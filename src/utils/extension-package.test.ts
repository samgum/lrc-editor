import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve("extension/public");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8")) as {
    default_locale: string;
    icons: Record<string, string>;
    host_permissions: string[];
    permissions: string[];
    declarative_net_request: { rule_resources: Array<{ path: string }> };
    version: string;
};

describe("extension package", () => {
    it("contains every manifest asset and rule resource", () => {
        for (const path of Object.values(manifest.icons)) {
            expect(existsSync(resolve(extensionRoot, path))).toBe(true);
        }
        for (const resource of manifest.declarative_net_request.rule_resources) {
            expect(existsSync(resolve(extensionRoot, resource.path))).toBe(true);
        }
    });

    it("applies Bilibili media headers to playback and waveform requests", () => {
        const rulePath = manifest.declarative_net_request.rule_resources[0].path;
        const rules = JSON.parse(readFileSync(resolve(extensionRoot, rulePath), "utf8")) as Array<{
            action: { responseHeaders?: Array<{ header: string }> };
            condition: { resourceTypes: string[] };
        }>;
        expect(manifest.version).toBe("0.3.2");
        expect(rules[0].condition.resourceTypes).toEqual(expect.arrayContaining(["media", "xmlhttprequest"]));
        expect(rules[1].condition.resourceTypes).toEqual(expect.arrayContaining(["media", "xmlhttprequest"]));
        expect(rules[1].action.responseHeaders?.map((header) => header.header)).toContain(
            "Access-Control-Allow-Origin",
        );
    });

    it("ships complete popup localization for every locale", () => {
        const required = ["extensionDescription", "extensionName", "openEditor", "supportedSources"];
        const localeRoot = resolve(extensionRoot, "_locales");
        const locales = readdirSync(localeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        expect(locales.map((entry) => entry.name)).toContain(manifest.default_locale);

        for (const locale of locales) {
            const messages = JSON.parse(
                readFileSync(resolve(localeRoot, locale.name, "messages.json"), "utf8"),
            ) as Record<string, { message: string }>;
            expect(Object.keys(messages).sort()).toEqual(required);
            expect(Object.values(messages).every((value) => value.message.trim().length > 0)).toBe(true);
        }
    });

    it("keeps host permissions constrained to the supported media flow", () => {
        expect(manifest.host_permissions).toEqual([
            "https://www.youtube.com/*",
            "https://youtubei.googleapis.com/*",
            "https://*.googlevideo.com/*",
            "https://api.bilibili.com/*",
            "https://www.bilibili.com/*",
            "https://b23.tv/*",
            "https://*.bilivideo.com/*",
            "https://lrc.sgmy.org/*",
            "http://localhost/*",
            "http://127.0.0.1/*",
        ]);
        expect(manifest.permissions).toEqual([
            "declarativeNetRequestWithHostAccess",
            "offscreen",
            "webRequest",
        ]);
    });
});
