from __future__ import annotations

from dataclasses import dataclass, replace
from difflib import SequenceMatcher

import numpy as np

from .lexical import LexicalUnit, lexical_units, lexical_values
from .types import TranscriptLine


@dataclass(frozen=True, slots=True)
class TimedASRWord:
    text: str
    start: float
    end: float
    probability: float = 1.0


@dataclass(frozen=True, slots=True)
class TimedASRSegment:
    text: str
    start: float
    end: float
    words: tuple[TimedASRWord, ...]


@dataclass(frozen=True, slots=True)
class TimedLexicalUnit:
    value: str
    word_index: int
    start: float
    end: float
    probability: float


@dataclass(frozen=True, slots=True)
class CoarseLineAnchor:
    line_index: int
    start: float
    end: float
    matched_units: int
    total_units: int
    confidence: float
    interpolated: bool
    method: str = "lexical"
    start_uncertainty: float = 0.0
    leading_unmatched_units: int = 0
    acoustic_start_hint: float | None = None
    stretched_second_start_hint: float | None = None


def _timed_units(words: list[TimedASRWord]) -> list[TimedLexicalUnit]:
    units: list[TimedLexicalUnit] = []
    for word_index, word in enumerate(words):
        values = lexical_values(word.text)
        if not values:
            continue
        duration = max(0.0, word.end - word.start)
        for index, value in enumerate(values):
            units.append(
                TimedLexicalUnit(
                    value=value,
                    word_index=word_index,
                    start=word.start + duration * index / len(values),
                    end=word.start + duration * (index + 1) / len(values),
                    probability=word.probability,
                )
            )
    return units


def _similarity(left: str, right: str) -> float:
    if left == right:
        return 4.0
    if min(len(left), len(right)) < 3:
        return -2.2
    ratio = SequenceMatcher(None, left, right, autojunk=False).ratio()
    if ratio >= 0.84:
        return 2.2
    if ratio >= 0.68:
        return 0.55
    return -2.2


def align_lexical_units(
    target: list[LexicalUnit],
    observed: list[TimedLexicalUnit],
) -> list[int | None]:
    """Globally align known transcript units to timestamped ASR units."""

    target_count = len(target)
    observed_count = len(observed)
    if target_count == 0:
        return []
    if observed_count == 0:
        return [None] * target_count

    gap_target = -0.82
    gap_observed = -0.9
    scores = np.empty((target_count + 1, observed_count + 1), dtype=np.float32)
    trace = np.zeros((target_count + 1, observed_count + 1), dtype=np.uint8)
    scores[0, 0] = 0.0
    scores[1:, 0] = np.arange(1, target_count + 1) * gap_target
    scores[0, 1:] = np.arange(1, observed_count + 1) * gap_observed
    trace[1:, 0] = 1
    trace[0, 1:] = 2

    target_scale = max(1, target_count - 1)
    observed_scale = max(1, observed_count - 1)
    for target_index in range(1, target_count + 1):
        left = target[target_index - 1].value
        target_progress = (target_index - 1) / target_scale
        for observed_index in range(1, observed_count + 1):
            right = observed[observed_index - 1].value
            observed_progress = (observed_index - 1) / observed_scale
            progress_penalty = 0.18 * abs(
                target_progress - observed_progress
            )
            diagonal = (
                scores[target_index - 1, observed_index - 1]
                + _similarity(left, right)
                - progress_penalty
            )
            skip_target = scores[target_index - 1, observed_index] + gap_target
            skip_observed = (
                scores[target_index, observed_index - 1] + gap_observed
            )
            if diagonal >= skip_target and diagonal >= skip_observed:
                scores[target_index, observed_index] = diagonal
                trace[target_index, observed_index] = 0
            elif skip_target >= skip_observed:
                scores[target_index, observed_index] = skip_target
                trace[target_index, observed_index] = 1
            else:
                scores[target_index, observed_index] = skip_observed
                trace[target_index, observed_index] = 2

    mapping: list[int | None] = [None] * target_count
    target_index = target_count
    observed_index = observed_count
    while target_index > 0 or observed_index > 0:
        direction = trace[target_index, observed_index]
        if target_index > 0 and observed_index > 0 and direction == 0:
            similarity = _similarity(
                target[target_index - 1].value,
                observed[observed_index - 1].value,
            )
            if similarity > 0:
                mapping[target_index - 1] = observed_index - 1
            target_index -= 1
            observed_index -= 1
        elif target_index > 0 and (observed_index == 0 or direction == 1):
            target_index -= 1
        else:
            observed_index -= 1
    return mapping


