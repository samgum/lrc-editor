import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { parser, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Action, IState } from "../hooks/useLrc.js";
import { ActionType } from "../hooks/useLrc.js";
import {
    type AdvancedLyricsDocument,
    decodeTextBytes,
    exportLineLyrics,
    type LineLyricExportFormat,
    type LyricFormat,
    parseLyricBytes,
    toEnhancedLrc,
    toLineLrc,
    toLineTimedDocument,
} from "../utils/advanced-lyrics.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import {
    alignOverwriteTextToSource,
    cleanGeniusTracklist,
    convertLyricsCase,
    type DuplicateTimestampStrategy,
    type InterleavedOverwriteResult,
    interleaveOverwriteLyrics,
    type LyricsCaseMode,
    type OverwriteFallbackMode,
    type OverwriteOutputMode,
    removeEmptyLines,
    removeTags,
    repairTimeline,
    replaceText,
    type SplitTranslationTarget,
    splitTranslationWithStats,
    stripGeniusSections,
    stripTimestampsFromText,
    transformTimes,
} from "../utils/lrc-tools.js";
import { appContext } from "./app.context.js";
import { StyledSelect } from "./styled-select.js";
import { CheckSVG, CopySVG, DownloadSVG, OpenFileSVG } from "./svg.js";
import { toastPubSub } from "./toast.js";

type Tool =
    | "overwrite"
    | "timeline-fix"
    | "time"
    | "split"
    | "convert"
    | "remove-tags"
    | "remove-empty"
    | "sections"
    | "tracklist"
    | "replace"
    | "case";

type StandaloneTool = "convert" | "sections" | "tracklist" | "replace" | "case";

const allToolIds = new Set<Tool>([
    "overwrite",
    "timeline-fix",
    "time",
    "split",
    "convert",
    "remove-tags",
    "remove-empty",
    "sections",
    "tracklist",
    "replace",
    "case",
]);

const standaloneTools = new Set<Tool>(["convert", "sections", "tracklist", "replace", "case"]);
const isStandaloneTool = (tool: Tool): tool is StandaloneTool => standaloneTools.has(tool);

const splitPatterns = [
    { label: "歌词 / 翻译", value: "(.+?)\\s*/\\s*(.+)" },
    { label: "歌词 \\ 翻译", value: "(.+?)\\s*\\\\\\s*(.+)" },
    { label: "歌词 | 翻译", value: "(.+?)\\s*\\|\\s*(.+)" },
    { label: "歌词 「翻译」", value: "(.+?)\\s*「(.+)」" },
    { label: "歌词 『翻译』", value: "(.+?)\\s*『(.+)』" },
    { label: "歌词 【翻译】", value: "(.+?)\\s*【(.+)】" },
    { label: "歌词 〖翻译〗", value: "(.+?)\\s*〖(.+)〗" },
    { label: "模糊匹配", value: "(.+?)\\s*(?:[/\\\\|]|[「『【〖])([^」』】〗]+)" },
] as const;

const inlineBilingualTemplates = [
    { value: "%orig / %trans", example: "A / B" },
    { value: "%orig 「%trans」", example: "A 「B」" },
    { value: "%orig 【%trans】", example: "A 【B】" },
    { value: "%orig | %trans", example: "A | B" },
    { value: "%orig (%trans)", example: "A (B)" },
] as const;

const timeQuickOffsets = [-1000, -500, -100, 100, 500, 1000] as const;

const OVERWRITE_ROW_HEIGHT = 46;
const OVERWRITE_PAD_TOP = 16;
const OVERWRITE_PAD_X = 16;
const OVERWRITE_PAD_BOTTOM = 220;
const OVERWRITE_OVERLAY_OFFSET_Y = 20;

