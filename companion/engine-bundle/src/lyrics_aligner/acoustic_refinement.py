from __future__ import annotations

import math
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from itertools import product
from pathlib import Path
from statistics import median

import numpy as np
import soundfile

from .asr_matching import CoarseLineAnchor
from .lexical import lexical_values, primary_lexical_values
from .types import TranscriptLine
from .verified_refinement import repair_verified_structural_outliers

_LATIN_LANGUAGES = frozenset(
    {
        "English",
        "French",
        "German",
        "Italian",
        "Portuguese",
        "Spanish",
    }
)
_STRUCTURAL_METHODS = frozenset(
    {
        "acoustic_gap_cluster",
        "acoustic_gap_cluster_rebased",
        "acoustic_gap_vocalization",
        "acoustic_alternating_repeat_cadence",
        "acoustic_balanced_identical_repeat",
        "acoustic_balanced_opening_repeat",
        "acoustic_bounded_repeated_chant",
        "acoustic_collapsed_prefix_variant",
        "acoustic_collapsed_exact_row",
        "acoustic_delayed_opening_pickup",
        "acoustic_dense_trailing_prefix",
        "acoustic_dense_partial_prefix",
        "acoustic_dense_shared_prefix_chant",
        "acoustic_early_gap_entry",
        "acoustic_early_gap_vocalization",
        "acoustic_exact_repeat_outlier",
        "acoustic_exact_occurrence_ratio",
        "acoustic_fragment_sequence",
        "acoustic_fragment_following_span",
        "acoustic_identical_repeat_cadence",
        "acoustic_identical_repeat_grid",
        "acoustic_leading_prefix",
        "acoustic_leading_vocalization",
        "acoustic_lexical_prior_recovery",
        "acoustic_long_lexical_boundary",
        "acoustic_long_opening_entrance",
        "acoustic_long_repeat_outlier",
        "acoustic_long_repeat_suffix",
        "acoustic_long_weighted_entrance",
        "acoustic_nested_suffix_repeat",
        "acoustic_overlap_run_rebased",
        "acoustic_opening_shift_chain",
        "acoustic_opening_syllabic_pair",
        "acoustic_partial_repeat_consensus",
        "acoustic_partial_repeat_prefix",
        "acoustic_repeat_offset_outlier",
        "acoustic_repeat_transfer",
        "acoustic_repeated_block_prior",
        "acoustic_repeated_fragment_tail",
        "acoustic_repeated_intro_pair",
        "acoustic_repeated_leading_prefix",
        "acoustic_repeated_overlap_entry",
        "acoustic_repeated_chant_suffix",
        "acoustic_repeated_internal_refrain",
        "acoustic_repeated_prefix_cadence_tail",
        "acoustic_repeated_section_entry",
        "acoustic_repeated_section_cadence",
        "acoustic_repeated_segment_entry",
        "acoustic_repeated_trailing_motif",
        "acoustic_repeated_trailing_pair",
        "acoustic_primary_parenthetical_entry",
        "acoustic_repeat_outlier",
        "acoustic_repeat_pair",
        "acoustic_shifted_onset_run",
        "acoustic_short_trailing_suffix",
        "acoustic_short_repeat_outlier",
        "acoustic_short_leading_pickup",
        "acoustic_short_identical_bridge",
        "acoustic_short_repeat_suffix_offset",
        "acoustic_shortened_repeat_tail",
        "acoustic_shifted_response_pair",
        "acoustic_shifted_trailing_pair",
        "acoustic_sparse_repeat",
        "acoustic_stretched_second",
        "acoustic_stretched_bridge",
        "acoustic_stretched_leading_cadence",
        "acoustic_stretched_section_cadence",
        "acoustic_suffix_echo",
        "acoustic_interleaved_suffix_echo",
        "acoustic_trailing_cadence",
        "acoustic_trailing_activity",
        "acoustic_trailing_short_activity",
        "acoustic_trailing_aba_cadence",
        "acoustic_uniform_weak_span",
        "acoustic_uniform_identical_pair",
        "acoustic_unclaimed_trailing_pattern",
        "acoustic_segment_start_prior",
        "acoustic_squeezed_long_lexical",
        "acoustic_rebased_leading_pair",
        "acoustic_crowded_leading_prefix_prior",
        "acoustic_weighted_bounded_weak_span",
        "acoustic_weighted_trailing_suffix",
        "acoustic_weighted_gap_cluster",
        "acoustic_weighted_gap_cluster_tail",
        "acoustic_weighted_interpolated_entrance",
        "acoustic_weighted_unmatched_span",
        "acoustic_weighted_weak_pair",
        "acoustic_weak_identical_pair_prior",
        "acoustic_weighted_primary_triplet",
        "acoustic_crowded_partial_lexical",
        "acoustic_crowded_short_partial",
        "acoustic_final_partial_lexical",
        "acoustic_multi_repeat_consensus",
        "acoustic_trailing_vocalization_cadence",
        "acoustic_variant_alternating_cadence",
        "repeat_cadence",
        "repeat_collapsed_cadence",
        "repeat_line_consensus",
        "repeat_periodic_boundary",
        "repeat_unique_dense_outlier",
        "repeat_suffix_offset_consensus",
        "repeat_template_outlier",
        "repeat_template_consensus",
        "repeat_transfer",
        "repeated_asr_boundary",
    }
)
_TEMPLATE_WEAK_METHODS = _STRUCTURAL_METHODS
_LEADING_VOCALIZATIONS = frozenset(
    {
        "aah",
        "ah",
        "eh",
        "hey",
        "hm",
        "hmm",
        "mm",
        "mmm",
        "oh",
        "ooh",
        "uh",
        "whoa",
        "yeah",
    }
)


@dataclass(frozen=True, slots=True)
class AcousticRefinementSummary:
    candidate_count: int
    refined_lines: int
    noise_floor_db: float