def _leading_repetition_start_hints(
    target: list[LexicalUnit],
    observed: list[TimedLexicalUnit],
    mapping: list[int | None],
) -> dict[int, float]:
    """Locate a phrase entrance hidden behind long repeated lead words.

    Singing ASR may emit ``you, you, you were`` while the supplied lyric row
    begins ``you were``.  The lexical DP quite reasonably attaches the lyric's
    first ``you`` to the earliest observation, even when the performance uses
    the earlier copies as a call or melisma and the phrase itself begins at
    the copy immediately before ``were``.  Use only the strongly constrained
    form: every skipped observation repeats the first target unit, the last
    copy touches the second target unit, and the alternative is at least
    2.5 seconds later.  Short ordinary repetitions deliberately keep their
    original mapping.
    """

    hints: dict[int, float] = {}
    for index in range(len(target) - 1):
        first = target[index]
        second = target[index + 1]
        if (
            first.part_index != 0
            or first.part_count < 2
            or second.source_index != first.source_index
            or second.part_index != 1
        ):
            continue
        first_observed = mapping[index]
        second_observed = mapping[index + 1]
        if (
            first_observed is None
            or second_observed is None
            or second_observed <= first_observed + 1
        ):
            continue
        skipped = observed[first_observed + 1 : second_observed]
        if (
            not skipped
            or any(item.value != first.value for item in skipped)
        ):
            continue
        candidate = skipped[-1]
        if (
            candidate.start
            < observed[first_observed].start + 2.5
            or candidate.end + 0.35 < observed[second_observed].start
        ):
            continue
        hints[first.source_index] = candidate.start
    return hints


def _unclaimed_prefix_start_hints(
    lines: list[TranscriptLine],
    segments: list[TimedASRSegment],
    mappings: list[tuple[int, int, int, int, bool]],
) -> dict[int, float]:
    """Attach contiguous skipped ASR segments to a collapsed lyric prefix.

    A heavily stretched sung prefix can be transcribed as several low-
    similarity segments, followed by a clean lexical suffix.  Segment DP then
    skips the prefix and anchors the lyric several seconds late.  Recover only
    two constrained shapes: at least three known leading units are unmatched,
    or at least three internal units are collapsed between the first two
    matches.  The skipped segments must sit continuously between mappings for
    adjacent lyric rows.
    """

    hints: dict[int, float] = {}
    semantic_mappings = [
        mapping for mapping in mappings if not mapping[4]
    ]
    for previous, current in zip(
        semantic_mappings,
        semantic_mappings[1:],
    ):
        (
            _,
            previous_segment_end,
            _,
            previous_line_end,
            _,
        ) = previous
        (
            current_segment_start,
            current_segment_end,
            current_line_start,
            current_line_end,
            _,
        ) = current
        skipped_count = current_segment_start - previous_segment_end
        if (
            previous_line_end != current_line_start
            or not 1 <= skipped_count <= 3
            or previous_segment_end <= 0
            or current_line_start >= len(lines)
        ):
            continue
        skipped = segments[
            previous_segment_end:current_segment_start
        ]
        if (
            not skipped
            or skipped[0].start
            - segments[previous_segment_end - 1].end
            > 1.25
            or segments[current_segment_start].start
            - skipped[-1].end
            > 1.25
        ):
            continue

        target = lexical_units(
            [
                line.text
                for line in lines[
                    current_line_start:current_line_end
                ]
            ]
        )
        observed = _timed_units(
            [
                word
                for segment in segments[
                    current_segment_start:current_segment_end
                ]
                for word in segment.words
            ]
        )
        mapping = align_lexical_units(target, observed)
        first_line_matches = sorted(
            (
                (target_unit, observed[observed_index])
                for target_unit, observed_index in zip(
                    target,
                    mapping,
                    strict=True,
                )
                if (
                    target_unit.source_index == 0
                    and observed_index is not None
                )
            ),
            key=lambda item: item[0].part_index,
        )
        total_units = len(lexical_values(lines[current_line_start].text))
        if (
            not first_line_matches
            or len(first_line_matches) / max(1, total_units) > 0.72
        ):
            continue
        first_target, first_observed = first_line_matches[0]
        missing_leading_prefix = first_target.part_index >= 3
        collapsed_internal_prefix = False
        if len(first_line_matches) >= 2:
            second_target, second_observed = first_line_matches[1]
            collapsed_internal_prefix = (
                first_target.part_index == 0
                and second_target.part_index >= 4
                and second_observed.start - first_observed.start
                <= 1.25
            )
        if not (
            missing_leading_prefix or collapsed_internal_prefix
        ):
            continue
        hints[current_line_start] = skipped[0].start
    return hints


