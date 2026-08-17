import { execSync } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { swc } from "rollup-plugin-swc3";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import sw_plugin from "./plugins/sw-plugin";

const hash = execSync("git rev-parse --short HEAD").toString().trim();
const updateTime = execSync("git log -1 --format=%cI").toString().trim();

const json_suffix = ".json";
const lang_dir = "src/languages";

const langFileList = readdirSync(lang_dir).filter((filename) => filename.endsWith(json_suffix));
langFileList.sort();

interface LangContent {
    languageName: string;
}

const langMap = await Promise.all(
    langFileList.map(async (f) => {
        const filePath = join(lang_dir, f);
        const fileContent = await readFile(filePath, {
            encoding: "utf-8",
        });

        const langCode = f.slice(0, -json_suffix.length);
        const langJson = JSON.parse(fileContent) as LangContent;
        const languageName = langJson.languageName;
        return [langCode, languageName] as const;
    }),
);

export default defineConfig({
    clearScreen: false,
    json: {
        namedExports: false,
    },
    plugins: [
        swc(),
        ffmpegCoreAssets(),
        sw_plugin(),
    ],
    base: "./",
    define: {
        "import.meta.env.app": JSON.stringify({ hash, updateTime, version: pkg.version }),
        "i18n.langCodeList": JSON.stringify(langFileList.map((f) => f.slice(0, -json_suffix.length))),
        "i18n.langMap": JSON.stringify(langMap),
    },
    css: {
        transformer: "lightningcss",
    },
    build: {
        minify: true,
        cssMinify: "lightningcss",
        outDir: "build",
        modulePreload: {
            polyfill: false,
        },
        rollupOptions: {
            input: ["index.html", "worker/sw.ts"],
            output: {
                entryFileNames(chunkInfo) {
                    if (chunkInfo.name === "sw") {
                        return "sw.js";
                    }
                    return "assets/[name]-[hash].js";
                },
            },
        },
    },
});

function ffmpegCoreAssets(): Plugin {
    const directory = join(process.cwd(), "node_modules", "@ffmpeg", "core", "dist", "esm");
    const coreFile = "ffmpeg-core.js";
    const wasmFile = "ffmpeg-core.wasm";
    const manifestFile = `${wasmFile}.manifest.json`;
    const chunkSize = 16 * 1024 * 1024;

    const createManifest = (size: number) => ({
        size,
        parts: Array.from({ length: Math.ceil(size / chunkSize) }, (_, index) => `${wasmFile}.part${index}`),
    });

    return {
        name: "ffmpeg-core-assets",
        configureServer(server) {
            server.middlewares.use("/ffmpeg", (request, response, next) => {
                const file = request.url?.split("?", 1)[0].replace(/^\//, "");
                if (!file) {
                    next();
                    return;
                }

                if (file === coreFile) {
                    response.setHeader("Content-Type", "text/javascript");
                    createReadStream(join(directory, coreFile)).on("error", next).pipe(response);
                    return;
                }

                const wasmPath = join(directory, wasmFile);
                const wasmSize = statSync(wasmPath).size;
                const manifest = createManifest(wasmSize);
                if (file === manifestFile) {
                    response.setHeader("Content-Type", "application/json");
                    response.end(JSON.stringify(manifest));
                    return;
                }

                const partIndex = manifest.parts.indexOf(file);
                if (partIndex === -1) {
                    next();
                    return;
                }

                const start = partIndex * chunkSize;
                const end = Math.min(wasmSize, start + chunkSize) - 1;
                response.setHeader("Content-Type", "application/octet-stream");
                response.setHeader("Content-Length", (end - start + 1).toString());
                createReadStream(wasmPath, { start, end }).on("error", next).pipe(response);
            });
        },
        async generateBundle() {
            const wasm = await readFile(join(directory, wasmFile));
            const manifest = createManifest(wasm.byteLength);

            this.emitFile({
                type: "asset",
                fileName: `ffmpeg/${coreFile}`,
                source: await readFile(join(directory, coreFile)),
            });
            this.emitFile({
                type: "asset",
                fileName: `ffmpeg/${manifestFile}`,
                source: JSON.stringify(manifest),
            });
            for (const [index, file] of manifest.parts.entries()) {
                this.emitFile({
                    type: "asset",
                    fileName: `ffmpeg/${file}`,
                    source: wasm.subarray(index * chunkSize, Math.min(wasm.byteLength, (index + 1) * chunkSize)),
                });
            }
        },
    };
}
