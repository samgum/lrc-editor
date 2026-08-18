from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


_PARENTHETICAL_GROUP = re.compile(
    r"\([^()]*\)|（[^（）]*）|\[[^\[\]]*\]|【[^【】]*】"
)


@dataclass(frozen=True, slots=True)
class LexicalUnit:
    value: str
    source_index: int
    part_index: int
    part_count: int


def _is_cjk_or_kana(character: str) -> bool:
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
        or 0x3040 <= codepoint <= 0x30FF
        or 0x31F0 <= codepoint <= 0x31FF
        or 0xAC00 <= codepoint <= 0xD7AF
    )


def _normalize_latin(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    return "".join(
        character
        for character in folded
        if not unicodedata.combining(character)
        and (character.isalnum() or _is_cjk_or_kana(character))
    )


def lexical_values(text: str) -> list[str]:
    """Tokenize Latin text by word and CJK/kana/Hangul text by character."""

    values: list[str] = []
    latin_buffer: list[str] = []

    def flush() -> None:
        if not latin_buffer:
            return
        normalized = _normalize_latin("".join(latin_buffer))
        if normalized:
            values.append(normalized)
        latin_buffer.clear()

    for character in unicodedata.normalize("NFKC", text):
        if _is_cjk_or_kana(character):
            flush()
            normalized = _normalize_latin(character)
            if normalized:
                values.append(normalized)
        elif character.isalnum() or character in {"'", "’"}:
            latin_buffer.append(character)
        else:
            flush()
    flush()
    return values


def primary_lexical_values(text: str) -> list[str]:
    """Tokenize the main lyric while ignoring parenthetical backing vocals.

    Parenthetical echoes often vary between otherwise identical chorus rows.
    They remain part of normal ASR matching, but excluding them from a
    structural signature lets repeated-section repair recognize the shared
    lead vocal. If a row contains only a parenthetical phrase, retain it.
    """

    primary = text
    while True:
        stripped = _PARENTHETICAL_GROUP.sub(" ", primary)
        if stripped == primary:
            break
        primary = stripped
    values = lexical_values(primary)
    return values or lexical_values(text)


def lexical_units(texts: list[str]) -> list[LexicalUnit]:
    units: list[LexicalUnit] = []
    for source_index, text in enumerate(texts):
        values = lexical_values(text)
        for part_index, value in enumerate(values):
            units.append(
                LexicalUnit(
                    value=value,
                    source_index=source_index,
                    part_index=part_index,
                    part_count=len(values),
                )
            )
    return units