def _mono_samples(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = soundfile.read(
        str(path),
        dtype="float32",
        always_2d=True,
    )
    return (
        np.mean(samples, axis=1, dtype=np.float32),
        int(sample_rate),
    )


def _onset_profile(
    samples: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, np.ndarray]:
    hop = max(1, round(sample_rate * 0.01))
    window = max(1, round(sample_rate * 0.025))
    if len(samples) < window + hop:
        empty = np.zeros(0, dtype=np.float64)
        return empty, empty, empty, -120.0, np.zeros(0, dtype=np.int64)

    squared = samples.astype(np.float64) ** 2
    cumulative = np.concatenate(([0.0], np.cumsum(squared)))
    starts = np.arange(
        1 + (len(samples) - window) // hop,
        dtype=np.int64,
    ) * hop
    power = (
        cumulative[starts + window] - cumulative[starts]
    ) / window + 1e-12
    power_cumulative = np.concatenate(([0.0], np.cumsum(power)))
    frame_count = len(power)
    pre_frames = 25
    post_frames = 18
    rise = np.zeros(frame_count, dtype=np.float64)
    post_db = np.full(frame_count, -120.0, dtype=np.float64)
    for index in range(pre_frames, frame_count - post_frames):
        before = (
            power_cumulative[index - 3]
            - power_cumulative[index - pre_frames]
        ) / (pre_frames - 3)
        after = (
            power_cumulative[index + post_frames]
            - power_cumulative[index + 2]
        ) / (post_frames - 2)
        before_db = 10.0 * np.log10(max(before, 1e-12))
        post_db[index] = 10.0 * np.log10(max(after, 1e-12))
        rise[index] = post_db[index] - before_db

    valid = post_db[pre_frames : frame_count - post_frames]
    noise_floor = (
        float(np.percentile(valid, 15))
        if len(valid)
        else -120.0
    )
    energy = np.clip(post_db - noise_floor, 0.0, 50.0)
    score = 0.85 * np.clip(rise, 0.0, 55.0) + 0.15 * energy
    candidates = np.flatnonzero(
        (score[1:-1] >= score[:-2])
        & (score[1:-1] >= score[2:])
        & (score[1:-1] >= 7.0)
        & (rise[1:-1] >= 6.0)
    ) + 1
    candidates = candidates[
        post_db[candidates] >= noise_floor + 5.0
    ]
    # ``score[index]`` looks ahead through ``post_frames``.  Its first peak
    # therefore means "an onset has appeared by the end of this look-ahead
    # window", not that the onset happened at the window's left edge.
    # Returning the left edge made every selected onset about 180 ms early.
    times = (
        starts.astype(np.float64) + post_frames * hop
    ) / sample_rate
    # Flat, sustained attacks otherwise produce one candidate per 10 ms
    # frame.  Keep the earliest near-maximum point from each attack so a
    # later lyric cannot reuse another frame from the same vocal entrance.
    clusters: list[list[int]] = []
    for candidate in candidates:
        if (
            clusters
            and times[candidate] - times[clusters[-1][-1]] <= 0.06
        ):
            clusters[-1].append(int(candidate))
        else:
            clusters.append([int(candidate)])
    reduced: list[int] = []
    for cluster in clusters:
        peak = max(score[index] for index in cluster)
        reduced.append(
            next(
                index
                for index in cluster
                if score[index] >= peak - 1.0
            )
        )
    return (
        times,
        score,
        post_db,
        noise_floor,
        np.asarray(reduced, dtype=np.int64),
    )


def _soft_onset_indices(
    onset_scores: np.ndarray,
    *,
    minimum_score: float = 5.5,
) -> np.ndarray:
    """Return lower-energy local rises for structurally constrained repairs."""

    if len(onset_scores) < 3:
        return np.zeros(0, dtype=np.int64)
    candidates = np.flatnonzero(
        (onset_scores[1:-1] >= onset_scores[:-2])
        & (onset_scores[1:-1] >= onset_scores[2:])
        & (onset_scores[1:-1] >= minimum_score)
    ) + 1
    reduced: list[int] = []
    for candidate in candidates:
        if (
            reduced
            and candidate - reduced[-1] <= 12
        ):
            if onset_scores[candidate] > onset_scores[reduced[-1]]:
                reduced[-1] = int(candidate)
        else:
            reduced.append(int(candidate))
    return np.asarray(reduced, dtype=np.int64)


def _repair_leading_vocalizations(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a soft Oh/Ooh/Mm omitted before the first matched word."""

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    for index, (line, anchor) in enumerate(
        zip(lines, anchors, strict=True)
    ):
        values = primary_lexical_values(line.text)
        if (
            not values
            or values[0] not in _LEADING_VOCALIZATIONS
            or anchor.leading_unmatched_units < 1
            or anchor.interpolated
            or anchor.method not in {"lexical", "lexical_segment_start"}
            or anchor.confidence < 0.5
        ):
            continue
        lower = max(0.0, anchor.start - 5.0)
        if index:
            lower = max(
                lower,
                anchors[index - 1].start + 0.28,
                anchors[index - 1].end - 0.1,
            )
        upper = anchor.start - 0.3
        if lower >= upper:
            continue
        candidates = [
            int(candidate)
            for candidate in soft_indices
            if lower <= times[candidate] <= upper
        ]
        if len(candidates) < 2:
            continue
        clusters: list[list[int]] = []
        for candidate in candidates:
            if (
                clusters
                and times[candidate] - times[clusters[-1][-1]] <= 1.35
            ):
                clusters[-1].append(candidate)
            else:
                clusters.append([candidate])
        clusters = [
            cluster
            for cluster in clusters
            if (
                len(cluster) >= 2
                and times[cluster[-1]] - times[cluster[0]] >= 0.2
            )
        ]
        if not clusters:
            continue
        # The last coherent group before the first recognized word belongs to
        # this row; its earliest rise is the missing vocalization entrance.
        cluster = clusters[-1]
        start = max(
            0.0,
            float(times[cluster[0]]) - cue_lead_seconds,
        )
        following = (
            anchors[index + 1].start
            if index + 1 < len(anchors)
            else math.inf
        )
        if (
            start < lower - cue_lead_seconds
            or start > following - 0.28
            or anchor.start - start < 0.45
        ):
            continue
        repaired[index] = replace(
            anchor,
            start=start,
            # The matched word remains at its original position.  Moving the
            # end by the same delta would erase that evidence and make the
            # following lyric appear to start inside the preceding phrase.
            end=max(start, anchor.end),
            confidence=max(0.5, min(0.7, anchor.confidence)),
            interpolated=False,
            method="acoustic_leading_vocalization",
            start_uncertainty=0.18,
        )
    return repaired


def _repair_isolated_gap_vocalizations(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    post_db: np.ndarray,
    noise_floor_db: float,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover one missed Oh/Mm between a phrase and a long instrumental."""

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    for index in range(1, len(repaired) - 1):
        anchor = repaired[index]
        values = primary_lexical_values(lines[index].text)
        if (
            not values
            or len(values) > 2
            or any(value not in _LEADING_VOCALIZATIONS for value in values)
            or not (anchor.interpolated or anchor.confidence < 0.3)
        ):
            continue
        previous = repaired[index - 1]
        following = repaired[index + 1]
        if (
            previous.interpolated
            or following.interpolated
            or previous.confidence < 0.5
            or following.confidence < 0.5
            or following.start - previous.end < 12.0
        ):
            continue

        lower = previous.end + 0.55 + cue_lead_seconds
        upper = following.start - 0.75 + cue_lead_seconds
        candidates = [
            int(candidate)
            for candidate in soft_indices
            if lower <= times[candidate] <= upper
            and onset_scores[candidate] >= 8.0
            and post_db[candidate] >= noise_floor_db + 5.0
        ]
        if not candidates:
            continue
        candidate = max(
            candidates,
            key=lambda item: (
                onset_scores[item],
                post_db[item],
            ),
        )
        start = max(
            0.0,
            float(times[candidate]) - cue_lead_seconds,
        )
        repaired[index] = replace(
            anchor,
            start=start,
            end=start + max(0.0, anchor.end - anchor.start),
            confidence=0.42,
            interpolated=False,
            method="acoustic_gap_vocalization",
            start_uncertainty=0.18,
        )
    return repaired


def _repair_unmatched_leading_prefixes(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a long lyric prefix omitted before a matched ASR suffix."""

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    for index, anchor in enumerate(anchors):
        if (
            index == 0
            or anchor.method != "lexical"
            # Three or four unmatched words are common when ASR chooses a
            # slightly later lexical token inside an otherwise well-aligned
            # English/Japanese line.  Treat only a genuinely long omitted
            # prefix as evidence for a multi-second backward correction.
            or anchor.leading_unmatched_units < 6
            or anchor.matched_units < 2
            or anchor.confidence < 0.35
            or anchor.start_uncertainty < 0.75
        ):
            continue
        matched_duration = max(0.0, anchor.end - anchor.start)
        unit_duration = min(
            0.45,
            max(
                0.12,
                matched_duration / anchor.matched_units,
            ),
        )
        predicted = (
            anchor.start
            - anchor.leading_unmatched_units * unit_duration
        )
        lower = repaired[index - 1].start + 0.28
        upper = (
            repaired[index + 1].start - 0.28
            if index + 1 < len(repaired)
            else anchor.start - 0.2
        )
        options = [
            (
                float(onset_scores[candidate])
                - 4.0
                * abs(
                    (
                        float(times[candidate])
                        - cue_lead_seconds
                    )
                    - predicted
                ),
                max(
                    0.0,
                    float(times[candidate])
                    - cue_lead_seconds,
                ),
            )
            for candidate in soft_indices
            if (
                lower
                <= times[candidate] - cue_lead_seconds
                <= upper
                and abs(
                    (
                        times[candidate]
                        - cue_lead_seconds
                    )
                    - predicted
                )
                <= 1.0
            )
        ]
        if not options:
            continue
        score, start = max(options)
        shift = anchor.start - start
        if (
            score < 4.0
            or shift < 0.5
            or shift > 4.5
        ):
            continue
        repaired[index] = replace(
            anchor,
            start=start,
            end=start + matched_duration,
            confidence=max(0.5, min(0.65, anchor.confidence)),
            interpolated=False,
            method="acoustic_leading_prefix",
            start_uncertainty=0.22,
        )
    return repaired


def _eligible(
    line: TranscriptLine,
    anchor: CoarseLineAnchor,
) -> tuple[bool, bool]:
    coverage = anchor.matched_units / max(1, anchor.total_units)
    weak = (
        anchor.method not in _STRUCTURAL_METHODS
        and (
            anchor.interpolated
            or anchor.confidence < 0.5
            or coverage < 0.7
            or anchor.method
            in {
                "leading_activity",
                "overlap_repair",
                "monotonic_repair",
            }
        )
    )
    stretched_latin_start = (
        (line.detected_language or "English") in _LATIN_LANGUAGES
        and anchor.start_uncertainty
        >= (1.0 if anchor.method == "repeat_cadence" else 0.25)
    )
    return weak or stretched_latin_start, weak


def _rebase_leading_weak_run(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
) -> list[CoarseLineAnchor]:
    """Move a zero-based weak prefix onto distinct early vocal entrances.

    Whisper commonly omits a sung pickup made from breaths, vocalizations, or
    heavily processed words.  The coarse mapper then spreads those rows from
    250 ms to the first lexical match.  Strong-onset-only recovery is too
    restrictive here: a second soft entrance can be structurally unambiguous
    even when it does not clear the generic acoustic threshold.
    """

    first_reliable = 0
    while first_reliable < len(anchors):
        _, weak = _eligible(lines[first_reliable], anchors[first_reliable])
        structurally_unmatched = (
            anchors[first_reliable].matched_units == 0
            and anchors[first_reliable].confidence < 0.5
        )
        if not (weak or structurally_unmatched):
            break
        first_reliable += 1
    if first_reliable < 1 or first_reliable >= len(anchors):
        return list(anchors)
    if first_reliable >= 3:
        # Long missing prefixes need a conservative span estimate.  Treating
        # every soft syllable as a separate row collapses dense Japanese or
        # multilingual openings such as KICK BACK and Berghain.
        upper = anchors[first_reliable].start
        usable = [
            int(index)
            for index in onset_indices
            if 0.25 <= times[index] < upper - 0.25
            and onset_scores[index] >= 12.0
        ]
        clusters: list[list[int]] = []
        for index in usable:
            if (
                clusters
                and times[index] - times[clusters[-1][-1]] <= 7.0
            ):
                clusters[-1].append(index)
            else:
                clusters.append([index])
        activity = next(
            (
                cluster
                for cluster in clusters
                if len(cluster) >= 3
                and times[cluster[-1]] - times[cluster[0]] >= 1.0
            ),
            None,
        )
        if activity is None:
            return list(anchors)
        if (
            len(activity) == first_reliable + 1
            and times[activity[1]] - times[activity[0]] >= 3.5
            and times[activity[-1]] - times[activity[1]] >= 1.0
        ):
            activity = activity[1:]
        cluster_start = times[activity[0]]
        entrance = max(
            (
                index
                for index in activity
                if times[index] <= cluster_start + 0.75
            ),
            key=lambda index: onset_scores[index],
        )
        lower = float(times[entrance])
        if lower - anchors[0].start < 2.0:
            return list(anchors)
        if upper - lower < first_reliable * 0.45:
            return list(anchors)

        weights = [
            max(
                1.0,
                math.sqrt(
                    max(1, len(lexical_values(line.text)))
                ),
            )
            for line in lines[:first_reliable]
        ]
        total = sum(weights)
        elapsed = 0.0
        starts: list[float] = []
        for weight in weights:
            starts.append(
                lower + (upper - lower) * elapsed / total
            )
            elapsed += weight

        rebased = list(anchors)
        for index, start in enumerate(starts):
            following = (
                starts[index + 1]
                if index + 1 < len(starts)
                else upper
            )
            rebased[index] = replace(
                anchors[index],
                start=start,
                end=max(start, following),
                confidence=0.18,
                interpolated=False,
                method="acoustic_leading_activity",
                start_uncertainty=4.0,
            )
        return rebased

    if (
        anchors[0].start > 0.75
        or not any(
            anchor.interpolated
            for anchor in anchors[:first_reliable]
        )
    ):
        return list(anchors)

    upper = anchors[first_reliable].start
    soft_indices = _soft_onset_indices(onset_scores)
    strong = {int(index) for index in onset_indices}
    usable = [
        index
        for index in sorted(
            strong | {int(candidate) for candidate in soft_indices},
            key=lambda candidate: times[candidate],
        )
        if 0.25 <= times[index] < upper - 0.25
        and onset_scores[index] >= 5.5
    ]
    clusters: list[list[int]] = []
    for index in usable:
        if (
            clusters
            and times[index] - times[clusters[-1][-1]] <= 5.0
        ):
            clusters[-1].append(index)
        else:
            clusters.append([index])

    def only_vocalizations(line: TranscriptLine) -> bool:
        values = primary_lexical_values(line.text)
        return bool(values) and all(
            value in _LEADING_VOCALIZATIONS for value in values
        )

    select_activity_entrance = False
    if first_reliable == 1 and only_vocalizations(lines[0]):
        # A one-row pickup normally belongs to the final activity group before
        # the first lexical line.  This rejects an isolated Demucs leak early
        # in a long instrumental intro while retaining a soft "uh" immediately
        # before speech.
        activity = clusters[-1] if clusters else None
        values = primary_lexical_values(lines[0].text)
        if activity and len(values) >= 2:
            # A repeated vocalization can be followed by the already-matched
            # lexical line closely enough that both land in the same five-
            # second activity cluster.  A clear internal pause plus activity
            # close to the reliable anchor marks that later subgroup as the
            # next line, not as the pickup.  Keep the first real entrance of
            # the earlier subgroup (for example "Ooh, ooh" before a verse).
            split = next(
                (
                    position
                    for position in range(2, len(activity))
                    if (
                        times[activity[position]]
                        - times[activity[position - 1]]
                        >= 3.0
                        and upper - times[activity[position]] <= 2.5
                    )
                ),
                None,
            )
            if split is not None:
                activity = activity[:split]
                select_activity_entrance = True
    else:
        activity = next(
            (
                cluster
                for cluster in clusters
                if len(cluster) >= first_reliable
            ),
            None,
        )
    if activity is None:
        return list(anchors)
    if (
        len(activity) == first_reliable + 1
        and times[activity[1]] - times[activity[0]] >= 3.5
        and times[activity[-1]] - times[activity[1]] >= 1.0
    ):
        # A single isolated Demucs artifact before exactly the required
        # number of vocal entrances must not drag a short intro back toward
        # zero. Larger uncertain prefixes keep the original conservative
        # behavior.
        activity = activity[1:]

    selected: list[int] = []
    for line in lines[:first_reliable]:
        candidates = activity
        if not only_vocalizations(line):
            strong_candidates = [
                candidate
                for candidate in activity
                if candidate in strong
            ]
            if strong_candidates:
                candidates = strong_candidates
        if selected:
            previous_units = len(
                lexical_values(
                    lines[len(selected) - 1].text
                )
            )
            minimum_gap = min(
                1.2,
                max(0.55, previous_units * 0.12),
            )
            candidates = [
                candidate
                for candidate in candidates
                if times[candidate]
                >= times[selected[-1]] + minimum_gap
            ]
        if not candidates:
            return list(anchors)
        if (
            first_reliable == 1
            and only_vocalizations(line)
            and not select_activity_entrance
        ):
            selected.append(candidates[-1])
        elif select_activity_entrance:
            cluster_start = times[candidates[0]]
            selected.append(
                max(
                    (
                        candidate
                        for candidate in candidates
                        if times[candidate] <= cluster_start + 0.75
                    ),
                    key=lambda candidate: onset_scores[candidate],
                )
            )
        else:
            selected.append(candidates[0])

    lower = float(times[selected[0]])
    if lower - anchors[0].start < 2.0:
        return list(anchors)
    if upper - float(times[selected[-1]]) < 0.25:
        return list(anchors)

    starts = [float(times[candidate]) for candidate in selected]

    rebased = list(anchors)
    for index, start in enumerate(starts):
        following = (
            starts[index + 1]
            if index + 1 < len(starts)
            else upper
        )
        rebased[index] = replace(
            anchors[index],
            start=start,
            end=max(start, following),
            confidence=0.18,
            interpolated=False,
            method="acoustic_leading_activity",
            start_uncertainty=4.0,
        )
    return rebased


def _repeated_blocks(
    lines: list[TranscriptLine],
    *,
    minimum: int = 3,
) -> list[tuple[int, int, int]]:
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    blocks: list[tuple[int, int, int]] = []
    for left in range(len(signatures)):
        for right in range(left + minimum, len(signatures)):
            if not signatures[left] or signatures[left] != signatures[right]:
                continue
            if (
                left
                and right
                and signatures[left - 1] == signatures[right - 1]
            ):
                continue
            length = 0
            while (
                right + length < len(signatures)
                and signatures[left + length]
                == signatures[right + length]
            ):
                length += 1
            if length >= minimum:
                blocks.append((left, right, length))
    return sorted(
        blocks,
        key=lambda block: (-block[2], block[0], block[1]),
    )


def _repeat_bin_support(
    pairs: list[tuple[int, int, float, float]],
) -> tuple[int, float]:
    ordered = sorted(pairs)
    lengths = [1] * len(ordered)
    energies = [pair[2] for pair in ordered]
    for index, (first, second, energy, _) in enumerate(ordered):
        for previous in range(index):
            old_first, old_second, _, _ = ordered[previous]
            if old_first >= first or old_second >= second:
                continue
            candidate_length = lengths[previous] + 1
            candidate_energy = energies[previous] + energy
            if (
                candidate_length > lengths[index]
                or (
                    candidate_length == lengths[index]
                    and candidate_energy > energies[index]
                )
            ):
                lengths[index] = candidate_length
                energies[index] = candidate_energy
    best = max(range(len(ordered)), key=lambda item: (
        lengths[item],
        energies[item],
    ))
    return lengths[best], energies[best]


def _repair_acoustic_repeat_pairs(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Lock weak repeated lyric blocks to a shared acoustic rhythm."""

    repaired = list(anchors)
    if not len(onset_indices):
        return repaired
    last_candidate = float(times[onset_indices[-1]]) + 0.01
    claimed_indices: set[int] = set()
    for left, right, length in _repeated_blocks(lines):
        # Maximal matching reports a cyclic refrain such as ABCDABCD A as
        # two length-five blocks whose boundary A is shared. Solving those
        # blocks verbatim assigns two candidates to the same lyric row, and
        # the later write can shift the cadence by an internal syllable.
        # Compare only the disjoint cycles in this acoustic pass.
        if right < left + length:
            length = right - left
        if length < 2:
            continue
        block_indices = [
            *(range(left, left + length)),
            *(range(right, right + length)),
        ]
        # A chant occurring many times yields a combinatorial number of
        # overlapping repeat pairs. Re-solving an already repaired row against
        # a different occurrence can shift the whole run by one refrain.
        # Prefer the longest disjoint blocks in the deterministic order from
        # _repeated_blocks; later structural transfer can still fill leftovers.
        if any(index in claimed_indices for index in block_indices):
            continue
        uncertain = sum(
            (
                repaired[index].method
                in {
                    "acoustic_leading_activity",
                    "interpolated",
                    "leading_activity",
                    "monotonic_repair",
                    "overlap_repair",
                }
                or (
                    repaired[index].confidence < 0.55
                    and repaired[index].method
                    not in _STRUCTURAL_METHODS
                )
            )
            for index in block_indices
        )
        # If one occurrence still has usable lexical/structural anchors,
        # the existing repeat-transfer path is safer.  Pure acoustic pairing
        # is reserved for repeated passages where both copies largely lost
        # their words.
        if uncertain < math.ceil(1.5 * length):
            continue

        def repeat_lower(index: int) -> float:
            if index == 0:
                return 0.0
            previous = repaired[index - 1]
            lower = previous.start + 0.28
            # ASR/interpolated spans often extend across the next sung line.
            # Treat the previous end as a hard exclusion only when that span
            # itself is reliable; otherwise it can erase the true refrain
            # entrance from the candidate pool.
            if (
                previous.end > previous.start + 0.05
                and previous.method
                not in {
                    "acoustic_leading_activity",
                    "leading_activity",
                }
            ):
                lower = max(lower, previous.end + 0.05)
            return lower

        first_lower = repeat_lower(left)
        first_upper = (
            repaired[left + length].start - 0.28
            if left + length < len(repaired)
            else last_candidate
        )
        second_lower = repeat_lower(right)
        second_upper = (
            repaired[right + length].start - 0.28
            if right + length < len(repaired)
            else last_candidate
        )
        current_offset = float(
            median(
                repaired[right + position].start
                - repaired[left + position].start
                for position in range(length)
            )
        )

        def bounded_candidates(
            indices: np.ndarray,
            lower: float,
            upper: float,
            *,
            suppress_nearby: bool = False,
        ) -> list[int]:
            candidates = [
                int(index)
                for index in indices
                if lower - 0.75 <= times[index] <= upper + 0.75
            ]
            if not suppress_nearby:
                return candidates
            # Soft peaks include several syllables from one attack. Keep the
            # strongest candidate inside each 300 ms neighbourhood so path
            # support measures distinct entrances rather than peak density.
            selected: list[int] = []
            for candidate in sorted(
                candidates,
                key=lambda index: onset_scores[index],
                reverse=True,
            ):
                if all(
                    abs(times[candidate] - times[other]) >= 0.3
                    for other in selected
                ):
                    selected.append(candidate)
            return sorted(selected)

        def rank_candidate_offsets(
            first_pool: list[int],
            second_pool: list[int],
        ) -> list[tuple[int, float, float]]:
            if len(first_pool) < length or len(second_pool) < length:
                return []
            bins: dict[
                int,
                list[tuple[int, int, float, float]],
            ] = {}
            for first_position, first in enumerate(first_pool):
                for second_position, second in enumerate(second_pool):
                    difference = float(times[second] - times[first])
                    if difference <= 0.5 or abs(
                        difference - current_offset
                    ) > 12.0:
                        continue
                    key = round(difference / 0.25)
                    bins.setdefault(key, []).append(
                        (
                            first_position,
                            second_position,
                            float(
                                min(
                                    onset_scores[first],
                                    onset_scores[second],
                                )
                            ),
                            difference,
                        )
                    )
            ranked: list[tuple[int, float, float]] = []
            for key, pairs in bins.items():
                support, energy = _repeat_bin_support(pairs)
                if support >= length:
                    offset = key * 0.25
                    ranked.append(
                        (
                            support,
                            energy
                            - 0.5
                            * abs(offset - current_offset),
                            offset,
                        )
                    )
            return ranked

        first_candidates = bounded_candidates(
            onset_indices,
            first_lower,
            first_upper,
        )
        second_candidates = bounded_candidates(
            onset_indices,
            second_lower,
            second_upper,
        )
        ranked_bins = rank_candidate_offsets(
            first_candidates,
            second_candidates,
        )
        allow_soft_repeat_fallback = all(
            repaired[index].method == "acoustic_leading_activity"
            for index in block_indices
        )
        if not ranked_bins and allow_soft_repeat_fallback:
            soft_indices = _soft_onset_indices(onset_scores)
            first_candidates = bounded_candidates(
                soft_indices,
                first_lower,
                first_upper,
                suppress_nearby=True,
            )
            second_candidates = bounded_candidates(
                soft_indices,
                second_lower,
                second_upper,
                suppress_nearby=True,
            )
            ranked_bins = rank_candidate_offsets(
                first_candidates,
                second_candidates,
            )
        if not ranked_bins:
            continue
        _, _, offset = max(ranked_bins)

        states = [
            (first_position, second_position)
            for first_position, first in enumerate(first_candidates)
            for second_position, second in enumerate(second_candidates)
            if abs(
                (times[second] - times[first]) - offset
            )
            <= 1.25
        ]
        if not states:
            continue
        infinity = float("inf")
        costs = [[infinity] * len(states) for _ in range(length)]
        traces = [[-1] * len(states) for _ in range(length)]

        def local_cost(position: int, state_index: int) -> float:
            first_position, second_position = states[state_index]
            first = first_candidates[first_position]
            second = second_candidates[second_position]
            first_start = float(times[first])
            second_start = float(times[second])
            expected_first = (
                repaired[left + position].start + cue_lead_seconds
            )
            expected_second = (
                repaired[right + position].start + cue_lead_seconds
            )
            return (
                0.12 * abs(first_start - expected_first)
                + 0.12 * abs(second_start - expected_second)
                + 0.8
                * abs((second_start - first_start) - offset)
                + (
                    2.0 * (first_position + second_position)
                    if position == 0
                    else 0.0
                )
                - 0.08
                * (
                    onset_scores[first]
                    + onset_scores[second]
                )
            )

        for state_index in range(len(states)):
            costs[0][state_index] = local_cost(0, state_index)
        for position in range(1, length):
            for state_index, (
                first_position,
                second_position,
            ) in enumerate(states):
                first = first_candidates[first_position]
                second = second_candidates[second_position]
                local = local_cost(position, state_index)
                for previous_index, (
                    old_first_position,
                    old_second_position,
                ) in enumerate(states):
                    if (
                        old_first_position >= first_position
                        or old_second_position >= second_position
                    ):
                        continue
                    old_first = first_candidates[old_first_position]
                    old_second = second_candidates[old_second_position]
                    first_gap = float(times[first] - times[old_first])
                    second_gap = float(times[second] - times[old_second])
                    expected_gap = min(
                        max(
                            0.28,
                            repaired[left + position].start
                            - repaired[left + position - 1].start,
                        ),
                        max(
                            0.28,
                            repaired[right + position].start
                            - repaired[right + position - 1].start,
                        ),
                    )
                    minimum_gap = max(
                        0.28,
                        min(1.2, 0.4 * expected_gap),
                    )
                    if (
                        first_gap < minimum_gap
                        or second_gap < minimum_gap
                    ):
                        continue
                    candidate = (
                        costs[position - 1][previous_index]
                        + local
                        + 2.5 * abs(first_gap - second_gap)
                        + 1.25
                        * (
                            abs(first_gap - expected_gap)
                            + abs(second_gap - expected_gap)
                        )
                        + 2.0
                        * (
                            max(
                                0,
                                first_position
                                - old_first_position
                                - 2,
                            )
                            + max(
                                0,
                                second_position
                                - old_second_position
                                - 2,
                            )
                        )
                    )
                    if candidate < costs[position][state_index]:
                        costs[position][state_index] = candidate
                        traces[position][state_index] = previous_index
        def following_attack_reward(
            candidate: int,
            has_following_line: bool,
        ) -> float:
            if not has_following_line:
                return 0.0
            following = [
                onset_scores[index]
                for index in onset_indices
                if 0.3
                <= times[index] - times[candidate]
                <= 1.6
            ]
            return 0.45 * float(max(following, default=0.0))

        state_index = min(
            range(len(states)),
            key=lambda item: (
                costs[-1][item]
                - following_attack_reward(
                    first_candidates[states[item][0]],
                    left + length < len(repaired),
                )
                - following_attack_reward(
                    second_candidates[states[item][1]],
                    right + length < len(repaired),
                )
            ),
        )
        if not math.isfinite(costs[-1][state_index]):
            continue
        selected: list[tuple[int, int]] = []
        for position in range(length - 1, -1, -1):
            selected.append(states[state_index])
            state_index = traces[position][state_index]
        selected.reverse()

        def side_has_distant_lexical_consensus(
            line_start: int,
            candidate_side: int,
            pool: list[int],
        ) -> bool:
            shifts: list[float] = []
            for position, state in enumerate(selected):
                anchor = repaired[line_start + position]
                if not (
                    anchor.method.startswith("lexical")
                    and anchor.confidence >= 0.48
                    and anchor.matched_units >= 3
                    and anchor.start_uncertainty <= 0.75
                ):
                    continue
                proposed_start = max(
                    0.0,
                    float(times[pool[state[candidate_side]]])
                    - cue_lead_seconds,
                )
                shifts.append(proposed_start - anchor.start)
            required_support = max(2, math.ceil(0.5 * length))
            if len(shifts) < required_support:
                return False
            median_shift = float(median(shifts))
            directional_support = sum(
                shift * median_shift > 0 and abs(shift) > 2.5
                for shift in shifts
            )
            # A repeat path can accidentally pair a real refrain with an
            # earlier instrumental or backing-vocal cycle.  When several
            # independent lexical anchors agree on the existing occurrence
            # and the acoustic path would move that whole side by seconds,
            # retain the lexical occurrence while still allowing the weak
            # counterpart to benefit from acoustic pairing.
            return (
                directional_support >= required_support
                and abs(median_shift) > 2.5
            )

        preserve_first = side_has_distant_lexical_consensus(
            left,
            0,
            first_candidates,
        )
        preserve_second = side_has_distant_lexical_consensus(
            right,
            1,
            second_candidates,
        )
        for position, (
            first_position,
            second_position,
        ) in enumerate(selected):
            for line_index, candidate_position, pool, preserve_side in (
                (
                    left + position,
                    first_position,
                    first_candidates,
                    preserve_first,
                ),
                (
                    right + position,
                    second_position,
                    second_candidates,
                    preserve_second,
                ),
            ):
                if preserve_side:
                    continue
                anchor = repaired[line_index]
                start = max(
                    0.0,
                    float(times[pool[candidate_position]])
                    - cue_lead_seconds,
                )
                repaired[line_index] = replace(
                    anchor,
                    start=start,
                    end=start + max(0.0, anchor.end - anchor.start),
                    confidence=0.48,
                    interpolated=False,
                    method="acoustic_repeat_pair",
                    start_uncertainty=0.1,
                )
        claimed_indices.update(block_indices)
        gap_start = left + length
        if gap_start < right:
            gap_anchors = repaired[gap_start:right]
            weak_gap_count = sum(
                (
                    anchor.interpolated
                    or anchor.confidence < 0.3
                    or anchor.method
                    in {
                        "acoustic_leading_activity",
                        "leading_activity",
                        "monotonic_repair",
                        "overlap_repair",
                    }
                )
                for anchor in gap_anchors
            )
            if weak_gap_count < math.ceil(0.8 * len(gap_anchors)):
                continue
            last_first = first_candidates[selected[-1][0]]
            following = [
                int(index)
                for index in onset_indices
                if 0.3
                <= times[index] - times[last_first]
                <= 1.6
                and onset_scores[index]
                >= onset_scores[last_first] + 4.0
            ]
            if following:
                entrance = max(
                    following,
                    key=lambda index: onset_scores[index],
                )
                lower = max(
                    0.0,
                    float(times[entrance]) - cue_lead_seconds,
                )
                upper = repaired[right].start
                gap_lines = lines[gap_start:right]
                if upper - lower >= len(gap_lines) * 0.35:
                    weights = [
                        max(
                            1.0,
                            math.sqrt(
                                max(
                                    1,
                                    len(lexical_values(line.text)),
                                )
                            ),
                        )
                        for line in gap_lines
                    ]
                    total = sum(weights)
                    elapsed = 0.0
                    bridge_starts: list[float] = []
                    for weight in weights:
                        bridge_starts.append(
                            lower
                            + (upper - lower) * elapsed / total
                        )
                        elapsed += weight
                    for position, start in enumerate(bridge_starts):
                        line_index = gap_start + position
                        following_start = (
                            bridge_starts[position + 1]
                            if position + 1 < len(bridge_starts)
                            else upper
                        )
                        repaired[line_index] = replace(
                            repaired[line_index],
                            start=start,
                            end=max(start, following_start),
                            confidence=0.22,
                            interpolated=False,
                            method="acoustic_repeat_bridge",
                            start_uncertainty=3.0,
                        )
    return repaired


def _repair_periodic_repeat_boundary(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a third refrain that was paired with a later vocal cycle.

    Two earlier, well-constrained performances must agree on every relative
    line entrance.  Their occurrence interval may be extrapolated exactly
    once only when it lands on the reliable phrase boundary immediately
    before a blank-delimited third performance.  Every proposed row must then
    expose an independent hard acoustic attack.  This combination avoids
    assuming that ordinary verse/chorus intervals are globally periodic.
    """

    repaired = list(anchors)
    if not len(onset_indices):
        return repaired
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    patterns: list[tuple[str, ...]] = []
    seen_patterns: set[tuple[str, ...]] = set()
    for left, _, length in _repeated_blocks(lines):
        if length < 4:
            continue
        pattern = tuple(signatures[left : left + length])
        if pattern in seen_patterns:
            continue
        seen_patterns.add(pattern)
        patterns.append(pattern)

    def reliable_source(anchor: CoarseLineAnchor) -> bool:
        return (
            anchor.method.startswith("lexical")
            and not anchor.interpolated
            and anchor.confidence >= 0.48
            and anchor.matched_units >= 3
            and anchor.start_uncertainty <= 0.75
        )

    for pattern in patterns:
        length = len(pattern)
        raw_starts = [
            start
            for start in range(len(signatures) - length + 1)
            if tuple(signatures[start : start + length]) == pattern
        ]
        occurrence_starts: list[int] = []
        for start in raw_starts:
            if occurrence_starts and start < occurrence_starts[-1] + length:
                continue
            occurrence_starts.append(start)
        if len(occurrence_starts) != 3:
            continue
        first_start, second_start, target_start = occurrence_starts
        if (
            target_start == 0
            or not lines[target_start].blank_before
            or not all(
                reliable_source(repaired[start + position])
                for start in (first_start, second_start)
                for position in range(length)
            )
            or not all(
                repaired[target_start + position].method
                == "acoustic_repeat_pair"
                and repaired[target_start + position].confidence <= 0.5
                for position in range(length)
            )
        ):
            continue

        previous = repaired[target_start - 1]
        if (
            previous.interpolated
            or not previous.method.startswith("lexical")
            or previous.confidence < 0.75
            or previous.start_uncertainty > 0.75
            or previous.end <= previous.start + 0.05
        ):
            continue
        relative_template: list[float] = []
        relative_spreads: list[float] = []
        for position in range(length):
            values = [
                repaired[start + position].start - repaired[start].start
                for start in (first_start, second_start)
            ]
            relative_template.append(float(median(values)))
            relative_spreads.append(max(values) - min(values))
        if max(relative_spreads) > 1.0 + 1e-6:
            continue

        period = (
            repaired[second_start].start
            - repaired[first_start].start
        )
        predicted_origin = repaired[second_start].start + period
        current_origin = repaired[target_start].start
        if (
            not 10.0 <= period <= 120.0
            or abs(predicted_origin - previous.end) > 1.25
            or current_origin - previous.end < 3.0
            or not -15.0
            <= predicted_origin - current_origin
            <= -3.0
        ):
            continue

        acoustic_candidates = [
            (
                max(
                    0.0,
                    float(times[index]) - cue_lead_seconds,
                ),
                float(onset_scores[index]),
            )
            for index in onset_indices
        ]
        proposed: list[float] = []
        for relative in relative_template:
            target = predicted_origin + relative
            options = [
                (
                    score - 10.0 * abs(start - target),
                    start,
                )
                for start, score in acoustic_candidates
                if (
                    abs(start - target) <= 0.8
                    and (
                        not proposed
                        or start >= proposed[-1] + 0.28
                    )
                )
            ]
            if not options:
                proposed = []
                break
            _, start = max(options)
            proposed.append(start)
        if len(proposed) != length:
            continue
        proposed_relative = [
            start - proposed[0]
            for start in proposed
        ]
        if (
            abs(proposed[0] - previous.end) > 1.25
            or max(
                abs(actual - expected)
                for actual, expected in zip(
                    proposed_relative,
                    relative_template,
                    strict=True,
                )
            )
            > 1.0
        ):
            continue
        following = (
            repaired[target_start + length].start - 0.28
            if target_start + length < len(repaired)
            else math.inf
        )
        if proposed[-1] > following:
            continue

        for position, start in enumerate(proposed):
            index = target_start + position
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            end = start + duration
            if position + 1 < length:
                end = min(end, proposed[position + 1])
            elif math.isfinite(following):
                end = min(end, following + 0.28)
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.5,
                interpolated=False,
                method="repeat_periodic_boundary",
                start_uncertainty=0.65,
            )
    return repaired


def _repeat_offset_consensus(
    anchors: list[CoarseLineAnchor],
    left: int,
    right: int,
    length: int,
) -> float | None:
    trusted = [
        anchors[right + position].start
        - anchors[left + position].start
        for position in range(length)
        if (
            not anchors[left + position].interpolated
            and not anchors[right + position].interpolated
            and anchors[left + position].confidence >= 0.4
            and anchors[right + position].confidence >= 0.4
        )
    ]
    differences = (
        trusted
        if len(trusted) >= 2
        else [
            anchors[right + position].start
            - anchors[left + position].start
            for position in range(length)
        ]
    )
    center = float(median(differences))
    consistent = [
        difference
        for difference in differences
        if abs(difference - center) <= 0.75
    ]
    if len(consistent) < max(2, math.ceil(len(differences) * 0.6)):
        return None
    return float(median(consistent))


def _repeat_block_rhythm_cost(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    start: int,
    length: int,
    replacements: dict[int, float] | None = None,
) -> float:
    proposed = replacements or {}
    normalized_gaps: list[float] = []
    first_gap = start - 1 if start > 0 else start
    last_gap = min(len(anchors) - 2, start + length - 1)
    for left_index in range(first_gap, last_gap + 1):
        right_index = left_index + 1
        left_start = proposed.get(
            left_index,
            anchors[left_index].start,
        )
        right_start = proposed.get(
            right_index,
            anchors[right_index].start,
        )
        gap = right_start - left_start
        if gap < 0.28:
            return math.inf
        weight = math.sqrt(
            max(
                1,
                len(lexical_values(lines[left_index].text)),
            )
        )
        normalized_gaps.append(gap / weight)
    log_gaps = [math.log(gap) for gap in normalized_gaps]
    center = float(median(log_gaps))
    return sum(abs(value - center) for value in log_gaps)


def _repair_acoustic_repeat_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Repair one low-reliability rhythm outlier in two exact sections."""

    repaired = list(anchors)
    for left, right, length in _repeated_blocks(lines):
        if length < 3:
            continue
        offset = _repeat_offset_consensus(
            repaired,
            left,
            right,
            length,
        )
        if offset is None:
            continue
        current_imbalance = (
            _repeat_block_rhythm_cost(
                lines,
                repaired,
                left,
                length,
            )
            + _repeat_block_rhythm_cost(
                lines,
                repaired,
                right,
                length,
            )
        )
        if not math.isfinite(current_imbalance):
            # An already non-monotonic block has no meaningful rhythm cost.
            # In particular, inf - inf would become NaN and bypass the
            # minimum-improvement check below.
            continue
        block_proposals: list[
            tuple[
                float,
                float,
                float,
                int,
                int,
                int,
                int,
            ]
        ] = []
        for position in range(length):
            first_index = left + position
            second_index = right + position
            if (
                first_index == 0
                or second_index == 0
                or first_index + 1 >= len(repaired)
                or second_index + 1 >= len(repaired)
            ):
                continue
            first_anchor = repaired[first_index]
            second_anchor = repaired[second_index]
            if (
                first_anchor.method != "lexical"
                or second_anchor.method != "lexical"
            ):
                continue
            first_coverage = first_anchor.matched_units / max(
                1,
                first_anchor.total_units,
            )
            second_coverage = second_anchor.matched_units / max(
                1,
                second_anchor.total_units,
            )
            if (
                max(first_anchor.confidence, second_anchor.confidence)
                >= 0.75
                or max(first_coverage, second_coverage) >= 0.65
            ):
                # A bare acoustic peak must not displace two independent,
                # high-coverage lexical matches by several seconds. This
                # repair is reserved for matching partial ASR anchors.
                continue
            first_candidates = [
                int(candidate)
                for candidate in onset_indices
                if (
                    abs(times[candidate] - first_anchor.start) <= 5.0
                    and onset_scores[candidate] >= 9.0
                )
            ]
            second_candidates = [
                int(candidate)
                for candidate in onset_indices
                if (
                    abs(times[candidate] - second_anchor.start) <= 5.0
                    and onset_scores[candidate] >= 9.0
                )
            ]
            proposals: list[tuple[float, float, float, int, int]] = []
            for first_candidate in first_candidates:
                first_start = max(
                    0.0,
                    float(times[first_candidate]) - cue_lead_seconds,
                )
                if not (
                    repaired[first_index - 1].start + 0.28
                    <= first_start
                    <= repaired[first_index + 1].start - 0.28
                ):
                    continue
                if (
                    repaired[first_index - 1].confidence >= 0.5
                    and first_start
                    < repaired[first_index - 1].end + 0.05
                ):
                    continue
                for second_candidate in second_candidates:
                    second_start = max(
                        0.0,
                        float(times[second_candidate])
                        - cue_lead_seconds,
                    )
                    if not (
                        repaired[second_index - 1].start + 0.28
                        <= second_start
                        <= repaired[second_index + 1].start - 0.28
                    ):
                        continue
                    if (
                        repaired[second_index - 1].confidence >= 0.5
                        and second_start
                        < repaired[second_index - 1].end + 0.05
                    ):
                        continue
                    if abs(
                        (second_start - first_start) - offset
                    ) > 0.55:
                        continue
                    first_shift = first_start - first_anchor.start
                    second_shift = second_start - second_anchor.start
                    if (
                        abs(first_shift) < 2.5
                        or abs(second_shift) < 2.5
                        or first_shift * second_shift <= 0
                        or abs(first_shift - second_shift) > 0.7
                    ):
                        continue
                    imbalance = (
                        _repeat_block_rhythm_cost(
                            lines,
                            repaired,
                            left,
                            length,
                            {first_index: first_start},
                        )
                        + _repeat_block_rhythm_cost(
                            lines,
                            repaired,
                            right,
                            length,
                            {second_index: second_start},
                        )
                    )
                    proposals.append(
                        (
                            imbalance,
                            -float(
                                min(
                                    onset_scores[first_candidate],
                                    onset_scores[second_candidate],
                                )
                            ),
                            abs(first_shift) + abs(second_shift),
                            first_candidate,
                            second_candidate,
                        )
                    )
            if not proposals:
                continue
            (
                proposed_imbalance,
                _,
                _,
                first_candidate,
                second_candidate,
            ) = min(proposals)
            block_proposals.append(
                (
                    current_imbalance - proposed_imbalance,
                    proposed_imbalance,
                    -float(
                        min(
                            onset_scores[first_candidate],
                            onset_scores[second_candidate],
                        )
                    ),
                    first_index,
                    second_index,
                    first_candidate,
                    second_candidate,
                )
            )
        if not block_proposals:
            continue
        (
            improvement,
            _,
            _,
            first_index,
            second_index,
            first_candidate,
            second_candidate,
        ) = max(
            block_proposals,
            key=lambda item: (
                item[0],
                -item[1],
                -item[2],
            ),
        )
        if improvement < 0.8:
            continue
        for index, candidate in (
            (first_index, first_candidate),
            (second_index, second_candidate),
        ):
            anchor = repaired[index]
            start = max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + max(0.0, anchor.end - anchor.start),
                confidence=0.55,
                interpolated=False,
                method="acoustic_repeat_outlier",
                start_uncertainty=0.12,
            )
    return repaired


def _repair_repeat_offset_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Repair one occurrence that lands on the wrong copy of a refrain."""

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    for left, right, length in _repeated_blocks(lines):
        if length < 3:
            continue
        offset = _repeat_offset_consensus(
            repaired,
            left,
            right,
            length,
        )
        if offset is None:
            continue
        proposals: list[
            tuple[float, float, float, int, int]
        ] = []
        for position in range(length):
            first_index = left + position
            second_index = right + position
            first = repaired[first_index]
            second = repaired[second_index]
            first_weak = first.interpolated or first.confidence < 0.4
            second_weak = second.interpolated or second.confidence < 0.4
            # Two reliable anchors may intentionally use a different rhythm
            # in a later refrain.  At least one side must therefore be weak,
            # while two missing/weak counterparts still need acoustic repair.
            if not (first_weak or second_weak):
                continue
            difference = second.start - first.start
            current_deviation = abs(difference - offset)
            if current_deviation < 4.0:
                continue
            for target_index, predicted, block_start in (
                (first_index, second.start - offset, left),
                (second_index, first.start + offset, right),
            ):
                target = repaired[target_index]
                target_weak = (
                    target.interpolated
                    or target.confidence < 0.4
                    or target.method
                    in {
                        "monotonic_repair",
                        "overlap_repair",
                    }
                )
                if not target_weak:
                    continue
                adjacent_weak = any(
                    (
                        repaired[neighbor].interpolated
                        or repaired[neighbor].confidence < 0.4
                        or repaired[neighbor].method
                        in {
                            "monotonic_repair",
                            "overlap_repair",
                        }
                    )
                    for neighbor in (
                        target_index - 1,
                        target_index + 1,
                    )
                    if 0 <= neighbor < len(repaired)
                )
                if adjacent_weak:
                    # One misplaced counterpart can be repaired against its
                    # reliable copy. A whole missing run needs a joint repair;
                    # moving one row first destroys its cadence and later
                    # repeat transfer amplifies the error.
                    continue
                if abs(target.start - predicted) < 1.5:
                    continue
                previous = (
                    repaired[target_index - 1].start + 0.28
                    if target_index
                    else 0.0
                )
                following = (
                    repaired[target_index + 1].start - 0.28
                    if target_index + 1 < len(repaired)
                    else math.inf
                )
                if not previous <= predicted <= following:
                    continue
                for candidate in soft_indices:
                    start = max(
                        0.0,
                        float(times[candidate]) - cue_lead_seconds,
                    )
                    if (
                        abs(start - predicted) > 2.0
                        or not previous <= start <= following
                    ):
                        continue
                    proposed_difference = (
                        second.start - start
                        if block_start == left
                        else start - first.start
                    )
                    improvement = (
                        current_deviation
                        - abs(proposed_difference - offset)
                    )
                    score = (
                        improvement
                        - 0.45 * abs(start - predicted)
                        + 0.02 * float(onset_scores[candidate])
                    )
                    proposals.append(
                        (
                            score,
                            improvement,
                            -abs(start - predicted),
                            target_index,
                            int(candidate),
                        )
                    )
        if not proposals:
            continue
        (
            _,
            improvement,
            _,
            target_index,
            candidate,
        ) = max(proposals)
        if improvement < 2.5:
            continue
        anchor = repaired[target_index]
        start = max(
            0.0,
            float(times[candidate]) - cue_lead_seconds,
        )
        repaired[target_index] = replace(
            anchor,
            start=start,
            end=start + max(0.0, anchor.end - anchor.start),
            confidence=max(0.5, min(0.65, anchor.confidence)),
            interpolated=False,
            method="acoustic_repeat_offset_outlier",
            start_uncertainty=0.18,
        )
    return repaired


def _signature_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(
        None,
        left,
        right,
        autojunk=False,
    ).ratio()


def _sparse_repeat_windows(
    lines: list[TranscriptLine],
) -> list[tuple[int, int, int]]:
    """Find short repeated sections with stable lines around lyric variants."""

    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    windows: set[tuple[int, int, int]] = set()
    for offset in range(3, len(lines)):
        exact = [
            index
            for index in range(len(lines) - offset)
            if (
                signatures[index]
                and signatures[index] == signatures[index + offset]
            )
        ]
        cluster_start = 0
        while cluster_start < len(exact):
            cluster_end = cluster_start + 1
            while (
                cluster_end < len(exact)
                and exact[cluster_end] - exact[cluster_end - 1] <= 4
                and exact[cluster_end] - exact[cluster_start] <= 8
            ):
                cluster_end += 1
            cluster = exact[cluster_start:cluster_end]
            cluster_start = cluster_end
            if (
                len(cluster) != 2
                or cluster[1] - cluster[0] < 2
            ):
                continue
            left = cluster[0]
            end = cluster[-1] + 1
            while (
                end < len(lines) - offset
                and end - left < 8
                and _signature_similarity(
                    signatures[end],
                    signatures[end + offset],
                )
                >= 0.82
            ):
                end += 1
            while (
                left > 0
                and left - 1 + offset < len(lines)
                and end - (left - 1) < 8
                and _signature_similarity(
                    signatures[left - 1],
                    signatures[left - 1 + offset],
                )
                >= 0.82
            ):
                left -= 1
            length = end - left
            supported = sum(
                _signature_similarity(
                    signatures[left + position],
                    signatures[left + offset + position],
                )
                >= 0.82
                for position in range(length)
            )
            exact_count = sum(
                signatures[left + position]
                == signatures[left + offset + position]
                for position in range(length)
            )
            if (
                length >= 3
                and supported >= 3
                and exact_count == 2
            ):
                windows.add((left, left + offset, length))
    return sorted(windows, key=lambda item: (-item[2], item[0], item[1]))


def _local_rhythm_cost(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    index: int,
    proposed_start: float,
) -> float:
    if index == 0 or index + 1 >= len(anchors):
        return math.inf
    before = proposed_start - anchors[index - 1].start
    after = anchors[index + 1].start - proposed_start
    if before < 0.28 or after < 0.28:
        return math.inf
    before_weight = math.sqrt(
        max(1, len(lexical_values(lines[index - 1].text)))
    )
    after_weight = math.sqrt(
        max(1, len(lexical_values(lines[index].text)))
    )
    return abs(
        math.log(
            (before / before_weight)
            / (after / after_weight)
        )
    )


def _repair_acoustic_sparse_repeats(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Use paired entrances in choruses whose wording changes slightly."""

    repaired = list(anchors)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    for left, right, length in _sparse_repeat_windows(lines):
        offsets = [
            repaired[right + position].start
            - repaired[left + position].start
            for position in range(length)
            if (
                _signature_similarity(
                    signatures[left + position],
                    signatures[right + position],
                )
                >= 0.82
                and not repaired[left + position].interpolated
                and not repaired[right + position].interpolated
                and repaired[left + position].confidence >= 0.65
                and repaired[right + position].confidence >= 0.65
            )
        ]
        if len(offsets) < 2:
            continue
        offset = float(median(offsets))
        consistent = [
            value
            for value in offsets
            if abs(value - offset) <= 0.75
        ]
        if len(consistent) < 2:
            continue
        offset = float(median(consistent))

        remaining = set(range(length))
        while remaining:
            proposals: list[
                tuple[
                    float,
                    float,
                    float,
                    int,
                    int,
                    int,
                ]
            ] = []
            for position in remaining:
                first_index = left + position
                second_index = right + position
                if (
                    first_index == 0
                    or second_index == 0
                    or first_index + 1 >= len(repaired)
                    or second_index + 1 >= len(repaired)
                    or len(lexical_values(lines[first_index].text)) <= 2
                ):
                    continue
                first_anchor = repaired[first_index]
                second_anchor = repaired[second_index]
                if (
                    first_anchor.method != "lexical"
                    or second_anchor.method != "lexical"
                ):
                    continue
                current_cost = (
                    _local_rhythm_cost(
                        lines,
                        repaired,
                        first_index,
                        first_anchor.start,
                    )
                    + _local_rhythm_cost(
                        lines,
                        repaired,
                        second_index,
                        second_anchor.start,
                    )
                )
                first_candidates = [
                    int(candidate)
                    for candidate in onset_indices
                    if (
                        abs(
                            times[candidate] - first_anchor.start
                        )
                        <= 5.0
                        and onset_scores[candidate] >= 9.0
                    )
                ]
                second_candidates = [
                    int(candidate)
                    for candidate in onset_indices
                    if (
                        abs(
                            times[candidate] - second_anchor.start
                        )
                        <= 5.0
                        and onset_scores[candidate] >= 9.0
                    )
                ]
                for first_candidate in first_candidates:
                    first_start = max(
                        0.0,
                        float(times[first_candidate])
                        - cue_lead_seconds,
                    )
                    for second_candidate in second_candidates:
                        second_start = max(
                            0.0,
                            float(times[second_candidate])
                            - cue_lead_seconds,
                        )
                        if abs(
                            (second_start - first_start) - offset
                        ) > 0.75:
                            continue
                        proposed_cost = (
                            _local_rhythm_cost(
                                lines,
                                repaired,
                                first_index,
                                first_start,
                            )
                            + _local_rhythm_cost(
                                lines,
                                repaired,
                                second_index,
                                second_start,
                            )
                        )
                        improvement = current_cost - proposed_cost
                        if improvement < 0.45:
                            continue
                        distance = (
                            abs(first_start - first_anchor.start)
                            + abs(second_start - second_anchor.start)
                        )
                        support = float(
                            min(
                                onset_scores[first_candidate],
                                onset_scores[second_candidate],
                            )
                        )
                        proposals.append(
                            (
                                improvement,
                                -proposed_cost,
                                support - 0.2 * distance,
                                position,
                                first_candidate,
                                second_candidate,
                            )
                        )
            if not proposals:
                break
            (
                _,
                _,
                _,
                position,
                first_candidate,
                second_candidate,
            ) = max(proposals)
            for index, candidate in (
                (left + position, first_candidate),
                (right + position, second_candidate),
            ):
                anchor = repaired[index]
                start = max(
                    0.0,
                    float(times[candidate]) - cue_lead_seconds,
                )
                repaired[index] = replace(
                    anchor,
                    start=start,
                    end=start + max(0.0, anchor.end - anchor.start),
                    confidence=0.55,
                    interpolated=False,
                    method="acoustic_sparse_repeat",
                    start_uncertainty=0.12,
                )
            remaining.remove(position)
    return repaired


def _repair_stretched_lexical_bridges(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    post_db: np.ndarray,
    noise_floor_db: float,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Split a falsely stretched lexical span across omitted lyric rows.

    Whisper can recognize a closing lyric with every word present while
    stretching those word timestamps across several omitted call/response
    rows.  The closing anchor then starts before the preceding rows and makes
    the final axis non-monotonic even though its end remains useful.  Repair
    only the uniquely constrained form: at least two collapsed weak rows,
    followed by a full-coverage high-confidence lexical span of six seconds
    or more, with one energetic soft onset per row and a plausible closing
    duration.
    """

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    for closing_index, closing in enumerate(repaired):
        if (
            closing.method != "lexical"
            or closing.confidence < 0.8
            or closing.matched_units != closing.total_units
            or closing.end - closing.start < 6.0
        ):
            continue

        run_start = closing_index
        while run_start > 0:
            candidate = repaired[run_start - 1]
            if not (
                candidate.interpolated
                or candidate.confidence < 0.3
            ):
                break
            run_start -= 1
        weak_count = closing_index - run_start
        if weak_count < 2 or run_start == 0:
            continue

        previous = repaired[run_start - 1]
        weak_starts = [
            repaired[index].start
            for index in range(run_start, closing_index)
        ]
        if (
            closing.start > previous.end + 0.75
            or max(weak_starts) - min(weak_starts) > 0.75
        ):
            continue

        lower = (
            max(
                previous.start + 0.28,
                previous.end - 0.15,
            )
            + cue_lead_seconds
        )
        upper = closing.end + cue_lead_seconds
        usable = [
            int(candidate)
            for candidate in soft_indices
            if lower <= times[candidate] <= upper
            and post_db[candidate] >= noise_floor_db + 5.0
        ]
        groups: list[list[int]] = []
        for candidate in usable:
            if (
                groups
                and times[candidate] - times[groups[-1][-1]]
                <= 0.6
            ):
                groups[-1].append(candidate)
            else:
                groups.append([candidate])
        representatives = [
            max(
                group,
                key=lambda candidate: onset_scores[candidate],
            )
            for group in groups
        ]
        if len(representatives) <= weak_count:
            continue

        selected = representatives[: weak_count + 1]
        starts = [
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            for candidate in selected
        ]
        if any(
            right - left < 0.7
            for left, right in zip(starts, starts[1:])
        ):
            continue

        closing_start = starts[-1]
        target_duration = min(
            3.2,
            max(1.2, 0.42 * closing.total_units),
        )
        closing_duration = closing.end - closing_start
        if (
            closing_start - closing.start < 2.5
            or abs(closing_duration - target_duration) > 0.8
            or closing_duration < 0.35
        ):
            continue

        for offset, start in enumerate(starts[:-1]):
            index = run_start + offset
            anchor = repaired[index]
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + max(0.0, anchor.end - anchor.start),
                confidence=0.45,
                interpolated=False,
                method="acoustic_stretched_bridge",
                start_uncertainty=0.18,
            )
        repaired[closing_index] = replace(
            closing,
            start=closing_start,
            confidence=max(0.55, min(0.7, closing.confidence)),
            interpolated=False,
            method="acoustic_stretched_bridge",
            start_uncertainty=0.18,
        )
    return repaired


def _repair_unclaimed_segment_prefixes(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    post_db: np.ndarray,
    noise_floor_db: float,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Refine a recovered skipped-segment boundary to nearby vocal onset."""

    repaired = list(anchors)
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    for index, anchor in enumerate(anchors):
        if (
            anchor.acoustic_start_hint is None
            or anchor.method != "lexical"
        ):
            continue
        hint = max(0.0, anchor.acoustic_start_hint)
        candidates = [
            int(candidate)
            for candidate in soft_indices
            if hint - 1.0 <= times[candidate] <= hint + 0.25
            and onset_scores[candidate] >= 6.0
            and post_db[candidate] >= noise_floor_db + 5.0
        ]
        if not candidates:
            start = hint
        else:
            candidate = max(
                candidates,
                key=lambda item: (
                    onset_scores[item]
                    - 2.0 * abs(times[item] - hint),
                    post_db[item],
                ),
            )
            start = max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
        if index > 0 and start < repaired[index - 1].start + 0.28:
            continue
        repaired[index] = replace(
            anchor,
            start=start,
            # The original end still contains the reliable matched suffix.
            end=max(start, anchor.end),
            confidence=max(0.5, min(0.65, anchor.confidence)),
            interpolated=False,
            method="acoustic_unclaimed_prefix",
            start_uncertainty=0.12,
        )
    return repaired


def _repair_unclaimed_trailing_pattern(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Rebuild a short repeated outro from a skipped-ASR entrance hint.

    This is deliberately narrower than the generic trailing-activity repair.
    It requires four to six weak final rows, a period-two textual pattern, a
    reliable preceding cadence, and an observed onset for every proposed row.
    The first entrance must already have been recovered from an ASR segment
    that the lexical mapper skipped, so instrumental onsets alone cannot
    activate the repair.
    """

    repaired = list(anchors)
    run_start = next(
        (
            index
            for index, anchor in enumerate(repaired)
            if anchor.acoustic_start_hint is not None
            and index + 4 <= len(repaired) <= index + 6
        ),
        None,
    )
    if run_start is None or run_start == 0:
        return repaired
    count = len(repaired) - run_start
    first = repaired[run_start]
    if first.method != "acoustic_unclaimed_prefix":
        return repaired

    def weak(candidate: CoarseLineAnchor) -> bool:
        coverage = candidate.matched_units / max(
            1,
            candidate.total_units,
        )
        return (
            candidate.interpolated
            or (
                coverage <= 0.5
                and candidate.confidence <= 0.65
            )
        )

    if not all(weak(candidate) for candidate in repaired[run_start:]):
        return repaired

    values = [
        primary_lexical_values(lines[index].text)
        for index in range(run_start, len(lines))
    ]
    if any(not item for item in values):
        return repaired

    period_two_support = sum(
        SequenceMatcher(
            None,
            values[position],
            values[position + 2],
            autojunk=False,
        ).ratio()
        >= 0.72
        for position in range(count - 2)
    )
    if period_two_support != count - 2:
        return repaired

    prior_gaps: list[float] = []
    for index in range(max(1, run_start - 8), run_start):
        left = repaired[index - 1]
        right = repaired[index]
        left_coverage = left.matched_units / max(1, left.total_units)
        right_coverage = right.matched_units / max(1, right.total_units)
        gap = right.start - left.start
        if (
            not left.interpolated
            and not right.interpolated
            and left.confidence >= 0.6
            and right.confidence >= 0.6
            and left_coverage >= 0.65
            and right_coverage >= 0.65
            and left.start_uncertainty <= 1.0
            and right.start_uncertainty <= 1.0
            and 1.2 <= gap <= 8.0
        ):
            prior_gaps.append(gap)
    if len(prior_gaps) < 3:
        return repaired
    prior_period = float(median(prior_gaps[-6:]))

    origin = first.start
    soft_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=3.5,
    )
    candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
        if (
            origin + 0.5
            <= times[index] - cue_lead_seconds
            <= origin + count * prior_period + 1.0
        )
    ]
    if len(candidates) < count - 1:
        return repaired

    period_lower = max(1.2, 0.9 * prior_period)
    period_upper = min(8.0, 1.1 * prior_period)
    period_steps = max(
        1,
        math.floor((period_upper - period_lower) / 0.01) + 1,
    )
    tolerance = max(0.55, min(0.8, 0.18 * prior_period))
    best: tuple[float, float, list[float]] | None = None
    for step in range(period_steps):
        period = period_lower + 0.01 * step
        selected = [origin]
        score = -12.0 * abs(period - prior_period)
        for position in range(1, count):
            target = origin + position * period
            options = [
                (
                    0.2 * min(candidate_score, 20.0)
                    - 18.0 * abs(candidate_start - target)
                    - 8.0
                    * abs(
                        (candidate_start - selected[-1])
                        - period
                    ),
                    candidate_start,
                )
                for candidate_start, candidate_score in candidates
                if (
                    candidate_start >= selected[-1] + 0.5
                    and abs(candidate_start - target) <= tolerance
                    and abs(
                        (candidate_start - selected[-1]) - period
                    )
                    <= tolerance + 0.15
                )
            ]
            if not options:
                selected = []
                break
            local_score, candidate_start = max(options)
            score += local_score
            selected.append(candidate_start)
        if len(selected) != count:
            continue
        proposal = (score, period, selected)
        if best is None or proposal[0] > best[0]:
            best = proposal
    if best is None:
        return repaired

    _, fitted_period, proposed = best
    current = [
        repaired[index].start
        for index in range(run_start, len(repaired))
    ]

    def cadence_error(path: list[float]) -> float:
        return sum(
            abs((right - left) - fitted_period)
            for left, right in zip(path, path[1:])
        )

    shifted = sum(
        abs(new - old) >= 2.0
        for new, old in zip(proposed, current, strict=True)
    )
    if (
        shifted < 2
        or cadence_error(current) - cadence_error(proposed)
        < max(3.0, 0.8 * prior_period)
        or max(
            abs((right - left) - fitted_period)
            for left, right in zip(proposed, proposed[1:])
        )
        > tolerance + 0.15
    ):
        return repaired

    for position in range(count):
        index = run_start + position
        anchor = repaired[index]
        start = proposed[position]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if position + 1 < count:
            end = min(end, proposed[position + 1])
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.58,
            interpolated=False,
            method="acoustic_unclaimed_trailing_pattern",
            start_uncertainty=0.22,
        )
    return repaired


def _repair_stretched_second_word_hints(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
    reference_anchors: list[CoarseLineAnchor] | None = None,
) -> tuple[list[CoarseLineAnchor], int]:
    """Consume a late lexical entrance only after structural repair.

    A long second ASR word can absorb a preceding vocalization and make the
    lyric appear several seconds early. The lexical matcher records a robust
    later alternative, but applying it before repeat/cadence repair can destroy
    an already-correct repeated section. Consume it here only when every prior
    structural pass left the row as an ordinary lexical or generic acoustic
    anchor.
    """

    repaired = list(anchors)
    repaired_count = 0
    cue_lead = max(0.0, cue_lead_seconds)
    for index, anchor in enumerate(anchors):
        hint = anchor.stretched_second_start_hint
        if (
            hint is None
            or anchor.method not in {"lexical", "acoustic_onset"}
        ):
            continue
        if (
            reference_anchors is not None
            and len(reference_anchors) == len(anchors)
            and 0 < index < len(anchors) - 1
        ):
            reference = reference_anchors[index]
            previous = reference_anchors[index - 1]
            following = reference_anchors[index + 1]

            def exact_lexical(
                item: CoarseLineAnchor,
                *,
                confidence: float,
            ) -> bool:
                return (
                    not item.interpolated
                    and item.method.startswith("lexical")
                    and item.confidence >= confidence
                    and item.start_uncertainty <= 0.8
                    and item.matched_units == item.total_units
                    and item.total_units > 0
                )

            if (
                exact_lexical(reference, confidence=0.93)
                and exact_lexical(previous, confidence=0.95)
                and exact_lexical(following, confidence=0.95)
                and abs(reference.start - previous.end) <= 0.08
            ):
                # Three exact lexical rows form an independently supported
                # ASR chain.  In this shape a long second word can be a real
                # sustained lyric, while the later hint points at an internal
                # syllable.  Preserve the original boundary instead of
                # overriding all three mutually consistent word matches.
                continue
        expected_onset = hint + cue_lead
        candidates = [
            int(candidate)
            for candidate in onset_indices
            if expected_onset - 0.3
            <= times[candidate]
            <= expected_onset + 1.25
        ]
        if candidates:
            candidate = max(
                candidates,
                key=lambda item: (
                    onset_scores[item]
                    - 4.0 * abs(times[item] - expected_onset),
                    -abs(times[item] - expected_onset),
                ),
            )
            start = max(0.0, float(times[candidate]) - cue_lead)
        else:
            start = max(0.0, hint)
        if start < anchor.start + 1.0:
            continue
        if index > 0 and start < repaired[index - 1].start + 0.28:
            continue
        if (
            index + 1 < len(repaired)
            and start > repaired[index + 1].start - 0.28
        ):
            continue
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, anchor.end),
            confidence=max(0.55, min(0.7, anchor.confidence)),
            interpolated=False,
            method="acoustic_stretched_second",
            start_uncertainty=0.12,
        )
        repaired_count += 1
    return repaired, repaired_count


def _reinterpolate_stale_weak_runs(
    reference_anchors: list[CoarseLineAnchor],
    anchors: list[CoarseLineAnchor],
) -> tuple[list[CoarseLineAnchor], int]:
    """Rebase untouched interpolation after a boundary was repaired.

    Generic interpolation happens before acoustic repeat/template repair. If a
    later structural pass moves either bounding row by several seconds, an
    untouched weak run can retain the obsolete spacing and become the largest
    error in the song. Recompute only pure, still-untouched interpolated runs,
    and require every row to move meaningfully so tiny cadence adjustments do
    not churn an otherwise stable axis.
    """

    if len(reference_anchors) != len(anchors):
        return list(anchors), 0
    repaired = list(anchors)
    repaired_count = 0
    index = 0
    while index < len(anchors):
        anchor = anchors[index]
        reference = reference_anchors[index]
        untouched = (
            anchor.interpolated
            and anchor.method == "interpolated"
            and abs(anchor.start - reference.start) < 0.08
        )
        if not untouched:
            index += 1
            continue
        run_start = index
        while index < len(anchors):
            current = anchors[index]
            original = reference_anchors[index]
            if not (
                current.interpolated
                and current.method == "interpolated"
                and abs(current.start - original.start) < 0.08
            ):
                break
            index += 1
        run_end = index
        if run_start == 0 or run_end >= len(anchors):
            continue
        left_index = run_start - 1
        right_index = run_end
        boundary_shift = max(
            abs(
                anchors[left_index].start
                - reference_anchors[left_index].start
            ),
            abs(
                anchors[right_index].start
                - reference_anchors[right_index].start
            ),
        )
        if boundary_shift < 0.5:
            continue
        left_start = repaired[left_index].start
        right_start = repaired[right_index].start
        span = right_index - left_index
        candidates = [
            left_start
            + (right_start - left_start)
            * (position - left_index)
            / span
            for position in range(run_start, run_end)
        ]
        if (
            right_start - left_start < 0.28 * span
            or any(
                abs(candidate - anchors[position].start) < 0.12
                for position, candidate in zip(
                    range(run_start, run_end),
                    candidates,
                    strict=True,
                )
            )
        ):
            continue
        for position, candidate in zip(
            range(run_start, run_end),
            candidates,
            strict=True,
        ):
            repaired[position] = replace(
                anchors[position],
                start=candidate,
                end=candidate,
                method="interpolated_rebased",
            )
            repaired_count += 1
    return repaired, repaired_count


def _rebase_stale_acoustic_gap_clusters(
    reference_anchors: list[CoarseLineAnchor],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    post_db: np.ndarray,
    noise_floor_db: float,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> tuple[list[CoarseLineAnchor], int]:
    """Rebuild a gap cluster after later repairs move its boundaries.

    Gap clusters are claimed early in the acoustic pipeline.  A fragment or
    repeat repair can subsequently move both surrounding anchors while the
    claimed internal onsets retain their old placement.  Revisit only a
    clearly stale, originally weak run for which the final interval exposes
    exactly one separated activity group per lyric row.
    """

    if len(reference_anchors) != len(anchors):
        return list(anchors), 0

    repaired = list(anchors)
    repaired_count = 0
    run_start = 0
    while run_start < len(anchors):
        if anchors[run_start].method != "acoustic_gap_cluster":
            run_start += 1
            continue
        run_end = run_start + 1
        while (
            run_end < len(anchors)
            and anchors[run_end].method == "acoustic_gap_cluster"
        ):
            run_end += 1

        count = run_end - run_start
        if (
            count < 2
            or run_start == 0
            or run_end >= len(anchors)
            or not all(
                reference_anchors[index].interpolated
                or reference_anchors[index].confidence < 0.3
                for index in range(run_start, run_end)
            )
        ):
            run_start = run_end
            continue

        left_shift = (
            anchors[run_start - 1].start
            - reference_anchors[run_start - 1].start
        )
        right_shift = (
            anchors[run_end].start
            - reference_anchors[run_end].start
        )
        if (
            max(abs(left_shift), abs(right_shift)) < 2.0
            or left_shift * right_shift < -0.25
        ):
            run_start = run_end
            continue

        left = anchors[run_start - 1]
        right = anchors[run_end]
        lower = (
            max(left.start + 0.8, left.end + 0.15)
            + cue_lead_seconds
        )
        upper = right.start + cue_lead_seconds - 0.8
        usable = [
            int(index)
            for index in onset_indices
            if lower <= times[index] <= upper
            and onset_scores[index] >= 9.0
        ]
        groups: list[list[int]] = []
        for index in usable:
            if (
                groups
                and times[index] - times[groups[-1][-1]] <= 0.8
            ):
                groups[-1].append(index)
            else:
                groups.append([index])
        if len(groups) != count:
            run_start = run_end
            continue

        selected = [
            max(
                group,
                key=lambda index: (
                    onset_scores[index]
                    + 0.5 * (post_db[index] - noise_floor_db)
                ),
            )
            for group in groups
        ]
        proposed = [
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            )
            for index in selected
        ]
        current = [
            anchors[index].start
            for index in range(run_start, run_end)
        ]
        expected_gap = (right.start - left.start) / (count + 1)
        if expected_gap < 0.8:
            run_start = run_end
            continue

        def cadence_cost(starts: list[float]) -> float:
            gaps = (
                [starts[0] - left.start]
                + [
                    later - earlier
                    for earlier, later in zip(
                        starts,
                        starts[1:],
                        strict=False,
                    )
                ]
                + [right.start - starts[-1]]
            )
            return sum(abs(gap - expected_gap) for gap in gaps)

        current_cost = cadence_cost(current)
        proposed_cost = cadence_cost(proposed)
        if (
            proposed_cost > 0.6 * current_cost
            or any(
                abs(before - after) < 0.12
                for before, after in zip(
                    current,
                    proposed,
                    strict=True,
                )
            )
        ):
            run_start = run_end
            continue

        for offset, start in enumerate(proposed):
            index = run_start + offset
            anchor = anchors[index]
            duration = max(0.0, anchor.end - anchor.start)
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + duration,
                confidence=0.5,
                interpolated=False,
                method="acoustic_gap_cluster_rebased",
                start_uncertainty=0.15,
            )
            repaired_count += 1
        run_start = run_end

    return repaired, repaired_count


def _repair_stale_overlap_runs(
    reference_anchors: list[CoarseLineAnchor],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    post_db: np.ndarray,
    noise_floor_db: float,
    *,
    cue_lead_seconds: float,
) -> tuple[list[CoarseLineAnchor], int]:
    """Rebuild a mixed overlap/interpolation run after a boundary moves.

    Chronological merge can push the first missed row to the end of a
    falsely late lexical span and label it ``overlap_repair``.  If repeat
    consensus later fixes that lexical boundary, the overlap row and its
    following interpolated rows retain their stale placement.  Recover only
    multi-row runs whose final interval contains a complete, monotonic path
    of nearby soft vocal onsets.
    """

    if len(reference_anchors) != len(anchors):
        return list(anchors), 0
    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return list(anchors), 0

    repaired = list(anchors)
    repaired_count = 0
    run_start = 0
    while run_start < len(anchors):
        anchor = anchors[run_start]
        reference = reference_anchors[run_start]
        unchanged_overlap = (
            anchor.interpolated
            and anchor.method == "overlap_repair"
            and reference.method == "overlap_repair"
            and abs(anchor.start - reference.start) < 0.08
        )
        if not unchanged_overlap:
            run_start += 1
            continue

        run_end = run_start + 1
        while run_end < len(anchors):
            current = anchors[run_end]
            original = reference_anchors[run_end]
            unchanged_interpolation = (
                current.interpolated
                and current.method == "interpolated"
                and original.method == "interpolated"
                and abs(current.start - original.start) < 0.08
            )
            if not unchanged_interpolation:
                break
            run_end += 1

        count = run_end - run_start
        if (
            count < 2
            or run_start == 0
            or run_end >= len(anchors)
        ):
            run_start = run_end
            continue

        boundary_shift = max(
            abs(
                anchors[run_start - 1].start
                - reference_anchors[run_start - 1].start
            ),
            abs(
                anchors[run_end].start
                - reference_anchors[run_end].start
            ),
        )
        if boundary_shift < 2.0:
            run_start = run_end
            continue

        left = anchors[run_start - 1]
        right = anchors[run_end]
        expected_gap = (right.start - left.start) / (count + 1)
        if expected_gap < 0.8:
            run_start = run_end
            continue
        targets = [
            left.start + expected_gap * (offset + 1)
            for offset in range(count)
        ]
        pools: list[list[int]] = []
        for target in targets:
            pool = [
                int(candidate)
                for candidate in soft_indices
                if left.start + 0.28
                <= times[candidate] - cue_lead_seconds
                <= right.start - 0.28
                and abs(
                    times[candidate]
                    - cue_lead_seconds
                    - target
                )
                <= 1.2
                and onset_scores[candidate] >= 5.5
                and post_db[candidate] >= noise_floor_db + 5.0
            ]
            if not pool:
                break
            pools.append(pool)
        if len(pools) != count:
            run_start = run_end
            continue

        scores: list[dict[int, float]] = []
        traces: list[dict[int, int | None]] = []
        for position, pool in enumerate(pools):
            row_scores: dict[int, float] = {}
            row_traces: dict[int, int | None] = {}
            for candidate in pool:
                local_score = float(
                    onset_scores[candidate]
                    - 2.0
                    * abs(
                        times[candidate]
                        - cue_lead_seconds
                        - targets[position]
                    )
                )
                if position == 0:
                    row_scores[candidate] = local_score
                    row_traces[candidate] = None
                    continue
                compatible = [
                    previous
                    for previous in scores[-1]
                    if times[previous] + 0.28 <= times[candidate]
                ]
                if not compatible:
                    continue
                previous = max(
                    compatible,
                    key=lambda item: scores[-1][item],
                )
                row_scores[candidate] = (
                    scores[-1][previous] + local_score
                )
                row_traces[candidate] = previous
            if not row_scores:
                break
            scores.append(row_scores)
            traces.append(row_traces)
        if len(scores) != count:
            run_start = run_end
            continue

        candidate = max(scores[-1], key=scores[-1].get)
        selected: list[int] = []
        for position in range(count - 1, -1, -1):
            selected.append(candidate)
            previous = traces[position][candidate]
            if previous is not None:
                candidate = previous
        selected.reverse()
        proposed = [
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            for candidate in selected
        ]
        current = [
            anchors[index].start
            for index in range(run_start, run_end)
        ]

        def cadence_cost(starts: list[float]) -> float:
            gaps = (
                [starts[0] - left.start]
                + [
                    later - earlier
                    for earlier, later in zip(
                        starts,
                        starts[1:],
                        strict=False,
                    )
                ]
                + [right.start - starts[-1]]
            )
            return sum(abs(gap - expected_gap) for gap in gaps)

        if (
            cadence_cost(proposed) > 0.6 * cadence_cost(current)
            or any(
                abs(before - after) < 0.12
                for before, after in zip(
                    current,
                    proposed,
                    strict=True,
                )
            )
        ):
            run_start = run_end
            continue

        for offset, start in enumerate(proposed):
            index = run_start + offset
            current_anchor = anchors[index]
            duration = max(
                0.0,
                current_anchor.end - current_anchor.start,
            )
            repaired[index] = replace(
                current_anchor,
                start=start,
                end=start + duration,
                confidence=0.5,
                interpolated=False,
                method="acoustic_overlap_run_rebased",
                start_uncertainty=0.15,
            )
            repaired_count += 1
        run_start = run_end

    return repaired, repaired_count


def _repair_shifted_dense_onset_runs(
    lines: list[TranscriptLine],
    reference_anchors: list[CoarseLineAnchor],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> tuple[list[CoarseLineAnchor], int]:
    """Shift a dense three-row onset path back onto an unclaimed entrance.

    When ASR skips the first phrase of a dense run, each following lyric can
    claim the next phrase's onset.  Recover only a complete three-row chain:
    an unused strong onset must precede two already selected onsets, all three
    shifts must agree, at least two original anchors must be weak, and moving
    the chain must materially improve the four surrounding cadence gaps.
    """

    if (
        len(lines) != len(reference_anchors)
        or len(lines) != len(anchors)
    ):
        return list(anchors), 0

    repaired = list(anchors)
    repaired_count = 0
    run_start = 1
    while run_start + 3 < len(repaired):
        indices = range(run_start, run_start + 3)
        if not all(
            repaired[index].method == "acoustic_onset"
            for index in indices
        ):
            run_start += 1
            continue

        weak_count = sum(
            (
                reference_anchors[index].interpolated
                or reference_anchors[index].confidence < 0.5
                or (
                    reference_anchors[index].matched_units
                    / max(1, reference_anchors[index].total_units)
                    < 0.7
                )
            )
            for index in indices
        )
        if weak_count < 2:
            run_start += 1
            continue

        current = [
            repaired[index].start
            for index in indices
        ]

        def has_selected_onset(start: float) -> bool:
            return any(
                onset_scores[candidate] >= 9.0
                and abs(
                    (
                        float(times[candidate])
                        - cue_lead_seconds
                    )
                    - start
                )
                <= 0.18
                for candidate in onset_indices
            )

        if not all(
            has_selected_onset(start)
            for start in current[:2]
        ):
            run_start += 1
            continue

        previous = repaired[run_start - 1].start
        following = repaired[run_start + 3].start
        proposals: list[
            tuple[float, float, float, list[float]]
        ] = []
        for candidate in onset_indices:
            first = max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            if (
                onset_scores[candidate] < 12.0
                or first < previous + 0.28
                or first > current[0] - 2.0
            ):
                continue
            shifts = [
                current[0] - first,
                current[1] - current[0],
                current[2] - current[1],
            ]
            if (
                min(shifts) < 2.0
                or max(shifts) > 4.5
                or max(shifts) - min(shifts) > 0.6
            ):
                continue

            proposed = [first, current[0], current[1]]
            if following - proposed[-1] < 0.28:
                continue
            current_gaps = [
                current[0] - previous,
                current[1] - current[0],
                current[2] - current[1],
                following - current[2],
            ]
            proposed_gaps = [
                proposed[0] - previous,
                proposed[1] - proposed[0],
                proposed[2] - proposed[1],
                following - proposed[2],
            ]
            cadence_improvement = (
                max(current_gaps)
                - min(current_gaps)
                - max(proposed_gaps)
                + min(proposed_gaps)
            )
            if cadence_improvement < 1.0:
                continue
            proposals.append(
                (
                    cadence_improvement,
                    -(
                        max(shifts) - min(shifts)
                    ),
                    float(onset_scores[candidate]),
                    proposed,
                )
            )
        if not proposals:
            run_start += 1
            continue

        _, _, _, proposed = max(proposals)
        for index, start in zip(
            indices,
            proposed,
            strict=True,
        ):
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + duration,
                confidence=max(0.5, min(0.6, anchor.confidence)),
                interpolated=False,
                method="acoustic_shifted_onset_run",
                start_uncertainty=0.12,
            )
            repaired_count += 1
        run_start += 3

    return repaired, repaired_count


def _repair_acoustic_gap_clusters(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Keep a weak lyric run out of a long instrumental gap."""

    repaired = list(anchors)
    run_start = 0
    while run_start < len(repaired):
        weak = (
            repaired[run_start].interpolated
            or repaired[run_start].confidence < 0.3
        )
        if not weak:
            run_start += 1
            continue
        run_end = run_start + 1
        while (
            run_end < len(repaired)
            and (
                repaired[run_end].interpolated
                or repaired[run_end].confidence < 0.3
            )
        ):
            run_end += 1
        count = run_end - run_start
        if (
            count < 2
            or run_start == 0
            or run_end >= len(repaired)
        ):
            run_start = run_end
            continue

        previous_anchor = repaired[run_start - 1]
        lower = (
            max(
                previous_anchor.start + 0.28,
                previous_anchor.end + 0.05,
            )
            + cue_lead_seconds
        )
        upper = (
            repaired[run_end].start
            + cue_lead_seconds
            - 0.28
        )
        usable = [
            int(index)
            for index in onset_indices
            if lower <= times[index] <= upper
            and onset_scores[index] >= 9.0
        ]
        clusters: list[list[int]] = []
        for index in usable:
            if (
                clusters
                and times[index] - times[clusters[-1][-1]] <= 5.0
            ):
                clusters[-1].append(index)
            else:
                clusters.append([index])
        if len(clusters) >= count:
            # A long instrumental gap can contain one vocal island per
            # missing lyric. The old single-cluster rule consumed every row
            # from the first island and ignored a later, clearer entrance.
            selected = []
            for item in clusters[:count]:
                early = [
                    candidate
                    for candidate in item
                    if times[candidate] <= times[item[0]] + 0.8
                ]
                selected.append(
                    max(
                        early,
                        key=lambda candidate: onset_scores[candidate],
                    )
                )
        else:
            cluster = next(
                (
                    item
                    for item in clusters
                    if len(item) >= count
                    and (
                        upper - times[item[-1]] >= 6.0
                        or times[item[0]] - lower >= 6.0
                    )
                ),
                None,
            )
            if cluster is None:
                run_start = run_end
                continue

            if count == 2:
                selected = [cluster[0], cluster[-1]]
            else:
                expected = np.linspace(
                    times[cluster[0]],
                    times[cluster[-1]],
                    count,
                )
                selected = []
                minimum_position = 0
                for target in expected:
                    remaining = count - len(selected) - 1
                    maximum_position = len(cluster) - remaining
                    position = min(
                        range(minimum_position, maximum_position),
                        key=lambda item: abs(
                            times[cluster[item]] - target
                        ),
                    )
                    selected.append(cluster[position])
                    minimum_position = position + 1
        if count >= 2:
            proposed_starts = [
                max(
                    0.0,
                    float(times[candidate]) - cue_lead_seconds,
                )
                for candidate in selected
            ]
            original_starts = [
                repaired[index].start
                for index in range(run_start, run_end)
            ]
            following_start = repaired[run_end].start
            proposed_span = (
                proposed_starts[-1] - proposed_starts[0]
            )
            original_span = (
                original_starts[-1] - original_starts[0]
            )
            proposed_following_gap = (
                following_start - proposed_starts[-1]
            )
            original_following_gap = (
                following_start - original_starts[-1]
            )
            proposed_preceding_gap = (
                proposed_starts[0] - previous_anchor.start
            )
            original_preceding_gap = (
                original_starts[0] - previous_anchor.start
            )
            compressed_into_early_island = (
                count >= 3
                and proposed_following_gap
                > max(6.0, original_following_gap + 4.0)
                and proposed_span < 0.65 * original_span
            )
            worsened_boundary_imbalance = (
                proposed_following_gap > original_following_gap + 3.5
                and abs(proposed_preceding_gap - proposed_following_gap)
                > abs(original_preceding_gap - original_following_gap) + 3.5
            )
            if (
                compressed_into_early_island
                or worsened_boundary_imbalance
            ):
                # Do not squeeze an evenly distributed coarse run into one
                # early activity island, or shift a whole block early enough
                # to manufacture a much more imbalanced pair of boundary
                # gaps. Continuous singing need not expose an onset per row.
                run_start = run_end
                continue
        for offset, candidate in enumerate(selected):
            index = run_start + offset
            anchor = repaired[index]
            start = max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + max(0.0, anchor.end - anchor.start),
                confidence=0.4,
                interpolated=False,
                method="acoustic_gap_cluster",
                start_uncertainty=0.15,
            )
        run_start = run_end
    return repaired


def _repair_dense_trailing_prefix(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover the first phrase group of a dense, fragmented outro."""

    repaired = list(anchors)
    run_start = len(repaired)
    while run_start > 0:
        anchor = repaired[run_start - 1]
        if not (anchor.interpolated or anchor.confidence < 0.65):
            break
        run_start -= 1
    count = len(repaired) - run_start
    if (
        count < 8
        or run_start == 0
        or not lines[run_start].blank_before
        or not len(onset_indices)
    ):
        return repaired
    first_units = sorted(
        len(lexical_values(lines[index].text))
        for index in range(run_start, run_start + 4)
    )
    if (first_units[1] + first_units[2]) / 2.0 > 7.0:
        return repaired

    previous = repaired[run_start - 1]
    if (
        previous.interpolated
        or previous.confidence < 0.75
        or previous.start_uncertainty > 1.0
    ):
        return repaired
    recent_gaps = [
        repaired[index].start - repaired[index - 1].start
        for index in range(max(1, run_start - 5), run_start)
        if (
            not repaired[index].interpolated
            and not repaired[index - 1].interpolated
            and repaired[index].confidence >= 0.7
            and repaired[index - 1].confidence >= 0.7
            and 0.8
            <= repaired[index].start
            - repaired[index - 1].start
            <= 6.0
        )
    ]
    if len(recent_gaps) < 3:
        return repaired
    period = float(median(recent_gaps[-4:]))
    if (
        not 1.5 <= period <= 6.0
        or repaired[run_start].start - previous.start
        <= 2.2 * period
    ):
        return repaired

    lower = previous.start + 0.28
    if previous.end > previous.start + 0.05:
        lower = max(lower, previous.end + 0.05)
    tolerance = max(1.1, 0.35 * period)
    upper = previous.start + 5.0 * period + tolerance
    candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in onset_indices
        if lower
        <= times[index] - cue_lead_seconds
        <= upper
    ]
    states: list[tuple[float, list[float]]] = []
    for position in range(4):
        target = previous.start + (position + 1) * period
        next_states: list[tuple[float, list[float]]] = []
        for candidate_start, candidate_score in candidates:
            if abs(candidate_start - target) > tolerance:
                continue
            if position == 0:
                gap = candidate_start - previous.start
                next_states.append(
                    (
                        candidate_score
                        - 8.0 * abs(candidate_start - target)
                        - 4.0 * abs(gap - period),
                        [candidate_start],
                    )
                )
                continue
            for old_score, path in states:
                gap = candidate_start - path[-1]
                if (
                    gap < 0.5
                    or abs(gap - period) > tolerance
                ):
                    continue
                next_states.append(
                    (
                        old_score
                        + candidate_score
                        - 8.0 * abs(candidate_start - target)
                        - 4.0 * abs(gap - period),
                        [*path, candidate_start],
                    )
                )
        states = next_states
        if not states:
            return repaired

    _, proposed = max(states, key=lambda state: state[0])
    current = [
        repaired[index].start
        for index in range(run_start, run_start + 4)
    ]
    current_cost = sum(
        abs(
            (
                start
                - (
                    previous.start
                    if position == 0
                    else current[position - 1]
                )
            )
            - period
        )
        for position, start in enumerate(current)
    )
    proposed_cost = sum(
        abs(
            (
                start
                - (
                    previous.start
                    if position == 0
                    else proposed[position - 1]
                )
            )
            - period
        )
        for position, start in enumerate(proposed)
    )
    if (
        current_cost - proposed_cost < 3.0
        or max(
            abs(new - old)
            for new, old in zip(
                proposed,
                current,
                strict=True,
            )
        )
        > 25.0
    ):
        return repaired

    remaining_count = count - len(proposed)
    if remaining_count <= 0:
        return repaired
    continuation_indices = [
        int(index)
        for index in onset_indices
        if (
            times[index] - cue_lead_seconds
            >= proposed[-1] + 0.5
        )
    ]
    clusters: list[list[int]] = []
    for index in continuation_indices:
        if (
            clusters
            and times[index] - times[clusters[-1][0]] <= 1.35
        ):
            clusters[-1].append(index)
        else:
            clusters.append([index])
    if len(clusters) < remaining_count:
        return repaired
    continuation_starts = [
        max(
            0.0,
            float(times[
                max(
                    cluster,
                    key=lambda index: onset_scores[index],
                )
            ])
            - cue_lead_seconds,
        )
        for cluster in clusters[:remaining_count]
    ]
    if (
        any(
            right - left < 0.5
            for left, right in zip(
                [proposed[-1], *continuation_starts[:-1]],
                continuation_starts,
                strict=True,
            )
        )
        or max(
            right - left
            for left, right in zip(
                [proposed[-1], *continuation_starts[:-1]],
                continuation_starts,
                strict=True,
            )
        )
        > 2.0 * period
    ):
        return repaired

    # Treat the suffix as one proposal.  Applying only the first four rows
    # before proving that the remaining activity groups exist can create a
    # new discontinuity in an otherwise untouched outro.
    planned_starts = [*proposed, *continuation_starts]
    for offset, start in enumerate(planned_starts):
        index = run_start + offset
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if offset + 1 < count:
            end = min(end, planned_starts[offset + 1])
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.5,
            interpolated=False,
            method="acoustic_dense_trailing_prefix",
            start_uncertainty=0.18,
        )
    return repaired


def _repair_trailing_weak_run(
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray | None = None,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Place an unrecognized outro on its first remaining vocal activities."""

    repaired = list(anchors)
    run_start = len(repaired)
    while run_start > 0:
        anchor = repaired[run_start - 1]
        if anchor.method == "acoustic_trailing_cadence":
            break
        if not (anchor.interpolated or anchor.confidence < 0.3):
            break
        run_start -= 1
    count = len(repaired) - run_start
    if count < 1 or run_start == 0:
        return repaired

    previous = repaired[run_start - 1]
    # Relax the previous-end boundary only when the coarse trailing estimate
    # itself overlaps that phrase, which is the characteristic call/response
    # case. A genuinely later outro still needs the reliable previous end to
    # exclude internal syllables and instrumental activity.
    overlaps_previous_end = (
        repaired[run_start].start <= previous.end + 0.75
    )
    lower = (
        previous.start + 0.28
        if overlaps_previous_end
        else max(
            previous.start + 0.28,
            previous.end + 0.05,
        )
    ) + cue_lead_seconds
    upper = lower + 20.0 + 8.0 * max(0, count - 1)

    def activity_clusters(indices: np.ndarray) -> list[list[int]]:
        candidates = [
            int(candidate)
            for candidate in indices
            if lower <= times[candidate] <= upper
        ]
        clusters: list[list[int]] = []
        for candidate in candidates:
            if (
                clusters
                and times[candidate] - times[clusters[-1][-1]] <= 1.35
            ):
                clusters[-1].append(candidate)
            else:
                clusters.append([candidate])
        return [
            cluster
            for cluster in clusters
            if (
                len(cluster) >= 2
                or onset_scores[cluster[0]] >= 9.0
            )
        ]

    clusters = (
        activity_clusters(onset_indices)
        if onset_indices is not None
        else []
    )
    if len(clusters) < count:
        clusters = activity_clusters(_soft_onset_indices(onset_scores))
    if len(clusters) < count:
        return repaired

    def representative(cluster: list[int]) -> int:
        early = [
            candidate
            for candidate in cluster
            if times[candidate] <= times[cluster[0]] + 0.8
        ]
        return max(
            early,
            key=lambda candidate: onset_scores[candidate],
        )

    selected_clusters = clusters[:count]
    if count >= 3 and len(clusters) > count:
        recent_gaps: list[float] = []
        for index in range(max(1, run_start - 7), run_start):
            left_anchor = repaired[index - 1]
            right_anchor = repaired[index]
            if not all(
                (
                    not anchor.interpolated
                    and anchor.confidence >= 0.6
                    and anchor.start_uncertainty <= 1.0
                )
                for anchor in (left_anchor, right_anchor)
            ):
                continue
            gap = right_anchor.start - left_anchor.start
            if 0.5 <= gap <= 12.0:
                recent_gaps.append(gap)
        if len(recent_gaps) >= 3:
            expected_gap = float(median(recent_gaps[-5:]))
            representatives = [
                representative(cluster)
                for cluster in clusters
            ]
            representative_times = [
                float(times[candidate])
                for candidate in representatives
            ]

            def cadence_error(values: list[float]) -> float:
                gaps = [
                    right - left
                    for left, right in zip(values, values[1:])
                ]
                return sum(
                    abs(gap - expected_gap)
                    for gap in gaps
                ) / len(gaps)

            current_times = representative_times[:count]
            current_error = cadence_error(current_times)
            cadence_windows: list[
                tuple[float, int, list[list[int]]]
            ] = []
            for offset in range(len(clusters) - count + 1):
                window_times = representative_times[
                    offset : offset + count
                ]
                window_gaps = [
                    right - left
                    for left, right in zip(
                        window_times,
                        window_times[1:],
                    )
                ]
                if not all(
                    0.6 * expected_gap
                    <= gap
                    <= 1.6 * expected_gap
                    for gap in window_gaps
                ):
                    continue
                if (
                    offset
                    and representative_times[offset]
                    - representative_times[offset - 1]
                    < 0.6 * expected_gap
                ):
                    # The first cluster is still part of a faster preceding
                    # activity island, rather than the start of the outro's
                    # established line cadence.
                    continue
                cadence_windows.append(
                    (
                        cadence_error(window_times),
                        offset,
                        clusters[offset : offset + count],
                    )
                )
            if cadence_windows:
                (
                    best_error,
                    best_offset,
                    best_clusters,
                ) = min(
                    cadence_windows,
                    key=lambda candidate: (
                        candidate[0],
                        candidate[1],
                    ),
                )
                minimum_improvement = max(
                    0.5,
                    0.15 * expected_gap,
                )
                if (
                    best_offset > 0
                    and current_error
                    >= max(0.8, 0.22 * expected_gap)
                    and best_error + minimum_improvement
                    < current_error
                ):
                    # A dense instrumental/backing-vocal island can expose
                    # one onset every half line and consume an entire weak
                    # tail. Prefer the later complete window only when a
                    # stable preceding verse supplies independent cadence
                    # evidence and the improvement is decisive.
                    selected_clusters = best_clusters

    if count == 2 and len(clusters) >= 3:
        first_tail = repaired[run_start]
        short_final = repaired[run_start + 1]
        coarse_gap = short_final.start - first_tail.start

        representatives = [
            representative(cluster)
            for cluster in clusters
        ]
        first_time = float(times[representatives[0]])
        immediate_gap = (
            float(times[representatives[1]]) - first_time
        )
        preferred_offset = min(
            range(1, len(clusters)),
            key=lambda offset: abs(
                float(times[representatives[offset]])
                - first_time
                - coarse_gap
            ),
        )
        preferred_gap = (
            float(times[representatives[preferred_offset]])
            - first_time
        )
        immediate_error = abs(immediate_gap - coarse_gap)
        preferred_error = abs(preferred_gap - coarse_gap)
        if (
            first_tail.total_units >= 4
            and short_final.total_units <= 2
            and coarse_gap >= 5.0
            and immediate_gap < 0.65 * coarse_gap
            and preferred_offset >= 2
            and preferred_gap >= 4.0
            and preferred_error <= 1.0
            and preferred_error + 1.0 <= immediate_error
        ):
            # A long final phrase followed by a very short response often
            # contains several strong internal syllables.  Preserve the
            # coarse *relative* cadence and skip those internal peaks, while
            # still taking the first remaining activity for the long phrase.
            selected_clusters = [
                clusters[0],
                clusters[preferred_offset],
            ]

    starts: list[float] = []
    for cluster in selected_clusters:
        early = [
            candidate
            for candidate in cluster
            if times[candidate] <= times[cluster[0]] + 0.8
        ]
        representative = max(
            early,
            key=lambda candidate: onset_scores[candidate],
        )
        starts.append(
            max(
                0.0,
                float(times[representative]) - cue_lead_seconds,
            )
        )
    if any(
        right - left < 0.28
        for left, right in zip(starts, starts[1:])
    ):
        return repaired

    for offset, start in enumerate(starts):
        index = run_start + offset
        anchor = repaired[index]
        repaired[index] = replace(
            anchor,
            start=start,
            end=start + max(0.0, anchor.end - anchor.start),
            confidence=0.42,
            interpolated=False,
            method="acoustic_trailing_activity",
            start_uncertainty=0.22,
        )
    return repaired


def _repair_trailing_vocalization_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover one hidden entrance before a repeated vocalization outro.

    A continuous call/response can hide the first entrance while the final
    repeated vocalizations still produce distinct soft onsets.  Synthesize
    exactly one entrance only when the tail is entirely vocalizations, its
    final two rows are identical, the preceding cadence is stable, and the
    number of remaining acoustic groups is exactly one short of the row count.
    """

    repaired = list(anchors)
    run_start = len(repaired)
    while run_start > 0:
        anchor = repaired[run_start - 1]
        if not (anchor.interpolated or anchor.confidence < 0.3):
            break
        run_start -= 1
    count = len(repaired) - run_start
    if not 2 <= count <= 4 or run_start == 0:
        return repaired

    values = [
        primary_lexical_values(lines[index].text)
        for index in range(run_start, len(lines))
    ]
    if any(
        not value
        or any(token not in _LEADING_VOCALIZATIONS for token in value)
        for value in values
    ):
        return repaired
    signatures = [" ".join(value) for value in values]
    if signatures[-1] != signatures[-2]:
        return repaired

    previous = repaired[run_start - 1]
    if previous.confidence < 0.5:
        return repaired
    prior_gaps = [
        repaired[index].start - repaired[index - 1].start
        for index in range(max(1, run_start - 4), run_start)
        if 0.8
        <= repaired[index].start - repaired[index - 1].start
        <= 6.0
    ]
    if len(prior_gaps) < 2:
        return repaired
    period = float(median(prior_gaps))
    if not 1.0 <= period <= 5.0:
        return repaired

    lower = previous.start + 0.28 + cue_lead_seconds
    upper = min(
        float(times[-1]) if len(times) else math.inf,
        previous.start + 6.0 * count,
    )
    soft_indices = _soft_onset_indices(onset_scores)
    candidates = [
        int(candidate)
        for candidate in soft_indices
        if lower <= times[candidate] <= upper
    ]
    clusters: list[list[int]] = []
    for candidate in candidates:
        if (
            clusters
            and times[candidate] - times[clusters[-1][-1]] <= 1.35
        ):
            clusters[-1].append(candidate)
        else:
            clusters.append([candidate])
    if len(clusters) != count - 1:
        return repaired

    acoustic_starts: list[float] = []
    for cluster in clusters:
        early = [
            candidate
            for candidate in cluster
            if times[candidate] <= times[cluster[0]] + 0.8
        ]
        representative = max(
            early,
            key=lambda candidate: onset_scores[candidate],
        )
        acoustic_starts.append(
            max(
                0.0,
                float(times[representative]) - cue_lead_seconds,
            )
        )
    starts = [previous.start + period, *acoustic_starts]
    gaps = [
        right - left
        for left, right in zip(
            [previous.start, *starts[:-1]],
            starts,
            strict=True,
        )
    ]
    tolerance = max(0.9, 0.4 * period)
    if (
        any(gap < 0.55 or abs(gap - period) > tolerance for gap in gaps)
        or any(
            right - left < 0.28
            for left, right in zip(starts, starts[1:])
        )
    ):
        return repaired

    old_starts = [
        repaired[index].start
        for index in range(run_start, len(repaired))
    ]
    old_gaps = [
        right - left
        for left, right in zip(
            [previous.start, *old_starts[:-1]],
            old_starts,
            strict=True,
        )
    ]
    old_cost = sum(abs(gap - period) for gap in old_gaps)
    new_cost = sum(abs(gap - period) for gap in gaps)
    maximum_shift = max(
        abs(proposed - current)
        for proposed, current in zip(starts, old_starts, strict=True)
    )
    if old_cost - new_cost < 2.0 or maximum_shift > 14.0:
        return repaired

    for offset, start in enumerate(starts):
        index = run_start + offset
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        repaired[index] = replace(
            anchor,
            start=start,
            end=start + duration,
            confidence=0.38 if offset == 0 else 0.44,
            interpolated=False,
            method=(
                "acoustic_trailing_vocalization_cadence"
                if offset == 0
                else "acoustic_trailing_activity"
            ),
            start_uncertainty=0.45 if offset == 0 else 0.22,
        )
    return repaired


def _transfer_acoustic_repeat_counterparts(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Transfer a repaired repeat timestamp to its still-missing counterpart."""

    repaired = list(anchors)
    for left, right, length in _repeated_blocks(lines):
        offset = _repeat_offset_consensus(
            repaired,
            left,
            right,
            length,
        )
        if offset is None:
            continue
        for position in range(length):
            first_index = left + position
            second_index = right + position
            first = repaired[first_index]
            second = repaired[second_index]
            first_weak = first.interpolated or first.confidence < 0.4
            second_weak = second.interpolated or second.confidence < 0.4
            if first_weak == second_weak:
                continue
            target_index = first_index if first_weak else second_index
            source_index = second_index if first_weak else first_index
            source = second if first_weak else first
            if (
                source.method
                in {
                    "acoustic_repeat_offset_outlier",
                    "acoustic_trailing_activity",
                }
                and any(
                    repaired[neighbor].method == source.method
                    for neighbor in (
                        source_index - 1,
                        source_index + 1,
                    )
                    if 0 <= neighbor < len(repaired)
                )
            ):
                # A single repaired counterpart is useful evidence. A whole
                # speculative outro run is not independent evidence, so do
                # not fan one of its timestamps into another repeated block.
                continue
            proposed = (
                source.start - offset
                if first_weak
                else source.start + offset
            )
            anchor = repaired[target_index]
            if (
                source.method == "acoustic_stretched_bridge"
                and position == 0
                and abs(proposed - anchor.start) <= 0.5
            ):
                # The first counterpart also forms the boundary after the
                # stretched closing phrase.  Keep an already-nearby coarse
                # boundary instead of copying a small offset error into it;
                # later collapsed repeats can still inherit the cadence.
                continue
            previous = (
                repaired[target_index - 1].start + 0.28
                if target_index
                else 0.0
            )
            following = (
                repaired[target_index + 1].start - 0.28
                if target_index + 1 < len(repaired)
                else math.inf
            )
            if not previous <= proposed <= following:
                continue
            repaired[target_index] = replace(
                anchor,
                start=max(0.0, proposed),
                end=max(0.0, proposed)
                + max(0.0, anchor.end - anchor.start),
                confidence=0.42,
                interpolated=False,
                method="acoustic_repeat_transfer",
                start_uncertainty=0.3,
            )
    return repaired


def _repair_repeat_template_consensus(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Borrow a repeated section's stable relative rhythm.

    This is deliberately limited to an exact section heard at least three
    times.  At least two well-constrained performances must agree before the
    template can repair low-confidence rows in another occurrence.  Reliable
    target rows are never moved, so real rubato remains authoritative.
    """

    repaired = list(anchors)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    patterns: list[tuple[str, ...]] = []
    seen_patterns: set[tuple[str, ...]] = set()
    for left, _, length in _repeated_blocks(lines):
        pattern = tuple(signatures[left : left + length])
        if pattern in seen_patterns:
            continue
        seen_patterns.add(pattern)
        patterns.append(pattern)

    repaired_indices: set[int] = set()
    for pattern in patterns:
        length = len(pattern)
        raw_starts = [
            start
            for start in range(len(signatures) - length + 1)
            if tuple(signatures[start : start + length]) == pattern
        ]
        occurrence_starts: list[int] = []
        for start in raw_starts:
            if occurrence_starts and start < occurrence_starts[-1] + length:
                continue
            occurrence_starts.append(start)
        if len(occurrence_starts) < 3:
            continue

        def stable(anchor: CoarseLineAnchor, *, origin: bool = False) -> bool:
            return (
                not anchor.interpolated
                and anchor.confidence >= (0.4 if origin else 0.32)
                and anchor.start_uncertainty <= 0.75
            )

        source_starts: list[int] = []
        for start in occurrence_starts:
            stable_positions = [
                position
                for position in range(length)
                if stable(repaired[start + position])
            ]
            following_stable = (
                start + length < len(repaired)
                and stable(repaired[start + length])
            )
            if (
                stable(repaired[start])
                and len(stable_positions) >= 3
                and max(stable_positions) - min(stable_positions)
                >= max(2, math.ceil((length - 1) * 0.5))
                and (
                    stable_positions[-1] == length - 1
                    or following_stable
                )
            ):
                source_starts.append(start)
        if len(source_starts) < 2:
            continue

        relative_template: list[float | None] = []
        relative_spreads: list[float] = []
        for position in range(length):
            values = [
                repaired[start + position].start
                - repaired[start].start
                for start in source_starts
            ]
            center = float(median(values))
            spread = max(values) - min(values)
            if spread > 1.0 + 1e-6:
                relative_template.append(None)
                relative_spreads.append(spread)
                continue
            relative_template.append(center)
            relative_spreads.append(spread)
        if (
            sum(value is not None for value in relative_template)
            < math.ceil(length * 0.8)
        ):
            continue

        template_duration = max(
            value or 0.0 for value in relative_template
        )
        maximum_shift = max(4.0, template_duration)
        for start in occurrence_starts:
            target_origins = [
                repaired[start + position].start - relative
                for position, relative in enumerate(relative_template)
                if (
                    relative is not None
                    and stable(repaired[start + position], origin=True)
                )
            ]
            if not target_origins:
                continue
            origin = float(median(target_origins))
            if (
                len(target_origins) >= 2
                and max(target_origins) - min(target_origins) > 0.8
            ):
                continue

            proposed = [
                (
                    repaired[start + position].start
                    if (
                        relative is None
                        or not (
                            repaired[start + position].interpolated
                            or repaired[start + position].confidence < 0.4
                            or repaired[start + position].start_uncertainty
                            > 0.9
                        )
                    )
                    else origin + relative
                )
                for position, relative in enumerate(relative_template)
            ]
            if any(
                right - left < 0.28
                for left, right in zip(proposed, proposed[1:])
            ):
                continue
            previous = (
                repaired[start - 1].start + 0.28
                if start
                else 0.0
            )
            following = (
                repaired[start + length].start - 0.28
                if start + length < len(repaired)
                else math.inf
            )
            if proposed[0] < previous or proposed[-1] > following:
                continue

            for position, predicted in enumerate(proposed):
                index = start + position
                anchor = repaired[index]
                relative = relative_template[position]
                if (
                    relative is None
                    or index in repaired_indices
                    or not (
                        anchor.interpolated
                        or anchor.confidence < 0.4
                        or anchor.start_uncertainty > 0.9
                    )
                    or abs(predicted - anchor.start) < 0.08
                    or abs(predicted - anchor.start) > maximum_shift
                ):
                    continue
                duration = max(0.0, anchor.end - anchor.start)
                repaired[index] = replace(
                    anchor,
                    start=max(0.0, predicted),
                    end=max(0.0, predicted) + duration,
                    confidence=0.44,
                    interpolated=False,
                    method="repeat_template_consensus",
                    start_uncertainty=max(
                        0.3,
                        min(0.8, relative_spreads[position]),
                    ),
                )
                repaired_indices.add(index)
    return repaired


def _repair_repeat_template_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Repair one grossly displaced row inside a recurrent exact section.

    A lexical ASR match can occasionally land on a later performance of one
    repeated line even though every surrounding row belongs to the current
    performance.  Confidence alone cannot identify that failure.  This repair
    therefore requires four non-overlapping performances of an exact section:
    at least three performances must agree on the relative position, and at
    least three other rows in the affected performance must agree on its
    origin.  Moderate rubato is left untouched; only a single four-second-or-
    larger outlier may move.
    """

    repaired = list(anchors)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    patterns: list[tuple[str, ...]] = []
    seen_patterns: set[tuple[str, ...]] = set()
    for left, _, length in _repeated_blocks(lines):
        if length < 4:
            continue
        pattern = tuple(signatures[left : left + length])
        if pattern in seen_patterns:
            continue
        seen_patterns.add(pattern)
        patterns.append(pattern)

    repaired_indices: set[int] = set()
    for pattern in patterns:
        length = len(pattern)
        raw_starts = [
            start
            for start in range(len(signatures) - length + 1)
            if tuple(signatures[start : start + length]) == pattern
        ]
        occurrence_starts: list[int] = []
        for start in raw_starts:
            if occurrence_starts and start < occurrence_starts[-1] + length:
                continue
            occurrence_starts.append(start)
        if len(occurrence_starts) < 4:
            continue

        def stable(anchor: CoarseLineAnchor) -> bool:
            return (
                not anchor.interpolated
                and anchor.confidence >= 0.4
                and anchor.start_uncertainty <= 0.75
            )

        source_starts = [
            start
            for start in occurrence_starts
            if (
                stable(repaired[start])
                and sum(
                    stable(repaired[start + position])
                    for position in range(length)
                )
                >= max(3, math.ceil(length * 0.75))
            )
        ]
        if len(source_starts) < 4:
            continue

        relative_template: list[float | None] = []
        for position in range(length):
            values = [
                repaired[start + position].start
                - repaired[start].start
                for start in source_starts
                if stable(repaired[start + position])
            ]
            if len(values) < 4:
                relative_template.append(None)
                continue
            center = float(median(values))
            inliers = [
                value
                for value in values
                if abs(value - center) <= 0.8
            ]
            if (
                len(inliers)
                < max(3, math.ceil(len(values) * 0.75))
                or max(inliers) - min(inliers) > 1.0 + 1e-6
            ):
                relative_template.append(None)
                continue
            relative_template.append(float(median(inliers)))
        if (
            sum(value is not None for value in relative_template)
            < math.ceil(length * 0.8)
        ):
            continue

        for start in occurrence_starts:
            origins = [
                (
                    position,
                    repaired[start + position].start - relative,
                )
                for position, relative in enumerate(relative_template)
                if (
                    relative is not None
                    and stable(repaired[start + position])
                )
            ]
            if len(origins) < 4:
                continue
            center = float(median(value for _, value in origins))
            inliers = [
                item
                for item in origins
                if abs(item[1] - center) <= 0.8
            ]
            outliers = [
                item
                for item in origins
                if abs(item[1] - center) > 0.8
            ]
            if len(inliers) < 3 or len(outliers) != 1:
                continue
            origin = float(median(value for _, value in inliers))
            inliers = [
                item
                for item in origins
                if abs(item[1] - origin) <= 0.8
            ]
            outliers = [
                item
                for item in origins
                if abs(item[1] - origin) > 0.8
            ]
            if len(inliers) < 3 or len(outliers) != 1:
                continue

            position, _ = outliers[0]
            index = start + position
            relative = relative_template[position]
            if relative is None or index in repaired_indices:
                continue
            target = repaired[index]
            predicted = origin + relative
            shift = predicted - target.start
            if abs(shift) < 4.0 or abs(shift) > 24.0:
                continue
            previous = (
                repaired[index - 1].start + 0.28
                if index
                else 0.0
            )
            following = (
                repaired[index + 1].start - 0.28
                if index + 1 < len(repaired)
                else math.inf
            )
            if not previous <= predicted <= following:
                continue

            duration = max(0.0, target.end - target.start)
            repaired[index] = replace(
                target,
                start=max(0.0, predicted),
                end=max(0.0, predicted) + duration,
                confidence=max(0.5, min(0.7, target.confidence)),
                interpolated=False,
                method="repeat_template_outlier",
                start_uncertainty=0.25,
            )
            repaired_indices.add(index)
    return repaired


def _repair_consecutive_repeat_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Recover a skipped cycle inside a long, exact lyric chant.

    This supplements the general repeat template only when a 3--8 line motif
    occurs at least four times back-to-back and at least two adjacent cycle
    periods agree.  Those guards keep ordinary repeated choruses and rubato
    out of the cadence extrapolation path.
    """

    repaired = list(anchors)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    patterns: list[tuple[str, ...]] = []
    seen_patterns: set[tuple[str, ...]] = set()

    # Maximal repeat matching hides a short motif when it is repeated many
    # times without a break (ABCDABCDABCDABCD becomes one long overlap).
    for start in range(len(signatures)):
        maximum_length = min(8, (len(signatures) - start) // 4)
        for length in range(3, maximum_length + 1):
            pattern = tuple(signatures[start : start + length])
            if (
                not all(pattern)
                or pattern in seen_patterns
                or (
                    start
                    and signatures[start - 1] == pattern[-1]
                )
                or tuple(
                    signatures[start + length : start + 2 * length]
                )
                != pattern
                or tuple(
                    signatures[start + 2 * length : start + 3 * length]
                )
                != pattern
                or tuple(
                    signatures[start + 3 * length : start + 4 * length]
                )
                != pattern
            ):
                continue
            seen_patterns.add(pattern)
            patterns.append(pattern)

    repaired_indices: set[int] = set()
    for pattern in patterns:
        length = len(pattern)
        raw_starts = [
            start
            for start in range(len(signatures) - length + 1)
            if tuple(signatures[start : start + length]) == pattern
        ]
        occurrence_starts: list[int] = []
        for start in raw_starts:
            if occurrence_starts and start < occurrence_starts[-1] + length:
                continue
            occurrence_starts.append(start)
        if len(occurrence_starts) < 3:
            continue

        def template_weak(anchor: CoarseLineAnchor) -> bool:
            return (
                anchor.interpolated
                or anchor.confidence < 0.4
                or (
                    anchor.method == "acoustic_onset"
                    and anchor.confidence <= 0.45
                )
                or anchor.start_uncertainty > 0.9
                or anchor.method in _TEMPLATE_WEAK_METHODS
            )

        def stable(anchor: CoarseLineAnchor, *, origin: bool = False) -> bool:
            return (
                not template_weak(anchor)
                and anchor.confidence >= (0.4 if origin else 0.32)
                and anchor.start_uncertainty <= 0.75
            )

        source_starts: list[int] = []
        for start in occurrence_starts:
            stable_positions = [
                position
                for position in range(length)
                if stable(repaired[start + position])
            ]
            following_stable = (
                start + length < len(repaired)
                and stable(repaired[start + length])
            )
            if (
                stable(repaired[start])
                and len(stable_positions) >= 3
                and max(stable_positions) - min(stable_positions)
                >= max(2, math.ceil((length - 1) * 0.5))
                and (
                    stable_positions[-1] == length - 1
                    or following_stable
                )
            ):
                source_starts.append(start)
        if len(source_starts) < 2:
            continue

        relative_template: list[float | None] = []
        relative_spreads: list[float] = []
        for position in range(length):
            values = [
                repaired[start + position].start
                - repaired[start].start
                for start in source_starts
            ]
            center = float(median(values))
            spread = max(values) - min(values)
            if spread > 1.0 + 1e-6:
                relative_template.append(None)
                relative_spreads.append(spread)
                continue
            relative_template.append(center)
            relative_spreads.append(spread)
        if (
            sum(value is not None for value in relative_template)
            < math.ceil(length * 0.8)
        ):
            continue

        template_duration = max(
            value or 0.0 for value in relative_template
        )
        known_origins: dict[int, float] = {}
        for start in occurrence_starts:
            stable_positions = [
                position
                for position, relative in enumerate(relative_template)
                if (
                    relative is not None
                    and stable(
                        repaired[start + position],
                        origin=True,
                    )
                )
            ]
            if (
                not stable(repaired[start], origin=True)
                and (
                    len(stable_positions) < 3
                    or stable_positions[-1]
                    - stable_positions[0]
                    < 2
                )
            ):
                # Two adjacent internal rows can both land on syllables from
                # the same skipped chant cycle. They are not enough evidence
                # to declare a new occurrence origin and poison an otherwise
                # stable period consensus.
                continue
            values = [
                repaired[start + position].start
                - (relative_template[position] or 0.0)
                for position in stable_positions
            ]
            if not values:
                continue
            if len(values) >= 2 and max(values) - min(values) > 0.8:
                continue
            known_origins[start] = float(median(values))

        period_samples = [
            known_origins[right] - known_origins[left]
            for left, right in zip(
                occurrence_starts,
                occurrence_starts[1:],
            )
            if (
                right == left + length
                and left in known_origins
                and right in known_origins
            )
        ]
        repeat_period: float | None = None
        if len(period_samples) >= 2:
            candidate_period = float(median(period_samples))
            if (
                candidate_period > template_duration + 0.28
                and max(period_samples) - min(period_samples)
                <= max(0.75, candidate_period * 0.12)
            ):
                repeat_period = candidate_period
        if repeat_period is None:
            continue

        origins = dict(known_origins)
        changed = True
        while changed:
            changed = False
            for left, right in zip(
                occurrence_starts,
                occurrence_starts[1:],
            ):
                if right != left + length:
                    continue
                if left in origins and right not in origins:
                    origins[right] = origins[left] + repeat_period
                    changed = True
                elif right in origins and left not in origins:
                    origins[left] = origins[right] - repeat_period
                    changed = True

        maximum_shift = max(
            4.0,
            template_duration,
            # A recognizer can skip several complete cycles of a long chant.
            # The period itself is already guarded by multiple independent
            # source occurrences, so permit recovery across up to four cycles
            # instead of abandoning the final repeated block.
            repeat_period * 4.25,
        )
        for start in occurrence_starts:
            origin = origins.get(start)
            if origin is None:
                continue

            proposed = [
                (
                    repaired[start + position].start
                    if (
                        relative is None
                        or not template_weak(
                            repaired[start + position]
                        )
                    )
                    else origin + relative
                )
                for position, relative in enumerate(relative_template)
            ]
            if any(
                right - left < 0.28
                for left, right in zip(proposed, proposed[1:])
            ):
                continue
            previous = (
                repaired[start - 1].start + 0.28
                if start
                else 0.0
            )
            following = (
                repaired[start + length].start - 0.28
                if start + length < len(repaired)
                else math.inf
            )
            if proposed[0] < previous or proposed[-1] > following:
                continue

            for position, predicted in enumerate(proposed):
                index = start + position
                anchor = repaired[index]
                relative = relative_template[position]
                if (
                    relative is None
                    or index in repaired_indices
                    or not template_weak(anchor)
                    or abs(predicted - anchor.start) < 0.08
                    or abs(predicted - anchor.start) > maximum_shift
                ):
                    continue
                duration = max(0.0, anchor.end - anchor.start)
                repaired[index] = replace(
                    anchor,
                    start=max(0.0, predicted),
                    end=max(0.0, predicted) + duration,
                    confidence=0.44,
                    interpolated=False,
                    method="repeat_cadence",
                    start_uncertainty=max(
                        0.3,
                        min(0.8, relative_spreads[position]),
                    ),
                )
                repaired_indices.add(index)
    return repaired


def _repair_identical_repeat_grid(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a repeated lyric run from an independently scored onset grid.

    A run of three or more repeated rows can itself contain several identical
    acoustic atoms.  For example, ``My, my, my, my`` normally produces four
    attacks per lyric row, while ``Love you, love you`` produces two.  Treating
    every attack as a separate row is a common source of collapsed or
    half-speed axes.  This repair derives the atom count from the shortest
    repeated lexical unit, searches the isolated-vocal onset profile for a
    periodic grid, and only writes the grid when the existing run is already
    materially anomalous.  Exact pairs are intentionally excluded after the
    independent v56/v57 gates found unresolved acoustic phase ambiguity.

    The routine is deliberately English-only and reference-blind.  It reads
    lyric structure, coarse anchors, and acoustic onset evidence only.
    """

    if not lines or any(
        (line.detected_language or "English") != "English"
        for line in lines
        if line.text.strip()
    ):
        return list(anchors)
    if len(times) < 3 or len(onset_scores) != len(times):
        return list(anchors)

    repaired = list(anchors)
    cue_lead = max(0.0, cue_lead_seconds)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    strong_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=7.0,
    )
    if not len(strong_indices):
        return repaired
    acoustic_candidates = [
        (
            max(0.0, float(times[index]) - cue_lead),
            float(onset_scores[index]),
        )
        for index in strong_indices
    ]

    def stable_seed(anchor: CoarseLineAnchor) -> bool:
        return (
            anchor.method == "lexical"
            and not anchor.interpolated
            and anchor.confidence >= 0.85
            and anchor.matched_units >= 3
            and anchor.start_uncertainty <= 1.0
        )

    def usable_phase_seed(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.65
            and anchor.start_uncertainty <= 0.75
        )

    def lexical_period(tokens: list[str]) -> tuple[int, int]:
        for unit_count in range(1, len(tokens) + 1):
            if (
                len(tokens) % unit_count == 0
                and tokens
                == tokens[:unit_count]
                * (len(tokens) // unit_count)
            ):
                return len(tokens) // unit_count, unit_count
        return 1, len(tokens)

    def partial_prefix_atom_count(
        full_tokens: list[str],
        tail_tokens: list[str],
        unit_count: int,
        atoms_per_row: int,
    ) -> int | None:
        if not 1 <= len(tail_tokens) < len(full_tokens):
            return None
        if tail_tokens[:-1] != full_tokens[: len(tail_tokens) - 1]:
            return None
        if not full_tokens[len(tail_tokens) - 1].startswith(
            tail_tokens[-1]
        ):
            return None
        return min(
            atoms_per_row,
            max(1, math.ceil(len(tail_tokens) / max(1, unit_count))),
        )

    def grid_evidence(
        origin: float,
        atom_period: float,
        event_count: int,
    ) -> tuple[float, int, list[float | None]] | None:
        targets = [
            origin + position * atom_period
            for position in range(event_count)
        ]
        selected: list[float | None] = [None] * event_count
        local_scores = [-math.inf] * event_count
        tolerance = min(0.32, max(0.18, 0.04 * atom_period))
        for start, strength in acoustic_candidates:
            if strength < 8.0:
                continue
            position = round((start - origin) / atom_period)
            if not 0 <= position < event_count:
                continue
            distance = abs(start - targets[position])
            if distance > tolerance:
                continue
            local = math.log1p(max(0.0, strength - 7.0)) - 4.0 * distance
            if local > local_scores[position]:
                local_scores[position] = local
                selected[position] = start

        supported = [
            position
            for position, start in enumerate(selected)
            if start is not None
        ]
        minimum_support = min(
            event_count,
            max(3, math.ceil(0.45 * event_count)),
        )
        section_size = max(1, event_count // 3)
        edge_support = min(2, section_size)
        if (
            len(supported) < minimum_support
            or sum(position < section_size for position in supported)
            < edge_support
            or sum(
                position >= event_count - section_size
                for position in supported
            )
            < edge_support
        ):
            return None
        score = sum(
            local_scores[position]
            for position in supported
        ) - 1.5 * (event_count - len(supported))
        return score, len(supported), selected

    run_start = 0
    while run_start < len(signatures):
        exact_run_end = run_start + 1
        while (
            exact_run_end < len(signatures)
            and signatures[run_start]
            and signatures[exact_run_end] == signatures[run_start]
        ):
            exact_run_end += 1
        exact_count = exact_run_end - run_start
        if exact_count < 3 or not signatures[run_start]:
            run_start = exact_run_end
            continue

        full_tokens = primary_lexical_values(lines[run_start].text)
        if not full_tokens:
            run_start = exact_run_end
            continue
        atoms_per_row, unit_count = lexical_period(full_tokens)
        run_end = exact_run_end
        partial_atoms = 0
        if exact_run_end < len(lines):
            tail_tokens = primary_lexical_values(
                lines[exact_run_end].text
            )
            partial = partial_prefix_atom_count(
                full_tokens,
                tail_tokens,
                unit_count,
                atoms_per_row,
            )
            if partial is not None:
                partial_atoms = partial
                run_end += 1

        row_count = run_end - run_start
        event_count = exact_count * atoms_per_row + partial_atoms
        if event_count < row_count:
            run_start = run_end
            continue

        if run_end < len(repaired):
            following_boundary = repaired[run_end]
            if (
                following_boundary.interpolated
                or following_boundary.confidence < 0.5
                or following_boundary.start_uncertainty > 1.0
            ):
                run_start = run_end
                continue

        lower = 0.0
        if run_start:
            previous = repaired[run_start - 1]
            lower = previous.start + 0.28
            if (
                previous.confidence >= 0.75
                and previous.start_uncertainty <= 0.75
                and previous.end > previous.start + 0.05
            ):
                lower = max(lower, previous.end + 0.05)
        upper = float(times[-1]) - cue_lead
        if run_end < len(repaired):
            upper = min(upper, repaired[run_end].start - 0.28)
        if upper <= lower:
            run_start = run_end
            continue

        minimum_atom_period = max(
            0.45,
            0.4 * min(6, unit_count),
        )
        maximum_atom_period = 10.0 / atoms_per_row
        first_stable = stable_seed(repaired[run_start])
        phase_seed = usable_phase_seed(repaired[run_start])
        seeded = (
            row_count >= 2
            and first_stable
            and stable_seed(repaired[run_start + 1])
        )
        if seeded:
            seed_period = (
                repaired[run_start + 1].start
                - repaired[run_start].start
            ) / atoms_per_row
            minimum_atom_period = max(
                minimum_atom_period,
                0.9 * seed_period,
            )
            maximum_atom_period = min(
                maximum_atom_period,
                1.1 * seed_period,
            )
        if minimum_atom_period > maximum_atom_period:
            run_start = run_end
            continue

        origins = [
            start
            for start, _ in acoustic_candidates
            if lower <= start <= upper
        ]
        proposals: list[
            tuple[float, int, float, float, list[float | None]]
        ] = []
        period_steps = max(
            1,
            math.floor(
                (maximum_atom_period - minimum_atom_period) / 0.01
            )
            + 1,
        )
        for origin in origins:
            for step in range(period_steps):
                atom_period = minimum_atom_period + 0.01 * step
                if origin + (event_count - 1) * atom_period > upper:
                    break
                line_period = atom_period * atoms_per_row
                if first_stable:
                    if abs(origin - repaired[run_start].start) > 0.6:
                        continue
                elif phase_seed:
                    phase_tolerance = max(0.75, 0.15 * line_period)
                    if (
                        abs(origin - repaired[run_start].start)
                        > phase_tolerance
                    ):
                        continue
                elif run_start and not lines[run_start].blank_before:
                    current_transition = (
                        repaired[run_start].start
                        - repaired[run_start - 1].start
                    )
                    phase_tolerance = max(0.75, 0.15 * line_period)
                    if (
                        current_transition <= 1.2 * line_period
                        and abs(origin - repaired[run_start].start)
                        > phase_tolerance
                    ):
                        continue
                    if (
                        current_transition > 1.2 * line_period
                        and origin
                        > repaired[run_start].start + phase_tolerance
                    ):
                        continue
                evidence = grid_evidence(
                    origin,
                    atom_period,
                    event_count,
                )
                if evidence is None:
                    continue
                score, support, selected = evidence
                if phase_seed and not first_stable:
                    score -= 2.0 * max(
                        0.0,
                        abs(origin - repaired[run_start].start) - 0.2,
                    )
                elif run_start and not lines[run_start].blank_before:
                    transition_gap = (
                        origin - repaired[run_start - 1].start
                    )
                    score -= 1.5 * max(
                        0.0,
                        transition_gap - 1.25 * line_period,
                    )
                proposals.append(
                    (score, support, origin, atom_period, selected)
                )
        if not proposals:
            run_start = run_end
            continue
        proposals.sort(
            key=lambda item: (
                -item[0],
                -item[1],
                item[2],
                item[3],
            )
        )
        current = [
            repaired[index].start
            for index in range(run_start, run_end)
        ]
        best = proposals[0]
        preliminary_line_period = best[3] * atoms_per_row
        prefix_gaps = [
            current[position + 1] - current[position]
            for position in range(min(3, row_count - 1))
        ]
        prefix_tolerance = max(0.3, 0.15 * preliminary_line_period)
        consistent_prefix_gaps = [
            gap
            for gap in prefix_gaps
            if (
                gap >= 0.28
                and abs(gap - preliminary_line_period)
                <= prefix_tolerance
            )
        ]
        eligible_proposals = proposals
        if len(consistent_prefix_gaps) >= 2:
            prefix_period = float(median(consistent_prefix_gaps))
            phase_locked = [
                proposal
                for proposal in proposals
                if (
                    abs(proposal[2] - current[0]) <= 0.45
                    and abs(
                        proposal[3] * atoms_per_row - prefix_period
                    )
                    <= prefix_tolerance
                )
            ]
            if phase_locked:
                eligible_proposals = phase_locked
                best = phase_locked[0]
        distinct = next(
            (
                proposal
                for proposal in eligible_proposals
                if proposal is not best
                if (
                    abs(proposal[2] - best[2]) > 0.35
                    or abs(
                        (event_count - 1)
                        * (proposal[3] - best[3])
                    )
                    > 0.35
                )
            ),
            None,
        )
        minimum_score_margin = min(
            0.75,
            max(0.35, 0.15 * event_count),
        )
        if (
            distinct is not None
            and best[0] - distinct[0] < minimum_score_margin
        ):
            run_start = run_end
            continue
        collapsed_input = all(
            right - left < 0.28
            for left, right in zip(current, current[1:])
        )
        if (
            first_stable
            and lines[run_start].blank_before
            and collapsed_input
            and abs(best[2] - current[0]) > 0.35
        ):
            run_start = run_end
            continue

        _, _, origin, atom_period, selected = best
        line_period = atom_period * atoms_per_row
        proposed = [
            origin + position * line_period
            for position in range(row_count)
        ]
        for position in range(row_count):
            acoustic_position = position * atoms_per_row
            if (
                acoustic_position < len(selected)
                and selected[acoustic_position] is not None
            ):
                proposed[position] = float(selected[acoustic_position])
        if any(
            right - left < 0.28
            for left, right in zip(proposed, proposed[1:])
        ):
            run_start = run_end
            continue

        current_gap_error = sum(
            abs((right - left) - line_period)
            for left, right in zip(current, current[1:])
        )
        proposed_gap_error = sum(
            abs((right - left) - line_period)
            for left, right in zip(proposed, proposed[1:])
        )
        required_gap_improvement = max(
            1.0,
            0.3 * line_period * max(1, row_count - 1),
        )
        material_threshold = max(0.75, 0.25 * line_period)
        material_changes = sum(
            abs(observed - target) >= material_threshold
            for observed, target in zip(current, proposed, strict=True)
        )
        required_material_changes = max(
            1,
            math.ceil(0.35 * row_count),
        )
        if (
            current_gap_error - proposed_gap_error
            < required_gap_improvement
            or material_changes < required_material_changes
        ):
            run_start = run_end
            continue

        for position, start in enumerate(proposed):
            index = run_start + position
            anchor = repaired[index]
            if (
                (phase_seed and position == 0)
                or (seeded and position < 2)
            ):
                continue
            if abs(start - anchor.start) < 0.08:
                continue
            duration = max(0.0, anchor.end - anchor.start)
            end = start + duration
            if position + 1 < row_count:
                end = min(end, proposed[position + 1])
            elif run_end < len(repaired):
                end = min(end, repaired[run_end].start)
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.7,
                interpolated=False,
                method="acoustic_identical_repeat_grid",
                start_uncertainty=0.2,
            )
        run_start = run_end
    return repaired


def _repair_identical_repeat_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
    experimental_seeded_final_run: bool = False,
    experimental_periodic_grid: bool = False,
) -> list[CoarseLineAnchor]:
    """Recover the acoustic cadence of a long identical-line chant.

    Identical rows are especially vulnerable to ASR assigning several copies
    to internal syllables of one performance. This path is intentionally
    narrow: at least four rows must be consecutive, the first entrance must
    be a reliable lexical anchor, every later row must remain uncertain, and
    a near-periodic sequence of independent acoustic attacks must improve the
    observed cadence substantially.
    """

    repaired = list(anchors)
    if experimental_periodic_grid:
        repaired = _repair_identical_repeat_grid(
            lines,
            repaired,
            times,
            onset_scores,
            cue_lead_seconds=cue_lead_seconds,
        )
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]

    def stable(anchor: CoarseLineAnchor) -> bool:
        return (
            anchor.method == "lexical"
            and not anchor.interpolated
            and anchor.confidence >= 0.55
            and anchor.start_uncertainty <= 1.0
        )

    def repair_seeded_final_run(
        run_start: int,
        exact_run_end: int,
    ) -> bool:
        """Extend two trusted chant entrances across an acoustically periodic tail."""

        run_end = exact_run_end
        signature_tokens = primary_lexical_values(lines[run_start].text)
        if exact_run_end + 1 == len(repaired):
            tail_tokens = primary_lexical_values(lines[exact_run_end].text)
            prefix_matches = (
                2 <= len(tail_tokens) <= len(signature_tokens)
                and tail_tokens[:-1]
                == signature_tokens[: len(tail_tokens) - 1]
                and signature_tokens[len(tail_tokens) - 1].startswith(
                    tail_tokens[-1]
                )
            )
            if prefix_matches:
                run_end += 1
        count = run_end - run_start
        if count < 8 or run_end != len(repaired):
            return False

        first = repaired[run_start]
        second = repaired[run_start + 1]
        if not (
            stable(first)
            and stable(second)
            and first.confidence >= 0.85
            and second.confidence >= 0.85
            and first.matched_units >= 3
            and second.matched_units >= 3
        ):
            return False
        period = second.start - first.start
        if not 1.0 <= period <= 6.0:
            return False

        expected = [
            first.start + position * period
            for position in range(count)
        ]
        if not len(times) or expected[-1] > float(times[-1]) + 0.25:
            return False
        current = [
            repaired[index].start
            for index in range(run_start, run_end)
        ]
        anomaly_tolerance = max(0.8, 0.3 * period)
        if sum(
            abs(observed - target) > anomaly_tolerance
            for observed, target in zip(current, expected, strict=True)
        ) < max(4, math.ceil(0.4 * count)):
            return False

        candidates = [
            (
                max(
                    0.0,
                    float(times[index]) - cue_lead_seconds,
                ),
                float(onset_scores[index]),
            )
            for index in _soft_onset_indices(
                onset_scores,
                minimum_score=3.5,
            )
            if first.start - 0.35
            <= times[index] - cue_lead_seconds
            <= float(times[-1])
        ]
        origins = [
            (start, score)
            for start, score in candidates
            if abs(start - first.start) <= 0.35
        ]
        if not origins:
            return False
        period_lower = max(1.0, 0.92 * period)
        period_upper = min(6.0, 1.08 * period)
        period_steps = max(
            1,
            math.floor((period_upper - period_lower) / 0.01) + 1,
        )
        best: tuple[float, float, list[float]] | None = None
        for origin, origin_score in origins:
            for step in range(period_steps):
                candidate_period = period_lower + 0.01 * step
                selected = [origin]
                score = (
                    0.15 * min(origin_score, 12.0)
                    - 8.0 * abs(origin - first.start)
                    - 8.0 * abs(candidate_period - period)
                )
                for position in range(1, count):
                    target = origin + position * candidate_period
                    options = [
                        (
                            0.15 * min(candidate_score, 12.0)
                            - 24.0 * abs(candidate_start - target)
                            - 10.0
                            * abs(
                                (candidate_start - selected[-1])
                                - candidate_period
                            ),
                            candidate_start,
                        )
                        for candidate_start, candidate_score in candidates
                        if (
                            candidate_start >= selected[-1] + 0.5
                            and abs(candidate_start - target) <= 0.6
                            and abs(
                                (candidate_start - selected[-1])
                                - candidate_period
                            )
                            <= 0.75
                        )
                    ]
                    if not options:
                        selected = []
                        break
                    local_score, candidate_start = max(options)
                    selected.append(candidate_start)
                    score += local_score
                if (
                    len(selected) != count
                    or abs(selected[1] - second.start) > 0.35
                ):
                    continue
                proposal = (score, candidate_period, selected)
                if best is None or proposal[0] > best[0]:
                    best = proposal
        if best is None:
            return False
        _, selected_period, acoustic_path = best
        proposed = [first.start, second.start, *acoustic_path[2:]]

        proposed_gaps = [
            right - left
            for left, right in zip(proposed, proposed[1:])
        ]
        if (
            abs(float(median(proposed_gaps)) - selected_period) > 0.3
            or max(
                abs(gap - selected_period) for gap in proposed_gaps
            )
            > 0.85
        ):
            return False

        for position in range(2, count):
            index = run_start + position
            anchor = repaired[index]
            start = proposed[position]
            duration = max(0.0, anchor.end - anchor.start)
            end = start + duration
            if position + 1 < count:
                end = min(end, proposed[position + 1])
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.72,
                interpolated=False,
                method="acoustic_identical_repeat_cadence",
                start_uncertainty=0.18,
            )
        return True

    def repair_stretched_final_run(
        run_start: int,
        run_end: int,
    ) -> bool:
        count = run_end - run_start
        if count < 4:
            return False
        first = repaired[run_start]
        coverage = first.matched_units / max(1, first.total_units)
        current_starts = [
            repaired[index].start
            for index in range(run_start, run_end)
        ]
        rough_period = (
            current_starts[-1] - current_starts[0]
        ) / (count - 1)
        if (
            run_end != len(repaired)
            or run_start == 0
            or not first.method.startswith("lexical")
            or first.interpolated
            or first.confidence < 0.5
            or coverage < 0.5
            or first.start_uncertainty > 1.5
            or not all(
                repaired[index].interpolated
                or repaired[index].confidence < 0.3
                for index in range(run_start + 1, run_end)
            )
            or rough_period <= 8.0
            or not len(times)
            or current_starts[-1] < float(times[-1]) - 1.5
        ):
            return False

        prior_gaps = [
            repaired[index].start - repaired[index - 1].start
            for index in range(max(1, run_start - 5), run_start)
            if (
                not repaired[index].interpolated
                and not repaired[index - 1].interpolated
                and repaired[index].confidence >= 0.6
                and repaired[index - 1].confidence >= 0.6
                and 0.8
                <= repaired[index].start
                - repaired[index - 1].start
                <= 6.0
            )
        ]
        if len(prior_gaps) < 2:
            return False
        prior_period = float(median(prior_gaps))
        unit_count = max(
            1,
            len(lexical_values(lines[run_start].text)),
        )
        minimum_period = max(
            0.65,
            0.45 * min(6, unit_count),
            0.65 * prior_period,
        )
        maximum_period = min(
            6.0,
            max(minimum_period, 1.8 * prior_period),
        )
        if minimum_period > maximum_period:
            return False

        previous = repaired[run_start - 1]
        lower = max(
            first.start - 3.5,
            previous.start + 0.28,
        )
        if (
            previous.confidence >= 0.75
            and previous.start_uncertainty <= 0.75
            and previous.end > previous.start + 0.05
        ):
            lower = max(lower, previous.end + 0.05)
        upper = float(times[-1]) - cue_lead_seconds
        soft_indices = _soft_onset_indices(
            onset_scores,
            minimum_score=3.5,
        )
        candidates = [
            (
                max(
                    0.0,
                    float(times[index]) - cue_lead_seconds,
                ),
                float(onset_scores[index]),
            )
            for index in soft_indices
            if lower
            <= times[index] - cue_lead_seconds
            <= upper
        ]
        origins = [
            candidate
            for candidate in candidates
            if abs(candidate[0] - first.start) <= 3.5
        ]
        if not origins:
            return False

        best: tuple[float, float, list[float]] | None = None
        step_count = max(
            1,
            math.floor(
                (maximum_period - minimum_period) / 0.05
            )
            + 1,
        )
        for origin, origin_score in origins:
            for step in range(step_count):
                period = minimum_period + 0.05 * step
                selected = [origin]
                score = (
                    origin_score
                    - 0.25 * abs(origin - first.start)
                )
                previous_start = origin
                for position in range(1, count):
                    target = origin + position * period
                    options = [
                        (
                            candidate_score
                            - 8.0
                            * abs(candidate_start - target)
                            - 4.0
                            * abs(
                                (
                                    candidate_start
                                    - previous_start
                                )
                                - period
                            ),
                            candidate_start,
                        )
                        for candidate_start, candidate_score in candidates
                        if (
                            candidate_start >= previous_start + 0.5
                            and abs(candidate_start - target) <= 0.8
                            and abs(
                                (
                                    candidate_start
                                    - previous_start
                                )
                                - period
                            )
                            <= 0.8
                        )
                    ]
                    if not options:
                        selected = []
                        break
                    local_score, candidate_start = max(options)
                    selected.append(candidate_start)
                    score += local_score
                    previous_start = candidate_start
                if len(selected) != count:
                    continue
                proposal = (score, period, selected)
                if best is None or proposal[0] > best[0]:
                    best = proposal
        if best is None:
            return False

        _, _, proposed_starts = best
        current_gaps = [
            right - left
            for left, right in zip(
                current_starts,
                current_starts[1:],
            )
        ]
        proposed_gaps = [
            right - left
            for left, right in zip(
                proposed_starts,
                proposed_starts[1:],
            )
        ]
        current_center = float(median(current_gaps))
        proposed_center = float(median(proposed_gaps))
        current_dispersion = sum(
            abs(gap - current_center)
            for gap in current_gaps
        )
        proposed_dispersion = sum(
            abs(gap - proposed_center)
            for gap in proposed_gaps
        )
        if (
            current_dispersion - proposed_dispersion < 4.0
            or max(
                abs(proposed - current)
                for proposed, current in zip(
                    proposed_starts,
                    current_starts,
                    strict=True,
                )
            )
            > 25.0
        ):
            return False

        for offset, start in enumerate(proposed_starts):
            index = run_start + offset
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            end = start + duration
            if offset + 1 < count:
                end = min(end, proposed_starts[offset + 1])
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.5,
                interpolated=False,
                method="acoustic_identical_repeat_cadence",
                start_uncertainty=0.18,
            )
        return True

    run_start = 0
    while run_start < len(signatures):
        run_end = run_start + 1
        while (
            run_end < len(signatures)
            and signatures[run_start]
            and signatures[run_end] == signatures[run_start]
        ):
            run_end += 1
        count = run_end - run_start
        if (
            experimental_seeded_final_run
            and repair_seeded_final_run(run_start, run_end)
        ):
            run_start = len(signatures)
            continue
        if repair_stretched_final_run(run_start, run_end):
            run_start = run_end
            continue
        if count < 4 or not stable(repaired[run_start]):
            run_start = run_end
            continue
        if any(stable(repaired[index]) for index in range(
            run_start + 1,
            run_end,
        )):
            run_start = run_end
            continue

        origin = repaired[run_start].start
        current_starts = [
            repaired[index].start
            for index in range(run_start, run_end)
        ]
        rough_period = (
            current_starts[-1] - current_starts[0]
        ) / (count - 1)
        if not 0.65 <= rough_period <= 8.0:
            run_start = run_end
            continue

        following = (
            repaired[run_end].start - 0.28
            if run_end < len(repaired)
            else float(times[onset_indices[-1]]) + 0.01
        )
        candidates = [
            (
                max(
                    0.0,
                    float(times[index]) - cue_lead_seconds,
                ),
                float(onset_scores[index]),
            )
            for index in onset_indices
            if (
                origin + 0.28
                <= times[index] - cue_lead_seconds
                <= following
            )
        ]
        if len(candidates) < count - 1:
            run_start = run_end
            continue

        unit_count = max(
            1,
            len(lexical_values(lines[run_start].text)),
        )
        minimum_period = max(
            0.65,
            0.45 * min(6, unit_count),
            0.65 * rough_period,
        )
        maximum_period = min(8.0, 1.5 * rough_period)
        if minimum_period > maximum_period:
            run_start = run_end
            continue

        best: tuple[float, float, list[float]] | None = None
        step_count = max(
            1,
            math.floor(
                (maximum_period - minimum_period) / 0.05
            )
            + 1,
        )
        for step in range(step_count):
            period = minimum_period + 0.05 * step
            selected: list[float] = []
            score = 0.0
            previous = origin
            for position in range(1, count):
                target = origin + position * period
                options = [
                    (
                        candidate_score
                        - 8.0 * abs(candidate_start - target)
                        - 4.0
                        * abs(
                            (candidate_start - previous) - period
                        ),
                        candidate_start,
                    )
                    for candidate_start, candidate_score in candidates
                    if (
                        candidate_start >= previous + 0.28
                        and abs(candidate_start - target) <= 1.1
                        and abs(
                            (candidate_start - previous) - period
                        )
                        <= 1.0
                    )
                ]
                if not options:
                    selected = []
                    break
                local_score, candidate_start = max(options)
                selected.append(candidate_start)
                score += local_score
                previous = candidate_start
            if len(selected) != count - 1:
                continue
            proposal = (score, period, selected)
            if best is None or proposal[0] > best[0]:
                best = proposal
        if best is None:
            run_start = run_end
            continue

        _, _, selected = best
        proposed_starts = [origin, *selected]
        current_gaps = [
            right - left
            for left, right in zip(
                current_starts,
                current_starts[1:],
            )
        ]
        proposed_gaps = [
            right - left
            for left, right in zip(
                proposed_starts,
                proposed_starts[1:],
            )
        ]
        current_center = float(median(current_gaps))
        proposed_center = float(median(proposed_gaps))
        current_dispersion = sum(
            abs(gap - current_center)
            for gap in current_gaps
        )
        proposed_dispersion = sum(
            abs(gap - proposed_center)
            for gap in proposed_gaps
        )
        if (
            current_dispersion - proposed_dispersion < 1.0
            or max(
                abs(proposed - current)
                for proposed, current in zip(
                    proposed_starts[1:],
                    current_starts[1:],
                )
            )
            < 0.8
        ):
            run_start = run_end
            continue

        for offset, start in enumerate(
            proposed_starts[1:],
            start=1,
        ):
            index = run_start + offset
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + duration,
                confidence=0.5,
                interpolated=False,
                method="acoustic_identical_repeat_cadence",
                start_uncertainty=0.18,
            )
        run_start = run_end
    return repaired


def _repair_collapsed_repeat_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a third repeated phrase collapsed onto the second one's end.

    A recognizer can map three adjacent performances of the same phrase onto
    only two ASR segments, leaving the third row at the second segment's end.
    Extrapolate one cycle only when two reliable entrances define a long
    period, the third lexical match is otherwise well covered, the current
    third gap is clearly collapsed, and an independent acoustic attack exists
    at the predicted cycle.
    """

    repaired = list(anchors)
    if not len(onset_indices):
        return repaired
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]

    def stable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.method
            in {"lexical", "lexical_segment_start", "acoustic_onset"}
            and anchor.confidence >= 0.6
            and anchor.start_uncertainty <= 0.75
        )

    for index in range(2, len(repaired)):
        signature = signatures[index]
        if (
            not signature
            or len(signature.split()) < 3
            or signatures[index - 2] != signature
            or signatures[index - 1] != signature
        ):
            continue
        first = repaired[index - 2]
        second = repaired[index - 1]
        target = repaired[index]
        coverage = target.matched_units / max(1, target.total_units)
        if (
            not stable(first)
            or not stable(second)
            or target.interpolated
            or target.method not in {"lexical", "lexical_segment_start"}
            or target.confidence < 0.55
            or coverage < 0.75
            or target.start_uncertainty > 0.75
            or abs(target.start - second.end) > 0.15
        ):
            continue

        period = second.start - first.start
        collapsed_gap = target.start - second.start
        predicted = second.start + period
        shift = predicted - target.start
        following_start = (
            repaired[index + 1].start
            if index + 1 < len(repaired)
            else math.inf
        )
        following = (
            following_start - 0.28
            if math.isfinite(following_start)
            else (
                float(times[onset_indices[-1]])
                - cue_lead_seconds
                + 0.6
            )
        )
        if (
            not 2.0 <= period <= 12.0
            or collapsed_gap < 0.28
            or collapsed_gap >= 0.45 * period
            or not 2.5 <= shift <= 10.0
            or predicted > following
        ):
            continue

        acoustic_support = any(
            onset_scores[candidate] >= 9.0
            and abs(
                (
                    float(times[candidate])
                    - cue_lead_seconds
                )
                - predicted
            )
            <= max(0.65, 0.08 * period)
            for candidate in onset_indices
        )
        if not acoustic_support:
            continue

        duration = max(0.0, target.end - target.start)
        end = max(0.0, predicted) + duration
        if math.isfinite(following_start):
            end = min(end, following_start)
        repaired[index] = replace(
            target,
            start=max(0.0, predicted),
            end=max(0.0, end),
            confidence=max(0.55, min(0.75, target.confidence)),
            interpolated=False,
            method="repeat_collapsed_cadence",
            start_uncertainty=0.25,
        )
    return repaired


def _repair_trailing_rhythmic_run(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Jointly place a short, repetitive outro that ASR mostly missed."""

    repaired = list(anchors)
    run_start = len(repaired)
    while run_start > 0:
        anchor = repaired[run_start - 1]
        if not (anchor.interpolated or anchor.confidence < 0.3):
            break
        run_start -= 1
    # The first row of the outro is often the only one found acoustically.
    if (
        run_start > 0
        and run_start < len(repaired)
        and repaired[run_start - 1].confidence <= 0.5
        and repaired[run_start - 1].method
        in {
            "acoustic_onset",
            "acoustic_repeat_offset_outlier",
            "acoustic_trailing_activity",
        }
        and len(lexical_values(lines[run_start - 1].text)) <= 4
    ):
        run_start -= 1

    count = len(repaired) - run_start
    if count < 4 or run_start == 0:
        return repaired
    values = [
        lexical_values(lines[index].text)
        for index in range(run_start, len(lines))
    ]
    if (
        any(not value or len(value) > 4 for value in values)
        or len({token for value in values for token in value}) > 4
    ):
        return repaired

    previous = repaired[run_start - 1]
    if previous.confidence < 0.5:
        return repaired
    first_estimate = repaired[run_start].start
    prior_gaps = [
        repaired[index].start - repaired[index - 1].start
        for index in range(
            max(1, run_start - 4),
            run_start,
        )
        if 0.8
        <= repaired[index].start - repaired[index - 1].start
        <= 6.0
    ]
    if len(prior_gaps) < 2:
        return repaired
    prior_period = float(median(prior_gaps))

    soft_indices = _soft_onset_indices(onset_scores)
    candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
        if (
            times[index] - cue_lead_seconds
            >= previous.start + 0.28
        )
    ]
    origins = [
        candidate
        for candidate in candidates
        if abs(candidate[0] - first_estimate) <= 1.5
    ]
    if not origins:
        return repaired

    minimum_period = max(1.35, 0.65 * prior_period)
    maximum_period = min(5.0, 1.5 * prior_period)
    best: tuple[
        float,
        float,
        list[float],
        bool,
    ] | None = None
    step_count = max(
        1,
        math.floor(
            (maximum_period - minimum_period) / 0.05
        )
        + 1,
    )
    for origin, origin_score in origins:
        for step in range(step_count):
            period = minimum_period + 0.05 * step
            selected = [origin]
            score = (
                origin_score
                - 10.0 * abs(period - prior_period)
            )
            previous_start = origin
            extrapolated = False
            for position in range(1, count):
                target = origin + position * period
                options = [
                    (
                        candidate_score
                        - 7.0 * abs(candidate_start - target)
                        - 3.0
                        * abs(
                            (candidate_start - previous_start)
                            - period
                        ),
                        candidate_start,
                    )
                    for candidate_start, candidate_score in candidates
                    if (
                        candidate_start >= previous_start + 1.35
                        and abs(candidate_start - target) <= 1.0
                        and abs(
                            (candidate_start - previous_start)
                            - period
                        )
                        <= 1.1
                    )
                ]
                if not options:
                    if position == count - 1:
                        selected.append(target)
                        score -= 8.0
                        previous_start = target
                        extrapolated = True
                        continue
                    selected = []
                    break
                local_score, candidate_start = max(options)
                selected.append(candidate_start)
                score += local_score
                previous_start = candidate_start
            if len(selected) != count:
                continue
            proposal = (
                score,
                period,
                selected,
                extrapolated,
            )
            if best is None or proposal[0] > best[0]:
                best = proposal
    if best is None:
        return repaired

    _, _, proposed_starts, extrapolated = best
    current_starts = [
        repaired[index].start
        for index in range(run_start, len(repaired))
    ]
    current_gaps = [
        right - left
        for left, right in zip(
            current_starts,
            current_starts[1:],
        )
    ]
    proposed_gaps = [
        right - left
        for left, right in zip(
            proposed_starts,
            proposed_starts[1:],
        )
    ]
    current_center = float(median(current_gaps))
    proposed_center = float(median(proposed_gaps))
    current_dispersion = sum(
        abs(gap - current_center)
        for gap in current_gaps
    )
    proposed_dispersion = sum(
        abs(gap - proposed_center)
        for gap in proposed_gaps
    )
    if current_dispersion - proposed_dispersion < 2.0:
        return repaired

    for offset, start in enumerate(proposed_starts):
        index = run_start + offset
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        is_extrapolated = extrapolated and offset == count - 1
        repaired[index] = replace(
            anchor,
            start=start,
            end=start + duration,
            confidence=0.36 if is_extrapolated else 0.46,
            interpolated=is_extrapolated,
            method="acoustic_trailing_cadence",
            start_uncertainty=0.45 if is_extrapolated else 0.2,
        )
    return repaired