def _unclaimed_trailing_span_start_hints(
    lines: list[TranscriptLine],
    segments: list[TimedASRSegment],
    mappings: list[tuple[int, int, int, int, bool]],
) -> dict[int, float]:
    """Keep the first skipped vocal segment before a weak final mapping.

    A recognizer can miss a new sung section completely and later match its
    lyrics to a lexically similar reprise near the end of the file.  Preserve
    the earlier ASR activity as a non-destructive hint only for a short final
    span.  The finalized-anchor pass below still requires every affected row
    to have poor lexical coverage; acoustic refinement additionally requires
    a complete repeated cadence before consuming the hint.
    """

    semantic_mappings = [
        mapping for mapping in mappings if not mapping[4]
    ]
    if len(semantic_mappings) < 2:
        return {}

    previous = semantic_mappings[-2]
    current = semantic_mappings[-1]
    (
        _,
        previous_segment_end,
        _,
        previous_line_end,
        _,
    ) = previous
    (
        current_segment_start,
        _,
        current_line_start,
        current_line_end,
        _,
    ) = current
    line_count = current_line_end - current_line_start
    skipped_count = current_segment_start - previous_segment_end
    if (
        current_line_end != len(lines)
        or previous_line_end != current_line_start
        or not 4 <= line_count <= 6
        or not 1 <= skipped_count <= min(3, line_count - 1)
        or previous_segment_end <= 0
        or current_segment_start >= len(segments)
    ):
        return {}

    skipped = segments[previous_segment_end:current_segment_start]
    first = skipped[0]
    previous_end = segments[previous_segment_end - 1].end
    mapped_start = segments[current_segment_start].start
    if (
        first.end - first.start < 0.4
        or first.start - previous_end < 1.5
        or mapped_start - first.start < 4.0
        or not any(lexical_values(segment.text) for segment in skipped)
    ):
        return {}
    return {current_line_start: first.start}


def _isolated_exact_prefix_boundary_hints(
    lines: list[TranscriptLine],
    segments: list[TimedASRSegment],
    mappings: list[tuple[int, int, int, int, bool]],
) -> dict[int, tuple[float, float, int]]:
    """Recover a short exact lyric prefix split off by a sparse pause.

    A stretched first word can become its own ASR segment while the rest of
    the lyric row begins several seconds later.  The normal segment DP must
    keep a tight grouping window, so it skips that isolated word and anchors
    the whole row to the suffix.  Extend the row boundary only when all
    lexical evidence is exact: one or two skipped units are precisely the
    missing prefix and the mapped segments are precisely the complete suffix.
    Requiring a five-unit lyric row keeps isolated short calls and repeated
    one-word responses out of this repair.
    """

    hints: dict[int, tuple[float, float, int]] = {}
    semantic_mappings = [
        mapping for mapping in mappings if not mapping[4]
    ]
    for previous, current in zip(
        semantic_mappings,
        semantic_mappings[1:],
    ):
        (
            _,
            previous_segment_end,
            _,
            previous_line_end,
            _,
        ) = previous
        (
            current_segment_start,
            current_segment_end,
            current_line_start,
            current_line_end,
            _,
        ) = current
        skipped_count = current_segment_start - previous_segment_end
        if (
            previous_line_end != current_line_start
            or current_line_end != current_line_start + 1
            or not 1 <= skipped_count <= 2
            or previous_segment_end <= 0
            or current_line_start >= len(lines)
        ):
            continue

        target_values = lexical_values(lines[current_line_start].text)
        observed_values = [
            value
            for segment in segments[
                current_segment_start:current_segment_end
            ]
            for value in lexical_values(segment.text)
        ]
        missing_prefix_units = len(target_values) - len(observed_values)
        if (
            len(target_values) < 5
            or missing_prefix_units not in {1, 2}
            or observed_values
            != target_values[missing_prefix_units:]
        ):
            continue

        skipped = segments[
            previous_segment_end:current_segment_start
        ]
        skipped_values = [
            value
            for segment in skipped
            for value in lexical_values(segment.text)
        ]
        if skipped_values != target_values[:missing_prefix_units]:
            continue

        internal_gap = segments[current_segment_start].start - skipped[-1].end
        prefix_to_suffix_span = (
            segments[current_segment_start].start - skipped[0].start
        )
        if (
            not 1.5 < internal_gap <= 4.5
            or not 2.5 <= prefix_to_suffix_span <= 6.0
        ):
            continue
        hints[current_line_start] = (
            skipped[0].start,
            segments[current_segment_end - 1].end,
            missing_prefix_units,
        )
    return hints


