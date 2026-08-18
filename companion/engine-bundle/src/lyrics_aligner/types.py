from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class TranscriptLine:
    index: int
    text: str
    source_line: int
    reference_start: float | None = None
    detected_language: str | None = None
    blank_before: bool = False


@dataclass(frozen=True, slots=True)
class TokenSpan:
    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class LineAlignment:
    line: TranscriptLine
    start: float
    end: float
    tokens: tuple[TokenSpan, ...] = ()
    backend: str = "qwen3-forced-aligner"
    language: str = "English"
    warnings: tuple[str, ...] = ()


@dataclass(slots=True)
class AlignmentResult:
    lines: list[LineAlignment]
    backend: str
    language: str
    audio_path: Path
    model_id: str
    processing_seconds: float
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["audio_path"] = str(self.audio_path)
        return payload