def _repair_recurrent_identical_line_runs(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Use cross-section cadence to disambiguate a repeated one-line chant."""

    repaired = list(anchors)
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    grouped_runs: dict[str, list[tuple[int, int]]] = {}
    run_start = 0
    while run_start < len(signatures):
        run_end = run_start + 1
        while (
            run_end < len(signatures)
            and signatures[run_start]
            and signatures[run_end] == signatures[run_start]
        ):
            run_end += 1
        if run_end - run_start >= 2:
            grouped_runs.setdefault(
                signatures[run_start],
                [],
            ).append((run_start, run_end))
        run_start = run_end

    soft_indices = _soft_onset_indices(onset_scores)
    if not len(soft_indices):
        return repaired
    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
    ]
    for runs in grouped_runs.values():
        if (
            len(runs) < 3
            or sum(end - start for start, end in runs) < 8
        ):
            continue
        gap_samples = [
            repaired[index].start
            - repaired[index - 1].start
            for start, end in runs
            for index in range(start + 1, end)
            if 0.8
            <= repaired[index].start
            - repaired[index - 1].start
            <= 5.0
        ]
        if len(gap_samples) < 6:
            continue
        period = float(median(gap_samples))
        if not 1.0 <= period <= 5.0:
            continue
        supporting_gaps = sum(
            abs(gap - period) <= 0.75
            for gap in gap_samples
        )
        if supporting_gaps < math.ceil(0.6 * len(gap_samples)):
            continue

        for start, end in runs:
            count = end - start
            if count < 3:
                continue
            current_starts = [
                repaired[index].start
                for index in range(start, end)
            ]
            current_gaps = [
                right - left
                for left, right in zip(
                    current_starts,
                    current_starts[1:],
                )
            ]
            run_period = float(median(current_gaps))
            following_limit = (
                repaired[end].start - 0.28
                if end < len(repaired)
                else math.inf
            )
            collides_with_following = (
                end < len(repaired)
                and following_limit - current_starts[-1]
                < 0.5 * period
            )
            if (
                abs(run_period - period) < 0.65
                and not collides_with_following
            ):
                continue
            if any(
                (
                    repaired[index].method == "lexical"
                    and repaired[index].confidence >= 0.75
                    and repaired[index].start_uncertainty <= 0.75
                )
                for index in range(start, end)
            ):
                continue

            previous_start = (
                repaired[start - 1].start
                if start
                else 0.0
            )
            lower = previous_start + (0.28 if start else 0.0)
            upper = (
                following_limit
                if math.isfinite(following_limit)
                else (
                    float(times[soft_indices[-1]])
                    - cue_lead_seconds
                    + 1.5 * period
                )
            )
            candidates = [
                candidate
                for candidate in acoustic_candidates
                if lower <= candidate[0] <= upper
            ]
            if len(candidates) < count - 1:
                continue
            origins = list(candidates)
            final_run = end == len(repaired)
            if final_run and start:
                origins.append(
                    (previous_start + period, 20.0)
                )

            best: tuple[
                float,
                list[float],
                bool,
            ] | None = None
            for origin, origin_score in origins:
                if not lower <= origin <= upper:
                    continue
                selected = [origin]
                score = (
                    origin_score
                    - 0.25 * abs(origin - current_starts[0])
                )
                synthetic_origin = (
                    final_run
                    and start > 0
                    and abs(
                        origin - (previous_start + period)
                    )
                    < 1e-6
                )
                if final_run and start:
                    score -= 10.0 * abs(
                        (origin - previous_start) - period
                    )
                old_start = origin
                for position in range(1, count):
                    target = origin + position * period
                    options = [
                        (
                            candidate_score
                            - 8.0
                            * abs(candidate_start - target)
                            - 3.0
                            * abs(
                                (candidate_start - old_start)
                                - period
                            )
                            - 0.25
                            * abs(
                                candidate_start
                                - current_starts[position]
                            ),
                            candidate_start,
                        )
                        for (
                            candidate_start,
                            candidate_score,
                        ) in candidates
                        if (
                            candidate_start
                            >= old_start + max(0.5, 0.5 * period)
                            and abs(
                                candidate_start - target
                            )
                            <= 0.9
                            and abs(
                                (candidate_start - old_start)
                                - period
                            )
                            <= 0.9
                        )
                    ]
                    if not options:
                        selected = []
                        break
                    local_score, candidate_start = max(options)
                    selected.append(candidate_start)
                    score += local_score
                    old_start = candidate_start
                if (
                    len(selected) != count
                    or selected[-1] > upper
                ):
                    continue
                proposal = (
                    score,
                    selected,
                    synthetic_origin,
                )
                if best is None or proposal[0] > best[0]:
                    best = proposal
            if best is None:
                continue

            _, proposed_starts, synthetic_origin = best
            maximum_shift = max(
                abs(proposed - current)
                for proposed, current in zip(
                    proposed_starts,
                    current_starts,
                )
            )
            if (
                maximum_shift < 0.8
                or maximum_shift > max(10.0, 3.0 * period)
            ):
                continue
            for offset, proposed in enumerate(proposed_starts):
                index = start + offset
                anchor = repaired[index]
                duration = max(0.0, anchor.end - anchor.start)
                repaired[index] = replace(
                    anchor,
                    start=proposed,
                    end=proposed + duration,
                    confidence=(
                        0.42
                        if synthetic_origin and offset == 0
                        else 0.48
                    ),
                    interpolated=False,
                    method="repeat_line_consensus",
                    start_uncertainty=(
                        0.35
                        if synthetic_origin and offset == 0
                        else 0.18
                    ),
                )
    return repaired


def _consecutive_repeat_indices(
    lines: list[TranscriptLine],
    *,
    minimum: int = 3,
) -> set[int]:
    signatures = [
        " ".join(lexical_values(line.text))
        for line in lines
    ]
    repeated: set[int] = set()
    run_start = 0
    while run_start < len(signatures):
        run_end = run_start + 1
        while (
            run_end < len(signatures)
            and signatures[run_start]
            and signatures[run_end] == signatures[run_start]
        ):
            run_end += 1
        if run_end - run_start >= minimum:
            repeated.update(range(run_start, run_end))
        run_start = run_end
    return repeated


def _repair_acoustic_fragment_sequences(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
    reference_anchors: list[CoarseLineAnchor] | None = None,
) -> list[CoarseLineAnchor]:
    """Jointly assign distinct entrances to adjacent one-word fragments."""

    repaired = list(anchors)
    short = [
        len(lexical_values(line.text)) <= 2
        for line in lines
    ]
    run_start = 0
    while run_start < len(short):
        if not short[run_start]:
            run_start += 1
            continue
        run_end = run_start + 1
        while run_end < len(short) and short[run_end]:
            run_end += 1
        if run_end - run_start < 2:
            run_start = run_end
            continue
        sequence_end = run_end
        if (
            sequence_end < len(lines)
            and len(lexical_values(lines[sequence_end].text)) <= 6
        ):
            sequence_end += 1
        appended_tail_index = (
            run_end
            if sequence_end > run_end
            else None
        )
        if run_start == 0 or sequence_end >= len(lines):
            run_start = run_end
            continue

        lower = max(
            repaired[run_start - 1].start + 0.28,
            repaired[run_start].start - 1.5,
        )
        upper = min(
            repaired[sequence_end].start - 0.28,
            repaired[sequence_end - 1].start + 3.5,
        )
        candidates = [
            int(candidate)
            for candidate in onset_indices
            if (
                lower
                <= times[candidate] - cue_lead_seconds
                <= upper
                and onset_scores[candidate] >= 9.0
            )
        ]
        count = sequence_end - run_start
        if len(candidates) < count:
            run_start = run_end
            continue

        def protected_tail_rejects(
            line_index: int,
            start: float,
            reference_anchor: CoarseLineAnchor,
        ) -> bool:
            reference_coverage = (
                reference_anchor.matched_units
                / reference_anchor.total_units
                if reference_anchor.total_units
                else 0.0
            )
            return (
                line_index == appended_tail_index
                and reference_anchor.method
                in {"lexical", "lexical_segment_start"}
                and reference_anchor.confidence >= 0.55
                and reference_coverage >= 0.5
                and reference_anchor.start_uncertainty <= 1.0
                and start < reference_anchor.start - 1.5
            )

        def precise_fragment_rejects(
            line_index: int,
            start: float,
            reference_anchor: CoarseLineAnchor,
        ) -> bool:
            """Keep exact short-word timestamps inside their tight window."""

            reference_coverage = (
                reference_anchor.matched_units
                / reference_anchor.total_units
                if reference_anchor.total_units
                else 0.0
            )
            return (
                line_index < run_end
                and reference_anchor.method
                in {"lexical", "lexical_segment_start"}
                and reference_anchor.confidence >= 0.95
                and reference_coverage >= 0.999
                and reference_anchor.start_uncertainty <= 0.35
                and abs(start - reference_anchor.start) > 0.75
            )

        negative_infinity = -1e30
        scores = [
            [negative_infinity] * len(candidates)
            for _ in range(count)
        ]
        traces = [
            [-1] * len(candidates)
            for _ in range(count)
        ]
        for line_offset in range(count):
            line_index = run_start + line_offset
            anchor = repaired[line_index]
            reference_anchor = (
                reference_anchors[line_index]
                if reference_anchors is not None
                else anchor
            )
            for candidate_position, candidate in enumerate(candidates):
                start = max(
                    0.0,
                    float(times[candidate]) - cue_lead_seconds,
                )
                maximum_anchor_shift = (
                    12.0
                    if anchor.interpolated or anchor.confidence < 0.3
                    else (
                        8.0
                        if (
                            reference_anchor.total_units <= 1
                            and reference_anchor.start_uncertainty >= 1.0
                        )
                        else 4.5
                    )
                )
                if abs(start - anchor.start) > maximum_anchor_shift:
                    continue
                if (
                    line_index > 0
                    and reference_anchors is not None
                    and reference_anchor.method == "lexical"
                    and reference_anchor.confidence >= 0.55
                    and reference_anchors[line_index - 1].confidence >= 0.5
                    and start
                    < reference_anchors[line_index - 1].end - 0.7
                ):
                    continue
                distance_weight = (
                    0.75
                    if (
                        reference_anchor.total_units <= 1
                        and reference_anchor.start_uncertainty >= 1.0
                    )
                    else 1.5
                )
                local = (
                    float(onset_scores[candidate])
                    - distance_weight * abs(start - anchor.start)
                )
                if line_offset == 0:
                    scores[line_offset][candidate_position] = local
                    continue
                for old_position in range(candidate_position):
                    old_candidate = candidates[old_position]
                    if (
                        times[candidate] - times[old_candidate]
                        < 0.28
                    ):
                        continue
                    value = (
                        scores[line_offset - 1][old_position]
                        + local
                    )
                    if value > scores[line_offset][candidate_position]:
                        scores[line_offset][candidate_position] = value
                        traces[line_offset][candidate_position] = (
                            old_position
                        )
        candidate_position = max(
            range(len(candidates)),
            key=lambda item: scores[-1][item],
        )
        if scores[-1][candidate_position] < 18.0 * count:
            run_start = run_end
            continue
        if appended_tail_index is not None:
            reference_anchor = (
                reference_anchors[appended_tail_index]
                if reference_anchors is not None
                else repaired[appended_tail_index]
            )
            selected_tail_start = max(
                0.0,
                float(times[candidates[candidate_position]])
                - cue_lead_seconds,
            )
            if protected_tail_rejects(
                appended_tail_index,
                selected_tail_start,
                reference_anchor,
            ):
                # Prefer a complete joint path whose context tail can
                # actually be written. If no such path clears the same
                # confidence floor, keep the old short-fragment path and
                # restore only the protected tail below. This prevents a
                # distant later fragment from losing its valid entrance
                # merely because no acoustic candidate exists near the
                # appended lexical context line.
                usable_tail_positions = [
                    position
                    for position, candidate in enumerate(candidates)
                    if (
                        scores[-1][position] >= 18.0 * count
                        and not protected_tail_rejects(
                            appended_tail_index,
                            max(
                                0.0,
                                float(times[candidate])
                                - cue_lead_seconds,
                            ),
                            reference_anchor,
                        )
                    )
                ]
                if usable_tail_positions:
                    candidate_position = max(
                        usable_tail_positions,
                        key=lambda item: scores[-1][item],
                    )
        selected: list[int] = []
        for line_offset in range(count - 1, -1, -1):
            if candidate_position < 0:
                selected = []
                break
            selected.append(candidates[candidate_position])
            candidate_position = traces[line_offset][candidate_position]
        if len(selected) != count:
            run_start = run_end
            continue
        selected.reverse()
        selected_starts = {
            run_start + line_offset: max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            )
            for line_offset, candidate in enumerate(selected)
        }
        selected_path_ends = {
            index: start
            + max(
                0.0,
                repaired[index].end - repaired[index].start,
            )
            for index, start in selected_starts.items()
        }
        precise_rejected_indices: set[int] = set()
        for line_offset, candidate in enumerate(selected):
            index = run_start + line_offset
            anchor = repaired[index]
            reference_anchor = (
                reference_anchors[index]
                if reference_anchors is not None
                else anchor
            )
            start = selected_starts[index]
            if protected_tail_rejects(
                index,
                start,
                reference_anchor,
            ):
                # A run of one- or two-word fragments may borrow one
                # following line so its last entrance is not collapsed.
                # That context line is not itself a fragment: a strong
                # internal syllable from the preceding chant must not
                # drag an already constrained lexical entrance several
                # seconds backwards.  Reject only this write so the short
                # fragment path itself stays unchanged, and restore the
                # original lexical evidence if an earlier vocalization pass
                # had already claimed the same activity cluster.
                repaired[index] = reference_anchor
                continue
            if precise_fragment_rejects(
                index,
                start,
                reference_anchor,
            ):
                # Keep the joint path available to neighbouring weak rows,
                # but do not overwrite an independent, exact lexical
                # observation with a distant syllable. Rejecting this
                # candidate during path search would make the entire run
                # choose a different route and disturb otherwise valid
                # fragment entrances.
                can_restore_precise = True
                if (
                    index > run_start
                    and reference_anchor.start
                    < repaired[index - 1].start + 0.28
                ):
                    previous_reference = (
                        reference_anchors[index - 1]
                        if reference_anchors is not None
                        else repaired[index - 1]
                    )
                    previous_is_weak = (
                        previous_reference.interpolated
                        or previous_reference.confidence < 0.55
                        or previous_reference.method
                        in {
                            "repeat_transfer",
                            "acoustic_repeat_transfer",
                        }
                    )
                    previous_lower_bound = (
                        repaired[index - 2].start + 0.28
                        if index - 2 >= 0
                        else 0.0
                    )
                    if (
                        previous_is_weak
                        and previous_reference.start
                        >= previous_lower_bound
                        and previous_reference.start + 0.28
                        <= reference_anchor.start
                    ):
                        # The distant onset assigned to the preceding weak
                        # fragment is what made this precise row appear
                        # non-monotonic. Restore that weak row only when its
                        # independent reference position fits cleanly between
                        # both neighbours; otherwise retain the original
                        # joint path below.
                        repaired[index - 1] = previous_reference
                    else:
                        # Protecting the exact row would invert the timeline
                        # and the weak predecessor has no safe independent
                        # position. Keep the unchanged joint assignment.
                        can_restore_precise = False
                if can_restore_precise:
                    repaired[index] = reference_anchor
                    precise_rejected_indices.add(index)
                    continue
            previous_confidence = (
                repaired[index - 1].confidence
                if index > 0
                else 0.0
            )
            previous_end = (
                repaired[index - 1].end
                if index > 0
                else 0.0
            )
            if index - 1 in precise_rejected_indices:
                # The previous precise row was restored above, but the joint
                # path originally assigned it this acoustic window. Use that
                # planned window solely for the following overlap guard so
                # restoring one row cannot newly authorize a neighbouring
                # write that the unchanged path would have rejected.
                previous_confidence = 0.55
                previous_end = selected_path_ends[index - 1]
            if (
                index > 0
                and reference_anchor.method == "lexical"
                and reference_anchor.confidence >= 0.55
                and previous_confidence >= 0.5
                and start < previous_end - 0.7
            ):
                # The joint path is useful for collapsed one-word rows, but
                # an internal syllable of the previous well-matched phrase
                # must not replace an already constrained lexical entrance.
                # This guard still permits large forward corrections when
                # genuinely distinct acoustic attacks resolve the collapse.
                continue
            repaired[index] = replace(
                anchor,
                start=start,
                end=start + max(0.0, anchor.end - anchor.start),
                confidence=0.55,
                interpolated=False,
                method="acoustic_fragment_sequence",
                start_uncertainty=0.12,
            )
        run_start = run_end
    return repaired


def _stabilize_repeat_offsets(
    lines: list[TranscriptLine],
    base: list[CoarseLineAnchor],
    refined: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Reject independent acoustic moves that break an exact repeat offset."""

    stabilized = list(refined)
    signatures = [
        " ".join(lexical_values(line.text))
        for line in lines
    ]
    for left, right, length in _repeated_blocks(lines):
        pattern = signatures[left : left + length]
        occurrence_count = sum(
            signatures[start : start + length] == pattern
            for start in range(len(signatures) - length + 1)
        )
        # Two performances of the same verse can legitimately use different
        # rubato.  Offset locking is reserved for chants/refrains observed at
        # least three times, where an independent multi-second jump is much
        # more likely to be an onset-selection mistake.
        if occurrence_count < 3:
            continue
        offset = _repeat_offset_consensus(base, left, right, length)
        if offset is None:
            continue
        for position in range(length):
            first_index = left + position
            second_index = right + position
            first = stabilized[first_index]
            second = stabilized[second_index]
            current_deviation = abs(
                (second.start - first.start) - offset
            )
            if current_deviation <= 0.8:
                continue
            choices = [
                (first, second, 0),
                (base[first_index], second, 1),
                (first, base[second_index], 1),
                (base[first_index], base[second_index], 2),
            ]
            valid: list[
                tuple[float, CoarseLineAnchor, CoarseLineAnchor]
            ] = []
            for first_choice, second_choice, reversions in choices:
                if (
                    first_index
                    and first_choice.start
                    < stabilized[first_index - 1].start + 0.28
                ):
                    continue
                if (
                    first_index + 1 < len(stabilized)
                    and first_choice.start
                    > stabilized[first_index + 1].start - 0.28
                ):
                    continue
                if (
                    second_index
                    and second_choice.start
                    < stabilized[second_index - 1].start + 0.28
                ):
                    continue
                if (
                    second_index + 1 < len(stabilized)
                    and second_choice.start
                    > stabilized[second_index + 1].start - 0.28
                ):
                    continue
                cost = (
                    3.0
                    * abs(
                        (
                            second_choice.start
                            - first_choice.start
                        )
                        - offset
                    )
                    + 0.2 * reversions
                )
                valid.append((cost, first_choice, second_choice))
            if not valid:
                continue
            _, first_choice, second_choice = min(
                valid,
                key=lambda item: item[0],
            )
            proposed_deviation = abs(
                (
                    second_choice.start
                    - first_choice.start
                )
                - offset
            )
            if current_deviation - proposed_deviation < 0.8:
                # One badly aligned occurrence must not undo a small acoustic
                # correction already supported by several other copies. Only
                # revert when repeat consistency improves materially.
                continue
            stabilized[first_index] = first_choice
            stabilized[second_index] = second_choice
    return stabilized


def _repair_dense_repeat_offset_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Transfer a stable long-section offset onto one uncertain counterpart.

    Two performances may use real rubato, so this is deliberately narrower
    than ordinary repeat transfer: the exact repeated block must be long,
    the offset must have a consensus, and the moved side must be clearly less
    reliable than its counterpart.
    """

    repaired = list(anchors)
    repaired_indices: set[int] = set()
    for left, right, length in _repeated_blocks(lines):
        if length < 6:
            continue
        offset = _repeat_offset_consensus(
            repaired,
            left,
            right,
            length,
        )
        if offset is None:
            continue
        for position in range(length):
            first_index = left + position
            second_index = right + position
            if (
                first_index in repaired_indices
                or second_index in repaired_indices
            ):
                continue
            first = repaired[first_index]
            second = repaired[second_index]
            deviation = (second.start - first.start) - offset
            if abs(deviation) < 1.0:
                continue

            def weakness(anchor: CoarseLineAnchor) -> float:
                coverage = anchor.matched_units / max(
                    1,
                    anchor.total_units,
                )
                return (
                    1.5 * min(3.0, anchor.start_uncertainty)
                    + (0.8 if anchor.interpolated else 0.0)
                    + max(0.0, 0.6 - anchor.confidence)
                    + 0.3 * max(0.0, 0.7 - coverage)
                )

            first_weakness = weakness(first)
            second_weakness = weakness(second)
            if abs(first_weakness - second_weakness) < 0.5:
                continue
            if first_weakness > second_weakness:
                target_index = first_index
                source = second
                target = first
                predicted = second.start - offset
            else:
                target_index = second_index
                source = first
                target = second
                predicted = first.start + offset
            target_is_uncertain = (
                target.interpolated
                or target.confidence < 0.6
                or target.start_uncertainty >= 0.75
            )
            source_is_stable = (
                not source.interpolated
                and source.confidence >= 0.4
                and source.start_uncertainty <= 0.5
            )
            if not (target_is_uncertain and source_is_stable):
                continue
            previous = (
                repaired[target_index - 1].start + 0.28
                if target_index
                else 0.0
            )
            following = (
                repaired[target_index + 1].start - 0.28
                if target_index + 1 < len(repaired)
                else math.inf
            )
            if (
                not previous <= predicted <= following
                or abs(predicted - target.start) > 4.5
            ):
                continue
            duration = max(0.0, target.end - target.start)
            repaired[target_index] = replace(
                target,
                start=max(0.0, predicted),
                end=max(0.0, predicted) + duration,
                confidence=max(
                    0.45,
                    min(0.65, source.confidence),
                ),
                interpolated=False,
                method="repeat_offset_consensus",
                start_uncertainty=0.25,
            )
            repaired_indices.add(target_index)
    return repaired


def _repair_unique_dense_repeat_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    *,
    acoustic_starts: list[float] | None = None,
) -> list[CoarseLineAnchor]:
    """Repair the only displaced row in two long exact performances.

    With only two performances, offset consensus alone cannot determine which
    copy is wrong. Move a row only when at least five other positions establish
    one dense offset template, exactly one position is three seconds or more
    away, and only one of the two possible corrections remains monotonic. This
    lets the neighboring rows choose the direction instead of trusting either
    performance or a benchmark-specific timestamp.
    """

    repaired = list(anchors)
    repaired_indices: set[int] = set()
    for left, right, length in _repeated_blocks(lines):
        if length < 6:
            continue
        offsets = [
            repaired[right + position].start
            - repaired[left + position].start
            for position in range(length)
        ]
        center = float(median(offsets))
        seed_inliers = [
            offset
            for offset in offsets
            if abs(offset - center) <= 1.4
        ]
        if len(seed_inliers) < max(5, math.ceil(0.65 * length)):
            continue
        center = float(median(seed_inliers))
        deviations = [offset - center for offset in offsets]
        outlier_positions = [
            position
            for position, deviation in enumerate(deviations)
            if abs(deviation) >= 3.0
        ]
        if len(outlier_positions) != 1:
            continue
        position = outlier_positions[0]
        if any(
            abs(deviation) > 2.25
            for index, deviation in enumerate(deviations)
            if index != position
        ):
            continue

        def supports_template(anchor: CoarseLineAnchor) -> bool:
            return (
                not anchor.interpolated
                and anchor.confidence >= 0.4
                and anchor.start_uncertainty <= 1.0
            )

        supported_inliers = sum(
            supports_template(repaired[left + index])
            and supports_template(repaired[right + index])
            for index, deviation in enumerate(deviations)
            if index != position and abs(deviation) <= 1.4
        )
        if supported_inliers < max(4, math.ceil(0.5 * length)):
            continue

        left_index = left + position
        right_index = right + position
        options: list[tuple[int, float]] = []
        for side, target_index, source_index, predicted in (
            (
                "left",
                left_index,
                right_index,
                repaired[right_index].start - center,
            ),
            (
                "right",
                right_index,
                left_index,
                repaired[left_index].start + center,
            ),
        ):
            target = repaired[target_index]
            source = repaired[source_index]
            target_coverage = target.matched_units / max(
                1,
                target.total_units,
            )
            acoustically_confirmed_precise = (
                acoustic_starts is not None
                and target.method == "lexical"
                and target.confidence >= 0.9
                and target_coverage >= 0.95
                and target.start_uncertainty <= 0.25
                and any(
                    abs(candidate - target.start) <= 0.35
                    for candidate in acoustic_starts
                )
            )
            if (
                target_index in repaired_indices
                or source_index in repaired_indices
                or target.interpolated
                or target.confidence < 0.65
                or target.method not in {"lexical", "lexical_segment_start"}
                or not supports_template(source)
                or acoustically_confirmed_precise
            ):
                continue
            shift = predicted - target.start
            previous = (
                repaired[target_index - 1].start + 0.28
                if target_index
                else 0.0
            )
            following = (
                repaired[target_index + 1].start - 0.28
                if target_index + 1 < len(repaired)
                else math.inf
            )
            if (
                not 3.0 <= abs(shift) <= 8.0
                or not previous <= predicted <= following
            ):
                continue

            local_before = 0.0
            local_after = 0.0
            if position > 0:
                left_gap = (
                    repaired[left_index].start
                    - repaired[left_index - 1].start
                )
                right_gap = (
                    repaired[right_index].start
                    - repaired[right_index - 1].start
                )
                local_before += abs(left_gap - right_gap)
                if side == "left":
                    left_gap = (
                        predicted - repaired[left_index - 1].start
                    )
                else:
                    right_gap = (
                        predicted - repaired[right_index - 1].start
                    )
                local_after += abs(left_gap - right_gap)
            if position + 1 < length:
                left_gap = (
                    repaired[left_index + 1].start
                    - repaired[left_index].start
                )
                right_gap = (
                    repaired[right_index + 1].start
                    - repaired[right_index].start
                )
                local_before += abs(left_gap - right_gap)
                if side == "left":
                    left_gap = (
                        repaired[left_index + 1].start - predicted
                    )
                else:
                    right_gap = (
                        repaired[right_index + 1].start - predicted
                    )
                local_after += abs(left_gap - right_gap)
            if local_before - local_after < 2.5:
                continue
            options.append((target_index, predicted))

        if len(options) != 1:
            continue
        target_index, predicted = options[0]
        target = repaired[target_index]
        duration = max(0.0, target.end - target.start)
        repaired[target_index] = replace(
            target,
            start=max(0.0, predicted),
            end=max(0.0, predicted) + duration,
            confidence=max(0.55, min(0.75, target.confidence)),
            interpolated=False,
            method="repeat_unique_dense_outlier",
            start_uncertainty=0.25,
        )
        repaired_indices.add(target_index)
    return repaired


def _repair_repeat_suffix_offset_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
) -> list[CoarseLineAnchor]:
    """Realign one delayed suffix of a long exact repeated section.

    The first three or more row offsets must agree, while the final three or
    more offsets must share one four-second-or-larger jump.  The affected
    performance must expose that jump as an anomalously long boundary gap, and
    every moved row must remain low-reliability.
    """

    repaired = list(anchors)
    repaired_indices: set[int] = set()
    for left, right, length in _repeated_blocks(lines):
        if length < 6:
            continue
        offsets = [
            repaired[right + position].start
            - repaired[left + position].start
            for position in range(length)
        ]
        for split in range(3, length - 2):
            prefix_offsets = offsets[:split]
            if max(prefix_offsets) - min(prefix_offsets) > 0.8:
                continue
            offset = float(median(prefix_offsets))
            suffix_deviations = [
                value - offset for value in offsets[split:]
            ]
            deviation = float(median(suffix_deviations))
            if (
                max(suffix_deviations) - min(suffix_deviations) > 1.0
                or not 4.0 <= abs(deviation) <= 12.0
            ):
                continue

            left_gap = (
                repaired[left + split].start
                - repaired[left + split - 1].start
            )
            right_gap = (
                repaired[right + split].start
                - repaired[right + split - 1].start
            )
            if abs(left_gap - right_gap) < 3.5:
                continue
            if left_gap > right_gap and deviation < 0.0:
                target_start = left
                source_start = right
                proposed = [
                    repaired[source_start + position].start - offset
                    for position in range(split, length)
                ]
            elif right_gap > left_gap and deviation > 0.0:
                target_start = right
                source_start = left
                proposed = [
                    repaired[source_start + position].start + offset
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
            if any(index in repaired_indices for index in target_indices):
                continue
            if not all(
                repaired[index].interpolated
                or repaired[index].confidence < 0.6
                or repaired[index].start_uncertainty > 0.75
                for index in target_indices
            ):
                continue

            def structurally_stable(anchor: CoarseLineAnchor) -> bool:
                return (
                    not anchor.interpolated
                    and anchor.confidence >= 0.32
                    and anchor.start_uncertainty <= 0.9
                )

            if (
                sum(
                    structurally_stable(repaired[index])
                    for index in source_indices
                )
                < 1
                or sum(
                    structurally_stable(repaired[left + position])
                    and structurally_stable(
                        repaired[right + position]
                    )
                    for position in range(split)
                )
                < 3
            ):
                continue

            previous = repaired[target_indices[0] - 1].start + 0.28
            following = (
                repaired[target_indices[-1] + 1].start - 0.28
                if target_indices[-1] + 1 < len(repaired)
                else math.inf
            )
            if (
                proposed[0] < previous
                or proposed[-1] > following
                or any(
                    right_start - left_start < 0.28
                    for left_start, right_start in zip(
                        proposed,
                        proposed[1:],
                    )
                )
                or max(
                    abs(
                        proposed_start - repaired[index].start
                    )
                    for index, proposed_start in zip(
                        target_indices,
                        proposed,
                        strict=True,
                    )
                )
                > 12.0
            ):
                continue

            for index, start in zip(
                target_indices,
                proposed,
                strict=True,
            ):
                anchor = repaired[index]
                duration = max(0.0, anchor.end - anchor.start)
                repaired[index] = replace(
                    anchor,
                    start=max(0.0, start),
                    end=max(0.0, start) + duration,
                    confidence=0.45,
                    interpolated=False,
                    method="repeat_suffix_offset_consensus",
                    start_uncertainty=0.3,
                )
                repaired_indices.add(index)
            break
    return repaired


def _repair_boundary_locked_alternating_runs(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Backfill a broken ABAB outro from its reliable following boundary.

    The run must contain at least six exact alternating rows, begin at a
    section boundary, and be followed by a reliable prefix of the next
    expected row.  A surrounding stable cadence limits the period search;
    every repaired row must map to a hard acoustic attack.  Half-cadence
    instrumental attacks therefore cannot consume the lyric rows.
    """

    repaired = list(anchors)
    if not len(onset_indices):
        return repaired
    values = [
        primary_lexical_values(line.text)
        for line in lines
    ]
    signatures = [" ".join(value) for value in values]

    def stable(
        anchor: CoarseLineAnchor,
        *,
        confidence: float = 0.75,
        uncertainty: float = 0.8,
    ) -> bool:
        return (
            anchor.method.startswith("lexical")
            and not anchor.interpolated
            and anchor.confidence >= confidence
            and anchor.start_uncertainty <= uncertainty
        )

    run_start = 0
    while run_start + 5 < len(repaired):
        first_signature = signatures[run_start]
        second_signature = signatures[run_start + 1]
        if (
            not first_signature
            or not second_signature
            or first_signature == second_signature
            or not all(
                signatures[index]
                == (
                    first_signature
                    if (index - run_start) % 2 == 0
                    else second_signature
                )
                for index in range(run_start, run_start + 6)
            )
        ):
            run_start += 1
            continue
        run_end = run_start + 6
        while (
            run_end < len(repaired)
            and signatures[run_end]
            == (
                first_signature
                if (run_end - run_start) % 2 == 0
                else second_signature
            )
        ):
            run_end += 1
        count = run_end - run_start
        if (
            run_start == 0
            or run_end >= len(repaired)
            or not lines[run_start].blank_before
            or not stable(repaired[run_start - 1], confidence=0.8)
            or not stable(
                repaired[run_end],
                confidence=0.9,
                uncertainty=0.5,
            )
            or sum(
                repaired[index].method in _TEMPLATE_WEAK_METHODS
                or repaired[index].interpolated
                or repaired[index].confidence < 0.5
                for index in range(run_start, run_end)
            )
            < math.ceil(0.5 * count)
        ):
            run_start = run_end
            continue

        expected_following = values[
            run_start + (count % 2)
        ]
        actual_following = values[run_end]
        minimum_prefix = max(
            2,
            math.ceil(0.4 * len(expected_following)),
        )
        if (
            len(actual_following) < minimum_prefix
            or actual_following
            != expected_following[: len(actual_following)]
        ):
            run_start = run_end
            continue

        cadence_samples: list[float] = []
        cadence_pairs = [
            *range(max(1, run_start - 7), run_start),
            *range(run_end + 1, min(len(repaired), run_end + 7)),
        ]
        for index in cadence_pairs:
            left = repaired[index - 1]
            right = repaired[index]
            if not stable(left) or not stable(right):
                continue
            gap = right.start - left.start
            if 1.5 <= gap <= 6.0:
                cadence_samples.append(gap)
        if len(cadence_samples) < 3:
            run_start = run_end
            continue
        base_period = float(median(cadence_samples))
        if not 2.0 <= base_period <= 6.0:
            run_start = run_end
            continue

        previous = repaired[run_start - 1]
        following = repaired[run_end]
        candidates = [
            (
                max(
                    0.0,
                    float(times[index]) - cue_lead_seconds,
                ),
                float(onset_scores[index]),
            )
            for index in onset_indices
            if (
                previous.end + 0.28
                <= times[index] - cue_lead_seconds
                <= following.start + 0.6
            )
        ]
        if (
            len(candidates) < count
            or not any(
                abs(start - following.start) <= 0.5
                for start, _ in candidates
            )
        ):
            run_start = run_end
            continue

        minimum_period = max(1.5, 0.75 * base_period)
        maximum_period = min(6.0, 1.25 * base_period)
        steps = max(
            1,
            math.floor(
                (maximum_period - minimum_period) / 0.01
            )
            + 1,
        )
        best: tuple[float, float, list[float]] | None = None
        for step in range(steps):
            period = minimum_period + 0.01 * step
            proposed: list[float] = []
            score = -3.0 * abs(period - base_period)
            for position in range(count):
                target = (
                    following.start
                    - (count - position) * period
                )
                tolerance = min(
                    0.75,
                    max(0.45, 0.16 * period),
                )
                options = [
                    (
                        candidate_score
                        - 12.0 * abs(candidate_start - target),
                        candidate_start,
                    )
                    for candidate_start, candidate_score in candidates
                    if (
                        abs(candidate_start - target) <= tolerance
                        and (
                            not proposed
                            or candidate_start >= proposed[-1] + 0.5
                        )
                    )
                ]
                if not options:
                    proposed = []
                    break
                local_score, candidate_start = max(options)
                proposed.append(candidate_start)
                score += local_score
            if len(proposed) != count:
                continue
            proposal = (score, period, proposed)
            if best is None or proposal[0] > best[0]:
                best = proposal
        if best is None:
            run_start = run_end
            continue

        _, _, proposed = best
        current_path = [
            repaired[index].start
            for index in range(run_start, run_end)
        ] + [following.start]
        proposed_path = [*proposed, following.start]
        current_error = sum(
            abs((right - left) - base_period)
            for left, right in zip(
                current_path,
                current_path[1:],
            )
        )
        proposed_error = sum(
            abs((right - left) - base_period)
            for left, right in zip(
                proposed_path,
                proposed_path[1:],
            )
        )
        if (
            current_error - proposed_error < 4.0
            or proposed[0] < previous.end + 0.28
            or proposed[-1] > following.start - 0.28
            or max(
                abs(
                    proposed[position]
                    - repaired[run_start + position].start
                )
                for position in range(count)
            )
            > 20.0
        ):
            run_start = run_end
            continue

        for position, start in enumerate(proposed):
            index = run_start + position
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            end = min(
                start + duration,
                (
                    proposed[position + 1]
                    if position + 1 < count
                    else following.start
                ),
            )
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.52,
                interpolated=False,
                method="acoustic_alternating_repeat_cadence",
                start_uncertainty=0.18,
            )
        run_start = run_end
    return repaired


