from __future__ import annotations

import math
import time
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

import numpy as np
import soundfile

from .backends import QwenForcedAlignerBackend
from .types import AlignmentResult, LineAlignment, TokenSpan

WORD_TIMING_BETA_VERSION = "qwen-line-locked-2026-07-30.2"


class ClipAligner(Protocol):
    def align_clips(
        self,
        clips: list[tuple[np.ndarray, int]],
        texts: list[str],
        languages: list[str],
        *,
        batch_size: int = 8,
    ) -> list[tuple[TokenSpan, ...]]: ...


@dataclass(frozen=True, slots=True)
class WordTimingWindow:
    start: float
    end: float


def _kept_character(character: str) -> bool:
    return character == "'" or unicodedata.category(character)[:1] in {"L", "N"}


def _normalized_units(text: str) -> tuple[str, list[int]]:
    units: list[str] = []
    source_offsets: list[int] = []
    for source_offset, character in enumerate(text):
        if not _kept_character(character):
            continue
        for normalized in character.casefold():
            units.append(normalized)
            source_offsets.append(source_offset)
    return "".join(units), source_offsets


def token_character_offsets(
    text: str,
    tokens: tuple[TokenSpan, ...],
) -> tuple[int, ...] | None:
    """Map Qwen's punctuation-free units back onto the untouched lyric text."""

    source, source_offsets = _normalized_units(text)
    if not source or not tokens:
        return None
    cursor = 0
    offsets: list[int] = []
    for token in tokens:
        normalized, _ = _normalized_units(token.text)
        if not normalized or not source.startswith(normalized, cursor):
            return None
        offsets.append(source_offsets[cursor])
        cursor += len(normalized)
    if cursor != len(source):
        return None
    return tuple(offsets)


def build_word_timing_windows(
    lines: list[LineAlignment],
    *,
    audio_duration: float,
    preroll_seconds: float = 0.65,
    postroll_seconds: float = 0.65,
    maximum_window_seconds: float = 20.0,
) -> list[WordTimingWindow]:
    if audio_duration <= 0:
        raise ValueError("分析音频时长必须大于 0。")
    if maximum_window_seconds < 2.0:
        raise ValueError("逐字窗口上限不能小于 2 秒。")

    windows: list[WordTimingWindow] = []
    for index, item in enumerate(lines):
        line_start = min(audio_duration, max(0.0, item.start))
        start = max(0.0, line_start - preroll_seconds)
        if index + 1 < len(lines):
            following = min(
                audio_duration,
                max(line_start, lines[index + 1].start),
            )
            end = min(
                audio_duration,
                max(item.end + postroll_seconds, following + postroll_seconds),
            )
        else:
            end = audio_duration
        end = min(end, start + maximum_window_seconds)
        end = min(audio_duration, max(end, line_start + 0.8))
        if end <= start:
            end = min(audio_duration, start + 0.8)
        if end <= start:
            raise ValueError(f"第 {item.line.index} 行没有可用的逐字音频窗口。")
        windows.append(WordTimingWindow(start=start, end=end))
    return windows


