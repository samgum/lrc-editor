from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


class VocalSeparationError(RuntimeError):
    pass


def _default_device() -> str:
    try:
        import torch
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def separate_vocals(
    audio_path: str | Path,
    output_dir: str | Path,
    *,
    model: str = "htdemucs_ft",
    device: str = "auto",
    segment: int = 7,
    overlap: float = 0.25,
    shifts: int = 1,
    reuse_existing: bool = True,
) -> Path:
    """Separate vocals in an isolated process and return a lossless WAV path."""

    source = Path(audio_path).resolve()
    destination = Path(output_dir).resolve()
    if not source.is_file():
        raise VocalSeparationError(f"找不到音频：{source}")
    if segment <= 0:
        raise ValueError("segment 必须大于 0。")
    destination.mkdir(parents=True, exist_ok=True)
    vocals = destination / model / source.stem / "vocals.wav"
    if (
        reuse_existing
        and vocals.is_file()
        and vocals.stat().st_size > 0
        and vocals.stat().st_mtime >= source.stat().st_mtime
    ):
        return vocals

    selected_device = _default_device() if device == "auto" else device
    command = [
        sys.executable,
        "-m",
        "lyrics_aligner.demucs_runner",
        "--two-stems",
        "vocals",
        "--name",
        model,
        "--out",
        str(destination),
        "--segment",
        str(segment),
        "--overlap",
        str(overlap),
        "--shifts",
        str(shifts),
        "--jobs",
        "0",
        "--device",
        selected_device,
        "--int24",
        str(source),
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise VocalSeparationError(
            "Demucs 人声分离失败。"
            + (f"\n{detail}" if detail else "")
        )

    if not vocals.is_file() or vocals.stat().st_size == 0:
        raise VocalSeparationError(
            f"Demucs 已结束，但没有生成预期的人声文件：{vocals}"
        )
    return vocals


def demucs_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