def _repair_duration_stretched_weak_suffix(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Replace duration-stretched outro interpolation with acoustic phrases.

    This path is limited to a blank-delimited final group where most rows are
    still interpolation-derived, the last coarse row lies several seconds
    after the final hard vocal attack, and a long quiet tail follows.  Text
    length supplies only relative spacing; every row is placed on an observed
    soft onset and the weighted cadence must improve decisively.
    """

    repaired = list(anchors)
    if len(repaired) < 6 or not len(onset_indices):
        return repaired

    def weak(anchor: CoarseLineAnchor) -> bool:
        return (
            anchor.method in _TEMPLATE_WEAK_METHODS
            or anchor.interpolated
            or anchor.confidence < 0.45
            or (
                anchor.method
                in {
                    "acoustic_onset",
                    "monotonic_repair",
                    "overlap_repair",
                }
                and anchor.confidence <= 0.45
            )
        )

    suffix_start: int | None = None
    for start in range(
        max(1, len(repaired) - 10),
        len(repaired) - 4,
    ):
        count = len(repaired) - start
        if (
            lines[start].blank_before
            and all(weak(repaired[index]) for index in range(
                start,
                len(repaired),
            ))
        ):
            suffix_start = start
            break
    if suffix_start is None:
        return repaired
    count = len(repaired) - suffix_start
    interpolation_derived = sum(
        repaired[index].interpolated
        or repaired[index].method
        in {
            "interpolated",
            "interpolated_rebased",
            "monotonic_repair",
            "overlap_repair",
        }
        for index in range(suffix_start, len(repaired))
    )
    previous = repaired[suffix_start - 1]
    if (
        interpolation_derived < math.ceil(0.6 * count)
        or previous.interpolated
        or previous.confidence < 0.48
        or previous.start_uncertainty > 0.8
    ):
        return repaired

    lower = max(
        previous.start + 0.28,
        (
            previous.end + 0.05
            if previous.end > previous.start + 0.05
            else previous.start + 0.28
        ),
    )
    hard_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in onset_indices
        if times[index] - cue_lead_seconds >= lower
    ]
    if not hard_candidates:
        return repaired
    final_attack = max(start for start, _ in hard_candidates)
    analysis_end = (
        float(times[-1]) - cue_lead_seconds
        if len(times)
        else final_attack
    )
    if (
        repaired[-1].start - final_attack < 3.0
        or analysis_end - final_attack < 3.0
    ):
        return repaired

    soft_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=3.5,
    )
    soft_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
        if lower <= times[index] - cue_lead_seconds <= final_attack
    ]
    if len(soft_candidates) < count:
        return repaired

    weights = [
        math.sqrt(
            max(
                1,
                len(lexical_values(lines[index].text)),
            )
        )
        for index in range(suffix_start, len(repaired) - 1)
    ]
    total_weight = sum(weights)
    final_score = max(
        score
        for start, score in hard_candidates
        if abs(start - final_attack) < 1e-6
    )
    best: tuple[float, list[float]] | None = None
    for origin, origin_score in hard_candidates:
        if origin >= final_attack - 3.0:
            continue
        scale = (final_attack - origin) / total_weight
        if not 0.7 <= scale <= 2.5:
            continue
        proposed = [origin]
        score = origin_score
        elapsed_weight = 0.0
        for position in range(1, count - 1):
            elapsed_weight += weights[position - 1]
            target = origin + scale * elapsed_weight
            tolerance = max(
                0.55,
                min(
                    1.0,
                    0.25 * scale * weights[position - 1],
                ),
            )
            options = [
                (
                    candidate_score
                    - 10.0 * abs(candidate_start - target),
                    candidate_start,
                )
                for candidate_start, candidate_score in soft_candidates
                if (
                    abs(candidate_start - target) <= tolerance
                    and candidate_start >= proposed[-1] + 0.45
                    and candidate_start < final_attack - 0.45
                )
            ]
            if not options:
                proposed = []
                break
            local_score, candidate_start = max(options)
            proposed.append(candidate_start)
            score += local_score
        if not proposed:
            continue
        proposed.append(final_attack)
        score += final_score
        if len(proposed) != count:
            continue
        proposal = (score, proposed)
        if best is None or proposal[0] > best[0]:
            best = proposal
    if best is None:
        return repaired

    _, proposed = best

    def weighted_error(path: list[float]) -> float:
        gaps = [
            right - left
            for left, right in zip(path, path[1:])
        ]
        scale = float(
            median(
                gap / weight
                for gap, weight in zip(
                    gaps,
                    weights,
                    strict=True,
                )
            )
        )
        return sum(
            abs(gap - scale * weight)
            for gap, weight in zip(
                gaps,
                weights,
                strict=True,
            )
        )

    current = [
        repaired[index].start
        for index in range(suffix_start, len(repaired))
    ]
    if (
        weighted_error(current) - weighted_error(proposed) < 5.0
        or proposed[0] < lower
        or max(
            abs(new - old)
            for new, old in zip(
                proposed,
                current,
                strict=True,
            )
        )
        > 20.0
    ):
        return repaired

    for position, start in enumerate(proposed):
        index = suffix_start + position
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if position + 1 < count:
            end = min(end, proposed[position + 1])
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.48,
            interpolated=False,
            method="acoustic_weighted_trailing_suffix",
            start_uncertainty=0.25,
        )
    return repaired


def _repair_short_interpolated_suffix(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover three or four interpolated outro rows from observed attacks.

    This complements the longer blank-delimited suffix solver.  It only
    handles a maximal all-interpolated tail whose final row was stretched to
    the analysis duration even though the last plausible vocal attack is
    followed by at least three seconds of quiet audio.  Text length controls
    relative spacing, but every output row must land on a measured onset.
    """

    repaired = list(anchors)
    if len(repaired) < 4 or not len(onset_indices) or not len(times):
        return repaired
    interpolation_methods = {
        "interpolated",
        "interpolated_rebased",
        "monotonic_repair",
        "overlap_repair",
    }
    suffix_start = len(repaired)
    while suffix_start:
        anchor = repaired[suffix_start - 1]
        if (
            not anchor.interpolated
            and anchor.method not in interpolation_methods
        ):
            break
        suffix_start -= 1
    count = len(repaired) - suffix_start
    if count not in {3, 4} or suffix_start == 0:
        return repaired

    previous = repaired[suffix_start - 1]
    if (
        previous.interpolated
        or previous.confidence < 0.4
        or previous.start_uncertainty > 0.8
    ):
        return repaired
    analysis_end = float(times[-1]) - cue_lead_seconds
    if repaired[-1].start < analysis_end - 0.6:
        return repaired

    lower = max(
        previous.start + 0.5,
        (
            previous.end + 0.05
            if previous.end > previous.start + 0.05
            else previous.start + 0.5
        ),
    )
    hard_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in onset_indices
        if lower <= times[index] - cue_lead_seconds
    ]
    soft_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=3.5,
    )
    soft_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
        if lower <= times[index] - cue_lead_seconds
    ]
    if not hard_candidates or len(soft_candidates) < count:
        return repaired

    weights = [
        math.sqrt(
            max(
                1,
                len(lexical_values(lines[index].text)),
            )
        )
        for index in range(suffix_start, len(repaired) - 1)
    ]
    total_weight = sum(weights)
    current = [
        repaired[index].start
        for index in range(suffix_start, len(repaired))
    ]
    final_candidates = [
        (start, score)
        for start, score in soft_candidates
        if (
            score >= 5.0
            and analysis_end - start >= 3.0
            and current[-1] - start >= 3.0
        )
    ]
    best: tuple[float, float, list[float]] | None = None
    for origin, origin_score in hard_candidates:
        if origin > analysis_end - 5.0:
            continue
        for final, final_score in final_candidates:
            if final - origin < 2.0:
                continue
            scale = (final - origin) / total_weight
            if not 0.6 <= scale <= 2.5:
                continue
            proposed = [origin]
            score = origin_score + final_score
            elapsed_weight = 0.0
            for position in range(1, count - 1):
                elapsed_weight += weights[position - 1]
                target = origin + scale * elapsed_weight
                tolerance = max(
                    0.5,
                    min(
                        0.9,
                        0.25 * scale * weights[position - 1],
                    ),
                )
                options = [
                    (
                        candidate_score
                        - 12.0 * abs(candidate_start - target),
                        candidate_start,
                    )
                    for candidate_start, candidate_score in soft_candidates
                    if (
                        abs(candidate_start - target) <= tolerance
                        and candidate_start >= proposed[-1] + 0.45
                        and candidate_start <= final - 0.45
                    )
                ]
                if not options:
                    proposed = []
                    break
                local_score, candidate_start = max(options)
                score += local_score
                proposed.append(candidate_start)
            if not proposed:
                continue
            proposed.append(final)
            if len(proposed) != count:
                continue
            gaps = [
                right - left
                for left, right in zip(
                    proposed,
                    proposed[1:],
                )
            ]
            normalized = [
                gap / weight
                for gap, weight in zip(
                    gaps,
                    weights,
                    strict=True,
                )
            ]
            fitted_scale = float(median(normalized))
            residual = sum(
                abs(gap - fitted_scale * weight)
                for gap, weight in zip(
                    gaps,
                    weights,
                    strict=True,
                )
            )
            candidate = (
                score - 15.0 * residual,
                residual,
                proposed,
            )
            if best is None or candidate[0] > best[0]:
                best = candidate
    if best is None:
        return repaired

    _, residual, proposed = best
    if (
        residual > 1.0
        or current[0] - proposed[0] < 1.5
        or max(
            abs(new - old)
            for new, old in zip(
                proposed,
                current,
                strict=True,
            )
        )
        > 12.0
    ):
        return repaired

    for position, start in enumerate(proposed):
        index = suffix_start + position
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if position + 1 < count:
            end = min(end, proposed[position + 1])
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.48,
            interpolated=False,
            method="acoustic_short_trailing_suffix",
            start_uncertainty=0.25,
        )
    return repaired


