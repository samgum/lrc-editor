# Visual and interaction remediation

This website-only update addresses the 13 findings from the visual audit of `04efba6`. The package version remains **0.4.6**; browser extension and AI engine archives are unchanged.

## Changes

| Audit finding | Resolution                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VIS-001       | Compact lyric queues reserve separate space for text, selected/playing badges, and timing warnings.                                                             |
| VIS-002       | Workspaces store independent page scroll positions and restore them after lazy content mounts.                                                                  |
| VIS-003       | Settings and playback/timing sliders expose visible keyboard focus.                                                                                             |
| VIS-004       | Preset colors use accessible native radios, mobile custom colors remain available, and lyric import uses a real keyboard-operable button.                       |
| VIS-005       | Theme foregrounds are checked against actual neutral and selected surfaces, including the key-binding background.                                               |
| VIS-006       | Waveform and spectrogram timing share a fixed time ruler derived from the current viewport coordinates.                                                         |
| VIS-007       | Plot height fits the actual space above the player. Short screens group secondary controls in a scrollable display-settings panel. Word time inputs are larger. |
| VIS-008       | The native line editor adds synchronized timing-warning backgrounds, gutter markers, and previous/next issue navigation.                                        |
| VIS-009       | Huhu settings retain their grid layout; the missing-key action focuses the key field.                                                                           |
| VIS-010       | Cancel buttons retain secondary styling in service/cache confirmations.                                                                                         |
| VIS-011       | Errors, time precision, playback controls, file input, colors, and editor controls use appropriate localized names.                                             |
| VIS-012       | Escape cancels an uncommitted beat draft first and closes the panel on the next press; it also closes after Enter has blurred the input.                        |
| VIS-013       | Notifications merge repeats, update media progress in one card, allow dismissal, pause while being read, and expire independently.                              |

## Browser verification

Windows Chrome was tested with isolated local test data. Viewport emulation is not certification of native Safari/iOS or Android behavior.

| Viewport | Plot top | Plot bottom | Player top | Page scroll |
| -------- | -------- | ----------- | ---------- | ----------- |
| 1280×720 | 368.45   | 651.45      | 664        | 0           |
| 390×844  | 417.51   | 719.51      | 732        | 0           |
| 360×800  | 417.51   | 675.51      | 688        | 0           |
| 844×390  | 227.20   | 327.20      | 334        | 0           |

- The 1280-pixel sidebar's content width now equals its client width (239 px); selected and playing labels fit together.
- Wrapped editor diagnostics matched the native textarea height (1539 versus 1539.17 px), including internal scroll synchronization. Native undo preserved the complete test text.
- A paused waveform click changed only the selected start, leaving media time at zero. S continued playback, and clicking/replacing a start plus switching views kept playback running (64.71 to 71.10 seconds) with page scroll unchanged.
- Editing `Hello QA` and its start to `00:01.234`, then switching Line → Word, retained both values. Export stayed `lrc`.
- Theme selection worked through Tab/arrow keys and uppercase custom HEX input. Settings selectors had a visible 2-pixel focus outline.
- A missing Huhu key focused the correct input. Opening service/cache confirmations did not execute their actions.
- Repeated notices merged into one card; closing it did not keep later notices alive. Notifications subsequently expired.
- Escape preserved the saved beat value after Enter and returned focus to the summary. With an uncommitted BPM draft, the first Escape restored the saved value and the second closed the panel.
- No browser warning/error logs were captured during final local verification.

## Automated verification

The added tests cover raw-line diagnostic mapping, CRLF/Unicode selection offsets, malformed tags, ruler coordinates and density, notification replacement/deduplication, and contrast on actual surfaces. The full suite contains 292 passing tests across 39 files at the time of remediation.

Native macOS/Safari, real mobile keyboards, browser 200% zoom, and full AI jobs were not executed in this environment. No real API key or paid alignment job was used for visual testing.

## 中文说明

本次修复覆盖视觉审校的 13 项问题：侧栏状态、工作区滚动、键盘焦点与入口、主题对比度、频谱时间标尺和可用高度、编辑器逐行异常标识、Huhu 设置、确认按钮、多语言以及通知与浮层交互。

逐行点击默认仍只设置起点；立即播放与自动下一行继续独立且默认关闭。模式切换保留逐字内容和时间，默认导出保持 LRC。网站仍为纯前端，版本仍为 v0.4.6，无需更新扩展或 AI 安装包。

以上浏览器验证来自 Windows Chrome 和视口模拟；未把模拟结果当作 macOS/iOS 真机验收，也未消耗真实 AI API 额度。
