from __future__ import annotations

import math
from collections import Counter
from dataclasses import replace
from statistics import median

from .asr_matching import (
    CoarseLineAnchor,
    TimedASRSegment,
)
from .lexical import lexical_values, primary_lexical_values
from .types import TranscriptLine

_MIN_REPEAT_LINES = 3
_RELIABLE_CONFIDENCE = 0.4


def _weak(anchor: CoarseLineAnchor) -> bool:
    return anchor.interpolated or anchor.confidence < _RELIABLE_CONFIDENCE


def _signatures(lines: list[TranscriptLine]) -> list[str]:
    return [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]


def refine_consecutive_refrains(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    *,
    minimum: int = 3,
) -> list[CoarseLineAnchor]:
    """Extend a stable cadence across missing or misassigned repetitions."""

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    signatures = _signatures(lines)
    refined = list(anchors)
    cadence_by_signature: dict[str, list[float]] = {}
    for index in range(len(lines) - 1):
        if (
            not signatures[index]
            or signatures[index] != signatures[index + 1]
            or anchors[index].interpolated
            or anchors[index + 1].interpolated
            or anchors[index].confidence < 0.7
            or anchors[index + 1].confidence < 0.7
        ):
            continue
        difference = anchors[index + 1].start - anchors[index].start
        if 0.35 <= difference <= 8.0:
            cadence_by_signature.setdefault(
                signatures[index],
                [],
            ).append(difference)
    run_start = 0
    while run_start < len(lines):
        run_end = run_start + 1
        while (
            run_end < len(lines)
            and signatures[run_start]
            and signatures[run_end] == signatures[run_start]
        ):
            run_end += 1
        if run_end - run_start < minimum:
            run_start = run_end
            continue

        reliable = [
            index
            for index in range(run_start, run_end)
            if (
                not anchors[index].interpolated
                and anchors[index].confidence >= 0.7
            )
        ]
        if not reliable:
            run_start = run_end
            continue
        local_steps = [
            (
                anchors[right].start - anchors[left].start
            )
            / (right - left)
            for left, right in zip(reliable, reliable[1:])
            if anchors[right].start > anchors[left].start
        ]
        step_source = (
            local_steps
            if len(local_steps) >= 2
            else cadence_by_signature.get(signatures[run_start], [])
        )
        if not step_source:
            run_start = run_end
            continue
        step = float(median(step_source))
        if not 0.35 <= step <= 8.0:
            run_start = run_end
            continue
        consistent = [
            value
            for value in step_source
            if abs(value - step) <= max(0.35, step * 0.35)
        ]
        if len(consistent) < (2 if len(local_steps) >= 2 else 1):
            run_start = run_end
            continue
        step = float(median(consistent))
        raw_origins = [
            anchors[index].start - (index - run_start) * step
            for index in reliable
        ]
        origin_center = float(median(raw_origins))
        origins = [
            value
            for value in raw_origins
            if abs(value - origin_center) <= max(0.5, step * 0.5)
        ]
        if not origins:
            run_start = run_end
            continue
        origin = float(median(origins))
        tolerance = max(0.8, step * 0.75)
        for index in range(run_start, run_end):
            predicted = origin + (index - run_start) * step
            anchor = refined[index]
            if (
                not anchor.interpolated
                and anchor.confidence >= 0.7
                and abs(anchor.start - predicted) <= tolerance
            ):
                continue
            if abs(anchor.start - predicted) <= 0.08:
                continue
            refined[index] = replace(
                anchor,
                start=max(0.0, predicted),
                end=max(predicted, predicted + min(step, 1.0)),
                confidence=0.38,
                interpolated=False,
                method="repeat_cadence",
                start_uncertainty=(
                    0.35
                    if len(local_steps) >= 2
                    else max(2.0, anchor.start_uncertainty)
                ),
            )
        run_start = run_end
    return refined


def repeated_blocks(
    lines: list[TranscriptLine],
    *,
    minimum: int = _MIN_REPEAT_LINES,
) -> list[tuple[int, int, int]]:
    """Return maximal, non-overlapping exact repeated lyric sections."""

    signatures = _signatures(lines)
    blocks: list[tuple[int, int, int]] = []
    for left in range(len(signatures)):
        for right in range(left + minimum, len(signatures)):
            if not signatures[left] or signatures[left] != signatures[right]:
                continue
            # A matching predecessor means this is a suffix of a block that
            # has already been discovered.
            if (
                left > 0
                and right > 0
                and signatures[left - 1] == signatures[right - 1]
            ):
                continue
            length = 0
            while (
                right + length < len(signatures)
                and signatures[left + length]
                and signatures[left + length]
                == signatures[right + length]
            ):
                length += 1
            if length >= minimum:
                blocks.append((left, right, length))
    return sorted(blocks, key=lambda block: (-block[2], block[0], block[1]))


def _repeat_offset(
    anchors: list[CoarseLineAnchor],
    left: int,
    right: int,
    length: int,
) -> float | None:
    differences = [
        anchors[right + offset].start - anchors[left + offset].start
        for offset in range(length)
        if not _weak(anchors[left + offset])
        and not _weak(anchors[right + offset])
    ]
    if len(differences) < 2:
        return None
    center = median(differences)
    consistent = [
        difference
        for difference in differences
        if abs(difference - center) <= 1.5
    ]
    if len(consistent) < 2:
        return None
    return float(median(consistent))


def _transfer_reliable_repeat_anchors(
    anchors: list[CoarseLineAnchor],
    left: int,
    right: int,
    length: int,
    offset: float,
) -> None:
    proposals: dict[int, tuple[float, float]] = {}
    for position in range(length):
        left_index = left + position
        right_index = right + position
        first = anchors[left_index]
        second = anchors[right_index]
        if _weak(first) and not _weak(second):
            start = second.start - offset
            proposals[left_index] = (
                max(0.0, start),
                max(start, second.end - offset),
            )
        elif _weak(second) and not _weak(first):
            start = first.start + offset
            proposals[right_index] = (
                start,
                max(start, first.end + offset),
            )
    for index in sorted(proposals):
        start, end = proposals[index]
        previous = (
            proposals[index - 1][0]
            if index - 1 in proposals
            else (anchors[index - 1].start if index else 0.0)
        )
        following = (
            proposals[index + 1][0]
            if index + 1 in proposals
            else (
                anchors[index + 1].start
                if index + 1 < len(anchors)
                else math.inf
            )
        )
        if previous - 0.05 <= start <= following + 0.05:
            anchors[index] = replace(
                anchors[index],
                start=start,
                end=end,
                confidence=0.36,
                interpolated=False,
                method="repeat_transfer",
            )


def _weak_pair_ranges(
    original: list[CoarseLineAnchor],
    left: int,
    right: int,
    length: int,
) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    position = 0
    while position < length:
        if not (
            _weak(original[left + position])
            and _weak(original[right + position])
        ):
            position += 1
            continue
        start = position
        while (
            position < length
            and _weak(original[left + position])
            and _weak(original[right + position])
        ):
            position += 1
        if position - start >= 2:
            ranges.append((start, position))
    return ranges


def _language_activity(
    segments: list[TimedASRSegment],
    lower: float,
    upper: float,
) -> list[tuple[float, float, int]]:
    intervals = sorted(
        (
            max(lower, segment.start),
            min(upper, segment.end),
        )
        for segment in segments
        if segment.end > lower and segment.start < upper
    )
    clusters: list[list[float | int]] = []
    for start, end in intervals:
        if end <= start:
            continue
        if clusters and start - clusters[-1][1] <= 3.5:
            clusters[-1][1] = max(clusters[-1][1], end)
            clusters[-1][2] = int(clusters[-1][2]) + 1
        else:
            clusters.append([start, end, 1])
    return [
        (float(start), float(end), int(count))
        for start, end, count in clusters
    ]


