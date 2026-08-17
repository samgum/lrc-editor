import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { parser, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Action, IState } from "../hooks/useLrc.js";
import { ActionType } from "../hooks/useLrc.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import {
    cleanGeniusTracklist,
    compressTags,
    convertLyricsCase,
    type LyricsCaseMode,
    overwriteLyrics,
    removeEmptyLines,
    removeTags,
    replaceText,
    splitTranslation,
    stripGeniusSections,
    transformTimes,
} from "../utils/lrc-tools.js";
import { appContext } from "./app.context.js";
import { toastPubSub } from "./toast.js";

type Tool =
    | "compress"
    | "remove-tags"
    | "remove-empty"
    | "time"
    | "split"
    | "overwrite"
    | "sections"
    | "tracklist"
    | "replace"
    | "case";

type StandaloneTool = "sections" | "tracklist" | "replace" | "case";

const standaloneTools = new Set<Tool>(["sections", "tracklist", "replace", "case"]);
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

export const Tools: React.FC<{
    state: IState;
    dispatch: React.Dispatch<Action>;
}> = ({ state, dispatch }) => {
    const { lang, prefState, trimOptions } = useContext(appContext);
    const serialized = useMemo(() => stringify(state, prefState), [prefState, state]);
    const [source, setSource] = useState(serialized);
    const [tool, setTool] = useState<Tool>("compress");
    const [multiplier, setMultiplier] = useState(1);
    const [constantMs, setConstantMs] = useState(0);
    const [splitPattern, setSplitPattern] = useState<string>(splitPatterns[0].value);
    const [customPattern, setCustomPattern] = useState("");
    const [replacement, setReplacement] = useState(() => sessionStorage.getItem(SSK.overwriteText) || "");
    const [standaloneSources, setStandaloneSources] = useState<Record<StandaloneTool, string>>({
        sections: "",
        tracklist: "",
        replace: "",
        case: "",
    });
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
    const sourceRef = useRef<HTMLTextAreaElement>(null);
    const translationRef = useRef<HTMLTextAreaElement>(null);
    const outputRef = useRef<HTMLTextAreaElement>(null);
    const [downloadHref, setDownloadHref] = useState<string>();

    useEffect(() => setSource(serialized), [serialized]);
    useEffect(() => sessionStorage.setItem(SSK.overwriteText, replacement), [replacement]);

    const activeSource = isStandaloneTool(tool) ? standaloneSources[tool] : source;
    const translationInfoLines = useMemo(() => {
        if (tool !== "overwrite") return 0;
        try {
            return parser(source, trimOptions).info.size;
        } catch {
            return 0;
        }
    }, [source, tool, trimOptions]);
    const updateActiveSource = useCallback((value: string) => {
        if (isStandaloneTool(tool)) {
            setStandaloneSources((current) => ({ ...current, [tool]: value }));
        } else {
            setSource(value);
        }
    }, [tool]);

    const transformed = useMemo(() => {
        try {
            if (tool === "sections") {
                return {
                    text: stripGeniusSections(activeSource, {
                        strictMode: strictSections,
                        dropEmpty: dropSectionEmpty,
                        dropSuggestions,
                    }).text,
                };
            }
            if (tool === "tracklist") {
                return {
                    text: cleanGeniusTracklist(activeSource, {
                        keepTitle: keepAlbumTitle,
                        stripFeatured,
                    }).text,
                };
            }
            if (tool === "replace") {
                const result = replaceText(activeSource, {
                    find: findText,
                    replacement: replacementText,
                    regex: regexMode,
                    caseSensitive,
                });
                return { text: result.text, error: result.error };
            }
            if (tool === "case") {
                return {
                    text: convertLyricsCase(activeSource, caseMode, capitalizeLineStart, fixPronoun),
                };
            }
            const parsed = parser(source, trimOptions);
            switch (tool) {
                case "compress":
                    return { text: compressTags(parsed, prefState) };
                case "remove-tags":
                    return { text: removeTags(parsed, prefState) };
                case "remove-empty":
                    return { text: removeEmptyLines(parsed, prefState) };
                case "time":
                    return { text: transformTimes(parsed, multiplier, constantMs, prefState) };
                case "split": {
                    const expression = new RegExp(customPattern || splitPattern);
                    return { text: splitTranslation(parsed, expression, prefState) };
                }
                case "overwrite":
                    return { text: overwriteLyrics(parsed, replacement, prefState) };
            }
        } catch {
            return { text: "", error: lang.tools.invalidRegex };
        }
    }, [
        constantMs,
        customPattern,
        activeSource,
        capitalizeLineStart,
        caseMode,
        caseSensitive,
        dropSectionEmpty,
        dropSuggestions,
        findText,
        fixPronoun,
        keepAlbumTitle,
        lang.tools.invalidRegex,
        multiplier,
        prefState,
        regexMode,
        replacement,
        replacementText,
        source,
        splitPattern,
        strictSections,
        stripFeatured,
        tool,
        trimOptions,
    ]);

    const applyResult = useCallback(() => {
        if (transformed.error || tool === "split") {
            return;
        }
        dispatch({ type: ActionType.parse, payload: { text: transformed.text, options: trimOptions } });
        updateActiveSource(transformed.text);
        toastPubSub.pub({ type: "success", text: lang.notify.resultApplied });
        location.hash = ROUTER.editor;
    }, [dispatch, lang.notify.resultApplied, tool, transformed, trimOptions, updateActiveSource]);

    const copyResult = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(transformed.text);
        } catch {
            outputRef.current?.select();
            document.execCommand("copy");
        }
        toastPubSub.pub({ type: "success", text: lang.notify.copied });
    }, [lang.notify.copied, transformed.text]);

    const prepareDownload = useCallback(() => {
        setDownloadHref((current) => {
            if (current) {
                URL.revokeObjectURL(current);
            }
            return URL.createObjectURL(new Blob([transformed.text], { type: "text/plain;charset=UTF-8" }));
        });
    }, [transformed.text]);

    const syncScroll = useCallback((origin: HTMLTextAreaElement, targets: Array<HTMLTextAreaElement | null>) => {
        for (const target of targets) {
            if (!target || target === origin) continue;
            if (Math.abs(target.scrollTop - origin.scrollTop) > 1) target.scrollTop = origin.scrollTop;
            if (Math.abs(target.scrollLeft - origin.scrollLeft) > 1) target.scrollLeft = origin.scrollLeft;
        }
    }, []);

    const toolButtons: Array<{ id: Tool; label: string }> = [
        { id: "compress", label: lang.tools.compressTags },
        { id: "remove-tags", label: lang.tools.removeTags },
        { id: "remove-empty", label: lang.tools.removeEmpty },
        { id: "time", label: lang.tools.changeOffset },
        { id: "split", label: lang.tools.splitTranslation },
        { id: "overwrite", label: lang.tools.overwrite },
        { id: "sections", label: lang.tools.sections },
        { id: "tracklist", label: lang.tools.tracklist },
        { id: "replace", label: lang.tools.replaceText },
        { id: "case", label: lang.tools.caseConverter },
    ];

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
                {tool === "time" && (
                    <>
                        <label>
                            {lang.tools.multiplier}
                            <input
                                type="number"
                                step="0.01"
                                value={multiplier}
                                onChange={(ev) => setMultiplier(ev.target.valueAsNumber)}
                            />
                        </label>
                        <label>
                            {lang.tools.constantMs}
                            <input
                                type="number"
                                step="10"
                                value={constantMs}
                                onChange={(ev) => setConstantMs(ev.target.valueAsNumber)}
                            />
                        </label>
                    </>
                )}
                {tool === "split" && (
                    <>
                        <label>
                            {lang.tools.splitPattern}
                            <select value={splitPattern} onChange={(ev) => setSplitPattern(ev.target.value)}>
                                {splitPatterns.map((pattern) => (
                                    <option key={pattern.value} value={pattern.value}>{pattern.label}</option>
                                ))}
                            </select>
                        </label>
                        <label className="tools-custom-regex">
                            {lang.tools.customRegex}
                            <input value={customPattern} onChange={(ev) => setCustomPattern(ev.target.value)} />
                        </label>
                    </>
                )}
                {tool === "sections" && (
                    <>
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
                        <label>
                            {lang.tools.find}
                            <input value={findText} onChange={(ev) => setFindText(ev.target.value)} />
                        </label>
                        <label>
                            {lang.tools.replaceWith}
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
                        <label>
                            {lang.tools.caseMode}
                            <select value={caseMode} onChange={(ev) => setCaseMode(ev.target.value as LyricsCaseMode)}>
                                <option value="sentence">{lang.tools.sentenceCase}</option>
                                <option value="upper">{lang.tools.upperCase}</option>
                                <option value="lower">{lang.tools.lowerCase}</option>
                                <option value="words">{lang.tools.wordCase}</option>
                                <option value="title">{lang.tools.titleCase}</option>
                            </select>
                        </label>
                        <ToggleOption
                            label={lang.tools.capitalizeLineStart}
                            checked={capitalizeLineStart}
                            onChange={setCapitalizeLineStart}
                        />
                        <ToggleOption label={lang.tools.fixPronounI} checked={fixPronoun} onChange={setFixPronoun} />
                    </>
                )}
            </div>

            <div className={`tools-editors${tool === "overwrite" ? " translation-axis-editors" : ""}`}>
                <label>
                    <span>{lang.tools.source}</span>
                    <textarea
                        ref={sourceRef}
                        value={activeSource}
                        onChange={(ev) => updateActiveSource(ev.target.value)}
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
                            style={{ paddingTop: `calc(0.75rem + ${translationInfoLines * 1.5}em)` }}
                            spellCheck={false}
                        />
                    </label>
                )}
                <label>
                    <span>{lang.tools.output}</span>
                    <textarea
                        ref={outputRef}
                        value={transformed.text}
                        readOnly={true}
                        spellCheck={false}
                        onScroll={(ev) => syncScroll(ev.currentTarget, [sourceRef.current, translationRef.current])}
                    />
                </label>
            </div>

            {transformed.error && <p className="tools-error" role="alert">{transformed.error}</p>}

            <footer className="tools-actions">
                <button
                    className="button"
                    type="button"
                    onClick={applyResult}
                    disabled={Boolean(transformed.error) || tool === "split"}
                >
                    {lang.tools.apply}
                </button>
                <button
                    className="button"
                    type="button"
                    onClick={() => void copyResult()}
                    disabled={Boolean(transformed.error)}
                >
                    {lang.tools.copy}
                </button>
                <a
                    className="button"
                    href={downloadHref}
                    download={lrcFileName(state.info)}
                    onClick={prepareDownload}
                    aria-disabled={Boolean(transformed.error)}
                >
                    {lang.tools.download}
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
