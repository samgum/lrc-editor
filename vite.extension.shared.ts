import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin, type UserConfig } from "vite";

interface ExtensionBuildOptions {
    firefox?: boolean;
    guidePath?: string;
    includeOffscreen?: boolean;
    includeServiceWorker?: boolean;
    manifestPath?: string;
    mobile?: boolean;
    outDir: string;
}

export const createExtensionConfig = (options: ExtensionBuildOptions): UserConfig => {
    const mobile = options.mobile ?? false;
    const input: Record<string, string> = {
        bridge: resolve("extension/src/bridge.ts"),
        popup: resolve(mobile ? "extension/popup-mobile.html" : "extension/popup.html"),
        "qqmusic-frame": resolve("extension/src/qqmusic-frame.ts"),
    };
    if (options.includeOffscreen ?? !mobile) input.offscreen = resolve("extension/offscreen.html");
    if (options.includeServiceWorker ?? true) input["service-worker"] = resolve("extension/src/service-worker.ts");

    return defineConfig({
        root: resolve("extension"),
        publicDir: resolve("extension/public"),
        resolve: {
            conditions: ["browser"],
        },
        define: {
            "import.meta.env.mobileExtension": JSON.stringify(mobile),
            "import.meta.env.firefoxAndroid": "false",
        },
        css: {
            transformer: "lightningcss",
        },
        plugins: mobile
            ? [finalizeMobilePackage(options.outDir, options.manifestPath, options.guidePath, options.firefox)]
            : [],
        build: {
            target: options.firefox ? "firefox128" : "chrome120",
            chunkSizeWarningLimit: 750,
            outDir: resolve(options.outDir),
            emptyOutDir: true,
            minify: true,
            rollupOptions: {
                input,
                output: {
                    entryFileNames: "[name].js",
                    chunkFileNames: "chunks/[name]-[hash].js",
                },
            },
        },
    });
};

const finalizeMobilePackage = (
    outDir: string,
    manifestPath?: string,
    guidePath?: string,
    firefox?: boolean,
): Plugin => ({
    name: "finalize-mobile-extension-package",
    closeBundle() {
        const output = resolve(outDir);
        if (!manifestPath || !guidePath) throw new Error("The mobile extension manifest and guide are required");
        copyFileSync(resolve(manifestPath), resolve(output, "manifest.json"));
        copyFileSync(resolve(guidePath), resolve(output, "INSTALL.txt"));
        rmSync(resolve(output, "INSTALL-EXTENSION.cmd"), { force: true });
        rmSync(resolve(output, "INSTALL-EXTENSION.txt"), { force: true });
        if (firefox) rmSync(resolve(output, "rules"), { force: true, recursive: true });
    },
});
