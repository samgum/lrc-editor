import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const fix = process.argv.includes("--fix");

const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const expectedVersion = packageJson.version;

if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    console.error(`Invalid version in package.json: ${String(expectedVersion)}`);
    process.exit(1);
}

const jsonManifestPaths = [
    "extension/public/manifest.json",
    "extension/mobile/edge-manifest.json",
    "extension/mobile/firefox-android-manifest.json",
];

const textTargets = [
    {
        path: "extension/public/INSTALL-EXTENSION.txt",
        patterns: [
            /(LRC Editor Media Bridge v)(\d+\.\d+\.\d+)/g,
            /(lrc-editor-ai-aligner-windows-v)(\d+\.\d+\.\d+)(\.zip)/g,
            /(lrc-editor-ai-aligner-macos-linux-v)(\d+\.\d+\.\d+)(\.tar\.gz)/g,
        ],
    },
    {
        path: "extension/public/INSTALL-EXTENSION.cmd",
        patterns: [/(LRC Editor Media Bridge v)(\d+\.\d+\.\d+)/g],
    },
    {
        path: "extension/public/YOUTUBE-RESOLVER.txt",
        patterns: [
            /(Media Bridge v)(\d+\.\d+\.\d+)/g,
            /(媒体扩展 v)(\d+\.\d+\.\d+)/g,
        ],
    },
    {
        path: "companion/INSTALL.txt",
        patterns: [/(lrc-editor-media-bridge-v)(\d+\.\d+\.\d+)(\.zip)/g],
    },
    {
        path: "companion/INSTALL-macOS.txt",
        patterns: [
            /(lrc-editor-ai-aligner-macos-linux-v)(\d+\.\d+\.\d+)(\.tar\.gz)/g,
            /(lrc-editor-media-bridge-v)(\d+\.\d+\.\d+)(\.zip)/g,
        ],
    },
    {
        path: "companion/INSTALL-Linux.txt",
        patterns: [
            /(lrc-editor-ai-aligner-macos-linux-v)(\d+\.\d+\.\d+)(\.tar\.gz)/g,
            /(lrc-editor-media-bridge-v)(\d+\.\d+\.\d+)(\.zip)/g,
        ],
    },
];

const mismatches = [];

for (const relPath of jsonManifestPaths) {
    const absPath = resolve(rootDir, relPath);
    const raw = readFileSync(absPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== expectedVersion) {
        mismatches.push(`${relPath}: expected ${expectedVersion}, found ${parsed.version}`);
        if (fix) {
            const updated = raw.replace(
                /("version"\s*:\s*")([^"]+)(")/,
                `$1${expectedVersion}$3`,
            );
            writeFileSync(absPath, updated, "utf8");
        }
    }
}

for (const target of textTargets) {
    const absPath = resolve(rootDir, target.path);
    const raw = readFileSync(absPath, "utf8");
    let updated = raw;
    let matchedAny = false;

    for (const pattern of target.patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(raw)) !== null) {
            matchedAny = true;
            const foundVersion = match[2];
            if (foundVersion !== expectedVersion) {
                mismatches.push(`${target.path}: expected ${expectedVersion}, found ${foundVersion}`);
            }
        }
        if (fix) {
            updated = updated.replace(pattern, (_full, prefix, _ver, suffix = "") => {
                return `${prefix}${expectedVersion}${suffix}`;
            });
        }
    }

    if (!matchedAny) {
        mismatches.push(`${target.path}: no version marker found`);
    } else if (fix && updated !== raw) {
        writeFileSync(absPath, updated, "utf8");
    }
}

if (mismatches.length > 0 && !fix) {
    console.error("Version mismatch detected (run `node scripts/check-version.mjs --fix` to sync):");
    for (const item of mismatches) {
        console.error(`  - ${item}`);
    }
    process.exit(1);
}

console.log(`Version check passed (${expectedVersion}).`);
