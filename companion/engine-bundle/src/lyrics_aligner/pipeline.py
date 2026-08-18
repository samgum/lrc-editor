from __future__ import annotations

import tempfile
from pathlib import Path

from .audio import prepare_alignment_wav, probe_duration
from .backends import QwenForcedAlignerBackend, WhisperXBackend
from .language import candidate_languages
from .transcript import parse_transcript_file
from .types import AlignmentResult


MAX_QWEN_AUDIO_SECONDS = 300.0


def align_file(
    audio_path: str | Path,
    transcript_path: str | Path,
    *,
    language: str = "auto",
    model_id: str = "Qwen/Qwen3-ForcedAligner-0.6B",
    device: str = "auto",
    backend: str = "qwen",
    work_dir: str | Path | None = None,
) -> AlignmentResult:
    audio = Path(audio_path).resolve()
    transcript = Path(transcript_path).resolve()
    lines = parse_transcript_file(transcript)
    if not lines:
        raise ValueError("文字稿清理后没有歌词行。")
    duration = probe_duration(audio)
    if duration > MAX_QWEN_AUDIO_SECONDS:
        raise ValueError(
            f"当前整曲流程上限为 5 分钟，输入为 {duration:.3f} 秒；"
            "长音频分段对齐尚未启用。"
        )

    if language == "auto":
        selected_language = candidate_languages(lines)[0]
    else:
        selected_language = language

    if work_dir is None:
        temporary = tempfile.TemporaryDirectory(prefix="lyrics-align-")
        base = Path(temporary.name)
    else:
        temporary = None
        base = Path(work_dir).resolve()
        base.mkdir(parents=True, exist_ok=True)

    try:
        wav_path = prepare_alignment_wav(audio, base / "alignment-input.wav")
        if backend == "qwen":
            aligner = QwenForcedAlignerBackend(
                model_id=model_id,
                device=device,
            )
        elif backend == "whisperx":
            aligner = WhisperXBackend(device=device)
        else:
            raise ValueError(f"未知对齐后端：{backend}")
        result = aligner.align(wav_path, lines, selected_language)
        result.metadata.update(
            {
                "source_audio": str(audio),
                "source_transcript": str(transcript),
                "duration": duration,
                "candidate_languages": candidate_languages(lines),
            }
        )
        return result
    finally:
        if temporary is not None:
            temporary.cleanup()
