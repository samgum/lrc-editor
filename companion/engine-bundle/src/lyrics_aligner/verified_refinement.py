from __future__ import annotations

import math
from dataclasses import dataclass, replace
from itertools import combinations, product
from statistics import median

import numpy as np

from .asr_matching import CoarseLineAnchor
from .lexical import primary_lexical_values
from .types import TranscriptLine


def _soft_onset_indices(
    onset_scores: np.ndarray,
    *,
    minimum_score: float = 5.5,
) -> np.ndarray:
    if len(onset_scores) < 3:
        return np.zeros(0, dtype=np.int64)
    candidates = np.flatnonzero(
        (onset_scores[1:-1] >= onset_scores[:-2])
        & (onset_scores[1:-1] >= onset_scores[2:])
        & (onset_scores[1:-1] >= minimum_score)
    ) + 1
    reduced: list[int] = []
    for candidate in candidates:
        if reduced and candidate - reduced[-1] <= 12:
            if onset_scores[candidate] > onset_scores[reduced[-1]]:
                reduced[-1] = int(candidate)
        else:
            reduced.append(int(candidate))
    return np.asarray(reduced, dtype=np.int64)


@dataclass(slots=True)
class _State:
    lines: list[TranscriptLine]
    original: list[CoarseLineAnchor]
    repaired: list[CoarseLineAnchor]
    values: list[list[str]]
    signatures: list[str]
    hard: list[tuple[float, float]]
    soft: list[tuple[float, float]]
    claimed: set[int]

    def stable(
        self,
        anchor: CoarseLineAnchor,
        *,
        confidence: float = 0.6,
        uncertainty: float = 1.0,
    ) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= confidence
            and anchor.start_uncertainty <= uncertainty
        )

    def hard_supported(
        self,
        start: float,
        *,
        tolerance: float = 0.35,
        minimum_score: float = 9.0,
    ) -> bool:
        return any(
            score >= minimum_score
            and abs(candidate_start - start) <= tolerance
            for candidate_start, score in self.hard
        )

    def commit(
        self,
        indices: list[int],
        starts: list[float],
        *,
        method: str,
        confidence: float = 0.52,
        uncertainty: float = 0.18,
    ) -> bool:
        if (
            not indices
            or len(indices) != len(starts)
            or any(index in self.claimed for index in indices)
            or indices
            != list(range(indices[0], indices[0] + len(indices)))
            or any(
                right - left < 0.28
                for left, right in zip(starts, starts[1:])
            )
        ):
            return False
        if (
            indices[0] > 0
            and starts[0]
            < self.repaired[indices[0] - 1].start + 0.28
        ):
            return False
        if (
            indices[-1] + 1 < len(self.repaired)
            and starts[-1]
            > self.repaired[indices[-1] + 1].start - 0.28
        ):
            return False

        replacements: list[CoarseLineAnchor] = []
        for position, (index, start) in enumerate(
            zip(indices, starts, strict=True)
        ):
            anchor = self.repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            following = (
                starts[position + 1]
                if position + 1 < len(starts)
                else (
                    self.repaired[index + 1].start
                    if index + 1 < len(self.repaired)
                    else math.inf
                )
            )
            end = start + duration
            if math.isfinite(following):
                end = min(end, following)
            replacements.append(
                replace(
                    anchor,
                    start=max(0.0, start),
                    end=max(start, end),
                    confidence=confidence,
                    interpolated=False,
                    method=method,
                    start_uncertainty=uncertainty,
                )
            )
        for index, replacement in zip(
            indices,
            replacements,
            strict=True,
        ):
            self.repaired[index] = replacement
            self.claimed.add(index)
        return True


def _repair_balanced_identical_repeats(state: _State) -> None:
    """Choose a hard-onset chant path balanced by both neighboring rows."""

    run_start = 0
    while run_start < len(state.signatures):
        run_end = run_start + 1
        while (
            run_end < len(state.signatures)
            and state.signatures[run_start]
            and state.signatures[run_end]
            == state.signatures[run_start]
        ):
            run_end += 1
        count = run_end - run_start
        if (
            4 <= count <= 8
            and run_start > 0
            and run_end < len(state.repaired)
            and state.stable(
                state.repaired[run_start - 1],
                confidence=0.45,
                uncertainty=1.2,
            )
            and state.hard_supported(
                state.repaired[run_start - 1].start,
                tolerance=0.35,
                minimum_score=9.0,
            )
            and state.stable(
                state.repaired[run_end],
                confidence=0.5,
                uncertainty=1.2,
            )
        ):
            previous = state.repaired[run_start - 1].start
            following = state.repaired[run_end].start
            current = [
                state.repaired[index].start
                for index in range(run_start, run_end)
            ]
            pool = [
                candidate
                for candidate in state.hard
                if previous + 0.28
                <= candidate[0]
                <= following - 0.28
            ]
            best: tuple[float, list[float]] | None = None
            if count <= len(pool) <= 18:
                current_gaps = [
                    right - left
                    for left, right in zip(current, current[1:])
                ]
                current_center = float(median(current_gaps))
                current_dispersion = sum(
                    abs(gap - current_center)
                    for gap in current_gaps
                )
                current_boundary = abs(
                    (current[0] - previous)
                    - (following - current[-1])
                )
                for option in combinations(pool, count):
                    proposed = [item[0] for item in option]
                    gaps = [
                        right - left
                        for left, right in zip(
                            proposed,
                            proposed[1:],
                        )
                    ]
                    if (
                        min(gaps) < 0.8
                        or max(gaps) > 6.0
                        or max(gaps) - min(gaps) > 0.75
                    ):
                        continue
                    left_boundary = proposed[0] - previous
                    right_boundary = following - proposed[-1]
                    boundary_imbalance = abs(
                        left_boundary - right_boundary
                    )
                    if (
                        min(left_boundary, right_boundary) < 0.7
                        or max(left_boundary, right_boundary) > 8.0
                        or boundary_imbalance > 1.5
                    ):
                        continue
                    proposed_center = float(median(gaps))
                    proposed_dispersion = sum(
                        abs(gap - proposed_center)
                        for gap in gaps
                    )
                    shifts = [
                        abs(new - old)
                        for new, old in zip(
                            proposed,
                            current,
                            strict=True,
                        )
                    ]
                    if (
                        current_dispersion
                        - proposed_dispersion
                        < 0.7
                        or current_boundary
                        - boundary_imbalance
                        < 1.0
                        or sum(shifts) < 4.0
                        or sum(shift >= 1.0 for shift in shifts)
                        < 2
                    ):
                        continue
                    rank = (
                        sum(item[1] for item in option)
                        - 10.0 * proposed_dispersion
                        - 8.0 * boundary_imbalance
                        - 2.0 * sum(shifts)
                    )
                    if best is None or rank > best[0]:
                        best = (rank, proposed)
            if best is not None:
                state.commit(
                    list(range(run_start, run_end)),
                    best[1],
                    method="acoustic_balanced_identical_repeat",
                )
        run_start = run_end


def _repair_shortened_repeat_tails(state: _State) -> None:
    """Use fixed endpoints around four exact rows plus a shortened tail."""

    run_start = 0
    while run_start < len(state.signatures):
        run_end = run_start + 1
        while (
            run_end < len(state.signatures)
            and state.signatures[run_start]
            and state.signatures[run_end]
            == state.signatures[run_start]
        ):
            run_end += 1
        if (
            run_end - run_start >= 4
            and run_end < len(state.signatures)
            and 2
            <= len(state.values[run_end])
            < len(state.values[run_start])
            and state.values[run_start][
                : len(state.values[run_end])
            ]
            == state.values[run_end]
        ):
            end = run_end + 1
            count = end - run_start
            first = state.repaired[run_start]
            final = state.repaired[end - 1]
            period = (final.start - first.start) / (count - 1)
            if (
                state.stable(first, confidence=0.55)
                and state.stable(final, confidence=0.55)
                and 0.8 <= period <= 4.0
            ):
                proposed = [first.start]
                for position in range(1, count - 1):
                    expected = first.start + period * position
                    options = [
                        (
                            score
                            - 10.0 * abs(start - expected),
                            start,
                        )
                        for start, score in state.soft
                        if (
                            abs(start - expected) <= 0.5
                            and start >= proposed[-1] + 0.28
                            and start <= final.start - 0.28
                        )
                    ]
                    if not options:
                        proposed = []
                        break
                    _, start = max(options)
                    proposed.append(start)
                if proposed:
                    proposed.append(final.start)
                    current = [
                        state.repaired[index].start
                        for index in range(run_start, end)
                    ]
                    current_error = sum(
                        abs(
                            (current[position] - first.start)
                            - period * position
                        )
                        for position in range(1, count - 1)
                    )
                    proposed_error = sum(
                        abs(
                            (proposed[position] - first.start)
                            - period * position
                        )
                        for position in range(1, count - 1)
                    )
                    shifts = [
                        abs(new - old)
                        for new, old in zip(
                            proposed,
                            current,
                            strict=True,
                        )
                    ]
                    if (
                        current_error - proposed_error >= 5.0
                        and sum(
                            shift >= 1.5 for shift in shifts
                        )
                        >= 2
                        and sum(shifts) >= 5.0
                    ):
                        state.commit(
                            list(
                                range(
                                    run_start + 1,
                                    end - 1,
                                )
                            ),
                            proposed[1:-1],
                            method=(
                                "acoustic_shortened_repeat_tail"
                            ),
                        )
        run_start = max(run_end, run_start + 1)


def _repair_repeated_intro_pair(state: _State) -> None:
    """Infer a missing opening pair attack from two later exact pairs."""

    if (
        len(state.repaired) < 8
        or not state.signatures[0]
        or state.signatures[0] != state.signatures[1]
        or len(state.values[0]) < 2
        or not state.stable(
            state.repaired[0],
            confidence=0.4,
        )
        or not (
            state.repaired[1].interpolated
            or state.repaired[1].confidence < 0.3
        )
        or state.repaired[2].start
        - state.repaired[0].start
        < 8.0
    ):
        return
    pair_starts = [
        index
        for index in range(len(state.signatures) - 1)
        if (
            state.signatures[index] == state.signatures[0]
            and state.signatures[index + 1]
            == state.signatures[0]
            and (
                index == 0
                or state.signatures[index - 1]
                != state.signatures[0]
            )
            and (
                index + 2 == len(state.signatures)
                or state.signatures[index + 2]
                != state.signatures[0]
            )
        )
    ]
    option_groups: list[
        list[tuple[float, float, float, float]]
    ] = []
    for start in pair_starts[1:]:
        first_options = [
            candidate
            for candidate in state.soft
            if abs(
                candidate[0] - state.repaired[start].start
            )
            <= 1.5
        ]
        second_options = [
            candidate
            for candidate in state.soft
            if abs(
                candidate[0] - state.repaired[start + 1].start
            )
            <= 1.5
        ]
        options = [
            (
                second[0] - first[0],
                first[1] + second[1],
                first[0],
                second[0],
            )
            for first in first_options
            for second in second_options
            if 2.5 <= second[0] - first[0] <= 5.0
        ]
        if options:
            option_groups.append(options)
    best: tuple[
        tuple[int, float, float],
        list[tuple[float, float, float, float]],
    ] | None = None
    for center in [
        option[0]
        for group in option_groups
        for option in group
    ]:
        selected = []
        for group in option_groups:
            compatible = [
                option
                for option in group
                if abs(option[0] - center) <= 0.25
            ]
            if compatible:
                selected.append(
                    max(
                        compatible,
                        key=lambda option: option[1],
                    )
                )
        if len(selected) < 2:
            continue
        periods = [option[0] for option in selected]
        spread = max(periods) - min(periods)
        rank = (
            len(selected),
            -spread,
            sum(option[1] for option in selected),
        )
        if best is None or rank > best[0]:
            best = (rank, selected)
    if best is None:
        return
    period = float(median(option[0] for option in best[1]))
    expected = state.repaired[0].start + period
    options = [
        (
            score - 8.0 * abs(start - expected),
            start,
        )
        for start, score in state.soft
        if (
            2.5 <= start - state.repaired[0].start <= 5.0
            and abs(start - expected) <= 0.5
            and score >= 5.5
        )
    ]
    if options:
        _, start = max(options)
        if state.repaired[1].start - start >= 1.5:
            state.commit(
                [1],
                [start],
                method="acoustic_repeated_intro_pair",
                confidence=0.48,
                uncertainty=0.25,
            )


def _repair_suffix_echoes(state: _State) -> None:
    """Move a standalone suffix echo past its internal prior occurrence."""

    for index in range(1, len(state.repaired) - 1):
        target_values = state.values[index]
        previous_values = state.values[index - 1]
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        if (
            index in state.claimed
            or not 2 <= len(target_values) <= 5
            or len(previous_values) <= len(target_values)
            or previous_values[-len(target_values) :]
            != target_values
            or target.method != "acoustic_onset"
            or target.matched_units != 0
            or target.confidence > 0.45
            or not state.stable(previous, confidence=0.65)
            or not state.stable(following, confidence=0.6)
            or not 6.0
            <= following.start - target.start
            <= 12.0
        ):
            continue
        options = [
            (
                score
                - 8.0
                * abs(
                    (start - target.start)
                    - (following.start - start)
                ),
                start,
            )
            for start, score in state.hard
            if (
                target.start + 2.5
                <= start
                <= following.start - 1.5
                and score >= 9.0
                and abs(
                    (start - target.start)
                    - (following.start - start)
                )
                <= 1.5
            )
        ]
        if options:
            _, start = max(options)
            state.commit(
                [index],
                [start],
                method="acoustic_suffix_echo",
            )


