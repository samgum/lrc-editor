import { useLayoutEffect } from "react";

export const WorkspaceScroll: React.FC<{ path: string; positions: Map<string, number> }> = ({ path, positions }) => {
    useLayoutEffect(() => {
        window.scrollTo({ top: positions.get(path) ?? 0, left: 0, behavior: "instant" });
    }, [path, positions]);
    return null;
};
