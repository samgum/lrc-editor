from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from ..types import AlignmentResult, LineAlignment, TokenSpan, TranscriptLine
from .qwen_asr import adapter_signature


class QwenAlignmentError(RuntimeError):
    pass


class QwenForcedAlignerBackend:
    def __init__(
        self,
        model_id: str = "Qwen/Qwen3-ForcedAligner-0.6B",
        device: str = "auto",
        adapter: str | Path | None = None,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.adapter = Path(adapter).resolve() if adapter else None
        self.adapter_signature = adapter_signature(self.adapter)
        self._model: Any | None = None
        self._torch: Any | None = None

    def load(self) -> None:
        if self._model is not None:
            return
        import torch
        from qwen_asr import Qwen3ForcedAligner

        if self.device == "auto":
            target_device = "cuda:0" if torch.cuda.is_available() else "cpu"
        else:
            target_device = self.device
        if target_device.startswith("cuda") and not torch.cuda.is_available():
            raise QwenAlignmentError("已请求 CUDA，但 PyTorch 没有检测到可用 GPU。")

        dtype = (
            torch.bfloat16
            if target_device.startswith("cuda") and torch.cuda.is_bf16_supported()
            else torch.float32
        )
        self._model = Qwen3ForcedAligner.from_pretrained(
            self.model_id,
            dtype=dtype,
            device_map=target_device,
        )
        if self.adapter is not None:
            from peft import PeftModel

            self._model.model = PeftModel.from_pretrained(
                self._model.model,
                str(self.adapter),
            )
            self._model.model.eval()
        self._torch = torch
        self.device = target_device

    def unload(self) -> None:
        if self._model is None:
            return
        self._model = None
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()

    def _token_lists(
        self,
        lines: list[TranscriptLine],
        language: str,
    ) -> list[list[str]]:
        assert self._model is not None
        processor = self._model.aligner_processor
        return [
            list(processor.encode_timestamp(line.text, language)[0])
            for line in lines
        ]

    def align_clips(
        self,
        clips: list[tuple[np.ndarray, int]],
        texts: list[str],
        languages: list[str],
        *,
        batch_size: int = 8,
    ) -> list[tuple[TokenSpan, ...]]:
        """Align independent short clips while keeping one model resident."""

        if not (len(clips) == len(texts) == len(languages)):
            raise ValueError("clips、texts 与 languages 数量必须一致。")
        if batch_size <= 0:
            raise ValueError("batch_size 必须大于 0。")
        self.load()
        assert self._model is not None

        all_spans: list[tuple[TokenSpan, ...]] = []
        for start in range(0, len(clips), batch_size):
            outputs = self._model.align(
                audio=clips[start : start + batch_size],
                text=texts[start : start + batch_size],
                language=languages[start : start + batch_size],
            )
            for output in outputs:
                all_spans.append(
                    tuple(
                        TokenSpan(
                            text=item.text,
                            start=float(item.start_time),
                            end=float(item.end_time),
                        )
                        for item in output
                    )
                )
        return all_spans

    def align(
        self,
        audio_path: str | Path,
        lines: list[TranscriptLine],
        language: str,
    ) -> AlignmentResult:
        if not lines:
            raise QwenAlignmentError("文字稿清理后没有可对齐的歌词行。")
        self.load()
        assert self._model is not None

        started = time.perf_counter()
        transcript = "\n".join(line.text for line in lines)
        output = self._model.align(
            audio=str(Path(audio_path).resolve()),
            text=transcript,
            language=language,
        )[0]
        spans = [
            TokenSpan(
                text=item.text,
                start=float(item.start_time),
                end=float(item.end_time),
            )
            for item in output
        ]
        expected = self._token_lists(lines, language)
        expected_flat = [token for tokens in expected for token in tokens]
        actual_flat = [span.text for span in spans]
        if expected_flat != actual_flat:
            raise QwenAlignmentError(
                "模型返回的 token 顺序与清理后的文字稿不一致，"
                f"expected={len(expected_flat)} actual={len(actual_flat)}。"
            )

        aligned_lines: list[LineAlignment] = []
        cursor = 0
        global_warnings: list[str] = []
        previous_start = -1.0
        for line, line_tokens in zip(lines, expected, strict=True):
            token_count = len(line_tokens)
            selected = tuple(spans[cursor : cursor + token_count])
            cursor += token_count
            warnings: list[str] = []
            if not selected:
                start = max(0.0, previous_start)
                end = start
                warnings.append("no_tokens")
            else:
                start = selected[0].start
                end = max(token.end for token in selected)
            if start < previous_start:
                warnings.append("non_monotonic_start")
                global_warnings.append(
                    f"第 {line.index} 行起点早于上一行。"
                )
            if end < start:
                warnings.append("negative_duration")
            if end == start:
                warnings.append("zero_duration")
            previous_start = max(previous_start, start)
            aligned_lines.append(
                LineAlignment(
                    line=line,
                    start=max(0.0, start),
                    end=max(start, end),
                    tokens=selected,
                    backend="qwen3-forced-aligner",
                    language=language,
                    warnings=tuple(warnings),
                )
            )

        return AlignmentResult(
            lines=aligned_lines,
            backend="qwen3-forced-aligner",
            language=language,
            audio_path=Path(audio_path).resolve(),
            model_id=self.model_id,
            processing_seconds=time.perf_counter() - started,
            warnings=global_warnings,
            metadata={
                "device": self.device,
                "adapter": str(self.adapter) if self.adapter else None,
                "adapter_signature": self.adapter_signature,
                "token_count": len(spans),
                "line_count": len(aligned_lines),
            },
        )
