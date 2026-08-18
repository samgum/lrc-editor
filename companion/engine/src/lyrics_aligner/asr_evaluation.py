from __future__ import annotations

from collections import defaultdict
import re
import unicodedata
from typing import Iterable, Sequence, TypeVar


_T = TypeVar("_T")
_SPACE = re.compile(r"\s+")


def target_text(value: str) -> str:
    marker = "<asr_text>"
    return value.split(marker, 1)[1] if marker in value else value


def target_language(value: str) -> str:
    prefix = "language "
    marker = "<asr_text>"
    if value.startswith(prefix) and marker in value:
        return value[len(prefix) : value.index(marker)]
    return "None"


def normalize_asr_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = normalized.replace("’", "'")
    characters = [
        character
        if (
            character.isspace()
            or unicodedata.category(character)[0] in {"L", "N"}
        )
        else " "
        for character in normalized
    ]
    return _SPACE.sub(" ", "".join(characters)).strip()


def edit_distance(reference: Sequence[_T], hypothesis: Sequence[_T]) -> int:
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for row, reference_item in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_item in enumerate(hypothesis, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1]
                    + (reference_item != hypothesis_item),
                )
            )
        previous = current
    return previous[-1]


def error_counts(reference: str, hypothesis: str) -> dict[str, int]:
    normalized_reference = normalize_asr_text(reference)
    normalized_hypothesis = normalize_asr_text(hypothesis)
    reference_words = normalized_reference.split()
    hypothesis_words = normalized_hypothesis.split()
    reference_characters = list(normalized_reference.replace(" ", ""))
    hypothesis_characters = list(normalized_hypothesis.replace(" ", ""))
    return {
        "word_edits": edit_distance(reference_words, hypothesis_words),
        "reference_words": len(reference_words),
        "character_edits": edit_distance(
            reference_characters,
            hypothesis_characters,
        ),
        "reference_characters": len(reference_characters),
        "exact": int(normalized_reference == normalized_hypothesis),
    }


def summarize_predictions(
    predictions: Iterable[dict[str, object]],
) -> dict[str, object]:
    rows = list(predictions)
    totals = defaultdict(int)
    language_totals: dict[str, defaultdict[str, int]] = defaultdict(
        lambda: defaultdict(int)
    )
    group_totals: dict[str, defaultdict[str, int]] = defaultdict(
        lambda: defaultdict(int)
    )
    group_language_totals: dict[
        tuple[str, str], defaultdict[str, int]
    ] = defaultdict(lambda: defaultdict(int))
    language_correct = 0
    language_evaluated = 0
    for row in rows:
        language = str(row["target_language"])
        group = str(row.get("group") or "Unknown")
        counts = error_counts(
            str(row["reference"]),
            str(row["hypothesis"]),
        )
        for name, value in counts.items():
            totals[name] += value
            language_totals[language][name] += value
            group_totals[group][name] += value
            group_language_totals[(group, language)][name] += value
        language_totals[language]["samples"] += 1
        group_totals[group]["samples"] += 1
        group_language_totals[(group, language)]["samples"] += 1
        if language != "None":
            language_evaluated += 1
            if str(row.get("detected_language", "")).casefold() == (
                language.casefold()
            ):
                language_correct += 1

    def metrics(counts: dict[str, int]) -> dict[str, float | int]:
        reference_words = counts.get("reference_words", 0)
        reference_characters = counts.get("reference_characters", 0)
        samples = counts.get("samples", len(rows))
        return {
            "samples": samples,
            "wer": (
                counts.get("word_edits", 0) / reference_words
                if reference_words
                else 0.0
            ),
            "cer": (
                counts.get("character_edits", 0)
                / reference_characters
                if reference_characters
                else 0.0
            ),
            "exact_match": (
                counts.get("exact", 0) / samples if samples else 0.0
            ),
        }

    totals["samples"] = len(rows)
    return {
        "aggregate": {
            **metrics(totals),
            "language_accuracy": (
                language_correct / language_evaluated
                if language_evaluated
                else None
            ),
            "language_evaluated": language_evaluated,
        },
        "by_language": {
            language: metrics(dict(counts))
            for language, counts in sorted(language_totals.items())
        },
        "by_group": {
            group: metrics(dict(counts))
            for group, counts in sorted(group_totals.items())
        },
        "by_group_language": {
            group: {
                language: metrics(
                    dict(group_language_totals[(group, language)])
                )
                for candidate_group, language in sorted(
                    group_language_totals
                )
                if candidate_group == group
            }
            for group in sorted(
                {group for group, _ in group_language_totals}
            )
        },
    }
