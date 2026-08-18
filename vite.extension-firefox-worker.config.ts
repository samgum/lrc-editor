import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    root: resolve("extension"),
    publicDir: false,
    resolve: {
        conditions: ["browser"],
    },
    define: {
        "import.meta.env.mobileExtension": "true",
        "import.meta.env.firefoxAndroid": "true",
    },
    build: {
        target: "firefox128",
        chunkSizeWarningLimit: 750,
        outDir: resolve("extension-firefox-android-dist"),
        emptyOutDir: false,
        minify: true,
        lib: {
            entry: resolve("extension/src/service-worker.ts"),
            name: "LrcEditorMobileBackground",
            formats: ["iife"],
            fileName: () => "service-worker.js",
        },
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
            },
        },
    },
});
