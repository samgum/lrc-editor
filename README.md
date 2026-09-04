<p align="center">
  <img src="./public/favicons/lrc-editor.svg" width="96" height="96" alt="LRC Editor logo">
</p>

<p align="center">
  <strong>English</strong> · <a href="./README-zh.md">简体中文</a>
</p>

# LRC Editor

LRC Editor is a browser-based workspace for editing LRC files and assigning timestamps while audio or video is playing. The production site is intended for `lrc.sgmy.org`.

The web application is static and keeps lyric text, preferences, and local media processing in the browser. YouTube, Bilibili, NetEase, and complete publicly playable QQ Music links are handled by an optional Manifest V3 companion extension, so the site does not require a media-resolution backend. Optional alignment can use the separate local engine or the user-keyed Huhu AI Beta; the latter is called directly by the browser without an LRC Editor proxy.

## Features

- Import plain text, standard or Enhanced LRC, binary or plaintext KRC, TTML, and SRT. Every supported file first opens as stable line-timed lyrics; when genuine word timestamps are present, the editor offers a choice between staying in line mode and switching to word mode.
- Keep advanced formats disabled by default. After enabling them in Settings, ordinary line timing and focused word timing use separate navigation pages; the editor alone switches between line text and structured word editing.
- Edit word or syllable text, line boundaries, word starts, and word ends in a structured word editor. Duplicate, backwards, and invalid word timing is marked on the exact segment and its row instead of being silently repaired.
- Time words on a separate focused page with a compact line queue, previous/current/next context, a large active-word readout, an active-line timing lane, separate playback and last-stamped clocks, and unmistakable selected/playing states. Tap mode records rapid consecutive starts; hold mode records a word from key/pointer down to release. Rap-oriented controls add input compensation, replay lead-in, 0.5×/0.75×/1×/1.25× speed presets, one-step even line drafts, focused re-recording, next-untimed navigation, range preview, fine-tuning, and undo/redo. Captures are kept at least 10 ms apart, and a cancelled hold rolls back cleanly.
- Switch between line and word modes without discarding timing, the active word, or unfinished progress. Line-time edits are reconciled when returning to word mode; unchanged timed lines keep their word axis, while only edited text lines are safely re-segmented. Progress and the word cursor are also restored after refresh.
- Segment mixed-language lyrics by script and language behavior: CJK glyph timing, dictionary segmentation for supported no-space scripts, intact Latin contractions and hyphenated words, contextual quote/bracket attachment, and exactly one space between Latin words without producing standalone space timing units. Imported opening punctuation is moved to the following segment, so `xxx(` + `next` becomes `xxx` + `(next` without changing timing or text.
- Default every editor export to Standard LRC. Line mode can explicitly switch to line SRT, line TTML, or plain text; word mode can explicitly switch to Enhanced LRC, binary KRC, word TTML, or ASS karaoke with real `\kf` centisecond tags. Standard SRT has no word-level karaoke timing, so its option is deliberately labeled and exported as line timing only.
- Drop media anywhere in the workspace, or drop LRC, Enhanced LRC, KRC, TTML, SRT, and text lyric axes. Existing lyric work is protected by a replacement confirmation; one media file and one lyric file can be loaded together. The media dialog also provides a full-card target with format guidance, current-media summary, animated loading state, and a separate link workflow. Direct media URLs, NetEase Music song links and `163cn.tv` shares, QQ Music `c6.y.qq.com` shares and `y.qq.com/.../songDetail/...` links, standard or Music YouTube links (including extra playlist parameters), and Bilibili or `b23.tv` links are supported. A complete share message can be pasted directly; the first HTTP(S) URL is extracted automatically. QQ Music support is limited to tracks whose complete audio is publicly playable at that moment; VIP-only and preview-only responses are rejected.
- Convert imported local FLAC/ALAC/AIFF/CAF media once to 256 kbps AAC with FFmpeg WebAssembly. Playback and AI alignment share only the current in-memory AAC Blob, so the AI bridge never reopens or transfers the much larger lossless source. The virtual input/output files and FFmpeg Worker are destroyed after every conversion; replacing the media revokes the previous Blob URL, and no converted audio is written to persistent browser storage.
- Display a waveform for local or extension-resolved media, seek precisely, change playback speed, keep playback alive across workspace-page changes, and continue in the background when enabled. Media Session controls provide play, pause, and seek actions where the browser supports them.
- Add, replace, delete, fine-tune, or batch-shift timestamps with keyboard or pointer controls. The default correction step is 100 ms; `Shift` halves it and `Alt` reduces it to one fifth for keyboard adjustments.
- Switch line timing between Standard timing and the dedicated Waveform timing workspace. Its timeline stays fixed while audio plays, with a luminous playback cursor, hover-time guide, click marker, and exact result feedback. Normal scrolling moves the timeline; `Shift` + scroll or the zoom slider changes time scale without rebuilding the player. Clicking updates only the current line start so it can be corrected repeatedly; `S` starts continuous playback from the current line, `F`/`Shift+F` pages the timeline, and `G` confirms and selects the next line. Optional click-to-auto-advance and play-from-new-start settings are independent and disabled by default. With play-from-new-start disabled, clicking changes neither playback position nor playing/paused state; enabling it explicitly seeks to the clicked start and plays. Clicking an existing timestamp explicitly plays from that line.
- Mark every duplicated timestamp row and each row that moves backwards with a full-width warning background, left rail, warning icon, and accessible issue label.
- Keep the selected line centered, record from a persistent timing toolbar, and undo or redo timestamp edits.
- Configure every timing and playback shortcut from the key-binding screen.
- Keep editing state and preferences locally between sessions.
- Optionally align the loaded media to the current editor lyrics with the local `lyrics-forced-aligner` models. Old timestamps are removed before processing, output precision follows the editor setting, and strict validation rejects duplicate or decreasing axes before one undoable replacement is applied. The progress card estimates remaining time without entering the inference path.
- Open the translation-axis workspace first to build a translated LRC from untimed lyrics. Replacement is strictly positional: leading, internal, and timed blank placeholders are preserved, every source timestamp remains unchanged, and extra translated lines cannot alter the NetEase-compatible axis. Every tool result remains editable before it is applied, copied, or downloaded. Tag cleanup also removes a bracketed lyric-document title such as `[YOASOBI「Biri-Biri」歌詞]` when it is the first meaningful line, together with known section tags, without treating the same title later in the lyrics as a header.
- Convert word-timed Enhanced LRC, KRC, or TTML into line-timed Standard LRC, SRT, Line TTML, or plain text from the Tools page. The converter can reuse the current editor word data or load a separate lyric file, reports the detected format and timing counts, and keeps both source and result editable.
- Use the integrated Lyrics Tools functions to remove Genius section labels, clean copied tracklists, replace plain text or regular expressions in bulk, and convert lyric case without changing timestamps.
- Switch between system, light, and dark themes; choose an accent color.
- Navigate categorized Settings sections for general/language, media/playback, timing workflow, advanced lyrics/AI, appearance/output, timing precision, and storage/about.
- Use English, Japanese, Korean, Polish, Brazilian Portuguese, Slovak, Simplified Chinese, Traditional Chinese (Hong Kong), or Traditional Chinese (Taiwan).
- Install the site as a PWA and receive shared media URLs through the Web Share Target API.
- Reopen the editor, timing workspace, tools, settings, and bundled language interface without a network connection after the first successful online visit. Remote media and first-time model or codec downloads still require a connection.
- Use the advanced-format interface in every bundled language. Imports preserve real TTML span timing and whitespace, keep line-timed TTML as line timing, and retain background-vocal text without forcing overlapping harmony timestamps into a backwards linear axis.

