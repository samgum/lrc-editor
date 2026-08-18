from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
from typing import Any, Iterable
import unicodedata

import soundfile

from .language import detect_line_languages


_TRACK_LANGUAGE_NAMES = {
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
    "pt": "Portuguese",
}
_LATIN_WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.UNICODE)
_SCRIPT_LANGUAGES = frozenset(
    {"Chinese", "Japanese", "Korean", "Russian"}
)


@dataclass(frozen=True)
class RootSplit:
    root: str
    group: str
    split: str


@dataclass(frozen=True)
class ClipCandidate:
    split: str
    group: str
    track_id: str
    line_index: int
    audio: str
    text: str
    language: str
    line_start: float
    line_end: float
    clip_start: float
    clip_end: float

    @property
    def key(self) -> str:
        return f"{self.track_id}-L{self.line_index:04d}"

    @property
    def song_family(self) -> str:
        """Return a conservative title key shared by common song variants."""

        value = unicodedata.normalize("NFKC", Path(self.audio).stem).casefold()
        value = re.sub(r"^\s*\d+\s*[.\-_]\s*", "", value)
        value = re.sub(
            r"[\[(][^\])]*(?:acoustic|live|remix|version|edit|"
            r"re-recorded|remaster|instrumental)[^\])]*[\])]",
            " ",
            value,
        )
        value = re.sub(
            r"\b(?:acoustic|live|remix|version|edit|re-recorded|"
            r"remaster(?:ed)?|instrumental)\b",
            " ",
            value,
        )
        value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
        return " ".join(value.split())


@dataclass(frozen=True)
class CollectionResult:
    candidates: tuple[ClipCandidate, ...]
    skipped: dict[str, int]