def _finalize_matches(
    lines: list[TranscriptLine],
    matches_by_line: list[list[tuple[LexicalUnit, TimedLexicalUnit]]],
    audio_duration: float,
) -> list[CoarseLineAnchor]:
    raw_starts: list[float | None] = []
    raw_ends: list[float | None] = []
    match_counts: list[int] = []
    values_by_line = [lexical_values(line.text) for line in lines]
    totals = [len(values) for values in values_by_line]
    confidences: list[float] = []
    start_uncertainties: list[float] = []
    leading_unmatched_units: list[int] = []
    stretched_second_start_hints: list[float | None] = [
        None for _ in lines
    ]
    for line_index, (total, matched) in enumerate(
        zip(totals, matches_by_line, strict=True)
    ):
        match_counts.append(len(matched))
        if not matched:
            raw_starts.append(None)
            raw_ends.append(None)
            confidences.append(0.0)
            start_uncertainties.append(3.0)
            leading_unmatched_units.append(total)
            continue
        first_target, first_observed = min(
            matched, key=lambda item: item[0].part_index
        )
        leading_unmatched_units.append(first_target.part_index)
        # When recognition missed the first known word, estimate its small
        # lead-in from the median duration of matched lexical units.
        unit_durations = sorted(
            max(0.04, item.end - item.start) for _, item in matched
        )
        typical_duration = unit_durations[
            max(0, (len(unit_durations) - 1) // 4)
        ]
        typical_duration = min(0.75, typical_duration)
        missed_leading_duration = min(
            1.25,
            first_target.part_index * typical_duration,
        )
        estimated_start = first_observed.start - min(
            1.25,
            first_target.part_index * typical_duration,
        )
        first_duration = max(
            0.0,
            first_observed.end - first_observed.start,
        )
        standalone_repeated_boundary = (
            total == 1
            and line_index > 0
            and line_index + 1 < len(lines)
            and values_by_line[line_index]
            and values_by_line[line_index - 1]
            and values_by_line[line_index][0]
            == values_by_line[line_index - 1][-1]
            and values_by_line[line_index - 1]
            != values_by_line[line_index]
            and (
                not values_by_line[line_index + 1]
                or values_by_line[line_index + 1][0]
                != values_by_line[line_index][0]
            )
        )
        stretched_first = (
            (total > 1 or standalone_repeated_boundary)
            and first_duration
            > max(1.35, 2.4 * typical_duration)
        )
        normal_limit = max(0.75, 2.4 * typical_duration)
        second_match = next(
            (
                item
                for item in matched
                if item[0].part_index == 1
            ),
            None,
        )
        later_normal_matches = [
            item
            for item in matched
            if (
                item[0].part_index >= 2
                and item[1].end - item[1].start <= normal_limit
            )
        ]
        later_probabilities = sorted(
            item.probability for _, item in later_normal_matches
        )
        stretched_second = (
            total >= 4
            and first_target.part_index == 0
            and second_match is not None
            and second_match[1].word_index != first_observed.word_index
            and second_match[1].end - second_match[1].start
            > max(1.35, 2.4 * typical_duration)
            and first_duration > 1.15 * typical_duration
            and len(later_normal_matches) >= 3
            and later_probabilities
            and first_observed.probability + 0.12
            <= later_probabilities[len(later_probabilities) // 2]
        )
        robust_spread = 0.0
        if stretched_first or stretched_second:
            # Whisper often stretches the first recognized word backwards
            # across a long musical rest. Later normal-duration words still
            # carry a reliable local cadence, so project their starts back to
            # the lyric entrance. This is especially important for sparse
            # sung lines such as "And I still cry": the raw first-word span
            # can begin five seconds before the voice actually enters.
            #
            # The same timestamp failure can land on the second word after a
            # short, low-confidence hallucinated pickup. In that shape both
            # opening durations are inflated, while at least three later
            # high-confidence words agree on a much later cadence. A genuine
            # sustained second word keeps its reliable first-word boundary and
            # deliberately does not enter this repair.
            projected = sorted(
                item.start
                - target_unit.part_index * typical_duration
                for target_unit, item in matched
                if item.end - item.start <= normal_limit
            )
            if not projected:
                projected = sorted(
                    item.end
                    - typical_duration
                    - target_unit.part_index * typical_duration
                    for target_unit, item in matched
                )
            if projected:
                lower_index = round((len(projected) - 1) * 0.25)
                upper_index = round((len(projected) - 1) * 0.75)
                robust_start = projected[lower_index]
                robust_spread = max(
                    0.0,
                    projected[upper_index] - robust_start,
                )
                minimum_shift = (
                    0.2 if stretched_first else 1.25
                )
                if robust_start > estimated_start + minimum_shift:
                    if stretched_first:
                        estimated_start = robust_start
                    else:
                        # Keep this as a non-destructive alternative. Repeat
                        # and bridge repair may already recover the row more
                        # accurately; the acoustic stage consumes the later
                        # hint only if those structural paths leave the anchor
                        # lexical.
                        stretched_second_start_hints[line_index] = (
                            robust_start
                        )
        raw_starts.append(max(0.0, estimated_start))
        raw_ends.append(max(item.end for _, item in matched))
        coverage = len(matched) / max(1, total)
        probability = sum(item.probability for _, item in matched) / len(matched)
        confidences.append(min(1.0, coverage * 0.7 + probability * 0.3))
        raw_uncertainty = (
            max(
                0.0,
                first_observed.end
                - first_observed.start
                - typical_duration,
            )
            + missed_leading_duration
        )
        start_uncertainties.append(
            (
                max(0.25, min(raw_uncertainty, 0.35 + robust_spread))
                if stretched_first
                else raw_uncertainty
            )
        )

    # A recognizer often emits only part of a consecutive repeated refrain.
    # Token-level global alignment may then place the surviving occurrences on
    # arbitrary copies of the identical target line. Preserve the observed
    # chronological starts, attach them to the earliest copies, and let the
    # following interpolation stage fill only the missing tail occurrences.
    signatures = [" ".join(lexical_values(line.text)) for line in lines]
    run_start = 0
    while run_start < len(lines):
        run_end = run_start + 1
        while (
            run_end < len(lines)
            and signatures[run_end]
            and signatures[run_end] == signatures[run_start]
        ):
            run_end += 1
        if run_end - run_start >= 2:
            occurrences = sorted(
                (
                    (
                        float(raw_starts[index]),
                        float(raw_ends[index]),
                        match_counts[index],
                        confidences[index],
                        start_uncertainties[index],
                        leading_unmatched_units[index],
                        stretched_second_start_hints[index],
                    )
                    for index in range(run_start, run_end)
                    if raw_starts[index] is not None
                ),
                key=lambda item: item[0],
            )
            for index in range(run_start, run_end):
                raw_starts[index] = None
                raw_ends[index] = None
                match_counts[index] = 0
                confidences[index] = 0.0
                start_uncertainties[index] = 3.0
                leading_unmatched_units[index] = totals[index]
                stretched_second_start_hints[index] = None
            for offset, occurrence in enumerate(occurrences):
                index = run_start + offset
                (
                    raw_starts[index],
                    raw_ends[index],
                    match_counts[index],
                    confidences[index],
                    start_uncertainties[index],
                    leading_unmatched_units[index],
                    stretched_second_start_hints[index],
                ) = occurrence
        run_start = run_end

    anchored = [index for index, value in enumerate(raw_starts) if value is not None]
    if not anchored:
        step = audio_duration / max(1, len(lines))
        raw_starts = [index * step for index in range(len(lines))]
        raw_ends = [min(audio_duration, (index + 1) * step) for index in range(len(lines))]
    else:
        first = anchored[0]
        if first > 0:
            first_time = float(raw_starts[first])
            for index in range(first):
                raw_starts[index] = first_time * index / first
                raw_ends[index] = raw_starts[index]
        for left, right in zip(anchored, anchored[1:]):
            if right - left <= 1:
                continue
            left_time = float(raw_starts[left])
            right_time = float(raw_starts[right])
            for index in range(left + 1, right):
                fraction = (index - left) / (right - left)
                raw_starts[index] = left_time + (right_time - left_time) * fraction
                raw_ends[index] = raw_starts[index]
        last = anchored[-1]
        if last < len(lines) - 1:
            last_time = float(raw_starts[last])
            remaining = len(lines) - 1 - last
            for index in range(last + 1, len(lines)):
                fraction = (index - last) / max(1, remaining)
                raw_starts[index] = last_time + (
                    audio_duration - last_time
                ) * fraction
                raw_ends[index] = raw_starts[index]

    anchors: list[CoarseLineAnchor] = []
    for index, line in enumerate(lines):
        start = min(audio_duration, max(0.0, float(raw_starts[index])))
        end = min(
            audio_duration,
            max(start, float(raw_ends[index] if raw_ends[index] is not None else start)),
        )
        anchors.append(
            CoarseLineAnchor(
                line_index=line.index,
                start=start,
                end=end,
                matched_units=match_counts[index],
                total_units=totals[index],
                confidence=confidences[index],
                interpolated=match_counts[index] == 0,
                method=(
                    "interpolated"
                    if match_counts[index] == 0
                    else "lexical"
                ),
                start_uncertainty=start_uncertainties[index],
                leading_unmatched_units=leading_unmatched_units[index],
                stretched_second_start_hint=(
                    stretched_second_start_hints[index]
                ),
            )
        )
    return anchors


def coarse_line_anchors(
    lines: list[TranscriptLine],
    words: list[TimedASRWord],
    *,
    audio_duration: float,
) -> list[CoarseLineAnchor]:
    target = lexical_units([line.text for line in lines])
    observed = _timed_units(words)
    mapping = align_lexical_units(target, observed)

    matches_by_line: list[list[tuple[LexicalUnit, TimedLexicalUnit]]] = [
        [] for _ in lines
    ]
    for target_unit, observed_index in zip(target, mapping, strict=True):
        if observed_index is not None:
            matches_by_line[target_unit.source_index].append(
                (target_unit, observed[observed_index])
            )
    return _finalize_matches(lines, matches_by_line, audio_duration)


def _exact_sequence_matches(left: list[str], right: list[str]) -> int:
    return sum(
        block.size
        for block in SequenceMatcher(
            None,
            left,
            right,
            autojunk=False,
        ).get_matching_blocks()
    )


def _segment_match_score(
    target_values: list[str],
    observed_values: list[str],
) -> float:
    if not target_values or not observed_values:
        return -1000.0
    matches = _exact_sequence_matches(target_values, observed_values)
    minimum = min(len(target_values), len(observed_values))
    if matches < max(1, round(minimum * 0.2)):
        return -4.0
    missing_target = len(target_values) - matches
    extra_observed = len(observed_values) - matches
    return matches * 1.6 - missing_target * 0.38 - extra_observed * 0.42


def align_asr_segments_to_lines(
    lines: list[TranscriptLine],
    segments: list[TimedASRSegment],
    *,
    audio_duration: float,
    max_lines_per_segment: int = 10,
    max_segments_per_match: int = 3,
    max_segment_gap_seconds: float = 1.5,
) -> list[tuple[int, int, int, int, bool]]:
    """Map contiguous ASR segment groups to contiguous lyric-line groups.

    Singing recognizers commonly split one long lyric row into two or three
    adjacent segments. Treating every segment as consuming at least one lyric
    row discards the first half and makes the line start several seconds late.
    The final boolean marks conservative one-to-one structural gap fills.
    """

    line_values = [lexical_values(line.text) for line in lines]
    segment_values = [lexical_values(segment.text) for segment in segments]
    line_count = len(lines)
    segment_count = len(segments)
    negative_infinity = np.float32(-1e30)
    scores = np.full(
        (line_count + 1, segment_count + 1),
        negative_infinity,
        dtype=np.float32,
    )
    traces: list[list[tuple[str, int, int] | None]] = [
        [None] * (segment_count + 1) for _ in range(line_count + 1)
    ]
    scores[0, 0] = 0.0

    def update(
        next_line: int,
        next_segment: int,
        score: float,
        action: tuple[str, int, int],
    ) -> None:
        if score > float(scores[next_line, next_segment]) + 1e-6:
            scores[next_line, next_segment] = score
            traces[next_line][next_segment] = action

    for line_index in range(line_count + 1):
        for segment_index in range(segment_count + 1):
            current = float(scores[line_index, segment_index])
            if current <= -1e20:
                continue
            if line_index < line_count:
                line_gap = -0.72 - 0.035 * len(line_values[line_index])
                update(
                    line_index + 1,
                    segment_index,
                    current + line_gap,
                    ("skip_line", 1, 0),
                )
            if segment_index < segment_count:
                segment_gap = -0.9 - 0.025 * len(
                    segment_values[segment_index]
                )
                update(
                    line_index,
                    segment_index + 1,
                    current + segment_gap,
                    ("skip_segment", 0, 1),
                )

                observed_combined: list[str] = []
                maximum_segments = min(
                    max_segments_per_match,
                    segment_count - segment_index,
                )
                for consumed_segments in range(1, maximum_segments + 1):
                    current_segment = segment_index + consumed_segments - 1
                    if (
                        consumed_segments > 1
                        and segments[current_segment].start
                        - segments[current_segment - 1].end
                        > max_segment_gap_seconds
                    ):
                        break
                    observed_combined.extend(
                        segment_values[current_segment]
                    )
                    target_combined: list[str] = []
                    maximum_lines = min(
                        max_lines_per_segment,
                        line_count - line_index,
                    )
                    for consumed_lines in range(1, maximum_lines + 1):
                        target_combined.extend(
                            line_values[line_index + consumed_lines - 1]
                        )
                        match_score = _segment_match_score(
                            target_combined,
                            observed_combined,
                        )
                        line_progress = (
                            (line_index + consumed_lines / 2)
                            / max(1, line_count)
                        )
                        time_progress = (
                            segments[segment_index].start
                            / max(0.001, audio_duration)
                        )
                        progress_penalty = 0.45 * abs(
                            line_progress - time_progress
                        )
                        grouping_penalty = 0.12 * (
                            consumed_segments - 1
                        )
                        update(
                            line_index + consumed_lines,
                            segment_index + consumed_segments,
                            current
                            + match_score
                            - progress_penalty
                            - grouping_penalty,
                            (
                                "match",
                                consumed_lines,
                                consumed_segments,
                            ),
                        )

    mappings: list[tuple[int, int, int, int, bool]] = []
    line_index = line_count
    segment_index = segment_count
    while line_index > 0 or segment_index > 0:
        action = traces[line_index][segment_index]
        if action is None:
            break
        kind, consumed_lines, consumed_segments = action
        if kind == "match":
            start_line = line_index - consumed_lines
            start_segment = segment_index - consumed_segments
            mappings.append(
                (
                    start_segment,
                    segment_index,
                    start_line,
                    line_index,
                    False,
                )
            )
            line_index = start_line
            segment_index = start_segment
        elif kind == "skip_line":
            line_index -= 1
        else:
            segment_index -= 1
    mappings.reverse()

    # When exactly the same small number of ASR segments and lyric rows were
    # skipped between two confident mappings, chronology itself is strong
    # evidence. Pair them one-to-one so a badly recognized line is anchored
    # to its real vocal segment instead of being spread across an instrumental
    # gap by interpolation.
    structural: list[tuple[int, int, int, int, bool]] = []
    for previous, following in zip(mappings, mappings[1:]):
        segment_gap = following[0] - previous[1]
        line_gap = following[2] - previous[3]
        if not (1 <= segment_gap == line_gap <= 3):
            continue
        structural.extend(
            (
                previous[1] + offset,
                previous[1] + offset + 1,
                previous[3] + offset,
                previous[3] + offset + 1,
                True,
            )
            for offset in range(segment_gap)
        )
    return sorted(
        mappings + structural,
        key=lambda item: (item[2], item[0]),
    )


def coarse_line_anchors_from_segments(
    lines: list[TranscriptLine],
    segments: list[TimedASRSegment],
    *,
    audio_duration: float,
) -> list[CoarseLineAnchor]:
    """Create line anchors while keeping each ASR segment locally contiguous."""

    matches_by_line: list[list[tuple[LexicalUnit, TimedLexicalUnit]]] = [
        [] for _ in lines
    ]
    mappings = align_asr_segments_to_lines(
        lines,
        segments,
        audio_duration=audio_duration,
    )
    structural_fallbacks: dict[int, tuple[float, float]] = {}
    boundary_hints: dict[int, tuple[float, float]] = {}
    leading_repetition_hints: dict[int, float] = {}
    unclaimed_prefix_hints = _unclaimed_prefix_start_hints(
        lines,
        segments,
        mappings,
    )
    # Kept for offline experiments only.  The frozen English validation and
    # Pink Floyd sealed set did not confirm a general full-song improvement,
    # so the default v49 pipeline must not consume these hints.
    unclaimed_trailing_span_hints: dict[int, float] = {}
    isolated_prefix_boundary_hints = (
        _isolated_exact_prefix_boundary_hints(
            lines,
            segments,
            mappings,
        )
    )
    for (
        start_segment,
        end_segment,
        start_line,
        end_line,
        structural_only,
    ) in mappings:
        mapped_segments = segments[start_segment:end_segment]
        target = lexical_units(
            [line.text for line in lines[start_line:end_line]]
        )
        observed = _timed_units(
            [
                word
                for segment in mapped_segments
                for word in segment.words
            ]
        )
        mapping = align_lexical_units(target, observed)
        for local_line_index, start in _leading_repetition_start_hints(
            target,
            observed,
            mapping,
        ).items():
            global_line_index = start_line + local_line_index
            leading_repetition_hints[global_line_index] = max(
                start,
                leading_repetition_hints.get(
                    global_line_index,
                    -float("inf"),
                ),
            )
        for target_unit, observed_index in zip(target, mapping, strict=True):
            if observed_index is None:
                continue
            global_line_index = start_line + target_unit.source_index
            global_unit = LexicalUnit(
                value=target_unit.value,
                source_index=global_line_index,
                part_index=target_unit.part_index,
                part_count=target_unit.part_count,
            )
            matches_by_line[global_line_index].append(
                (global_unit, observed[observed_index])
            )
        if end_line - start_line == 1:
            boundary_hints[start_line] = (
                mapped_segments[0].start,
                mapped_segments[-1].end,
            )
            if structural_only:
                structural_fallbacks[start_line] = (
                    mapped_segments[0].start,
                    mapped_segments[-1].end,
                )

    anchors = _finalize_matches(lines, matches_by_line, audio_duration)
    for line_index, start in unclaimed_prefix_hints.items():
        anchor = anchors[line_index]
        coverage = anchor.matched_units / max(1, anchor.total_units)
        if (
            not anchor.interpolated
            and coverage <= 0.72
            and start >= 0.0
            and start <= anchor.start - 2.5
            and start < anchor.end
        ):
            anchors[line_index] = replace(
                anchor,
                # Preserve the lexical anchor until all existing repeat and
                # fragment repairs have run.  The acoustic stage consumes
                # this non-destructive hint at the end of structural repair.
                acoustic_start_hint=start,
            )
    for line_index, start in unclaimed_trailing_span_hints.items():
        anchor = anchors[line_index]
        previous = anchors[line_index - 1]
        trailing = anchors[line_index:]

        def weak_coverage(candidate: CoarseLineAnchor) -> bool:
            coverage = candidate.matched_units / max(
                1,
                candidate.total_units,
            )
            return (
                candidate.interpolated
                or (
                    coverage <= 0.5
                    and candidate.confidence <= 0.6
                )
            )

        previous_coverage = previous.matched_units / max(
            1,
            previous.total_units,
        )
        if (
            all(weak_coverage(candidate) for candidate in trailing)
            and not previous.interpolated
            and previous.confidence >= 0.65
            and previous_coverage >= 0.65
            and start >= previous.end + 1.0
            and start <= anchor.start - 4.0
        ):
            anchors[line_index] = replace(
                anchor,
                acoustic_start_hint=start,
            )
    for (
        line_index,
        (start, end, missing_prefix_units),
    ) in isolated_prefix_boundary_hints.items():
        anchor = anchors[line_index]
        if (
            not anchor.interpolated
            and anchor.method == "lexical"
            and anchor.leading_unmatched_units == missing_prefix_units
            and anchor.matched_units + missing_prefix_units
            == anchor.total_units
            and start + 2.5 <= anchor.start
            and start < anchor.end
        ):
            anchors[line_index] = replace(
                anchor,
                start=max(0.0, start),
                end=max(end, anchor.end),
                method="lexical_segment_start",
                start_uncertainty=max(
                    anchor.start_uncertainty,
                    anchor.start - start,
                ),
            )
    for line_index, start in leading_repetition_hints.items():
        anchor = anchors[line_index]
        if (
            not anchor.interpolated
            and start >= anchor.start + 2.5
            and start < anchor.end
        ):
            anchors[line_index] = replace(
                anchor,
                start=max(0.0, start),
                method="lexical_repeated_leading",
                start_uncertainty=max(
                    0.5,
                    anchor.start_uncertainty,
                ),
            )
    for line_index, (start, end) in boundary_hints.items():
        anchor = anchors[line_index]
        if (
            not anchor.interpolated
            and anchor.leading_unmatched_units > 0
            and start + 0.05 < anchor.start
        ):
            anchors[line_index] = replace(
                anchor,
                start=max(0.0, start),
                end=max(end, anchor.end),
                method="lexical_segment_start",
                start_uncertainty=max(
                    anchor.start_uncertainty,
                    anchor.start - start,
                ),
            )
    for line_index, (start, end) in structural_fallbacks.items():
        anchor = anchors[line_index]
        if anchor.interpolated:
            anchors[line_index] = replace(
                anchor,
                start=max(0.0, start),
                end=max(start, end),
                confidence=0.18,
                interpolated=False,
                method="segment_structure",
                start_uncertainty=max(0.6, end - start),
            )
    return anchors
