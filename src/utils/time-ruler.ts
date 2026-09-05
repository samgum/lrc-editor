export interface TimeRulerTick {
    time: number;
    x: number;
    edge?: "start" | "end";
}

export const timeRulerTicks = (
    start: number,
    end: number,
    width: number,
    pixelsPerSecond: number,
    fixed: number,
): TimeRulerTick[] => {
    if (
        ![start, end, width, pixelsPerSecond].every(Number.isFinite)
        || end <= start || width <= 0 || pixelsPerSecond <= 0
    ) return [];
    const startTime = Math.max(0, start);
    const endX = Math.min(width, (end - startTime) * pixelsPerSecond);
    if (endX <= 0) return [];
    const minimum = Math.max(80 / pixelsPerSecond, 10 ** -fixed);
    const magnitude = 10 ** Math.floor(Math.log10(minimum));
    const step = [1, 2, 5, 10].map((value) => value * magnitude).find((value) => value >= minimum)!;
    const ticks: TimeRulerTick[] = [{ time: startTime, x: 0, edge: "start" }];
    const first = Math.ceil(startTime / step);
    const last = Math.floor(end / step);
    for (let index = first; index <= last && ticks.length < 100; index++) {
        const time = Math.round(index * step * 1000) / 1000;
        const x = (time - startTime) * pixelsPerSecond;
        if (x >= 80 && endX - x >= 80) ticks.push({ time, x });
    }
    if (endX >= 120) ticks.push({ time: end, x: endX, edge: "end" });
    return ticks;
};
