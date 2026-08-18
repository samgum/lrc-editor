from __future__ import annotations

import json
from decimal import Decimal, ROUND_FLOOR

from .types import AlignmentResult, LineAlignment
from .word_timing import token_character_offsets


def _floor_units(seconds: float, units_per_second: int) -> int:
    value = Decimal(str(max(0.0, seconds))) * units_per_second
    return int(value.to_integral_value(rounding=ROUND_FLOOR))


def _lrc_units_per_second(precision: int) -> int:
    if precision not in (2, 3):
        raise ValueError("LRC 精度只能是 2 或 3。")
    return 10**precision


def _format_lrc_units(total_units: int, precision: int) -> str:
    units_per_second = _lrc_units_per_second(precision)
    minutes, remainder = divmod(total_units, 60 * units_per_second)
    whole_seconds, fraction = divmod(remainder, units_per_second)
    return f"[{minutes:02d}:{whole_seconds:02d}.{fraction:0{precision}d}]"


def format_lrc_timestamp(seconds: float, precision: int = 3) -> str:
    units_per_second = _lrc_units_per_second(precision)
    return _format_lrc_units(
        _floor_units(seconds, units_per_second),
        precision,
    )


def _lrc_axis(
    result: AlignmentResult,
    precision: int,
) -> list[tuple[int | None, int]]:
    """Build a strictly increasing rendered axis, including section blanks.

    Simultaneous or sub-precision source rows are valid alignment data, but an
    extra timestamp-only LRC row cannot fit between equal rendered timestamps.
    Nudge only the rendered axis by the minimum unit (1 or 10 ms) instead of
    dropping the requested blank or failing the entire export.
    """

    units_per_second = _lrc_units_per_second(precision)
    axis: list[tuple[int | None, int]] = []
    last_units = -1
    for index, item in enumerate(result.lines):
        requested_units = _floor_units(item.start, units_per_second)
        blank_units: int | None = None
        if index and item.line.blank_before:
            lyric_units = max(requested_units, last_units + 2)
            previous_end_units = _floor_units(
                result.lines[index - 1].end,
                units_per_second,
            )
            blank_units = (
                previous_end_units
                if last_units < previous_end_units < lyric_units
                else lyric_units - 1
            )
        else:
            lyric_units = max(requested_units, last_units + 1)
        axis.append((blank_units, lyric_units))
        last_units = lyric_units
    return axis


def export_lrc(result: AlignmentResult, precision: int = 3) -> str:
    rendered: list[str] = []
    for item, (blank_units, lyric_units) in zip(
        result.lines,
        _lrc_axis(result, precision),
        strict=True,
    ):
        if blank_units is not None:
            rendered.append(
                _format_lrc_units(blank_units, precision)
            )
        rendered.append(
            f"{_format_lrc_units(lyric_units, precision)}{item.line.text}"
        )
    return "\n".join(rendered)


def export_enhanced_lrc_beta(
    result: AlignmentResult,
    precision: int = 3,
) -> str:
    """Render verified word starts while preserving the original lyric text."""

    rendered: list[str] = []
    units_per_second = _lrc_units_per_second(precision)
    for item, (blank_units, lyric_units) in zip(
        result.lines,
        _lrc_axis(result, precision),
        strict=True,
    ):
        if blank_units is not None:
            rendered.append(
                _format_lrc_units(blank_units, precision)
            )
        prefix = _format_lrc_units(lyric_units, precision)
        offsets = token_character_offsets(item.line.text, item.tokens)
        if offsets is None:
            rendered.append(f"{prefix}{item.line.text}")
            continue
        markers: dict[int, list[str]] = {}
        for offset, token in zip(offsets, item.tokens, strict=True):
            token_units = max(
                lyric_units,
                _floor_units(token.start, units_per_second),
            )
            token_timestamp = _format_lrc_units(
                token_units,
                precision,
            )
            markers.setdefault(offset, []).append(
                f"<{token_timestamp[1:-1]}>"
            )
        content: list[str] = []
        for offset, character in enumerate(item.line.text):
            content.extend(markers.get(offset, ()))
            content.append(character)
        rendered.append(prefix + "".join(content))
    return "\n".join(rendered)


def format_srt_timestamp(seconds: float) -> str:
    total_ms = _floor_units(seconds, 1000)
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return (
        f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},"
        f"{milliseconds:03d}"
    )


def _srt_end(lines: list[LineAlignment], index: int) -> float:
    item = lines[index]
    if index + 1 < len(lines):
        next_start = lines[index + 1].start
        return max(item.start + 0.05, next_start - 0.001)
    return max(item.start + 0.25, item.end)


def export_srt(result: AlignmentResult) -> str:
    blocks: list[str] = []
    for index, item in enumerate(result.lines):
        end = _srt_end(result.lines, index)
        blocks.append(
            "\n".join(
                (
                    str(index + 1),
                    f"{format_srt_timestamp(item.start)} --> "
                    f"{format_srt_timestamp(end)}",
                    item.line.text,
                )
            )
        )
    return "\n\n".join(blocks) + "\n"


def export_json(result: AlignmentResult) -> str:
    return json.dumps(
        result.to_dict(),
        ensure_ascii=False,
        indent=2,
    ) + "\n"