def _repair_repeated_section_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Rebuild a weak repeated section from a reliable earlier performance.

    Both occurrences must occupy identical blank-delimited sections.  The
    source needs reliable lexical or acoustic anchors, while at least three
    quarters of the target must remain structurally weak.  Every target row
    is then required to expose a hard onset near the source section's
    relative cadence; the update is atomic when any row lacks proof.
    """

    repaired = list(anchors)
    if len(repaired) < 10 or not len(onset_indices):
        return repaired

    def source_reliable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.6
            and anchor.start_uncertainty <= 0.8
            and (
                anchor.method.startswith("lexical")
                or anchor.method == "acoustic_onset"
            )
        )

    def boundary_reliable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.6
            and anchor.start_uncertainty <= 0.8
        )

    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    section_starts = [0] + [
        index
        for index in range(1, len(lines))
        if lines[index].blank_before
    ]
    sections = [
        (
            start,
            (
                section_starts[position + 1]
                if position + 1 < len(section_starts)
                else len(lines)
            ),
        )
        for position, start in enumerate(section_starts)
    ]
    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    claimed_targets: set[int] = set()
    for source_position, (source_start, source_end) in enumerate(
        sections
    ):
        count = source_end - source_start
        if (
            not 4 <= count <= 10
            or not all(
                source_reliable(repaired[index])
                for index in range(source_start, source_end)
            )
        ):
            continue
        pattern = tuple(signatures[source_start:source_end])
        relative = [
            repaired[source_start + position].start
            - repaired[source_start].start
            for position in range(count)
        ]
        for target_start, target_end in sections[
            source_position + 1 :
        ]:
            if (
                target_start in claimed_targets
                or target_end - target_start != count
                or target_start == 0
                or target_end >= len(repaired)
                or tuple(signatures[target_start:target_end])
                != pattern
                or not boundary_reliable(repaired[target_start - 1])
                or not boundary_reliable(repaired[target_end])
            ):
                continue
            weak_count = sum(
                repaired[index].interpolated
                or repaired[index].method in _TEMPLATE_WEAK_METHODS
                or repaired[index].confidence < 0.5
                for index in range(target_start, target_end)
            )
            if weak_count < math.ceil(0.75 * count):
                continue
            current = [
                repaired[index].start
                for index in range(target_start, target_end)
            ]
            current_error = sum(
                abs(
                    (current[position] - current[0])
                    - relative[position]
                )
                for position in range(1, count)
            )
            if current_error < 4.0:
                continue

            lower = repaired[target_start - 1].end + 0.28
            upper = repaired[target_end].start - 0.28
            best: tuple[float, float, list[float]] | None = None
            for origin, origin_score in acoustic_candidates:
                if not lower <= origin <= upper:
                    continue
                proposed = [origin]
                score = origin_score
                for position in range(1, count):
                    expected = origin + relative[position]
                    options = [
                        (
                            candidate_score
                            - 10.0
                            * abs(candidate_start - expected),
                            candidate_start,
                        )
                        for (
                            candidate_start,
                            candidate_score,
                        ) in acoustic_candidates
                        if (
                            abs(candidate_start - expected) <= 0.8
                            and candidate_start
                            >= proposed[-1] + 0.28
                            and candidate_start <= upper
                        )
                    ]
                    if not options:
                        proposed = []
                        break
                    local_score, candidate_start = max(options)
                    score += local_score
                    proposed.append(candidate_start)
                if len(proposed) != count:
                    continue
                proposed_error = sum(
                    abs(
                        (proposed[position] - proposed[0])
                        - relative[position]
                    )
                    for position in range(1, count)
                )
                candidate = (
                    score - 10.0 * proposed_error,
                    proposed_error,
                    proposed,
                )
                if best is None or candidate[0] > best[0]:
                    best = candidate
            if best is None:
                continue

            _, proposed_error, proposed = best
            if (
                current_error - proposed_error < 4.0
                or max(
                    abs(new - old)
                    for new, old in zip(
                        proposed,
                        current,
                        strict=True,
                    )
                )
                > 12.0
            ):
                continue

            for position, start in enumerate(proposed):
                index = target_start + position
                anchor = repaired[index]
                duration = max(0.0, anchor.end - anchor.start)
                end = start + duration
                if position + 1 < count:
                    end = min(end, proposed[position + 1])
                else:
                    end = min(end, repaired[target_end].start)
                repaired[index] = replace(
                    anchor,
                    start=start,
                    end=max(start, end),
                    confidence=0.52,
                    interpolated=False,
                    method="acoustic_repeated_section_cadence",
                    start_uncertainty=0.25,
                )
            claimed_targets.add(target_start)
    return repaired


def _repair_repeated_chant_suffix(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Transfer a three-row chant cadence between repeated sections.

    The two blank-delimited sections may differ in their first line, but all
    remaining text must match.  At least three shared prefix rows establish a
    stable occurrence offset.  The final three rows must contain only the same
    repeated lexical value, and both performances must expose corresponding
    acoustic attacks.  This prevents high-confidence ASR chant tokens from
    collapsing onto an earlier sustained syllable.
    """

    repaired = list(anchors)
    if len(repaired) < 12 or not len(onset_indices):
        return repaired

    def prefix_reliable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.65
            and anchor.start_uncertainty <= 1.1
            and (
                anchor.method.startswith("lexical")
                or anchor.method == "acoustic_onset"
            )
        )

    lexical_rows = [
        primary_lexical_values(line.text)
        for line in lines
    ]
    signatures = [
        " ".join(values)
        for values in lexical_rows
    ]
    section_starts = [0] + [
        index
        for index in range(1, len(lines))
        if lines[index].blank_before
    ]
    sections = [
        (
            start,
            (
                section_starts[position + 1]
                if position + 1 < len(section_starts)
                else len(lines)
            ),
        )
        for position, start in enumerate(section_starts)
    ]
    soft_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=3.5,
    )
    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in soft_indices
        if onset_scores[index] >= 7.0
    ]
    claimed_targets: set[int] = set()
    for source_position, (source_start, source_end) in enumerate(
        sections
    ):
        count = source_end - source_start
        if not 6 <= count <= 12:
            continue
        prefix_count = count - 3
        source_tail = lexical_rows[source_end - 3 : source_end]
        tail_values = set().union(
            *(set(values) for values in source_tail)
        )
        if (
            len(tail_values) != 1
            or any(
                not values
                or set(values) != tail_values
                or len(values) > 4
                for values in source_tail
            )
        ):
            continue

        for target_start, target_end in sections[
            source_position + 1 :
        ]:
            if (
                target_start in claimed_targets
                or target_end - target_start != count
                or tuple(signatures[source_start + 1 : source_end])
                != tuple(signatures[target_start + 1 : target_end])
            ):
                continue
            matched_prefix = range(1, prefix_count)
            if (
                len(matched_prefix) < 3
                or not all(
                    prefix_reliable(repaired[source_start + position])
                    and prefix_reliable(
                        repaired[target_start + position]
                    )
                    for position in matched_prefix
                )
                or not all(
                    not repaired[index].interpolated
                    and repaired[index].confidence >= 0.7
                    for index in range(
                        source_start + prefix_count,
                        source_end,
                    )
                )
                or not all(
                    not repaired[index].interpolated
                    and repaired[index].confidence >= 0.7
                    for index in range(
                        target_start + prefix_count,
                        target_end,
                    )
                )
            ):
                continue
            offsets = [
                repaired[target_start + position].start
                - repaired[source_start + position].start
                for position in matched_prefix
            ]
            occurrence_offset = float(median(offsets))
            offset_mad = float(
                median(
                    abs(offset - occurrence_offset)
                    for offset in offsets
                )
            )
            if (
                offset_mad > 0.45
                or max(offsets) - min(offsets) > 1.5
            ):
                continue

            source_options: list[list[tuple[float, float]]] = []
            for index in range(
                source_start + prefix_count,
                source_end,
            ):
                options = [
                    (start, score)
                    for start, score in acoustic_candidates
                    if abs(start - repaired[index].start) <= 1.2
                ]
                options = sorted(
                    options,
                    key=lambda item: (
                        item[1]
                        - 4.0
                        * abs(item[0] - repaired[index].start)
                    ),
                    reverse=True,
                )[:8]
                if not options:
                    source_options = []
                    break
                source_options.append(options)
            if not source_options:
                continue

            best: tuple[float, list[float]] | None = None
            for source_path_items in product(*source_options):
                source_path = [
                    item[0]
                    for item in source_path_items
                ]
                if any(
                    right < left + 0.4
                    for left, right in zip(
                        source_path,
                        source_path[1:],
                    )
                ):
                    continue
                proposed: list[float] = []
                score = 0.0
                for position, (
                    source_start_time,
                    source_score,
                ) in enumerate(source_path_items):
                    expected = (
                        source_start_time + occurrence_offset
                    )
                    options = [
                        (
                            candidate_score
                            - 10.0
                            * abs(candidate_start - expected),
                            candidate_start,
                        )
                        for (
                            candidate_start,
                            candidate_score,
                        ) in acoustic_candidates
                        if (
                            abs(candidate_start - expected) <= 0.65
                            and (
                                not proposed
                                or candidate_start
                                >= proposed[-1] + 0.4
                            )
                        )
                    ]
                    if not options:
                        proposed = []
                        break
                    local_score, candidate_start = max(options)
                    source_index = (
                        source_start + prefix_count + position
                    )
                    score += (
                        source_score
                        + local_score
                        - 4.0
                        * abs(
                            source_start_time
                            - repaired[source_index].start
                        )
                    )
                    proposed.append(candidate_start)
                if len(proposed) != 3:
                    continue
                candidate = (score, proposed)
                if best is None or candidate[0] > best[0]:
                    best = candidate
            if best is None:
                continue

            _, proposed = best
            target_indices = range(
                target_start + prefix_count,
                target_end,
            )
            current = [
                repaired[index].start
                for index in target_indices
            ]
            if (
                sum(
                    abs(old - new) >= 2.0
                    for old, new in zip(
                        current,
                        proposed,
                        strict=True,
                    )
                )
                < 2
                or sum(
                    abs(old - new)
                    for old, new in zip(
                        current,
                        proposed,
                        strict=True,
                    )
                )
                < 5.0
                or proposed[0]
                < repaired[target_start + prefix_count - 1].start
                + 0.4
                or (
                    target_end < len(repaired)
                    and proposed[-1]
                    > repaired[target_end].start - 0.28
                )
            ):
                continue

            for position, start in enumerate(proposed):
                index = target_start + prefix_count + position
                anchor = repaired[index]
                duration = max(0.0, anchor.end - anchor.start)
                end = start + duration
                if position + 1 < len(proposed):
                    end = min(end, proposed[position + 1])
                elif target_end < len(repaired):
                    end = min(end, repaired[target_end].start)
                repaired[index] = replace(
                    anchor,
                    start=start,
                    end=max(start, end),
                    confidence=0.52,
                    interpolated=False,
                    method="acoustic_repeated_chant_suffix",
                    start_uncertainty=0.25,
                )
            claimed_targets.add(target_start)
    return repaired


