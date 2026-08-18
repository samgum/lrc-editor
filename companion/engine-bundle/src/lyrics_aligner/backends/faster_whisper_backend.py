from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..asr_matching import TimedASRSegment, TimedASRWord

_LANGUAGE_CODES = {
    "Chinese": "zh",
    "English": "en",
    "French": "fr",
    "German": "de",
    "Italian": "it",
    "Japanese": "ja",
    "Korean": "ko",
    "Portuguese": "pt",
    "Russian": "ru",
    "Spanish": "es",
}


class FasterWhisperError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class WhisperASRPass:
    requested_language: str
    detected_language: str
    language_probability: float
    segments: tuple[TimedASRSegment, ...]
    processing_seconds: float
    model_id: str
    device: str
    compute_type: str


class FasterWhisperBackend:
    def __init__(
        self,
        model_id: str = "large-v3-turbo",
        *,
        device: str = "auto",
        compute_type: str = "auto",
        download_root: str | Path | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.compute_type = compute_type
        self.download_root = (
            Path(download_root).resolve() if download_root is not None else None
        )
        self._model: Any | None = None

    def load(self) -> None:
        if self._model is not None:
            return
        import ctranslate2
        from faster_whisper import WhisperModel

        if self.device == "auto":
            self.device = (
                "cuda"
                if ctranslate2.get_cuda_device_count() > 0
                else "cpu"
            )
        if self.compute_type == "auto":
            self.compute_type = "float16" if self.device == "cuda" else "int8"
        try:
            self._model = WhisperModel(
                self.model_id,
                device=self.device,
                compute_type=self.compute_type,
                download_root=(
                    str(self.download_root) if self.download_root else None
                ),
            )
        except Exception as error:
            raise FasterWhisperError(
                f"Whisper 模型加载失败：{error}"
            ) from error

    def unload(self) -> None:
        # CTranslate2 4.6 can abort the whole Python process when a CUDA model
        # is explicitly destroyed on Windows after consecutive transcriptions.
        # Production calls run in a short-lived isolated process; leave cleanup
        # to process teardown there.
        if os.name == "nt" and self.device == "cuda":
            return
        self._model = None
        gc.collect()

    def transcribe(
        self,
        audio_path: str | Path,
        *,
        language: str,
    ) -> WhisperASRPass:
        source = Path(audio_path).resolve()
        if not source.is_file():
            raise FasterWhisperError(f"找不到音频：{source}")
        code = _LANGUAGE_CODES.get(language)
        if not code:
            raise FasterWhisperError(f"Whisper 尚未配置语言：{language}")
        self.load()
        assert self._model is not None

        started = time.perf_counter()
        iterator, info = self._model.transcribe(
            str(source),
            beam_size=5,
            language=code,
            word_timestamps=True,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        segments: list[TimedASRSegment] = []
        for segment in iterator:
            words = tuple(
                TimedASRWord(
                    text=word.word,
                    start=float(word.start),
                    end=float(word.end),
                    probability=float(word.probability),
                )
                for word in (segment.words or [])
                if word.start is not None and word.end is not None
            )
            if not words or not segment.text.strip():
                continue
            segments.append(
                TimedASRSegment(
                    text=segment.text,
                    start=float(segment.start),
                    end=float(segment.end),
                    words=words,
                )
            )
        if not segments:
            raise FasterWhisperError(
                f"Whisper 的 {language} 识别没有返回可用片段。"
            )
        return WhisperASRPass(
            requested_language=language,
            detected_language=str(info.language),
            language_probability=float(info.language_probability),
            segments=tuple(segments),
            processing_seconds=time.perf_counter() - started,
            model_id=self.model_id,
            device=self.device,
            compute_type=self.compute_type,
        )


def whisper_pass_to_dict(result: WhisperASRPass) -> dict[str, object]:
    return {
        "requested_language": result.requested_language,
        "detected_language": result.detected_language,
        "language_probability": result.language_probability,
        "processing_seconds": result.processing_seconds,
        "model_id": result.model_id,
        "device": result.device,
        "compute_type": result.compute_type,
        "segments": [
            {
                "text": segment.text,
                "start": segment.start,
                "end": segment.end,
                "words": [
                    {
                        "text": word.text,
                        "start": word.start,
                        "end": word.end,
                        "probability": word.probability,
                    }
                    for word in segment.words
                ],
            }
            for segment in result.segments
        ],
    }


def whisper_pass_from_dict(payload: dict[str, object]) -> WhisperASRPass:
    return WhisperASRPass(
        requested_language=str(payload["requested_language"]),
        detected_language=str(payload["detected_language"]),
        language_probability=float(payload["language_probability"]),
        processing_seconds=float(payload["processing_seconds"]),
        model_id=str(payload["model_id"]),
        device=str(payload["device"]),
        compute_type=str(payload["compute_type"]),
        segments=tuple(
            TimedASRSegment(
                text=str(segment["text"]),
                start=float(segment["start"]),
                end=float(segment["end"]),
                words=tuple(
                    TimedASRWord(
                        text=str(word["text"]),
                        start=float(word["start"]),
                        end=float(word["end"]),
                        probability=float(word["probability"]),
                    )
                    for word in segment["words"]
                ),
            )
            for segment in payload["segments"]
        ),
    )


def transcribe_isolated(
    audio_path: str | Path,
    *,
    language: str,
    model_id: str,
    device: str,
    download_root: str | Path,
    output_path: str | Path,
) -> WhisperASRPass:
    """Run CTranslate2 outside the web/server process on Windows."""

    source = Path(audio_path).resolve()
    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file():
        try:
            cached = json.loads(output.read_text(encoding="utf-8"))
            if (
                str(cached.get("source")) == str(source)
                and int(cached.get("source_size", -1)) == source.stat().st_size
                and int(cached.get("source_mtime_ns", -1))
                == source.stat().st_mtime_ns
                and str(cached.get("requested_language")) == language
                and str(cached.get("model_id")) == model_id
            ):
                return whisper_pass_from_dict(cached)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    command = [
        sys.executable,
        "-m",
        "lyrics_aligner.whisper_runner",
        str(source),
        str(output),
        "--language",
        language,
        "--model",
        model_id,
        "--device",
        device,
        "--download-root",
        str(Path(download_root).resolve()),
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
        raise FasterWhisperError(
            f"{language} ASR 隔离进程失败。"
            + (f"\n{detail}" if detail else "")
        )
    if not output.is_file():
        raise FasterWhisperError(f"ASR 隔离进程没有生成结果：{output}")
    payload = json.loads(output.read_text(encoding="utf-8"))
    return whisper_pass_from_dict(payload)
