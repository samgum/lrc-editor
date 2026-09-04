import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = resolve("extension/public");
const mobileRoot = resolve("extension/mobile");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8")) as {
    default_locale: string;
    icons: Record<string, string>;
    host_permissions: string[];
    permissions: string[];
    declarative_net_request: { rule_resources: Array<{ path: string }> };
    version: string;
};
const edgeMobileManifest = JSON.parse(readFileSync(resolve(mobileRoot, "edge-manifest.json"), "utf8")) as {
    action: { default_popup: string };
    manifest_version: number;
    permissions: string[];
    version: string;
};
const firefoxAndroidManifest = JSON.parse(
    readFileSync(resolve(mobileRoot, "firefox-android-manifest.json"), "utf8"),
) as {
    background: { persistent: boolean; scripts: string[] };
    browser_action: { default_popup: string };
    browser_specific_settings: {
        gecko: { data_collection_permissions: { required: string[] }; id: string };
        gecko_android: { strict_min_version: string };
    };
    manifest_version: number;
    permissions: string[];
    version: string;
};

describe("extension package", () => {
    it("includes clear unpacked-extension installation helpers", () => {
        expect(existsSync(resolve(extensionRoot, "INSTALL-EXTENSION.cmd"))).toBe(true);
        expect(existsSync(resolve(extensionRoot, "INSTALL-EXTENSION.txt"))).toBe(true);
        expect(readFileSync(resolve(extensionRoot, "YOUTUBE-RESOLVER.txt"), "utf8")).toContain("yt-dlp 2026.08.19");
    });

    it("keeps the classic content script free of runtime imports", () => {
        const bridgeSource = readFileSync(resolve("extension/src/bridge.ts"), "utf8");
        expect(bridgeSource).not.toMatch(/^import\s+(?!type\b)/m);
    });

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
        expect(manifest.version).toBe("0.4.6");
        expect(rules[0].condition.resourceTypes).toEqual(expect.arrayContaining(["media", "xmlhttprequest"]));
        expect(rules[1].condition.resourceTypes).toEqual(expect.arrayContaining(["media", "xmlhttprequest"]));
        expect(rules[1].action.responseHeaders?.map((header) => header.header)).toContain(
            "Access-Control-Allow-Origin",
        );
        for (const rule of rules.slice(2)) {
            expect(rule.condition.resourceTypes).toContain("xmlhttprequest");
            expect(rule.action.responseHeaders?.map((header) => header.header)).toContain(
                "Access-Control-Allow-Origin",
            );
        }
    });

    it("ships complete popup localization for every locale", () => {
        const required = [
            "extensionDescription",
            "extensionName",
            "localAiAlignment",
            "mobileAiDesktop",
            "neteaseShareLinks",
            "openEditor",
            "qqMusicLinks",
            "supportedSources",
        ];
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
            "https://163cn.tv/*",
            "https://music.163.com/*",
            "https://*.music.163.com/*",
            "http://*.music.126.net/*",
            "https://*.music.126.net/*",
            "https://c6.y.qq.com/*",
            "https://i.y.qq.com/*",
            "https://i2.y.qq.com/*",
            "https://aqqmusic.tc.qq.com/*",
            "https://lrc.sgmy.org/*",
            "https://samgum.github.io/*",
            "http://localhost/*",
            "http://127.0.0.1/*",
        ]);
        expect(manifest.permissions).toEqual([
            "declarativeNetRequestWithHostAccess",
            "offscreen",
            "webRequest",
        ]);
    });

    it("defines separate Edge Mobile and Firefox Android packages", () => {
        expect(edgeMobileManifest).toMatchObject({
            manifest_version: 3,
            version: manifest.version,
            action: { default_popup: "popup-mobile.html" },
        });
        expect(edgeMobileManifest.permissions).toContain("declarativeNetRequestWithHostAccess");
        expect(edgeMobileManifest.permissions).not.toEqual(
            expect.arrayContaining(["cookies", "nativeMessaging", "offscreen", "tabs"]),
        );
        expect(firefoxAndroidManifest).toMatchObject({
            manifest_version: 2,
            version: manifest.version,
            background: { persistent: false, scripts: ["service-worker.js"] },
            browser_action: { default_popup: "popup-mobile.html" },
        });
        expect(firefoxAndroidManifest.permissions).toContain("webRequestBlocking");
        expect(firefoxAndroidManifest.permissions).not.toEqual(
            expect.arrayContaining(["cookies", "nativeMessaging", "offscreen", "tabs"]),
        );
        expect(firefoxAndroidManifest.browser_specific_settings.gecko.id).toBe(
            "lrc-editor-media-bridge@sgmy.org",
        );
        expect(firefoxAndroidManifest.browser_specific_settings.gecko.data_collection_permissions.required)
            .toEqual(["none"]);
        expect(Number.parseInt(firefoxAndroidManifest.browser_specific_settings.gecko_android.strict_min_version))
            .toBeGreaterThanOrEqual(142);
        expect(existsSync(resolve(mobileRoot, "INSTALL-Edge-Mobile.txt"))).toBe(true);
        expect(existsSync(resolve(mobileRoot, "INSTALL-Firefox-Android.txt"))).toBe(true);
    });
});
