from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import mean, median

from .types import AlignmentResult


@dataclass(frozen=True, slots=True)
class AlignmentMetrics:
    evaluated_lines: int
    mean_absolute_error: float
    median_absolute_error: float
    p90_absolute_error: float
    max_absolute_error: float
    within_250ms: float
    within_500ms: float
    within_1s: float

    def to_dict(self) -> dict[str, float | int]:
        return {
            "evaluated_lines": self.evaluated_lines,
            "mean_absolute_error": self.mean_absolute_error,
            "median_absolute_error": self.median_absolute_error,
            "p90_absolute_error": self.p90_absolute_error,
            "max_absolute_error": self.max_absolute_error,
            "within_250ms": self.within_250ms,
            "within_500ms": self.within_500ms,
            "within_1s": self.within_1s,
        }


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def evaluate_reference_axes(result: AlignmentResult) -> AlignmentMetrics:
    errors = [
        abs(item.start - item.line.reference_start)
        for item in result.lines
        if item.line.reference_start is not None
    ]
    if not errors:
        raise ValueError("输入文字稿没有可用于评测的 LRC 时间轴。")
    count = len(errors)
    return AlignmentMetrics(
        evaluated_lines=count,
        mean_absolute_error=mean(errors),
        median_absolute_error=median(errors),
        p90_absolute_error=_percentile(errors, 0.9),
        max_absolute_error=max(errors),
        within_250ms=sum(error <= 0.25 for error in errors) / count,
        within_500ms=sum(error <= 0.5 for error in errors) / count,
        within_1s=sum(error <= 1.0 for error in errors) / count,
    )