def _repair_nested_suffix_repeats(state: _State) -> None:
    """Use two A/B/C sections when C is B without a short prefix."""

    groups: dict[tuple[str, str, str], list[int]] = {}
    for index in range(len(state.repaired) - 2):
        middle = state.values[index + 1]
        suffix = state.values[index + 2]
        if (
            state.signatures[index]
            and 1 <= len(middle) - len(suffix) <= 3
            and len(suffix) >= 4
            and middle[-len(suffix) :] == suffix
        ):
            groups.setdefault(
                tuple(state.signatures[index : index + 3]),
                [],
            ).append(index)
    for occurrence_starts in groups.values():
        if len(occurrence_starts) < 2:
            continue
        eligible: list[
            tuple[int, list[tuple[float, float]]]
        ] = []
        for start in occurrence_starts:
            first = state.repaired[start]
            target = state.repaired[start + 1]
            final = state.repaired[start + 2]
            first_stable = (
                state.stable(first, confidence=0.55)
                or (
                    first.method == "acoustic_onset"
                    and first.confidence >= 0.4
                    and not first.interpolated
                    and first.start_uncertainty <= 1.0
                )
            )
            if (
                start + 1 in state.claimed
                or not first_stable
                or not state.stable(final, confidence=0.6)
                or not (
                    target.leading_unmatched_units > 0
                    or target.confidence < 0.6
                    or target.start_uncertainty > 0.75
                )
            ):
                continue
            options = sorted(
                [
                    candidate
                    for candidate in state.hard
                    if (
                        first.start + 2.5
                        <= candidate[0]
                        <= first.start + 5.5
                        and candidate[0] <= final.start - 0.8
                        and target.start - candidate[0] >= 1.0
                        and candidate[1] >= 9.0
                    )
                ],
                key=lambda candidate: candidate[1],
                reverse=True,
            )[:8]
            if options:
                eligible.append((start, options))
        if len(eligible) < 2:
            continue
        best: tuple[
            float,
            tuple[tuple[float, float], ...],
        ] | None = None
        for option in product(*(item[1] for item in eligible)):
            leading_offsets = [
                candidate[0] - state.repaired[start].start
                for (start, _), candidate in zip(
                    eligible,
                    option,
                    strict=True,
                )
            ]
            trailing_offsets = [
                state.repaired[start + 2].start - candidate[0]
                for (start, _), candidate in zip(
                    eligible,
                    option,
                    strict=True,
                )
            ]
            leading_spread = (
                max(leading_offsets) - min(leading_offsets)
            )
            trailing_spread = (
                max(trailing_offsets) - min(trailing_offsets)
            )
            if (
                leading_spread > 0.75
                or trailing_spread > 0.75
            ):
                continue
            rank = (
                sum(candidate[1] for candidate in option)
                - 8.0 * leading_spread
                - 4.0 * trailing_spread
            )
            if best is None or rank > best[0]:
                best = (rank, option)
        if best is None:
            continue
        proposals = [
            (start + 1, candidate[0])
            for (start, _), candidate in zip(
                eligible,
                best[1],
                strict=True,
            )
        ]
        if not all(
            state.repaired[index - 1].start + 0.28
            <= start
            <= state.repaired[index + 1].start - 0.28
            for index, start in proposals
        ):
            continue
        for index, start in proposals:
            state.commit(
                [index],
                [start],
                method="acoustic_nested_suffix_repeat",
            )


def _weak_anchor(anchor: CoarseLineAnchor) -> bool:
    return (
        anchor.interpolated
        or anchor.confidence < 0.3
        or anchor.method in {"overlap_repair", "interpolated_rebased"}
        or (
            anchor.method == "acoustic_onset"
            and anchor.matched_units == 0
            and anchor.confidence <= 0.45
        )
    )


def _weighted_starts(
    left: float,
    right: float,
    weights: list[int],
) -> list[float]:
    """Return starts after ``left`` with lyric-unit weighted durations."""

    total = sum(max(1, weight) for weight in weights)
    cumulative = 0
    starts: list[float] = []
    for weight in weights[:-1]:
        cumulative += max(1, weight)
        starts.append(left + (right - left) * cumulative / total)
    return starts


def _line_weight(state: _State, index: int) -> int:
    """Measure the main lyric without parenthetical backing-vocal echoes."""

    return max(1, len(state.values[index]))


def _nearest_candidate(
    candidates: list[tuple[float, float]],
    expected: float,
    *,
    tolerance: float,
    minimum_score: float,
) -> tuple[float, float] | None:
    options = [
        (
            score - 10.0 * abs(start - expected),
            start,
            score,
        )
        for start, score in candidates
        if score >= minimum_score and abs(start - expected) <= tolerance
    ]
    if not options:
        return None
    _, start, score = max(options)
    return start, score


def _supported(
    candidates: list[tuple[float, float]],
    start: float,
    *,
    tolerance: float = 0.35,
    minimum_score: float = 9.0,
) -> bool:
    return any(
        score >= minimum_score
        and abs(candidate_start - start) <= tolerance
        for candidate_start, score in candidates
    )


def _best_score_near(
    candidates: list[tuple[float, float]],
    start: float,
    *,
    tolerance: float,
) -> float:
    return max(
        (
            score
            for candidate_start, score in candidates
            if abs(candidate_start - start) <= tolerance
        ),
        default=-math.inf,
    )


def _repeated_blocks(
    state: _State,
    *,
    minimum: int = 3,
) -> list[tuple[int, int, int]]:
    """Return maximal exact primary-lyric blocks."""

    blocks: list[tuple[int, int, int]] = []
    for left in range(len(state.signatures)):
        for right in range(left + minimum, len(state.signatures)):
            if (
                not state.signatures[left]
                or state.signatures[left]
                != state.signatures[right]
                or (
                    left
                    and right
                    and state.signatures[left - 1]
                    == state.signatures[right - 1]
                )
            ):
                continue
            length = 0
            while (
                right + length < len(state.signatures)
                and state.signatures[left + length]
                == state.signatures[right + length]
            ):
                length += 1
            if length >= minimum:
                blocks.append((left, right, length))
    return sorted(
        blocks,
        key=lambda item: (-item[2], item[0], item[1]),
    )


def _rhythm_dispersion(gaps: list[float]) -> float:
    if not gaps or min(gaps) <= 0.0:
        return math.inf
    center = float(median(gaps))
    return sum(abs(gap - center) for gap in gaps)


def _repair_shifted_response_pairs(state: _State) -> None:
    """Recover a two-line response whose second onset was assigned first."""

    for index in range(len(state.repaired) - 2):
        first = state.repaired[index]
        second = state.repaired[index + 1]
        following = state.repaired[index + 2]
        if (
            index in state.claimed
            or index + 1 in state.claimed
            or first.method != "acoustic_onset"
            or first.matched_units != 0
            or first.confidence > 0.45
            or not second.method.startswith("lexical")
            or second.confidence < 0.8
            or second.start_uncertainty < 0.75
            or not state.stable(following, confidence=0.6)
            or not state.hard_supported(
                following.start,
                tolerance=0.4,
                minimum_score=12.0,
            )
        ):
            continue
        first_options = [
            candidate
            for candidate in state.hard
            if (
                candidate[1] >= 12.0
                and abs(candidate[0] - second.start) <= 0.35
            )
        ]
        best: tuple[float, float, float] | None = None
        for first_candidate in first_options:
            first_start, first_score = first_candidate
            for second_start, second_score in state.hard:
                first_interval = second_start - first_start
                second_interval = following.start - second_start
                if (
                    second_score < 12.0
                    or not 2.5 <= first_interval <= 6.0
                    or not 1.5 <= second_interval <= 6.0
                    or abs(first_interval - second_interval) > 0.6
                    or second_start - second.start < 2.0
                    or first_start - first.start < 2.0
                ):
                    continue
                rank = (
                    first_score
                    + second_score
                    - 10.0 * abs(first_interval - second_interval)
                )
                if best is None or rank > best[0]:
                    best = (rank, first_start, second_start)
        if best is not None:
            state.commit(
                [index, index + 1],
                [best[1], best[2]],
                method="acoustic_shifted_response_pair",
            )


def _repair_early_gap_entries(state: _State) -> None:
    """Use the first strong attack after a complete preceding lexical row."""

    for index in range(1, len(state.repaired) - 1):
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        if (
            index in state.claimed
            or not previous.method.startswith("lexical")
            or previous.confidence < 0.9
            or previous.matched_units < previous.total_units
            or previous.start_uncertainty > 0.5
            or target.method != "acoustic_onset"
            or target.matched_units != 0
            or target.confidence > 0.45
            or not 3 <= target.total_units <= 10
            or not state.stable(following, confidence=0.6)
            or following.start - target.start < 8.0
        ):
            continue
        options = [
            (score, start)
            for start, score in state.hard
            if (
                score >= 15.0
                and previous.end + 0.28 <= start <= previous.end + 1.5
                and target.start - start >= 3.0
                and following.start - start >= 10.0
            )
        ]
        if options:
            _, start = max(options)
            state.commit(
                [index],
                [start],
                method="acoustic_early_gap_entry",
            )


def _repair_weighted_unmatched_spans(state: _State) -> None:
    """Reweight a long weak span between reliable lexical boundaries."""

    for start in range(1, len(state.repaired) - 3):
        first = state.repaired[start]
        if (
            start in state.claimed
            or first.method != "acoustic_onset"
            or first.matched_units != 0
            or first.confidence < 0.4
            or first.total_units < 10
            or not state.stable(
                state.repaired[start - 1],
                confidence=0.6,
            )
        ):
            continue
        for end in range(start + 3, min(len(state.repaired), start + 6)):
            final = state.repaired[end]
            interior = state.repaired[start + 1 : end]
            if (
                any(index in state.claimed for index in range(start, end))
                or not state.stable(
                    final,
                    confidence=0.65,
                    uncertainty=0.8,
                )
                or not all(
                    anchor.interpolated
                    or anchor.confidence < 0.6
                    or anchor.matched_units
                    < 0.5 * max(1, anchor.total_units)
                    or anchor.method
                    in {"acoustic_onset", "acoustic_leading_prefix"}
                    for anchor in interior
                )
                or not 8.0 <= final.start - first.start <= 30.0
            ):
                continue
            weights = [
                _line_weight(state, index)
                for index in range(start, end)
            ]
            expected = _weighted_starts(first.start, final.start, weights)
            proposed = [first.start]
            valid = True
            for target in expected:
                candidate = _nearest_candidate(
                    state.hard,
                    target,
                    tolerance=0.9,
                    minimum_score=9.0,
                )
                if candidate is None:
                    valid = False
                    break
                proposed.append(candidate[0])
            if not valid or len(proposed) != end - start:
                continue
            current = [
                state.repaired[index].start
                for index in range(start, end)
            ]
            current_residual = sum(
                abs(value - target)
                for value, target in zip(current[1:], expected, strict=True)
            )
            proposed_residual = sum(
                abs(value - target)
                for value, target in zip(proposed[1:], expected, strict=True)
            )
            shifts = [
                abs(new - old)
                for new, old in zip(proposed, current, strict=True)
            ]
            if (
                current_residual - proposed_residual >= 4.0
                and sum(shift >= 1.5 for shift in shifts) >= 2
                and sum(shifts) >= 5.0
            ):
                state.commit(
                    list(range(start + 1, end)),
                    proposed[1:],
                    method="acoustic_weighted_unmatched_span",
                )
                break


def _repair_short_leading_pickup(state: _State) -> None:
    """Recover a short opening pickup omitted by the original coarse map."""

    if len(state.repaired) < 2 or len(state.original) != len(state.repaired):
        return
    original = state.original[0]
    target = state.repaired[0]
    following = state.repaired[1]
    if (
        0 in state.claimed
        or not 1 <= len(state.values[0]) <= 3
        or not original.interpolated
        or original.confidence != 0
        or target.method != "acoustic_leading_activity"
        or target.start_uncertainty < 3.0
        or following.start - target.start < 2.5
        or not (
            state.stable(following, confidence=0.6)
            or (
                following.method == "acoustic_onset"
                and following.confidence >= 0.4
                and not following.interpolated
            )
        )
    ):
        return
    options = [
        (score, start)
        for start, score in state.soft
        if (
            score >= 15.0
            and 0.28 <= following.start - start <= 1.2
        )
    ]
    if options:
        _, start = max(options)
        state.commit(
            [0],
            [start],
            method="acoustic_short_leading_pickup",
        )


def _repair_shifted_trailing_pairs(state: _State) -> None:
    """Shift a final weak pair back by one independently supported attack."""

    if len(state.repaired) < 3:
        return
    first_index = len(state.repaired) - 2
    previous = state.repaired[first_index - 1]
    first = state.repaired[first_index]
    second = state.repaired[first_index + 1]
    if (
        first_index in state.claimed
        or first_index + 1 in state.claimed
        or first.method != "acoustic_trailing_activity"
        or second.method != "acoustic_trailing_activity"
        or first.matched_units != 0
        or second.matched_units != 0
        or not previous.method.startswith("lexical")
        or previous.confidence < 0.7
        or first.start - previous.start < 5.0
        or second.start - first.start > 2.2
        or not state.hard_supported(
            first.start,
            tolerance=0.2,
            minimum_score=9.0,
        )
    ):
        return
    options = []
    for start, score in state.hard:
        left = start - previous.start
        right = first.start - start
        if (
            score >= 7.0
            and 2.0 <= left <= 5.0
            and 2.0 <= right <= 5.0
            and abs(left - right) <= 1.0
        ):
            options.append(
                (score - 8.0 * abs(left - right), start)
            )
    if options:
        _, start = max(options)
        state.commit(
            [first_index, first_index + 1],
            [start, first.start],
            method="acoustic_shifted_trailing_pair",
        )


