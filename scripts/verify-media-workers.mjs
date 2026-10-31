import assert from "node:assert/strict";
import { createCipheriv, webcrypto } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

const buildDirectory = new URL("../build/", import.meta.url);
const assetDirectory = new URL("assets/", buildDirectory);
const files = await readdir(assetDirectory);
const manifest = JSON.parse(await readFile(new URL("offline-assets.json", buildDirectory), "utf8"));
const appBundles = await Promise.all(
    files.filter((file) => file.endsWith(".js") && !file.includes("worker"))
        .map((file) => readFile(new URL(file, assetDirectory), "utf8")),
);

const sampleRate = 22_050;
const pcmBytes = sampleRate * 2;
const audio = Buffer.alloc(44 + pcmBytes);
audio.write("RIFF");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(sampleRate, 24);
audio.writeUInt32LE(sampleRate * 2, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36);
audio.writeUInt32LE(pcmBytes, 40);
for (let sample = 0; sample < sampleRate; sample++) {
    audio.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / sampleRate) * 8_000), 44 + sample * 2);
}

const qmcMask = Buffer.from(
    "c34ad6ca9067f752d8a166629f5b0900c35e95239f13117ed8923fbc90bb740e"
        + "c347743d90aa3f51d8f411849fde951dc3c609d59ffa66f9d8f0f7a090a1d6f3",
    "hex",
);
const qmc = Buffer.from(audio);
for (let offset = 0; offset < qmc.length; offset++) {
    const position = (offset > 0x7fff ? offset % 0x7fff : offset) % 128;
    const index = position < 64 ? position : (128 - position) % 64;
    qmc[offset] ^= qmcMask[index];
}

const streamKey = Buffer.from("media-worker-regression-fixture");
const cipher = createCipheriv("aes-128-ecb", Buffer.from("hzHRAmso5kInbaxW"), null);
const encryptedKey = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from("neteasecloudmusic"), streamKey])),
    cipher.final(),
]);
for (let offset = 0; offset < encryptedKey.length; offset++) encryptedKey[offset] ^= 0x64;
const table = Uint8Array.from({ length: 256 }, (_, index) => index);
let cursor = 0;
for (let index = 0; index < table.length; index++) {
    cursor = (cursor + table[index] + streamKey[index % streamKey.length]) % 256;
    [table[index], table[cursor]] = [table[cursor], table[index]];
}
const encryptedAudio = Buffer.from(audio);
for (let offset = 0; offset < encryptedAudio.length; offset++) {
    const index = (offset + 1) % 256;
    const left = table[index];
    const right = table[(index + left) % 256];
    encryptedAudio[offset] ^= table[(left + right) % 256];
}
const ncmHeader = Buffer.alloc(14);
ncmHeader.write("CTENFDAM");
ncmHeader.writeUInt32LE(encryptedKey.length, 10);
const ncm = Buffer.concat([ncmHeader, encryptedKey, Buffer.alloc(17), encryptedAudio]);

async function verifyWorker(prefix, input) {
    const matches = files.filter((file) => file.startsWith(`${prefix}-`) && file.endsWith(".js"));
    assert.equal(matches.length, 1, `${prefix}: expected one compiled JavaScript worker`);
    assert.ok(
        !files.some((file) => file.startsWith(`${prefix}-`) && /\.tsx?$/.test(file)),
        `${prefix}: raw TypeScript was emitted`,
    );
    const file = matches[0];
    assert.ok(
        appBundles.some((code) => code.includes(file)),
        `${prefix}: compiled worker is not referenced by the app`,
    );
    assert.ok(manifest.assets.includes(`assets/${file}`), `${prefix}: worker is missing from the offline manifest`);
    const source = await readFile(new URL(file, assetDirectory), "utf8");
    const messages = [];
    let listener;
    let closed = false;
    const context = createContext({
        crypto: webcrypto,
        FileReaderSync: class {
            readAsArrayBuffer(file) {
                return file.buffer;
            }
        },
        self: {
            addEventListener(type, callback) {
                assert.equal(type, "message");
                assert.equal(listener, undefined);
                listener = callback;
            },
            postMessage(message, transfers) {
                messages.push({ message, transfers });
            },
            close() {
                closed = true;
            },
        },
    });
    new Script(source, { filename: fileURLToPath(new URL(file, assetDirectory)) }).runInContext(context, {
        timeout: 2_000,
    });
    assert.equal(typeof listener, "function", `${prefix}: worker did not register its message handler`);
    const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    let timeout;
    try {
        await Promise.race([
            listener({ data: { buffer } }),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${prefix}: decoding timed out`)), 5_000);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
    assert.equal(messages.length, 1, `${prefix}: expected one result`);
    const { message, transfers } = messages[0];
    assert.equal(message.type, "success", `${prefix}: decoding failed`);
    assert.deepEqual(Buffer.from(message.payload), audio, `${prefix}: decoded audio bytes differ`);
    assert.equal(transfers.length, 1, `${prefix}: decoded audio should be transferred, not copied`);
    assert.equal(transfers[0], message.payload.buffer);
    assert.ok(closed, `${prefix}: worker did not close after decoding`);
    console.log(`${file}: JavaScript, app reference, offline cache and ${audio.length}-byte decoding passed`);
}

await verifyWorker("ncmc-worker", ncm);
await verifyWorker("qmc-worker", qmc);
