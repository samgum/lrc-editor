const debuggingPort = Number.parseInt(process.argv[2] || "", 10);
const alignerPort = Number.parseInt(process.argv[3] || "8765", 10);
if (!Number.isInteger(debuggingPort)) throw new Error("Pass the Edge remote debugging port");

const target = await waitForPage(debuggingPort);
const cdp = await connect(target.webSocketDebuggerUrl);
let workerCdp;
const consoleErrors = [];
cdp.on("Runtime.exceptionThrown", (event) => consoleErrors.push(event.exceptionDetails?.text || "Runtime exception"));
cdp.on("Log.entryAdded", (event) => {
    if (event.entry?.level === "error") consoleErrors.push(event.entry.text);
});

try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    const workerTarget = await waitForTarget(
        debuggingPort,
        (item) => item.type === "service_worker" && item.url.startsWith("chrome-extension://"),
    );
    workerCdp = await connect(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    const workerProbe = await evaluate(
        workerCdp,
        `fetch("http://127.0.0.1:${alignerPort}/openapi.json", { cache: "no-store" })
            .then(async (response) => ({ ok: response.ok, status: response.status, text: await response.text() }))
            .catch((error) => ({ error: String(error), stack: error?.stack }))`,
    );
    assert(workerProbe.ok, `Extension service worker cannot reach the local aligner: ${JSON.stringify(workerProbe)}`);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            if (location.origin === "http://127.0.0.1:4173") {
                localStorage.setItem("lrc-editor-preferences", JSON.stringify({
                    lang: "en-US",
                    fixed: 3,
                    aiAlignmentEnabled: true,
                    showWaveform: true
                }));
                localStorage.setItem("lrc-editor-lyric", "[ti: Demo]\\n[00:05.000]One\\n[00:06.000]Two");
                sessionStorage.setItem("audio-src", "http://127.0.0.1:${alignerPort}/test.wav");
            }
        `,
    });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:4173/#/editor/" });
    try {
        await waitFor(async () =>
            await evaluate(
                cdp,
                "document.readyState === 'complete' && !!document.querySelector('button.ai-align-button') && !!document.querySelector('audio[src]')",
            ), 15_000);
    } catch (error) {
        const diagnostics = await evaluate(
            cdp,
            `({
            url: location.href,
            readyState: document.readyState,
            body: document.body?.innerText?.slice(0, 1000),
            preferences: localStorage.getItem("lrc-editor-preferences"),
            lyric: localStorage.getItem("lrc-editor-lyric"),
            audio: document.querySelector("audio")?.outerHTML,
            aiButtons: document.querySelectorAll("button.ai-align-button").length
        })`,
        );
        throw new Error(`${error.message}\nDiagnostics: ${JSON.stringify(diagnostics)}`);
    }

    await evaluate(
        cdp,
        `
        (() => {
            window.__aiBridgeMessages = [];
            window.addEventListener("message", (event) => {
                if (String(event.data?.type || "").includes("ALIGNER")) {
                    window.__aiBridgeMessages.push({
                        type: event.data.type,
                        requestId: event.data.requestId,
                        ok: event.data.ok,
                        error: event.data.error,
                        message: event.data.message,
                        payloadKind: event.data.payload?.kind
                    });
                }
            });
            const button = document.querySelector("button.ai-align-button");
            button.click();
            button.click();
            return true;
        })()
    `,
    );
    try {
        await waitFor(async () => {
            const pageState = await evaluate(
                cdp,
                `({
                value: document.querySelector("textarea")?.value || "",
                error: document.querySelector(".ai-align-dialog")?.innerText || ""
            })`,
            );
            if (/Install and start Lyrics Forced Aligner/.test(pageState.error)) {
                throw new Error("The extension reported that the local aligner is unavailable");
            }
            return pageState.value.includes("[00:01.234]One") && pageState.value.includes("[00:02.345]Two");
        }, 20_000);
    } catch (error) {
        const diagnostics = await evaluate(
            cdp,
            `({
            editor: document.querySelector("textarea")?.value,
            dialog: document.querySelector(".ai-align-dialog")?.innerText,
            toasts: [...document.querySelectorAll(".toast")].map((item) => item.innerText),
            audio: document.querySelector("audio")?.outerHTML,
            messages: window.__aiBridgeMessages
        })`,
        );
        const alignerState = await getAlignerState(alignerPort);
        throw new Error(
            `${error.message}\nPage: ${JSON.stringify(diagnostics)}\nAligner: ${JSON.stringify(alignerState)}`
                + `\nConsole: ${JSON.stringify(consoleErrors)}`,
        );
    }

    const firstState = await getAlignerState(alignerPort);
    assert(firstState.postCount === 1, `Expected one job after duplicate click, received ${firstState.postCount}`);
    assert(
        firstState.transcripts[0].replace(/\r\n/g, "\n") === "One\nTwo",
        `Unexpected transcript: ${JSON.stringify(firstState.transcripts[0])}`,
    );
    assert(firstState.audioBytes[0] > 1_000, "The loaded editor audio was not transferred");
    assert(JSON.stringify(firstState.downloads) === JSON.stringify(["lrc3"]), "Three-digit output was not requested");

    await evaluate(cdp, "location.hash = '#/preferences/'; true");
    await waitFor(async () => await evaluate(cdp, "!!document.querySelector('select[name=fixed]')"));
    await evaluate(
        cdp,
        `
        (() => {
            const select = document.querySelector("select[name=fixed]");
            select.value = "2";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        })()
    `,
    );
    await evaluate(cdp, "location.hash = '#/editor/'; true");
    await waitFor(async () => await evaluate(cdp, "!!document.querySelector('button.ai-align-button')"));
    await evaluate(cdp, "document.querySelector('button.ai-align-button').click(); true");
    await waitFor(async () => (await getAlignerState(alignerPort)).downloads.length === 2, 20_000);

    const finalState = await getAlignerState(alignerPort);
    const editorValue = await evaluate(cdp, "document.querySelector('textarea').value");
    assert(finalState.postCount === 2, `Expected two completed precision checks, received ${finalState.postCount}`);
    assert(
        JSON.stringify(finalState.downloads) === JSON.stringify(["lrc3", "lrc2"]),
        "Precision did not follow settings",
    );
    assert(editorValue.includes("[ti: Demo]"), "Editor metadata was not preserved");
    assert(
        editorValue.includes("[00:01.23]One") && editorValue.includes("[00:02.34]Two"),
        "Two-digit axis was not applied",
    );
    assert(!editorValue.includes("[00:05"), "The old editor axis was not replaced");
    assert(consoleErrors.length === 0, `Browser errors: ${consoleErrors.join(" | ")}`);

    process.stdout.write(
        JSON.stringify(
            {
                ok: true,
                jobs: finalState.postCount,
                downloads: finalState.downloads,
                transcript: finalState.transcripts[0],
                audioBytes: finalState.audioBytes[0],
                editorValue,
            },
            null,
            2,
        ) + "\n",
    );
} finally {
    workerCdp?.close();
    try {
        await cdp.send("Browser.close");
    } catch {
    }
    cdp.close();
}

async function waitForPage(port) {
    return await waitForTarget(port, (item) => item.type === "page");
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

async function getAlignerState(port) {
    return await fetch(`http://127.0.0.1:${port}/__state`, { cache: "no-store" }).then((response) => response.json());
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
