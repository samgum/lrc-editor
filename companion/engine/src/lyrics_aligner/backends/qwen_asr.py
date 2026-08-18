from __future__ import annotations

import gc
import hashlib
import json
import math
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..asr_matching import TimedASRSegment, TimedASRWord


class QwenASRError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ASRResult:
    text: str
    language: str
    model_id: str
    device: str
    processing_seconds: float


@dataclass(frozen=True, slots=True)
class QwenTimedASRPass:
    requested_language: str
    detected_language: str
    text: str
    segments: tuple[TimedASRSegment, ...]
    processing_seconds: float
    model_id: str
    forced_aligner_model_id: str
    adapter: str | None
    adapter_signature: str | None
    forced_aligner_adapter: str | None
    forced_aligner_adapter_signature: str | None
    device: str


def qwen_timestamp_items_to_segments(
    items: Any,
    *,
    maximum_gap_seconds: float = 0.85,
    maximum_segment_seconds: float = 8.0,
    maximum_words: int = 18,
) -> tuple[TimedASRSegment, ...]:
    """Group the aligner's flat word stream into conservative ASR phrases."""

    words: list[TimedASRWord] = []
    for item in items or []:
        text = str(getattr(item, "text", "")).strip()
        start = float(getattr(item, "start_time", -1.0))
        end = float(getattr(item, "end_time", -1.0))
        if (
            not text
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0.0
            or end < start
        ):
            continue
        words.append(
            TimedASRWord(
                text=text,
                start=start,
                end=end,
                # Qwen3-ForcedAligner does not expose token confidence.
                # Keep it below Whisper's certain-token ceiling so later
                # fusion can remain conservative.
                probability=0.9,
            )
        )
    words.sort(key=lambda item: (item.start, item.end))
    if not words:
        return ()

    groups: list[list[TimedASRWord]] = []
    current: list[TimedASRWord] = []
    for word in words:
        split = bool(current) and (
            word.start - current[-1].end > maximum_gap_seconds
            or word.end - current[0].start > maximum_segment_seconds
            or len(current) >= maximum_words
        )
        if split:
            groups.append(current)
            current = []
        current.append(word)
    if current:
        groups.append(current)

    return tuple(
        TimedASRSegment(
            text=" ".join(word.text for word in group),
            start=group[0].start,
            end=max(word.end for word in group),
            words=tuple(group),
        )
        for group in groups
    )


def adapter_signature(adapter: str | Path | None) -> str | None:
    if adapter is None:
        return None
    directory = Path(adapter).resolve()
    digest = hashlib.sha256()
    matched = False
    for name in ("adapter_config.json", "adapter_model.safetensors"):
        path = directory / name
        if not path.is_file():
            continue
        matched = True
        digest.update(name.encode("utf-8"))
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    if not matched:
        raise QwenASRError(f"LoRA 目录缺少适配器文件：{directory}")
    return digest.hexdigest()


