const debuggingPort = Number.parseInt(process.argv[2] || "", 10);
if (!Number.isInteger(debuggingPort)) throw new Error("Pass the Edge remote debugging port");

const pageTarget = await waitForTarget(
    debuggingPort,
    (item) => item.type === "page" && item.url.startsWith("http://127.0.0.1:4173/"),
);
const page = await connect(pageTarget.webSocketDebuggerUrl);
const errors = [];

await page.send("Runtime.enable");
page.on("Runtime.exceptionThrown", (event) => {
    errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "Runtime error");
});

try {
    await page.send("Page.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.__mediaBridgeMessages = [];
            window.addEventListener("message", (event) => {
                if (String(event.data?.type || "").startsWith("LRC_EDITOR_")) {
                    window.__mediaBridgeMessages.push(event.data);
                }
            });
        `,
    });
    await evaluate(
        page,
        `localStorage.setItem("lrc-editor-preferences", JSON.stringify({
            lang: "en-US",
            fixed: 3,
            aiAlignmentEnabled: true,
            showWaveform: true
        })); localStorage.setItem("lrc-editor-lyric", "[00:00.000]Test line"); true`,
    );

    const successful = [];
    for (
        const sample of [
            {
                title: "Intro",
                text: "The Hydrogen Dude《Intro》 https://c6.y.qq.com/base/fcgi-bin/u?__=LNIUcFeE9ZJc @QQ音乐",
                url: "https://c6.y.qq.com/base/fcgi-bin/u?__=LNIUcFeE9ZJc",
                duration: 14,
            },
            {
                title: "POP GIRL (with Yves)",
                text:
                    "刘柏辛Lexie/Yves (이브)《POP GIRL (with Yves)》 https://c6.y.qq.com/base/fcgi-bin/u?__=FlhnwqeE9hsJ @QQ音乐",
                url: "https://c6.y.qq.com/base/fcgi-bin/u?__=FlhnwqeE9hsJ",
                duration: 147,
            },
            {
                title: "My Body Isn't Ready (limited free)",
                text: "sombr《My Body Isn't Ready》 https://c6.y.qq.com/base/fcgi-bin/u?__=pLwHz2eE9Kv8 @QQ音乐",
                url: "https://c6.y.qq.com/base/fcgi-bin/u?__=pLwHz2eE9Kv8",
                duration: 217,
            },
            {
                title: "Intro long link",
                text: "https://y.qq.com/n/ryqq_v2/songDetail/001qJBYN2lctpI",
                url: "https://y.qq.com/n/ryqq_v2/songDetail/001qJBYN2lctpI",
                duration: 14,
            },
        ]
    ) {
        await loadFromSession(page, sample.text);
        try {
            await waitFor(async () => {
                const state = await mediaState(page);
                return state.readyState >= 1 && state.src.startsWith("blob:") && Number.isFinite(state.duration);
            }, 30_000);
        } catch (error) {
            throw new Error(
                `${sample.title} did not load: ${error.message}\n`
                    + `${JSON.stringify(await mediaState(page))}`,
            );
        }
        const state = await mediaState(page);
        assert(Math.abs(state.duration - sample.duration) < 1, `${sample.title} duration was ${state.duration}`);
        assert(state.display === sample.url, `${sample.title} display URL was not preserved`);
        assert(state.remembered === sample.url, `${sample.title} session URL was not preserved`);
        successful.push({ title: sample.title, duration: state.duration, readyState: state.readyState });
    }

    await loadFromSession(
        page,
        "分享Troye Sivan的单曲《She’s the Best》https://163cn.tv/bdlP6XHD (@网易云音乐)",
    );
    const netease = await waitFor(async () => {
        const state = await mediaState(page);
        return state.readyState >= 1 && state.src.startsWith("blob:") && state.duration > 60 ? state : false;
    }, 30_000);
    assert(netease.display === "https://163cn.tv/bdlP6XHD", "The NetEase share URL was not preserved");
    successful.push({ title: "NetEase: She’s the Best", duration: netease.duration, readyState: netease.readyState });

    await evaluate(
        page,
        `(() => {
            const textarea = document.querySelector("textarea");
            if (textarea) textarea.value = "Test line";
            document.querySelector("button.ai-align-button")?.click();
            return true;
        })()`,
    );
    try {
        await waitFor(async () => {
            const text = await evaluate(page, `document.querySelector(".ai-align-dialog")?.innerText || ""`);
            return text.length > 0 && !/Load audio or video|请先载入音频或视频/i.test(text);
        }, 15_000);
    } catch (error) {
        const diagnostic = await evaluate(
            page,
            `({
                button: document.querySelector("button.ai-align-button")?.outerHTML,
                dialog: document.querySelector(".ai-align-dialog")?.innerText,
                lyric: document.querySelector("textarea")?.value,
                storedLyric: localStorage.getItem("lrc-editor-lyric"),
                toasts: [...document.querySelectorAll(".toast")].map((item) => item.innerText)
            })`,
        );
        throw new Error(`AI media check failed: ${error.message}\n${JSON.stringify(diagnostic)}`);
    }
    const aiDialog = await evaluate(page, `document.querySelector(".ai-align-dialog")?.innerText || ""`);
    assert(
        !/Load audio or video|请先载入音频或视频/i.test(aiDialog),
        "QQ Music was not registered as AI alignment media",
    );

    await loadFromSession(
        page,
        "徐良《幻灭》 https://c6.y.qq.com/base/fcgi-bin/u?__=gWVcm0eE9hQ8 @QQ音乐",
    );
    await waitFor(async () => {
        const state = await mediaState(page);
        return state.toasts.some((text) => /complete public playback|VIP|preview-only/i.test(text));
    }, 20_000);
    const blocked = await mediaState(page);
    assert(!blocked.src, "A preview-only QQ Music track was loaded as complete audio");

    await evaluate(page, `location.hash = "#/tools/"; true`);
    await waitFor(async () => await evaluate(page, `document.querySelectorAll(".tools-tabs button").length >= 2`));
    await evaluate(
        page,
        `(() => {
            document.querySelectorAll(".tools-tabs button")[1].click();
            const source = document.querySelector(".tools-editors textarea");
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(source, "[YOASOBI「Biri-Biri」歌詞]\\n\\n[Verse 1]\\nxxx");
            source.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`,
    );
    await waitFor(async () => {
        const value = await evaluate(page, `document.querySelectorAll(".tools-editors textarea")[1]?.value || ""`);
        return value.includes("xxx") && !value.includes("YOASOBI") && !value.includes("Verse 1");
    });
    const editable = await evaluate(
        page,
        `(() => {
            const output = document.querySelectorAll(".tools-editors textarea")[1];
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(output, "manually edited result");
            output.dispatchEvent(new Event("input", { bubbles: true }));
            return !output.readOnly;
        })()`,
    );
    assert(editable, "The tool result textarea is still read-only");
    await evaluate(page, `document.querySelector(".tools-actions button")?.click(); true`);
    await waitFor(async () =>
        await evaluate(
            page,
            `location.hash === "#/editor/" && document.querySelector("textarea")?.value === "manually edited result"`,
        )
    );
    assert(errors.length === 0, `Browser errors: ${errors.join(" | ")}`);

    process.stdout.write(
        JSON.stringify(
            { ok: true, successful, blocked: "幻灭", aiDialog, tools: "editable result and leading tags passed" },
            null,
            2,
        ) + "\n",
    );
} finally {
    try {
        await page.send("Browser.close");
    } catch {
    }
    page.close();
}

async function loadFromSession(cdp, value) {
    await evaluate(
        cdp,
        `(() => {
            sessionStorage.removeItem("audio-src");
            sessionStorage.removeItem("media-input-display");
            sessionStorage.setItem("media-input", ${JSON.stringify(value)});
            location.reload();
            return true;
        })()`,
    );
    await waitFor(
        async () => await evaluate(cdp, `document.readyState === "complete" && !!document.querySelector("audio")`),
        15_000,
    );
}

async function mediaState(cdp) {
    return await evaluate(
        cdp,
        `(() => {
            const audio = document.querySelector("audio");
            return {
                src: audio?.getAttribute("src") || "",
                duration: audio?.duration,
                readyState: audio?.readyState || 0,
                display: sessionStorage.getItem("media-input-display"),
                remembered: sessionStorage.getItem("media-input"),
                toasts: [...document.querySelectorAll(".toast")].map((item) => item.innerText),
                messages: window.__mediaBridgeMessages || [],
                body: document.body?.innerText?.slice(0, 1000)
            };
        })()`,
    );
}

async function waitForTarget(port, predicate) {
    return await waitFor(async () => {
        try {
            const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
            return targets.find(predicate) || false;
        } catch {
            return false;
        }
    }, 15_000);
}

async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw lastError || new Error(`Condition did not become true within ${timeoutMs} ms`);
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const pending = new Map();
        const listeners = new Map();
        let nextId = 1;
        socket.addEventListener("open", () => {
            resolve({
                close: () => socket.close(),
                on: (method, listener) => {
                    const callbacks = listeners.get(method) || [];
                    callbacks.push(listener);
                    listeners.set(method, callbacks);
                },
                send: (method, params = {}) =>
                    new Promise((resolveMessage, rejectMessage) => {
                        const id = nextId++;
                        pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
                        socket.send(JSON.stringify({ id, method, params }));
                    }),
            });
        }, { once: true });
        socket.addEventListener("error", reject, { once: true });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const task = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) task?.reject(new Error(message.error.message));
                else task?.resolve(message.result);
                return;
            }
            for (const listener of listeners.get(message.method) || []) listener(message.params || {});
        });
    });
}

async function evaluate(cdp, expression) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Evaluation failed");
    return result.result?.value;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
