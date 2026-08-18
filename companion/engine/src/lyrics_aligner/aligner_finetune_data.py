from __future__ import annotations

from collections.abc import Callable
from typing import Any


def merge_gold_token_spans(
    qwen_words: list[str],
    gold_tokens: list[dict[str, Any]],
    *,
    cleaner: Callable[[str], str],
) -> list[tuple[float, float]] | None:
    """Map Qwen words to one or more contiguous Apple timed units.

    Apple Word TTML sometimes splits a written word into sung syllables
    (``che`` + ``mi`` + ``cals``). Qwen's aligner expects the written word,
    so merge only when the normalized units concatenate exactly. Empty
    censored units are ignored; fuzzy or reordered matches are rejected.
    """

    cleaned_gold = [
        (
            cleaner(str(token.get("text", ""))).casefold(),
            float(token["start"]),
            float(token["end"]),
        )
        for token in gold_tokens
    ]
    cleaned_gold = [item for item in cleaned_gold if item[0]]
    spans: list[tuple[float, float]] = []
    cursor = 0
    for word in qwen_words:
        target = cleaner(word).casefold()
        if not target:
            continue
        start_cursor = cursor
        combined = ""
        while cursor < len(cleaned_gold) and len(combined) < len(target):
            combined += cleaned_gold[cursor][0]
            cursor += 1
            if not target.startswith(combined):
                return None
        if combined != target or cursor <= start_cursor:
            return None
        spans.append(
            (
                cleaned_gold[start_cursor][1],
                cleaned_gold[cursor - 1][2],
            )
        )
    if cursor != len(cleaned_gold) or len(spans) != len(qwen_words):
        return None
    return spans


def timestamp_bins(
    spans: list[tuple[float, float]],
    *,
    clip_start: float,
    clip_end: float,
    segment_milliseconds: float,
    class_count: int,
    overlap_tolerance: float = 0.02,
) -> list[int] | None:
    if segment_milliseconds <= 0.0 or class_count <= 0:
        raise ValueError("时间戳量化参数必须为正数。")
    clip_duration = clip_end - clip_start
    if clip_duration <= 0.0:
        return None
    bins: list[int] = []
    previous = 0
    previous_end: float | None = None
    for start, end in spans:
        if previous_end is not None and start < previous_end - overlap_tolerance:
            return None
        relative_start = max(0.0, min(clip_duration, start - clip_start))
        relative_end = max(relative_start, min(clip_duration, end - clip_start))
        start_bin = round(relative_start * 1000.0 / segment_milliseconds)
        end_bin = round(relative_end * 1000.0 / segment_milliseconds)
        start_bin = max(previous, min(class_count - 1, start_bin))
        end_bin = max(start_bin, min(class_count - 1, end_bin))
        bins.extend((start_bin, end_bin))
        previous = end_bin
        previous_end = end
    return bins