def _repair_repeated_trailing_acoustic_motif(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Locate two identical final rows from their repeated onset motif.

    At least three hard attacks within the first performance must recur at the
    same lag in the second.  The selected origin must be the earliest paired
    attack in that motif, preventing an internal syllable or digit from being
    mistaken for the line entrance.
    """

    repaired = list(anchors)
    if len(repaired) < 3 or not len(onset_indices):
        return repaired
    first_values = primary_lexical_values(lines[-2].text)
    second_values = primary_lexical_values(lines[-1].text)
    if (
        len(first_values) < 2
        or first_values != second_values
        or not all(
            anchor.confidence <= 0.5
            or anchor.method.startswith("acoustic_")
            for anchor in repaired[-2:]
        )
    ):
        return repaired

    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[index]) - cue_lead_seconds,
            ),
            float(onset_scores[index]),
        )
        for index in onset_indices
        if onset_scores[index] >= 8.0
    ]
    current = [repaired[-2].start, repaired[-1].start]
    best: tuple[
        float,
        float,
        float,
        float,
        int,
    ] | None = None
    for first_position, (
        first,
        first_score,
    ) in enumerate(acoustic_candidates):
        if (
            first < current[0] + 2.0
            or first < repaired[-3].start + 0.28
        ):
            continue
        for second, second_score in acoustic_candidates[
            first_position + 1 :
        ]:
            lag = second - first
            if lag < 2.0:
                continue
            if lag > 6.0:
                break
            if second < current[1] + 2.0:
                continue

            paired_count = 0
            for attack, _ in acoustic_candidates:
                if not (
                    first - 0.05
                    <= attack
                    <= first + min(3.5, lag - 0.3)
                ):
                    continue
                if any(
                    abs(counterpart - (attack + lag)) <= 0.18
                    for counterpart, _ in acoustic_candidates
                ):
                    paired_count += 1
            if paired_count < 3:
                continue
            if any(
                first - 1.2 <= earlier <= first - 0.2
                and any(
                    abs(counterpart - (earlier + lag)) <= 0.18
                    for counterpart, _ in acoustic_candidates
                )
                for earlier, _ in acoustic_candidates
            ):
                continue
            score = (
                20.0 * paired_count
                + first_score
                + second_score
                - 2.0
                * (
                    first
                    - current[0]
                    + second
                    - current[1]
                )
            )
            candidate = (
                score,
                -first,
                first,
                second,
                paired_count,
            )
            if best is None or candidate[0] > best[0]:
                best = candidate
    if best is None:
        return repaired

    _, _, first, second, _ = best
    proposed = [first, second]
    if max(
        new - old
        for new, old in zip(
            proposed,
            current,
            strict=True,
        )
    ) > 10.0:
        return repaired
    for position, start in enumerate(proposed):
        index = len(repaired) - 2 + position
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if position == 0:
            end = min(end, second)
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.52,
            interpolated=False,
            method="acoustic_repeated_trailing_motif",
            start_uncertainty=0.18,
        )
    return repaired


def _repair_exact_repeated_section_outliers(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Repair one displaced row inside an exact repeated section.

    One performance supplies the candidate row while at least three other
    corresponding rows establish the occurrence offset.  The target row may
    move only when those offsets agree tightly and a hard attack independently
    confirms the transferred position.  This handles a single phrase that was
    matched to an internal backing vocal without copying an entire chorus or
    assuming identical rubato.
    """

    repaired = list(anchors)
    if len(repaired) < 8 or not len(onset_indices):
        return repaired

    def reliable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.4
            and anchor.start_uncertainty <= 0.9
        )

    def source_reliable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.5
            and anchor.start_uncertainty <= 0.8
            and (
                anchor.method.startswith("lexical")
                or anchor.method == "acoustic_onset"
            )
        )

    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    section_starts = [0] + [
        index
        for index in range(1, len(lines))
        if lines[index].blank_before
    ]
    sections = [
        (
            start,
            (
                section_starts[position + 1]
                if position + 1 < len(section_starts)
                else len(lines)
            ),
        )
        for position, start in enumerate(section_starts)
    ]
    grouped: dict[tuple[str, ...], list[tuple[int, int]]] = {}
    for start, end in sections:
        if (
            4 <= end - start <= 8
            and all(signatures[start:end])
        ):
            grouped.setdefault(
                tuple(signatures[start:end]),
                [],
            ).append((start, end))

    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    proposals: dict[int, tuple[float, float]] = {}
    for occurrences in grouped.values():
        if len(occurrences) < 2:
            continue
        count = occurrences[0][1] - occurrences[0][0]
        for source_start, _ in occurrences:
            for target_start, _ in occurrences:
                if source_start == target_start:
                    continue
                for position in range(count):
                    source_index = source_start + position
                    target_index = target_start + position
                    source = repaired[source_index]
                    target = repaired[target_index]
                    if (
                        not source_reliable(source)
                        or not (
                            target.confidence <= 0.7
                            or target.start_uncertainty >= 0.9
                            or target.method
                            in {
                                "acoustic_onset",
                                "acoustic_repeat_transfer",
                            }
                        )
                    ):
                        continue

                    offsets = [
                        repaired[target_start + other].start
                        - repaired[source_start + other].start
                        for other in range(count)
                        if (
                            other != position
                            and reliable(
                                repaired[source_start + other]
                            )
                            and reliable(
                                repaired[target_start + other]
                            )
                        )
                    ]
                    if len(offsets) < 3:
                        continue
                    offset = float(median(offsets))
                    inliers = [
                        value
                        for value in offsets
                        if abs(value - offset) <= 0.65
                    ]
                    if (
                        len(inliers) < 3
                        or max(inliers) - min(inliers) > 0.8
                    ):
                        continue
                    offset = float(median(inliers))
                    expected = source.start + offset
                    shift = expected - target.start
                    if not 2.5 <= abs(shift) <= 8.0:
                        continue

                    lower = (
                        repaired[target_index - 1].start + 0.28
                        if target_index
                        else 0.0
                    )
                    upper = (
                        repaired[target_index + 1].start - 0.28
                        if target_index + 1 < len(repaired)
                        else math.inf
                    )
                    options = [
                        (
                            score
                            - 10.0 * abs(start - expected),
                            start,
                        )
                        for start, score in acoustic_candidates
                        if (
                            abs(start - expected) <= 0.8
                            and lower <= start <= upper
                        )
                    ]
                    if not options:
                        continue
                    local_score, proposed = max(options)
                    current_deviation = abs(
                        (target.start - source.start) - offset
                    )
                    proposed_deviation = abs(
                        (proposed - source.start) - offset
                    )
                    if (
                        current_deviation - proposed_deviation < 2.0
                        or abs(proposed - target.start) < 2.5
                    ):
                        continue
                    evidence_score = (
                        10.0 * len(inliers)
                        - 8.0 * (max(inliers) - min(inliers))
                        + local_score
                    )
                    existing = proposals.get(target_index)
                    if (
                        existing is None
                        or evidence_score > existing[0]
                    ):
                        proposals[target_index] = (
                            evidence_score,
                            proposed,
                        )

    for index in sorted(proposals):
        _, start = proposals[index]
        previous = repaired[index - 1].start + 0.28 if index else 0.0
        following = (
            repaired[index + 1].start - 0.28
            if index + 1 < len(repaired)
            else math.inf
        )
        if not previous <= start <= following:
            continue
        anchor = repaired[index]
        duration = max(0.0, anchor.end - anchor.start)
        end = start + duration
        if index + 1 < len(repaired):
            end = min(end, repaired[index + 1].start)
        repaired[index] = replace(
            anchor,
            start=start,
            end=max(start, end),
            confidence=0.52,
            interpolated=False,
            method="acoustic_exact_repeat_outlier",
            start_uncertainty=0.2,
        )
    return repaired


