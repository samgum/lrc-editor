import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    root: resolve("extension"),
    publicDir: resolve("extension/public"),
    resolve: {
        conditions: ["browser"],
    },
    css: {
        transformer: "lightningcss",
    },
    build: {
        target: "chrome120",
        chunkSizeWarningLimit: 750,
        outDir: resolve("extension-dist"),
        emptyOutDir: true,
        minify: true,
        rollupOptions: {
            input: {
                bridge: resolve("extension/src/bridge.ts"),
                popup: resolve("extension/popup.html"),
                "service-worker": resolve("extension/src/service-worker.ts"),
            },
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
            },
        },
    },
});