def _resolved_config_path(config_path: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = config_path.parent / path
    return path.resolve()


def _normal_root(value: str) -> str:
    return str(Path(value)).replace("/", "\\").rstrip("\\").casefold()


def load_experiment_config(config_path: Path) -> dict[str, Any]:
    config_path = config_path.resolve()
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1:
        raise ValueError("ASR 微调配置 schema_version 必须为 1。")
    sources = payload.get("sources")
    groups = payload.get("root_splits")
    if not isinstance(sources, list) or not sources:
        raise ValueError("ASR 微调配置至少需要一个 sources 清单。")
    if not isinstance(groups, list) or not groups:
        raise ValueError("ASR 微调配置至少需要一个 root_splits 条目。")
    return payload


def validate_root_splits(items: Iterable[RootSplit]) -> None:
    root_to_split: dict[str, str] = {}
    group_to_split: dict[str, str] = {}
    for item in items:
        if item.split not in {"train", "validation", "test"}:
            raise ValueError(f"未知数据划分：{item.split}")
        root_key = _normal_root(item.root)
        previous_root = root_to_split.setdefault(root_key, item.split)
        if previous_root != item.split:
            raise ValueError(f"同一素材目录跨数据划分：{item.root}")
        previous_group = group_to_split.setdefault(item.group, item.split)
        if previous_group != item.split:
            raise ValueError(
                f"同一艺人组不得跨数据划分：{item.group}"
            )


def _clip_bounds(
    lines: list[dict[str, Any]],
    index: int,
    *,
    duration: float,
    pre_padding: float,
    post_padding: float,
    overlap_tolerance: float,
) -> tuple[float, float] | None:
    line = lines[index]
    start = float(line["start"])
    end = float(line["end"])
    if not (
        math.isfinite(start)
        and math.isfinite(end)
        and end > start
        and start >= 0.0
    ):
        return None
    if index:
        previous_end = float(lines[index - 1]["end"])
        if previous_end - start > overlap_tolerance:
            return None
    else:
        previous_end = 0.0
    if index + 1 < len(lines):
        next_start = float(lines[index + 1]["start"])
        if end - next_start > overlap_tolerance:
            return None
    else:
        next_start = duration

    clip_start = max(0.0, start - pre_padding)
    clip_end = min(duration, end + post_padding)
    if index:
        clip_start = max(
            clip_start,
            min(start, previous_end + 0.02),
        )
    if index + 1 < len(lines):
        clip_end = min(
            clip_end,
            max(end, next_start - 0.02),
        )
    if clip_end <= clip_start:
        return None
    return clip_start, clip_end


def _training_language(
    text: str,
    detected: str,
    track_language: str,
) -> str:
    """Choose a conservative Qwen language prefix for one lyric line."""

    track = _TRACK_LANGUAGE_NAMES.get(
        track_language.casefold(),
        "None",
    )
    if detected == "Chinese" and track == "Japanese":
        # Kana-free Japanese hooks are otherwise indistinguishable from
        # Chinese by script alone.
        return "Japanese"
    if detected in _SCRIPT_LANGUAGES:
        return detected
    latin_words = _LATIN_WORD.findall(text)
    if len(latin_words) <= 2 and track == "English":
        # Ad-libs such as "mwah" and "brrt" are not reliable evidence for
        # a separate Latin language.
        return "English"
    if track == "English" and detected != "English":
        # Mixed English/French/Spanish lines should train transcription
        # without teaching a false single-language detector label.
        return "None"
    return detected


def collect_candidates(
    config_path: Path,
    *,
    minimum_line_seconds: float = 0.55,
    maximum_line_seconds: float = 18.0,
    maximum_clip_seconds: float = 20.0,
    pre_padding: float = 0.12,
    post_padding: float = 0.08,
    overlap_tolerance: float = 0.08,
) -> CollectionResult:
    config_path = config_path.resolve()
    config = load_experiment_config(config_path)
    root_splits = tuple(
        RootSplit(
            root=str(item["root"]),
            group=str(item["group"]),
            split=str(item["split"]),
        )
        for item in config["root_splits"]
    )
    validate_root_splits(root_splits)
    policies = {
        _normal_root(item.root): item
        for item in root_splits
    }
    excluded_audio = {
        _normal_root(str(Path(value).resolve()))
        for value in config.get("excluded_audio", [])
    }
    excluded_clips = {
        str(value).strip()
        for value in config.get("excluded_clips", [])
        if str(value).strip()
    }

    candidates: list[ClipCandidate] = []
    skipped: Counter[str] = Counter()
    seen_keys: set[str] = set()
    for source in config["sources"]:
        manifest_path = _resolved_config_path(
            config_path,
            str(source["manifest"]),
        )
        manifest = json.loads(
            manifest_path.read_text(encoding="utf-8")
        )
        for entry in manifest.get("entries", []):
            entry_audio = str(entry.get("audio", ""))
            if _normal_root(entry_audio) in excluded_audio:
                skipped["configured_exclusion"] += 1
                continue
            policy = policies.get(_normal_root(str(entry.get("root", ""))))
            if policy is None:
                skipped["unassigned_root"] += 1
                continue
            if not bool(entry.get("word_timed")):
                skipped["line_timed_track"] += 1
                continue
            audio = Path(str(entry["audio"])).resolve()
            gold_path = Path(str(entry["word_gold"])).resolve()
            if not audio.is_file() or not gold_path.is_file():
                skipped["missing_source"] += 1
                continue
            gold = json.loads(gold_path.read_text(encoding="utf-8"))
            if not bool(gold.get("word_timed")):
                skipped["not_word_timed"] += 1
                continue
            lines = [
                line
                for line in gold.get("lines", [])
                if str(line.get("text", "")).strip()
            ]
            if not lines:
                skipped["empty_track"] += 1
                continue
            languages = detect_line_languages(
                [str(line["text"]).strip() for line in lines]
            )
            track_language = str(
                entry.get("ttml_language")
                or gold.get("language")
                or ""
            )
            duration = float(
                entry.get("duration") or gold.get("duration") or 0.0
            )
            if not math.isfinite(duration) or duration <= 0.0:
                skipped["invalid_track_duration"] += len(lines)
                continue

            for index, (line, detected_language) in enumerate(
                zip(lines, languages, strict=True)
            ):
                text = str(line["text"]).strip()
                language = _training_language(
                    text,
                    detected_language,
                    track_language,
                )
                line_start = float(line["start"])
                line_end = float(line["end"])
                line_seconds = line_end - line_start
                if len(text) < 2:
                    skipped["text_too_short"] += 1
                    continue
                if len(text) > 300:
                    skipped["text_too_long"] += 1
                    continue
                if (
                    line_seconds < minimum_line_seconds
                    or line_seconds > maximum_line_seconds
                ):
                    skipped["line_duration"] += 1
                    continue
                bounds = _clip_bounds(
                    lines,
                    index,
                    duration=duration,
                    pre_padding=pre_padding,
                    post_padding=post_padding,
                    overlap_tolerance=overlap_tolerance,
                )
                if bounds is None:
                    skipped["overlap_or_invalid_time"] += 1
                    continue
                clip_start, clip_end = bounds
                if clip_end - clip_start > maximum_clip_seconds:
                    skipped["clip_too_long"] += 1
                    continue
                track_id = str(entry["id"])
                candidate = ClipCandidate(
                    split=policy.split,
                    group=policy.group,
                    track_id=track_id,
                    line_index=index + 1,
                    audio=str(audio),
                    text=text,
                    language=language,
                    line_start=line_start,
                    line_end=line_end,
                    clip_start=clip_start,
                    clip_end=clip_end,
                )
                if candidate.key in excluded_clips:
                    skipped["configured_clip_exclusion"] += 1
                    continue
                if candidate.key in seen_keys:
                    skipped["duplicate_key"] += 1
                    continue
                seen_keys.add(candidate.key)
                candidates.append(candidate)

    candidates.sort(
        key=lambda item: (
            item.split,
            item.group,
            item.track_id,
            item.line_index,
        )
    )
    return CollectionResult(
        candidates=tuple(candidates),
        skipped=dict(sorted(skipped.items())),
    )


def deterministic_select(
    candidates: Iterable[ClipCandidate],
    *,
    limit: int | None,
    seed: str,
    max_per_track: int | None = None,
    max_per_family: int | None = None,
    max_per_group: int | None = None,
) -> list[ClipCandidate]:
    items = list(candidates)
    for cap, key_name, key_fn in (
        (
            max_per_track,
            "track",
            lambda item: (item.group, item.track_id),
        ),
        (
            max_per_family,
            "family",
            lambda item: (item.group, item.song_family),
        ),
    ):
        if cap is None:
            continue
        if cap <= 0:
            return []
        grouped: dict[tuple[str, str], list[ClipCandidate]] = defaultdict(
            list
        )
        for item in items:
            grouped[key_fn(item)].append(item)
        items = []
        for key, bucket in sorted(grouped.items()):
            bucket.sort(
                key=lambda item: hashlib.sha256(
                    f"{seed}\0{key_name}\0{key}\0{item.key}".encode(
                        "utf-8"
                    )
                ).digest()
            )
            items.extend(bucket[:cap])
    if max_per_group is not None:
        if max_per_group <= 0:
            return []
        by_group: dict[str, list[ClipCandidate]] = defaultdict(list)
        for item in items:
            by_group[item.group].append(item)
        capped: list[ClipCandidate] = []
        for group, group_items in sorted(by_group.items()):
            by_language: dict[str, list[ClipCandidate]] = defaultdict(list)
            for item in group_items:
                by_language[item.language].append(item)
            for language, bucket in by_language.items():
                bucket.sort(
                    key=lambda item: hashlib.sha256(
                        f"{seed}\0group\0{group}\0{language}\0"
                        f"{item.key}".encode("utf-8")
                    ).digest()
                )
            group_selected: list[ClipCandidate] = []
            languages = sorted(by_language)
            while len(group_selected) < max_per_group:
                progressed = False
                for language in languages:
                    bucket = by_language[language]
                    if not bucket:
                        continue
                    group_selected.append(bucket.pop(0))
                    progressed = True
                    if len(group_selected) == max_per_group:
                        break
                if not progressed:
                    break
            capped.extend(group_selected)
        items = capped
    if limit is None or limit >= len(items):
        return sorted(items, key=lambda item: item.key)
    if limit <= 0:
        return []

    buckets: dict[tuple[str, str], list[ClipCandidate]] = defaultdict(list)
    for item in items:
        buckets[(item.group, item.language)].append(item)
    for key, bucket in buckets.items():
        bucket.sort(
            key=lambda item: hashlib.sha256(
                f"{seed}\0{key}\0{item.key}".encode("utf-8")
            ).digest()
        )

    selected: list[ClipCandidate] = []
    ordered_keys = sorted(buckets)
    while len(selected) < limit:
        progressed = False
        for key in ordered_keys:
            bucket = buckets[key]
            if not bucket:
                continue
            selected.append(bucket.pop(0))
            progressed = True
            if len(selected) == limit:
                break
        if not progressed:
            break
    return sorted(selected, key=lambda item: item.key)


def _decode_track(
    audio: Path,
    decoded: Path,
    *,
    ffmpeg: str,
) -> None:
    decoded.parent.mkdir(parents=True, exist_ok=True)
    partial = decoded.with_suffix(".partial.wav")
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(audio),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(partial),
        ],
        check=True,
    )
    partial.replace(decoded)