def _select_activity_cluster(
    segments_by_language: dict[str, list[TimedASRSegment]],
    lower: float,
    upper: float,
    line_count: int,
    prefer_upper: bool = False,
) -> tuple[float, float, str] | None:
    candidates: list[tuple[float, float, float, str]] = []
    for language, segments in segments_by_language.items():
        for start, end, segment_count in _language_activity(
            segments,
            lower,
            upper,
        ):
            duration = end - start
            if duration < max(1.5, line_count * 0.75):
                continue
            score = (
                abs(segment_count - line_count)
                + 0.015 * max(0.0, start - lower)
                + 0.01
                * max(0.0, duration - max(6.0, line_count * 4.0))
                + (
                    0.08 * max(0.0, upper - end)
                    if prefer_upper
                    else 0.0
                )
            )
            candidates.append((score, start, end, language))
    if not candidates:
        return None
    _, start, end, language = min(candidates)
    return start, end, language


def _boundary_candidates(
    segments_by_language: dict[str, list[TimedASRSegment]],
    cluster: tuple[float, float, str],
) -> list[tuple[float, float]]:
    lower, upper, language = cluster
    raw: list[tuple[float, float]] = []
    for segment in segments_by_language[language]:
        if not (lower - 0.05 <= segment.start <= upper + 0.05):
            continue
        raw.append((segment.start, 0.0))
        previous = segment.start
        for word in segment.words:
            if (
                word.start <= upper + 0.05
                and word.start - segment.start > 0.35
                and word.start - previous >= 0.48
            ):
                raw.append((word.start, 0.6))
            previous = word.start
    raw.sort()
    merged: list[tuple[float, float]] = []
    for start, penalty in raw:
        if merged and start - merged[-1][0] < 0.12:
            if penalty < merged[-1][1]:
                merged[-1] = (start, penalty)
        else:
            merged.append((start, penalty))
    return merged


def _expected_starts(
    lines: list[TranscriptLine],
    cluster: tuple[float, float, str],
) -> list[float]:
    weights = [
        max(1.0, math.sqrt(max(1, len(lexical_values(line.text)))))
        for line in lines
    ]
    total = sum(weights)
    duration = cluster[1] - cluster[0]
    elapsed = 0.0
    starts: list[float] = []
    for weight in weights:
        starts.append(cluster[0] + duration * elapsed / total)
        elapsed += weight
    return starts


def _bounded_span_weak(anchor: CoarseLineAnchor) -> bool:
    if (
        not anchor.interpolated
        and anchor.confidence >= 0.4
        and anchor.method.startswith("acoustic_")
    ):
        return False
    coverage = anchor.matched_units / max(1, anchor.total_units)
    return (
        anchor.interpolated
        or anchor.method
        in {
            "interpolated",
            "interpolated_rebased",
            "monotonic_repair",
            "overlap_repair",
            "segment_structure",
        }
        or (coverage <= 0.45 and anchor.confidence <= 0.6)
    )


def _bounded_span_boundary(anchor: CoarseLineAnchor) -> bool:
    coverage = anchor.matched_units / max(1, anchor.total_units)
    return (
        not anchor.interpolated
        and (
            (anchor.confidence >= 0.55 and coverage >= 0.5)
            or (
                anchor.confidence >= 0.4
                and anchor.method.startswith("acoustic_")
            )
        )
        and anchor.method
        not in {
            "interpolated_rebased",
            "monotonic_repair",
            "overlap_repair",
            "segment_structure",
        }
    )


def _collapsed_span_weak(anchor: CoarseLineAnchor) -> bool:
    coverage = anchor.matched_units / max(1, anchor.total_units)
    return (
        anchor.interpolated
        or anchor.method == "monotonic_repair"
        or (anchor.confidence <= 0.45 and coverage <= 0.5)
    )


_REFRAIN_LEAD_INS = frozenset(
    {"ah", "ay", "ayy", "bitch", "hey", "oh", "ooh", "uh", "yeah"}
)


def _dense_refrain_motif(line: TranscriptLine) -> tuple[str, ...]:
    values = list(primary_lexical_values(line.text))
    while len(values) > 1 and values[0] in _REFRAIN_LEAD_INS:
        values.pop(0)
    while len(values) > 1 and values[-1] in _REFRAIN_LEAD_INS:
        values.pop()
    if not 1 <= len(values) <= 3:
        return ()
    return tuple(values)


def _dense_refrain_runs(
    lines: list[TranscriptLine],
) -> list[tuple[int, int]]:
    motifs = [_dense_refrain_motif(line) for line in lines]
    runs: list[tuple[int, int]] = []
    start = 0
    while start < len(lines):
        if not motifs[start]:
            start += 1
            continue
        counts: Counter[tuple[str, ...]] = Counter()
        best_end = start
        end = start
        while end < len(lines) and motifs[end]:
            counts[motifs[end]] += 1
            if len(counts) > 3:
                break
            length = end - start + 1
            repeated = sum(value for value in counts.values() if value >= 2)
            if (
                length >= 5
                and max(counts.values()) >= 3
                and repeated >= math.ceil(0.8 * length)
            ):
                best_end = end + 1
            end += 1
        if best_end > start:
            selected_start = start
            selected_end = best_end
            selected_counts = Counter(motifs[selected_start:selected_end])
            stable_motifs = {
                motif
                for motif, count in selected_counts.items()
                if count >= 2
            }
            chunks: list[tuple[int, int]] = []
            chunk_start = selected_start
            while chunk_start < selected_end:
                while (
                    chunk_start < selected_end
                    and motifs[chunk_start] not in stable_motifs
                ):
                    chunk_start += 1
                chunk_end = chunk_start
                while (
                    chunk_end < selected_end
                    and motifs[chunk_end] in stable_motifs
                ):
                    chunk_end += 1
                if chunk_end > chunk_start:
                    chunks.append((chunk_start, chunk_end))
                chunk_start = chunk_end + 1
            if chunks:
                selected_start, selected_end = max(
                    chunks,
                    key=lambda chunk: chunk[1] - chunk[0],
                )
            if selected_end - selected_start >= 5:
                runs.append((selected_start, selected_end))
            start = best_end
        else:
            start += 1
    return runs


