from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .audio import probe_duration
from .transcript import parse_transcript_file

_AUDIO_EXTENSIONS = (".m4a", ".flac", ".wav", ".mp3", ".aac", ".ogg")
_PLACEHOLDER = re.compile(
    r"^\s*(?:纯音乐|純音樂|无歌词|無歌詞|暂无歌词|暫無歌詞|"
    r"instrumental|music only|no lyrics?)\s*[.!。！]?\s*$",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class ManifestPair:
    root: Path
    audio: Path
    transcript: Path


def _stem_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return normalized.translate(
        str.maketrans({"’": "'", "‘": "'", "‛": "'", "`": "'"})
    )


def _find_audio(transcript: Path) -> Path | None:
    for extension in _AUDIO_EXTENSIONS:
        candidate = transcript.with_suffix(extension)
        if candidate.is_file():
            return candidate
    siblings = {
        item.suffix.casefold(): item
        for item in transcript.parent.iterdir()
        if item.is_file() and _stem_key(item.stem) == _stem_key(transcript.stem)
    }
    for extension in _AUDIO_EXTENSIONS:
        if extension in siblings:
            return siblings[extension]
    return None


def discover_pairs(roots: list[Path]) -> tuple[list[ManifestPair], list[dict[str, str]]]:
    pairs: list[ManifestPair] = []
    excluded: list[dict[str, str]] = []
    for root in roots:
        resolved = root.resolve()
        if not resolved.is_dir():
            excluded.append({"root": str(resolved), "reason": "missing_root"})
            continue
        for transcript in sorted(
            resolved.rglob("*.lrc"),
            key=lambda path: str(path).casefold(),
        ):
            audio = _find_audio(transcript)
            if audio is None:
                excluded.append(
                    {
                        "transcript": str(transcript.resolve()),
                        "reason": "missing_same_stem_audio",
                    }
                )
                continue
            pairs.append(
                ManifestPair(
                    root=resolved,
                    audio=audio.resolve(),
                    transcript=transcript.resolve(),
                )
            )
    return pairs, excluded


def _substantive_lyrics(texts: list[str]) -> tuple[bool, str | None]:
    useful = [text.strip() for text in texts if text.strip()]
    if not useful:
        return False, "empty_after_cleaning"
    if all(_PLACEHOLDER.fullmatch(text) for text in useful):
        return False, "lyrics_placeholder"
    visible_characters = sum(
        character.isalnum()
        for text in useful
        for character in text
    )
    if len(useful) < 2 or visible_characters < 12:
        return False, "not_substantive"
    return True, None


def _entry_id(audio: Path, transcript: Path) -> str:
    digest = hashlib.sha256(
        f"{audio}\0{transcript}".encode("utf-8")
    ).hexdigest()
    return digest[:16]


def _assign_roles(entries: list[dict[str, object]]) -> None:
    by_root: dict[str, list[dict[str, object]]] = {}
    for entry in entries:
        by_root.setdefault(str(entry["root"]), []).append(entry)
    for group in by_root.values():
        group.sort(key=lambda entry: str(entry["audio"]).casefold())
        calibration = {0, len(group) // 2}
        holdout = len(group) - 1
        if holdout in calibration:
            holdout = -1
        for index, entry in enumerate(group):
            if index in calibration:
                entry["role"] = "calibration"
            elif index == holdout:
                entry["role"] = "holdout"
            else:
                entry["role"] = "reserve"


def build_manifest(roots: list[str | Path]) -> dict[str, object]:
    resolved_roots = [Path(root).resolve() for root in roots]
    pairs, excluded = discover_pairs(resolved_roots)
    entries: list[dict[str, object]] = []
    for pair in pairs:
        lines = parse_transcript_file(pair.transcript)
        substantive, reason = _substantive_lyrics(
            [line.text for line in lines]
        )
        if not substantive:
            excluded.append(
                {
                    "audio": str(pair.audio),
                    "transcript": str(pair.transcript),
                    "reason": str(reason),
                }
            )
            continue
        languages = Counter(
            line.detected_language or "Unknown" for line in lines
        )
        entries.append(
            {
                "id": _entry_id(pair.audio, pair.transcript),
                "root": str(pair.root),
                "audio": str(pair.audio),
                "transcript": str(pair.transcript),
                "duration": round(probe_duration(pair.audio), 6),
                "line_count": len(lines),
                "reference_line_count": sum(
                    line.reference_start is not None for line in lines
                ),
                "languages": dict(sorted(languages.items())),
            }
        )
    _assign_roles(entries)
    role_counts = Counter(str(entry["role"]) for entry in entries)
    language_counts: Counter[str] = Counter()
    for entry in entries:
        language_counts.update(entry["languages"])
    return {
        "schema_version": 1,
        "roots": [str(root) for root in resolved_roots],
        "policy": {
            "discovery": "same-stem LRC plus audio, built once and reused",
            "minimum": "at least 2 non-placeholder lines and 12 alphanumeric characters",
            "roles": {
                "calibration": "small diverse tuning set",
                "holdout": "not used while tuning",
                "reserve": "run only for targeted regression questions",
            },
        },
        "summary": {
            "eligible": len(entries),
            "excluded": len(excluded),
            "roles": dict(sorted(role_counts.items())),
            "line_languages": dict(sorted(language_counts.items())),
        },
        "entries": entries,
        "excluded": excluded,
    }


def write_manifest(payload: dict[str, object], destination: str | Path) -> Path:
    output = Path(destination).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return output