def _repair_uniform_weak_spans(state: _State) -> None:
    """Select a uniform soft-onset path across a bounded weak run."""

    index = 1
    while index < len(state.repaired) - 1:
        if not _weak_anchor(state.repaired[index]):
            index += 1
            continue
        start = index
        while (
            index < len(state.repaired) - 1
            and _weak_anchor(state.repaired[index])
        ):
            index += 1
        end = index
        count = end - start
        previous = state.repaired[start - 1]
        following = state.repaired[end]
        if (
            not 2 <= count <= 8
            or any(item in state.claimed for item in range(start, end))
            or not state.stable(
                previous,
                confidence=0.5,
                uncertainty=1.2,
            )
            or not state.stable(
                following,
                confidence=0.6,
                uncertainty=1.2,
            )
        ):
            continue
        expected = [
            previous.start
            + (following.start - previous.start)
            * position
            / (count + 1)
            for position in range(1, count + 1)
        ]
        proposed = []
        for target in expected:
            candidate = _nearest_candidate(
                state.soft,
                target,
                tolerance=0.8,
                minimum_score=9.0,
            )
            if candidate is None:
                proposed = []
                break
            proposed.append(candidate[0])
        if not proposed:
            continue
        current = [
            state.repaired[item].start for item in range(start, end)
        ]
        current_residual = sum(
            abs(value - target)
            for value, target in zip(current, expected, strict=True)
        )
        proposed_residual = sum(
            abs(value - target)
            for value, target in zip(proposed, expected, strict=True)
        )
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            current_residual - proposed_residual >= 4.0
            and sum(shift >= 1.5 for shift in shifts) >= 2
            and sum(shifts) >= 4.0
        ):
            state.commit(
                list(range(start, end)),
                proposed,
                method="acoustic_uniform_weak_span",
            )


def _repair_fragment_following_spans(state: _State) -> None:
    """Rebase a weak verse after a three-row fragment sequence."""

    index = 3
    while index < len(state.repaired) - 1:
        if not _weak_anchor(state.repaired[index]):
            index += 1
            continue
        start = index
        while (
            index < len(state.repaired) - 1
            and _weak_anchor(state.repaired[index])
        ):
            index += 1
        end = index
        count = end - start
        if (
            not 4 <= count <= 8
            or any(item in state.claimed for item in range(start, end))
            or not all(
                state.repaired[item].method
                == "acoustic_fragment_sequence"
                for item in range(start - 3, start)
            )
            or not state.stable(
                state.repaired[end],
                confidence=0.65,
            )
        ):
            continue
        previous = state.repaired[start - 1]
        following = state.repaired[end]
        first_options = [
            (start_time, score)
            for start_time, score in state.soft
            if (
                score >= 6.0
                and previous.start + 0.28
                <= start_time
                <= previous.start + 1.5
            )
        ]
        if not first_options:
            continue
        first_start, _ = min(first_options, key=lambda item: item[0])
        step = (following.start - first_start) / count
        if step < 0.8:
            continue
        expected = [
            first_start + step * position for position in range(count)
        ]
        proposed = [first_start]
        for target in expected[1:]:
            candidate = _nearest_candidate(
                state.soft,
                target,
                tolerance=1.0,
                minimum_score=6.0,
            )
            if candidate is None:
                proposed = []
                break
            proposed.append(candidate[0])
        if not proposed:
            continue
        current = [
            state.repaired[item].start for item in range(start, end)
        ]
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            sum(shift >= 1.5 for shift in shifts) >= 4
            and sum(shifts) >= 10.0
        ):
            state.commit(
                list(range(start, end)),
                proposed,
                method="acoustic_fragment_following_span",
            )


def _repair_weighted_interpolated_entrances(state: _State) -> None:
    """Weight a weak entrance and its interpolated verse by lyric length."""

    for start in range(1, len(state.repaired) - 4):
        first = state.repaired[start]
        previous = state.repaired[start - 1]
        if (
            start in state.claimed
            or first.method != "acoustic_onset"
            or first.matched_units != 0
            or first.confidence > 0.45
            or not state.stable(
                previous,
                confidence=0.4,
                uncertainty=1.2,
            )
        ):
            continue
        end = start + 1
        while (
            end < len(state.repaired)
            and state.repaired[end].interpolated
        ):
            end += 1
        count = end - start
        if (
            not 4 <= count <= 8
            or end >= len(state.repaired)
            or any(item in state.claimed for item in range(start, end))
            or not state.stable(
                state.repaired[end],
                confidence=0.6,
                uncertainty=1.2,
            )
        ):
            continue
        following = state.repaired[end]
        weights = [
            _line_weight(state, item)
            for item in range(start - 1, end)
        ]
        expected = _weighted_starts(
            previous.start,
            following.start,
            weights,
        )
        proposed = []
        for target in expected:
            lower = (
                proposed[-1] + 0.28
                if proposed
                else previous.start + 0.28
            )
            candidate = _nearest_candidate(
                [
                    item
                    for item in state.soft
                    if lower <= item[0] <= following.start - 0.28
                ],
                target,
                tolerance=1.3,
                minimum_score=9.0,
            )
            if candidate is None:
                proposed = []
                break
            proposed.append(candidate[0])
        if len(proposed) != count:
            continue
        current = [
            state.repaired[item].start for item in range(start, end)
        ]
        current_residual = sum(
            abs(value - target)
            for value, target in zip(current, expected, strict=True)
        )
        proposed_residual = sum(
            abs(value - target)
            for value, target in zip(proposed, expected, strict=True)
        )
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            current_residual - proposed_residual >= 5.0
            and sum(shift >= 1.5 for shift in shifts) >= 3
            and sum(shifts) >= 8.0
        ):
            state.commit(
                list(range(start, end)),
                proposed,
                method="acoustic_weighted_interpolated_entrance",
            )


def _repair_weighted_weak_pairs(state: _State) -> None:
    """Use lyric-length priors for exactly two weak bounded rows."""

    for start in range(1, len(state.repaired) - 2):
        end = start + 2
        if (
            not _weak_anchor(state.repaired[start])
            or not _weak_anchor(state.repaired[start + 1])
            or _weak_anchor(state.repaired[start - 1])
            or _weak_anchor(state.repaired[end])
            or any(item in state.claimed for item in range(start, end))
        ):
            continue
        previous = state.repaired[start - 1]
        following = state.repaired[end]
        if (
            not state.stable(
                previous,
                confidence=0.6,
                uncertainty=1.2,
            )
            or not state.stable(
                following,
                confidence=0.45,
                uncertainty=1.2,
            )
            or following.total_units < 4
        ):
            continue
        weights = [
            _line_weight(state, item)
            for item in range(start - 1, end)
        ]
        expected = _weighted_starts(
            previous.start,
            following.start,
            weights,
        )
        proposed = []
        for target in expected:
            lower = (
                proposed[-1] + 0.28
                if proposed
                else previous.start + 0.28
            )
            candidate = _nearest_candidate(
                [
                    item
                    for item in state.soft
                    if lower <= item[0] <= following.start - 0.28
                ],
                target,
                tolerance=1.1,
                minimum_score=9.0,
            )
            if candidate is None:
                proposed = []
                break
            proposed.append(candidate[0])
        if len(proposed) != 2:
            continue
        current = [
            state.repaired[item].start for item in range(start, end)
        ]
        current_residual = sum(
            abs(value - target)
            for value, target in zip(current, expected, strict=True)
        )
        proposed_residual = sum(
            abs(value - target)
            for value, target in zip(proposed, expected, strict=True)
        )
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            current_residual - proposed_residual >= 2.5
            and all(shift >= 1.0 for shift in shifts)
            and sum(shifts) >= 3.0
        ):
            state.commit(
                [start, start + 1],
                proposed,
                method="acoustic_weighted_weak_pair",
            )


def _repair_collapsed_prefix_variants(state: _State) -> None:
    """Recover a short prefix line collapsed onto its longer sibling."""

    for index in range(1, len(state.repaired) - 1):
        target_values = state.values[index]
        previous_values = state.values[index - 1]
        following_values = state.values[index + 1]
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        if (
            index in state.claimed
            or not 1 <= len(target_values) <= 3
            or previous_values[: len(target_values)] != target_values
            or following_values[: len(target_values)] != target_values
            or target.interpolated
            or not target.method.startswith("lexical")
            or target.confidence < 0.5
            or abs(target.start - following.start) > 0.3
            or not 5.0 <= following.start - previous.start <= 12.0
        ):
            continue
        options = []
        for start, score in state.hard:
            left = start - previous.start
            right = following.start - start
            if (
                score >= 12.0
                and 2.0 <= left <= 6.0
                and 2.0 <= right <= 6.0
                and target.start - start >= 2.0
                and abs(left - right) <= 1.0
            ):
                options.append(
                    (score - 8.0 * abs(left - right), start)
                )
        if options:
            _, start = max(options)
            state.commit(
                [index],
                [start],
                method="acoustic_collapsed_prefix_variant",
            )


def _repair_weighted_gap_clusters(state: _State) -> None:
    """Reweight a long acoustic gap cluster by lyric-unit duration."""

    index = 0
    while index < len(state.repaired):
        if state.repaired[index].method != "acoustic_gap_cluster":
            index += 1
            continue
        start = index
        while (
            index < len(state.repaired)
            and state.repaired[index].method == "acoustic_gap_cluster"
        ):
            index += 1
        end = index
        count = end - start
        if (
            not 4 <= count <= 10
            or start == 0
            or end >= len(state.repaired)
            or any(item in state.claimed for item in range(start + 1, end))
        ):
            continue
        first = state.repaired[start]
        following = state.repaired[end]
        weights = [
            _line_weight(state, item)
            for item in range(start, end)
        ]
        expected = _weighted_starts(first.start, following.start, weights)
        proposed = []
        for target in expected:
            candidate = _nearest_candidate(
                state.soft,
                target,
                tolerance=0.8,
                minimum_score=9.0,
            )
            if candidate is None:
                proposed = []
                break
            proposed.append(candidate[0])
        if len(proposed) != count - 1:
            continue
        current = [
            state.repaired[item].start
            for item in range(start + 1, end)
        ]
        current_residual = sum(
            abs(value - target)
            for value, target in zip(current, expected, strict=True)
        )
        proposed_residual = sum(
            abs(value - target)
            for value, target in zip(proposed, expected, strict=True)
        )
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            current_residual - proposed_residual >= 5.0
            and sum(shift >= 1.5 for shift in shifts) >= 3
            and sum(shifts) >= 8.0
        ):
            state.commit(
                list(range(start + 1, end)),
                proposed,
                method="acoustic_weighted_gap_cluster",
            )


def _repair_weighted_gap_cluster_tails(state: _State) -> None:
    """Repair the final row of a short gap cluster between hard boundaries."""

    for index in range(1, len(state.repaired) - 1):
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        if (
            index in state.claimed
            or previous.method != "acoustic_gap_cluster"
            or target.method != "acoustic_gap_cluster"
            or following.interpolated
            or following.confidence < 0.4
            or following.start - previous.start < 5.0
            or not state.hard_supported(
                previous.start,
                tolerance=0.25,
                minimum_score=9.0,
            )
            or not state.hard_supported(
                following.start,
                tolerance=0.35,
                minimum_score=9.0,
            )
        ):
            continue
        previous_weight = _line_weight(state, index - 1)
        target_weight = _line_weight(state, index)
        expected = previous.start + (
            (following.start - previous.start)
            * previous_weight
            / (previous_weight + target_weight)
        )
        candidate = _nearest_candidate(
            state.hard,
            expected,
            tolerance=0.9,
            minimum_score=9.0,
        )
        if (
            candidate is not None
            and abs(target.start - expected)
            - abs(candidate[0] - expected)
            >= 2.0
            and abs(candidate[0] - target.start) >= 2.5
        ):
            state.commit(
                [index],
                [candidate[0]],
                method="acoustic_weighted_gap_cluster_tail",
            )


def _repair_repeated_fragment_tails(state: _State) -> None:
    """Disambiguate the same short tail after three repeated lead-ins."""

    groups: dict[tuple[str, str], list[int]] = {}
    for index in range(1, len(state.repaired) - 1):
        if state.signatures[index]:
            groups.setdefault(
                (
                    state.signatures[index - 1],
                    state.signatures[index],
                ),
                [],
            ).append(index)

    for indices in groups.values():
        if (
            len(indices) < 3
            or len(state.values[indices[0]]) > 2
            or any(index in state.claimed for index in indices)
            or not all(
                state.repaired[index].method
                == "acoustic_fragment_sequence"
                for index in indices
            )
        ):
            continue
        proposals: list[tuple[int, float]] = []
        for index in indices:
            previous = state.repaired[index - 1]
            target = state.repaired[index]
            following = state.repaired[index + 1]
            previous_weight = _line_weight(state, index - 1)
            target_weight = _line_weight(state, index)
            expected = previous.start + (
                (following.start - previous.start)
                * previous_weight
                / (previous_weight + target_weight)
            )
            options = [
                (
                    score - 8.0 * abs(start - expected),
                    start,
                )
                for start, score in state.soft
                if (
                    score >= 7.0
                    and abs(start - expected) <= 1.1
                    and previous.start + 0.28
                    <= start
                    <= following.start - 0.28
                )
            ]
            if not options:
                proposals = []
                break
            _, proposed = max(options)
            if (
                abs(target.start - expected)
                - abs(proposed - expected)
                < 1.1
                or abs(proposed - target.start) < 2.0
            ):
                proposals = []
                break
            proposals.append((index, proposed))
        if len(proposals) != len(indices):
            continue
        for index, proposed in proposals:
            state.commit(
                [index],
                [proposed],
                method="acoustic_repeated_fragment_tail",
            )


