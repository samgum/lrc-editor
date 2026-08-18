from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

from ..audio import probe_duration
from ..types import AlignmentResult, LineAlignment, TokenSpan, TranscriptLine

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


class WhisperXAlignmentError(RuntimeError):
    pass


class WhisperXBackend:
    def __init__(self, device: str = "auto") -> None:
        self.device = device
        self._whisperx: Any | None = None
        self._model: Any | None = None
        self._metadata: Any | None = None
        self._loaded_language: str | None = None

    def load(self, language: str) -> None:
        import torch
        import whisperx

        if self.device == "auto":
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        code = _LANGUAGE_CODES.get(language)
        if not code:
            raise WhisperXAlignmentError(
                f"WhisperX 尚未配置 {language} 的对齐模型。"
            )
        if self._model is not None and self._loaded_language == code:
            return
        self._model, self._metadata = whisperx.load_align_model(
            language_code=code,
            device=self.device,
        )
        self._whisperx = whisperx
        self._loaded_language = code

    def unload(self) -> None:
        self._model = None
        self._metadata = None
        if self._whisperx is not None:
            import gc
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    @staticmethod
    def _line_words(line: TranscriptLine) -> list[str]:
        return line.text.split()

    @staticmethod
    def _number(value: Any) -> float | None:
        if value is None:
            return None
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None

    def align(
        self,
        audio_path: str | Path,
        lines: list[TranscriptLine],
        language: str,
    ) -> AlignmentResult:
        if not lines:
            raise WhisperXAlignmentError("文字稿清理后没有可对齐的歌词行。")
        self.load(language)
        assert self._whisperx is not None
        assert self._model is not None
        assert self._metadata is not None

        started = time.perf_counter()
        audio = self._whisperx.load_audio(str(Path(audio_path).resolve()))
        transcript = " ".join(line.text for line in lines)
        duration = probe_duration(audio_path)
        result = self._whisperx.align(
            [{"start": 0.0, "end": duration, "text": transcript}],
            self._model,
            self._metadata,
            audio,
            self.device,
            return_char_alignments=False,
            print_progress=False,
        )
        raw_words = list(result.get("word_segments", []))
        expected_count = sum(len(self._line_words(line)) for line in lines)
        if len(raw_words) != expected_count:
            raise WhisperXAlignmentError(
                "WhisperX 返回词数与文字稿不一致，"
                f"expected={expected_count} actual={len(raw_words)}。"
            )

        aligned_lines: list[LineAlignment] = []
        warnings: list[str] = []
        cursor = 0
        previous_start = 0.0
        for line in lines:
            expected_words = self._line_words(line)
            selected_raw = raw_words[cursor : cursor + len(expected_words)]
            cursor += len(expected_words)
            token_spans: list[TokenSpan] = []
            for raw in selected_raw:
                start = self._number(raw.get("start"))
                end = self._number(raw.get("end"))
                if start is None or end is None:
                    continue
                token_spans.append(
                    TokenSpan(
                        text=str(raw.get("word", "")).strip(),
                        start=start,
                        end=end,
                    )
                )
            line_warnings: list[str] = []
            if token_spans:
                start = token_spans[0].start
                end = max(token.end for token in token_spans)
            else:
                start = previous_start
                end = start
                line_warnings.append("no_aligned_words")
                warnings.append(f"第 {line.index} 行没有可用词时间。")
            if start < previous_start:
                line_warnings.append("non_monotonic_start")
            previous_start = max(previous_start, start)
            aligned_lines.append(
                LineAlignment(
                    line=line,
                    start=max(0.0, start),
                    end=max(start, end),
                    tokens=tuple(token_spans),
                    backend="whisperx",
                    language=language,
                    warnings=tuple(line_warnings),
                )
            )

        return AlignmentResult(
            lines=aligned_lines,
            backend="whisperx",
            language=language,
            audio_path=Path(audio_path).resolve(),
            model_id=str(self._metadata.get("model_name", "whisperx-default")),
            processing_seconds=time.perf_counter() - started,
            warnings=warnings,
            metadata={
                "device": self.device,
                "line_count": len(aligned_lines),
                "word_count": len(raw_words),
                "language_code": self._loaded_language,
            },
        )

    def align_windows(
        self,
        audio_path: str | Path,
        lines: list[TranscriptLine],
        windows: list[tuple[float, float]],
    ) -> AlignmentResult:
        """Align each known line only inside its coarse ASR time window."""

        if len(lines) != len(windows):
            raise ValueError("歌词行与局部窗口数量不一致。")
        if not lines:
            raise WhisperXAlignmentError("没有可局部对齐的歌词行。")

        import whisperx

        started = time.perf_counter()
        source = Path(audio_path).resolve()
        audio = whisperx.load_audio(str(source))
        grouped: dict[str, list[int]] = {}
        for index, line in enumerate(lines):
            grouped.setdefault(
                line.detected_language or "English",
                [],
            ).append(index)

        aligned: list[LineAlignment | None] = [None] * len(lines)
        warnings: list[str] = []
        model_ids: dict[str, str] = {}
        for language, indices in grouped.items():
            self.load(language)
            assert self._whisperx is not None
            assert self._model is not None
            assert self._metadata is not None
            model_ids[language] = str(
                self._metadata.get("model_name", "whisperx-default")
            )
            for index in indices:
                line = lines[index]
                window_start, window_end = windows[index]
                result = self._whisperx.align(
                    [
                        {
                            "start": window_start,
                            "end": window_end,
                            "text": line.text,
                        }
                    ],
                    self._model,
                    self._metadata,
                    audio,
                    self.device,
                    return_char_alignments=False,
                    print_progress=False,
                )
                token_spans: list[TokenSpan] = []
                scores: list[float] = []
                for raw in result.get("word_segments", []):
                    start = self._number(raw.get("start"))
                    end = self._number(raw.get("end"))
                    if start is None or end is None:
                        continue
                    token_spans.append(
                        TokenSpan(
                            text=str(raw.get("word", "")).strip(),
                            start=start,
                            end=end,
                        )
                    )
                    score = self._number(raw.get("score"))
                    if score is not None:
                        scores.append(score)
                line_warnings: list[str] = []
                if token_spans:
                    line_start = token_spans[0].start
                    line_end = max(token.end for token in token_spans)
                else:
                    line_start = window_start
                    line_end = window_start
                    line_warnings.append("no_aligned_words")
                    warnings.append(f"第 {line.index} 行没有局部 CTC 词时间。")
                if scores and sum(scores) / len(scores) < 0.35:
                    line_warnings.append("low_ctc_score")
                aligned[index] = LineAlignment(
                    line=line,
                    start=line_start,
                    end=max(line_start, line_end),
                    tokens=tuple(token_spans),
                    backend="whisperx-windowed",
                    language=language,
                    warnings=tuple(line_warnings),
                )
            self.unload()

        completed = [item for item in aligned if item is not None]
        if len(completed) != len(lines):
            raise WhisperXAlignmentError("局部 CTC 对齐没有覆盖全部歌词行。")
        return AlignmentResult(
            lines=completed,
            backend="whisperx-windowed",
            language="multilingual" if len(grouped) > 1 else next(iter(grouped)),
            audio_path=source,
            model_id=json.dumps(model_ids, ensure_ascii=False, sort_keys=True),
            processing_seconds=time.perf_counter() - started,
            warnings=warnings,
            metadata={
                "device": self.device,
                "window_count": len(windows),
                "languages": sorted(grouped),
            },
        )