GitHub Gist integration from the upstream project is intentionally not included. LRC Editor never inserts a `[tool: ...]` metadata line.

## Media companion extension

LRC Editor Media Bridge accepts only validated YouTube or Bilibili video identifiers, constrained NetEase links, and validated QQ Music share or song-detail links from the LRC Editor page. It resolves streams locally. NetEase and QQ Music audio are materialized as temporary in-memory Blobs so playback, waveform rendering, and AI alignment use the same bytes without writing the audio to persistent browser storage. QQ Music playback metadata is read through a restricted 1×1 temporary frame hosted offscreen on desktop or in the current editor tab on mobile; the resolver requires the public `pay_play=0` and full-playback state and rejects trial resources. Scoped browser rules supply only the Bilibili referer and QQ Music mobile playback header required by those flows.

Download the current unpacked extension package from [GitHub Releases](https://github.com/samgum/lrc-editor/releases/latest).

Extract the complete ZIP before loading it. Browser security always requires a manual **Load unpacked** confirmation.

Chrome installation:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted `lrc-editor-media-bridge-v0.4.6` directory.
4. Reload LRC Editor after installing or replacing the extension.

Microsoft Edge uses `edge://extensions` with the same **Developer mode** and **Load unpacked** steps. On Windows, `INSTALL-EXTENSION.cmd` opens the management page and extracted directory but cannot perform the final confirmation.

- The temporary URL and audio data are not added to browser history, persistent storage, logs, or a project server. Original YouTube, Bilibili, NetEase, or QQ Music input is retained only for the current tab session so a refresh can resolve it again.
- The extension does not read site cookies, tabs, browsing history, or account data.
- YouTube playback integrity data is obtained through an invisible muted embed, which is closed immediately without opening a tab or window.
- The localized popup opens LRC Editor and shows the supported platforms.
- Host permissions are limited to the YouTube, Bilibili, NetEase, QQ Music share/playback and media CDN endpoints used by the resolvers, the LRC Editor site, and loopback access for the optional local aligner.
- Direct media URLs remain available as a manual fallback.

The YouTube resolver uses the private InnerTube interface through `youtubei.js`; the Bilibili resolver uses public web-player endpoints; the QQ Music resolver reads its official public share-page playback state without cookies. Any integration can stop working when a platform changes its clients or playback requirements. Use is subject to the platform terms and the laws applicable to the media.

The current YouTube maintenance pass follows [yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) client changes without adding yt-dlp or Python as a runtime dependency. It handles gzip-compressed player requests, refreshes the embedded client version from the browser on each resolution, keeps playback tokens bound to the requested video, and removes retired Android VR/TV-embedded fallbacks. Audio URL refreshes must retain the same format before range chunks are combined. There is no daily monitoring task or remotely executed code: metadata refresh is automatic when used, but algorithm changes still require a new extension build. Replace and reload the unpacked extension even when the project version remains v0.4.6; `YOUTUBE-RESOLVER.txt` identifies this package.

### Mobile extensions

The same resolver core now produces two separate mobile packages:

- `lrc-editor-media-bridge-edge-mobile-v0.4.6.zip` is a Manifest V3 submission package for Microsoft Edge Mobile on Android and iOS. It uses the current editor tab instead of the Chromium-only offscreen permission.
- `lrc-editor-media-bridge-firefox-android-v0.4.6.zip` is a Manifest V2 Firefox Android package with a non-persistent event page because Firefox Android does not support Manifest V3 background service workers. It declares no data collection and requires Firefox Android 142 or later.

Both packages keep media URLs and bytes local, request no cookie, tab-history, account, or native-messaging permission, and support the Cloudflare and GitHub Pages site addresses. Edge Mobile installation requires a signed Microsoft Edge Add-ons listing. Persistent Firefox installation requires Mozilla signing; `web-ext` can temporarily load the extracted package on a development device.

The current faster-whisper/Demucs alignment engine does not run on a phone. The mobile bridge rejects AI uploads before reading media bytes and directs the user to the desktop version. Authenticated desktop pairing is the intended next step; the loopback-only desktop service will not be exposed to the LAN without a separate pairing security design.

## Optional local AI alignment

AI alignment is disabled by default. The labeled **AI** button remains visible in the editor; clicking it enables the feature and starts the requested alignment. Before that click, the page does not probe local ports, transfer media, or create a model task. Repeated clicks reopen the same progress card, while the extension and local service reject concurrent duplicate jobs.

Media Bridge v0.4.6 is the only browser extension: media resolution and local AI bridging are combined in the same package. The AI installer below is an optional local model engine, not a second browser extension.

Windows, macOS, and Linux companion installers keep the managed runtime, bundled verified engine snapshot, and models in one user-selected directory. They install an isolated uv-managed Python runtime internally, so users do not need a system Python installation or Python commands. NVIDIA CUDA is private to the companion on Windows/Linux; macOS and unsupported GPUs use the complete CPU path. Installation offers the official Hugging Face source or HF-Mirror; mirror-mode Demucs files must match all four complete official SHA-256 hashes before use. Per-task audio, outputs, and analysis work are deleted after the selected LRC has reached the editor unless **Keep and reuse AI task cache** is explicitly enabled in Settings. Website cache and local AI task cache have separate controls; neither task cleanup nor the AI cache control removes model weights or the private runtime. See the [local AI alignment guide](./companion/README.md).

## Huhu AI alignment (Beta)

The editor can send the current in-memory media copy and timestamp-free editor lyrics directly from the browser to `https://huhu.cdgz.top/api/v1`. LRC Editor has no proxy for this path and never receives the user's Huhu API key. Japanese, English, Japanese-English, Simplified Chinese, and Chinese-English requests are selectable, and completed LRC results pass the same line-count/timing validation before replacing editor timing.

Huhu results keep every nonblank lyric and its original timestamp. If a generated blank separator overlaps the next line, its timestamp is fitted into the available gap at the selected precision. Blank lines are not deleted, and actual lyric timestamps are not shifted. If a unique timeline cannot be preserved, or the returned lyrics differ, the editor stays unchanged and identifies the result-validation problem instead of reporting that the remote alignment failed. Already completed results remain available in Huhu; they do not need a new alignment job.

Audio uploads to either alignment service keep the local filename, or the original name with an `.m4a` extension when a lossless file was converted. YouTube links use public title/author metadata to form `Title - Artist.m4a` (or the actual audio container extension); the channel suffix `- Topic` is omitted. Metadata lookup is browser-only and best-effort, with a video-ID filename fallback, so a failed lookup does not prevent loading the audio or require an extension update. Direct media URLs preserve a recognizable filename without including query tokens.

The default Huhu language selection is **Auto**; saved manual choices remain available. Detection runs locally on the submitted lyrics and sends one supported language, never `auto`, to Huhu. Kana selects Japanese, or Japanese-English when at least three lines are entirely English or contain an English word. Without kana, the same three-line threshold selects Chinese-English; otherwise Chinese is used. English text with no CJK characters selects English regardless of line count. Each line counts once; punctuation, numbers, emoji, and unsupported symbols do not count, and isolated single letters inside CJK lines are not English words.

The key is encrypted in browser IndexedDB with a non-exportable Web Crypto key. After saving, the application displays only whether a key exists: it never refills, reveals, or offers to copy the stored value. Users can enter a new key to replace it or clear it completely. This protects against accidental UI disclosure, not malicious same-origin code or a compromised device, so keys should be stored only on trusted devices.

Direct browser access is enabled by the Huhu API for `https://lrc.sgmy.org`: its preflight allows `Authorization` and `Content-Type`, and responses use a cross-origin resource policy. The GitHub Pages backup origin is intentionally not allowed, so its Huhu controls are disabled and identify the main site as the supported entry point. No Worker or LRC Editor backend fallback is used.

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
- `extension-edge-mobile-dist/`: Edge Mobile MV3 package
- `extension-firefox-android-dist/`: Firefox Android MV2 package

To test the extension locally, open the browser's extension management page, enable developer mode, choose **Load unpacked**, and select `extension-dist/`. The manifest allows the bridge only on `localhost`, `127.0.0.1`, `lrc.sgmy.org`, and the exact `samgum.github.io/lrc-editor/` backup path.

## Deployment

Deploy the contents of `build/` to any static HTTPS host. The included Dockerfile builds the web application and serves it with nginx.

The production project uses Cloudflare Pages without a Worker runtime:

```bash
pnpm build
pnpm exec wrangler pages deploy build --project-name lrc-editor
```

The offline Service Worker runs in the visitor's browser and does not add a Pages Function or Cloudflare Worker. Cloudflare documents static asset requests on Pages as free and unlimited on both free and paid plans: [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/#static-asset-requests).

Cloudflare deployment remains manual. Every successful push to `main` is also checked, tested, built, and automatically published by [the GitHub Pages workflow](./.github/workflows/pages.yml) to the independent backup site at [samgum.github.io/lrc-editor](https://samgum.github.io/lrc-editor/).

The extensions are packaged separately. Build the desktop package with `pnpm build:extension`, or both mobile packages with `pnpm build:extension:mobile`. After committing a release version, `./scripts/package-release.ps1` creates the desktop, Edge Mobile, and Firefox Android extension archives, both companion archives with the bundled engine, and `SHA256SUMS.txt`.

## Project structure

```text
src/                 React application, line/word lyric formats, localization, and tests
worker/              Local NCM/QMC media workers
extension/           Shared extension source plus desktop and mobile manifests
companion/           Local AI installer, launcher, documentation, and bundled engine snapshot
public/              PWA metadata and brand assets
build/               Web build output
extension-dist/      Extension build output
extension-edge-mobile-dist/       Edge Mobile build output
extension-firefox-android-dist/    Firefox Android build output
```

## Credits

LRC Editor is developed and maintained by [伤感咩吖](https://github.com/samgum).

Source and interaction references include:

- [lrc-maker](https://github.com/magic-akari/lrc-maker), by magic-akari
- [lrc-maker-cdgz](https://github.com/CDGZ-ofc/lrc-maker-cdgz), by 重叠广州 / CDGZ-ofc
- [lrc-utils](https://github.com/magic-akari/lrc-utils), by magic-akari
- [lyrics-tools](https://github.com/samgum/lyrics-tools), by samgum
- [Aegisub modified fork](https://github.com/samgum/Aegisub), by the Aegisub Project and samgum; the S/F/G audio workflow is an interaction reference under Aegisub's own license, not copied source code
- [Bundled local AI alignment engine](./companion/engine-bundle/README.md), by 伤感咩吖

The media companion bundles [YouTube.js](https://github.com/LuanRT/YouTube.js), by LuanRT and contributors, under the MIT license. Local codec fallback uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), also under the MIT license.

## License

This project is distributed under the [MIT License](./LICENSE). The original copyright notices are retained.
