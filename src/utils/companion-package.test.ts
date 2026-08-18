import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const companionRoot = resolve("companion");
const engineRoot = resolve("companion", "engine");

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
                "resolve-ai-aligner-install.ps1",
                "resolve-ai-aligner-install.sh",
                "start-ai-aligner.command",
                "stop-ai-aligner.ps1",
                "stop-ai-aligner.cmd",
                "stop-ai-aligner.sh",
                "stop-ai-aligner.command",
                "uninstall-ai-aligner.ps1",
                "uninstall-ai-aligner.cmd",
                "uninstall-ai-aligner.sh",
                "uninstall-ai-aligner.command",
                "README.md",
                "README-zh.md",
                "INSTALL.txt",
                "INSTALL-macOS.txt",
                "INSTALL-Linux.txt",
                "ai-constraints.txt",
                "lrc_editor_companion_server.py",
            ]
        ) {
            expect(existsSync(resolve(companionRoot, file))).toBe(true);
        }
        expect(readdirSync(companionRoot).filter((file) => file.endsWith(".py")).sort()).toEqual([
            "lrc_editor_companion_server.py",
        ]);
    });

    it("uses a pinned private uv and portable macOS Python arguments", () => {
        const installer = readFileSync(resolve(companionRoot, "install-ai-aligner.sh"), "utf8");
        expect(installer).toContain("uv_version=\"0.12.5\"");
        expect(installer).toContain("uv_command=\"$uv_tools/uv\"");
        expect(installer).toContain("installed_uv_version=\"$(\"$uv_command\" --version");
        expect(installer).not.toContain("installed_uv_version=\"$($uv_command --version");
        expect(installer).toContain("UV_PYTHON_INSTALL_BIN=0");
        expect(installer).not.toContain("--no-bin");
        expect(installer).toContain("python install 3.11 --install-dir \"$python_root\" --managed-python");
    });

    it("resolves installations from downloaded launchers", () => {
        const unixResolver = readFileSync(resolve(companionRoot, "resolve-ai-aligner-install.sh"), "utf8");
        const windowsResolver = readFileSync(resolve(companionRoot, "resolve-ai-aligner-install.ps1"), "utf8");
        const unixInstaller = readFileSync(resolve(companionRoot, "install-ai-aligner.sh"), "utf8");
        const windowsInstaller = readFileSync(resolve(companionRoot, "install-ai-aligner.ps1"), "utf8");
        for (const resolver of [unixResolver, windowsResolver]) {
            expect(resolver).toContain("install-location.txt");
            expect(resolver).toContain("install-state.json");
        }
        expect(unixInstaller).toContain("lrc_ai_location_registry");
        expect(windowsInstaller).toContain("ai-aligner-location.txt");
    });

    it("ships operating-system-specific guides and lifecycle commands", () => {
        const macGuide = readFileSync(resolve(companionRoot, "INSTALL-macOS.txt"), "utf8");
        const windowsGuide = readFileSync(resolve(companionRoot, "INSTALL.txt"), "utf8");
        const windowsUninstaller = readFileSync(resolve(companionRoot, "uninstall-ai-aligner.ps1"), "utf8");
        const unixUninstaller = readFileSync(resolve(companionRoot, "uninstall-ai-aligner.sh"), "utf8");
        expect(macGuide).toContain("Right-click install-ai-aligner.command and choose Open");
        expect(macGuide).toContain("stop-ai-aligner.command");
        expect(windowsGuide).toContain("install-ai-aligner.cmd");
        for (const uninstaller of [windowsUninstaller, unixUninstaller]) {
            expect(uninstaller).toContain("UNINSTALL");
            expect(uninstaller).toContain("Second confirmation");
        }
    });

    it("links the in-app installer prompt to the current release page", () => {
        const editor = readFileSync(resolve("src/components/editor.tsx"), "utf8");
        expect(editor).toContain("BRAND.extensionRelease");
        expect(editor).not.toContain("tree/main/companion");
    });

    it("uses fixed local directories and the verified engine revision", () => {
        const installer = readFileSync(resolve(companionRoot, "install-ai-aligner.ps1"), "utf8");
        expect(installer).toContain("LRC Editor\\AI Aligner");
        expect(installer).toContain("4898a3cbc569349c5db87bbc931c9d6fa124d64d");
        expect(installer).toContain("Install-BundledEngine");
        expect(installer).not.toContain("github.com/samgum/lyrics-forced-aligner");
        expect(installer).toContain("Join-Path $resolvedInstallRoot \"models\"");
        expect(installer).toContain("Join-Path $resolvedInstallRoot \"runtime\"");
        expect(installer).toContain("Read-Host \"Choose installation location [1/2/3]\"");
        expect(installer).toContain("EstimateOnly");
        expect(installer).toContain("\"--managed-python\", \"--no-bin\", \"--no-registry\"");
        expect(installer).toContain("UV_MANAGED_PYTHON");
        expect(installer).toContain("--constraints");
        expect(installer).toContain("\"cache\", \"clean\"");
    });

    it("bundles only the pinned runtime engine without private repository history", () => {
        expect(readFileSync(resolve(engineRoot, "ENGINE_REVISION"), "utf8").trim()).toBe(
            "4898a3cbc569349c5db87bbc931c9d6fa124d64d",
        );
        for (
            const path of [
                "pyproject.toml",
                "README.md",
                "README-zh.md",
                "LICENSE",
                "src/lyrics_aligner/server.py",
                "web/index.html",
            ]
        ) {
            expect(existsSync(resolve(engineRoot, path))).toBe(true);
        }
        for (const path of [".git", "tests", "training", "benchmarks", "runtime", ".cache"]) {
            expect(existsSync(resolve(engineRoot, path))).toBe(false);
        }
        const unixInstaller = readFileSync(resolve(companionRoot, "install-ai-aligner.sh"), "utf8");
        expect(unixInstaller).toContain("bundled_engine_root");
        expect(unixInstaller).not.toContain("git clone");
    });

    it("runs the LRC Editor wrapper and exposes task cache cleanup", () => {
        const wrapper = readFileSync(resolve(companionRoot, "lrc_editor_companion_server.py"), "utf8");
        const windowsLauncher = readFileSync(resolve(companionRoot, "start-ai-aligner.ps1"), "utf8");
        const unixLauncher = readFileSync(resolve(companionRoot, "start-ai-aligner.sh"), "utf8");
        expect(wrapper).toContain("@app.delete(\"/api/jobs/{job_id}/cache\")");
        expect(wrapper).toContain("@app.post(\"/api/lrc-editor/jobs/{job_id}/cancel\")");
        expect(wrapper).toContain("@app.delete(\"/api/lrc-editor/cache\")");
        expect(wrapper).toContain("@app.post(\"/api/lrc-editor/service/stop\")");
        expect(wrapper).toContain("reclaimed_bytes");
        expect(wrapper).toContain("service.pid");
        expect(windowsLauncher).toContain("-m lrc_editor_companion_server");
        expect(unixLauncher).toContain("-m lrc_editor_companion_server");
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
            expect(source).toContain("torch==2.11.0");
            expect(source).toContain("demucs");
        }
        expect(windowsLauncher).toContain("Join-Path $sitePackages \"cublas\\bin\"");
        expect(unixLauncher).toContain("nvidia/cublas/lib");
        expect(windowsLauncher).toContain("$env:CUDA_VISIBLE_DEVICES = \"-1\"");
        expect(unixLauncher).toContain("export CUDA_VISIBLE_DEVICES=-1");
    });
});