export const Tools: React.FC<{
    state: IState;
    dispatch: React.Dispatch<Action>;
    advancedDocument: AdvancedLyricsDocument | null;
    onTextApplied: (text: string) => void;
    onConversionApplied: (document: AdvancedLyricsDocument) => void;
}> = ({ state, dispatch, advancedDocument, onTextApplied, onConversionApplied }) => {
    const { lang, prefState, trimOptions } = useContext(appContext);
    const serialized = useMemo(() => stringify(state, prefState), [prefState, state]);
    const converterInitialSource = useMemo(
        () => advancedDocument ? toEnhancedLrc(advancedDocument, prefState.fixed) : serialized,
        [advancedDocument, prefState.fixed, serialized],
    );
    const [source, setSource] = useState(serialized);
    const [tool, setTool] = useState<Tool>(() => {
        const requested = sessionStorage.getItem(SSK.initialTool) as Tool | null;
        if (requested && allToolIds.has(requested)) {
            sessionStorage.removeItem(SSK.initialTool);
            return requested;
        }
        return "overwrite";
    });

    // Overwrite state (歌词滚动姬-style interleaved overlay)
    const [overwriteMode, setOverwriteMode] = useState<OverwriteOutputMode>("replace");
    const [inlineTemplate, setInlineTemplate] = useState<string>(inlineBilingualTemplates[0].value);
    const [overwriteFallback, setOverwriteFallback] = useState<OverwriteFallbackMode>("empty");
    const [editSourceMode, setEditSourceMode] = useState(false);
    const [timePaddingWidth, setTimePaddingWidth] = useState(0);
    const [replacement, setReplacement] = useState(() => sessionStorage.getItem(SSK.overwriteText) || "");

    // Time transform state
    const [multiplier, setMultiplier] = useState("1");
    const [constantMs, setConstantMs] = useState("0");
    const [startFromSec, setStartFromSec] = useState("0");

    // Split translation state
    const [splitPattern, setSplitPattern] = useState<string>(splitPatterns[0].value);
    const [customPattern, setCustomPattern] = useState("");
    const [splitTarget, setSplitTarget] = useState<SplitTranslationTarget>("both");

    // Timeline repair state
    const [expandMulti, setExpandMulti] = useState(true);
    const [sortChrono, setSortChrono] = useState(true);
    const [dupStrategy, setDupStrategy] = useState<DuplicateTimestampStrategy>("dedupe-exact");
    const [trimTimelineSpaces, setTrimTimelineSpaces] = useState(true);

    // Standalone tools state
    const [standaloneSources, setStandaloneSources] = useState<Record<StandaloneTool, string>>(() => ({
        convert: converterInitialSource,
        sections: serialized,
        tracklist: "",
        replace: serialized,
        case: serialized,
    }));
    const [strictSections, setStrictSections] = useState(true);
    const [dropSectionEmpty, setDropSectionEmpty] = useState(false);
    const [dropSuggestions, setDropSuggestions] = useState(true);
    const [keepAlbumTitle, setKeepAlbumTitle] = useState(false);
    const [stripFeatured, setStripFeatured] = useState(true);
    const [findText, setFindText] = useState("");
    const [replacementText, setReplacementText] = useState("");
    const [regexMode, setRegexMode] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [caseMode, setCaseMode] = useState<LyricsCaseMode>("sentence");
    const [capitalizeLineStart, setCapitalizeLineStart] = useState(true);
    const [fixPronoun, setFixPronoun] = useState(true);
    const [conversionFormat, setConversionFormat] = useState<LineLyricExportFormat>("lrc");
    const [conversionLoadedFormat, setConversionLoadedFormat] = useState<LyricFormat | null>(null);

    const sourceRef = useRef<HTMLTextAreaElement>(null);
    const underlayRef = useRef<HTMLTextAreaElement>(null);
    const translationRef = useRef<HTMLTextAreaElement>(null);
    const outputRef = useRef<HTMLTextAreaElement>(null);
    const timePaddingRef = useRef<HTMLSpanElement>(null);
    const [output, setOutput] = useState("");

    useEffect(() => {
        setSource(serialized);
    }, [serialized]);

    useEffect(() => sessionStorage.setItem(SSK.overwriteText, replacement), [replacement]);

    const activeSource = isStandaloneTool(tool) ? standaloneSources[tool] : source;

    const updateActiveSource = useCallback((value: string) => {
        if (isStandaloneTool(tool)) {
            setStandaloneSources((current) => ({ ...current, [tool]: value }));
            if (tool === "convert") setConversionLoadedFormat(null);
        } else {
            setSource(value);
        }
    }, [tool]);

    const syncSourceFromEditor = useCallback(() => {
        if (isStandaloneTool(tool)) {
            const next = tool === "convert" ? converterInitialSource : serialized;
            setStandaloneSources((current) => ({ ...current, [tool]: next }));
            if (tool === "convert") setConversionLoadedFormat(null);
        } else {
            setSource(serialized);
            setEditSourceMode(false);
        }
        toastPubSub.pub({ type: "info", text: lang.tools.lyricFileLoaded });
    }, [converterInitialSource, lang.tools.lyricFileLoaded, serialized, tool]);

    const onConversionFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const document = parseLyricBytes(file.name, bytes);
            const isKrc = /\.krc$/iu.test(file.name) || new TextDecoder().decode(bytes.subarray(0, 4)) === "krc1";
            const text = isKrc ? toEnhancedLrc(document, prefState.fixed) : decodeTextBytes(bytes);
            if (tool === "convert") {
                setStandaloneSources((current) => ({ ...current, convert: text }));
                setConversionLoadedFormat(document.sourceFormat);
            } else {
                const lineText = toLineLrc(toLineTimedDocument(document), prefState.fixed);
                setSource(lineText);
                setEditSourceMode(false);
            }
            toastPubSub.pub({ type: "success", text: lang.tools.lyricFileLoaded });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.tools.formatConversionFailed });
        } finally {
            event.target.value = "";
        }
    }, [lang.tools, prefState.fixed, tool]);

    const onReplacementFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            setReplacement(decodeTextBytes(bytes));
            toastPubSub.pub({ type: "success", text: lang.tools.lyricFileLoaded });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.tools.formatConversionFailed });
        } finally {
            event.target.value = "";
        }
    }, [lang.tools]);

    const parsedOverwriteSource = useMemo(() => parser(source, trimOptions), [source, trimOptions]);

    const hasOverwriteSourceLyrics = useMemo(
        () =>
            parsedOverwriteSource.info.size > 0
            || parsedOverwriteSource.lyric.some((line) => line.time !== undefined || line.text.trim() !== ""),
        [parsedOverwriteSource],
    );

    const normalizedOverwriteSource = useMemo(
        () => stringify(parsedOverwriteSource, prefState),
        [parsedOverwriteSource, prefState],
    );

    const sampleTimeTag = useMemo(() => {
        let maxTime: number | undefined;
        for (const line of parsedOverwriteSource.lyric) {
            if (line.time !== undefined && (maxTime === undefined || line.time > maxTime)) {
                maxTime = line.time;
            }
        }
        if (maxTime === undefined) return "";
        return stringify(
            { info: new Map(), lyric: [{ time: maxTime, text: "" }] },
            { fixed: prefState.fixed, spaceStart: prefState.spaceStart, spaceEnd: 0 },
        );
    }, [parsedOverwriteSource.lyric, prefState.fixed, prefState.spaceStart]);

    useLayoutEffect(() => {
        if (tool !== "overwrite" || editSourceMode) return;
        const el = timePaddingRef.current;
        if (!el || !sampleTimeTag) {
            setTimePaddingWidth(0);
            return;
        }
        const measure = () => {
            setTimePaddingWidth(Math.round(el.getBoundingClientRect().width * 100) / 100);
        };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        if (observer) observer.observe(el);
        void document.fonts?.ready?.then(measure);
        return () => observer?.disconnect();
    }, [editSourceMode, sampleTimeTag, tool]);

    const overwriteResult = useMemo<InterleavedOverwriteResult | null>(() => {
        if (tool !== "overwrite") return null;
        return interleaveOverwriteLyrics(parsedOverwriteSource, replacement, prefState, {
            outputMode: overwriteMode,
            inlineTemplate,
            unmatchedFallback: overwriteFallback,
        });
    }, [inlineTemplate, overwriteFallback, overwriteMode, parsedOverwriteSource, prefState, replacement, tool]);

    const transformed = useMemo<{
        text: string;
        error?: string;
        sourceFormat?: string;
        lineCount?: number;
        segmentCount?: number;
        statusBadge?: string;
    }>(() => {
        try {
            if (tool === "overwrite") {
                return { text: overwriteResult?.text ?? "" };
            }
            if (tool === "timeline-fix") {
                const result = repairTimeline(source, prefState, {
                    expandMultiTimestamps: expandMulti,
                    sortChronologically: sortChrono,
                    duplicateStrategy: dupStrategy,
                    trimSpaces: trimTimelineSpaces,
                });
                return {
                    text: result.text,
                    statusBadge: lang.tools.timelineStats
                        .replace("%expanded", String(result.expandedCount))
                        .replace("%reordered", String(result.reorderedCount))
                        .replace("%deduped", String(result.duplicateResolvedCount)),
                };
            }
            if (tool === "convert") {
                const document = parseLyricBytes("pasted.txt", new TextEncoder().encode(activeSource));
                const segmentCount = document.lines.reduce(
                    (total, line) => total + line.words.filter((word) => word.startMs !== undefined).length,
                    0,
                );
                return {
                    text: exportLineLyrics(document, conversionFormat, prefState.fixed),
                    sourceFormat: conversionLoadedFormat ?? document.sourceFormat,
                    lineCount: document.lines.length,
                    segmentCount,
                };
            }
            if (tool === "sections") {
                const result = stripGeniusSections(activeSource, {
                    strictMode: strictSections,
                    dropEmpty: dropSectionEmpty,
                    dropSuggestions,
                });
                return {
                    text: result.text,
                    statusBadge: lang.tools.sectionsStats
                        .replace("%removed", String(result.removed.length))
                        .replace("%blank", String(result.blankRemoved)),
                };
            }
            if (tool === "tracklist") {
                const result = cleanGeniusTracklist(activeSource, {
                    keepTitle: keepAlbumTitle,
                    stripFeatured,
                });
                return {
                    text: result.text,
                    statusBadge: lang.tools.tracklistStats
                        .replace("%tracks", String(result.tracks))
                        .replace("%ignored", String(result.ignored)),
                };
            }
            if (tool === "replace") {
                const result = replaceText(activeSource, {
                    find: findText,
                    replacement: replacementText,
                    regex: regexMode,
                    caseSensitive,
                });
                return {
                    text: result.text,
                    error: result.error ? lang.tools.invalidRegex : undefined,
                    statusBadge: findText.trim()
                        ? lang.tools.replaceStats.replace("%s", String(result.count))
                        : undefined,
                };
            }
            if (tool === "case") {
                return {
                    text: convertLyricsCase(activeSource, caseMode, capitalizeLineStart, fixPronoun),
                };
            }
            const parsed = parser(source, trimOptions);
            switch (tool) {
                case "remove-tags":
                    return { text: removeTags(parsed, prefState) };
                case "remove-empty":
                    return { text: removeEmptyLines(parsed, prefState) };
                case "time": {
                    const startSec = Number.parseFloat(startFromSec);
                    return {
                        text: transformTimes(
                            parsed,
                            Number.parseFloat(multiplier),
                            Number.parseFloat(constantMs),
                            prefState,
                            Number.isFinite(startSec) && startSec > 0 ? startSec : undefined,
                        ),
                    };
                }
                case "split": {
                    const expression = new RegExp(customPattern || splitPattern);
                    const splitResult = splitTranslationWithStats(parsed, expression, prefState, splitTarget);
                    return {
                        text: splitResult.text,
                        statusBadge: lang.tools.splitMatchedCount.replace("%s", String(splitResult.matchedCount)),
                    };
                }
            }
        } catch {
            return {
                text: "",
                error: tool === "convert" ? lang.tools.formatConversionFailed : lang.tools.invalidRegex,
            };
        }
    }, [
        activeSource,
        capitalizeLineStart,
        caseMode,
        caseSensitive,
        constantMs,
        conversionFormat,
        conversionLoadedFormat,
        customPattern,
        dropSectionEmpty,
        dropSuggestions,
        dupStrategy,
        expandMulti,
        findText,
        fixPronoun,
        keepAlbumTitle,
        lang.tools,
        multiplier,
        overwriteResult,
        prefState,
        regexMode,
        replacementText,
        sortChrono,
        source,
        splitPattern,
        splitTarget,
        startFromSec,
        strictSections,
        stripFeatured,
        tool,
        trimOptions,
        trimTimelineSpaces,
    ]);

    useLayoutEffect(() => setOutput(transformed.text), [tool, transformed.text]);

    const pasteFromClipboard = useCallback(async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                setReplacement(text);
            }
        } catch {
            translationRef.current?.focus();
        }
    }, []);

    const handleAutoAlignBlanks = useCallback(() => {
        if (!replacement.trim() || !hasOverwriteSourceLyrics) return;
        setReplacement(alignOverwriteTextToSource(parsedOverwriteSource, replacement));
    }, [hasOverwriteSourceLyrics, parsedOverwriteSource, replacement]);

    const handleFillOriginalLyrics = useCallback(() => {
        if (!hasOverwriteSourceLyrics) return;
        setReplacement(parsedOverwriteSource.lyric.map((line) => line.text).join("\n"));
        setEditSourceMode(false);
    }, [hasOverwriteSourceLyrics, parsedOverwriteSource.lyric]);

    const hasTagsInReplacement = useMemo(
        () =>
            /\[\s*(?:(?:\d{1,3}:)?\d{1,2}:\d{2}|(?:ti|title|ar|artist|al|album|au|author|by|offset|length|re|ve|tool):)|<(?:\d{1,3}:)?\d{1,2}:\d{2}/i
                .test(replacement),
        [replacement],
    );

    const handleStripTimestamps = useCallback(() => {
        if (!replacement.trim()) return;
        setReplacement(stripTimestampsFromText(replacement));
    }, [replacement]);

    const canApplyToEditor = !transformed.error && !(tool === "split" && splitTarget === "both");

    const applyResult = useCallback(() => {
        if (!canApplyToEditor) {
            return;
        }
        let editorText = output;
        if (tool === "convert") {
            try {
                const extension = conversionFormat === "txt" ? "txt" : conversionFormat;
                const parsed = parseLyricBytes(`converted.${extension}`, new TextEncoder().encode(output));
                const lineDocument = toLineTimedDocument(parsed);
                editorText = toLineLrc(lineDocument, prefState.fixed);
                onConversionApplied(lineDocument);
            } catch {
                toastPubSub.pub({ type: "warning", text: lang.tools.formatConversionFailed });
                return;
            }
        } else {
            onTextApplied(editorText);
        }
        dispatch({ type: ActionType.parse, payload: { text: editorText, options: trimOptions } });
        updateActiveSource(tool === "convert" ? editorText : output);
        toastPubSub.pub({ type: "success", text: lang.notify.resultApplied });
        location.hash = ROUTER.editor;
    }, [
        canApplyToEditor,
        conversionFormat,
        dispatch,
        lang.notify.resultApplied,
        lang.tools.formatConversionFailed,
        onConversionApplied,
        onTextApplied,
        output,
        prefState.fixed,
        tool,
        trimOptions,
        updateActiveSource,
    ]);

    const copyResult = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(output);
        } catch {
            outputRef.current?.select();
            document.execCommand("copy");
        }
        toastPubSub.pub({ type: "success", text: lang.notify.copied });
    }, [lang.notify.copied, output]);

    const downloadExtension = tool === "convert"
        ? { lrc: ".lrc", srt: ".srt", ttml: ".ttml", txt: ".txt" }[conversionFormat]
        : tool === "tracklist"
        ? ".txt"
        : ".lrc";

    const downloadResult = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (transformed.error) return;
        const url = URL.createObjectURL(new Blob([output], { type: "text/plain;charset=UTF-8" }));
        const link = document.createElement("a");
        link.hidden = true;
        link.href = url;
        link.download = lrcFileName(state.info, downloadExtension);
        document.body.append(link);
        link.click();
        setTimeout(() => {
            link.remove();
            URL.revokeObjectURL(url);
        }, 1000);
    }, [downloadExtension, output, state.info, transformed.error]);

    const syncScroll = useCallback((origin: HTMLTextAreaElement, targets: Array<HTMLTextAreaElement | null>) => {
        for (const target of targets) {
            if (!target || target === origin) continue;
            if (Math.abs(target.scrollTop - origin.scrollTop) > 1) target.scrollTop = origin.scrollTop;
            if (Math.abs(target.scrollLeft - origin.scrollLeft) > 1) target.scrollLeft = origin.scrollLeft;
        }
    }, []);

    const adjustConstantOffset = useCallback((deltaMs: number) => {
        setConstantMs((prev) => {
            const current = Number.parseFloat(prev);
            const base = Number.isFinite(current) ? current : 0;
            return String(Math.round(base + deltaMs));
        });
    }, []);

    const toolButtons: Array<{ id: Tool; label: string }> = [
        { id: "overwrite", label: lang.tools.overwrite },
        { id: "timeline-fix", label: lang.tools.timelineFix },
        { id: "time", label: lang.tools.changeOffset },
        { id: "split", label: lang.tools.splitTranslation },
        { id: "convert", label: lang.tools.formatConverter },
        { id: "remove-tags", label: lang.tools.removeTags },
        { id: "remove-empty", label: lang.tools.removeEmpty },
        { id: "sections", label: lang.tools.sections },
        { id: "tracklist", label: lang.tools.tracklist },
        { id: "replace", label: lang.tools.replaceText },
        { id: "case", label: lang.tools.caseConverter },
    ];

    const infoLineCount = parsedOverwriteSource.info.size;
    const targetLineCount = hasOverwriteSourceLyrics ? parsedOverwriteSource.lyric.length : 0;
    const overlayLineCount = useMemo(
        () => Math.max(1, replacement.replace(/\r\n?/g, "\n").split("\n").length),
        [replacement],
    );
    const totalVisualRows = Math.max(1, targetLineCount, overlayLineCount);
    const underlayLineCount = Math.max(1, infoLineCount + Math.max(1, parsedOverwriteSource.lyric.length));
    const underlayPaddingBottom = OVERWRITE_PAD_BOTTOM
        + Math.max(0, infoLineCount + totalVisualRows - underlayLineCount) * OVERWRITE_ROW_HEIGHT;
    const overlayPaddingTop = OVERWRITE_PAD_TOP
        + infoLineCount * OVERWRITE_ROW_HEIGHT
        + OVERWRITE_OVERLAY_OFFSET_Y;
    const overlayPaddingBottom = (OVERWRITE_PAD_BOTTOM - OVERWRITE_OVERLAY_OFFSET_Y)
        + Math.max(0, totalVisualRows - overlayLineCount) * OVERWRITE_ROW_HEIGHT;
    const outputLineCount = useMemo(
        () => Math.max(1, output.replace(/\r\n?/g, "\n").split("\n").length),
        [output],
    );
    const outputPaddingBottom = overwriteMode === "dual-line"
        ? 120
        : OVERWRITE_PAD_BOTTOM
            + Math.max(0, infoLineCount + totalVisualRows - outputLineCount) * OVERWRITE_ROW_HEIGHT;

    const overwriteBadgeInfo = useMemo(() => {
        if (!overwriteResult || !hasOverwriteSourceLyrics) return null;
        const { filledCount, targetCount, extraCount } = overwriteResult;
        const base = lang.tools.overwriteProgressBadge
            .replace("%filled", String(filledCount))
            .replace("%total", String(targetCount));
        return {
            matched: filledCount === targetCount && extraCount === 0 && targetCount > 0,
            text: extraCount > 0 ? `${base} (+${extraCount})` : base,
        };
    }, [hasOverwriteSourceLyrics, lang.tools.overwriteProgressBadge, overwriteResult]);

    return (
        <section className="tools-page">
            <header className="tools-heading">
                <h1>{lang.tools.title}</h1>
                <nav className="tools-tabs" aria-label={lang.tools.title}>
                    {toolButtons.map((item) => (
                        <button
                            type="button"
                            key={item.id}
                            aria-pressed={tool === item.id}
                            onClick={() => setTool(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
            </header>

            <div className="tools-options">
                {tool === "overwrite" && (
                    <>
                        <label>
                            <span>{lang.tools.overwriteMode}</span>
                            <StyledSelect
                                value={overwriteMode}
                                onValueChange={(val) => setOverwriteMode(val as OverwriteOutputMode)}
                                label={lang.tools.overwriteMode}
                                options={[
                                    { value: "replace", label: lang.tools.overwriteModeReplace },
                                    { value: "inline", label: lang.tools.overwriteModeInline },
                                    { value: "dual-line", label: lang.tools.overwriteModeDual },
                                ]}
                            />
                        </label>

                        {overwriteMode === "inline" && (
                            <label>
                                <span>{lang.tools.overwriteSeparator}</span>
                                <StyledSelect
                                    value={inlineTemplate}
                                    onValueChange={setInlineTemplate}
                                    label={lang.tools.overwriteSeparator}
                                    options={inlineBilingualTemplates.map((item) => ({
                                        value: item.value,
                                        label: item.example,
                                    }))}
                                />
                            </label>
                        )}

                        {overwriteMode === "replace" && (
                            <label>
                                <span>{lang.tools.overwriteFallback}</span>
                                <StyledSelect
                                    value={overwriteFallback}
                                    onValueChange={(val) => setOverwriteFallback(val as OverwriteFallbackMode)}
                                    label={lang.tools.overwriteFallback}
                                    options={[
                                        { value: "empty", label: lang.tools.overwriteFallbackEmpty },
                                        { value: "keep", label: lang.tools.overwriteFallbackKeep },
                                    ]}
                                />
                            </label>
                        )}

                        <label className="tools-file-button">
                            <input
                                hidden={true}
                                type="file"
                                accept="text/*,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                                onChange={(event) => void onConversionFile(event)}
                            />
                            <OpenFileSVG />
                            <span>{lang.tools.loadLyricFile}</span>
                        </label>

                        <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                            {lang.tools.overwriteSyncEditor}
                        </button>

                        <button
                            type="button"
                            className={`tools-ghost-button${editSourceMode ? " is-active" : ""}`}
                            aria-pressed={editSourceMode}
                            onClick={() => {
                                const next = !editSourceMode;
                                setEditSourceMode(next);
                                requestAnimationFrame(() => {
                                    if (next) underlayRef.current?.focus();
                                    else translationRef.current?.focus();
                                });
                            }}
                        >
                            {editSourceMode ? lang.tools.overwriteDoneEditSource : lang.tools.overwriteEditSource}
                        </button>

                        {overwriteBadgeInfo && (
                            <output
                                className={`tools-format-status${overwriteBadgeInfo.matched ? " is-matched" : ""}`}
                                aria-live="polite"
                            >
                                {overwriteBadgeInfo.matched && <CheckSVG />}
                                <strong>{overwriteBadgeInfo.text}</strong>
                            </output>
                        )}
                    </>
                )}

                {tool === "timeline-fix" && (
                    <>
                        <ToggleOption
                            label={lang.tools.timelineExpandMulti}
                            checked={expandMulti}
                            onChange={setExpandMulti}
                        />
                        <ToggleOption
                            label={lang.tools.timelineSort}
                            checked={sortChrono}
                            onChange={setSortChrono}
                        />
                        <ToggleOption
                            label={lang.tools.timelineTrimSpaces}
                            checked={trimTimelineSpaces}
                            onChange={setTrimTimelineSpaces}
                        />
                        <label>
                            <span>{lang.tools.timelineDuplicates}</span>
                            <StyledSelect
                                value={dupStrategy}
                                onValueChange={(val) => setDupStrategy(val as DuplicateTimestampStrategy)}
                                label={lang.tools.timelineDuplicates}
                                options={[
                                    { value: "dedupe-exact", label: lang.tools.timelineDupDedupe },
                                    { value: "merge-inline", label: lang.tools.timelineDupMerge },
                                    { value: "nudge", label: lang.tools.timelineDupNudge },
                                    { value: "keep", label: lang.tools.timelineDupKeep },
                                ]}
                            />
                        </label>
                    </>
                )}

                {tool === "convert" && (
                    <>
                        <label className="tools-file-button">
                            <input
                                hidden={true}
                                type="file"
                                accept="text/*,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                                onChange={(event) => void onConversionFile(event)}
                            />
                            <OpenFileSVG />
                            <span>{lang.tools.loadLyricFile}</span>
                        </label>
                        <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                            {lang.tools.overwriteSyncEditor}
                        </button>
                        <label>
                            <span>{lang.tools.converterOutputFormat}</span>
                            <StyledSelect
                                value={conversionFormat}
                                onValueChange={(value) => setConversionFormat(value as LineLyricExportFormat)}
                                label={lang.tools.converterOutputFormat}
                                options={[
                                    { value: "lrc", label: lang.advancedLyrics.standardLrc },
                                    { value: "srt", label: "SRT" },
                                    { value: "ttml", label: lang.tools.lineTtml },
                                    { value: "txt", label: lang.tools.plainText },
                                ]}
                            />
                        </label>
                        {transformed.sourceFormat && (
                            <output className="tools-format-status" aria-live="polite">
                                <strong>{lang.tools.detectedFormat}: {transformed.sourceFormat.toUpperCase()}</strong>
                                <span>{transformed.lineCount} {lang.tools.lines}</span>
                                <span>{transformed.segmentCount} {lang.tools.timedSegments}</span>
                            </output>
                        )}
                    </>
                )}

                {tool === "time" && (
                    <>
                        <label>
                            <span>{lang.tools.multiplier}</span>
                            <input
                                type="number"
                                step="0.01"
                                value={multiplier}
                                onChange={(ev) => setMultiplier(ev.target.value)}
                            />
                        </label>
                        <label>
                            <span>{lang.tools.constantMs}</span>
                            <input
                                type="number"
                                step="10"
                                value={constantMs}
                                onChange={(ev) => setConstantMs(ev.target.value)}
                            />
                        </label>
                        <label>
                            <span>{lang.tools.timeStartFromSec}</span>
                            <input
                                type="number"
                                min="0"
                                step="0.5"
                                value={startFromSec}
                                onChange={(ev) => setStartFromSec(ev.target.value)}
                            />
                        </label>
                        <div className="tools-quick-pills" role="group" aria-label={lang.tools.offsetMs}>
                            {timeQuickOffsets.map((delta) => (
                                <button
                                    key={delta}
                                    type="button"
                                    className="tools-pill-button"
                                    onClick={() => adjustConstantOffset(delta)}
                                >
                                    {delta > 0 ? `+${delta}ms` : `${delta}ms`}
                                </button>
                            ))}
                            <button
                                type="button"
                                className="tools-pill-button is-reset"
                                onClick={() => {
                                    setMultiplier("1");
                                    setConstantMs("0");
                                    setStartFromSec("0");
                                }}
                            >
                                {lang.tools.timeReset}
                            </button>
                        </div>
                    </>
                )}

                {tool === "split" && (
                    <>
                        <label>
                            <span>{lang.tools.splitPattern}</span>
                            <StyledSelect
                                value={splitPattern}
                                onValueChange={setSplitPattern}
                                label={lang.tools.splitPattern}
                                options={splitPatterns.map((pattern) => ({
                                    value: pattern.value,
                                    label: pattern.label === "模糊匹配"
                                        ? lang.visual.flexibleMatch
                                        : pattern.label.replace("歌词", lang.visual.lyricEditor)
                                            .replace("翻译", lang.tools.translation),
                                }))}
                            />
                        </label>
                        <label>
                            <span>{lang.tools.splitOutputTarget}</span>
                            <StyledSelect
                                value={splitTarget}
                                onValueChange={(val) => setSplitTarget(val as SplitTranslationTarget)}
                                label={lang.tools.splitOutputTarget}
                                options={[
                                    { value: "both", label: lang.tools.splitTargetBoth },
                                    { value: "original", label: lang.tools.splitTargetOriginal },
                                    { value: "translation", label: lang.tools.splitTargetTranslation },
                                ]}
                            />
                        </label>
                        <label className="tools-custom-regex">
                            <span>{lang.tools.customRegex}</span>
                            <input value={customPattern} onChange={(ev) => setCustomPattern(ev.target.value)} />
                        </label>
                    </>
                )}

                {tool === "sections" && (
                    <>
                        <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                            {lang.tools.overwriteSyncEditor}
                        </button>
                        <ToggleOption
                            label={lang.tools.strictSections}
                            checked={strictSections}
                            onChange={setStrictSections}
                        />
                        <ToggleOption
                            label={lang.tools.dropEmpty}
                            checked={dropSectionEmpty}
                            onChange={setDropSectionEmpty}
                        />
                        <ToggleOption
                            label={lang.tools.dropSuggestions}
                            checked={dropSuggestions}
                            onChange={setDropSuggestions}
                        />
                    </>
                )}

                {tool === "tracklist" && (
                    <>
                        <ToggleOption
                            label={lang.tools.keepAlbumTitle}
                            checked={keepAlbumTitle}
                            onChange={setKeepAlbumTitle}
                        />
                        <ToggleOption
                            label={lang.tools.stripFeatured}
                            checked={stripFeatured}
                            onChange={setStripFeatured}
                        />
                    </>
                )}

                {tool === "replace" && (
                    <>
                        <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                            {lang.tools.overwriteSyncEditor}
                        </button>
                        <label>
                            <span>{lang.tools.find}</span>
                            <input value={findText} onChange={(ev) => setFindText(ev.target.value)} />
                        </label>
                        <label>
                            <span>{lang.tools.replaceWith}</span>
                            <input value={replacementText} onChange={(ev) => setReplacementText(ev.target.value)} />
                        </label>
                        <ToggleOption label={lang.tools.regexMode} checked={regexMode} onChange={setRegexMode} />
                        <ToggleOption
                            label={lang.tools.caseSensitive}
                            checked={caseSensitive}
                            onChange={setCaseSensitive}
                        />
                    </>
                )}

                {tool === "case" && (
                    <>
                        <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                            {lang.tools.overwriteSyncEditor}
                        </button>
                        <label>
                            <span>{lang.tools.caseMode}</span>
                            <StyledSelect
                                value={caseMode}
                                onValueChange={(value) => setCaseMode(value as LyricsCaseMode)}
                                label={lang.tools.caseMode}
                                options={[
                                    { value: "sentence", label: lang.tools.sentenceCase },
                                    { value: "upper", label: lang.tools.upperCase },
                                    { value: "lower", label: lang.tools.lowerCase },
                                    { value: "words", label: lang.tools.wordCase },
                                    { value: "title", label: lang.tools.titleCase },
                                ]}
                            />
                        </label>
                        <ToggleOption
                            label={lang.tools.capitalizeLineStart}
                            checked={capitalizeLineStart}
                            onChange={setCapitalizeLineStart}
                        />
                        <ToggleOption label={lang.tools.fixPronounI} checked={fixPronoun} onChange={setFixPronoun} />
                    </>
                )}

                {transformed.statusBadge && (
                    <output className="tools-format-status" aria-live="polite">
                        <strong>{transformed.statusBadge}</strong>
                    </output>
                )}
            </div>

            {tool === "overwrite" && (
                <div className="overwrite-dual-editors">
                    <section className="overwrite-stage-card">
                        <header className="overwrite-pane-header">
                            <div className="overwrite-pane-title">
                                <strong>{editSourceMode ? lang.tools.source : lang.tools.overwriteOverlayTitle}</strong>
                            </div>
                            <div className="overwrite-pane-actions">
                                {editSourceMode
                                    ? (
                                        <button
                                            type="button"
                                            className="tools-mini-btn is-primary"
                                            onClick={() => {
                                                setEditSourceMode(false);
                                                requestAnimationFrame(() => translationRef.current?.focus());
                                            }}
                                        >
                                            {lang.tools.overwriteDoneEditSource}
                                        </button>
                                    )
                                    : (
                                        <>
                                            <button
                                                type="button"
                                                className="tools-mini-btn"
                                                disabled={!replacement.trim() || !hasOverwriteSourceLyrics}
                                                onClick={handleAutoAlignBlanks}
                                            >
                                                {lang.tools.overwriteAutoAlign}
                                            </button>
                                            <button
                                                type="button"
                                                className="tools-mini-btn"
                                                disabled={!hasOverwriteSourceLyrics}
                                                onClick={handleFillOriginalLyrics}
                                            >
                                                {lang.tools.overwriteUseOriginal}
                                            </button>
                                            {hasTagsInReplacement && (
                                                <button
                                                    type="button"
                                                    className="tools-mini-btn"
                                                    onClick={handleStripTimestamps}
                                                >
                                                    {lang.tools.overwriteStripTags}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                className="tools-mini-btn"
                                                onClick={() => void pasteFromClipboard()}
                                            >
                                                {lang.tools.overwritePasteClipboard}
                                            </button>
                                            <label className="tools-mini-btn">
                                                <input
                                                    hidden={true}
                                                    type="file"
                                                    accept="text/*,.txt,.lrc,.srt,.ttml"
                                                    onChange={(event) => void onReplacementFile(event)}
                                                />
                                                <span>{lang.tools.overwriteLoadReplacementFile}</span>
                                            </label>
                                            <button
                                                type="button"
                                                className="tools-mini-btn danger"
                                                disabled={!replacement}
                                                onClick={() => setReplacement("")}
                                            >
                                                {lang.tools.overwriteClearInput}
                                            </button>
                                        </>
                                    )}
                            </div>
                        </header>

                        <div className={`overwrite-stage${editSourceMode ? " is-editing-source" : ""}`}>
                            <textarea
                                ref={underlayRef}
                                className="overwrite-underlay"
                                value={editSourceMode ? source : normalizedOverwriteSource}
                                readOnly={!editSourceMode}
                                tabIndex={editSourceMode ? 0 : -1}
                                aria-hidden={!editSourceMode}
                                aria-label={lang.tools.source}
                                onChange={editSourceMode ? (ev) => setSource(ev.target.value) : undefined}
                                style={editSourceMode ? undefined : { paddingBottom: `${underlayPaddingBottom}px` }}
                                spellCheck={false}
                            />
                            {!editSourceMode && (
                                <textarea
                                    ref={translationRef}
                                    className="overwrite-overlay"
                                    value={replacement}
                                    placeholder={hasOverwriteSourceLyrics
                                        ? lang.tools.overwriteOverlayPlaceholder
                                        : undefined}
                                    aria-label={lang.tools.translation}
                                    onChange={(ev) => setReplacement(ev.target.value)}
                                    onScroll={(ev) =>
                                        syncScroll(ev.currentTarget, [
                                            underlayRef.current,
                                            overwriteMode === "dual-line" ? null : outputRef.current,
                                        ])}
                                    style={{
                                        paddingTop: `${overlayPaddingTop}px`,
                                        paddingBottom: `${overlayPaddingBottom}px`,
                                        paddingLeft: `${OVERWRITE_PAD_X + timePaddingWidth}px`,
                                        paddingRight: `${OVERWRITE_PAD_X}px`,
                                    }}
                                    spellCheck={false}
                                />
                            )}
                            <span ref={timePaddingRef} className="overwrite-time-padding" aria-hidden="true">
                                {sampleTimeTag}
                            </span>

                            {!hasOverwriteSourceLyrics && !editSourceMode && (
                                <div className="overwrite-empty-callout">
                                    <p>{lang.tools.overwriteEmptySourceGuide}</p>
                                    <div className="overwrite-empty-actions">
                                        <label className="button tools-action-secondary">
                                            <input
                                                hidden={true}
                                                type="file"
                                                accept="text/*,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                                                onChange={(event) => void onConversionFile(event)}
                                            />
                                            <OpenFileSVG />
                                            <span>{lang.tools.loadLyricFile}</span>
                                        </label>
                                        <button
                                            type="button"
                                            className="button tools-action-primary"
                                            onClick={() => {
                                                setEditSourceMode(true);
                                                requestAnimationFrame(() => underlayRef.current?.focus());
                                            }}
                                        >
                                            <span>{lang.tools.overwriteEditSource}</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>

                    <section className="overwrite-output-card">
                        <header className="overwrite-pane-header">
                            <div className="overwrite-pane-title">
                                <strong>{lang.tools.output}</strong>
                            </div>
                            {!editSourceMode && (
                                <small className="overwrite-pane-hint">{lang.tools.overwriteOverlayHint}</small>
                            )}
                        </header>
                        <textarea
                            ref={outputRef}
                            className={`overwrite-output${overwriteMode === "dual-line" ? " is-compact-lines" : ""}`}
                            value={output}
                            aria-label={lang.tools.output}
                            onChange={(ev) => setOutput(ev.target.value)}
                            onScroll={(ev) => {
                                if (overwriteMode !== "dual-line" && !editSourceMode) {
                                    syncScroll(ev.currentTarget, [translationRef.current, underlayRef.current]);
                                }
                            }}
                            style={{ paddingBottom: `${outputPaddingBottom}px` }}
                            spellCheck={false}
                        />
                    </section>
                </div>
            )}

            {tool !== "overwrite" && (
                <div className="tools-editors">
                    <label>
                        <span>{lang.tools.source}</span>
                        <textarea
                            ref={sourceRef}
                            value={activeSource}
                            placeholder={tool === "convert" ? lang.tools.converterSourcePlaceholder : undefined}
                            onChange={(ev) => updateActiveSource(ev.target.value)}
                            onScroll={(ev) => syncScroll(ev.currentTarget, [outputRef.current])}
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span>{lang.tools.output}</span>
                        <textarea
                            ref={outputRef}
                            value={output}
                            onChange={(ev) => setOutput(ev.target.value)}
                            spellCheck={false}
                            onScroll={(ev) => syncScroll(ev.currentTarget, [sourceRef.current])}
                        />
                    </label>
                </div>
            )}

            {transformed.error && <p className="tools-error" role="alert">{transformed.error}</p>}

            <footer className="tools-actions">
                <button
                    className="button tools-action-primary"
                    type="button"
                    onClick={applyResult}
                    disabled={!canApplyToEditor}
                >
                    <CheckSVG />
                    <span>{lang.tools.apply}</span>
                </button>
                <button
                    className="button tools-action-secondary"
                    type="button"
                    onClick={() => void copyResult()}
                    disabled={Boolean(transformed.error)}
                >
                    <CopySVG />
                    <span>{lang.tools.copy}</span>
                </button>
                <a
                    className="button tools-action-secondary"
                    href="#"
                    download={lrcFileName(state.info, downloadExtension)}
                    onClick={downloadResult}
                    aria-disabled={Boolean(transformed.error)}
                >
                    <DownloadSVG />
                    <span>{lang.tools.download}</span>
                </a>
            </footer>
        </section>
    );
};

const ToggleOption: React.FC<{
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ label, checked, onChange }) => (
    <label className="tools-option-toggle">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
    </label>
);
