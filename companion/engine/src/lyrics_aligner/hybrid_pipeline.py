from __future__ import annotations

import tempfile
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

from .acoustic_refinement import (
    refine_acoustic_onsets,
    refine_post_refrain_verified_onsets,
)
from .asr_matching import (
    CoarseLineAnchor,
    coarse_line_anchors_from_segments,
)
from .audio import prepare_alignment_wav, probe_duration
from .backends import transcribe_isolated
from .hybrid import merge_language_anchor_passes
from .language import candidate_languages
from .separation import VocalSeparationError, separate_vocals
from .structural_refinement import (
    refine_consecutive_refrains,
    refine_repeated_sections,
)
from .transcript import parse_transcript_file
from .types import AlignmentResult, LineAlignment

ProgressCallback = Callable[[str, float, str], None]

DEFAULT_MAX_AUDIO_SECONDS = 15 * 60.0
DEFAULT_ONSET_COMPENSATION_SECONDS = 0.25
DEFAULT_ACOUSTIC_CUE_LEAD_SECONDS = 0.25
ALIGNMENT_ALGORITHM_VERSION = "hybrid-2026-08-02.49"


def _notify(
    callback: ProgressCallback | None,
    stage: str,
    progress: float,
    detail: str,
) -> None:
    if callback is not None:
        callback(stage, progress, detail)


def _line_alignments(
    lines,
    anchors: list[CoarseLineAnchor],
    chosen_passes: list[str],
) -> list[LineAlignment]:
    aligned: list[LineAlignment] = []
    for index, (line, anchor, chosen_pass) in enumerate(
        zip(lines, anchors, chosen_passes, strict=True)
    ):
        next_start = (
            anchors[index + 1].start
            if index + 1 < len(anchors)
            else max(anchor.end, anchor.start + 0.8)
        )
        warnings: list[str] = []
        if anchor.interpolated:
            warnings.append("asr_interpolated")
        if anchor.confidence < 0.4:
            warnings.append("low_anchor_confidence")
        if anchor.method not in {"lexical", "interpolated"}:
            warnings.append(anchor.method)
        aligned.append(
            LineAlignment(
                line=line,
                start=anchor.start,
                end=max(anchor.start, min(max(anchor.end, anchor.start), next_start)),
                backend="demucs+whisper-asr-dp",
                language=chosen_pass,
                warnings=tuple(warnings),
            )
        )
    return aligned


