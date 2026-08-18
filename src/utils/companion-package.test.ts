import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const companionRoot = resolve("companion");

describe("local AI companion package", () => {
    it("ships a self-contained Windows installer and launcher", () => {
        for (
            const file of [
                "install-ai-aligner.ps1",
                "install-ai-aligner.cmd",
                "start-ai-aligner.ps1",
                "start-ai-aligner.cmd",
                "install-ai-aligner.sh",
                "start-ai-aligner.sh",
                "install-ai-aligner.command",
                "start-ai-aligner.command",
                "README.md",
                "README-zh.md",
                "INSTALL.txt",
            ]
        ) {
            expect(existsSync(resolve(companionRoot, file))).toBe(true);
        }
        expect(readdirSync(companionRoot).some((file) => file.endsWith(".py"))).toBe(false);
    });

    it("uses fixed local directories and the verified engine revision", () => {
        const installer = readFileSync(resolve(companionRoot, "install-ai-aligner.ps1"), "utf8");
        expect(installer).toContain("LRC Editor\\AI Aligner");
        expect(installer).toContain("4898a3cbc569349c5db87bbc931c9d6fa124d64d");
        expect(installer).toContain("Join-Path $resolvedInstallRoot \"models\"");
        expect(installer).toContain("Join-Path $resolvedInstallRoot \"runtime\"");
        expect(installer).toContain("Read-Host \"Choose installation location [1/2/3]\"");
        expect(installer).toContain("EstimateOnly");
        expect(installer).toContain("\"--managed-python\", \"--no-bin\", \"--no-registry\"");
        expect(installer).toContain("UV_MANAGED_PYTHON");
    });

    it("downloads models through the upstream model libraries", () => {
        const installer = readFileSync(resolve(companionRoot, "install-ai-aligner.ps1"), "utf8");
        expect(installer).toContain("from demucs.pretrained import get_model");
        expect(installer).toContain("https://dl.fbaipublicfiles.com/demucs/");
        expect(installer).toContain("from faster_whisper import download_model");
        expect(installer).toContain("https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo");
    });

    it("keeps CUDA private and preserves a CPU fallback", () => {
        const windowsInstaller = readFileSync(resolve(companionRoot, "install-ai-aligner.ps1"), "utf8");
        const windowsLauncher = readFileSync(resolve(companionRoot, "start-ai-aligner.ps1"), "utf8");
        const unixInstaller = readFileSync(resolve(companionRoot, "install-ai-aligner.sh"), "utf8");
        const unixLauncher = readFileSync(resolve(companionRoot, "start-ai-aligner.sh"), "utf8");

        for (const source of [windowsInstaller, unixInstaller]) {
            expect(source).toContain("nvidia-cublas-cu12==12.8.4.1");
            expect(source).toContain("nvidia-cudnn-cu12==9.8.0.87");
            expect(source).toContain("CPU compatibility mode");
            expect(source).toContain("large-v3-turbo");
        }
        expect(windowsLauncher).toContain("Join-Path $sitePackages \"cublas\\bin\"");
        expect(unixLauncher).toContain("nvidia/cublas/lib");
        expect(windowsLauncher).toContain("$env:CUDA_VISIBLE_DEVICES = \"-1\"");
        expect(unixLauncher).toContain("export CUDA_VISIBLE_DEVICES=-1");
    });
});