def _dense_refrain_observed_units(
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[tuple[str, float, float]]:
    units: list[tuple[str, float, float]] = []
    words = sorted(
        (
            word
            for segments in segments_by_language.values()
            for segment in segments
            for word in segment.words
        ),
        key=lambda word: (word.start, word.end),
    )
    for word in words:
        values = lexical_values(word.text)
        duration = max(0.0, word.end - word.start)
        for index, value in enumerate(values):
            units.append(
                (
                    value,
                    word.start + duration * index / len(values),
                    word.start + duration * (index + 1) / len(values),
                )
            )
    return units


def _dense_refrain_candidates(
    line: TranscriptLine,
    observed: list[tuple[str, float, float]],
    lower: float,
    upper: float,
) -> list[tuple[float, int, int]]:
    motif = _dense_refrain_motif(line)
    primary = tuple(primary_lexical_values(line.text))
    motif_start = 0
    while (
        motif_start < len(primary) - 1
        and primary[motif_start] in _REFRAIN_LEAD_INS
    ):
        motif_start += 1
    stripped_lead = primary[:motif_start]
    candidates: list[tuple[float, int, int]] = []
    for start in range(len(observed) - len(motif) + 1):
        if tuple(
            observed[index][0]
            for index in range(start, start + len(motif))
        ) != motif:
            continue
        candidate_start = observed[start][1]
        observed_start = start
        if (
            stripped_lead
            and start
            and observed[start - 1][0] == stripped_lead[-1]
            and observed[start][1] - observed[start - 1][2] <= 0.35
        ):
            candidate_start = observed[start - 1][1]
            observed_start -= 1
        if lower - 0.5 <= candidate_start <= upper + 0.1:
            candidates.append(
                (
                    candidate_start,
                    observed_start,
                    start + len(motif),
                )
            )
    deduplicated: list[tuple[float, int, int]] = []
    for candidate in candidates:
        if deduplicated and candidate[0] - deduplicated[-1][0] < 0.12:
            continue
        deduplicated.append(candidate)
    return deduplicated


def _select_dense_refrain_path(
    lines: list[TranscriptLine],
    candidates_by_line: list[list[tuple[float, int, int]]],
    lower: float,
    upper: float,
) -> list[float] | None:
    if any(not candidates for candidates in candidates_by_line):
        return None
    expected = _expected_starts(lines, (lower, upper, "English"))
    scores = [
        [float("inf")] * len(candidates)
        for candidates in candidates_by_line
    ]
    traces = [
        [-1] * len(candidates)
        for candidates in candidates_by_line
    ]
    for index, candidate in enumerate(candidates_by_line[0]):
        scores[0][index] = 0.12 * abs(candidate[0] - expected[0])
    for line_index in range(1, len(lines)):
        expected_gap = expected[line_index] - expected[line_index - 1]
        for candidate_index, candidate in enumerate(
            candidates_by_line[line_index]
        ):
            local = 0.12 * abs(candidate[0] - expected[line_index])
            for previous_index, previous in enumerate(
                candidates_by_line[line_index - 1]
            ):
                if (
                    previous[2] > candidate[1]
                    or candidate[0] - previous[0] < 0.12
                ):
                    continue
                score = (
                    scores[line_index - 1][previous_index]
                    + local
                    + 0.08
                    * abs((candidate[0] - previous[0]) - expected_gap)
                )
                if score < scores[line_index][candidate_index]:
                    scores[line_index][candidate_index] = score
                    traces[line_index][candidate_index] = previous_index
    final_index = min(
        range(len(scores[-1])),
        key=scores[-1].__getitem__,
    )
    if not math.isfinite(scores[-1][final_index]):
        return None
    selected: list[float] = []
    candidate_index = final_index
    for line_index in range(len(lines) - 1, -1, -1):
        selected.append(candidates_by_line[line_index][candidate_index][0])
        candidate_index = traces[line_index][candidate_index]
    selected.reverse()
    if (
        selected[-1] < upper - 4.0
        or selected[-1] - selected[0] < 0.6 * (upper - lower)
    ):
        return None
    return selected


def _select_dense_refrain_lattice(
    lines: list[TranscriptLine],
    candidates_by_line: list[list[tuple[float, int, int]]],
    lower: float,
    upper: float,
) -> list[float] | None:
    """Infer at most a few missed occurrences in one repeated short motif.

    Whisper sometimes merges or omits one occurrence in a long run of the
    same one-to-three-word refrain.  Requiring one lexical hit per lyric row
    then discards an otherwise very strong periodic sequence.  This fallback
    fits a cadence only when at least 60% of seven or more rows have exact,
    non-overlapping ASR hits, including support near both ends of the run.
    """

    count = len(lines)
    motifs = {_dense_refrain_motif(line) for line in lines}
    if count < 7 or len(motifs) != 1 or () in motifs:
        return None

    required_support = max(5, math.ceil(0.6 * count))
    hypotheses: list[
        tuple[
            tuple[float, float, float],
            list[float],
            list[tuple[float, int, int] | None],
        ]
    ] = []
    for left_slot in range(count - 1):
        for right_slot in range(left_slot + 3, count):
            for left in candidates_by_line[left_slot]:
                for right in candidates_by_line[right_slot]:
                    if left[2] > right[1] or right[0] <= left[0]:
                        continue
                    step = (right[0] - left[0]) / (
                        right_slot - left_slot
                    )
                    if not 0.35 <= step <= 8.0:
                        continue
                    origin = left[0] - left_slot * step
                    predicted = [
                        origin + slot * step for slot in range(count)
                    ]
                    if (
                        predicted[0] < lower - 0.5
                        or predicted[-1] > upper + 0.1
                    ):
                        continue

                    tolerance = max(0.12, min(0.9, step * 0.18))
                    assignments: list[
                        tuple[float, int, int] | None
                    ] = []
                    residuals: list[float] = []
                    previous_end = -1
                    for expected, candidates in zip(
                        predicted,
                        candidates_by_line,
                        strict=True,
                    ):
                        options = [
                            (abs(candidate[0] - expected), candidate)
                            for candidate in candidates
                            if (
                                candidate[1] >= previous_end
                                and abs(candidate[0] - expected)
                                <= tolerance
                            )
                        ]
                        if not options:
                            assignments.append(None)
                            continue
                        residual, candidate = min(options)
                        assignments.append(candidate)
                        residuals.append(residual)
                        previous_end = candidate[2]

                    if (
                        len(residuals) < required_support
                        or not any(assignments[:2])
                        or not any(assignments[-2:])
                        or median(residuals) > 0.35
                    ):
                        continue
                    score = (
                        -float(len(residuals)),
                        float(median(residuals)),
                        float(sum(residuals)),
                    )
                    hypotheses.append((score, predicted, assignments))

    if not hypotheses:
        return None
    _, predicted, assignments = min(hypotheses, key=lambda item: item[0])
    return [
        candidate[0] if candidate is not None else expected
        for expected, candidate in zip(
            predicted,
            assignments,
            strict=True,
        )
    ]


_VOCALIZATION_BASES = (
    "whoa",
    "yeah",
    "aah",
    "hmm",
    "mmm",
    "ooh",
    "ah",
    "eh",
    "hey",
    "hm",
    "mm",
    "oh",
    "uh",
)


def _vocalization_base(value: str) -> str | None:
    for base in _VOCALIZATION_BASES:
        if value == base:
            return base
        suffix = value[len(base) :] if value.startswith(base) else ""
        if suffix and set(suffix) == {base[-1]}:
            return base
    return None


def _line_vocalization_base(line: TranscriptLine) -> str | None:
    values = primary_lexical_values(line.text)
    bases = {_vocalization_base(value) for value in values}
    if len(values) < 2 or len(bases) != 1 or None in bases:
        return None
    return next(iter(bases))


def _repair_vocalization_sequences(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Map a bounded multi-line vocalization run to ASR phrase entrances."""

    refined = list(anchors)
    start = 0
    while start < len(lines):
        base = _line_vocalization_base(lines[start])
        if base is None:
            start += 1
            continue
        end = start + 1
        while (
            end < len(lines)
            and _line_vocalization_base(lines[end]) == base
        ):
            end += 1
        count = end - start
        if not 4 <= count <= 8:
            start = end
            continue

        lower = anchors[start].start - 1.2
        upper = anchors[end - 1].start + 2.5
        raw: list[tuple[float, float, bool]] = []
        for segment in segments_by_language.get("English", []):
            values = lexical_values(segment.text)
            if (
                not values
                or segment.end < lower
                or segment.start > upper
                or any(
                    _vocalization_base(value) != base
                    for value in values
                )
            ):
                continue
            raw.append((segment.start, 0.0, True))
            previous = segment.start
            for word in segment.words[1:]:
                word_values = lexical_values(word.text)
                if (
                    word_values
                    and all(
                        _vocalization_base(value) == base
                        for value in word_values
                    )
                    and word.start - segment.start >= 1.0
                    and word.start - previous >= 0.8
                ):
                    raw.append((word.start, 0.55, False))
                previous = word.start
        raw.sort()
        candidates: list[tuple[float, float, bool]] = []
        for candidate in raw:
            if candidates and candidate[0] - candidates[-1][0] < 0.12:
                if candidate[1] < candidates[-1][1]:
                    candidates[-1] = candidate
            else:
                candidates.append(candidate)
        segment_candidates = [
            candidate for candidate in candidates if candidate[2]
        ]
        if (
            len(candidates) < count
            or len(segment_candidates) < count - 1
            or not segment_candidates
            or abs(segment_candidates[0][0] - anchors[start].start) > 1.2
            or abs(segment_candidates[-1][0] - anchors[end - 1].start)
            > 1.2
        ):
            start = end
            continue

        first = segment_candidates[0][0]
        last = segment_candidates[-1][0]
        weights = [
            max(
                1.0,
                math.sqrt(
                    len(primary_lexical_values(line.text))
                ),
            )
            for line in lines[start:end]
        ]
        denominator = sum(weights[:-1])
        elapsed = 0.0
        expected: list[float] = []
        for index, weight in enumerate(weights):
            expected.append(
                last
                if index == count - 1
                else first + (last - first) * elapsed / denominator
            )
            elapsed += weight

        scores = [
            [float("inf")] * len(candidates)
            for _ in range(count)
        ]
        traces = [
            [-1] * len(candidates)
            for _ in range(count)
        ]
        for candidate_index, candidate in enumerate(candidates):
            if abs(candidate[0] - anchors[start].start) <= 1.2:
                scores[0][candidate_index] = (
                    candidate[1]
                    + 0.08 * abs(candidate[0] - expected[0])
                )
        for line_index in range(1, count):
            expected_gap = expected[line_index] - expected[line_index - 1]
            for candidate_index, candidate in enumerate(candidates):
                local = (
                    candidate[1]
                    + 0.08
                    * abs(candidate[0] - expected[line_index])
                )
                for previous_index, previous in enumerate(candidates):
                    if previous[0] >= candidate[0] - 0.12:
                        continue
                    score = (
                        scores[line_index - 1][previous_index]
                        + local
                        + 0.04
                        * abs(
                            (candidate[0] - previous[0])
                            - expected_gap
                        )
                    )
                    if score < scores[line_index][candidate_index]:
                        scores[line_index][candidate_index] = score
                        traces[line_index][candidate_index] = previous_index
        final_candidates = [
            index
            for index, candidate in enumerate(candidates)
            if (
                math.isfinite(scores[-1][index])
                and abs(candidate[0] - anchors[end - 1].start) <= 1.2
            )
        ]
        if not final_candidates:
            start = end
            continue
        candidate_index = min(
            final_candidates,
            key=scores[-1].__getitem__,
        )
        proposed: list[float] = []
        for line_index in range(count - 1, -1, -1):
            proposed.append(candidates[candidate_index][0])
            candidate_index = traces[line_index][candidate_index]
        proposed.reverse()
        movements = [
            abs(candidate - anchor.start)
            for candidate, anchor in zip(
                proposed,
                anchors[start:end],
                strict=True,
            )
        ]
        if sum(movement >= 2.0 for movement in movements[1:-1]) < 2:
            start = end
            continue
        for offset, candidate in enumerate(proposed):
            line_index = start + offset
            anchor = anchors[line_index]
            if (
                offset in {0, count - 1}
                and anchor.method.startswith("acoustic_")
                and anchor.confidence >= 0.65
                and abs(candidate - anchor.start) <= 1.2
            ):
                continue
            next_start = (
                proposed[offset + 1]
                if offset + 1 < count
                else max(candidate, anchor.end)
            )
            refined[line_index] = replace(
                anchor,
                start=candidate,
                end=max(candidate, min(next_start, anchor.end)),
                confidence=max(0.5, anchor.confidence),
                interpolated=False,
                method="asr_vocalization_sequence",
                start_uncertainty=0.35,
            )
        start = end
    return refined


def _segment_matches_repeated_phrase(
    signature: tuple[str, ...],
    segment: TimedASRSegment,
) -> bool:
    observed = tuple(primary_lexical_values(segment.text))
    if (
        len(signature) < 4
        or not observed
        or observed[0] != signature[0]
    ):
        return False
    common = sum(
        (Counter(signature) & Counter(observed)).values()
    )
    return common / len(signature) >= 0.65


def _repair_anchored_repeated_phrase_gap(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Insert one ASR-omitted phrase after two locked repetitions."""

    refined = list(anchors)
    signatures = [
        tuple(primary_lexical_values(line.text)) for line in lines
    ]
    start = 0
    while start < len(lines):
        signature = signatures[start]
        end = start + 1
        while end < len(lines) and signatures[end] == signature:
            end += 1
        count = end - start
        if (
            not 5 <= count <= 9
            or len(signature) < 4
            or end >= len(anchors)
            or not _bounded_span_boundary(anchors[start])
            or not _bounded_span_boundary(anchors[start + 1])
        ):
            start = end
            continue
        lower = anchors[start].start - 0.5
        upper = anchors[end].start - 0.1
        candidates = sorted(
            {
                segment.start
                for segment in segments_by_language.get("English", [])
                if (
                    lower <= segment.start <= upper
                    and _segment_matches_repeated_phrase(
                        signature,
                        segment,
                    )
                )
            }
        )
        if (
            len(candidates) != count - 1
            or abs(candidates[0] - anchors[start].start) > 0.35
            or abs(candidates[1] - anchors[start + 1].start) > 0.35
            or len(candidates) < 4
        ):
            start = end
            continue
        stable_step = candidates[-1] - candidates[-2]
        doubled_gap = candidates[2] - candidates[1]
        if (
            not 0.5 <= stable_step <= 8.0
            or abs(doubled_gap - 2.0 * stable_step)
            > max(0.4, 0.22 * stable_step)
        ):
            start = end
            continue
        inferred = candidates[2] - stable_step
        proposed = [
            candidates[0],
            candidates[1],
            inferred,
            *candidates[2:],
        ]
        if (
            len(proposed) != count
            or proposed[-1] >= anchors[end].start - 0.12
            or any(
                right - left < 0.12
                for left, right in zip(proposed, proposed[1:])
            )
            or sum(
                abs(candidate - anchor.start) >= 1.0
                for candidate, anchor in zip(
                    proposed[2:],
                    anchors[start + 2 : end],
                    strict=True,
                )
            )
            < 2
        ):
            start = end
            continue
        for offset, candidate in enumerate(proposed[2:], 2):
            line_index = start + offset
            next_start = (
                proposed[offset + 1]
                if offset + 1 < count
                else anchors[end].start
            )
            anchor = anchors[line_index]
            refined[line_index] = replace(
                anchor,
                start=candidate,
                end=max(candidate, min(next_start, anchor.end)),
                confidence=0.56,
                interpolated=False,
                method="asr_repeated_phrase_gap",
                start_uncertainty=0.3,
            )
        start = end
    return refined


def _long_identical_phrase_runs(
    lines: list[TranscriptLine],
    *,
    minimum: int = 8,
) -> list[tuple[int, int, tuple[str, ...]]]:
    signatures = [
        tuple(primary_lexical_values(line.text)) for line in lines
    ]
    runs: list[tuple[int, int, tuple[str, ...]]] = []
    start = 0
    while start < len(lines):
        signature = signatures[start]
        end = start + 1
        while end < len(lines) and signatures[end] == signature:
            end += 1
        if end - start >= minimum and len(signature) >= 3:
            runs.append((start, end, signature))
        start = end
    return runs


def _long_phrase_prefix_candidates(
    signature: tuple[str, ...],
    segments_by_language: dict[str, list[TimedASRSegment]],
    lower: float,
    upper: float,
) -> list[float]:
    observed = _dense_refrain_observed_units(segments_by_language)
    prefix = signature[: min(3, len(signature))]
    candidates: list[float] = []
    for index in range(len(observed) - len(prefix) + 1):
        if tuple(
            unit[0] for unit in observed[index : index + len(prefix)]
        ) != prefix:
            continue
        start = observed[index][1]
        if lower <= start <= upper:
            candidates.append(start)
    deduplicated: list[float] = []
    for candidate in candidates:
        if deduplicated and candidate - deduplicated[-1] < 0.12:
            continue
        deduplicated.append(candidate)
    return deduplicated


def _fit_long_repeated_cadence(
    anchors: list[CoarseLineAnchor],
    candidates: list[float],
) -> list[float] | None:
    count = len(anchors)
    initial_step = anchors[1].start - anchors[0].start
    if not 0.6 <= initial_step <= 8.0:
        return None
    tolerance = max(0.5, 0.35 * initial_step)
    by_slot: dict[int, tuple[float, float]] = {}
    for candidate in candidates:
        slot = round((candidate - anchors[0].start) / initial_step)
        if not 0 <= slot < count:
            continue
        residual = abs(
            candidate - (anchors[0].start + slot * initial_step)
        )
        if residual > tolerance:
            continue
        if slot not in by_slot or residual < by_slot[slot][0]:
            by_slot[slot] = (residual, candidate)
    if (
        0 not in by_slot
        or 1 not in by_slot
        or len(by_slot) < 4
        or max(by_slot) < math.ceil(0.7 * (count - 1))
    ):
        return None

    slots = sorted(by_slot)
    times = [by_slot[slot][1] for slot in slots]
    slot_mean = sum(slots) / len(slots)
    time_mean = sum(times) / len(times)
    denominator = sum((slot - slot_mean) ** 2 for slot in slots)
    if denominator <= 0.0:
        return None
    step = sum(
        (slot - slot_mean) * (time - time_mean)
        for slot, time in zip(slots, times, strict=True)
    ) / denominator
    origin = time_mean - step * slot_mean
    residuals = [
        abs(time - (origin + step * slot))
        for slot, time in zip(slots, times, strict=True)
    ]
    if (
        not 0.6 <= step <= 8.0
        or abs(step - initial_step) > max(0.25, 0.2 * initial_step)
        or abs(origin - anchors[0].start) > 0.6
        or abs(origin + step - anchors[1].start) > 0.6
        or median(residuals) > max(0.2, 0.12 * step)
        or max(residuals) > max(0.45, 0.2 * step)
    ):
        return None
    return [origin + step * slot for slot in range(count)]


def _repair_long_repeated_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Rebuild a long repeated phrase only after a catastrophic collapse."""

    refined = list(anchors)
    for start, end, signature in _long_identical_phrase_runs(lines):
        current = anchors[start:end]
        if (
            len(current) < 8
            or not _bounded_span_boundary(current[0])
            or not _bounded_span_boundary(current[1])
        ):
            continue
        collapsed_pairs = sum(
            following.start <= previous.start + 0.01
            for previous, following in zip(current, current[1:])
        )
        if collapsed_pairs < max(3, len(current) // 4):
            continue
        lower = current[0].start - 0.8
        following = anchors[end] if end < len(anchors) else None
        observed_end = max(
            (
                segment.end
                for segments in segments_by_language.values()
                for segment in segments
            ),
            default=current[-1].end,
        )
        upper = (
            following.start - 0.12
            if following is not None
            else max(observed_end, current[-1].end)
        )
        candidates = _long_phrase_prefix_candidates(
            signature,
            segments_by_language,
            lower,
            upper,
        )
        proposed = _fit_long_repeated_cadence(current, candidates)
        if proposed is None:
            continue
        if (
            proposed[-1] > upper
            or any(
                right - left < 0.5
                for left, right in zip(proposed, proposed[1:])
            )
            or sum(
                abs(candidate - anchor.start) >= 2.0
                for candidate, anchor in zip(
                    proposed[2:],
                    current[2:],
                    strict=True,
                )
            )
            < max(3, len(current) // 3)
        ):
            continue
        for offset, proposed_start in enumerate(proposed[2:], 2):
            line_index = start + offset
            next_start = (
                proposed[offset + 1]
                if offset + 1 < len(proposed)
                else (
                    following.start
                    if following is not None
                    else max(proposed_start, anchors[line_index].end)
                )
            )
            anchor = anchors[line_index]
            refined[line_index] = replace(
                anchor,
                start=proposed_start,
                end=max(
                    proposed_start,
                    min(next_start, anchor.end),
                ),
                confidence=max(0.52, anchor.confidence),
                interpolated=False,
                method="asr_long_repeated_cadence",
                start_uncertainty=0.35,
            )
    return refined


def refine_long_repeated_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Apply the v53 long-repeat cadence candidate reference-blind."""

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    if set(segments_by_language) != {"English"}:
        return list(anchors)
    if any(
        line.detected_language not in {None, "English"}
        for line in lines
    ):
        return list(anchors)
    return _repair_long_repeated_cadence(
        lines,
        anchors,
        segments_by_language,
    )


def _repair_dense_exact_refrain_paths(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Use exact ASR phrase occurrences for a dense repeated refrain."""

    observed = _dense_refrain_observed_units(segments_by_language)
    if not observed:
        return list(anchors)
    refined = list(anchors)
    for start, end in _dense_refrain_runs(lines):
        previous = anchors[start - 1] if start else None
        following = anchors[end] if end < len(anchors) else None
        if previous is not None and not _bounded_span_boundary(previous):
            continue
        if following is not None and not _bounded_span_boundary(following):
            continue
        lower = (
            max(previous.start, min(previous.end, anchors[start].start)) - 0.5
            if previous is not None
            else 0.0
        )
        upper = (
            following.start
            if following is not None
            else max(unit[2] for unit in observed)
        )
        if upper - lower < 0.7 * (end - start):
            continue
        candidates_by_line = [
            _dense_refrain_candidates(line, observed, lower, upper)
            for line in lines[start:end]
        ]
        proposed = _select_dense_refrain_path(
            lines[start:end],
            candidates_by_line,
            lower,
            upper,
        )
        if proposed is None:
            proposed = _select_dense_refrain_lattice(
                lines[start:end],
                candidates_by_line,
                lower,
                upper,
            )
        if proposed is None:
            continue
        if min(
            abs(proposed[0] - anchors[start].start),
            abs(proposed[-1] - anchors[end - 1].start),
        ) > 1.2:
            continue
        movement = [
            abs(candidate - anchor.start)
            for candidate, anchor in zip(
                proposed,
                anchors[start:end],
                strict=True,
            )
        ]
        if sum(value >= 0.5 for value in movement) < 3:
            continue
        for offset, candidate in enumerate(proposed):
            line_index = start + offset
            next_start = (
                proposed[offset + 1]
                if offset + 1 < len(proposed)
                else upper
            )
            anchor = anchors[line_index]
            if (
                offset in {0, len(proposed) - 1}
                and anchor.method.startswith("acoustic_")
                and anchor.confidence >= 0.65
                and abs(candidate - anchor.start) <= 1.2
            ):
                continue
            refined[line_index] = replace(
                anchor,
                start=candidate,
                end=max(candidate, min(next_start, anchor.end)),
                confidence=max(0.62, anchor.confidence),
                interpolated=False,
                method="asr_dense_exact_refrain",
                start_uncertainty=0.2,
            )
    return refined


def _repair_repeated_short_boundary_spans(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> list[CoarseLineAnchor]:
    """Recover a collapsed long span after two short repeated calls."""

    segments = sorted(
        (
            segment
            for language_segments in segments_by_language.values()
            for segment in language_segments
        ),
        key=lambda segment: segment.start,
    )
    signatures = _signatures(lines)
    refined = list(anchors)
    for first in range(len(lines) - 6):
        second = first + 1
        signature = signatures[first]
        if (
            not signature
            or signature != signatures[second]
            or len(primary_lexical_values(lines[first].text)) > 2
            or anchors[first].interpolated
            or anchors[first].confidence < 0.35
            or not _collapsed_span_weak(anchors[second])
            or anchors[second].start - anchors[first].start > 1.6
        ):
            continue
        end = second
        while end < len(anchors) and _collapsed_span_weak(anchors[end]):
            end += 1
        if end - second < 5 or end >= len(anchors):
            continue
        following = anchors[end]
        if not _bounded_span_boundary(following):
            continue
        current_starts = [anchor.start for anchor in anchors[second:end]]
        nonmonotonic = any(
            right + 0.01 < left
            for left, right in zip(current_starts, current_starts[1:])
        )

        asr_pairs: list[tuple[float, float]] = []
        for first_segment in segments:
            if abs(first_segment.start - anchors[first].start) > 1.0:
                continue
            segment_signature = tuple(lexical_values(first_segment.text))
            if not segment_signature or len(segment_signature) > 3:
                continue
            for second_segment in segments:
                if (
                    second_segment.start < first_segment.start + 2.0
                    or second_segment.start > first_segment.start + 10.0
                    or second_segment.start > following.start - 1.0
                    or tuple(lexical_values(second_segment.text))
                    != segment_signature
                ):
                    continue
                asr_pairs.append(
                    (first_segment.start, second_segment.start)
                )
        if not asr_pairs:
            continue
        _, recovered_start = min(
            asr_pairs,
            key=lambda pair: (
                abs(pair[0] - anchors[first].start),
                pair[1],
            ),
        )
        available = following.start - recovered_start
        current_range = max(current_starts) - min(current_starts)
        if (
            recovered_start < anchors[second].start + 2.0
            or available < 0.45 * (end - second)
            or (
                not nonmonotonic
                and current_range >= 0.6 * available
            )
        ):
            continue
        proposed = _expected_starts(
            lines[second:end],
            (recovered_start, following.start, "English"),
        )
        if (
            proposed[-1] > following.start - 0.18
            or median(
                start - anchor.start
                for start, anchor in zip(
                    proposed,
                    anchors[second:end],
                    strict=True,
                )
            )
            < 2.0
        ):
            continue
        for offset, start in enumerate(proposed):
            line_index = second + offset
            next_start = (
                proposed[offset + 1]
                if offset + 1 < len(proposed)
                else following.start
            )
            anchor = anchors[line_index]
            refined[line_index] = replace(
                anchor,
                start=start,
                end=max(start, min(next_start, start + 1.0)),
                confidence=0.32,
                interpolated=False,
                method="asr_repeated_short_boundary_span",
                start_uncertainty=0.5,
            )
    return refined


def _zero_coverage_acoustic_anchor(anchor: CoarseLineAnchor) -> bool:
    return (
        anchor.total_units > 0
        and anchor.matched_units == 0
        and anchor.confidence <= 0.45
        and anchor.method.startswith("acoustic_")
        and anchor.end - anchor.start <= 0.15
    )


def _inside_neighbor_interval(
    anchors: list[CoarseLineAnchor],
    index: int,
    proposed: float,
) -> bool:
    return (
        0 < index < len(anchors) - 1
        and anchors[index - 1].start + 0.18
        <= proposed
        <= anchors[index + 1].start - 0.18
    )


def _repair_zero_coverage_repeat_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Transfer a robust repeated-block offset to one unsupported outlier.

    A zero-duration acoustic fallback can land on an instrumental hit when a
    repeated lyric line is absent from ASR.  Two other matched positions in
    the repeated block establish the inter-performance offset.  If both
    copies of the missing line are unsupported, only the direction whose
    proposal fits strictly between its local neighbours is accepted.
    """

    proposals: dict[int, list[float]] = {}
    for left, right, length in repeated_blocks(lines):
        offset = _repeat_offset(anchors, left, right, length)
        if offset is None:
            continue
        for position in range(length):
            left_index = left + position
            right_index = right + position
            if (
                left_index == 0
                or right_index == 0
                or left_index + 1 >= len(anchors)
                or right_index + 1 >= len(anchors)
            ):
                continue
            first = anchors[left_index]
            second = anchors[right_index]
            if abs((second.start - first.start) - offset) < 2.0:
                continue
            first_unsupported = _zero_coverage_acoustic_anchor(first)
            second_unsupported = _zero_coverage_acoustic_anchor(second)
            if not (first_unsupported or second_unsupported):
                continue
            options: list[tuple[int, float]] = []
            proposed_second = first.start + offset
            if second_unsupported and _inside_neighbor_interval(
                anchors,
                right_index,
                proposed_second,
            ):
                options.append((right_index, proposed_second))
            proposed_first = second.start - offset
            if first_unsupported and _inside_neighbor_interval(
                anchors,
                left_index,
                proposed_first,
            ):
                options.append((left_index, proposed_first))
            if first_unsupported and second_unsupported and len(options) != 1:
                continue
            for index, proposed in options:
                proposals.setdefault(index, []).append(proposed)

    refined = list(anchors)
    for index, candidates in proposals.items():
        if max(candidates) - min(candidates) > 0.75:
            continue
        proposed = float(median(candidates))
        anchor = anchors[index]
        if (
            abs(proposed - anchor.start) < 2.0
            or not _inside_neighbor_interval(anchors, index, proposed)
        ):
            continue
        refined[index] = replace(
            anchor,
            start=proposed,
            end=max(proposed, min(anchors[index + 1].start, proposed + 1.0)),
            confidence=0.36,
            interpolated=False,
            method="repeat_offset_outlier",
            start_uncertainty=0.6,
        )
    return refined


def _repeat_shape_reliable(anchor: CoarseLineAnchor) -> bool:
    return (
        not _collapsed_span_weak(anchor)
        and anchor.method
        not in {
            "interpolated_rebased",
            "monotonic_repair",
            "overlap_repair",
            "segment_structure",
        }
    )


def _repair_repeated_edge_consensus(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Restore one collapsed repeat from two independent intact copies.

    A repeated section may retain only its first or last row while every
    interior row collapses onto an earlier ASR phrase.  One intact copy is
    not enough evidence because performances can change tempo.  Proposals
    are therefore accepted only when two distinct repeated copies transfer
    the same rows within 750 ms and the whole repaired run remains bounded.
    """

    proposals: dict[int, list[tuple[float, int]]] = {}
    for left, right, length in repeated_blocks(lines, minimum=4):
        for source, target in ((left, right), (right, left)):
            source_anchors = anchors[source : source + length]
            target_anchors = anchors[target : target + length]
            source_reliable = [
                _repeat_shape_reliable(anchor)
                for anchor in source_anchors
            ]
            target_weak = [
                _collapsed_span_weak(anchor)
                for anchor in target_anchors
            ]
            target_strong = [
                position
                for position, weak in enumerate(target_weak)
                if not weak
            ]
            if (
                sum(source_reliable) < length - 1
                or len(target_strong) != 1
                or target_strong[0] not in {0, length - 1}
                or sum(target_weak) < max(3, length - 1)
            ):
                continue
            edge = target_strong[0]
            if not source_reliable[edge]:
                continue
            if any(
                right_anchor.start - left_anchor.start < 0.12
                for left_anchor, right_anchor in zip(
                    source_anchors,
                    source_anchors[1:],
                )
            ):
                continue
            offset = (
                target_anchors[edge].start
                - source_anchors[edge].start
            )
            transferred = [
                anchor.start + offset for anchor in source_anchors
            ]
            lower = (
                anchors[target - 1].start + 0.12
                if target
                else 0.0
            )
            upper = (
                anchors[target + length].start - 0.12
                if target + length < len(anchors)
                else math.inf
            )
            if (
                transferred[0] < lower
                or transferred[-1] > upper
                or any(
                    right_start - left_start < 0.12
                    for left_start, right_start in zip(
                        transferred,
                        transferred[1:],
                    )
                )
            ):
                continue
            movements = [
                transferred[position] - target_anchors[position].start
                for position in range(length)
                if target_weak[position]
            ]
            direction = 1.0 if median(movements) > 0.0 else -1.0
            if (
                median(abs(movement) for movement in movements) < 2.0
                or sum(
                    movement * direction >= 1.0
                    for movement in movements
                )
                < math.ceil(0.75 * len(movements))
            ):
                continue
            for position, weak in enumerate(target_weak):
                if weak:
                    proposals.setdefault(target + position, []).append(
                        (transferred[position], source)
                    )

    accepted: dict[int, float] = {}
    for index, candidates in proposals.items():
        if len({source for _, source in candidates}) < 2:
            continue
        values = [value for value, _ in candidates]
        if max(values) - min(values) <= 0.75:
            accepted[index] = float(median(values))

    refined = list(anchors)
    for start in sorted(accepted):
        if start - 1 in accepted:
            continue
        end = start
        while end in accepted:
            end += 1
        if end - start < 3:
            continue
        proposed = [accepted[index] for index in range(start, end)]
        previous = anchors[start - 1].start if start else -0.001
        following = (
            anchors[end].start if end < len(anchors) else math.inf
        )
        if (
            proposed[0] <= previous + 0.001
            or proposed[-1] >= following - 0.001
            or any(
                right_start - left_start < 0.12
                for left_start, right_start in zip(
                    proposed,
                    proposed[1:],
                )
            )
        ):
            continue
        for index, proposed_start in zip(
            range(start, end),
            proposed,
            strict=True,
        ):
            next_start = (
                accepted.get(index + 1, following)
            )
            anchor = anchors[index]
            refined[index] = replace(
                anchor,
                start=proposed_start,
                end=max(
                    proposed_start,
                    min(next_start, proposed_start + 1.0),
                ),
                confidence=0.38,
                interpolated=False,
                method="repeat_edge_consensus",
                start_uncertainty=0.6,
            )
    return refined


def _bounded_asr_candidates(
    segments_by_language: dict[str, list[TimedASRSegment]],
    lower: float,
    upper: float,
) -> list[tuple[float, float, bool]]:
    """Return ASR phrase/word boundaries with conservative penalties."""

    raw: list[tuple[float, float, bool]] = []
    for segments in segments_by_language.values():
        for segment in segments:
            if segment.end < lower - 0.2 or segment.start > upper + 0.2:
                continue
            if lower - 0.12 <= segment.start <= upper + 0.05:
                probability = (
                    sum(word.probability for word in segment.words)
                    / len(segment.words)
                    if segment.words
                    else 0.5
                )
                raw.append(
                    (
                        segment.start,
                        max(0.0, 0.18 * (0.65 - probability)),
                        True,
                    )
                )
            previous = segment.start
            for word in segment.words:
                if not lower - 0.12 <= word.start <= upper + 0.05:
                    previous = word.start
                    continue
                gap = word.start - previous
                if word.start - segment.start >= 0.3 and gap >= 0.32:
                    raw.append(
                        (
                            word.start,
                            0.32 + 0.3 * max(0.0, 0.5 - word.probability),
                            False,
                        )
                    )
                previous = word.start
    raw.sort(key=lambda item: (item[0], item[1], not item[2]))
    merged: list[tuple[float, float, bool]] = []
    for candidate in raw:
        if merged and candidate[0] - merged[-1][0] < 0.14:
            if (candidate[1], not candidate[2]) < (
                merged[-1][1],
                not merged[-1][2],
            ):
                merged[-1] = candidate
        else:
            merged.append(candidate)
    return merged


def _bounded_path_cost(
    starts: list[float],
    expected: list[float],
    candidates: list[tuple[float, float, bool]],
) -> float:
    cost = 0.0
    candidate_starts = [candidate[0] for candidate in candidates]
    for index, (start, target) in enumerate(zip(starts, expected, strict=True)):
        nearest = min(
            (abs(start - candidate) for candidate in candidate_starts),
            default=2.0,
        )
        cost += 0.75 * abs(start - target) + min(2.0, 1.4 * nearest)
        if index:
            observed_gap = start - starts[index - 1]
            expected_gap = expected[index] - expected[index - 1]
            cost += 0.2 * abs(observed_gap - expected_gap)
    return cost


def _select_bounded_asr_path(
    lines: list[TranscriptLine],
    current: list[CoarseLineAnchor],
    candidates: list[tuple[float, float, bool]],
    lower: float,
    upper: float,
) -> list[float] | None:
    count = len(lines)
    if len(candidates) < count:
        return None
    expected = _expected_starts(lines, (lower, upper, "English"))
    segment_candidate_count = sum(candidate[2] for candidate in candidates)
    required_segment_count = (
        segment_candidate_count
        if segment_candidate_count <= count
        else max(2, math.ceil(count / 2))
    )
    scores: list[dict[tuple[int, int], float]] = [
        {} for _ in range(count)
    ]
    traces: list[
        dict[tuple[int, int], tuple[int, int] | None]
    ] = [{} for _ in range(count)]
    for candidate_index, (start, penalty, segment_boundary) in enumerate(
        candidates
    ):
        if lower - 0.12 <= start <= upper - 0.18:
            segment_count = int(segment_boundary)
            state = (candidate_index, segment_count)
            scores[0][state] = (
                0.75 * abs(start - expected[0]) + penalty
            )
            traces[0][state] = None
    for line_index in range(1, count):
        expected_gap = expected[line_index] - expected[line_index - 1]
        for candidate_index, (
            start,
            penalty,
            segment_boundary,
        ) in enumerate(candidates):
            if not lower <= start <= upper - 0.18:
                continue
            local = 0.75 * abs(start - expected[line_index]) + penalty
            for (
                previous_index,
                previous_segment_count,
            ), previous_score in scores[line_index - 1].items():
                if previous_index >= candidate_index:
                    continue
                previous_start = candidates[previous_index][0]
                gap = start - previous_start
                if gap < 0.18:
                    continue
                segment_count = (
                    previous_segment_count + int(segment_boundary)
                )
                if segment_count > required_segment_count:
                    segment_count = required_segment_count
                score = (
                    previous_score
                    + local
                    + 0.2 * abs(gap - expected_gap)
                )
                state = (candidate_index, segment_count)
                if score < scores[line_index].get(state, float("inf")):
                    scores[line_index][state] = score
                    traces[line_index][state] = (
                        previous_index,
                        previous_segment_count,
                    )
    final_states = [
        state
        for state in scores[-1]
        if state[1] >= required_segment_count
    ]
    if not final_states:
        return None
    final_state = min(final_states, key=scores[-1].__getitem__)
    selected: list[int] = []
    state: tuple[int, int] | None = final_state
    for line_index in range(count - 1, -1, -1):
        assert state is not None
        selected.append(state[0])
        state = traces[line_index][state]
    selected.reverse()
    proposed = [candidates[index][0] for index in selected]
    current_starts = [anchor.start for anchor in current]
    current_cost = _bounded_path_cost(
        current_starts,
        expected,
        candidates,
    )
    proposed_cost = _bounded_path_cost(proposed, expected, candidates) + sum(
        candidates[index][1] for index in selected
    )
    improvement = current_cost - proposed_cost
    moved = [
        abs(start - anchor.start)
        for start, anchor in zip(proposed, current, strict=True)
    ]
    signed_movement = [
        start - anchor.start
        for start, anchor in zip(proposed, current, strict=True)
    ]
    if (
        improvement < max(1.2, 0.25 * count)
        or sum(distance >= 0.25 for distance in moved) < 2
        or max(moved, default=0.0) < 0.65
        or median(signed_movement) < 0.4
        or sum(distance >= 0.25 for distance in signed_movement)
        < math.ceil(count / 2)
    ):
        return None
    return proposed


def _repair_non_increasing_axis(
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Apply the renderer's one-millisecond ordering invariant to anchors."""

    refined = list(anchors)
    previous = -0.001
    for index, anchor in enumerate(refined):
        if anchor.start > previous + 0.0005:
            previous = anchor.start
            continue
        proposed = previous + 0.001
        refined[index] = replace(
            anchor,
            start=proposed,
            end=max(proposed, anchor.end),
            confidence=min(0.2, anchor.confidence),
            interpolated=True,
            method="strict_monotonic_axis",
            start_uncertainty=max(0.6, anchor.start_uncertainty),
        )
        previous = proposed
    return refined


def refine_supported_repeat_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Apply only the cross-family-supported v51 structural repairs.

    The broader v51 pass did not clear its unseen-artist promotion gate.  Two
    sub-rules nevertheless had independent evidence across multiple artist
    families: moving a zero-coverage repeated-line outlier from a consensus
    repeat offset, and enforcing a strictly increasing internal axis.  Keep
    this candidate English-only until its separately frozen v52 gate proves
    that the smaller evidence-supported core generalizes.
    """

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    if any(
        line.detected_language not in {None, "English"}
        for line in lines
    ):
        return list(anchors)
    refined = _repair_zero_coverage_repeat_outliers(lines, anchors)
    return _repair_non_increasing_axis(refined)


def refine_bounded_unmatched_asr_spans(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
    *,
    include_dense_exact_refrains: bool = True,
) -> list[CoarseLineAnchor]:
    """Redistribute bounded weak English rows onto observed ASR activity.

    The recognizer can hear several consecutive vocal phrases while getting
    their words wrong.  The lexical DP may then consume all lyric rows in the
    first phrase and discard the later segment boundaries.  This pass only
    touches an entirely weak 2--8 row run enclosed by reliable lexical rows,
    and atomically selects a complete monotonic ASR-boundary path.  Reference
    timestamps, artist identity and song metadata are never consulted.
    """

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    if set(segments_by_language) != {"English"}:
        return list(anchors)
    if any(
        line.detected_language not in {None, "English"}
        for line in lines
    ):
        return list(anchors)

    original = _repair_repeated_edge_consensus(lines, anchors)
    original = _repair_zero_coverage_repeat_outliers(lines, original)
    if include_dense_exact_refrains:
        original = _repair_dense_exact_refrain_paths(
            lines,
            original,
            segments_by_language,
        )
    original = _repair_vocalization_sequences(
        lines,
        original,
        segments_by_language,
    )
    original = _repair_anchored_repeated_phrase_gap(
        lines,
        original,
        segments_by_language,
    )
    original = _repair_repeated_short_boundary_spans(
        lines,
        original,
        segments_by_language,
    )
    refined = list(original)
    index = 1
    while index + 1 < len(anchors):
        if not _bounded_span_weak(original[index]):
            index += 1
            continue
        start = index
        while index < len(anchors) and _bounded_span_weak(original[index]):
            index += 1
        end = index
        count = end - start
        if (
            not 2 <= count <= 8
            or sum(anchor.interpolated for anchor in original[start:end]) < 2
            or end >= len(anchors)
            or not _bounded_span_boundary(original[start - 1])
            or not _bounded_span_boundary(original[end])
        ):
            continue
        lower = max(
            original[start - 1].start + 0.18,
            min(
                original[start - 1].end - 0.8,
                original[end].start - 0.4,
            ),
        )
        upper = original[end].start
        duration = upper - lower
        if duration < max(0.8, 0.3 * count) or duration > 9.0 * count:
            continue
        candidates = _bounded_asr_candidates(
            segments_by_language,
            lower,
            upper,
        )
        proposed = _select_bounded_asr_path(
            lines[start:end],
            original[start:end],
            candidates,
            lower,
            upper,
        )
        if proposed is None:
            continue
        for offset, proposed_start in enumerate(proposed):
            line_index = start + offset
            anchor = original[line_index]
            following_start = (
                proposed[offset + 1]
                if offset + 1 < len(proposed)
                else upper
            )
            duration_hint = min(
                max(0.25, anchor.end - anchor.start),
                max(0.25, following_start - proposed_start),
            )
            refined[line_index] = replace(
                anchor,
                start=proposed_start,
                end=min(upper, proposed_start + duration_hint),
                confidence=0.34,
                interpolated=False,
                method="asr_bounded_weak_span",
                start_uncertainty=0.35,
            )
    return _repair_non_increasing_axis(refined)


def _joint_repeat_boundaries(
    lines: list[TranscriptLine],
    first_candidates: list[tuple[float, float]],
    second_candidates: list[tuple[float, float]],
    first_cluster: tuple[float, float, str],
    second_cluster: tuple[float, float, str],
    offset: float,
) -> tuple[list[float], list[float]] | None:
    line_count = len(lines)
    if (
        len(first_candidates) < line_count
        or len(second_candidates) < line_count
    ):
        return None
    expected_first = _expected_starts(lines, first_cluster)
    expected_second = _expected_starts(lines, second_cluster)
    states = [
        (first_index, second_index)
        for first_index, first in enumerate(first_candidates)
        for second_index, second in enumerate(second_candidates)
        if abs((second[0] - first[0]) - offset) <= 3.0
    ]
    if not states:
        return None

    infinity = float("inf")
    scores = [[infinity] * len(states) for _ in range(line_count)]
    traces = [[-1] * len(states) for _ in range(line_count)]

    def state_cost(line_index: int, state_index: int) -> float:
        first_index, second_index = states[state_index]
        first = first_candidates[first_index]
        second = second_candidates[second_index]
        return (
            abs(first[0] - expected_first[line_index])
            + abs(second[0] - expected_second[line_index])
            + first[1]
            + second[1]
            + 3.0 * abs((second[0] - first[0]) - offset)
        )

    for state_index in range(len(states)):
        scores[0][state_index] = state_cost(0, state_index)
    for line_index in range(1, line_count):
        for state_index, (first_index, second_index) in enumerate(states):
            first_time = first_candidates[first_index][0]
            second_time = second_candidates[second_index][0]
            local_cost = state_cost(line_index, state_index)
            for previous_index, (
                previous_first,
                previous_second,
            ) in enumerate(states):
                if (
                    previous_first >= first_index
                    or previous_second >= second_index
                    or first_time
                    - first_candidates[previous_first][0]
                    < 0.4
                    or second_time
                    - second_candidates[previous_second][0]
                    < 0.4
                ):
                    continue
                score = scores[line_index - 1][previous_index] + local_cost
                if score < scores[line_index][state_index]:
                    scores[line_index][state_index] = score
                    traces[line_index][state_index] = previous_index

    state_index = min(
        range(len(states)),
        key=lambda index: scores[-1][index],
    )
    if not math.isfinite(scores[-1][state_index]):
        return None
    selected: list[tuple[int, int]] = []
    for line_index in range(line_count - 1, -1, -1):
        selected.append(states[state_index])
        state_index = traces[line_index][state_index]
    selected.reverse()
    return (
        [first_candidates[first][0] for first, _ in selected],
        [second_candidates[second][0] for _, second in selected],
    )


def _repair_leading_activity(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
) -> None:
    first_reliable = 0
    while first_reliable < len(anchors) and _weak(anchors[first_reliable]):
        first_reliable += 1
    if first_reliable < 2 or first_reliable >= len(anchors):
        return
    if any(
        right + length <= first_reliable
        for _, right, length in repeated_blocks(lines)
    ):
        # An exact repeated section inside a wholly unrecognized prefix has
        # stronger acoustic structure than a word-count interpolation. Leave
        # it weak so the onset stage can jointly recover both performances.
        return
    upper = anchors[first_reliable].start
    cluster = _select_activity_cluster(
        segments_by_language,
        0.0,
        max(0.0, upper - 0.05),
        first_reliable,
        prefer_upper=True,
    )
    if cluster is None or cluster[0] < 0.75:
        return
    starts = _expected_starts(
        lines[:first_reliable],
        (cluster[0], upper, cluster[2]),
    )
    for index, start in enumerate(starts):
        next_start = (
            starts[index + 1]
            if index + 1 < len(starts)
            else upper
        )
        anchors[index] = replace(
            anchors[index],
            start=start,
            end=max(start, next_start),
            confidence=0.28,
            interpolated=False,
            method="leading_activity",
        )


def refine_repeated_sections(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    segments_by_language: dict[str, list[TimedASRSegment]],
    *,
    audio_duration: float,
) -> list[CoarseLineAnchor]:
    """Repair repeated lyric sections without consulting input LRC axes.

    Reliable lexical matches establish the offset between two occurrences.
    Weak lines can then borrow a reliable counterpart or, when both copies
    are unrecognized, use paired ASR boundary sequences with the same offset.
    """

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    original = list(anchors)
    refined = list(anchors)
    _repair_leading_activity(lines, refined, segments_by_language)
    for left, right, length in repeated_blocks(lines):
        offset = _repeat_offset(original, left, right, length)
        if offset is None:
            continue
        _transfer_reliable_repeat_anchors(
            refined,
            left,
            right,
            length,
            offset,
        )
        for start, end in _weak_pair_ranges(
            original,
            left,
            right,
            length,
        ):
            first_start = left + start
            first_end = left + end
            second_start = right + start
            second_end = right + end
            first_lower = (
                refined[first_start - 1].end
                if first_start
                else 0.0
            )
            second_lower = (
                refined[second_start - 1].end
                if second_start
                else 0.0
            )
            first_upper = (
                refined[first_end].start
                if first_end < len(refined)
                else audio_duration
            )
            second_upper = (
                refined[second_end].start
                if second_end < len(refined)
                else audio_duration
            )
            count = end - start
            first_cluster = _select_activity_cluster(
                segments_by_language,
                first_lower + 0.5,
                first_upper - 0.05,
                count,
            )
            second_cluster = _select_activity_cluster(
                segments_by_language,
                second_lower + 0.5,
                second_upper - 0.05,
                count,
            )
            if first_cluster is None or second_cluster is None:
                continue
            if abs(
                (second_cluster[0] - first_cluster[0]) - offset
            ) > 3.0:
                continue
            selected = _joint_repeat_boundaries(
                lines[first_start:first_end],
                _boundary_candidates(
                    segments_by_language,
                    first_cluster,
                ),
                _boundary_candidates(
                    segments_by_language,
                    second_cluster,
                ),
                first_cluster,
                second_cluster,
                offset,
            )
            if selected is None:
                continue
            first_times, second_times = selected
            for local, start_time in enumerate(first_times):
                index = first_start + local
                refined[index] = replace(
                    refined[index],
                    start=start_time,
                    end=max(start_time, refined[index].end),
                    confidence=0.32,
                    interpolated=False,
                    method="repeated_asr_boundary",
                )
            for local, start_time in enumerate(second_times):
                index = second_start + local
                refined[index] = replace(
                    refined[index],
                    start=start_time,
                    end=max(start_time, refined[index].end),
                    confidence=0.32,
                    interpolated=False,
                    method="repeated_asr_boundary",
                )

    # Nested repeated blocks can touch the same area. Preserve chronological
    # order even when a weaker nested repair disagrees by a few milliseconds.
    previous = 0.0
    for index, anchor in enumerate(refined):
        if anchor.start < previous:
            refined[index] = replace(
                anchor,
                start=previous,
                end=max(previous, anchor.end),
                confidence=min(anchor.confidence, 0.2),
                interpolated=True,
                method="monotonic_repair",
            )
        previous = refined[index].start
    return refined
