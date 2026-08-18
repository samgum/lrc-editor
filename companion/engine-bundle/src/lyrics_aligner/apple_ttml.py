from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


_XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
_TTM_ROLE = "{http://www.w3.org/ns/ttml#metadata}role"


@dataclass(frozen=True, slots=True)
class TtmlTimedUnit:
    text: str
    start: float
    end: float
    lane: str = "main"


@dataclass(frozen=True, slots=True)
class TtmlLyricLine:
    key: str
    text: str
    start: float
    end: float
    tokens: tuple[TtmlTimedUnit, ...] = ()
    background_tokens: tuple[TtmlTimedUnit, ...] = ()
    blank_before: bool = False
    song_part: str | None = None


@dataclass(frozen=True, slots=True)
class AppleTtmlLyrics:
    timing: str
    language: str | None
    duration: float | None
    lines: tuple[TtmlLyricLine, ...]

    @property
    def word_timed(self) -> bool:
        return self.timing.casefold() == "word" and any(
            line.tokens for line in self.lines
        )


def _local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def _attribute(
    element: ET.Element,
    name: str,
    default: str = "",
) -> str:
    if name in element.attrib:
        return element.attrib[name]
    for key, value in element.attrib.items():
        if _local_name(key) == name:
            return value
    return default


def parse_ttml_time(value: str) -> float:
    raw = value.strip()
    if not raw:
        raise ValueError("TTML 时间值为空。")
    upper = raw.upper()
    if upper.startswith("PT"):
        match = re.fullmatch(
            r"PT(?:(?P<h>\d+(?:\.\d+)?)H)?"
            r"(?:(?P<m>\d+(?:\.\d+)?)M)?"
            r"(?:(?P<s>\d+(?:\.\d+)?)S)?",
            upper,
        )
        if not match:
            raise ValueError(f"不支持的 ISO-8601 TTML 时间：{raw}")
        seconds = (
            Decimal(match.group("h") or "0") * 3600
            + Decimal(match.group("m") or "0") * 60
            + Decimal(match.group("s") or "0")
        )
    else:
        parts = raw.rstrip("sS").split(":")
        if len(parts) == 1:
            seconds = Decimal(parts[0])
        elif len(parts) == 2:
            seconds = Decimal(parts[0]) * 60 + Decimal(parts[1])
        elif len(parts) == 3:
            seconds = (
                Decimal(parts[0]) * 3600
                + Decimal(parts[1]) * 60
                + Decimal(parts[2])
            )
        else:
            raise ValueError(f"不支持的 TTML 时间：{raw}")
    milliseconds = (seconds * 1000).quantize(
        Decimal("1"),
        rounding=ROUND_HALF_UP,
    )
    return int(milliseconds) / 1000.0


def _optional_time(element: ET.Element, name: str) -> float | None:
    value = _attribute(element, name)
    return parse_ttml_time(value) if value else None


def _direct_children(
    element: ET.Element,
    local_name: str,
) -> list[ET.Element]:
    return [
        child
        for child in list(element)
        if _local_name(child.tag) == local_name
    ]


def _is_timed_span(element: ET.Element) -> bool:
    return (
        _local_name(element.tag) == "span"
        and bool(_attribute(element, "begin"))
    )


def _leaf_timed_spans(element: ET.Element) -> list[ET.Element]:
    candidates = [
        item
        for item in element.iter()
        if _is_timed_span(item)
    ]
    leaves: list[ET.Element] = []
    for candidate in candidates:
        if not any(
            descendant is not candidate and _is_timed_span(descendant)
            for descendant in candidate.iter()
        ):
            leaves.append(candidate)
    return leaves


def _clean_spacing(value: str | None) -> str:
    if not value:
        return ""
    if any(character in value for character in "\r\n\t"):
        return re.sub(r"\s+", " ", value)
    return value


def _span_text(span: ET.Element) -> str:
    return "".join(span.itertext())


def _render_spans(
    spans: list[ET.Element],
    *,
    prefix: str = "",
) -> str:
    return (
        _clean_spacing(prefix)
        + "".join(
            _span_text(span) + _clean_spacing(span.tail)
            for span in spans
        )
    ).strip()


def _timed_units(
    spans: list[ET.Element],
    *,
    lane: str,
) -> tuple[TtmlTimedUnit, ...]:
    units: list[TtmlTimedUnit] = []
    for span in spans:
        start = _optional_time(span, "begin")
        end = _optional_time(span, "end")
        if start is None or end is None:
            continue
        if end < start:
            raise ValueError(
                f"TTML 字词结束时间早于开始时间：{start} -> {end}"
            )
        units.append(
            TtmlTimedUnit(
                text=_span_text(span),
                start=start,
                end=end,
                lane=lane,
            )
        )
    return tuple(units)