def _repair_paired_repeated_entries(state: _State) -> None:
    """Repair the same collapsed or partial entrance in two exact blocks."""

    proposed_rows: dict[int, tuple[float, float, str]] = {}
    for left, right, length in _repeated_blocks(state):
        offsets = [
            state.repaired[right + position].start
            - state.repaired[left + position].start
            for position in range(length)
        ]
        center = float(median(offsets))
        inliers = [
            value for value in offsets if abs(value - center) <= 0.75
        ]
        if len(inliers) < 2:
            continue
        offset = float(median(inliers))
        for position in range(length):
            first_index = left + position
            second_index = right + position
            if (
                first_index == 0
                or second_index == 0
                or first_index + 1 >= len(state.repaired)
                or second_index + 1 >= len(state.repaired)
                or first_index in state.claimed
                or second_index in state.claimed
            ):
                continue
            first = state.repaired[first_index]
            second = state.repaired[second_index]
            mode = ""
            minimum_score = 0.0
            if (
                first.method == "overlap_repair"
                and second.method == "overlap_repair"
                and first.matched_units == 0
                and second.matched_units == 0
                and state.repaired[first_index + 1].start
                - first.start
                <= 0.3
                and state.repaired[second_index + 1].start
                - second.start
                <= 0.3
            ):
                mode = "acoustic_repeated_overlap_entry"
                minimum_score = 7.0
            elif (
                first.method == "lexical"
                and second.method == "lexical"
                and first.leading_unmatched_units >= 2
                and second.leading_unmatched_units >= 2
                and first.matched_units >= 4
                and second.matched_units >= 4
                and first.matched_units < first.total_units
                and second.matched_units < second.total_units
                and first.confidence >= 0.6
                and second.confidence >= 0.6
                and first.start_uncertainty >= 1.0
                and second.start_uncertainty >= 1.0
            ):
                mode = "acoustic_repeated_leading_prefix"
                minimum_score = 9.0
            if not mode:
                continue

            first_options = [
                (start, score)
                for start, score in state.soft
                if (
                    score >= minimum_score
                    and state.repaired[first_index - 1].start + 0.28
                    <= start
                    <= state.repaired[first_index + 1].start - 0.28
                    and -4.5 <= start - first.start <= -1.8
                )
            ]
            second_options = [
                (start, score)
                for start, score in state.soft
                if (
                    score >= minimum_score
                    and state.repaired[second_index - 1].start + 0.28
                    <= start
                    <= state.repaired[second_index + 1].start - 0.28
                    and -4.5 <= start - second.start <= -1.8
                )
            ]
            options = [
                (
                    min(first_score, second_score),
                    -abs(
                        (first_start - first.start)
                        - (second_start - second.start)
                    ),
                    first_start,
                    second_start,
                )
                for first_start, first_score in first_options
                for second_start, second_score in second_options
                if (
                    abs(
                        (first_start - first.start)
                        - (second_start - second.start)
                    )
                    <= 0.5
                    and abs(
                        (second_start - first_start) - offset
                    )
                    <= 0.5
                )
            ]
            if not options:
                continue
            evidence, _, first_start, second_start = max(options)
            for index, start in (
                (first_index, first_start),
                (second_index, second_start),
            ):
                old = proposed_rows.get(index)
                if old is None or evidence > old[0]:
                    proposed_rows[index] = (evidence, start, mode)

    for index in sorted(proposed_rows):
        _, proposed, method = proposed_rows[index]
        state.commit([index], [proposed], method=method)


