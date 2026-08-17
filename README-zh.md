<p align="center">
  <img src="./public/favicons/lrc-editor.svg" width="96" height="96" alt="LRC Editor 标志">
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# LRC Editor

LRC Editor 是用于编辑 LRC 歌词并配合音频或视频制作时间轴的浏览器工作台，生产站点计划使用 `lrc.sgmy.org`。

主站是纯静态 Web 应用。歌词、设置和本地媒体处理都留在浏览器中。YouTube 与哔哩哔哩链接由可选的 Manifest V3 配套扩展在本机解析，因此项目不需要媒体解析后端，也不需要 Python 运行环境。

## 功能

- 导入纯文本、`.txt` 和 `.lrc` 文件，编辑歌曲名、艺人和专辑元信息。
- 复制或下载 LRC；可设置时间标签小数位数及左右空格。
- 载入音频、视频、媒体直链、网易云音乐歌曲链接、普通或 Music YouTube 链接（包括附带播放列表参数的链接）、哔哩哔哩链接和 `b23.tv` 短链。
- 在浏览器支持时原生播放 FLAC；遇到不支持的本地 ALAC/FLAC 时，使用 FFmpeg WebAssembly 转为浏览器可播放的无损格式。
- 本地媒体波形、精确跳转、播放速度调节，以及可选的后台播放。
- 使用键盘或指针添加、覆盖、删除、微调时间标签，也可整体平移全部时间标签。默认微调量为 100 ms；键盘操作配合 `Shift` 可减半，配合 `Alt` 可缩小至五分之一。
- 选中行自动居中，通过常驻打轴工具栏记录时间，并可撤销或重做时间修改。
- 在键位设置页修改全部打轴与播放快捷键。
- 在浏览器本地保存歌词状态和设置。
- 内置 LRC 实用工具：压缩重复标签、移除标签、移除空行、线性变换时间、拆分翻译、保留时间轴覆写歌词。
- 支持跟随系统、亮色和暗色模式，以及自定义强调色。
- 支持英语、日语、韩语、波兰语、巴西葡萄牙语、斯洛伐克语、简体中文、繁体中文（香港）和繁体中文（台湾）。
- 可安装为 PWA，并通过 Web Share Target 接收分享的媒体链接。

本项目明确不包含上游的 GitHub Gist 功能，也不会自动写入 `[tool: ...]` 元信息。

## 媒体配套扩展

LRC Editor Media Bridge 只接收主站验证过的 YouTube 或哔哩哔哩视频标识。扩展的 Service Worker 在本机解析兼容音频流，再通过扩展消息通道把临时媒体地址交给主站。针对哔哩哔哩媒体播放，扩展使用限定范围的浏览器规则补充所需 Referer。

可从 [GitHub Releases](https://github.com/samgum/lrc-editor/releases/latest) 下载当前版本的可解压安装扩展包。

- 临时地址不会写入浏览器历史、本地存储、日志或项目服务器。
- 扩展不读取站点 Cookie、标签页、浏览历史或账号信息。
- 多语言扩展弹窗可打开 LRC Editor，并显示当前支持的平台。
- 域名权限仅覆盖解析器使用的 YouTube、哔哩哔哩及媒体 CDN 端点。
- 媒体资源直链仍可作为手动备用方案。

YouTube 解析器通过 `youtubei.js` 使用非公开 InnerTube 接口；哔哩哔哩解析器使用网页播放器接口。平台客户端或播放要求变化时，对应功能可能失效。使用者需遵守平台条款和媒体所在地区的适用法律。

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

本地测试扩展时，打开浏览器扩展管理页，启用开发者模式，选择“加载已解压的扩展程序”，然后选择 `extension-dist/`。开发清单只允许扩展桥接 `localhost`、`127.0.0.1` 和 `lrc.sgmy.org`。

## 部署

把 `build/` 中的内容部署到任意静态 HTTPS 主机即可。仓库内的 Dockerfile 会构建站点并使用 nginx 提供服务。

扩展单独打包。运行 `pnpm build:extension` 后，可分发 `extension-dist/`，或用同一份打包代码提交至 Chromium 扩展商店。

## 目录结构

```text
src/                 React 应用、LRC 逻辑、多语言和测试
worker/              本地 NCM/QMC 媒体 Worker
extension/           Manifest V3 扩展源码与清单
public/              PWA 元数据与品牌资源
build/               Web 构建产物
extension-dist/      扩展构建产物
```

## 开发维护与参考项目

LRC Editor 由[伤感咩吖](https://github.com/samgum)开发和维护。

实现过程中参考并改编了以下 MIT 许可项目：

- [lrc-maker](https://github.com/magic-akari/lrc-maker)，作者 magic-akari
- [lrc-maker-cdgz](https://github.com/CDGZ-ofc/lrc-maker-cdgz)，作者 重叠广州 / CDGZ-ofc
- [lrc-utils](https://github.com/magic-akari/lrc-utils)，作者 magic-akari

媒体配套扩展内置 MIT 许可的 [YouTube.js](https://github.com/LuanRT/YouTube.js)，作者 LuanRT 及贡献者。本地编码兜底使用同为 MIT 许可的 [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)。

## 许可证

本项目使用 [MIT License](./LICENSE)，并保留原始版权声明。
