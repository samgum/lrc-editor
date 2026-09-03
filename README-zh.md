<p align="center">
  <img src="./public/favicons/lrc-editor.svg" width="96" height="96" alt="LRC Editor 标志">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# LRC Editor

LRC Editor 是用于编辑 LRC 歌词并配合音频或视频制作时间轴的浏览器工作台，生产站点计划使用 `lrc.sgmy.org`。

主站是纯静态 Web 应用。歌词、设置和本地媒体处理都留在浏览器中。YouTube、哔哩哔哩、网易云，以及能公开完整播放的 QQ 音乐链接由可选的 Manifest V3 配套扩展在本机解析，因此站点不需要媒体解析后端。可选对轴既可使用独立本机引擎，也可使用由用户自行提供 Key 的 Huhu AI Beta；后者由浏览器直接调用，不经过 LRC Editor 代理。

## 功能

- 导入纯文本、标准／Enhanced LRC、二进制或明文 KRC、TTML 和 SRT。所有受支持文件都会先稳定转换成逐行歌词；只有检测到真实逐字时间时，才会询问保持逐行模式还是切换到逐字模式。
- 高级歌词格式默认关闭。用户在设置中开启后，普通逐行打轴与专注逐字打轴使用两个独立导航页面；只有编辑器内部在逐行文本和结构化逐字编辑之间切换。
- 在结构化逐字编辑器中修改字词或音节文本、行开始／结束和字词开始／结束。重复、倒退和无效逐字时间会同时醒目标在具体片段与整行上，不会被程序静默修正。
- 逐字打轴使用单独页面：主工作台旁是紧凑行队列，并同时显示上一行／当前行／下一行、放大的当前字词、当前行时间轨、播放时间与上次记录时间。点按模式适合连续记录密集起点；按住模式从按下到松开记录完整字词时长。Rap 提效控件包括敲击补偿、回听预卷、0.5×／0.75×／1×／1.25× 快捷速度、整行均分草稿、从当前字词局部重录、跳到下一个未打轴字词、区间试听、微调和独立撤销／重做。连续记录至少间隔 10 ms，按住过程中取消或窗口失焦会完整回滚本次动作。
- 逐行与逐字模式往返不会丢失时间、当前字词或未完成进度。返回逐字时会同步逐行修改的行时间；未改文字的行保留既有逐字轴，只有文字发生变化的行才安全重新分词。刷新后也会恢复逐字文档和字词光标。
- 混合语言按脚本与语言习惯分词：中日韩保持字形打轴，支持无空格语言的词语分段，英文缩写与连字符词保持完整，引号／括号按上下文附着，并把拉丁单词之间规范为恰好一个空格，不生成单独的空格时间块。导入数据若把左括号留在上一片段末尾，会无损迁移到下一片段，因此 `xxx(`／`next` 会变为 `xxx`／`(next`，不改变文字或时间。
- 编辑器导出始终默认标准 LRC。逐行模式可主动选择逐行 SRT、逐行 TTML 或纯文本；逐字模式可主动选择 Enhanced LRC、二进制 KRC、逐字 TTML，或包含真实百分之一秒 `\kf` 标签的 ASS 卡拉 OK 字幕。标准 SRT 不支持逐字卡拉 OK 时间，因此界面明确标成“SRT（逐行）”，导出时也只保留逐行轴。
- 可把媒体拖到工作区任意位置，也可直接拖入 LRC、Enhanced LRC、KRC、TTML、SRT 与文本歌词轴；已有歌词会先显示覆盖确认，媒体与歌词各一个时可同时拖入。载入媒体弹窗仍提供完整卡片式投放区、格式说明、当前媒体与解析状态；媒体链接使用独立分区。支持媒体直链、网易云音乐歌曲链接与 `163cn.tv` 分享链接、QQ 音乐 `c6.y.qq.com` 分享链接与 `y.qq.com/.../songDetail/...` 长链接、普通或 Music YouTube 链接（包括附带播放列表参数的链接）、哔哩哔哩链接和 `b23.tv` 短链。可直接粘贴完整分享文案，页面会自动提取其中第一个 HTTP(S) 链接。QQ 音乐仅载入当下无需登录即可完整播放的歌曲；VIP 与仅试听资源会明确拒绝。
- 本地导入 FLAC／ALAC／AIFF／CAF 时，使用 FFmpeg WebAssembly 一次性转为 256 kbps AAC；播放与 AI 对轴只共用当前这一份内存 AAC Blob，不会为 AI 再读取或传输体积更大的无损源文件。每次转换结束都会删除 FFmpeg 虚拟输入／输出并终止 Worker；换歌时撤销上一份 Blob URL，转换结果不会写入浏览器持久存储。
- 为本地媒体和扩展解析媒体显示波形，支持精确跳转与播放速度调节；站内切换编辑、打轴、工具和设置时不中断，开启相应设置后切到后台也继续播放。浏览器支持时还可使用系统媒体面板播放、暂停和跳转。
- 使用键盘或指针添加、覆盖、删除、微调时间标签，也可整体平移全部时间标签。默认微调量为 100 ms；键盘操作配合 `Shift` 可减半，配合 `Alt` 可缩小至五分之一。
- 逐行打轴可在“常规打轴”和独立的“波形打轴”工作区之间切换。播放时波形时间窗保持固定，并显示醒目的播放光柱、悬停时间指针、点击落点与精确结果；普通滚轮移动波形，`Shift + 滚轮`或缩放滑杆调整时间比例，连续缩放会合并为一次重绘。点击只更新当前行开始时间，可反复校准；`S` 从当前行开始时间持续播放，`F`／`Shift+F` 左右翻时间轴，`G` 确认后选择下一行。设置中的“点击后自动下一行”和“设置起点后立即播放”互相独立且默认关闭；关闭立即播放时，点击既不改变播放器位置，也不改变播放／暂停状态；开启后才会明确跳到点击位置并播放。点击已有时间戳会明确地从该行开始播放。波形／频谱、缩放、显示振幅和模式选择都会保存在本地。
- 对所有重复时间戳行和发生倒退的具体行显示整行警示底色、左侧警示条、矢量警示图标及可访问的问题名称。
- 选中行自动居中，通过常驻打轴工具栏记录时间，并可撤销或重做时间修改。
- 在键位设置页修改全部打轴与播放快捷键。
- 在浏览器本地保存歌词状态和设置。
- 可使用本机 `lyrics-forced-aligner` 模型，把当前已载入媒体与编辑器歌词自动对齐。处理前会移除旧时间戳，输出精度跟随编辑器设置；应用前严格拒绝重复或倒序时间轴，最终作为一次可撤销操作写入。进度卡会用已有进度轻量估算剩余时间，不进入模型推理路径。
- 工具页默认首先打开翻译时间轴，并严格按行套用无时间翻译：开头空行、内部空行和定时空行占位均会保留，全部原时间戳保持不变，多余译文也不能改变网易云兼容轴。所有工具的“结果”文本框都可在应用、复制或下载前继续删改；标签清理还会删除位于歌词首个有效行的 `[YOASOBI「Biri-Biri」歌詞]` 一类标题头和已知段落标签，但不会把正文后方相同的方括号文字误当成开头标题。
- 在实用工具中把逐字 Enhanced LRC、KRC 或 TTML 转为逐行标准 LRC、SRT、逐行 TTML 或纯文本。转换器既可直接读取编辑器当前逐字数据，也可单独载入歌词文件；会显示识别格式、行数和定时片段数，原文与结果都能继续修改。
- 合并 Lyrics Tools 功能：清理 Genius 段落标签、清理复制的曲目列表、批量普通／正则替换，以及不破坏时间戳的歌词大小写转换。
- 支持跟随系统、亮色和暗色模式，以及自定义强调色。
- 设置页按常规与语言、媒体与播放、打轴工作流、高级歌词与 AI、外观与歌词输出、时间精度、存储与关于分组显示。
- 支持英语、日语、韩语、波兰语、巴西葡萄牙语、斯洛伐克语、简体中文、繁体中文（香港）和繁体中文（台湾）。
- 可安装为 PWA，并通过 Web Share Target 接收分享的媒体链接。
- 首次联网成功访问后，断网仍可重新打开编辑、打轴、工具、设置及内置多语言界面；远程媒体、首次模型下载和首次编解码资源下载仍需联网。
- 高级格式界面覆盖全部内置语言。TTML 导入保留真实 `span` 时间和空白；只有行时间的 TTML 不会伪造逐字轴；背景和声文字会保留，但不会把并行和声时间强塞进线性轴而制造倒序。

