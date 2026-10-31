import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { convertTimeToTag, parser, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { audioRef, currentTimePubSub } from "../utils/audiomodule.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import {
    buildOverwritePlan,
    cleanGeniusTracklist,
    convertLyricsCase,
    type DuplicateTimestampStrategy,
    extractReplacementLines,
    type LyricsCaseMode,
    type OverwriteAlignMode,
    type OverwriteFallbackMode,
    type OverwriteOutputMode,
    type OverwritePlan,
    type OverwriteRowKind,
    removeEmptyLines,
    removeTags,
    repairTimeline,
    replaceText,
    type SplitTranslationTarget,
    splitTranslationWithStats,
    stripGeniusSections,
    transformTimes,
} from "../utils/lrc-tools.js";
import { appContext } from "./app.context.js";
import { StyledSelect } from "./styled-select.js";
import { CheckSVG, CopySVG, DownloadSVG, OpenFileSVG, PlaySVG } from "./svg.js";
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

    // Overwrite state
    const [overwriteView, setOverwriteView] = useState<"workbench" | "columns">("workbench");
    const [overwriteMode, setOverwriteMode] = useState<OverwriteOutputMode>("replace");
    const [inlineTemplate, setInlineTemplate] = useState<string>(inlineBilingualTemplates[0].value);
    const [overwriteAlign, setOverwriteAlign] = useState<OverwriteAlignMode>("smart");
    const [preserveCredits, setPreserveCredits] = useState(true);
    const [ignoreBlankLines, setIgnoreBlankLines] = useState(true);
    const [overwriteFallback, setOverwriteFallback] = useState<OverwriteFallbackMode>("keep");
    const [overwriteFilter, setOverwriteFilter] = useState<"all" | "active">("all");
    const [skippedIndices, setSkippedIndices] = useState<Set<number>>(() => new Set());
    const [forcedIndices, setForcedIndices] = useState<Set<number>>(() => new Set());
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
    const translationRef = useRef<HTMLTextAreaElement>(null);
    const outputRef = useRef<HTMLTextAreaElement>(null);
    const alignListRef = useRef<HTMLDivElement>(null);
    const [output, setOutput] = useState("");

    useEffect(() => {
        setSource(serialized);
        setSkippedIndices(new Set());
        setForcedIndices(new Set());
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
            setSkippedIndices(new Set());
            setForcedIndices(new Set());
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
                setSkippedIndices(new Set());
                setForcedIndices(new Set());
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

    const overwritePlan = useMemo<OverwritePlan | null>(() => {
        if (tool !== "overwrite") return null;
        try {
            const parsed = parser(source, trimOptions);
            return buildOverwritePlan(parsed, replacement, prefState, {
                outputMode: overwriteMode,
                inlineTemplate,
                alignMode: overwriteAlign,
                preserveCredits,
                ignoreBlankLines,
                unmatchedFallback: overwriteFallback,
                skippedLineIndices: skippedIndices,
                forcedLyricLineIndices: forcedIndices,
            });
        } catch {
            return null;
        }
    }, [
        forcedIndices,
        ignoreBlankLines,
        inlineTemplate,
        overwriteAlign,
        overwriteFallback,
        overwriteMode,
        prefState,
        preserveCredits,
        replacement,
        skippedIndices,
        source,
        tool,
        trimOptions,
    ]);

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
                return { text: overwritePlan?.text ?? "" };
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
        overwritePlan,
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

    useEffect(() => setOutput(transformed.text), [tool, transformed.text]);

    // Helpers for interactive slot manipulation in Overwrite Workbench
    const getMaterializedSlots = useCallback((): string[] => {
        const extracted = extractReplacementLines(replacement, {
            alignMode: overwriteAlign,
            ignoreBlankLines,
        });
        return extracted;
    }, [ignoreBlankLines, overwriteAlign, replacement]);

    const updateSlotValue = useCallback((slotIndex: number, nextValue: string) => {
        const slots = getMaterializedSlots();
        while (slots.length <= slotIndex) {
            slots.push("");
        }
        slots[slotIndex] = nextValue;
        if (slots.some((line) => line.trim() === "") && ignoreBlankLines) {
            setIgnoreBlankLines(false);
        }
        setReplacement(slots.join("\n"));
    }, [getMaterializedSlots, ignoreBlankLines]);

    const insertBlankAtSlot = useCallback((slotIndex: number) => {
        const slots = getMaterializedSlots();
        while (slots.length < slotIndex) {
            slots.push("");
        }
        slots.splice(slotIndex, 0, "");
        if (ignoreBlankLines) {
            setIgnoreBlankLines(false);
        }
        setReplacement(slots.join("\n"));
    }, [getMaterializedSlots, ignoreBlankLines]);

    const deleteAtSlot = useCallback((slotIndex: number) => {
        const slots = getMaterializedSlots();
        if (slotIndex < 0 || slotIndex >= slots.length) return;
        slots.splice(slotIndex, 1);
        setReplacement(slots.join("\n"));
    }, [getMaterializedSlots]);

    const toggleRowParticipation = useCallback((lineIndex: number, kind: OverwriteRowKind) => {
        if (kind === "lyric") {
            setSkippedIndices((prev) => {
                const next = new Set(prev);
                next.add(lineIndex);
                return next;
            });
            setForcedIndices((prev) => {
                if (!prev.has(lineIndex)) return prev;
                const next = new Set(prev);
                next.delete(lineIndex);
                return next;
            });
        } else if (kind === "skipped") {
            setSkippedIndices((prev) => {
                const next = new Set(prev);
                next.delete(lineIndex);
                return next;
            });
        } else {
            // Auto-skipped row (credit / section / empty) -> force include as target lyric slot
            setForcedIndices((prev) => {
                const next = new Set(prev);
                if (next.has(lineIndex)) next.delete(lineIndex);
                else next.add(lineIndex);
                return next;
            });
        }
    }, []);

    const normalizeReplacementInput = useCallback(() => {
        const slots = getMaterializedSlots();
        setReplacement(slots.join("\n"));
    }, [getMaterializedSlots]);

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

    const jumpToFirstGap = useCallback(() => {
        if (!overwritePlan || overwritePlan.firstUnmatchedLineIndex === null) return;
        const rowEl = alignListRef.current?.querySelector<HTMLElement>(
            `[data-line-index="${overwritePlan.firstUnmatchedLineIndex}"]`,
        );
        if (!rowEl) return;
        rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
        rowEl.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }, [overwritePlan]);

    const previewLineTime = useCallback((time: number) => {
        audioRef.currentTime = Math.max(0, time);
        currentTimePubSub.pub(audioRef.currentTime);
        if (audioRef.src && audioRef.paused) {
            void audioRef.current?.play().catch(() => undefined);
        }
    }, []);

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

    const overwriteDiagnostic = useMemo(() => {
        if (!overwritePlan) return null;
        const { inputCount, targetCount } = overwritePlan;
        if (inputCount === 0) {
            return {
                tone: "waiting" as const,
                text: lang.tools.overwriteStatusWaiting.replace("%s", String(targetCount)),
            };
        }
        if (inputCount === targetCount) {
            return {
                tone: "matched" as const,
                text: lang.tools.overwriteStatusMatched.replace(/%s/g, String(targetCount)),
            };
        }
        if (inputCount < targetCount) {
            return {
                tone: "short" as const,
                text: lang.tools.overwriteStatusShort
                    .replace("%actual", String(inputCount))
                    .replace("%target", String(targetCount))
                    .replace("%diff", String(targetCount - inputCount)),
            };
        }
        return {
            tone: "extra" as const,
            text: lang.tools.overwriteStatusExtra
                .replace("%actual", String(inputCount))
                .replace("%target", String(targetCount))
                .replace("%diff", String(inputCount - targetCount)),
        };
    }, [lang.tools, overwritePlan]);

    const visibleOverwriteRows = useMemo(() => {
        if (!overwritePlan) return [];
        if (overwriteFilter === "active") {
            return overwritePlan.rows.filter((row) => row.kind === "lyric");
        }
        return overwritePlan.rows;
    }, [overwriteFilter, overwritePlan]);

    const badgeLabelForKind = (kind: OverwriteRowKind): string => {
        switch (kind) {
            case "empty":
                return lang.tools.overwriteBadgeEmpty;
            case "credit":
                return lang.tools.overwriteBadgeCredit;
            case "section":
                return lang.tools.overwriteBadgeSection;
            case "skipped":
                return lang.tools.overwriteBadgeSkipped;
            default:
                return "";
        }
    };

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
                        <div className="tools-segmented" role="group" aria-label={lang.tools.overwrite}>
                            <button
                                type="button"
                                className={overwriteView === "workbench" ? "active" : ""}
                                aria-pressed={overwriteView === "workbench"}
                                onClick={() => setOverwriteView("workbench")}
                            >
                                {lang.tools.overwriteWorkbenchView}
                            </button>
                            <button
                                type="button"
                                className={overwriteView === "columns" ? "active" : ""}
                                aria-pressed={overwriteView === "columns"}
                                onClick={() => setOverwriteView("columns")}
                            >
                                {lang.tools.overwriteColumnsView}
                            </button>
                        </div>

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

                        <label>
                            <span>{lang.tools.overwriteAlignMode}</span>
                            <StyledSelect
                                value={overwriteAlign}
                                onValueChange={(val) => setOverwriteAlign(val as OverwriteAlignMode)}
                                label={lang.tools.overwriteAlignMode}
                                options={[
                                    { value: "smart", label: lang.tools.overwriteAlignSmart },
                                    { value: "strict", label: lang.tools.overwriteAlignStrict },
                                ]}
                            />
                        </label>

                        <label>
                            <span>{lang.tools.overwriteFallback}</span>
                            <StyledSelect
                                value={overwriteFallback}
                                onValueChange={(val) => setOverwriteFallback(val as OverwriteFallbackMode)}
                                label={lang.tools.overwriteFallback}
                                options={[
                                    { value: "keep", label: lang.tools.overwriteFallbackKeep },
                                    { value: "empty", label: lang.tools.overwriteFallbackEmpty },
                                ]}
                            />
                        </label>

                        {overwriteAlign === "smart" && (
                            <>
                                <ToggleOption
                                    label={lang.tools.overwritePreserveCredits}
                                    checked={preserveCredits}
                                    onChange={setPreserveCredits}
                                />
                                <ToggleOption
                                    label={lang.tools.overwriteIgnoreBlank}
                                    checked={ignoreBlankLines}
                                    onChange={setIgnoreBlankLines}
                                />
                            </>
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

            {tool === "overwrite" && overwriteView === "workbench" && overwritePlan && (
                <div className="overwrite-workspace">
                    {overwriteDiagnostic && (
                        <div className={`overwrite-status-bar tone-${overwriteDiagnostic.tone}`} role="status">
                            <div className="overwrite-status-message">
                                {overwriteDiagnostic.tone === "matched" && <CheckSVG />}
                                <strong>{overwriteDiagnostic.text}</strong>
                                {overwriteDiagnostic.tone === "short"
                                    && overwritePlan.firstUnmatchedLineIndex !== null && (
                                    <button
                                        type="button"
                                        className="overwrite-jump-btn"
                                        onClick={jumpToFirstGap}
                                    >
                                        {lang.tools.overwriteJumpMismatch}
                                    </button>
                                )}
                            </div>
                            <div className="overwrite-status-controls">
                                <div className="tools-segmented compact">
                                    <button
                                        type="button"
                                        className={overwriteFilter === "all" ? "active" : ""}
                                        aria-pressed={overwriteFilter === "all"}
                                        onClick={() =>
                                            setOverwriteFilter("all")}
                                    >
                                        {lang.tools.overwriteFilterAll.replace("%s", String(overwritePlan.rows.length))}
                                    </button>
                                    <button
                                        type="button"
                                        className={overwriteFilter === "active" ? "active" : ""}
                                        aria-pressed={overwriteFilter === "active"}
                                        onClick={() =>
                                            setOverwriteFilter("active")}
                                    >
                                        {lang.tools.overwriteFilterActive.replace(
                                            "%s",
                                            String(overwritePlan.targetCount),
                                        )}
                                    </button>
                                </div>
                                <button type="button" className="tools-ghost-button" onClick={syncSourceFromEditor}>
                                    {lang.tools.overwriteSyncEditor}
                                </button>
                                <label className="tools-file-button compact">
                                    <input
                                        hidden={true}
                                        type="file"
                                        accept="text/*,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                                        onChange={(event) => void onConversionFile(event)}
                                    />
                                    <OpenFileSVG />
                                    <span>{lang.tools.loadLyricFile}</span>
                                </label>
                            </div>
                        </div>
                    )}

                    <div className="overwrite-workbench">
                        <section className="overwrite-input-pane">
                            <header className="overwrite-pane-header">
                                <span>{lang.tools.translation}</span>
                                <div className="overwrite-pane-actions">
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
                                        className="tools-mini-btn"
                                        disabled={!replacement.trim()}
                                        onClick={normalizeReplacementInput}
                                    >
                                        {lang.tools.overwriteNormalizeInput}
                                    </button>
                                    <button
                                        type="button"
                                        className="tools-mini-btn danger"
                                        disabled={!replacement}
                                        onClick={() => setReplacement("")}
                                    >
                                        {lang.tools.overwriteClearInput}
                                    </button>
                                </div>
                            </header>
                            <textarea
                                ref={translationRef}
                                value={replacement}
                                placeholder={lang.tools.overwritePlaceholder}
                                onChange={(ev) => setReplacement(ev.target.value)}
                                spellCheck={false}
                            />
                        </section>

                        <section className="overwrite-align-pane">
                            <header className="overwrite-pane-header">
                                <span>
                                    {lang.tools.source} → {lang.tools.output}
                                </span>
                            </header>

                            <div className="overwrite-align-list" ref={alignListRef}>
                                {visibleOverwriteRows.length === 0 && (
                                    <p className="overwrite-empty-hint">{lang.workspace.noLyrics}</p>
                                )}
                                {visibleOverwriteRows.map((row) => {
                                    const isLyricSlot = row.kind === "lyric" && row.slotIndex !== null;
                                    const timeLabel = row.time !== undefined
                                        ? convertTimeToTag(row.time, prefState.fixed, false)
                                        : "—";
                                    const isGap = isLyricSlot && overwritePlan.inputCount > 0 && !row.matched;

                                    return (
                                        <div
                                            key={row.lineIndex}
                                            data-line-index={row.lineIndex}
                                            className={`overwrite-row kind-${row.kind}${isGap ? " is-gap" : ""}`}
                                        >
                                            <div className="overwrite-row-meta">
                                                <span className="overwrite-row-num">#{row.lineIndex + 1}</span>
                                                {row.time !== undefined
                                                    ? (
                                                        <button
                                                            type="button"
                                                            className="overwrite-time-chip"
                                                            title={lang.tools.overwritePreviewTime}
                                                            onClick={() => previewLineTime(row.time!)}
                                                        >
                                                            <PlaySVG />
                                                            <span>{timeLabel}</span>
                                                        </button>
                                                    )
                                                    : <span className="overwrite-time-chip untimed">{timeLabel}</span>}
                                                {row.kind !== "lyric" && (
                                                    <span className={`overwrite-kind-badge badge-${row.kind}`}>
                                                        {badgeLabelForKind(row.kind)}
                                                    </span>
                                                )}
                                                <button
                                                    type="button"
                                                    className="overwrite-skip-toggle"
                                                    onClick={() => toggleRowParticipation(row.lineIndex, row.kind)}
                                                >
                                                    {row.kind === "lyric"
                                                        ? lang.tools.overwriteSkipLine
                                                        : lang.tools.overwriteUnskipLine}
                                                </button>
                                            </div>

                                            <div className="overwrite-row-source">
                                                {row.sourceText.trim()
                                                    ? <span>{row.sourceText}</span>
                                                    : <em className="overwrite-empty-text">{lang.timing.emptyLine}</em>}
                                            </div>

                                            {isLyricSlot && (
                                                <div className="overwrite-row-target">
                                                    <input
                                                        type="text"
                                                        value={row.replacementText}
                                                        placeholder={overwriteFallback === "keep"
                                                            ? row.sourceText
                                                            : "…"}
                                                        aria-label={`${lang.tools.translation} #${row.lineIndex + 1}`}
                                                        onChange={(ev) =>
                                                            updateSlotValue(row.slotIndex!, ev.target.value)}
                                                        spellCheck={false}
                                                    />
                                                    <div className="overwrite-row-tools">
                                                        <button
                                                            type="button"
                                                            title={lang.tools.overwriteInsertBlankDown}
                                                            aria-label={lang.tools.overwriteInsertBlankDown}
                                                            onClick={() => insertBlankAtSlot(row.slotIndex!)}
                                                        >
                                                            ↓
                                                        </button>
                                                        <button
                                                            type="button"
                                                            title={lang.tools.overwriteDeletePullUp}
                                                            aria-label={lang.tools.overwriteDeletePullUp}
                                                            disabled={!row.matched}
                                                            onClick={() => deleteAtSlot(row.slotIndex!)}
                                                        >
                                                            ↑
                                                        </button>
                                                        <button
                                                            type="button"
                                                            title={lang.tools.overwriteUseOriginal}
                                                            aria-label={lang.tools.overwriteUseOriginal}
                                                            onClick={() =>
                                                                updateSlotValue(row.slotIndex!, row.sourceText)}
                                                        >
                                                            ↺
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}

                                {overwritePlan.extraLines.length > 0 && (
                                    <div className="overwrite-extra-box">
                                        <strong>
                                            {lang.tools.overwriteExtraLinesTitle.replace(
                                                "%s",
                                                String(overwritePlan.extraLines.length),
                                            )}
                                        </strong>
                                        <ol start={overwritePlan.targetCount + 1}>
                                            {overwritePlan.extraLines.map((line, idx) => (
                                                <li key={`${idx}-${line}`}>{line || " "}</li>
                                            ))}
                                        </ol>
                                    </div>
                                )}
                            </div>
                        </section>
                    </div>
                </div>
            )}

            {(tool !== "overwrite" || overwriteView === "columns") && (
                <div className={`tools-editors${tool === "overwrite" ? " translation-axis-editors" : ""}`}>
                    <label>
                        <span>{lang.tools.source}</span>
                        <textarea
                            ref={sourceRef}
                            value={activeSource}
                            placeholder={tool === "convert" ? lang.tools.converterSourcePlaceholder : undefined}
                            onChange={(ev) =>
                                updateActiveSource(ev.target.value)}
                            onScroll={(ev) => syncScroll(ev.currentTarget, [translationRef.current, outputRef.current])}
                            spellCheck={false}
                        />
                    </label>
                    {tool === "overwrite" && (
                        <label>
                            <span>{lang.tools.translation}</span>
                            <textarea
                                ref={translationRef}
                                value={replacement}
                                placeholder={lang.tools.overwritePlaceholder}
                                onChange={(ev) => setReplacement(ev.target.value)}
                                onScroll={(ev) => syncScroll(ev.currentTarget, [sourceRef.current, outputRef.current])}
                                spellCheck={false}
                            />
                        </label>
                    )}
                    <label>
                        <span>{lang.tools.output}</span>
                        <textarea
                            ref={outputRef}
                            value={output}
                            onChange={(ev) => setOutput(ev.target.value)}
                            spellCheck={false}
                            onScroll={(ev) => syncScroll(ev.currentTarget, [sourceRef.current, translationRef.current])}
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
