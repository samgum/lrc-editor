from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

_ALIGNMENT_WAV_PROFILE = "mono-16k-pcm-s16le-v1"


class AudioPreparationError(RuntimeError):
    pass


def _require_executable(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise AudioPreparationError(f"找不到 {name}，请先安装并加入 PATH。")
    return executable


def probe_duration(path: str | Path) -> float:
    ffprobe = _require_executable("ffprobe")
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(Path(path)),
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(completed.stdout)
    return float(payload["format"]["duration"])


def prepare_alignment_wav(
    source: str | Path,
    destination: str | Path,
) -> Path:
    ffmpeg = _require_executable("ffmpeg")
    source_path = Path(source).resolve()
    destination_path = Path(destination).resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    sidecar = destination_path.with_suffix(destination_path.suffix + ".source.json")
    if destination_path.is_file() and destination_path.stat().st_size > 44:
        source_stat = source_path.stat()
        reusable = destination_path.stat().st_mtime_ns >= source_stat.st_mtime_ns
        if sidecar.is_file():
            try:
                cached = json.loads(sidecar.read_text(encoding="utf-8"))
                reusable = reusable and (
                    cached.get("profile") == _ALIGNMENT_WAV_PROFILE
                    and cached.get("source") == str(source_path)
                    and int(cached.get("source_size", -1))
                    == source_stat.st_size
                    and int(cached.get("source_mtime_ns", -1))
                    == source_stat.st_mtime_ns
                )
            except (OSError, ValueError, TypeError):
                reusable = False
        if reusable:
            if not sidecar.is_file():
                sidecar.write_text(
                    json.dumps(
                        {
                            "profile": _ALIGNMENT_WAV_PROFILE,
                            "source": str(source_path),
                            "source_size": source_stat.st_size,
                            "source_mtime_ns": source_stat.st_mtime_ns,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
            return destination_path
    completed = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-map_metadata",
            "-1",
            str(destination_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or "FFmpeg 未返回错误详情。"
        raise AudioPreparationError(f"音频预处理失败：{detail}")
    if not destination_path.exists() or destination_path.stat().st_size == 0:
        raise AudioPreparationError("音频预处理没有生成有效 WAV。")
    source_stat = source_path.stat()
    sidecar.write_text(
        json.dumps(
            {
                "profile": _ALIGNMENT_WAV_PROFILE,
                "source": str(source_path),
                "source_size": source_stat.st_size,
                "source_mtime_ns": source_stat.st_mtime_ns,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return destination_path
