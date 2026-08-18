<p align="center">
  <img src="./public/favicons/lrc-editor.svg" width="96" height="96" alt="LRC Editor logo">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README-zh.md">简体中文</a>
</p>

# LRC Editor

LRC Editor is a browser-based workspace for editing LRC files and assigning timestamps while audio or video is playing. The production site is intended for `lrc.sgmy.org`.

The web application is static and keeps lyric text, preferences, and local media processing in the browser. YouTube and Bilibili links are handled by an optional Manifest V3 companion extension, so the site does not require a media-resolution backend. Optional AI alignment runs through a separate local engine only when the user enables and starts it.

## Features

- Import plain text, `.txt`, and `.lrc` files; edit title, artist, and album metadata.
- Copy or download LRC output with configurable timestamp precision and whitespace.
- Load audio and video files, direct media URLs, NetEase Music song links, standard or Music YouTube links (including extra playlist parameters), and Bilibili or `b23.tv` links.
- Convert imported local FLAC/ALAC/AIFF/CAF media once to 256 kbps AAC with FFmpeg WebAssembly. Playback and AI alignment share only the current in-memory AAC Blob, so the AI bridge never reopens or transfers the much larger lossless source. The virtual input/output files and FFmpeg Worker are destroyed after every conversion; replacing the media revokes the previous Blob URL, and no converted audio is written to persistent browser storage.
- Display a waveform for local or extension-resolved media, seek precisely, change playback speed, and continue playback in the background when enabled.
- Add, replace, delete, fine-tune, or batch-shift timestamps with keyboard or pointer controls. The default correction step is 100 ms; `Shift` halves it and `Alt` reduces it to one fifth for keyboard adjustments.
- Mark every duplicated timestamp row and each row that moves backwards with a full-width warning background, left rail, warning icon, and accessible issue label.
- Keep the selected line centered, record from a persistent timing toolbar, and undo or redo timestamp edits.
- Configure every timing and playback shortcut from the key-binding screen.
- Keep editing state and preferences locally between sessions.
- Optionally align the loaded media to the current editor lyrics with the local `lyrics-forced-aligner` models. Old timestamps are removed before processing, output precision follows the editor setting, and strict validation rejects duplicate or decreasing axes before one undoable replacement is applied. The progress card estimates remaining time without entering the inference path.
- Open the translation-axis workspace first to build a translated LRC from untimed lyrics. Replacement is strictly positional: leading, internal, and timed blank placeholders are preserved, every source timestamp remains unchanged, and extra translated lines cannot alter the NetEase-compatible axis. Additional tools remove tags or empty lines, transform timestamps, and split translations.
- Use the integrated Lyrics Tools functions to remove Genius section labels, clean copied tracklists, replace plain text or regular expressions in bulk, and convert lyric case without changing timestamps.
- Switch between system, light, and dark themes; choose an accent color.
- Use English, Japanese, Korean, Polish, Brazilian Portuguese, Slovak, Simplified Chinese, Traditional Chinese (Hong Kong), or Traditional Chinese (Taiwan).
- Install the site as a PWA and receive shared media URLs through the Web Share Target API.
- Reopen the editor, timing workspace, tools, settings, and bundled language interface without a network connection after the first successful online visit. Remote media and first-time model or codec downloads still require a connection.

GitHub Gist integration from the upstream project is intentionally not included. LRC Editor never inserts a `[tool: ...]` metadata line.

## Media companion extension

LRC Editor Media Bridge accepts only validated YouTube or Bilibili video identifiers from the LRC Editor page. It resolves the stream locally and transfers the required audio into an in-memory Blob. A scoped browser rule supplies the Bilibili media referer required for loading its audio.

