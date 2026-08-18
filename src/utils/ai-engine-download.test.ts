import { describe, expect, it } from "vitest";
import { aiEngineDownloadUrl } from "./ai-engine-download.js";

describe("local AI engine download", () => {
    const release = "https://github.com/samgum/lrc-editor/releases/latest";

    it("selects the macOS/Linux archive", () => {
        expect(aiEngineDownloadUrl(release, "0.4.6", "MacIntel")).toBe(
            "https://github.com/samgum/lrc-editor/releases/latest/download/lrc-editor-ai-aligner-macos-linux-v0.4.6.tar.gz",
        );
    });

    it("selects the Windows archive", () => {
        expect(aiEngineDownloadUrl(release, "0.4.6", "Win32")).toBe(
            "https://github.com/samgum/lrc-editor/releases/latest/download/lrc-editor-ai-aligner-windows-v0.4.6.zip",
        );
    });
});
