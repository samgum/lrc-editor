export const aiEngineAssetName = (version: string, platform: string): string =>
    /Mac|Linux|X11/i.test(platform)
        ? `lrc-editor-ai-aligner-macos-linux-v${version}.tar.gz`
        : `lrc-editor-ai-aligner-windows-v${version}.zip`;

export const aiEngineDownloadUrl = (releaseUrl: string, version: string, platform: string): string =>
    `${releaseUrl.replace(/\/$/, "")}/download/${aiEngineAssetName(version, platform)}`;