Download the current unpacked extension package from [GitHub Releases](https://github.com/samgum/lrc-editor/releases/latest).

Extract the complete ZIP before loading it. Browser security always requires a manual **Load unpacked** confirmation.

Chrome installation:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted `lrc-editor-media-bridge-v0.4.6` directory.
4. Reload LRC Editor after installing or replacing the extension.

Microsoft Edge uses `edge://extensions` with the same **Developer mode** and **Load unpacked** steps. On Windows, `INSTALL-EXTENSION.cmd` opens the management page and extracted directory but cannot perform the final confirmation.

- The temporary URL and audio data are not added to browser history, storage, logs, or a project server. The original YouTube or Bilibili input is retained only for the current tab session so a refresh can request a new temporary URL.
- The extension does not read site cookies, tabs, browsing history, or account data.
- YouTube playback integrity data is obtained through an invisible muted embed, which is closed immediately without opening a tab or window.
- The localized popup opens LRC Editor and shows the supported platforms.
- Host permissions are limited to the YouTube, Bilibili, and media CDN endpoints used by the resolvers, the LRC Editor site, and loopback access for the optional local aligner.
- Direct media URLs remain available as a manual fallback.

The YouTube resolver uses the private InnerTube interface through `youtubei.js`; the Bilibili resolver uses public web-player endpoints. Either integration can stop working when a platform changes its clients or playback requirements. Use is subject to the platform terms and the laws applicable to the media.

## Optional local AI alignment

AI alignment is disabled by default. The labeled **AI** button remains visible in the editor; clicking it enables the feature and starts the requested alignment. Before that click, the page does not probe local ports, transfer media, or create a model task. Repeated clicks reopen the same progress card, while the extension and local service reject concurrent duplicate jobs.

Media Bridge v0.4.6 is the only browser extension: media resolution and local AI bridging are combined in the same package. The AI installer below is an optional local model engine, not a second browser extension.

Windows, macOS, and Linux companion installers keep the managed runtime, bundled verified engine snapshot, and models in one user-selected directory. They install an isolated uv-managed Python runtime internally, so users do not need a system Python installation or Python commands. NVIDIA CUDA is private to the companion on Windows/Linux; macOS and unsupported GPUs use the complete CPU path. Installation offers the official Hugging Face source or HF-Mirror; mirror-mode Demucs files must match all four complete official SHA-256 hashes before use. Per-task audio, outputs, and analysis work are deleted after the selected LRC has reached the editor unless **Keep and reuse AI task cache** is explicitly enabled in Settings. Website cache and local AI task cache have separate controls; neither task cleanup nor the AI cache control removes model weights or the private runtime. See the [local AI alignment guide](./companion/README.md).

Every platform package includes matching start, stop, and uninstall commands. Uninstall requires typing `UNINSTALL` and then the complete installation path before it removes the engine, models, private runtime, and task data.
The website downloads the correct platform-specific Windows or macOS/Linux engine archive directly. Launchers in a downloaded package resolve the recorded installation directory or platform default without asking for a path. If no complete installation exists, the start launcher offers to install first and then continues starting automatically. The website can stop an already-running service through the extension, but it cannot launch an executable after the service has closed without the broader `nativeMessaging` permission, which this project does not request.

## Development

Requirements:

- Node.js matching [`.node-version`](./.node-version)
- pnpm 10

```bash
pnpm install
pnpm start
```

Vite prints the local development URL. Open it in a modern Chromium, Firefox, or Safari browser.

## Build and verification

```bash
pnpm typecheck
pnpm test
pnpm check:lint
pnpm check:fmt
pnpm build:all
```

Outputs:

- `build/`: static web application
- `extension-dist/`: unpacked Chrome/Edge extension

To test the extension locally, open the browser's extension management page, enable developer mode, choose **Load unpacked**, and select `extension-dist/`. The development manifest allows the bridge on `localhost`, `127.0.0.1`, and `lrc.sgmy.org` only.

## Deployment

Deploy the contents of `build/` to any static HTTPS host. The included Dockerfile builds the web application and serves it with nginx.

The production project uses Cloudflare Pages without a Worker runtime:

```bash
pnpm build
pnpm exec wrangler pages deploy build --project-name lrc-editor
```

The offline Service Worker runs in the visitor's browser and does not add a Pages Function or Cloudflare Worker. Cloudflare documents static asset requests on Pages as free and unlimited on both free and paid plans: [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/#static-asset-requests).

The extension is packaged separately. Build it with `pnpm build:extension`, then distribute the resulting `extension-dist/` directory or submit the same packaged code to a Chromium extension store. After committing a release version, `./scripts/package-release.ps1` creates the extension archive, both companion archives with the bundled engine, and `SHA256SUMS.txt`.

## Project structure

```text
src/                 React application, LRC logic, localization, and tests
worker/              Local NCM/QMC media workers
extension/           Manifest V3 source and manifest
companion/           Local AI installer, launcher, documentation, and bundled engine snapshot
public/              PWA metadata and brand assets
build/               Web build output
extension-dist/      Extension build output
```

## Credits

LRC Editor is developed and maintained by [伤感咩吖](https://github.com/samgum).

The implementation studies and adapts MIT-licensed work from:

- [lrc-maker](https://github.com/magic-akari/lrc-maker), by magic-akari
- [lrc-maker-cdgz](https://github.com/CDGZ-ofc/lrc-maker-cdgz), by 重叠广州 / CDGZ-ofc
- [lrc-utils](https://github.com/magic-akari/lrc-utils), by magic-akari
- [lyrics-tools](https://github.com/samgum/lyrics-tools), by samgum
- [Bundled local AI alignment engine](./companion/engine-bundle/README.md), by 伤感咩吖

The media companion bundles [YouTube.js](https://github.com/LuanRT/YouTube.js), by LuanRT and contributors, under the MIT license. Local codec fallback uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), also under the MIT license.

## License

This project is distributed under the [MIT License](./LICENSE). The original copyright notices are retained.