class QwenASRBackend:
    """Song-capable Qwen3-ASR used only to obtain coarse lexical anchors."""

    def __init__(
        self,
        model_id: str = "Qwen/Qwen3-ASR-1.7B",
        device: str = "auto",
        max_new_tokens: int = 4096,
        adapter: str | Path | None = None,
        forced_aligner_model_id: str | None = None,
        forced_aligner_adapter: str | Path | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.max_new_tokens = max_new_tokens
        self.adapter = Path(adapter).resolve() if adapter else None
        self.forced_aligner_model_id = forced_aligner_model_id
        self.adapter_signature = adapter_signature(self.adapter)
        self.forced_aligner_adapter = (
            Path(forced_aligner_adapter).resolve()
            if forced_aligner_adapter
            else None
        )
        self.forced_aligner_adapter_signature = adapter_signature(
            self.forced_aligner_adapter
        )
        if self.forced_aligner_adapter and not self.forced_aligner_model_id:
            raise QwenASRError(
                "ForcedAligner LoRA 需要同时配置 ForcedAligner 模型。"
            )
        self._model: Any | None = None
        self._torch: Any | None = None

    def load(self) -> None:
        if self._model is not None:
            return
        import torch
        from qwen_asr import Qwen3ASRModel

        target = (
            "cuda:0"
            if self.device == "auto" and torch.cuda.is_available()
            else ("cpu" if self.device == "auto" else self.device)
        )
        if target.startswith("cuda") and not torch.cuda.is_available():
            raise QwenASRError("已请求 CUDA，但 PyTorch 没有检测到可用 GPU。")
        dtype = (
            torch.bfloat16
            if target.startswith("cuda") and torch.cuda.is_bf16_supported()
            else torch.float32
        )
        load_kwargs: dict[str, Any] = {
            "dtype": dtype,
            "device_map": target,
            "max_inference_batch_size": 1,
            "max_new_tokens": self.max_new_tokens,
        }
        if self.forced_aligner_model_id:
            load_kwargs["forced_aligner"] = self.forced_aligner_model_id
            load_kwargs["forced_aligner_kwargs"] = {
                "dtype": dtype,
                "device_map": target,
            }
        self._model = Qwen3ASRModel.from_pretrained(
            self.model_id,
            **load_kwargs,
        )
        if self.adapter is not None:
            from peft import PeftModel

            self._model.model = PeftModel.from_pretrained(
                self._model.model,
                str(self.adapter),
            )
            self._model.model.eval()
        if self.forced_aligner_adapter is not None:
            from peft import PeftModel

            assert self._model.forced_aligner is not None
            self._model.forced_aligner.model = PeftModel.from_pretrained(
                self._model.forced_aligner.model,
                str(self.forced_aligner_adapter),
            )
            self._model.forced_aligner.model.eval()
        self._torch = torch
        self.device = target

    def unload(self) -> None:
        self._model = None
        gc.collect()
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()

    def transcribe(
        self,
        audio_path: str | Path,
        *,
        language: str | None = None,
        context: str = "",
    ) -> ASRResult:
        source = Path(audio_path).resolve()
        if not source.is_file():
            raise QwenASRError(f"找不到音频：{source}")
        self.load()
        assert self._model is not None

        started = time.perf_counter()
        results = self._model.transcribe(
            audio=str(source),
            language=language,
            context=context,
            return_time_stamps=False,
        )
        if not results or not results[0].text.strip():
            raise QwenASRError("Qwen3-ASR 没有返回可用文字。")
        item = results[0]
        return ASRResult(
            text=item.text.strip(),
            language=item.language.strip(),
            model_id=self.model_id,
            device=self.device,
            processing_seconds=time.perf_counter() - started,
        )

    def transcribe_timed(
        self,
        audio_path: str | Path,
        *,
        language: str | None = None,
        context: str = "",
    ) -> QwenTimedASRPass:
        source = Path(audio_path).resolve()
        if not source.is_file():
            raise QwenASRError(f"找不到音频：{source}")
        if not self.forced_aligner_model_id:
            raise QwenASRError("时间戳转录需要配置 Qwen3-ForcedAligner。")
        self.load()
        assert self._model is not None

        started = time.perf_counter()
        results = self._model.transcribe(
            audio=str(source),
            language=language,
            context=context,
            return_time_stamps=True,
        )
        if not results or not results[0].text.strip():
            raise QwenASRError("Qwen3-ASR 没有返回可用文字。")
        item = results[0]
        segments = qwen_timestamp_items_to_segments(item.time_stamps)
        if not segments:
            raise QwenASRError("Qwen3-ForcedAligner 没有返回可用时间戳。")
        return QwenTimedASRPass(
            requested_language=language or "Auto",
            detected_language=item.language.strip(),
            text=item.text.strip(),
            segments=segments,
            processing_seconds=time.perf_counter() - started,
            model_id=self.model_id,
            forced_aligner_model_id=self.forced_aligner_model_id,
            adapter=str(self.adapter) if self.adapter else None,
            adapter_signature=self.adapter_signature,
            forced_aligner_adapter=(
                str(self.forced_aligner_adapter)
                if self.forced_aligner_adapter
                else None
            ),
            forced_aligner_adapter_signature=(
                self.forced_aligner_adapter_signature
            ),
            device=self.device,
        )


def qwen_timed_pass_to_dict(result: QwenTimedASRPass) -> dict[str, object]:
    return {
        "requested_language": result.requested_language,
        "detected_language": result.detected_language,
        "text": result.text,
        "processing_seconds": result.processing_seconds,
        "model_id": result.model_id,
        "forced_aligner_model_id": result.forced_aligner_model_id,
        "adapter": result.adapter,
        "adapter_signature": result.adapter_signature,
        "forced_aligner_adapter": result.forced_aligner_adapter,
        "forced_aligner_adapter_signature": (
            result.forced_aligner_adapter_signature
        ),
        "device": result.device,
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


def qwen_timed_pass_from_dict(payload: dict[str, object]) -> QwenTimedASRPass:
    return QwenTimedASRPass(
        requested_language=str(payload["requested_language"]),
        detected_language=str(payload["detected_language"]),
        text=str(payload["text"]),
        processing_seconds=float(payload["processing_seconds"]),
        model_id=str(payload["model_id"]),
        forced_aligner_model_id=str(payload["forced_aligner_model_id"]),
        adapter=(str(payload["adapter"]) if payload.get("adapter") else None),
        adapter_signature=(
            str(payload["adapter_signature"])
            if payload.get("adapter_signature")
            else None
        ),
        forced_aligner_adapter=(
            str(payload["forced_aligner_adapter"])
            if payload.get("forced_aligner_adapter")
            else None
        ),
        forced_aligner_adapter_signature=(
            str(payload["forced_aligner_adapter_signature"])
            if payload.get("forced_aligner_adapter_signature")
            else None
        ),
        device=str(payload["device"]),
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


def transcribe_qwen_isolated(
    audio_path: str | Path,
    *,
    language: str,
    model_id: str,
    forced_aligner_model_id: str,
    adapter: str | Path | None,
    forced_aligner_adapter: str | Path | None,
    device: str,
    output_path: str | Path,
) -> QwenTimedASRPass:
    source = Path(audio_path).resolve()
    output = Path(output_path).resolve()
    signature = adapter_signature(adapter)
    forced_signature = adapter_signature(forced_aligner_adapter)
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
                and str(cached.get("forced_aligner_model_id"))
                == forced_aligner_model_id
                and cached.get("adapter_signature") == signature
                and cached.get("forced_aligner_adapter_signature")
                == forced_signature
            ):
                return qwen_timed_pass_from_dict(cached)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    command = [
        sys.executable,
        "-m",
        "lyrics_aligner.qwen_timestamp_runner",
        str(source),
        str(output),
        "--language",
        language,
        "--model",
        model_id,
        "--forced-aligner",
        forced_aligner_model_id,
        "--device",
        device,
    ]
    if adapter is not None:
        command.extend(["--adapter", str(Path(adapter).resolve())])
    if forced_aligner_adapter is not None:
        command.extend(
            [
                "--forced-aligner-adapter",
                str(Path(forced_aligner_adapter).resolve()),
            ]
        )
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise QwenASRError(
            "Qwen 时间戳 ASR 隔离进程失败。"
            + (f"\n{detail}" if detail else "")
        )
    if not output.is_file():
        raise QwenASRError(f"隔离进程没有生成结果：{output}")
    return qwen_timed_pass_from_dict(
        json.loads(output.read_text(encoding="utf-8"))
    )