本项目明确不包含上游的 GitHub Gist 功能，也不会自动写入 `[tool: ...]` 元信息。

## 媒体配套扩展

LRC Editor Media Bridge 只接收主站验证过的 YouTube／哔哩哔哩视频标识、受限的网易云链接，以及通过校验的 QQ 音乐分享或歌曲详情链接。扩展在本机解析音频；网易云和 QQ 音乐音频会转成仅存在于内存的临时 Blob，让播放、波形和 AI 对轴共用同一份数据，不写入浏览器持久存储。QQ 音乐播放信息通过受限的 1×1 临时页面读取：桌面端使用离屏页面，移动端使用当前编辑器标签页；解析器必须确认公开 `pay_play=0` 且允许完整播放，并拒绝试听资源。浏览器规则只补充哔哩哔哩 Referer 与 QQ 音乐流程所需的移动播放请求头。

可从 [GitHub Releases](https://github.com/samgum/lrc-editor/releases/latest) 下载当前版本的可解压安装扩展包。

必须先完整解压 ZIP 再加载；受浏览器安全机制限制，最后一步始终需要手动确认。

Chrome 安装步骤：

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择解压后的 `lrc-editor-media-bridge-v0.4.6` 目录。
4. 首次安装或替换扩展后刷新 LRC Editor。

Microsoft Edge 打开 `edge://extensions`，其余“开发者模式”和“加载已解压的扩展程序”步骤相同。Windows 可双击 `INSTALL-EXTENSION.cmd` 自动打开管理页与解压目录，但不能代替最后的人工确认。

- 临时媒体地址和音频数据不会写入浏览器历史、持久存储、日志或项目服务器；只在当前标签页会话中记录原始 YouTube／哔哩哔哩／网易云／QQ 音乐链接，以便刷新时重新解析。
- 扩展不读取站点 Cookie、标签页、浏览历史或账号信息。
- YouTube 播放完整性数据通过不可见的静音嵌入页获取，使用后立即关闭，不会打开标签页或窗口。
- 多语言扩展弹窗可打开 LRC Editor，并显示当前支持的平台。
- 域名权限仅覆盖解析器使用的 YouTube、哔哩哔哩、网易云、QQ 音乐分享／播放及媒体 CDN 端点、LRC Editor 站点，以及可选本机对齐器所需的回环地址。
- 媒体资源直链仍可作为手动备用方案。

YouTube 解析器通过 `youtubei.js` 使用非公开 InnerTube 接口；哔哩哔哩解析器使用网页播放器接口；QQ 音乐解析器不使用 Cookie，只读取官方公开分享页的播放状态。平台客户端或播放要求变化时，对应功能可能失效。使用者需遵守平台条款和媒体所在地区的适用法律。

### 移动端扩展

同一套解析核心现在会生成两套互相独立的移动安装包：

- `lrc-editor-media-bridge-edge-mobile-v0.4.6.zip`：面向 Android／iOS Microsoft Edge Mobile 的 Manifest V3 提交包，不申请 Chromium 桌面专用的 offscreen 权限，改用当前编辑器标签页承载临时页面。
- `lrc-editor-media-bridge-firefox-android-v0.4.6.zip`：使用 Manifest V2 非持久 Event Page；原因是 Firefox Android 不支持 Manifest V3 后台 Service Worker。包内声明不收集数据，并要求 Firefox Android 142 或更高版本。

两套移动包都不会上传媒体，不申请 Cookie、标签页历史、账号或 `nativeMessaging` 权限，并同时支持 Cloudflare 与 GitHub Pages 地址。Edge Mobile 需要在 Microsoft Edge 扩展商店签名上架后安装；Firefox 长期安装需要 Mozilla 签名，开发设备可使用 `web-ext` 临时载入解压目录。

现有 faster-whisper／Demucs AI 对轴引擎不能在手机运行。移动扩展会在读取音频字节前拒绝 AI 上传，并引导用户使用桌面端。安全的电脑配对是下一阶段；在完成独立配对鉴权设计之前，不会把当前仅限回环地址的桌面服务直接暴露到局域网。

## 可选本机 AI 对轴

AI 对轴默认关闭，但编辑器会始终显示带文字的“AI”按钮；点击按钮会启用功能并开始本次对轴。在点击前，页面不会探测本机端口、传输媒体或创建模型任务。重复点击只会重新显示同一个进度卡，扩展和本机服务还会拒绝并行的重复任务。

Media Bridge v0.4.6 是唯一需要安装的浏览器扩展：媒体解析和本机 AI 桥接已经合并在同一个包里。下方 AI 安装器是可选的本机模型引擎，不是第二个浏览器扩展。

Windows、macOS 和 Linux 安装器会把隔离运行环境、内置的固定引擎快照与模型统一放在用户选择的一个目录中。安装器会在内部准备 uv 管理的 Python 运行环境，用户无需安装系统 Python，也不需要使用 Python 命令。Windows/Linux 的 NVIDIA CUDA 只在组件目录内生效；macOS 和不受支持的显卡使用功能完整的 CPU 路径。安装时可选择 Hugging Face 官方源或 HF-Mirror；镜像模式下载的四个 Demucs 文件必须全部通过完整官方 SHA-256 校验才会使用。默认会在选定 LRC 返回编辑器后删除本次音频、输出和分析工作文件；只有在设置中明确开启“保留并复用 AI 对轴任务缓存”才会保留。网站缓存与本机 AI 缓存使用两个独立入口；任务清理和 AI 缓存清理都不会删除模型权重或私有运行环境。具体步骤见[本机 AI 对轴指南](./companion/README-zh.md)。

## Huhu AI 对轴（Beta）

编辑器可以把当前内存中的媒体副本和去除时间戳后的编辑器歌词，由浏览器直接发送到 `https://huhu.cdgz.top/api/v1`。这条路径不经过 LRC Editor 代理，本站不会接收用户的 Huhu API Key。用户可选择日语、英语、日英混合、简体中文或中英混合；完成后的 LRC 会通过与本机对轴相同的行数和时间校验，确认有效后才替换编辑器时间轴。

Key 使用不可导出的 Web Crypto 密钥加密保存在浏览器 IndexedDB。保存后应用只显示“是否已保存”，不会回填、显示或提供复制已存 Key 的入口；用户只能输入新 Key 替换，或将其彻底清空。这能避免界面误泄露，但不能防御同源恶意代码或已被控制的设备，因此只应在可信设备保存。

Huhu API 已允许 `https://lrc.sgmy.org` 的浏览器直连：预检会放行 `Authorization` 与 `Content-Type`，并返回跨域资源策略。GitHub Pages 备用来源没有被允许，因此备用站会禁用 Huhu Key 写入与调用，并明确引导使用主站。本项目不会为此增加 Worker 或 LRC Editor 后端代理。

各平台安装包都提供对应的启动、停止和卸载命令。卸载时必须先输入 `UNINSTALL`，再完整输入安装路径，确认两次后才会删除引擎、模型、私有运行环境和任务数据。
网页会直接下载真正按平台拆分的 Windows 或 macOS/Linux 引擎压缩包。下载目录中的启动器会自动查找安装器记录的位置或系统默认位置，不再要求手动输入路径；如果没有完整安装，启动器会询问是否先安装，并在安装成功后自动继续启动。网页可通过扩展停止已经运行的服务，但服务关闭后若不申请权限范围更大的 `nativeMessaging`，浏览器就不能直接启动本机程序；本项目不会申请这项权限。

## 本地开发

环境要求：

- 与 [`.node-version`](./.node-version) 一致的 Node.js
- pnpm 10

```bash
pnpm install
pnpm start
```

Vite 会输出本地访问地址，请使用现代 Chromium、Firefox 或 Safari 浏览器打开。

## 构建与验证

```bash
pnpm typecheck
pnpm test
pnpm check:lint
pnpm check:fmt
pnpm build:all
```

输出目录：

- `build/`：静态 Web 应用
- `extension-dist/`：可解压安装的 Chrome/Edge 扩展
- `extension-edge-mobile-dist/`：Edge Mobile MV3 安装包
- `extension-firefox-android-dist/`：Firefox Android MV2 安装包

本地测试扩展时，打开浏览器扩展管理页，启用开发者模式，选择“加载已解压的扩展程序”，然后选择 `extension-dist/`。扩展清单只允许桥接 `localhost`、`127.0.0.1`、`lrc.sgmy.org` 和精确的 `samgum.github.io/lrc-editor/` 备用路径。

## 部署

把 `build/` 中的内容部署到任意静态 HTTPS 主机即可。仓库内的 Dockerfile 会构建站点并使用 nginx 提供服务。

生产项目使用不带 Worker 运行时的 Cloudflare Pages：

```bash
pnpm build
pnpm exec wrangler pages deploy build --project-name lrc-editor
```

离线 Service Worker 运行在访问者浏览器中，不会新增 Pages Function 或 Cloudflare Worker。Cloudflare 官方说明 Pages 静态资源请求在免费与付费计划中均免费且不限量：[Pages 计费说明](https://developers.cloudflare.com/pages/functions/pricing/#static-asset-requests)。

Cloudflare 继续手动部署。每次成功推送到 `main` 后，[GitHub Pages 工作流](./.github/workflows/pages.yml)还会自动完成检查、测试、构建，并把同一站点发布到独立备用地址 [samgum.github.io/lrc-editor](https://samgum.github.io/lrc-editor/)。

扩展单独打包。运行 `pnpm build:extension` 构建桌面版，运行 `pnpm build:extension:mobile` 构建两套移动版。提交 Release 版本号后，运行 `./scripts/package-release.ps1` 会同时生成桌面、Edge Mobile、Firefox Android 扩展压缩包、两套含内置引擎的本机组件包和 `SHA256SUMS.txt`。

## 目录结构

```text
src/                 React 应用、逐行／逐字歌词格式、多语言和测试
worker/              本地 NCM/QMC 媒体 Worker
extension/           Manifest V3 扩展源码与清单
companion/           本机 AI 安装器、启动器、说明与内置引擎快照
public/              PWA 元数据与品牌资源
build/               Web 构建产物
extension-dist/      扩展构建产物
```

## 开发维护与参考项目

LRC Editor 由[伤感咩吖](https://github.com/samgum)开发和维护。

源码与交互参考项目包括：

- [lrc-maker](https://github.com/magic-akari/lrc-maker)，作者 magic-akari
- [lrc-maker-cdgz](https://github.com/CDGZ-ofc/lrc-maker-cdgz)，作者 重叠广州 / CDGZ-ofc
- [lrc-utils](https://github.com/magic-akari/lrc-utils)，作者 magic-akari
- [lyrics-tools](https://github.com/samgum/lyrics-tools)，作者 samgum
- [Aegisub 修改版](https://github.com/samgum/Aegisub)，作者 Aegisub Project／samgum；S／F／G 音频工作流仅作交互参考，遵循 Aegisub 自身许可证，没有复制其源码
- [内置本机 AI 对轴引擎](./companion/engine-bundle/README-zh.md)，作者伤感咩吖

媒体配套扩展内置 MIT 许可的 [YouTube.js](https://github.com/LuanRT/YouTube.js)，作者 LuanRT 及贡献者。本地编码兜底使用同为 MIT 许可的 [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)。

## 许可证

本项目使用 [MIT License](./LICENSE)，并保留原始版权声明。