def _load_mono_audio(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = soundfile.read(
        str(path),
        dtype="float32",
        always_2d=True,
    )
    if not len(samples) or sample_rate <= 0:
        raise ValueError("逐字 Beta 的分析音频为空。")
    mono = np.mean(samples, axis=1, dtype=np.float32)
    return np.asarray(mono, dtype=np.float32), int(sample_rate)


def _validate_spans(
    item: LineAlignment,
    window: WordTimingWindow,
    relative_spans: tuple[TokenSpan, ...],
    *,
    maximum_start_deviation: float,
    following_start: float | None,
    following_start_tolerance: float,
) -> tuple[tuple[TokenSpan, ...] | None, str | None]:
    if not relative_spans:
        return None, "模型没有返回逐字时间"
    if token_character_offsets(item.line.text, relative_spans) is None:
        return None, "模型 token 无法无损映射回原歌词"

    window_duration = window.end - window.start
    previous_boundary = -0.001
    absolute: list[TokenSpan] = []
    for span in relative_spans:
        values = (span.start, span.end)
        if not all(math.isfinite(value) for value in values):
            return None, "模型返回了非有限时间"
        if (
            span.start < -0.02
            or span.end < span.start
            or span.end > window_duration + 0.05
            or span.start + 0.02 < previous_boundary
        ):
            return None, "模型返回了越界或倒序时间"
        absolute_start = max(
            item.start,
            window.start + max(0.0, span.start),
        )
        absolute_end = max(
            absolute_start,
            window.start + min(window_duration, span.end),
        )
        absolute.append(
            TokenSpan(
                text=span.text,
                start=absolute_start,
                end=absolute_end,
            )
        )
        previous_boundary = max(previous_boundary, span.end)

    if abs(absolute[0].start - item.start) > maximum_start_deviation:
        return None, "首词与已验证的逐行起点相差过大"
    if (
        following_start is not None
        and absolute[-1].start
        > following_start + following_start_tolerance
    ):
        return None, "末词入口越过了下一行歌词"
    return tuple(absolute), None


def _align_resilient(
    backend: ClipAligner,
    clips: list[tuple[np.ndarray, int]],
    texts: list[str],
    languages: list[str],
    *,
    batch_size: int,
) -> tuple[list[tuple[TokenSpan, ...] | None], dict[int, str]]:
    aligned: list[tuple[TokenSpan, ...] | None] = [None] * len(clips)
    errors: dict[int, str] = {}

    def run(indices: list[int]) -> None:
        if not indices:
            return
        try:
            outputs = backend.align_clips(
                [clips[index] for index in indices],
                [texts[index] for index in indices],
                [languages[index] for index in indices],
                batch_size=min(batch_size, len(indices)),
            )
            if len(outputs) != len(indices):
                raise RuntimeError(
                    f"模型返回 {len(outputs)} 项，预期 {len(indices)} 项"
                )
            for index, spans in zip(indices, outputs, strict=True):
                aligned[index] = tuple(spans)
        except Exception as error:
            if len(indices) == 1:
                message = str(error).strip() or type(error).__name__
                errors[indices[0]] = message[:240]
                return
            midpoint = len(indices) // 2
            run(indices[:midpoint])
            run(indices[midpoint:])

    for first in range(0, len(clips), batch_size):
        run(list(range(first, min(len(clips), first + batch_size))))
    return aligned, errors


def attach_word_timing_beta(
    result: AlignmentResult,
    audio_path: str | Path,
    *,
    model_id: str = "Qwen/Qwen3-ForcedAligner-0.6B",
    device: str = "auto",
    batch_size: int = 4,
    maximum_start_deviation: float = 2.0,
    minimum_line_confidence: float = 0.5,
    following_start_tolerance: float = 0.25,
    backend: ClipAligner | None = None,
) -> AlignmentResult:
    """Attach real forced-alignment tokens without changing any line boundary."""

    if batch_size <= 0:
        raise ValueError("batch_size 必须大于 0。")
    if maximum_start_deviation <= 0:
        raise ValueError("首词偏差阈值必须大于 0。")
    if not 0.0 <= minimum_line_confidence <= 1.0:
        raise ValueError("逐行置信度阈值必须在 0 到 1 之间。")
    if following_start_tolerance < 0:
        raise ValueError("跨行容差不能小于 0。")
    source = Path(audio_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"找不到逐字 Beta 分析音频：{source}")
    if not result.lines:
        raise ValueError("没有可生成逐字时间的歌词行。")

    samples, sample_rate = _load_mono_audio(source)
    duration = len(samples) / sample_rate
    windows = build_word_timing_windows(
        result.lines,
        audio_duration=duration,
    )
    clips: list[tuple[np.ndarray, int]] = []
    for window in windows:
        first = max(0, round(window.start * sample_rate))
        last = min(len(samples), round(window.end * sample_rate))
        clips.append((samples[first:last], sample_rate))

    raw_anchors = result.metadata.get("anchors")
    anchors = raw_anchors if isinstance(raw_anchors, list) else []
    model_errors: dict[int, str] = {}
    eligible_indices: list[int] = []
    for index in range(len(result.lines)):
        anchor = (
            anchors[index]
            if index < len(anchors)
            and isinstance(anchors[index], dict)
            else None
        )
        anchor_confidence = (
            float(anchor["confidence"])
            if anchor is not None
            and isinstance(anchor.get("confidence"), (int, float))
            else None
        )
        if (
            anchor_confidence is not None
            and anchor_confidence < minimum_line_confidence
        ):
            model_errors[index] = (
                "逐行锚点置信度不足，拒绝生成伪精确词轴"
            )
        else:
            eligible_indices.append(index)

    owned_backend = backend is None
    aligner: ClipAligner = backend or QwenForcedAlignerBackend(
        model_id=model_id,
        device=device,
    )
    started = time.perf_counter()
    relative_by_line: list[tuple[TokenSpan, ...] | None] = [
        None
    ] * len(result.lines)
    try:
        eligible_outputs, eligible_errors = _align_resilient(
            aligner,
            [clips[index] for index in eligible_indices],
            [
                result.lines[index].line.text
                for index in eligible_indices
            ],
            [
                result.lines[index].line.detected_language
                or result.lines[index].language
                or "English"
                for index in eligible_indices
            ],
            batch_size=batch_size,
        )
        for local_index, original_index in enumerate(
            eligible_indices
        ):
            relative_by_line[original_index] = eligible_outputs[
                local_index
            ]
        model_errors.update(
            {
                eligible_indices[local_index]: message
                for local_index, message in eligible_errors.items()
            }
        )
    finally:
        if owned_backend and isinstance(aligner, QwenForcedAlignerBackend):
            aligner.unload()

    output_lines: list[LineAlignment] = []
    line_statuses: list[dict[str, object]] = []
    token_count = 0
    for index, (item, window, relative_spans) in enumerate(
        zip(result.lines, windows, relative_by_line, strict=True)
    ):
        error = model_errors.get(index)
        accepted: tuple[TokenSpan, ...] | None = None
        if error is None and relative_spans is not None:
            accepted, error = _validate_spans(
                item,
                window,
                relative_spans,
                maximum_start_deviation=maximum_start_deviation,
                following_start=(
                    result.lines[index + 1].start
                    if index + 1 < len(result.lines)
                    else None
                ),
                following_start_tolerance=following_start_tolerance,
            )
        if accepted is None:
            error = error or "模型没有返回逐字时间"
            output_lines.append(
                replace(
                    item,
                    tokens=(),
                    warnings=(
                        *item.warnings,
                        "word_timing_beta_fallback",
                    ),
                )
            )
            line_statuses.append(
                {
                    "line": item.line.index,
                    "status": "fallback",
                    "reason": error,
                }
            )
            continue

        token_count += len(accepted)
        output_lines.append(replace(item, tokens=accepted))
        line_statuses.append(
            {
                "line": item.line.index,
                "status": "aligned",
                "tokens": len(accepted),
            }
        )

    aligned_lines = sum(bool(item.tokens) for item in output_lines)
    fallback_lines = len(output_lines) - aligned_lines
    status = (
        "complete"
        if fallback_lines == 0
        else "partial"
        if aligned_lines
        else "failed"
    )
    beta_seconds = time.perf_counter() - started
    metadata = dict(result.metadata)
    metadata["word_timing_beta"] = {
        "version": WORD_TIMING_BETA_VERSION,
        "status": status,
        "model": model_id,
        "analysis_audio": str(source),
        "processing_seconds": beta_seconds,
        "line_starts_locked": True,
        "minimum_line_confidence": minimum_line_confidence,
        "following_start_tolerance": following_start_tolerance,
        "aligned_lines": aligned_lines,
        "fallback_lines": fallback_lines,
        "token_count": token_count,
        "lines": line_statuses,
    }
    warnings = list(result.warnings)
    if fallback_lines:
        warnings.append(
            f"逐字 Beta 有 {fallback_lines} 行未通过校验，"
            "这些行保留逐行结果且未生成伪造词轴。"
        )
    return replace(
        result,
        lines=output_lines,
        processing_seconds=result.processing_seconds + beta_seconds,
        warnings=warnings,
        metadata=metadata,
    )
