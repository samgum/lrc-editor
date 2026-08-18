from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile

from .asr_matching import CoarseLineAnchor
from .backends import QwenForcedAlignerBackend
from .types import AlignmentResult, LineAlignment, TokenSpan, TranscriptLine


@dataclass(frozen=True, slots=True)
class RefinementWindow:
    start: float
    end: float
    coarse_start: float
    low_confidence: bool


def build_refinement_windows(
    anchors: list[CoarseLineAnchor],
    *,
    audio_duration: float,
    uncertain_padding: float = 2.6,
    maximum_pre_roll: float | None = None,
) -> list[RefinementWindow]:
    if maximum_pre_roll is not None and maximum_pre_roll <= 0.0:
        raise ValueError("maximum_pre_roll 必须大于 0。")
    starts = [anchor.start for anchor in anchors]
    windows: list[RefinementWindow] = []
    for index, anchor in enumerate(anchors):
        previous = starts[index - 1] if index > 0 else 0.0
        following = (
            starts[index + 1] if index + 1 < len(starts) else audio_duration
        )
        left = 0.0 if index == 0 else (previous + anchor.start) / 2
        right = (
            audio_duration
            if index + 1 == len(starts)
            else (anchor.start + following) / 2
        )
        uncertain = anchor.interpolated or anchor.confidence < 0.48
        if uncertain:
            left -= uncertain_padding
            right += uncertain_padding
        else:
            left -= min(0.8, max(0.15, anchor.start - previous) * 0.2)
            right += min(0.8, max(0.15, following - anchor.start) * 0.2)
        left = max(0.0, min(anchor.start, left))
        if maximum_pre_roll is not None:
            left = max(left, anchor.start - maximum_pre_roll)
        right = min(audio_duration, max(anchor.start + 0.8, right))
        if right - left > 18.0:
            left = max(0.0, anchor.start - 8.0)
            right = min(audio_duration, anchor.start + 10.0)
        windows.append(
            RefinementWindow(
                start=left,
                end=right,
                coarse_start=anchor.start,
                low_confidence=uncertain,
            )
        )
    return windows


def _load_mono_audio(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = soundfile.read(
        str(path),
        dtype="float32",
        always_2d=True,
    )
    mono = np.mean(samples, axis=1, dtype=np.float32)
    return np.asarray(mono, dtype=np.float32), int(sample_rate)


def refine_with_qwen(
    audio_path: str | Path,
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    *,
    model_id: str = "Qwen/Qwen3-ForcedAligner-0.6B",
    device: str = "auto",
    batch_size: int = 8,
    adapter: str | Path | None = None,
    aligner_backend: QwenForcedAlignerBackend | None = None,
    maximum_pre_roll: float | None = None,
) -> AlignmentResult:
    if len(lines) != len(anchors):
        raise ValueError("歌词行与粗锚点数量不一致。")
    source = Path(audio_path).resolve()
    samples, sample_rate = _load_mono_audio(source)
    duration = len(samples) / sample_rate
    windows = build_refinement_windows(
        anchors,
        audio_duration=duration,
        maximum_pre_roll=maximum_pre_roll,
    )
    clips: list[tuple[np.ndarray, int]] = []
    for window in windows:
        first = max(0, round(window.start * sample_rate))
        last = min(len(samples), round(window.end * sample_rate))
        clips.append((samples[first:last], sample_rate))

    owned_backend = aligner_backend is None
    backend = aligner_backend or QwenForcedAlignerBackend(
        model_id=model_id, device=device, adapter=adapter
    )
    started = time.perf_counter()
    try:
        clip_spans = backend.align_clips(
            clips,
            [line.text for line in lines],
            [line.detected_language or "English" for line in lines],
            batch_size=batch_size,
        )
    finally:
        if owned_backend:
            backend.unload()

    aligned: list[LineAlignment] = []
    warnings: list[str] = []
    previous_start = 0.0
    for line, anchor, window, relative_spans in zip(
        lines,
        anchors,
        windows,
        clip_spans,
        strict=True,
    ):
        absolute_spans = tuple(
            TokenSpan(
                text=span.text,
                start=window.start + span.start,
                end=window.start + span.end,
            )
            for span in relative_spans
        )
        line_warnings: list[str] = []
        if absolute_spans:
            start = absolute_spans[0].start
            end = max(span.end for span in absolute_spans)
        else:
            start = anchor.start
            end = max(anchor.end, start)
            line_warnings.append("qwen_no_tokens")
        if start < previous_start:
            line_warnings.append("qwen_non_monotonic")
            warnings.append(f"第 {line.index} 行局部结果早于上一行。")
        if not window.low_confidence and abs(start - anchor.start) > 1.6:
            line_warnings.append("large_shift_from_asr_anchor")
        previous_start = max(previous_start, start)
        aligned.append(
            LineAlignment(
                line=line,
                start=max(0.0, start),
                end=max(start, end),
                tokens=absolute_spans,
                backend="qwen-local-after-whisper",
                language=line.detected_language or "English",
                warnings=tuple(line_warnings),
            )
        )

    return AlignmentResult(
        lines=aligned,
        backend="whisper-asr+qwen-local",
        language="multilingual",
        audio_path=source,
        model_id=model_id,
        processing_seconds=time.perf_counter() - started,
        warnings=warnings,
        metadata={
            "device": backend.device,
            "adapter": str(backend.adapter) if backend.adapter else None,
            "adapter_signature": backend.adapter_signature,
            "maximum_pre_roll": maximum_pre_roll,
            "windows": [
                {
                    "start": window.start,
                    "end": window.end,
                    "coarse_start": window.coarse_start,
                    "low_confidence": window.low_confidence,
                }
                for window in windows
            ],
        },
    )
