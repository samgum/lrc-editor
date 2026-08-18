export interface FollowViewport {
    lineTop: number;
    lineHeight: number;
    safeTop: number;
    safeBottom: number;
}

export const centeredFollowOffset = ({ lineTop, lineHeight, safeTop, safeBottom }: FollowViewport): number => {
    const safeHeight = safeBottom - safeTop;
    if (![lineTop, lineHeight, safeTop, safeBottom].every(Number.isFinite) || lineHeight <= 0 || safeHeight <= 0) {
        return 0;
    }
    const targetTop = safeTop + (safeHeight - lineHeight) / 2;
    const offset = lineTop - targetTop;
    return Math.abs(offset) < 1 ? 0 : offset;
};

export const followEndSpace = (safeTop: number, safeBottom: number): number =>
    Math.max(80, Math.round(Math.max(0, safeBottom - safeTop) / 2));
