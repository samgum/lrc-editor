import { createExtensionConfig } from "./vite.extension.shared";

export default createExtensionConfig({
    outDir: "extension-firefox-android-dist",
    mobile: true,
    firefox: true,
    includeServiceWorker: false,
    manifestPath: "extension/mobile/firefox-android-manifest.json",
    guidePath: "extension/mobile/INSTALL-Firefox-Android.txt",
});