def align_file_hybrid(
    audio_path: str | Path,
    transcript_path: str | Path,
    *,
    languages: list[str] | None = None,
    separate: bool = True,
    separation_model: str = "htdemucs_ft",
    whisper_model: str = "large-v3-turbo",
    device: str = "auto",
    work_dir: str | Path | None = None,
    cache_dir: str | Path | None = None,
    max_audio_seconds: float = DEFAULT_MAX_AUDIO_SECONDS,
    onset_compensation: float = DEFAULT_ONSET_COMPENSATION_SECONDS,
    preserve_blank_lines: bool = True,
    experimental_repeat_grid: bool = False,
    progress_callback: ProgressCallback | None = None,
) -> AlignmentResult:
    """Run the tested singing pipeline without using input reference axes."""

    started = time.perf_counter()
    audio = Path(audio_path).resolve()
    transcript = Path(transcript_path).resolve()
    if not audio.is_file():
        raise FileNotFoundError(f"找不到音频：{audio}")
    if not transcript.is_file():
        raise FileNotFoundError(f"找不到文字稿：{transcript}")

    _notify(progress_callback, "prepare", 0.02, "正在清理文字稿")
    lines = parse_transcript_file(
        transcript,
        preserve_blank_lines=preserve_blank_lines,
    )
    if not lines:
        raise ValueError("文字稿清理后没有歌词行。")
    duration = probe_duration(audio)
    if duration > max_audio_seconds:
        raise ValueError(
            f"音频为 {duration:.1f} 秒，超过本地任务上限 "
            f"{max_audio_seconds:.0f} 秒。"
        )
    selected_languages = languages or candidate_languages(lines)
    selected_languages = list(dict.fromkeys(selected_languages))
    if not selected_languages:
        selected_languages = ["English"]

    if work_dir is None:
        temporary = tempfile.TemporaryDirectory(prefix="lyrics-hybrid-")
        base = Path(temporary.name)
    else:
        temporary = None
        base = Path(work_dir).resolve()
        base.mkdir(parents=True, exist_ok=True)
    cache = (
        Path(cache_dir).resolve()
        if cache_dir is not None
        else base.parent / ".cache"
    )
    cache.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    try:
        alignment_source = audio
        separation_seconds = 0.0
        if separate:
            _notify(
                progress_callback,
                "separate",
                0.08,
                "正在分离无损人声轨",
            )
            separation_started = time.perf_counter()
            try:
                alignment_source = separate_vocals(
                    audio,
                    base / "stems",
                    model=separation_model,
                    device=device,
                )
            except VocalSeparationError:
                raise
            separation_seconds = time.perf_counter() - separation_started

        _notify(
            progress_callback,
            "prepare",
            0.35 if separate else 0.12,
            "正在生成 16 kHz 单声道分析音频",
        )
        wav_path = prepare_alignment_wav(
            alignment_source,
            base / "alignment-input.wav",
        )

        anchors_by_language: dict[str, list[CoarseLineAnchor]] = {}
        segments_by_language = {}
        pass_metadata: dict[str, dict[str, object]] = {}
        for pass_index, language in enumerate(selected_languages):
            pass_progress = 0.42 + 0.42 * pass_index / len(
                selected_languages
            )
            _notify(
                progress_callback,
                "recognize",
                pass_progress,
                f"正在运行 {language} 歌词粗锚点",
            )
            asr_pass = transcribe_isolated(
                wav_path,
                language=language,
                model_id=whisper_model,
                device=device,
                download_root=cache / "faster-whisper",
                output_path=base / "asr" / f"{language}.json",
            )
            anchors_by_language[language] = (
                refine_consecutive_refrains(
                    lines,
                    coarse_line_anchors_from_segments(
                        lines,
                        list(asr_pass.segments),
                        audio_duration=duration,
                    ),
                )
            )
            segments_by_language[language] = list(asr_pass.segments)
            pass_metadata[language] = {
                "detected_language": asr_pass.detected_language,
                "language_probability": asr_pass.language_probability,
                "segments": len(asr_pass.segments),
                "processing_seconds": asr_pass.processing_seconds,
            }

        _notify(
            progress_callback,
            "merge",
            0.9,
            "正在合并多语言锚点并修复漏识别行",
        )
        anchors, chosen_passes = merge_language_anchor_passes(
            lines,
            anchors_by_language,
        )
        anchors = refine_repeated_sections(
            lines,
            anchors,
            segments_by_language,
            audio_duration=duration,
        )
        if onset_compensation:
            anchors = [
                replace(
                    anchor,
                    start=min(
                        duration,
                        max(0.0, anchor.start + onset_compensation),
                    ),
                    end=min(
                        duration,
                        max(
                            anchor.start + onset_compensation,
                            anchor.end + onset_compensation,
                        ),
                    ),
                )
                for anchor in anchors
            ]
        pre_acoustic_anchors = list(anchors)
        anchors, acoustic_summary = refine_acoustic_onsets(
            lines,
            anchors,
            wav_path,
            cue_lead_seconds=DEFAULT_ACOUSTIC_CUE_LEAD_SECONDS,
            experimental_repeat_grid=experimental_repeat_grid,
        )
        # A corrected entrance is a much safer origin for a run of repeated
        # lyrics than the stretched first-word timestamp Whisper supplied.
        anchors = refine_consecutive_refrains(lines, anchors)
        anchors = refine_post_refrain_verified_onsets(
            lines,
            anchors,
            wav_path,
            cue_lead_seconds=DEFAULT_ACOUSTIC_CUE_LEAD_SECONDS,
            reference_anchors=pre_acoustic_anchors,
        )
        result = AlignmentResult(
            lines=_line_alignments(lines, anchors, chosen_passes),
            backend="demucs+whisper-asr-dp" if separate else "whisper-asr-dp",
            language=(
                "multilingual"
                if len(selected_languages) > 1
                else selected_languages[0]
            ),
            audio_path=audio,
            model_id=whisper_model,
            processing_seconds=time.perf_counter() - started,
            warnings=warnings,
            metadata={
                "source_audio": str(audio),
                "source_transcript": str(transcript),
                "alignment_algorithm_version": ALIGNMENT_ALGORITHM_VERSION,
                "alignment_source": str(alignment_source),
                "analysis_audio": str(wav_path),
                "duration": duration,
                "separation": separate,
                "separation_model": separation_model if separate else None,
                "separation_seconds": separation_seconds,
                "languages": selected_languages,
                "chosen_passes": chosen_passes,
                "passes": pass_metadata,
                "anchors": [
                    {
                        "line": anchor.line_index,
                        "start": anchor.start,
                        "end": anchor.end,
                        "matched_units": anchor.matched_units,
                        "total_units": anchor.total_units,
                        "confidence": anchor.confidence,
                        "interpolated": anchor.interpolated,
                        "method": anchor.method,
                        "start_uncertainty": anchor.start_uncertainty,
                        "leading_unmatched_units": (
                            anchor.leading_unmatched_units
                        ),
                        "acoustic_start_hint": anchor.acoustic_start_hint,
                        "stretched_second_start_hint": (
                            anchor.stretched_second_start_hint
                        ),
                    }
                    for anchor in anchors
                ],
                "pre_acoustic_anchors": [
                    {
                        "line": anchor.line_index,
                        "start": anchor.start,
                        "end": anchor.end,
                        "matched_units": anchor.matched_units,
                        "total_units": anchor.total_units,
                        "confidence": anchor.confidence,
                        "interpolated": anchor.interpolated,
                        "method": anchor.method,
                        "start_uncertainty": anchor.start_uncertainty,
                        "leading_unmatched_units": (
                            anchor.leading_unmatched_units
                        ),
                        "acoustic_start_hint": anchor.acoustic_start_hint,
                        "stretched_second_start_hint": (
                            anchor.stretched_second_start_hint
                        ),
                    }
                    for anchor in pre_acoustic_anchors
                ],
                "reference_axes_used_for_alignment": False,
                "preserve_blank_lines": preserve_blank_lines,
                "onset_compensation_seconds": onset_compensation,
                "acoustic_cue_lead_seconds": (
                    DEFAULT_ACOUSTIC_CUE_LEAD_SECONDS
                ),
                "acoustic_refinement": {
                    "candidate_count": (
                        acoustic_summary.candidate_count
                    ),
                    "refined_lines": acoustic_summary.refined_lines,
                    "noise_floor_db": acoustic_summary.noise_floor_db,
                },
            },
        )
        _notify(progress_callback, "done", 1.0, "对齐完成")
        return result
    finally:
        if temporary is not None:
            temporary.cleanup()
