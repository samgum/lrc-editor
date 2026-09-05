import { useEffect, useState } from "react";

export const useMediaQuery = (queryText: string): boolean => {
    const [matches, setMatches] = useState(() => matchMedia(queryText).matches);
    useEffect(() => {
        const query = matchMedia(queryText);
        const update = () => setMatches(query.matches);
        query.addEventListener("change", update);
        update();
        return () => query.removeEventListener("change", update);
    }, [queryText]);
    return matches;
};