def _repair_short_identical_bridges(state: _State) -> None:
    """Repair a two-row identical bridge from its acoustic boundaries."""

    run_start = 0
    while run_start < len(state.signatures):
        run_end = run_start + 1
        while (
            run_end < len(state.signatures)
            and state.signatures[run_start]
            and state.signatures[run_end]
            == state.signatures[run_start]
        ):
            run_end += 1
        if (
            run_end - run_start != 2
            or run_start == 0
            or run_end >= len(state.repaired)
            or len(state.values[run_start]) < 2
        ):
            run_start = run_end
            continue

        # If one copy and the following boundary are independently audible,
        # their midpoint identifies a displaced second copy (and vice versa).
        for target_index, left_index, right_index in (
            (run_start + 1, run_start, run_end),
            (run_start, run_start - 1, run_start + 1),
        ):
            if (
                target_index in state.claimed
                or not state.hard_supported(
                    state.repaired[left_index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
                or not state.hard_supported(
                    state.repaired[right_index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
                or state.hard_supported(
                    state.repaired[target_index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            ):
                continue
            expected = (
                state.repaired[left_index].start
                + state.repaired[right_index].start
            ) / 2.0
            candidate = _nearest_candidate(
                state.hard,
                expected,
                tolerance=0.6,
                minimum_score=9.0,
            )
            if (
                candidate is not None
                and abs(
                    state.repaired[target_index].start - expected
                )
                - abs(candidate[0] - expected)
                >= 2.0
                and abs(
                    candidate[0]
                    - state.repaired[target_index].start
                )
                >= 2.0
            ):
                state.commit(
                    [target_index],
                    [candidate[0]],
                    method="acoustic_short_identical_bridge",
                )

        # Two unsupported copies can still be recovered when their current
        # path crowds one boundary while trisection produces one coherent,
        # same-direction correction between supported outer rows.
        if any(
            index in state.claimed
            for index in range(run_start, run_end)
        ):
            run_start = run_end
            continue
        previous = state.repaired[run_start - 1]
        following = state.repaired[run_end]
        current = [
            state.repaired[index].start
            for index in range(run_start, run_end)
        ]
        span = following.start - previous.start
        current_gaps = [
            current[0] - previous.start,
            current[1] - current[0],
            following.start - current[1],
        ]
        boundary_supported = (
            _supported(
                state.soft,
                previous.start,
                tolerance=0.45,
                minimum_score=6.0,
            )
            and _supported(
                state.soft,
                following.start,
                tolerance=0.45,
                minimum_score=6.0,
            )
        )
        targets_unsupported = not any(
            _supported(
                state.soft,
                start,
                tolerance=0.45,
                minimum_score=6.0,
            )
            for start in current
        )
        proposed = [
            previous.start + span / 3.0,
            previous.start + 2.0 * span / 3.0,
        ]
        shifts = [
            new - old
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            boundary_supported
            and targets_unsupported
            and state.stable(previous, confidence=0.5, uncertainty=1.2)
            and state.stable(following, confidence=0.5, uncertainty=1.2)
            and 8.0 <= span <= 25.0
            and min(current_gaps) >= 0.28
            and max(current_gaps) - min(current_gaps) >= 4.0
            and all(1.5 <= abs(shift) <= 4.5 for shift in shifts)
            and shifts[0] * shifts[1] > 0.0
            and abs(shifts[0] - shifts[1]) <= 1.0
        ):
            state.commit(
                list(range(run_start, run_end)),
                proposed,
                method="acoustic_uniform_identical_pair",
            )
        run_start = run_end


def _repair_exact_occurrence_ratios(state: _State) -> None:
    """Use three audible copies to repair unsupported local-position outliers."""

    occurrences: dict[str, list[int]] = {}
    for index, signature in enumerate(state.signatures):
        if signature:
            occurrences.setdefault(signature, []).append(index)

    proposals: dict[int, tuple[float, float]] = {}
    for indices in occurrences.values():
        if len(indices) < 4:
            continue
        ratios = []
        for index in indices:
            if (
                index == 0
                or index + 1 >= len(state.repaired)
                or not state.stable(
                    state.repaired[index],
                    confidence=0.4,
                )
                or not state.hard_supported(
                    state.repaired[index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            ):
                continue
            span = (
                state.repaired[index + 1].start
                - state.repaired[index - 1].start
            )
            if span > 0.0:
                ratios.append(
                    (
                        state.repaired[index].start
                        - state.repaired[index - 1].start
                    )
                    / span
                )
        if len(ratios) < 3:
            continue
        center = float(median(ratios))
        inliers = [
            ratio for ratio in ratios if abs(ratio - center) <= 0.08
        ]
        if len(inliers) < 3 or max(inliers) - min(inliers) > 0.1:
            continue
        ratio = float(median(inliers))
        for index in indices:
            if (
                index == 0
                or index + 1 >= len(state.repaired)
                or index in state.claimed
                or not state.stable(
                    state.repaired[index],
                    confidence=0.4,
                )
                or state.hard_supported(
                    state.repaired[index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            ):
                continue
            previous = state.repaired[index - 1]
            target = state.repaired[index]
            following = state.repaired[index + 1]
            expected = previous.start + (
                following.start - previous.start
            ) * ratio
            candidate = _nearest_candidate(
                state.hard,
                expected,
                tolerance=0.9,
                minimum_score=9.0,
            )
            if (
                candidate is None
                or candidate[0] < previous.start + 0.28
                or candidate[0] > following.start - 0.28
                or abs(target.start - expected)
                - abs(candidate[0] - expected)
                < 1.8
                or not 1.8
                <= abs(candidate[0] - target.start)
                <= 4.5
            ):
                continue
            evidence = (
                10.0 * len(inliers)
                - 20.0 * (max(inliers) - min(inliers))
                + candidate[1]
            )
            old = proposals.get(index)
            if old is None or evidence > old[0]:
                proposals[index] = (evidence, candidate[0])

    for index in sorted(proposals):
        _, proposed = proposals[index]
        state.commit(
            [index],
            [proposed],
            method="acoustic_exact_occurrence_ratio",
        )


def _repair_partial_repeat_consensus(state: _State) -> None:
    """Recover a missing repeated prefix from independently aligned copies."""

    occurrences: dict[str, list[int]] = {}
    for index, signature in enumerate(state.signatures):
        if signature:
            occurrences.setdefault(signature, []).append(index)

    for indices in occurrences.values():
        if len(indices) < 3:
            continue
        full_supported = [
            index
            for index in indices
            if (
                state.stable(
                    state.repaired[index],
                    confidence=0.6,
                )
                and state.repaired[index].matched_units
                >= state.repaired[index].total_units
                and state.hard_supported(
                    state.repaired[index].start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            )
        ]
        partial_copies = [
            index
            for index in indices
            if (
                not state.repaired[index].interpolated
                and state.repaired[index].leading_unmatched_units >= 1
                and 0
                < state.repaired[index].matched_units
                < state.repaired[index].total_units
            )
        ]
        for index in indices:
            if (
                index == 0
                or index + 1 >= len(state.repaired)
                or index in state.claimed
            ):
                continue
            target = state.repaired[index]
            coverage = target.matched_units / max(1, target.total_units)

            # A repeat-template row with a substantial matched suffix may
            # inherit the entrance class demonstrated by two complete copies.
            if (
                len(full_supported) >= 2
                and target.method == "repeat_template_consensus"
                and target.leading_unmatched_units >= 3
                and 0.5 <= coverage < 0.8
            ):
                options = [
                    (
                        score
                        - 0.5 * abs(start - target.start),
                        start,
                    )
                    for start, score in state.hard
                    if (
                        score >= 9.0
                        and state.repaired[index - 1].start + 0.28
                        <= start
                        <= state.repaired[index + 1].start - 0.28
                        and -4.5 <= start - target.start <= -1.8
                    )
                ]
                if options:
                    _, proposed = max(options)
                    state.commit(
                        [index],
                        [proposed],
                        method="acoustic_partial_repeat_prefix",
                    )
                    continue

            # One fully matched copy can still start on an internal word. Two
            # partial siblings expose that the shared phrase has a recurring
            # leading prefix; lyric-weighted local timing then chooses the
            # independently audible earlier attack.
            if (
                len(partial_copies) >= 2
                and target.method == "lexical"
                and target.confidence >= 0.9
                and target.matched_units >= target.total_units
                and not state.hard_supported(
                    target.start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            ):
                previous_weight = _line_weight(state, index - 1)
                target_weight = _line_weight(state, index)
                if (
                    min(previous_weight, target_weight) < 5
                    or not 0.7
                    <= previous_weight / target_weight
                    <= 1.4
                ):
                    continue
                previous = state.repaired[index - 1]
                following = state.repaired[index + 1]
                expected = previous.start + (
                    (following.start - previous.start)
                    * previous_weight
                    / (previous_weight + target_weight)
                )
                options = [
                    (
                        score - 10.0 * abs(start - expected),
                        start,
                    )
                    for start, score in state.hard
                    if (
                        score >= 20.0
                        and abs(start - expected) <= 1.1
                        and previous.start + 0.28
                        <= start
                        <= following.start - 0.28
                        and -4.5 <= start - target.start <= -1.8
                    )
                ]
                if not options:
                    continue
                _, proposed = max(options)
                if (
                    abs(target.start - expected)
                    - abs(proposed - expected)
                    >= 0.9
                ):
                    state.commit(
                        [index],
                        [proposed],
                        method="acoustic_partial_repeat_consensus",
                    )


def _repair_repeated_section_entries(state: _State) -> None:
    """Recover a repeated full-coverage line at a new section entrance."""

    occurrences: dict[str, list[int]] = {}
    for index, signature in enumerate(state.signatures):
        if signature:
            occurrences.setdefault(signature, []).append(index)
    for indices in occurrences.values():
        if len(indices) < 3:
            continue
        for index in indices:
            target = state.repaired[index]
            if (
                index == 0
                or index + 1 >= len(state.repaired)
                or index in state.claimed
                or not state.lines[index].blank_before
                or target.method != "lexical"
                or target.confidence < 0.9
                or target.matched_units < target.total_units
                or target.start_uncertainty < 1.0
                or state.hard_supported(
                    target.start,
                    tolerance=0.35,
                    minimum_score=9.0,
                )
            ):
                continue
            options = [
                (
                    score - 0.5 * abs(start - target.start),
                    start,
                )
                for start, score in state.hard
                if (
                    score >= 12.0
                    and state.repaired[index - 1].start + 0.28
                    <= start
                    <= state.repaired[index + 1].start - 0.28
                    and -4.0 <= start - target.start <= -1.8
                )
            ]
            if options:
                _, proposed = max(options)
                state.commit(
                    [index],
                    [proposed],
                    method="acoustic_repeated_section_entry",
                )


def _repeat_offset_without_position(
    state: _State,
    left: int,
    right: int,
    length: int,
    position: int,
) -> float | None:
    offsets = [
        state.repaired[right + other].start
        - state.repaired[left + other].start
        for other in range(length)
        if (
            other != position
            and state.stable(
                state.repaired[left + other],
                confidence=0.5,
                uncertainty=0.9,
            )
            and state.stable(
                state.repaired[right + other],
                confidence=0.5,
                uncertainty=0.9,
            )
        )
    ]
    if len(offsets) < 3:
        return None
    center = float(median(offsets))
    inliers = [
        value for value in offsets if abs(value - center) <= 0.65
    ]
    if len(inliers) < 3 or max(inliers) - min(inliers) > 0.8:
        return None
    return float(median(inliers))


def _repair_repeated_block_outliers(state: _State) -> None:
    """Transfer a repeated-block entrance with an independent audio check."""

    proposals: dict[int, tuple[float, float, str]] = {}
    for left, right, length in _repeated_blocks(
        state,
        minimum=4,
    ):
        for position in range(length):
            offset = _repeat_offset_without_position(
                state,
                left,
                right,
                length,
                position,
            )
            if offset is None:
                continue
            for source_index, target_index, expected in (
                (
                    left + position,
                    right + position,
                    state.repaired[left + position].start + offset,
                ),
                (
                    right + position,
                    left + position,
                    state.repaired[right + position].start - offset,
                ),
            ):
                if (
                    target_index == 0
                    or target_index + 1 >= len(state.repaired)
                    or target_index in state.claimed
                    or not state.stable(
                        state.repaired[source_index],
                        confidence=0.5,
                        uncertainty=0.9,
                    )
                    or not state.hard_supported(
                        state.repaired[source_index].start,
                        tolerance=0.35,
                        minimum_score=9.0,
                    )
                ):
                    continue
                target = state.repaired[target_index]
                original = state.original[target_index]
                method = ""
                if (
                    target.method == "lexical_segment_start"
                    and target.leading_unmatched_units >= 2
                    and target.matched_units
                    <= 0.5 * max(1, target.total_units)
                ):
                    method = "acoustic_repeated_segment_entry"
                elif (
                    target.method == "acoustic_onset"
                    and original.method == "lexical"
                    and original.confidence >= 0.9
                ):
                    method = "acoustic_repeated_block_prior"
                if (
                    not method
                    or not 1.8
                    <= abs(expected - target.start)
                    <= 4.5
                ):
                    continue

                options = [
                    (
                        score - 10.0 * abs(start - expected),
                        start,
                        score,
                    )
                    for start, score in state.hard
                    if (
                        score >= 9.0
                        and abs(start - expected) <= 0.8
                        and state.repaired[target_index - 1].start + 0.28
                        <= start
                        <= state.repaired[target_index + 1].start - 0.28
                        and (
                            method != "acoustic_repeated_block_prior"
                            or abs(start - original.start) <= 1.25
                        )
                    )
                ]
                if not options:
                    continue
                _, proposed, score = max(options)
                if (
                    abs(target.start - expected)
                    - abs(proposed - expected)
                    < 1.5
                    or abs(proposed - target.start) < 1.8
                ):
                    continue
                evidence = (
                    score
                    + 10.0
                    * (
                        abs(target.start - expected)
                        - abs(proposed - expected)
                    )
                )
                old = proposals.get(target_index)
                if old is None or evidence > old[0]:
                    proposals[target_index] = (
                        evidence,
                        proposed,
                        method,
                    )

    for index in sorted(proposals):
        _, proposed, method = proposals[index]
        state.commit([index], [proposed], method=method)


def _repair_long_weighted_entrances(state: _State) -> None:
    """Choose an earlier strong attack for a long, locally balanced line."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        previous_weight = _line_weight(state, index - 1)
        target_weight = _line_weight(state, index)
        if (
            min(previous_weight, target_weight) < 8
            or not 0.75
            <= previous_weight / target_weight
            <= 1.34
            or target.interpolated
            or target.confidence < 0.4
            or not state.hard_supported(
                previous.start,
                tolerance=0.35,
                minimum_score=9.0,
            )
            or not state.hard_supported(
                following.start,
                tolerance=0.35,
                minimum_score=9.0,
            )
        ):
            continue
        current_supported = state.hard_supported(
            target.start,
            tolerance=0.35,
            minimum_score=9.0,
        )
        if (
            current_supported
            and target.method != "acoustic_onset"
        ):
            continue
        expected = previous.start + (
            (following.start - previous.start)
            * previous_weight
            / (previous_weight + target_weight)
        )
        options = [
            (
                score - 10.0 * abs(start - expected),
                start,
            )
            for start, score in state.hard
            if (
                score >= 25.0
                and abs(start - expected) <= 0.8
                and previous.start + 0.28
                <= start
                <= following.start - 0.28
                and -4.5 <= start - target.start <= -1.8
            )
        ]
        if not options:
            continue
        _, proposed = max(options)
        if (
            abs(target.start - expected)
            - abs(proposed - expected)
            >= 1.5
        ):
            state.commit(
                [index],
                [proposed],
                method="acoustic_long_weighted_entrance",
            )

    # A long first lyric has no left boundary. A strong earlier attack is
    # accepted only for an already acoustic start well into the track.
    if (
        state.repaired
        and 0 not in state.claimed
        and len(state.values[0]) >= 10
        and state.repaired[0].method == "acoustic_onset"
        and state.repaired[0].start >= 5.0
    ):
        target = state.repaired[0]
        following_limit = (
            state.repaired[1].start - 0.28
            if len(state.repaired) > 1
            else math.inf
        )
        options = [
            (score, start)
            for start, score in state.hard
            if (
                score >= 20.0
                and -3.5 <= start - target.start <= -1.8
                and start <= following_limit
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [0],
                [proposed],
                method="acoustic_long_opening_entrance",
            )


def _repair_lexical_prior_onsets(state: _State) -> None:
    """Recover an acoustic choice contradicted by its full lexical prior."""

    if len(state.original) != len(state.repaired):
        return
    for index, (target, original) in enumerate(
        zip(state.repaired, state.original, strict=True)
    ):
        if (
            index in state.claimed
            or target.method != "acoustic_onset"
            or original.method != "lexical"
            or original.confidence < 0.9
            or original.matched_units < original.total_units
            or original.start_uncertainty < 0.45
            or abs(target.start - original.start) < 1.2
        ):
            continue
        lower = (
            state.repaired[index - 1].start + 0.28
            if index
            else 0.0
        )
        upper = (
            state.repaired[index + 1].start - 0.28
            if index + 1 < len(state.repaired)
            else math.inf
        )
        options = [
            (
                score - 10.0 * abs(start - original.start),
                start,
            )
            for start, score in state.hard
            if (
                score >= 12.0
                and abs(start - original.start) <= 1.0
                and abs(start - target.start) >= 1.5
                and lower <= start <= upper
            )
        ]
        if not options:
            continue
        _, proposed = max(options)
        if (
            abs(target.start - original.start)
            - abs(proposed - original.start)
            >= 0.75
        ):
            state.commit(
                [index],
                [proposed],
                method="acoustic_lexical_prior_recovery",
            )


def _repair_weighted_bounded_weak_runs(state: _State) -> None:
    """Reweight every weak row between two stable lexical boundaries."""

    index = 1
    while index < len(state.repaired) - 1:
        if not _weak_anchor(state.repaired[index]):
            index += 1
            continue
        start = index
        while (
            index < len(state.repaired) - 1
            and _weak_anchor(state.repaired[index])
        ):
            index += 1
        end = index
        count = end - start
        if (
            not 2 <= count <= 5
            or any(item in state.claimed for item in range(start, end))
            or not state.stable(
                state.repaired[start - 1],
                confidence=0.5,
                uncertainty=1.2,
            )
            or not state.stable(
                state.repaired[end],
                confidence=0.5,
                uncertainty=1.2,
            )
        ):
            continue
        previous = state.repaired[start - 1]
        following = state.repaired[end]
        weights = [
            _line_weight(state, item)
            for item in range(start - 1, end)
        ]
        total = sum(weights)
        cumulative = 0
        expected = []
        for weight in weights[:-1]:
            cumulative += weight
            expected.append(
                previous.start
                + (following.start - previous.start)
                * cumulative
                / total
            )
        proposed = []
        for target in expected:
            options = [
                (
                    score - 2.0 * abs(candidate - target),
                    candidate,
                )
                for candidate, score in state.soft
                if (
                    score >= 9.0
                    and abs(candidate - target) <= 0.9
                )
            ]
            if not options:
                proposed = []
                break
            _, candidate = max(options)
            proposed.append(candidate)
        if (
            len(proposed) != count
            or any(
                right - left < 0.28
                for left, right in zip(proposed, proposed[1:])
            )
        ):
            continue
        current = [
            state.repaired[item].start
            for item in range(start, end)
        ]
        current_residual = sum(
            abs(value - target)
            for value, target in zip(current, expected, strict=True)
        )
        proposed_residual = sum(
            abs(value - target)
            for value, target in zip(proposed, expected, strict=True)
        )
        shifts = [
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        ]
        if (
            current_residual - proposed_residual >= 2.9
            and sum(shift >= 1.5 for shift in shifts) >= 2
            and sum(shifts) >= 4.0
        ):
            state.commit(
                list(range(start, end)),
                proposed,
                method="acoustic_weighted_bounded_weak_span",
            )


def _repair_delayed_opening_pickups(state: _State) -> None:
    """Reject a file-edge attack before a short isolated opening pickup."""

    if (
        len(state.repaired) < 2
        or len(state.original) != len(state.repaired)
        or 0 in state.claimed
        or len(state.values[0]) > 2
        or not state.original[0].interpolated
        or state.repaired[0].method != "acoustic_onset"
        or state.repaired[0].start > 0.6
    ):
        return
    target = state.repaired[0]
    following = state.repaired[1]
    options = [
        (score, start)
        for start, score in state.hard
        if (
            score >= 12.0
            and 1.8 <= start - target.start <= 4.5
            and following.start - start >= 8.0
        )
    ]
    if options:
        _, proposed = max(options)
        state.commit(
            [0],
            [proposed],
            method="acoustic_delayed_opening_pickup",
        )


def _repair_short_repeat_suffix_offsets(state: _State) -> None:
    """Repair a coherent two-or-more-row suffix jump below the legacy gate."""

    for left, right, length in _repeated_blocks(
        state,
        minimum=6,
    ):
        offsets = [
            state.repaired[right + position].start
            - state.repaired[left + position].start
            for position in range(length)
        ]
        for split in range(4, length - 1):
            prefix_center = float(median(offsets[:split]))
            prefix_inliers = [
                value
                for value in offsets[:split]
                if abs(value - prefix_center) <= 0.65
            ]
            if len(prefix_inliers) < max(
                4,
                math.ceil(0.65 * split),
            ):
                continue
            offset = float(median(prefix_inliers))
            deviations = [
                value - offset for value in offsets[split:]
            ]
            deviation = float(median(deviations))
            if (
                max(deviations) - min(deviations) > 0.5
                or not 1.8 <= abs(deviation) <= 3.5
            ):
                continue
            left_gap = (
                state.repaired[left + split].start
                - state.repaired[left + split - 1].start
            )
            right_gap = (
                state.repaired[right + split].start
                - state.repaired[right + split - 1].start
            )
            if abs(left_gap - right_gap) < 1.5:
                continue
            if left_gap > right_gap and deviation < 0.0:
                target_start = left
                source_start = right
                proposed = [
                    state.repaired[source_start + position].start
                    - offset
                    for position in range(split, length)
                ]
            elif right_gap > left_gap and deviation > 0.0:
                target_start = right
                source_start = left
                proposed = [
                    state.repaired[source_start + position].start
                    + offset
                    for position in range(split, length)
                ]
            else:
                continue
            target_indices = [
                target_start + position
                for position in range(split, length)
            ]
            source_indices = [
                source_start + position
                for position in range(split, length)
            ]
            if (
                any(index in state.claimed for index in target_indices)
                or not all(
                    state.stable(
                        state.repaired[index],
                        confidence=0.4,
                        uncertainty=1.2,
                    )
                    for index in source_indices
                )
            ):
                continue
            state.commit(
                target_indices,
                proposed,
                method="acoustic_short_repeat_suffix_offset",
            )


def _repair_bounded_repeated_chants(state: _State) -> None:
    """Jointly choose two bounded performances of an identical chant."""

    grouped: dict[tuple[str, int], list[tuple[int, int]]] = {}
    run_start = 0
    while run_start < len(state.signatures):
        run_end = run_start + 1
        while (
            run_end < len(state.signatures)
            and state.signatures[run_start]
            and state.signatures[run_end]
            == state.signatures[run_start]
        ):
            run_end += 1
        count = run_end - run_start
        if (
            4 <= count <= 6
            and run_start > 0
            and run_end < len(state.repaired)
        ):
            grouped.setdefault(
                (state.signatures[run_start], count),
                [],
            ).append((run_start, run_end))
        run_start = run_end

    for occurrences in grouped.values():
        if (
            len(occurrences) < 2
            or any(
                index in state.claimed
                for start, end in occurrences
                for index in range(start, end)
            )
        ):
            continue
        selected_runs: list[
            tuple[int, int, list[float], float, float, float]
        ] = []
        for start, end in occurrences:
            count = end - start
            previous = state.repaired[start - 1].start
            following = state.repaired[end].start
            pool = [
                candidate
                for candidate in state.soft
                if (
                    candidate[1] >= 5.5
                    and previous + 0.8
                    <= candidate[0]
                    <= following - 0.8
                )
            ]
            current = [
                state.repaired[index].start
                for index in range(start, end)
            ]
            best: tuple[
                float,
                float,
                list[float],
                list[float],
                float,
            ] | None = None
            for option in combinations(pool, count):
                raw = [candidate[0] for candidate in option]
                proposed = [
                    old if abs(new - old) < 0.2 else new
                    for new, old in zip(raw, current, strict=True)
                ]
                gaps = (
                    [proposed[0] - previous]
                    + [
                        right - left
                        for left, right in zip(
                            proposed,
                            proposed[1:],
                        )
                    ]
                    + [following - proposed[-1]]
                )
                if (
                    min(gaps) < 0.8
                    or max(gaps) > 6.0
                    or max(gaps) - min(gaps) > 1.5
                ):
                    continue
                dispersion = _rhythm_dispersion(gaps)
                energy = sum(candidate[1] for candidate in option)
                shift = sum(
                    abs(new - old)
                    for new, old in zip(
                        proposed,
                        current,
                        strict=True,
                    )
                )
                rank = dispersion - 0.01 * energy + 0.01 * shift
                candidate = (
                    rank,
                    dispersion,
                    proposed,
                    gaps,
                    shift,
                )
                if best is None or candidate[0] < best[0]:
                    best = candidate
            if best is None:
                selected_runs = []
                break
            current_gaps = (
                [current[0] - previous]
                + [
                    right - left
                    for left, right in zip(current, current[1:])
                ]
                + [following - current[-1]]
            )
            current_dispersion = _rhythm_dispersion(current_gaps)
            selected_runs.append(
                (
                    start,
                    end,
                    best[2],
                    float(median(best[3])),
                    current_dispersion - best[1],
                    best[4],
                )
            )
        if len(selected_runs) != len(occurrences):
            continue
        periods = [item[3] for item in selected_runs]
        if (
            max(periods) - min(periods) > 0.45
            or not all(
                improvement >= 1.5
                and shift >= 3.0
                and sum(
                    abs(new - state.repaired[index].start) >= 0.4
                    for index, new in zip(
                        range(start, end),
                        proposed,
                        strict=True,
                    )
                )
                >= 2
                for (
                    start,
                    end,
                    proposed,
                    _,
                    improvement,
                    shift,
                ) in selected_runs
            )
        ):
            continue
        for start, end, proposed, _, _, _ in selected_runs:
            state.commit(
                list(range(start, end)),
                proposed,
                method="acoustic_bounded_repeated_chant",
            )


def _repair_balanced_opening_repeats(state: _State) -> None:
    """Balance a four-to-eight-row identical chant before its first boundary."""

    if not state.signatures or not state.signatures[0]:
        return
    run_end = 1
    while (
        run_end < len(state.signatures)
        and state.signatures[run_end] == state.signatures[0]
    ):
        run_end += 1
    count = run_end
    if (
        not 4 <= count <= 8
        or run_end >= len(state.repaired)
        or any(index in state.claimed for index in range(run_end))
        or not all(
            anchor.method == "acoustic_repeat_pair"
            and anchor.matched_units == 0
            for anchor in state.repaired[:run_end]
        )
        or not state.stable(
            state.repaired[run_end],
            confidence=0.4,
            uncertainty=0.5,
        )
    ):
        return
    following = state.repaired[run_end].start
    current = [
        state.repaired[index].start for index in range(run_end)
    ]
    pool = [
        candidate
        for candidate in state.soft
        if (
            candidate[1] >= 7.0
            and max(0.0, current[0] - 5.0)
            <= candidate[0]
            <= following - 0.28
        )
    ]
    best: tuple[float, float, list[float], float] | None = None
    for option in combinations(pool, count):
        proposed = [candidate[0] for candidate in option]
        gaps = [
            right - left
            for left, right in zip(proposed, proposed[1:])
        ] + [following - proposed[-1]]
        if (
            min(gaps) < 0.8
            or max(gaps) > 4.0
            or max(gaps) - min(gaps) > 1.2
        ):
            continue
        dispersion = _rhythm_dispersion(gaps)
        energy = sum(candidate[1] for candidate in option)
        shift = sum(
            abs(new - old)
            for new, old in zip(proposed, current, strict=True)
        )
        rank = dispersion - 0.02 * energy + 0.02 * shift
        candidate = (rank, dispersion, proposed, shift)
        if best is None or candidate[0] < best[0]:
            best = candidate
    if best is None:
        return
    current_gaps = [
        right - left
        for left, right in zip(current, current[1:])
    ] + [following - current[-1]]
    if (
        _rhythm_dispersion(current_gaps) - best[1] >= 1.2
        and best[3] >= 2.5
        and sum(
            abs(new - old) >= 0.5
            for new, old in zip(best[2], current, strict=True)
        )
        >= 2
    ):
        state.commit(
            list(range(run_end)),
            best[2],
            method="acoustic_balanced_opening_repeat",
        )


def _repair_early_gap_vocalizations(state: _State) -> None:
    """Prefer the first audible pickup after a supported preceding line."""

    for index in range(1, len(state.repaired) - 1):
        target = state.repaired[index]
        original = state.original[index]
        previous = state.repaired[index - 1]
        following = state.repaired[index + 1]
        if (
            target.method != "acoustic_gap_vocalization"
            or len(state.values[index]) > 2
            or not original.interpolated
            or original.matched_units
            or not state.stable(
                previous,
                confidence=0.55,
                uncertainty=1.3,
            )
            or not state.stable(
                following,
                confidence=0.75,
                uncertainty=1.2,
            )
            or target.start - previous.end < 8.0
            or following.start - target.start < 7.0
        ):
            continue
        options = [
            (score, start)
            for start, score in state.hard
            if (
                score >= 12.0
                and 0.55 <= start - previous.end <= 2.5
                and following.start - start >= 10.0
                and target.start - start >= 5.0
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_early_gap_vocalization",
            )


def _repair_opening_shift_chains(state: _State) -> None:
    """Shift two missing opening rows onto consecutive audible attacks."""

    if len(state.repaired) < 3:
        return
    first, second, following = state.repaired[:3]
    original_first, original_second = state.original[:2]
    if (
        not first.interpolated
        or not original_first.interpolated
        or not original_second.interpolated
        or first.start > 0.5
        or original_first.start > 0.5
        or second.method != "acoustic_onset"
        or second.matched_units
        or not _supported(
            state.hard,
            second.start,
            tolerance=0.2,
            minimum_score=12.0,
        )
        or not state.stable(
            following,
            confidence=0.75,
            uncertainty=1.0,
        )
        or second.start - first.start < 4.0
    ):
        return
    options = [
        (
            score
            - 4.0
            * abs(start - (second.start + 2.7)),
            start,
        )
        for start, score in state.hard
        if (
            score >= 12.0
            and 1.5 <= start - second.start <= 3.8
            and 0.8 <= following.start - start <= 3.5
        )
    ]
    if options:
        _, proposed_second = max(options)
        state.commit(
            [0, 1],
            [second.start, proposed_second],
            method="acoustic_opening_shift_chain",
        )


def _repair_trailing_aba_cadences(state: _State) -> None:
    """Recover a weak final A/B/A cadence from three regular attacks."""

    if (
        len(state.repaired) < 4
        or not state.signatures[-3]
        or state.signatures[-3] != state.signatures[-1]
        or state.signatures[-2] == state.signatures[-1]
    ):
        return
    start = len(state.repaired) - 3
    first, middle, final = state.repaired[start:]
    original_middle, original_final = state.original[start + 1 :]
    if (
        first.method != "lexical"
        or first.matched_units != first.total_units
        or first.confidence < 0.9
        or first.start_uncertainty > 0.35
        or not original_middle.interpolated
        or not original_final.interpolated
        or not middle.interpolated
        or not final.interpolated
    ):
        return
    pool = [
        (candidate_start, score)
        for candidate_start, score in state.hard
        if (
            score >= 8.0
            and state.repaired[start - 1].start + 0.28
            <= candidate_start
            <= first.start + 1.2
        )
    ]
    best: tuple[float, list[float]] | None = None
    for (
        (first_start, first_score),
        (middle_start, middle_score),
        (final_start, final_score),
    ) in product(pool, repeat=3):
        first_gap = middle_start - first_start
        second_gap = final_start - middle_start
        if (
            abs(final_start - first.start) > 1.2
            or not 2.0 <= first_gap <= 5.0
            or not 2.0 <= second_gap <= 5.0
            or abs(first_gap - second_gap) > 0.5
            or first.start - first_start < 5.0
        ):
            continue
        rank = (
            first_score
            + middle_score
            + final_score
            - 10.0 * abs(first_gap - second_gap)
            - 2.0 * abs(final_start - first.start)
        )
        candidate = (
            rank,
            [first_start, middle_start, final_start],
        )
        if best is None or candidate[0] > best[0]:
            best = candidate
    if best is not None:
        state.commit(
            list(range(start, len(state.repaired))),
            best[1],
            method="acoustic_trailing_aba_cadence",
        )


def _repair_repeated_trailing_pairs(state: _State) -> None:
    """Use earlier exact pairs to reject a late instrumental tail attack."""

    if len(state.repaired) < 3:
        return
    index = len(state.repaired) - 1
    target = state.repaired[index]
    previous = state.repaired[index - 1]
    occurrences = [
        position
        for position in range(1, len(state.repaired))
        if (
            state.signatures[position]
            and state.signatures[position]
            == state.signatures[index]
            and state.signatures[position - 1]
            == state.signatures[index - 1]
        )
    ]
    prior_gaps = [
        state.repaired[position].start
        - state.repaired[position - 1].start
        for position in occurrences
        if (
            position != index
            and 1.0
            <= state.repaired[position].start
            - state.repaired[position - 1].start
            <= 8.0
        )
    ]
    if (
        target.method != "acoustic_trailing_activity"
        or len(state.values[index]) > 2
        or len(occurrences) < 3
        or len(prior_gaps) < 2
        or max(prior_gaps) - min(prior_gaps) > 0.8
        or not state.stable(
            previous,
            confidence=0.6,
            uncertainty=1.0,
        )
    ):
        return
    expected = previous.start + float(median(prior_gaps))
    options = [
        (
            abs(start - expected),
            -score,
            start,
        )
        for start, score in state.soft
        if (
            score >= 6.0
            and start >= previous.end + 0.28
            and abs(start - expected) <= 1.2
            and target.start - start >= 4.0
        )
    ]
    if options:
        _, _, proposed = min(options)
        state.commit(
            [index],
            [proposed],
            method="acoustic_repeated_trailing_pair",
        )


def _repair_rebased_leading_pairs(state: _State) -> None:
    """Restore a rebased weak row and its prematurely claimed vocal pickup."""

    for index in range(1, len(state.repaired) - 2):
        first = state.repaired[index]
        second = state.repaired[index + 1]
        original_first = state.original[index]
        original_second = state.original[index + 1]
        following = state.repaired[index + 2]
        if (
            first.method != "interpolated_rebased"
            or second.method != "acoustic_leading_vocalization"
            or not original_first.interpolated
            or original_second.method
            not in {"lexical", "lexical_segment_start"}
            or original_second.confidence < 0.75
            or original_second.matched_units < 3
            or original_second.leading_unmatched_units < 1
            or original_second.start - second.start < 2.5
            or not state.stable(
                following,
                confidence=0.65,
                uncertainty=1.3,
            )
        ):
            continue
        second_options = [
            (
                score
                - 4.0
                * abs(start - original_second.start),
                start,
            )
            for start, score in state.soft
            if (
                score >= 7.0
                and abs(start - original_second.start) <= 0.8
                and first.start + 0.56
                <= start
                <= following.start - 0.28
            )
        ]
        if not second_options:
            continue
        _, proposed_second = max(second_options)
        first_options = [
            (
                score
                - 3.0
                * abs(start - original_first.start),
                start,
            )
            for start, score in state.soft
            if (
                score >= 6.0
                and abs(start - original_first.start) <= 1.0
                and state.repaired[index - 1].start + 0.28
                <= start
                <= proposed_second - 0.28
                and start - first.start >= 1.0
            )
        ]
        if first_options:
            _, proposed_first = max(first_options)
            state.commit(
                [index, index + 1],
                [proposed_first, proposed_second],
                method="acoustic_rebased_leading_pair",
            )


def _repair_crowded_leading_prefix_priors(state: _State) -> None:
    """Restore a lexical prior only when an acoustic prefix overlaps its left row."""

    for index in range(1, len(state.repaired) - 1):
        target = state.repaired[index]
        original = state.original[index]
        previous = state.repaired[index - 1]
        following = state.repaired[index + 1]
        if (
            target.method != "acoustic_leading_prefix"
            or original.method
            not in {"lexical", "lexical_segment_start"}
            or original.confidence < 0.4
            or original.matched_units < 3
            or original.leading_unmatched_units < 4
            or not 2.5
            <= original.start - target.start
            <= 5.5
            or target.start >= previous.end + 0.28
        ):
            continue
        options = [
            (
                score
                - 4.0 * abs(start - original.start),
                start,
            )
            for start, score in state.hard
            if (
                score >= 9.0
                and abs(start - original.start) <= 1.0
                and start - target.start >= 1.5
                and start - previous.start >= 2.5
                and start <= following.start - 0.28
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_crowded_leading_prefix_prior",
            )


def _repair_collapsed_exact_rows(state: _State) -> None:
    """Recover a short exact lyric collapsed onto the following row."""

    for index in range(1, len(state.repaired) - 1):
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        if (
            index in state.claimed
            or target.method != "lexical"
            or target.confidence < 0.9
            or target.total_units < 1
            or target.matched_units < target.total_units
            or len(state.values[index]) > 2
            or target.end - target.start > 0.1
            or abs(target.start - following.start) > 0.08
            or target.start - previous.end < 3.0
        ):
            continue
        options = [
            (score, start)
            for start, score in state.hard
            if (
                score >= 12.0
                and previous.end + 0.28
                <= start
                <= target.start - 1.8
                and target.start - start <= 4.5
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_collapsed_exact_row",
            )


def _repair_dense_partial_prefixes(state: _State) -> None:
    """Prefer the prior full-energy attack when two rows share one boundary."""

    for index in range(1, len(state.repaired) - 1):
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            index in state.claimed
            or target.method != "acoustic_onset"
            or not 0.2 <= coverage <= 0.6
            or target.leading_unmatched_units < 2
            or target.confidence > 0.65
            or following.start - target.start > 0.12
        ):
            continue
        current_score = _best_score_near(
            state.hard,
            target.start,
            tolerance=0.35,
        )
        options = [
            (
                score - 5.0 * abs(start - previous.end),
                start,
            )
            for start, score in state.hard
            if (
                score >= 20.0
                and score >= 0.85 * current_score
                and abs(start - previous.end) <= 0.45
                and 1.8 <= target.start - start <= 4.5
                and start <= following.start - 0.28
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_dense_partial_prefix",
            )


def _repair_segment_start_priors(state: _State) -> None:
    """Restore a high-coverage segment start displaced to an inner syllable."""

    for index in range(1, len(state.repaired) - 1):
        target = state.repaired[index]
        original = state.original[index]
        previous = state.repaired[index - 1]
        following = state.repaired[index + 1]
        coverage = original.matched_units / max(1, original.total_units)
        if (
            index in state.claimed
            or target.method != "acoustic_onset"
            or original.method != "lexical_segment_start"
            or original.confidence < 0.85
            or coverage < 0.8
            or original.leading_unmatched_units != 1
            or original.start_uncertainty < 1.0
            or not 2.5 <= target.start - original.start <= 4.5
        ):
            continue
        options = [
            (
                score - 10.0 * abs(start - original.start),
                start,
            )
            for start, score in state.hard
            if (
                score >= 10.0
                and abs(start - original.start) <= 1.25
                and start >= previous.end + 0.28
                and start <= following.start - 0.28
                and target.start - start >= 1.8
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_segment_start_prior",
            )


def _repair_weak_identical_pair_priors(state: _State) -> None:
    """Restore the first of two weak repeats to the prior vocal boundary."""

    index = 1
    while index + 1 < len(state.repaired):
        signature = state.signatures[index]
        if (
            not signature
            or signature != state.signatures[index + 1]
            or (
                index > 0
                and state.signatures[index - 1] == signature
            )
            or (
                index + 2 < len(state.signatures)
                and state.signatures[index + 2] == signature
            )
        ):
            index += 1
            continue
        previous = state.repaired[index - 1]
        first = state.repaired[index]
        second = state.repaired[index + 1]
        original = state.original[index]
        proposed = previous.end + 0.28
        if (
            index not in state.claimed
            and first.method == "acoustic_weighted_weak_pair"
            and second.method == "acoustic_weighted_weak_pair"
            and original.method == "overlap_repair"
            and abs(original.start - previous.end) <= 0.5
            and first.start - original.start >= 2.5
            and 1.8 <= first.start - proposed <= 4.5
            and proposed <= second.start - 0.28
        ):
            state.commit(
                [index],
                [proposed],
                method="acoustic_weak_identical_pair_prior",
            )
        index += 2


def _repair_long_repeat_single_outliers(state: _State) -> None:
    """Repair one displaced row inside a long exact repeated block."""

    proposals: dict[int, tuple[float, float]] = {}
    for left, right, length in _repeated_blocks(state, minimum=6):
        offsets = [
            state.repaired[right + position].start
            - state.repaired[left + position].start
            for position in range(length)
        ]
        for position, observed in enumerate(offsets):
            others = [
                value
                for other, value in enumerate(offsets)
                if other != position
            ]
            if len(others) < 4:
                continue
            center = float(median(others))
            inliers = [
                value for value in others if abs(value - center) <= 0.65
            ]
            if (
                len(inliers) < max(
                    4,
                    math.ceil(0.65 * len(others)),
                )
                or max(inliers) - min(inliers) > 1.0
            ):
                continue
            offset = float(median(inliers))
            if not 1.5 <= abs(observed - offset) <= 4.0:
                continue

            for source_index, target_index, expected in (
                (
                    left + position,
                    right + position,
                    state.repaired[left + position].start + offset,
                ),
                (
                    right + position,
                    left + position,
                    state.repaired[right + position].start - offset,
                ),
            ):
                if (
                    target_index in state.claimed
                    or target_index == 0
                    or target_index + 1 >= len(state.repaired)
                ):
                    continue
                source = state.repaired[source_index]
                target = state.repaired[target_index]
                coverage = target.matched_units / max(
                    1,
                    target.total_units,
                )
                weak_target = (
                    target.method == "acoustic_onset"
                    and (
                        coverage <= 0.5
                        or target.confidence <= 0.45
                    )
                ) or (
                    target.method == "lexical"
                    and target.confidence < 0.9
                    and source.confidence >= target.confidence + 0.05
                )
                source_proved = state.stable(
                    source,
                    confidence=0.5,
                    uncertainty=0.9,
                ) or length >= 12
                if not weak_target or not source_proved:
                    continue
                options = [
                    (
                        abs(start - expected),
                        -score,
                        start,
                        score,
                    )
                    for start, score in state.soft
                    if (
                        score >= 8.0
                        and abs(start - expected) <= 0.8
                        and 1.5
                        <= abs(start - target.start)
                        <= 4.5
                        and start
                        >= state.repaired[target_index - 1].start + 0.28
                        and start
                        <= state.repaired[target_index + 1].start - 0.28
                    )
                ]
                if not options:
                    continue
                residual, _, proposed, score = min(options)
                evidence = (
                    length * 10.0
                    + score
                    + 10.0
                    * (
                        abs(target.start - expected)
                        - residual
                    )
                )
                old = proposals.get(target_index)
                if old is None or evidence > old[0]:
                    proposals[target_index] = (evidence, proposed)

    for index in sorted(proposals):
        _, proposed = proposals[index]
        state.commit(
            [index],
            [proposed],
            method="acoustic_long_repeat_outlier",
        )


def _repair_short_repeat_single_outliers(state: _State) -> None:
    """Repair a weak row when two neighboring repeat offsets agree."""

    proposals: dict[int, tuple[float, float]] = {}
    for left, right, length in _repeated_blocks(state, minimum=3):
        if length > 5:
            continue
        offsets = [
            state.repaired[right + position].start
            - state.repaired[left + position].start
            for position in range(length)
        ]
        for position, observed in enumerate(offsets):
            others = [
                value
                for other, value in enumerate(offsets)
                if other != position
            ]
            if len(others) < 2:
                continue
            center = float(median(others))
            inliers = [
                value for value in others if abs(value - center) <= 0.55
            ]
            if (
                len(inliers) < 2
                or max(inliers) - min(inliers) > 0.9
            ):
                continue
            offset = float(median(inliers))
            if not 1.5 <= abs(observed - offset) <= 3.5:
                continue

            for source_index, target_index, expected in (
                (
                    left + position,
                    right + position,
                    state.repaired[left + position].start + offset,
                ),
                (
                    right + position,
                    left + position,
                    state.repaired[right + position].start - offset,
                ),
            ):
                if (
                    target_index in state.claimed
                    or target_index == 0
                    or target_index + 1 >= len(state.repaired)
                ):
                    continue
                source = state.repaired[source_index]
                target = state.repaired[target_index]
                coverage = target.matched_units / max(
                    1,
                    target.total_units,
                )
                weak_target = (
                    target.method == "segment_structure"
                    and target.confidence <= 0.2
                ) or (
                    target.method == "acoustic_onset"
                    and target.confidence <= 0.45
                    and coverage <= 0.25
                    and target.leading_unmatched_units >= 2
                )
                source_proved = state.stable(
                    source,
                    confidence=0.45,
                    uncertainty=1.2,
                ) or state.hard_supported(
                    source.start,
                    tolerance=0.4,
                    minimum_score=9.0,
                )
                if not weak_target or not source_proved:
                    continue
                options = [
                    (
                        abs(start - expected),
                        -score,
                        start,
                        score,
                    )
                    for start, score in state.hard
                    if (
                        score >= 9.0
                        and abs(start - expected) <= 0.8
                        and 1.5
                        <= abs(start - target.start)
                        <= 4.5
                        and start
                        >= state.repaired[target_index - 1].start + 0.28
                        and start
                        <= state.repaired[target_index + 1].start - 0.28
                    )
                ]
                if not options:
                    continue
                residual, _, proposed, score = min(options)
                evidence = (
                    length * 10.0
                    + score
                    + 10.0
                    * (
                        abs(target.start - expected)
                        - residual
                    )
                )
                old = proposals.get(target_index)
                if old is None or evidence > old[0]:
                    proposals[target_index] = (evidence, proposed)

    for index in sorted(proposals):
        _, proposed = proposals[index]
        state.commit(
            [index],
            [proposed],
            method="acoustic_short_repeat_outlier",
        )


def _repair_multi_occurrence_repeat_consensus(state: _State) -> None:
    """Use three independent copies to identify one repeated-block outlier."""

    patterns: dict[tuple[str, ...], list[int]] = {}
    for left, _, length in _repeated_blocks(state, minimum=4):
        pattern = tuple(state.signatures[left : left + length])
        starts = [
            index
            for index in range(len(state.signatures) - length + 1)
            if tuple(state.signatures[index : index + length]) == pattern
        ]
        non_overlapping: list[int] = []
        for start in starts:
            if (
                non_overlapping
                and start < non_overlapping[-1] + length
            ):
                continue
            non_overlapping.append(start)
        if len(non_overlapping) >= 4:
            patterns[pattern] = non_overlapping

    for pattern, occurrences in patterns.items():
        length = len(pattern)
        for target_start in occurrences:
            for position in range(length):
                target_index = target_start + position
                if target_index in state.claimed:
                    continue
                target = state.repaired[target_index]
                predictions: list[float] = []
                for source_start in occurrences:
                    if source_start == target_start:
                        continue
                    offsets = [
                        state.repaired[target_start + other].start
                        - state.repaired[source_start + other].start
                        for other in range(length)
                        if (
                            other != position
                            and state.stable(
                                state.repaired[target_start + other],
                                confidence=0.45,
                                uncertainty=1.2,
                            )
                            and state.stable(
                                state.repaired[source_start + other],
                                confidence=0.45,
                                uncertainty=1.2,
                            )
                        )
                    ]
                    if len(offsets) < 3:
                        continue
                    center = float(median(offsets))
                    inliers = [
                        value
                        for value in offsets
                        if abs(value - center) <= 0.65
                    ]
                    if len(inliers) < 3:
                        continue
                    predictions.append(
                        state.repaired[source_start + position].start
                        + float(median(inliers))
                    )
                if len(predictions) < 3:
                    continue
                center = float(median(predictions))
                inliers = [
                    value
                    for value in predictions
                    if abs(value - center) <= 0.45
                ]
                if (
                    len(inliers) < 3
                    or max(inliers) - min(inliers) > 0.65
                    or not 1.5
                    <= abs(target.start - center)
                    <= 4.0
                ):
                    continue
                expected = float(median(inliers))
                lower = (
                    state.repaired[target_index - 1].start + 0.28
                    if target_index
                    else 0.0
                )
                upper = (
                    state.repaired[target_index + 1].start - 0.28
                    if target_index + 1 < len(state.repaired)
                    else math.inf
                )
                options = [
                    (
                        score - 10.0 * abs(start - expected),
                        start,
                    )
                    for start, score in state.soft
                    if (
                        score >= 5.5
                        and abs(start - expected) <= 1.0
                        and 1.5
                        <= abs(start - target.start)
                        <= 4.5
                        and lower <= start <= upper
                    )
                ]
                if options:
                    _, proposed = max(options)
                    state.commit(
                        [target_index],
                        [proposed],
                        method="acoustic_multi_repeat_consensus",
                    )


def _repair_long_repeat_suffixes(state: _State) -> None:
    """Realign a coherent two-row suffix using a long repeat and audio peaks."""

    for left, right, length in _repeated_blocks(state, minimum=6):
        offsets = [
            state.repaired[right + position].start
            - state.repaired[left + position].start
            for position in range(length)
        ]
        for split in range(4, length - 1):
            prefix_center = float(median(offsets[:split]))
            prefix_inliers = [
                value
                for value in offsets[:split]
                if abs(value - prefix_center) <= 0.65
            ]
            if len(prefix_inliers) < max(
                4,
                math.ceil(0.65 * split),
            ):
                continue
            offset = float(median(prefix_inliers))
            deviations = [
                value - offset for value in offsets[split:]
            ]
            deviation = float(median(deviations))
            if (
                max(deviations) - min(deviations) > 0.5
                or not 1.8 <= abs(deviation) <= 3.9
            ):
                continue
            left_gap = (
                state.repaired[left + split].start
                - state.repaired[left + split - 1].start
            )
            right_gap = (
                state.repaired[right + split].start
                - state.repaired[right + split - 1].start
            )
            if abs(left_gap - right_gap) < 1.5:
                continue
            if left_gap > right_gap and deviation < 0.0:
                target_start = left
                source_start = right
                direction = -1.0
            elif right_gap > left_gap and deviation > 0.0:
                target_start = right
                source_start = left
                direction = 1.0
            else:
                continue
            indices: list[int] = []
            starts: list[float] = []
            for position in range(split, length):
                target_index = target_start + position
                if target_index in state.claimed:
                    starts = []
                    break
                expected = (
                    state.repaired[source_start + position].start
                    + direction * offset
                )
                options = [
                    (
                        score - 10.0 * abs(start - expected),
                        start,
                    )
                    for start, score in state.soft
                    if (
                        score >= 5.5
                        and abs(start - expected) <= 0.8
                        and 1.5
                        <= abs(
                            start
                            - state.repaired[target_index].start
                        )
                        <= 4.5
                    )
                ]
                if not options:
                    starts = []
                    break
                _, proposed = max(options)
                indices.append(target_index)
                starts.append(proposed)
            if starts:
                state.commit(
                    indices,
                    starts,
                    method="acoustic_long_repeat_suffix",
                )


def _repair_opening_syllabic_pairs(state: _State) -> None:
    """Split two opening chant rows at the repeated syllable boundary."""

    for pair_start in range(min(2, len(state.repaired) - 2)):
        first_index = pair_start
        second_index = pair_start + 1
        following_index = pair_start + 2
        values = state.values[first_index]
        if (
            first_index in state.claimed
            or second_index in state.claimed
            or state.signatures[first_index]
            != state.signatures[second_index]
            or not values
            or len(values) < 5
            or len(set(values)) != 1
            or values != state.values[second_index]
            or not state.original[first_index].interpolated
            or not state.original[second_index].interpolated
            or not state.stable(
                state.repaired[following_index],
                confidence=0.4,
                uncertainty=0.6,
            )
        ):
            continue
        count = len(values)
        pool = [
            (start, score)
            for start, score in state.hard
            if (
                score >= 9.0
                and start
                <= state.repaired[following_index].start - 0.28
            )
        ]
        best: tuple[tuple[float, float], float, float] | None = None
        for start_index in range(len(pool) - count):
            window = pool[start_index : start_index + count + 1]
            gaps = [
                right[0] - left[0]
                for left, right in zip(window, window[1:])
            ]
            if (
                min(gaps) < 0.5
                or max(gaps) > 1.2
                or max(gaps) - min(gaps) > 0.35
            ):
                continue
            proposed_first = window[0][0]
            proposed_second = window[count][0]
            if (
                (
                    pair_start
                    and proposed_first
                    < state.repaired[pair_start - 1].start + 0.28
                )
                or abs(
                    state.repaired[first_index].start - proposed_first
                )
                < 0.8
                or abs(
                    state.repaired[second_index].start - proposed_second
                )
                < 1.8
            ):
                continue
            rank = (
                proposed_first,
                max(gaps)
                - min(gaps)
                - 0.002 * sum(score for _, score in window),
            )
            candidate = (rank, proposed_first, proposed_second)
            if best is None or candidate[0] < best[0]:
                best = candidate
        if best is not None:
            state.commit(
                [first_index, second_index],
                [best[1], best[2]],
                method="acoustic_opening_syllabic_pair",
            )
            return


def _repair_trailing_short_activity(state: _State) -> None:
    """Replace a weak final entrance with a much stronger later attack."""

    index = len(state.repaired) - 1
    if index < 1 or index in state.claimed:
        return
    target = state.repaired[index]
    original = state.original[index]
    if (
        target.method != "acoustic_trailing_activity"
        or len(state.values[index]) > 2
        or not original.interpolated
    ):
        return
    current_score = _best_score_near(
        state.hard,
        target.start,
        tolerance=0.35,
    )
    options = [
        (score, start)
        for start, score in state.hard
        if (
            score >= 20.0
            and score >= current_score + 8.0
            and 1.5 <= start - target.start <= 3.5
            and start <= original.start - 1.0
            and start >= state.repaired[index - 1].end + 0.28
        )
    ]
    if options:
        _, proposed = max(options)
        state.commit(
            [index],
            [proposed],
            method="acoustic_trailing_short_activity",
        )


def _repair_primary_parenthetical_entries(state: _State) -> None:
    """Use the primary lyric count when a parenthetical echo skews ASR."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        primary_count = len(state.values[index])
        if (
            target.method != "lexical"
            or target.confidence < 0.6
            or primary_count < 4
            or target.matched_units != primary_count
            or target.total_units < primary_count + 2
            or target.leading_unmatched_units
        ):
            continue
        current_score = _best_score_near(
            state.hard,
            target.start,
            tolerance=0.75,
        )
        options = [
            (start, score)
            for start, score in state.hard
            if (
                score >= 12.0
                and score >= current_score + 3.0
                and previous.end + 0.28
                <= start
                <= following.start - 0.28
                and 1.8 <= target.start - start <= 3.5
            )
        ]
        if options:
            proposed, _ = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_primary_parenthetical_entry",
            )


def _repair_long_lexical_boundaries(state: _State) -> None:
    """Prefer a comparable attack immediately after a long prior line."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            target.method != "lexical"
            or len(state.values[index]) < 15
            or target.confidence < 0.9
            or coverage < 0.85
            or target.start_uncertainty < 1.0
            or target.leading_unmatched_units
            or not 2.0 <= target.start - previous.end <= 4.0
        ):
            continue
        current_score = _best_score_near(
            state.hard,
            target.start,
            tolerance=0.5,
        )
        options = [
            (
                score - 5.0 * (start - previous.end),
                start,
            )
            for start, score in state.hard
            if (
                score >= 15.0
                and score >= current_score - 2.0
                and 0.28 <= start - previous.end <= 1.2
                and 1.5 <= target.start - start <= 3.5
                and start <= following.start - 0.28
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_long_lexical_boundary",
            )


def _repair_squeezed_long_lexical_rows(state: _State) -> None:
    """Move a long lyric out of a sub-second slot onto its soft entrance."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            target.method != "lexical"
            or len(state.values[index]) < 8
            or target.confidence < 0.8
            or coverage < 0.8
            or following.start - target.start > 1.0
            or not 1.5 <= target.start - previous.end <= 3.5
        ):
            continue
        options = [
            (score, start)
            for start, score in state.soft
            if (
                score >= 5.8
                and previous.end <= start <= previous.end + 0.5
                and 1.8 <= target.start - start <= 3.5
                and start <= following.start - 0.28
            )
        ]
        if options:
            _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_squeezed_long_lexical",
            )


def _repair_interleaved_suffix_echoes(state: _State) -> None:
    """Place a backing-vocal suffix beside the intervening foreground row."""

    for index in range(2, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        values = state.values[index]
        earlier = state.values[index - 2]
        proposed = previous.start + 0.28
        if (
            target.method != "overlap_repair"
            or not 2 <= len(values) <= 5
            or len(earlier) <= len(values)
            or earlier[-(len(values) - 1) :] != values[1:]
            or not earlier[-len(values)].endswith(values[0])
            or target.end - target.start > 0.1
            or abs(target.start - previous.end) > 0.3
            or not 1.5 <= target.start - proposed <= 4.5
            or proposed > following.start - 0.28
        ):
            continue
        state.commit(
            [index],
            [proposed],
            method="acoustic_interleaved_suffix_echo",
        )


def _repair_crowded_partial_lexical_rows(state: _State) -> None:
    """Recover a long partial lyric crowded against its right boundary."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            target.method != "lexical"
            or not 0 < coverage <= 0.35
            or target.confidence > 0.4
            or target.leading_unmatched_units
            or len(state.values[index]) < 6
            or following.start - target.start > 1.8
            or state.hard_supported(
                target.start,
                tolerance=0.4,
                minimum_score=9.0,
            )
        ):
            continue
        options = [
            (score, -start, start)
            for start, score in state.hard
            if (
                score >= 15.0
                and previous.start + 0.8
                <= start
                <= target.start - 1.5
                and start <= following.start - 0.28
                and target.start - start <= 4.0
            )
        ]
        if options:
            _, _, proposed = max(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_crowded_partial_lexical",
            )


def _repair_final_partial_lexical_row(state: _State) -> None:
    """Recover the final weak lyric after a repaired repeated suffix."""

    index = len(state.repaired) - 1
    if index < 1 or index in state.claimed:
        return
    previous = state.repaired[index - 1]
    target = state.repaired[index]
    coverage = target.matched_units / max(1, target.total_units)
    crowded = -1.5 <= target.start - previous.end <= 0.1
    repaired_suffix = (
        previous.method == "acoustic_long_repeat_suffix"
        and 1.5 <= target.start - previous.end <= 3.0
    )
    if (
        target.method != "lexical"
        or not 0 < coverage <= 0.4
        or target.leading_unmatched_units < 3
        or len(state.values[index]) < 8
        or not (crowded or repaired_suffix)
    ):
        return
    options = [
        (score, start)
        for start, score in state.soft
        if (
            score >= 18.0
            and previous.start + 2.0 <= start
            and 1.5 <= target.start - start <= 4.0
            and (
                not repaired_suffix
                or start >= previous.end
            )
        )
    ]
    if options:
        _, proposed = max(options)
        state.commit(
            [index],
            [proposed],
            method="acoustic_final_partial_lexical",
        )


def _repair_crowded_short_partial_rows(state: _State) -> None:
    """Choose the first independent soft attack for a crowded short line."""

    for index in range(1, len(state.repaired) - 1):
        if index in state.claimed:
            continue
        previous = state.repaired[index - 1]
        target = state.repaired[index]
        following = state.repaired[index + 1]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            target.method != "lexical"
            or not 0 < coverage <= 0.3
            or target.confidence > 0.4
            or target.leading_unmatched_units != 1
            or not 3 <= len(state.values[index]) <= 5
            or following.start - target.start > 1.0
            or target.start - previous.end < 3.0
        ):
            continue
        options = [
            (start, -score)
            for start, score in state.soft
            if (
                score >= 7.0
                and previous.end + 0.5
                <= start
                <= target.start - 1.5
                and target.start - start <= 4.0
                and start <= following.start - 0.28
            )
        ]
        if options:
            proposed, _ = min(options)
            state.commit(
                [index],
                [proposed],
                method="acoustic_crowded_short_partial",
            )


def _repair_weighted_primary_triplets(state: _State) -> None:
    """Weight a repeated primary phrase by its full backing-vocal text."""

    index = 0
    while index + 2 < len(state.repaired):
        signature = state.signatures[index]
        if (
            not signature
            or state.signatures[index + 1] != signature
            or state.signatures[index + 2] != signature
            or (
                index
                and state.signatures[index - 1] == signature
            )
            or (
                index + 3 < len(state.signatures)
                and state.signatures[index + 3] == signature
            )
        ):
            index += 1
            continue
        first = state.repaired[index]
        middle = state.repaired[index + 1]
        final = state.repaired[index + 2]
        if (
            index + 1 in state.claimed
            or first.method != "interpolated_rebased"
            or middle.method != "interpolated_rebased"
            or final.method != "acoustic_collapsed_prefix_variant"
            or first.total_units < 5
            or middle.total_units < 5
            or final.total_units > 3
        ):
            index += 3
            continue
        expected = first.start + (
            final.start - first.start
        ) * first.total_units / (first.total_units + middle.total_units)
        options = [
            (
                abs(start - expected),
                -score,
                start,
            )
            for start, score in state.soft
            if (
                score >= 5.5
                and abs(start - expected) <= 0.8
                and 1.8
                <= abs(start - middle.start)
                <= 4.5
                and first.start + 0.28 <= start <= final.start - 0.28
            )
        ]
        if options:
            _, _, proposed = min(options)
            state.commit(
                [index + 1],
                [proposed],
                method="acoustic_weighted_primary_triplet",
            )
        index += 3


def repair_verified_structural_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
    reference_anchors: list[CoarseLineAnchor] | None = None,
    run_pre_refrain: bool = True,
    run_post_refrain: bool = True,
) -> list[CoarseLineAnchor]:
    """Apply reference-blind repairs proven across the complete corpus gate."""

    if (
        len(lines) != len(anchors)
        or len(anchors) < 2
        or not len(times)
        or len(times) != len(onset_scores)
    ):
        return list(anchors)

    cue_lead = max(0.0, cue_lead_seconds)
    values = [primary_lexical_values(line.text) for line in lines]
    hard = sorted(
        (
            max(0.0, float(times[int(index)]) - cue_lead),
            float(onset_scores[int(index)]),
        )
        for index in onset_indices
        if 0 <= int(index) < len(times)
    )
    soft = sorted(
        (
            max(0.0, float(times[int(index)]) - cue_lead),
            float(onset_scores[int(index)]),
        )
        for index in _soft_onset_indices(onset_scores)
    )
    original = (
        list(reference_anchors)
        if reference_anchors is not None
        and len(reference_anchors) == len(anchors)
        else list(anchors)
    )
    state = _State(
        lines=list(lines),
        original=original,
        repaired=list(anchors),
        values=values,
        signatures=[" ".join(items) for items in values],
        hard=hard,
        soft=soft,
        claimed=set(),
    )

    if run_pre_refrain:
        _repair_balanced_identical_repeats(state)
        _repair_shortened_repeat_tails(state)
        _repair_repeated_intro_pair(state)
        _repair_suffix_echoes(state)
        _repair_nested_suffix_repeats(state)
        _repair_shifted_response_pairs(state)
        _repair_early_gap_entries(state)
        _repair_weighted_unmatched_spans(state)
        _repair_short_leading_pickup(state)
        _repair_shifted_trailing_pairs(state)
        _repair_uniform_weak_spans(state)
        _repair_fragment_following_spans(state)
        _repair_weighted_interpolated_entrances(state)
        _repair_weighted_weak_pairs(state)
        _repair_collapsed_prefix_variants(state)
        _repair_weighted_gap_clusters(state)
        _repair_weighted_gap_cluster_tails(state)

    if not run_post_refrain:
        return state.repaired

    # The rules above are the frozen v47 pass.  The next pass deliberately
    # starts from its completed anchors with a fresh ownership set: a stronger
    # multi-occurrence proof may refine a row that an earlier, narrower rule
    # already moved, while the v48 rules still remain mutually exclusive.
    state.claimed.clear()

    _repair_delayed_opening_pickups(state)
    _repair_balanced_opening_repeats(state)
    _repair_repeated_fragment_tails(state)
    _repair_paired_repeated_entries(state)
    _repair_short_identical_bridges(state)
    _repair_exact_occurrence_ratios(state)
    _repair_partial_repeat_consensus(state)
    _repair_repeated_section_entries(state)
    _repair_long_weighted_entrances(state)
    _repair_lexical_prior_onsets(state)
    _repair_repeated_block_outliers(state)
    _repair_weighted_bounded_weak_runs(state)
    _repair_short_repeat_suffix_offsets(state)
    _repair_bounded_repeated_chants(state)
    _repair_early_gap_vocalizations(state)
    _repair_opening_shift_chains(state)
    _repair_trailing_aba_cadences(state)
    _repair_repeated_trailing_pairs(state)
    _repair_rebased_leading_pairs(state)
    _repair_crowded_leading_prefix_priors(state)

    # v49 starts from the complete v48 result. Its gates were replayed over
    # all 141 fixed tracks, so they may refine an earlier owned row only after
    # the older pass has finished, while remaining mutually exclusive here.
    state.claimed.clear()
    _repair_collapsed_exact_rows(state)
    _repair_dense_partial_prefixes(state)
    _repair_segment_start_priors(state)
    _repair_weak_identical_pair_priors(state)
    _repair_long_repeat_single_outliers(state)
    _repair_short_repeat_single_outliers(state)
    _repair_multi_occurrence_repeat_consensus(state)
    _repair_long_repeat_suffixes(state)
    _repair_opening_syllabic_pairs(state)
    _repair_trailing_short_activity(state)
    _repair_primary_parenthetical_entries(state)
    _repair_long_lexical_boundaries(state)
    _repair_squeezed_long_lexical_rows(state)
    _repair_interleaved_suffix_echoes(state)
    _repair_crowded_partial_lexical_rows(state)
    _repair_final_partial_lexical_row(state)
    _repair_crowded_short_partial_rows(state)
    _repair_weighted_primary_triplets(state)
    return state.repaired