def _parenthesize(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    if text.startswith("(") and text.endswith(")"):
        return text
    return f"({text})"


def parse_apple_ttml(path: str | Path) -> AppleTtmlLyrics:
    source = Path(path).resolve()
    root = ET.parse(source).getroot()
    timing = _attribute(root, "timing") or "unspecified"
    language = root.attrib.get(_XML_LANG) or _attribute(root, "lang") or None
    body = next(
        (
            element
            for element in root.iter()
            if _local_name(element.tag) == "body"
        ),
        None,
    )
    duration = _optional_time(body, "dur") if body is not None else None

    lines: list[TtmlLyricLine] = []
    paragraph_number = 0
    for div in (
        element
        for element in root.iter()
        if _local_name(element.tag) == "div"
    ):
        paragraphs = _direct_children(div, "p")
        if not paragraphs:
            continue
        song_part = _attribute(div, "songPart") or None
        for paragraph_index, paragraph in enumerate(paragraphs):
            paragraph_number += 1
            key = _attribute(
                paragraph,
                "key",
                f"L{paragraph_number}",
            )
            paragraph_start = _optional_time(paragraph, "begin")
            paragraph_end = _optional_time(paragraph, "end")

            main_spans: list[ET.Element] = []
            background_groups: list[list[ET.Element]] = []
            for child in _direct_children(paragraph, "span"):
                role = _attribute(child, "role") or child.attrib.get(
                    _TTM_ROLE,
                    "",
                )
                leaves = _leaf_timed_spans(child)
                if not leaves:
                    continue
                if role == "x-bg":
                    background_groups.append(leaves)
                else:
                    main_spans.extend(leaves)

            if not main_spans:
                background_ids = {
                    id(span)
                    for group in background_groups
                    for span in group
                }
                main_spans = [
                    span
                    for span in _leaf_timed_spans(paragraph)
                    if id(span) not in background_ids
                ]

            main_tokens = _timed_units(main_spans, lane="main")
            background_tokens = tuple(
                token
                for group in background_groups
                for token in _timed_units(group, lane="background")
            )
            if main_spans:
                text = _render_spans(
                    main_spans,
                    prefix=paragraph.text or "",
                )
            else:
                text = "".join(paragraph.itertext()).strip()
            background_texts = [
                _parenthesize(_render_spans(group))
                for group in background_groups
            ]
            background_texts = [
                value for value in background_texts if value
            ]
            if background_texts:
                text = (text + " " + " ".join(background_texts)).strip()
            if not text:
                continue

            if paragraph_start is None:
                if main_tokens:
                    paragraph_start = main_tokens[0].start
                elif background_tokens:
                    paragraph_start = background_tokens[0].start
                else:
                    raise ValueError(f"{source.name} 的 {key} 缺少开始时间。")
            if paragraph_end is None:
                token_ends = [
                    token.end
                    for token in (*main_tokens, *background_tokens)
                ]
                paragraph_end = max(token_ends, default=paragraph_start)
            if paragraph_end < paragraph_start:
                raise ValueError(
                    f"{source.name} 的 {key} 结束时间早于开始时间。"
                )
            lines.append(
                TtmlLyricLine(
                    key=key,
                    text=text,
                    start=paragraph_start,
                    end=paragraph_end,
                    tokens=main_tokens,
                    background_tokens=background_tokens,
                    blank_before=bool(lines) and paragraph_index == 0,
                    song_part=song_part,
                )
            )

    if not lines:
        raise ValueError(f"TTML 中没有可用歌词行：{source}")
    # Apple may keep short overlapping responses after the lead line in
    # document order even when their actual start is a few milliseconds
    # earlier. LRC and the aligner need chronological order; Python's stable
    # sort preserves source order when two entrances are exactly equal.
    lines.sort(key=lambda line: line.start)
    for previous, current in zip(lines, lines[1:]):
        if current.start < previous.start:
            raise ValueError(
                f"TTML 行时间倒序：{previous.key} -> {current.key}"
            )
    return AppleTtmlLyrics(
        timing=timing,
        language=language,
        duration=duration,
        lines=tuple(lines),
    )


def _format_lrc_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    minutes, remainder = divmod(milliseconds, 60_000)
    whole_seconds, fraction = divmod(remainder, 1000)
    return f"[{minutes:02d}:{whole_seconds:02d}.{fraction:03d}]"


def render_reference_lrc(lyrics: AppleTtmlLyrics) -> str:
    rendered: list[str] = []
    for line in lyrics.lines:
        if rendered and line.blank_before and rendered[-1]:
            rendered.append("")
        rendered.append(f"{_format_lrc_time(line.start)}{line.text}")
    return "\n".join(rendered)


def render_word_gold_json(
    lyrics: AppleTtmlLyrics,
    *,
    source: str | Path,
) -> str:
    payload = {
        "schema_version": 1,
        "source_ttml": str(Path(source).resolve()),
        "timing": lyrics.timing,
        "language": lyrics.language,
        "duration": lyrics.duration,
        "word_timed": lyrics.word_timed,
        "lines": [asdict(line) for line in lyrics.lines],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
