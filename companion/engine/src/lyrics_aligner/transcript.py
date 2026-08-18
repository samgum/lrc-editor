from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

from .language import detect_line_languages
from .types import TranscriptLine

_LRC_TAG = re.compile(
    r"\[(?P<minutes>\d{1,3}):(?P<seconds>\d{1,2})(?:[.:](?P<fraction>\d{1,3}))?\]"
)
_LEADING_LRC = re.compile(
    r"^\s*(?P<tags>(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+)(?P<text>.*)$"
)
_ENHANCED_LRC_TAG = re.compile(
    r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>"
)
_METADATA_TAG = re.compile(r"^\s*\[[A-Za-z][A-Za-z0-9_-]*\s*:")
_SRT_TIMING = re.compile(
    r"^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*"
    r"\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}"
)
_SRT_INDEX = re.compile(r"^\s*\d+\s*$")


def _parse_lrc_seconds(match: re.Match[str]) -> float:
    fraction = match.group("fraction") or ""
    milliseconds = int(fraction.ljust(3, "0")) if fraction else 0
    return (
        int(match.group("minutes")) * 60
        + int(match.group("seconds"))
        + milliseconds / 1000
    )


def decode_transcript_file(path: str | Path) -> str:
    raw = Path(path).read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


@lru_cache(maxsize=1)
def _traditional_to_simplified():
    try:
        from opencc import OpenCC
    except ImportError:
        return None
    return OpenCC("t2s")


def _same_axis_key(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    converter = _traditional_to_simplified()
    if converter is not None:
        normalized = converter.convert(normalized)
    return " ".join(normalized.casefold().split())


def _deduplicate_same_axis(
    provisional: list[tuple[int, str, float | None, bool]],
) -> list[tuple[int, str, float | None, bool]]:
    retained: list[tuple[int, str, float | None, bool]] = []
    keys_by_axis: dict[int, list[str]] = {}
    carry_blank = False
    for source_line, text, reference, blank_before in provisional:
        effective_blank = blank_before or carry_blank
        if reference is None:
            retained.append(
                (source_line, text, reference, effective_blank)
            )
            carry_blank = False
            continue
        millisecond = round(reference * 1000)
        key = _same_axis_key(text)
        seen = keys_by_axis.setdefault(millisecond, [])
        duplicate = any(
            key == existing
            or (
                min(len(key), len(existing)) >= 5
                and SequenceMatcher(
                    None,
                    key,
                    existing,
                    autojunk=False,
                ).ratio()
                >= 0.86
            )
            for existing in seen
        )
        if duplicate:
            # If the discarded duplicate followed a paragraph separator,
            # carry that separator to the next visible lyric instead of
            # moving it backwards onto the retained copy.
            carry_blank = effective_blank
            continue
        seen.append(key)
        retained.append(
            (source_line, text, reference, effective_blank)
        )
        carry_blank = False
    return retained


def parse_transcript_text(
    text: str,
    *,
    preserve_blank_lines: bool = True,
) -> list[TranscriptLine]:
    provisional: list[tuple[int, str, float | None, bool]] = []
    saw_srt_timing = any(_SRT_TIMING.match(line) for line in text.splitlines())
    pending_blank = False
    have_lyric = False

    for source_line, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip().replace("\ufeff", "")
        if not line:
            if preserve_blank_lines and have_lyric and not saw_srt_timing:
                pending_blank = True
            continue
        if saw_srt_timing and (
            _SRT_TIMING.match(line) or _SRT_INDEX.fullmatch(line)
        ):
            continue
        if _METADATA_TAG.match(line):
            continue

        leading = _LEADING_LRC.match(line)
        if leading:
            cleaned = _ENHANCED_LRC_TAG.sub("", leading.group("text")).strip()
            if not cleaned:
                if (
                    preserve_blank_lines
                    and have_lyric
                    and not saw_srt_timing
                ):
                    # A timestamp-only LRC row is the portable representation
                    # of a section blank. It remains layout metadata and never
                    # becomes a lyric row sent to the aligner.
                    pending_blank = True
                continue
            timestamps = [
                _parse_lrc_seconds(match)
                for match in _LRC_TAG.finditer(leading.group("tags"))
            ]
            for timestamp in timestamps or [None]:
                provisional.append(
                    (source_line, cleaned, timestamp, pending_blank)
                )
            pending_blank = False
            have_lyric = True
            continue

        cleaned = _ENHANCED_LRC_TAG.sub("", line).strip()
        if cleaned:
            provisional.append(
                (source_line, cleaned, None, pending_blank)
            )
            pending_blank = False
            have_lyric = True

    # Multiple leading LRC timestamps express repeated occurrences. When every
    # retained lyric line has an axis, timestamp order is the authoritative
    # reading order; timestamps themselves are not passed to the aligner.
    if provisional and all(item[2] is not None for item in provisional):
        provisional.sort(key=lambda item: (float(item[2]), item[0]))
        provisional = _deduplicate_same_axis(provisional)

    detected_languages = detect_line_languages(
        [line_text for _, line_text, _, _ in provisional]
    )
    return [
        TranscriptLine(
            index=index,
            text=line_text,
            source_line=source_line,
            reference_start=reference,
            detected_language=detected_language,
            blank_before=blank_before and index > 1,
        )
        for index, (
            (source_line, line_text, reference, blank_before),
            detected_language,
        ) in enumerate(
            zip(provisional, detected_languages, strict=True),
            start=1,
        )
    ]


def parse_transcript_file(
    path: str | Path,
    *,
    preserve_blank_lines: bool = True,
) -> list[TranscriptLine]:
    return parse_transcript_text(
        decode_transcript_file(path),
        preserve_blank_lines=preserve_blank_lines,
    )


def cleaned_transcript(lines: list[TranscriptLine]) -> str:
    return "\n".join(line.text for line in lines)