def _repair_repeated_internal_refrain_onsets(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Choose the first attack of a repeated two-part refrain line.

    Some short refrain lines repeat their key word twice several seconds
    apart.  A generic acoustic pass can bind different performances to either
    the first or second half.  Four exact lyric occurrences, two currently on
    each half, and a stable attack-pair period are required before later-half
    anchors are normalized to the first attack.
    """

    repaired = list(anchors)
    if len(repaired) < 12 or not len(onset_indices):
        return repaired
    signatures = [
        " ".join(primary_lexical_values(line.text))
        for line in lines
    ]
    occurrences: dict[str, list[int]] = {}
    for index, signature in enumerate(signatures):
        if signature:
            occurrences.setdefault(signature, []).append(index)
    hard = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    analysis_end = (
        max(0.0, float(times[-1]) - cue_lead_seconds)
        if len(times)
        else math.inf
    )

    for indices in occurrences.values():
        if len(indices) < 4:
            continue
        values = primary_lexical_values(lines[indices[0]].text)
        if (
            not 3 <= len(values) <= 6
            or len(set(values)) < 2
            or values.count(values[-1]) < 2
        ):
            continue

        per_occurrence: list[
            tuple[int, float, list[tuple[float, float, float, float]]]
        ] = []
        for index in indices:
            anchor = repaired[index]
            nearest = [
                (
                    abs(start - anchor.start),
                    start,
                    score,
                )
                for start, score in hard
                if abs(start - anchor.start) <= 0.45
            ]
            if not nearest:
                continue
            _, current_attack, current_score = min(nearest)
            lower = (
                repaired[index - 1].start + 0.28
                if index
                else 0.0
            )
            upper = (
                repaired[index + 1].start - 0.28
                if index + 1 < len(repaired)
                else analysis_end
            )
            partners = [
                (
                    min(current_attack, other),
                    max(current_attack, other),
                    abs(other - current_attack),
                    current_score + score,
                )
                for other, score in hard
                if (
                    3.5 <= abs(other - current_attack) <= 5.5
                    and lower
                    <= min(current_attack, other)
                    < max(current_attack, other)
                    <= upper
                )
            ]
            if partners:
                per_occurrence.append(
                    (index, current_attack, partners)
                )
        if len(per_occurrence) < 4:
            continue

        best: tuple[
            tuple[int, float, float],
            list[
                tuple[
                    int,
                    float,
                    tuple[float, float, float, float],
                ]
            ],
        ] | None = None
        period_centers = [
            option[2]
            for _, _, options in per_occurrence
            for option in options
        ]
        for center in period_centers:
            selected: list[
                tuple[
                    int,
                    float,
                    tuple[float, float, float, float],
                ]
            ] = []
            for index, current_attack, options in per_occurrence:
                compatible = [
                    option
                    for option in options
                    if abs(option[2] - center) <= 0.3
                ]
                if compatible:
                    selected.append(
                        (
                            index,
                            current_attack,
                            max(
                                compatible,
                                key=lambda option: option[3],
                            ),
                        )
                    )
            if len(selected) < 4:
                continue
            periods = [item[2][2] for item in selected]
            if max(periods) - min(periods) > 0.4:
                continue
            earlier = sum(
                abs(current - option[0]) <= 0.55
                for _, current, option in selected
            )
            later = sum(
                abs(current - option[1]) <= 0.55
                for _, current, option in selected
            )
            if earlier < 2 or later < 2:
                continue
            rank = (
                len(selected),
                -(max(periods) - min(periods)),
                sum(item[2][3] for item in selected),
            )
            if best is None or rank > best[0]:
                best = (rank, selected)
        if best is None:
            continue

        for index, current_attack, option in best[1]:
            early, late, _, _ = option
            if (
                abs(current_attack - late) > 0.55
                or repaired[index].method != "acoustic_onset"
                or repaired[index].confidence < 0.45
            ):
                continue
            previous = (
                repaired[index - 1].start + 0.28
                if index
                else 0.0
            )
            following = (
                repaired[index + 1].start - 0.28
                if index + 1 < len(repaired)
                else analysis_end
            )
            if (
                not previous <= early <= following
                or not 3.5 <= repaired[index].start - early <= 5.5
            ):
                continue
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            repaired[index] = replace(
                anchor,
                start=early,
                end=max(
                    early,
                    min(early + duration, following + 0.28),
                ),
                confidence=0.55,
                interpolated=False,
                method="acoustic_repeated_internal_refrain",
                start_uncertainty=0.18,
            )
    return repaired


def _repair_repeated_prefix_cadence_tails(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Extend two identical rows into a repeated short-prefix response.

    The target response may add an interjection and then repeat only the
    opening words of the preceding line.  Two independent occurrences must
    show the same compressed failure and preceding period before a soft attack
    near the extrapolated cadence can replace the internal lexical match.
    """

    repaired = list(anchors)
    if len(repaired) < 8:
        return repaired
    values = [
        primary_lexical_values(line.text)
        for line in lines
    ]
    signatures = [" ".join(item) for item in values]
    grouped: dict[
        str,
        list[tuple[int, float]],
    ] = {}
    for index in range(2, len(repaired)):
        repeated_signature = signatures[index - 1]
        if (
            not repeated_signature
            or signatures[index - 2] != repeated_signature
            or signatures[index] == repeated_signature
        ):
            continue
        prefix_length = max(
            (
                len(values[index]) - skipped
                for skipped in (0, 1, 2)
                if (
                    len(values[index]) - skipped >= 4
                    and values[index][skipped:]
                    == values[index - 1][
                        : len(values[index]) - skipped
                    ]
                )
            ),
            default=0,
        )
        if prefix_length < 4:
            continue
        first = repaired[index - 2]
        second = repaired[index - 1]
        target = repaired[index]
        period = second.start - first.start
        gap = target.start - second.start
        if (
            first.interpolated
            or second.interpolated
            or first.confidence < 0.55
            or second.confidence < 0.55
            or first.start_uncertainty > 0.8
            or second.start_uncertainty > 0.8
            or target.interpolated
            or target.method != "lexical"
            or target.confidence < 0.8
            or target.start_uncertainty > 0.8
            or not 2.0 <= period <= 8.0
            or gap >= 0.55 * period
        ):
            continue
        grouped.setdefault(
            repeated_signature,
            [],
        ).append((index, period))

    soft_indices = _soft_onset_indices(
        onset_scores,
        minimum_score=5.5,
    )
    soft_candidates = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in soft_indices
    ]
    for triples in grouped.values():
        if len(triples) < 2:
            continue
        periods = [period for _, period in triples]
        if max(periods) - min(periods) > 0.4:
            continue
        period = sum(periods) / len(periods)
        proposals: list[tuple[int, float]] = []
        for index, _ in triples:
            expected = repaired[index - 1].start + period
            previous = repaired[index - 1].start + 0.28
            following = (
                repaired[index + 1].start - 0.28
                if index + 1 < len(repaired)
                else math.inf
            )
            options = [
                (
                    score - 8.0 * abs(start - expected),
                    start,
                )
                for start, score in soft_candidates
                if (
                    abs(start - expected) <= 0.8
                    and previous <= start <= following
                )
            ]
            if not options:
                proposals = []
                break
            _, proposed = max(options)
            current_gap = (
                repaired[index].start
                - repaired[index - 1].start
            )
            proposed_gap = (
                proposed - repaired[index - 1].start
            )
            if (
                proposed - repaired[index].start < 2.0
                or proposed - repaired[index].start > 6.0
                or abs(current_gap - period)
                - abs(proposed_gap - period)
                < 2.0
            ):
                proposals = []
                break
            proposals.append((index, proposed))
        if len(proposals) != len(triples):
            continue

        for index, start in proposals:
            anchor = repaired[index]
            duration = max(0.0, anchor.end - anchor.start)
            end = start + duration
            if index + 1 < len(repaired):
                end = min(end, repaired[index + 1].start)
            repaired[index] = replace(
                anchor,
                start=start,
                end=max(start, end),
                confidence=0.5,
                interpolated=False,
                method="acoustic_repeated_prefix_cadence_tail",
                start_uncertainty=0.25,
            )
    return repaired