def _jsonl_row(candidate: ClipCandidate, audio_path: Path) -> dict[str, Any]:
    return {
        "audio": str(audio_path.resolve()),
        "text": (
            f"language {candidate.language}<asr_text>{candidate.text}"
        ),
        "prompt": "",
        "meta": {
            "key": candidate.key,
            "split": candidate.split,
            "group": candidate.group,
            "track_id": candidate.track_id,
            "line_index": candidate.line_index,
            "language": candidate.language,
            "source_audio": candidate.audio,
            "line_start": round(candidate.line_start, 6),
            "line_end": round(candidate.line_end, 6),
            "clip_start": round(candidate.clip_start, 6),
            "clip_end": round(candidate.clip_end, 6),
        },
    }


def materialize_dataset(
    candidates: Iterable[ClipCandidate],
    output_dir: Path,
    *,
    ffmpeg: str = "ffmpeg",
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    selected = list(candidates)
    by_track: dict[tuple[str, str], list[ClipCandidate]] = defaultdict(list)
    for candidate in selected:
        by_track[(candidate.track_id, candidate.audio)].append(candidate)

    rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for (track_id, source_audio), track_candidates in sorted(
        by_track.items()
    ):
        decoded = output_dir / "_decoded" / f"{track_id}.wav"
        if not decoded.is_file():
            _decode_track(
                Path(source_audio),
                decoded,
                ffmpeg=ffmpeg,
            )
        samples, sample_rate = soundfile.read(
            decoded,
            dtype="float32",
            always_2d=False,
        )
        if sample_rate != 16_000:
            raise RuntimeError(
                f"解码采样率异常：{decoded} -> {sample_rate}"
            )
        if getattr(samples, "ndim", 1) != 1:
            raise RuntimeError(f"解码音频不是单声道：{decoded}")
        for candidate in track_candidates:
            first = max(0, round(candidate.clip_start * sample_rate))
            last = min(
                len(samples),
                round(candidate.clip_end * sample_rate),
            )
            if last <= first:
                raise RuntimeError(f"切片范围为空：{candidate.key}")
            clip_path = (
                output_dir
                / "clips"
                / candidate.split
                / f"{candidate.key}.wav"
            )
            clip_path.parent.mkdir(parents=True, exist_ok=True)
            soundfile.write(
                clip_path,
                samples[first:last],
                sample_rate,
                subtype="PCM_16",
            )
            rows[candidate.split].append(
                _jsonl_row(candidate, clip_path)
            )

    split_summary: dict[str, Any] = {}
    for split in ("train", "validation", "test"):
        split_rows = sorted(
            rows.get(split, []),
            key=lambda item: str(item["meta"]["key"]),
        )
        path = output_dir / f"{split}.jsonl"
        path.write_text(
            "".join(
                json.dumps(row, ensure_ascii=False) + "\n"
                for row in split_rows
            ),
            encoding="utf-8",
            newline="\n",
        )
        split_summary[split] = {
            "clips": len(split_rows),
            "groups": dict(
                sorted(
                    Counter(
                        str(row["meta"]["group"])
                        for row in split_rows
                    ).items()
                )
            ),
            "languages": dict(
                sorted(
                    Counter(
                        str(row["meta"]["language"])
                        for row in split_rows
                    ).items()
                )
            ),
            "seconds": round(
                sum(
                    float(row["meta"]["clip_end"])
                    - float(row["meta"]["clip_start"])
                    for row in split_rows
                ),
                3,
            ),
            "jsonl": str(path),
        }
    return split_summary


def candidate_audit(
    result: CollectionResult,
    selected: Iterable[ClipCandidate],
) -> dict[str, Any]:
    selected_list = list(selected)
    split_groups: dict[str, set[str]] = defaultdict(set)
    for candidate in selected_list:
        split_groups[candidate.split].add(candidate.group)
    overlaps: dict[str, list[str]] = {}
    for left, right in (
        ("train", "validation"),
        ("train", "test"),
        ("validation", "test"),
    ):
        shared = sorted(split_groups[left] & split_groups[right])
        if shared:
            overlaps[f"{left}:{right}"] = shared
    if overlaps:
        raise ValueError(f"艺人组跨划分泄漏：{overlaps}")
    return {
        "candidate_count": len(result.candidates),
        "selected_count": len(selected_list),
        "skipped": result.skipped,
        "candidate_languages": dict(
            sorted(
                Counter(
                    candidate.language
                    for candidate in result.candidates
                ).items()
            )
        ),
        "selected_languages": dict(
            sorted(
                Counter(
                    candidate.language
                    for candidate in selected_list
                ).items()
            )
        ),
        "selected_groups": {
            split: sorted(groups)
            for split, groups in sorted(split_groups.items())
        },
        "selected_track_count": len(
            {candidate.track_id for candidate in selected_list}
        ),
        "selected_family_count": len(
            {
                (candidate.group, candidate.song_family)
                for candidate in selected_list
            }
        ),
        "group_overlap": overlaps,
        "items": [asdict(candidate) for candidate in selected_list],
    }
