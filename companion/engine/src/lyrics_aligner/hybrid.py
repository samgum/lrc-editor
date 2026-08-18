from __future__ import annotations

from dataclasses import replace

from .asr_matching import CoarseLineAnchor
from .language import has_explicit_language_script
from .types import TranscriptLine

_SCRIPT_LANGUAGES = frozenset(
    {"Chinese", "Japanese", "Korean", "Russian"}
)
# Sparse script passes exist to resolve the actual code-switched lyric, not
# to replace acoustically similar lines nearby in another language.
_SPARSE_SCRIPT_CONTEXT_RADIUS = 0


def merge_language_anchor_passes(
    lines: list[TranscriptLine],
    anchors_by_language: dict[str, list[CoarseLineAnchor]],
) -> tuple[list[CoarseLineAnchor], list[str]]:
    """Choose one globally monotonic path across all language passes.

    A greedy line-by-line merge can select a plausible timestamp from the
    wrong repetition and then make every later correct candidate
    non-monotonic. Dynamic programming lets later high-quality anchors vote
    against that locally attractive dead end.
    """

    if not anchors_by_language:
        raise ValueError("没有语言锚点可合并。")
    if any(len(anchors) != len(lines) for anchors in anchors_by_language.values()):
        raise ValueError("语言锚点数量与歌词行不一致。")

    languages = list(anchors_by_language)
    negative_infinity = -1e30
    sparse_script_contexts: dict[str, set[int]] = {}
    for language in languages:
        if language not in _SCRIPT_LANGUAGES:
            continue
        # Keep a normal language pass globally available whenever at least one
        # lyric line identifies it as the primary language. Restrict only
        # secondary-script passes (for example Hangul embedded in a Japanese
        # line), which otherwise tend to win unrelated phonetic lookalikes.
        if any(line.detected_language == language for line in lines):
            continue
        evidence = [
            index
            for index, line in enumerate(lines)
            if has_explicit_language_script(line.text, language)
        ]
        if not evidence:
            continue
        sparse_script_contexts[language] = {
            nearby
            for index in evidence
            for nearby in range(
                max(0, index - _SPARSE_SCRIPT_CONTEXT_RADIUS),
                min(
                    len(lines),
                    index + _SPARSE_SCRIPT_CONTEXT_RADIUS + 1,
                ),
            )
        }

    def pass_is_eligible(index: int, language: str) -> bool:
        context = sparse_script_contexts.get(language)
        return context is None or index in context

    scores = [
        [negative_infinity] * len(languages)
        for _ in lines
    ]
    traces = [[-1] * len(languages) for _ in lines]

    def local_score(index: int, pass_index: int) -> float:
        language = languages[pass_index]
        anchor = anchors_by_language[language][index]
        coverage = anchor.matched_units / max(1, anchor.total_units)
        score = (
            2.0 * anchor.confidence
            + 0.5 * coverage
            + (1.0 if not anchor.interpolated else -0.4)
            - 0.15 * min(3.0, anchor.start_uncertainty)
        )
        preferred = lines[index].detected_language or languages[0]
        if language == preferred:
            score += 0.2 if not anchor.interpolated else 0.05
        return score

    for pass_index, language in enumerate(languages):
        if pass_is_eligible(0, language):
            scores[0][pass_index] = local_score(0, pass_index)
    for index in range(1, len(lines)):
        for pass_index, language in enumerate(languages):
            if not pass_is_eligible(index, language):
                continue
            anchor = anchors_by_language[language][index]
            local = local_score(index, pass_index)
            for previous_index, previous_language in enumerate(languages):
                previous_anchor = anchors_by_language[previous_language][
                    index - 1
                ]
                if anchor.start < previous_anchor.start - 0.04:
                    continue
                transition = 0.0
                if (
                    not anchor.interpolated
                    and anchor.start < previous_anchor.end - 1.5
                ):
                    transition -= (
                        previous_anchor.end - 1.5 - anchor.start
                    )
                candidate = (
                    scores[index - 1][previous_index]
                    + local
                    + transition
                )
                if candidate > scores[index][pass_index]:
                    scores[index][pass_index] = candidate
                    traces[index][pass_index] = previous_index

        if max(scores[index]) <= negative_infinity / 2:
            # Extremely broken passes can all move backwards at the same
            # point. Preserve a path so the chronological repair below can
            # still produce a usable diagnostic result.
            previous_index = max(
                range(len(languages)),
                key=lambda item: scores[index - 1][item],
            )
            for pass_index in range(len(languages)):
                scores[index][pass_index] = (
                    scores[index - 1][previous_index]
                    + local_score(index, pass_index)
                    - 10.0
                )
                traces[index][pass_index] = previous_index

    pass_index = max(
        range(len(languages)),
        key=lambda item: scores[-1][item],
    )
    reversed_passes: list[str] = []
    for index in range(len(lines) - 1, -1, -1):
        reversed_passes.append(languages[pass_index])
        pass_index = traces[index][pass_index]
    chosen_passes = list(reversed(reversed_passes))
    chosen = [
        anchors_by_language[language][index]
        for index, language in enumerate(chosen_passes)
    ]

    previous = 0.0
    previous_end = 0.0
    for index, anchor in enumerate(chosen):
        if anchor.interpolated and anchor.start < previous_end - 0.3:
            repaired_start = max(previous, previous_end - 0.2)
            anchor = replace(
                anchor,
                start=repaired_start,
                end=max(repaired_start, anchor.end),
                confidence=0.0,
                method="overlap_repair",
            )
        if anchor.start < previous:
            anchor = replace(
                anchor,
                start=previous,
                end=max(previous, anchor.end),
                confidence=min(anchor.confidence, 0.2),
                interpolated=True,
                method="monotonic_repair",
            )
        chosen[index] = anchor
        previous = anchor.start
        previous_end = max(anchor.start, anchor.end)
    return chosen, chosen_passes