def _repair_dense_shared_prefix_chants(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Rebuild a compressed dense chant between fixed endpoint rows.

    Seven to twelve consecutive variants must share their first two lexical
    units.  The first and last rows remain fixed; their span supplies only a
    rough cadence.  Every interior row must have a hard attack near that grid,
    and the complete path must improve substantially before any row moves.
    """

    repaired = list(anchors)
    if len(repaired) < 9 or not len(onset_indices):
        return repaired
    values = [
        primary_lexical_values(line.text)
        for line in lines
    ]
    hard = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    endpoint_candidates = [
        max(
            0.0,
            float(times[candidate]) - cue_lead_seconds,
        )
        for candidate in _soft_onset_indices(
            onset_scores,
            minimum_score=5.5,
        )
    ]
    index = 0
    while index < len(repaired):
        if len(values[index]) < 2:
            index += 1
            continue
        key = tuple(values[index][:2])
        end = index + 1
        while (
            end < len(repaired)
            and len(values[end]) >= 2
            and tuple(values[end][:2]) == key
        ):
            end += 1
        count = end - index
        if (
            not 7 <= count <= 12
            or len(
                {
                    " ".join(values[position])
                    for position in range(index, end)
                }
            )
            < 2
            or index == 0
            or end >= len(repaired)
        ):
            index = max(end, index + 1)
            continue

        previous = repaired[index - 1]
        following = repaired[end]
        first = repaired[index]
        final = repaired[end - 1]
        period = (final.start - first.start) / (count - 1)
        if (
            previous.interpolated
            or previous.confidence < 0.6
            or following.interpolated
            or following.confidence < 0.6
            or first.interpolated
            or first.confidence < 0.6
            or not 0.8 <= period <= 3.0
            or first.start < previous.start + 0.28
            or final.start > following.start - 0.28
            or not any(
                abs(start - first.start) <= 0.5
                for start in endpoint_candidates
            )
            or not any(
                abs(start - final.start) <= 0.5
                for start in endpoint_candidates
            )
        ):
            index = end
            continue

        proposed = [first.start]
        for position in range(1, count - 1):
            expected = first.start + period * position
            options = [
                (
                    score - 10.0 * abs(start - expected),
                    start,
                )
                for start, score in hard
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
        if not proposed:
            index = end
            continue
        proposed.append(final.start)
        current = [
            repaired[position].start
            for position in range(index, end)
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
            current_error - proposed_error < 5.0
            or sum(shift >= 1.5 for shift in shifts) < 2
            or sum(shifts) < 5.0
        ):
            index = end
            continue

        for position in range(1, count - 1):
            start = proposed[position]
            target_index = index + position
            anchor = repaired[target_index]
            if abs(start - anchor.start) < 0.08:
                continue
            duration = max(0.0, anchor.end - anchor.start)
            repaired[target_index] = replace(
                anchor,
                start=start,
                end=max(
                    start,
                    min(
                        start + duration,
                        proposed[position + 1],
                    ),
                ),
                confidence=0.52,
                interpolated=False,
                method="acoustic_dense_shared_prefix_chant",
                start_uncertainty=0.18,
            )
        index = end
    return repaired


def _repair_variant_alternating_cadence(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Repair an alternating section whose response rows contain variants.

    One parity must repeat exactly while the other shares a two-unit lexical
    prefix.  Same-parity intervals establish a robust half-period; every row
    then needs a hard attack within 350 ms of that cadence.  This preserves
    parenthetical ad-libs while preventing one variant from skipping a cycle.
    """

    repaired = list(anchors)
    if len(repaired) < 8 or not len(onset_indices):
        return repaired
    values = [
        primary_lexical_values(line.text)
        for line in lines
    ]
    signatures = [" ".join(item) for item in values]
    candidates: dict[
        tuple[int, int],
        tuple[int, int, int, float],
    ] = {}
    starts = [
        index
        for index in range(len(lines))
        if index == 0 or lines[index].blank_before
    ]
    for start in starts:
        for end in range(
            start + 6,
            min(len(repaired), start + 12) + 1,
        ):
            for parity in (0, 1):
                exact = [
                    signatures[index]
                    for index in range(start + parity, end, 2)
                ]
                variants = [
                    values[index]
                    for index in range(
                        start + 1 - parity,
                        end,
                        2,
                    )
                ]
                if (
                    len(exact) < 3
                    or len(variants) < 3
                    or not exact[0]
                    or len(set(exact)) != 1
                    or any(len(item) < 2 for item in variants)
                    or len(
                        {
                            tuple(item[:2])
                            for item in variants
                        }
                    )
                    != 1
                ):
                    continue
                gaps = [
                    (
                        repaired[index + 2].start
                        - repaired[index].start
                    )
                    / 2.0
                    for index in range(
                        start + parity,
                        end - 2,
                        2,
                    )
                ]
                center = float(median(gaps))
                inliers = [
                    gap
                    for gap in gaps
                    if abs(gap - center) <= 0.35
                ]
                if (
                    len(inliers) < 2
                    or max(inliers) - min(inliers) > 0.3
                    or not 2.0 <= center <= 6.0
                ):
                    continue
                proposal = (
                    start,
                    end,
                    parity,
                    float(median(inliers)),
                )
                key = (start, parity)
                current = candidates.get(key)
                if current is None or end > current[1]:
                    candidates[key] = proposal

    hard = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    claimed: set[int] = set()
    for start, end, _, period in sorted(
        candidates.values(),
        key=lambda item: (item[0], -item[1]),
    ):
        if (
            end >= len(repaired)
            or any(index in claimed for index in range(start, end))
        ):
            continue
        origin = repaired[start]
        following = repaired[end]
        if (
            origin.interpolated
            or origin.confidence < 0.5
            or not any(
                abs(candidate - origin.start) <= 0.35
                for candidate, _ in hard
            )
        ):
            continue
        proposed = [origin.start]
        for position in range(1, end - start):
            expected = origin.start + period * position
            options = [
                (
                    score - 10.0 * abs(candidate - expected),
                    candidate,
                )
                for candidate, score in hard
                if (
                    abs(candidate - expected) <= 0.35
                    and candidate >= proposed[-1] + 0.28
                    and candidate <= following.start - 0.28
                )
            ]
            if not options:
                proposed = []
                break
            _, candidate = max(options)
            proposed.append(candidate)
        if not proposed:
            continue
        current = [
            repaired[index].start
            for index in range(start, end)
        ]
        current_error = sum(
            abs(
                (current[position] - origin.start)
                - period * position
            )
            for position in range(1, len(current))
        )
        proposed_error = sum(
            abs(
                (proposed[position] - origin.start)
                - period * position
            )
            for position in range(1, len(proposed))
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
            current_error - proposed_error < 4.0
            or sum(shift >= 1.0 for shift in shifts) < 2
            or sum(shifts) < 5.0
        ):
            continue

        for position, candidate in enumerate(proposed):
            index = start + position
            anchor = repaired[index]
            if abs(candidate - anchor.start) < 0.08:
                continue
            duration = max(0.0, anchor.end - anchor.start)
            end_time = candidate + duration
            if position + 1 < len(proposed):
                end_time = min(
                    end_time,
                    proposed[position + 1],
                )
            else:
                end_time = min(end_time, following.start)
            repaired[index] = replace(
                anchor,
                start=candidate,
                end=max(candidate, end_time),
                confidence=0.52,
                interpolated=False,
                method="acoustic_variant_alternating_cadence",
                start_uncertainty=0.18,
            )
            claimed.add(index)
    return repaired


def _repair_stretched_cadence_boundaries(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    times: np.ndarray,
    onset_scores: np.ndarray,
    onset_indices: np.ndarray,
    *,
    cue_lead_seconds: float,
) -> list[CoarseLineAnchor]:
    """Recover a section entrance stretched across an earlier activity island.

    A suspicious first line is measured against the stable cadence and
    duration density of the following lines in the same section.  The repair
    is allowed only when the existing anchor consumes far more time than that
    evidence supports and an independent hard attack appears near the
    cadence-derived entrance.  Repeated vocalizations are excluded because a
    deliberately sustained chant can legitimately span several later beats.
    """

    repaired = list(anchors)
    if len(repaired) < 4 or not len(onset_indices):
        return repaired

    def stable(anchor: CoarseLineAnchor) -> bool:
        return (
            not anchor.interpolated
            and anchor.confidence >= 0.7
            and anchor.start_uncertainty <= 1.0
            and (
                anchor.method.startswith("lexical")
                or anchor.method == "acoustic_onset"
            )
        )

    acoustic_candidates = [
        (
            max(
                0.0,
                float(times[candidate]) - cue_lead_seconds,
            ),
            float(onset_scores[candidate]),
        )
        for candidate in onset_indices
    ]
    for index in range(len(repaired) - 2):
        leading = index == 0
        if (
            (
                not leading
                and (
                    not lines[index].blank_before
                    or lines[index + 1].blank_before
                )
            )
            or not stable(repaired[index + 1])
        ):
            continue
        values = primary_lexical_values(lines[index].text)
        if len(set(values)) < 3:
            continue

        cadence_gaps: list[float] = []
        normalized_durations: list[float] = []
        for following in range(
            index + 1,
            min(len(repaired) - 1, index + 6),
        ):
            if lines[following + 1].blank_before:
                break
            left = repaired[following]
            right = repaired[following + 1]
            if stable(left) and stable(right):
                gap = right.start - left.start
                if 1.2 <= gap <= 10.0:
                    cadence_gaps.append(gap)
            duration = left.end - left.start
            if duration > 0.2:
                normalized_durations.append(
                    duration
                    / max(
                        1,
                        len(lexical_values(lines[following].text)),
                    )
                )
        minimum_gaps = 2 if leading else 1
        if (
            len(cadence_gaps) < minimum_gaps
            or not normalized_durations
        ):
            continue

        base_gap = float(median(cadence_gaps))
        current = repaired[index]
        following = repaired[index + 1]
        expected = following.start - base_gap
        unit_count = max(
            1,
            len(lexical_values(lines[index].text)),
        )
        normalized_duration = (
            max(0.0, current.end - current.start) / unit_count
        )
        typical_duration = float(median(normalized_durations))
        if typical_duration <= 0.0:
            continue
        stretch = normalized_duration / typical_duration
        lower = (
            0.0
            if leading
            else repaired[index - 1].end + 0.2
        )
        if (
            expected - current.start < 2.5
            or following.start - current.start
            < max(base_gap + 2.5, 1.5 * base_gap)
            or expected < lower
        ):
            continue
        if leading:
            if (
                current.start_uncertainty < 2.0
                and stretch < 1.9
            ):
                continue
        elif not (
            stretch >= 1.9
            or (
                current.start_uncertainty >= 2.0
                and stretch >= 1.4
            )
            or (
                current.start < repaired[index - 1].end - 1.0
                and stretch >= 1.4
            )
        ):
            continue

        options = [
            (
                score - 10.0 * abs(start - expected),
                start,
            )
            for start, score in acoustic_candidates
            if (
                abs(start - expected) <= 1.0
                and start >= lower
                and start <= following.start - 0.28
            )
        ]
        if not options:
            continue
        _, proposed = max(options)
        current_error = abs(
            (following.start - current.start) - base_gap
        )
        proposed_error = abs(
            (following.start - proposed) - base_gap
        )
        if (
            proposed - current.start < 2.25
            or current_error - proposed_error < 2.0
        ):
            continue

        duration = max(0.0, current.end - current.start)
        repaired[index] = replace(
            current,
            start=proposed,
            end=max(
                proposed,
                min(proposed + duration, following.start),
            ),
            confidence=0.52,
            interpolated=False,
            method=(
                "acoustic_stretched_leading_cadence"
                if leading
                else "acoustic_stretched_section_cadence"
            ),
            start_uncertainty=0.25,
        )
    return repaired


def refine_acoustic_onsets(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    audio_path: str | Path,
    *,
    cue_lead_seconds: float = 0.0,
    experimental_repeat_grid: bool = False,
) -> tuple[list[CoarseLineAnchor], AcousticRefinementSummary]:
    """Snap uncertain line starts to isolated-vocal energy rises.

    The raw ASR path remains available as a fallback candidate for every line.
    A global monotonic path prevents a locally strong internal syllable from
    forcing later lines backwards.
    """

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    samples, sample_rate = _mono_samples(Path(audio_path).resolve())
    times, onset_scores, post_db, noise_floor, onset_indices = (
        _onset_profile(samples, sample_rate)
    )
    if not len(onset_indices):
        return (
            list(anchors),
            AcousticRefinementSummary(0, 0, noise_floor),
        )
    working_anchors = _rebase_leading_weak_run(
        lines,
        anchors,
        times,
        onset_scores,
        onset_indices,
    )
    working_anchors = _repair_leading_vocalizations(
        lines,
        working_anchors,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_isolated_gap_vocalizations(
        lines,
        working_anchors,
        times,
        onset_scores,
        post_db,
        noise_floor,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_unmatched_leading_prefixes(
        working_anchors,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    # Claim a complete weak outro before generic gap and fragment repair can
    # consume only its loudest first rows. A later second pass remains useful
    # when repeat repair exposes a new trailing weak run.
    working_anchors = _repair_trailing_weak_run(
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_dense_trailing_prefix(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_acoustic_repeat_pairs(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_periodic_repeat_boundary(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_acoustic_repeat_outliers(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_repeat_offset_outliers(
        lines,
        working_anchors,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_acoustic_sparse_repeats(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_stretched_lexical_bridges(
        working_anchors,
        times,
        onset_scores,
        post_db,
        noise_floor,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_acoustic_gap_clusters(
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _repair_acoustic_fragment_sequences(
        lines,
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
        reference_anchors=anchors,
    )
    working_anchors = _repair_trailing_weak_run(
        working_anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    working_anchors = _transfer_acoustic_repeat_counterparts(
        lines,
        working_anchors,
    )
    working_anchors = _repair_unclaimed_segment_prefixes(
        working_anchors,
        times,
        onset_scores,
        post_db,
        noise_floor,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    consecutive_repeats = _consecutive_repeat_indices(lines)
    options: list[list[tuple[float, float, bool]]] = []
    for line_index, (line, anchor) in enumerate(
        zip(lines, working_anchors, strict=True)
    ):
        allowed, weak = _eligible(line, anchor)
        leading = anchor.method == "acoustic_leading_activity"
        bridge = anchor.method == "acoustic_repeat_bridge"
        segment_hint = anchor.method == "lexical_segment_start"
        repeated_leading = (
            anchor.method == "lexical_repeated_leading"
        )
        raw = (
            anchor.start,
            (
                8.0
                if leading
                else (
                    10.0
                    if bridge
                    else (
                        12.0
                        if segment_hint or repeated_leading
                        else 18.0
                    )
                )
            ),
            False,
        )
        if not allowed:
            options.append([raw])
            continue
        if weak:
            backward = 6.0 if leading else 4.8
            forward = 4.5 if leading else 4.0
        else:
            backward = max(
                1.8,
                min(3.8, anchor.start_uncertainty + 1.5),
            )
            forward = max(
                3.2,
                min(4.5, anchor.start_uncertainty + 3.0),
            )
        selected = onset_indices[
            (times[onset_indices] >= anchor.start - backward)
            & (times[onset_indices] <= anchor.start + forward)
        ]
        if segment_hint:
            # This method already moved the lexical estimate back to the
            # beginning of its exclusive ASR segment. It is an early bound,
            # so acoustic evidence may refine it forward. Keep the correction
            # local: a much later, louder syllable inside the same long lyric
            # must not replace the line entrance.
            selected = selected[
                times[selected]
                >= anchor.start
                + max(0.0, cue_lead_seconds)
                - 0.08
            ]
            if (
                (line.detected_language or "English")
                not in _LATIN_LANGUAGES
                and len(lexical_values(line.text)) > 2
            ):
                maximum_cue_shift = max(
                    0.75,
                    min(1.25, anchor.start_uncertainty + 0.5),
                )
                selected = selected[
                    times[selected]
                    - max(0.0, cue_lead_seconds)
                    - anchor.start
                    <= maximum_cue_shift
                ]
        if (
            anchor.interpolated
            and line_index > 0
            and working_anchors[line_index - 1].confidence >= 0.5
            and working_anchors[line_index - 1].end
            <= anchor.start + 0.75
        ):
            selected = selected[
                times[selected]
                >= working_anchors[line_index - 1].end
                + max(0.0, cue_lead_seconds)
                - 0.1
            ]
        # A word-matched anchor should not jump several seconds merely
        # because an internal syllable or backing-vocal attack is louder.
        # Short lines and consecutive identical refrains remain exempt:
        # their lexical timestamps are intrinsically ambiguous and acoustic
        # entrances carry more useful information.
        if (
            (
                (
                    anchor.method == "lexical"
                    and len(lexical_values(line.text)) > 2
                )
                or repeated_leading
            )
            and line_index not in consecutive_repeats
        ):
            maximum_shift = max(
                1.25,
                1.5 * anchor.start_uncertainty + 0.25,
            )
            selected = selected[
                np.abs(times[selected] - anchor.start)
                <= maximum_shift
            ]
        candidates = [
            (
                float(times[index]),
                float(
                    onset_scores[index]
                    - (
                        0.9
                        if leading
                        else (
                            1.5
                            if bridge
                            else (
                                2.0
                                if segment_hint or repeated_leading
                                else 4.0
                            )
                        )
                    )
                    * abs(times[index] - anchor.start)
                ),
                True,
            )
            for index in selected
        ]
        candidates.sort(key=lambda item: item[1], reverse=True)
        options.append(
            sorted(candidates[:24] + [raw], key=lambda item: item[0])
        )

    negative_infinity = -1e30
    scores = [
        [negative_infinity] * len(line_options)
        for line_options in options
    ]
    traces = [[-1] * len(line_options) for line_options in options]
    for option_index, (_, score, _) in enumerate(options[0]):
        scores[0][option_index] = score
    for line_index in range(1, len(options)):
        for option_index, (start, local, _) in enumerate(
            options[line_index]
        ):
            for previous_index, (previous, _, _) in enumerate(
                options[line_index - 1]
            ):
                # Separate lyric rows should not consume two frames from the
                # same syllable attack.  A 280 ms floor is still permissive
                # for very fast sung or spoken lines.
                if previous + 0.28 > start:
                    continue
                transition_penalty = 0.0
                if (
                    working_anchors[line_index].method
                    in {
                        "acoustic_leading_activity",
                        "acoustic_repeat_bridge",
                    }
                    and working_anchors[line_index - 1].method
                    in {
                        "acoustic_leading_activity",
                        "acoustic_repeat_bridge",
                    }
                ):
                    expected_gap = max(
                        0.28,
                        working_anchors[line_index].start
                        - working_anchors[line_index - 1].start,
                    )
                    transition_penalty = 1.5 * abs(
                        (start - previous) - expected_gap
                    )
                candidate = (
                    scores[line_index - 1][previous_index]
                    + local
                    - transition_penalty
                )
                if candidate > scores[line_index][option_index]:
                    scores[line_index][option_index] = candidate
                    traces[line_index][option_index] = previous_index
        if max(scores[line_index]) <= negative_infinity / 2:
            previous_index = max(
                range(len(options[line_index - 1])),
                key=lambda item: scores[line_index - 1][item],
            )
            for option_index, (_, local, _) in enumerate(
                options[line_index]
            ):
                scores[line_index][option_index] = (
                    scores[line_index - 1][previous_index]
                    + local
                    - 10.0
                )
                traces[line_index][option_index] = previous_index

    option_index = max(
        range(len(options[-1])),
        key=lambda item: scores[-1][item],
    )
    selected_options: list[tuple[float, float, bool]] = []
    for line_index in range(len(options) - 1, -1, -1):
        selected_options.append(options[line_index][option_index])
        option_index = traces[line_index][option_index]
    selected_options.reverse()

    refined: list[CoarseLineAnchor] = []
    refined_count = 0
    cue_lead = max(0.0, cue_lead_seconds)
    planned_starts = [
        max(0.0, start - cue_lead) if acoustic else start
        for start, _, acoustic in selected_options
    ]
    for line_index, (anchor, (start, _, acoustic)) in enumerate(
        zip(working_anchors, selected_options, strict=True)
    ):
        if not acoustic or abs(start - anchor.start) < 0.08:
            refined.append(anchor)
            continue
        cue_start = planned_starts[line_index]
        coverage = anchor.matched_units / max(1, anchor.total_units)
        precise_lexical = (
            anchor.method == "lexical"
            and anchor.confidence >= 0.97
            and coverage >= 0.999
            and anchor.start_uncertainty <= 1.0
        )
        if (
            precise_lexical
            and cue_start < anchor.start - 1.25
        ):
            previous_start = (
                refined[-1].start if refined else -math.inf
            )
            following_start = (
                planned_starts[line_index + 1]
                if line_index + 1 < len(planned_starts)
                else math.inf
            )
            if (
                previous_start + 0.28 <= anchor.start
                and anchor.start + 0.28 <= following_start
            ):
                # Keep the globally selected onset path available to adjacent
                # rows, but do not overwrite an independent exact word match
                # with a much earlier breath, backing vocal, or previous-line
                # tail. Restoring only at writeback avoids making a neighbour
                # consume the rejected onset; the spacing check preserves the
                # same monotonic floor as the global path.
                refined.append(anchor)
                continue
        duration = max(0.0, anchor.end - anchor.start)
        refined.append(
            replace(
                anchor,
                start=cue_start,
                end=cue_start + duration,
                confidence=max(0.42, min(0.7, anchor.confidence)),
                interpolated=False,
                method="acoustic_onset",
                start_uncertainty=0.12,
            )
        )
        refined_count += 1
    refined = _stabilize_repeat_offsets(
        lines,
        working_anchors,
        refined,
    )
    refined = _repair_dense_repeat_offset_outliers(
        lines,
        refined,
    )
    refined = _repair_unique_dense_repeat_outliers(
        lines,
        refined,
    )
    refined = _repair_repeat_template_consensus(lines, refined)
    refined = _repair_repeat_template_outliers(lines, refined)
    refined = _repair_consecutive_repeat_cadence(lines, refined)
    refined = _repair_identical_repeat_cadence(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
        experimental_periodic_grid=experimental_repeat_grid,
    )
    refined = _repair_collapsed_repeat_cadence(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_recurrent_identical_line_runs(
        lines,
        refined,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeat_suffix_offset_outliers(
        lines,
        refined,
    )
    refined = _repair_trailing_vocalization_cadence(
        lines,
        refined,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_trailing_rhythmic_run(
        lines,
        refined,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_trailing_weak_run(
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined, stretched_second_count = (
        _repair_stretched_second_word_hints(
            refined,
            times,
            onset_scores,
            onset_indices,
            cue_lead_seconds=max(0.0, cue_lead_seconds),
            reference_anchors=anchors,
        )
    )
    refined_count += stretched_second_count
    refined, rebased_gap_count = _rebase_stale_acoustic_gap_clusters(
        anchors,
        refined,
        times,
        onset_scores,
        post_db,
        noise_floor,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined_count += rebased_gap_count
    refined, rebased_overlap_count = _repair_stale_overlap_runs(
        anchors,
        refined,
        times,
        onset_scores,
        post_db,
        noise_floor,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined_count += rebased_overlap_count
    refined, reinterpolated_count = _reinterpolate_stale_weak_runs(
        anchors,
        refined,
    )
    refined_count += reinterpolated_count
    refined, shifted_onset_count = _repair_shifted_dense_onset_runs(
        lines,
        anchors,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined_count += shifted_onset_count
    refined = _repair_boundary_locked_alternating_runs(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_duration_stretched_weak_suffix(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_short_interpolated_suffix(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeated_section_cadence(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_exact_repeated_section_outliers(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeated_chant_suffix(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeated_internal_refrain_onsets(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeated_prefix_cadence_tails(
        lines,
        refined,
        times,
        onset_scores,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_dense_shared_prefix_chants(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_variant_alternating_cadence(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_repeated_trailing_acoustic_motif(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = _repair_stretched_cadence_boundaries(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
    )
    refined = repair_verified_structural_outliers(
        lines,
        refined,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
        reference_anchors=anchors,
        run_post_refrain=False,
    )
    return (
        refined,
        AcousticRefinementSummary(
            candidate_count=len(onset_indices),
            refined_lines=refined_count,
            noise_floor_db=noise_floor,
        ),
    )


def refine_post_refrain_verified_onsets(
    lines: list[TranscriptLine],
    anchors: list[CoarseLineAnchor],
    audio_path: str | Path,
    *,
    cue_lead_seconds: float = 0.0,
    reference_anchors: list[CoarseLineAnchor] | None = None,
) -> list[CoarseLineAnchor]:
    """Run the verified second pass after refrain structure is finalized."""

    if len(lines) != len(anchors):
        raise ValueError("歌词行和锚点数量不一致。")
    samples, sample_rate = _mono_samples(Path(audio_path).resolve())
    times, onset_scores, _, _, onset_indices = _onset_profile(
        samples,
        sample_rate,
    )
    if not len(onset_indices):
        return list(anchors)
    return repair_verified_structural_outliers(
        lines,
        anchors,
        times,
        onset_scores,
        onset_indices,
        cue_lead_seconds=max(0.0, cue_lead_seconds),
        reference_anchors=reference_anchors,
        run_pre_refrain=False,
    )
