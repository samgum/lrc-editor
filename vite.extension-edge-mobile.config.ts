import { createExtensionConfig } from "./vite.extension.shared";

export default createExtensionConfig({
    outDir: "extension-edge-mobile-dist",
    mobile: true,
    manifestPath: "extension/mobile/edge-manifest.json",
    guidePath: "extension/mobile/INSTALL-Edge-Mobile.txt",
});
