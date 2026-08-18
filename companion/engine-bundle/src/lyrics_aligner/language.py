from __future__ import annotations

from collections import Counter
from functools import lru_cache
import re

from .types import TranscriptLine

SUPPORTED_QWEN_LANGUAGES = (
    "Chinese",
    "English",
    "Cantonese",
    "French",
    "German",
    "Italian",
    "Japanese",
    "Korean",
    "Portuguese",
    "Russian",
    "Spanish",
)

_LATIN_LANGUAGE_NAMES = (
    "English",
    "French",
    "German",
    "Italian",
    "Portuguese",
    "Spanish",
)
_LATIN_CONFIDENCE_MINIMUM = 0.55
_LATIN_MARGIN_MINIMUM = 0.25
_LATIN_NON_ENGLISH = frozenset(_LATIN_LANGUAGE_NAMES) - {"English"}
_ENGLISH_MARKERS = frozenset(
    {
        "and",
        "are",
        "divine",
        "don't",
        "i",
        "i'll",
        "intervention",
        "is",
        "love",
        "me",
        "my",
        "the",
        "this",
        "through",
        "till",
        "to",
        "you",
    }
)
_LATIN_WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.UNICODE)
_JAPANESE_RANGES = (
    (0x3040, 0x309F),
    (0x30A0, 0x30FF),
    (0x31F0, 0x31FF),
    (0xFF66, 0xFF9D),
)
_KOREAN_RANGES = (
    (0x1100, 0x11FF),
    (0x3130, 0x318F),
    (0xA960, 0xA97F),
    (0xAC00, 0xD7AF),
    (0xD7B0, 0xD7FF),
)
_HAN_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
)
_CYRILLIC_RANGES = ((0x0400, 0x052F),)


def _in_ranges(character: str, ranges: tuple[tuple[int, int], ...]) -> bool:
    codepoint = ord(character)
    return any(start <= codepoint <= end for start, end in ranges)


def _count_in_ranges(
    text: str,
    ranges: tuple[tuple[int, int], ...],
) -> int:
    return sum(_in_ranges(character, ranges) for character in text)


def _explicit_script_languages(text: str) -> list[tuple[str, int]]:
    kana = _count_in_ranges(text, _JAPANESE_RANGES)
    hangul = _count_in_ranges(text, _KOREAN_RANGES)
    han = _count_in_ranges(text, _HAN_RANGES)
    cyrillic = _count_in_ranges(text, _CYRILLIC_RANGES)
    languages: list[tuple[str, int]] = []
    if kana:
        languages.append(("Japanese", kana))
    if hangul:
        languages.append(("Korean", hangul))
    # Japanese lyrics routinely use Han characters. A line containing kana is
    # not evidence that an additional Chinese ASR pass is useful.
    if han and not kana:
        languages.append(("Chinese", han))
    if cyrillic:
        languages.append(("Russian", cyrillic))
    return languages


def has_explicit_language_script(text: str, language: str) -> bool:
    return any(
        script_language == language
        for script_language, _ in _explicit_script_languages(text)
    )


@lru_cache(maxsize=1)
def _latin_detector():
    try:
        from lingua import Language, LanguageDetectorBuilder
    except ImportError:
        return None
    languages = tuple(
        getattr(Language, language.upper())
        for language in _LATIN_LANGUAGE_NAMES
    )
    return LanguageDetectorBuilder.from_languages(*languages).build()


def _detect_latin_language(text: str) -> str:
    detector = _latin_detector()
    if detector is None:
        return "English"
    confidences = detector.compute_language_confidence_values(text)
    if not confidences:
        return "English"
    best = confidences[0]
    detected = best.language.name.title()
    if detected == "English":
        return "English"
    runner_up = confidences[1].value if len(confidences) > 1 else 0.0
    if (
        best.value >= _LATIN_CONFIDENCE_MINIMUM
        and best.value - runner_up >= _LATIN_MARGIN_MINIMUM
    ):
        return detected
    # Short lyric fragments, names and romanized minority languages are easy
    # to over-classify. English is the conservative Whisper fallback; other
    # languages are enabled as soon as at least one sufficiently clear line
    # identifies them.
    return "English"


def _strong_english_fragment(text: str) -> bool:
    words = {
        word.casefold().replace("’", "'")
        for word in _LATIN_WORD.findall(text)
    }
    return len(words & _ENGLISH_MARKERS) >= 2


def detect_line_language(text: str) -> str:
    scripts = dict(_explicit_script_languages(text))
    for language in ("Japanese", "Korean", "Chinese", "Russian"):
        if scripts.get(language):
            return language
    return _detect_latin_language(text)


def detect_line_languages(texts: list[str]) -> list[str]:
    """Detect lyric lines, smoothing only ambiguous Latin-script runs.

    Songs commonly contain short fragments that are too small for reliable
    standalone identification. An ambiguous run bounded by the same clear
    Latin language inherits that language, unless it contains strong English
    function-word evidence. Script-detected CJK/Cyrillic lines are never
    smoothed this way.
    """

    labels = [detect_line_language(text) for text in texts]
    if len(labels) < 3:
        return labels
    index = 0
    while index < len(labels):
        if labels[index] != "English" or _strong_english_fragment(texts[index]):
            index += 1
            continue
        start = index
        while (
            index < len(labels)
            and labels[index] == "English"
            and not _strong_english_fragment(texts[index])
        ):
            index += 1
        end = index
        left = labels[start - 1] if start else None
        right = labels[end] if end < len(labels) else None
        if (
            end - start <= 3
            and left == right
            and left in _LATIN_NON_ENGLISH
        ):
            labels[start:end] = [left] * (end - start)
    return labels


def candidate_languages(lines: list[TranscriptLine]) -> list[str]:
    weighted: Counter[str] = Counter()
    for line in lines:
        language = line.detected_language or detect_line_language(line.text)
        weighted[language] += max(1, len(line.text))
        # A single mixed-script line still needs every explicit script pass.
        # Its primary label remains stable for merging, while secondary
        # scripts become available as alternate acoustic evidence.
        for script_language, character_count in _explicit_script_languages(
            line.text
        ):
            if script_language != language:
                weighted[script_language] += max(1, character_count)
    if not weighted:
        return ["English"]
    return [
        language
        for language, _ in sorted(
            weighted.items(), key=lambda item: (-item[1], item[0])
        )
        if language in SUPPORTED_QWEN_LANGUAGES
    ]


def dominant_language(lines: list[TranscriptLine]) -> str:
    return candidate_languages(lines)[0]
