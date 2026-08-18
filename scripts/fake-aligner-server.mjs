import http from "node:http";

const port = Number.parseInt(process.argv[2] || "8765", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");

const jobs = new Map();
const state = {
    postCount: 0,
    transcripts: [],
    audioBytes: [],
    downloads: [],
    requests: [],
};

const wav = createWav();
const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.writeHead(204).end();
        return;
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/__state") state.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === "/openapi.json") {
        json(response, { info: { title: "Lyrics Forced Aligner", version: "0.2.27" } });
        return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
        const running = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
        json(response, { ok: true, gpu_queue: { running, queued: 0 } });
        return;
    }
    if (request.method === "GET" && url.pathname === "/test.wav") {
        response.writeHead(200, {
            "Accept-Ranges": "bytes",
            "Content-Length": wav.length,
            "Content-Type": "audio/wav",
        });
        response.end(wav);
        return;
    }
    if (request.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readBody(request);
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(request.headers["content-type"] || "")?.slice(1)
            .find(Boolean);
        if (!boundary) {
            json(response, { detail: "Missing multipart boundary" }, 400);
            return;
        }
        const parsed = parseMultipart(body, boundary);
        const id = (state.postCount + 1).toString(16).padStart(32, "0");
        state.postCount += 1;
        state.transcripts.push(parsed.transcript);
        state.audioBytes.push(parsed.audioBytes);
        jobs.set(id, { id, polls: 0, status: "queued" });
        json(response, jobPayload(id, "queued", 0));
        return;
    }

    const statusMatch = /^\/api\/jobs\/([a-f0-9]{32})$/i.exec(url.pathname);
    if (request.method === "GET" && statusMatch) {
        const job = jobs.get(statusMatch[1]);
        if (!job) {
            json(response, { detail: "Unknown job" }, 404);
            return;
        }
        job.polls += 1;
        job.status = job.polls >= 2 ? "complete" : "running";
        json(response, jobPayload(job.id, job.status, job.status === "complete" ? 1 : 0.55));
        return;
    }

    const resultMatch = /^\/api\/jobs\/([a-f0-9]{32})\/download\/(lrc2|lrc3)$/i.exec(url.pathname);
    if (request.method === "GET" && resultMatch) {
        const job = jobs.get(resultMatch[1]);
        if (!job || job.status !== "complete") {
            json(response, { detail: "Result unavailable" }, 404);
            return;
        }
        state.downloads.push(resultMatch[2]);
        const lrc = resultMatch[2] === "lrc2"
            ? "[00:01.23]One\n[00:02.34]Two\n"
            : "[00:01.234]One\n[00:02.345]Two\n";
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(lrc);
        return;
    }
    if (request.method === "GET" && url.pathname === "/__state") {
        json(response, state);
        return;
    }
    response.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Fake Lyrics Forced Aligner listening on http://127.0.0.1:${port}\n`);
});

const json = (response, value, status = 200) => {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "Content-Length": body.length, "Content-Type": "application/json" });
    response.end(body);
};

const readBody = async (request) => {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 10 * 1024 * 1024) throw new Error("Request too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

const parseMultipart = (body, boundary) => {
    const text = body.toString("latin1");
    const marker = `--${boundary}`;
    const parts = text.split(marker);
    let transcript = "";
    let audioBytes = 0;
    for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const value = part.slice(headerEnd + 4).replace(/\r\n$/, "");
        if (/name="transcript_text"/i.test(headers)) transcript = Buffer.from(value, "latin1").toString("utf8");
        if (/name="audio"/i.test(headers)) audioBytes = Buffer.byteLength(value, "latin1");
    }
    return { transcript, audioBytes };
};

const jobPayload = (id, status, progress) => ({
    id,
    status,
    stage: status === "complete" ? "done" : status,
    progress,
    detail: status === "complete" ? "Complete" : "Testing local alignment",
    error: null,
});

function createWav() {
    const sampleRate = 16_000;
    const sampleCount = sampleRate;
    const dataLength = sampleCount * 2;
    const output = Buffer.alloc(44 + dataLength);
    output.write("RIFF", 0);
    output.writeUInt32LE(36 + dataLength, 4);
    output.write("WAVEfmt ", 8);
    output.writeUInt32LE(16, 16);
    output.writeUInt16LE(1, 20);
    output.writeUInt16LE(1, 22);
    output.writeUInt32LE(sampleRate, 24);
    output.writeUInt32LE(sampleRate * 2, 28);
    output.writeUInt16LE(2, 32);
    output.writeUInt16LE(16, 34);
    output.write("data", 36);
    output.writeUInt32LE(dataLength, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        output.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 4_000), 44 + index * 2);
    }
    return output;
}
