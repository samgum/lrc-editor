import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packages = [
    { kind: "edge", root: resolve("extension-edge-mobile-dist") },
    { kind: "firefox", root: resolve("extension-firefox-android-dist") },
];

for (const item of packages) {
    const manifest = JSON.parse(readFileSync(resolve(item.root, "manifest.json"), "utf8"));
    const required = new Set([
        ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
        ...(manifest.background?.scripts || []),
        ...(manifest.action?.default_popup ? [manifest.action.default_popup] : []),
        ...(manifest.browser_action?.default_popup ? [manifest.browser_action.default_popup] : []),
        ...manifest.content_scripts.flatMap((entry) => entry.js || []),
        ...Object.values(manifest.icons || {}),
        ...(manifest.declarative_net_request?.rule_resources.map((entry) => entry.path) || []),
        "INSTALL.txt",
    ]);
    for (const path of required) {
        assert(existsSync(resolve(item.root, path)), `${item.kind} package is missing ${path}`);
    }
    assert(!existsSync(resolve(item.root, "INSTALL-EXTENSION.cmd")), `${item.kind} package contains a desktop CMD`);
    assert(!existsSync(resolve(item.root, "INSTALL-EXTENSION.txt")), `${item.kind} package contains the desktop guide`);

    if (item.kind === "edge") {
        assert(manifest.manifest_version === 3, "Edge Mobile must use Manifest V3");
        assert(!manifest.permissions.includes("offscreen"), "Edge Mobile must use the tab frame fallback");
    } else {
        assert(manifest.manifest_version === 2, "Firefox Android must use Manifest V2");
        assert(manifest.background?.persistent === false, "Firefox Android must use a non-persistent event page");
        assert(
            manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required?.[0] === "none",
            "Firefox Android must declare that it collects no data",
        );
        const background = readFileSync(resolve(item.root, "service-worker.js"), "utf8");
        assert(background.startsWith("(function()"), "Firefox Android background must be a classic IIFE script");
        assert(
            !background.includes("chrome.offscreen"),
            "Firefox Android background contains the unsupported offscreen API",
        );
        assert(
            !background.includes("declarativeNetRequest"),
            "Firefox Android background contains the unsupported declarativeNetRequest API",
        );
    }
}

process.stdout.write("Mobile extension packages validated.\n");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
