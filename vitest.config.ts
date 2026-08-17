import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@lrc-maker/lrc-parser": resolve("node_modules/@lrc-maker/lrc-parser/build/esm/lrc-parser.js"),
        },
    },
    test: {
        environment: "node",
    },
});
