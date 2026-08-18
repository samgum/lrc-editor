# LRC Editor 本机 AI 对轴

[English](./README.md) · [简体中文](./README-zh.md)

这个可选组件会在本机运行经过验证的 `lyrics-forced-aligner` 引擎。LRC Editor 直接使用页面已经载入的媒体，以及去掉旧时间戳后的当前编辑器歌词。音频、歌词、模型和结果都不会发送给 LRC Editor 站点或项目服务器。

## Windows 安装

1. 从最新 [LRC Editor Release](https://github.com/samgum/lrc-editor/releases/latest) 下载并解压 `lrc-editor-ai-aligner` 安装包。
2. 双击 `install-ai-aligner.cmd`；选择 1 使用 C 盘默认目录、2 使用 `D:\LRC Editor AI`、3 输入自定义目录，然后等待全部下载完成。
3. 只在需要 AI 对轴时双击 `start-ai-aligner.cmd`，并保持终端窗口开启。
4. 安装或更新到 LRC Editor Media Bridge v0.4.2 或更高版本。
5. 在 LRC Editor 中开启“设置 → 启用本机 AI 对轴”，载入媒体、打开编辑器，再点击“AI 对轴”。

缺少 Git、FFmpeg 或 uv 时，安装脚本会通过 WinGet 自动安装。安装器始终把 uv 管理的 Python 3.11 下载到所选目录内的 `python`，并只用这个解释器创建 `environment`；不会复用、注册或加入系统 PATH，用户无需预装 Python。删除整个 AI 安装目录即可一并移除这套私有 Python。

## macOS／Linux 安装

1. 解压 macOS/Linux 配套包。
2. macOS 双击 `install-ai-aligner.command`；Linux 在终端运行 `./install-ai-aligner.sh`。
3. 按提示选择安装目录。macOS 默认位置为 `~/Library/Application Support/LRC Editor/AI Aligner`，Linux 默认为 `${XDG_DATA_HOME:-~/.local/share}/LRC Editor/AI Aligner`。
4. 需要时用 macOS 的 `start-ai-aligner.command` 或 Linux 的 `./start-ai-aligner.sh` 启动。

如果 macOS 阻止打开下载的命令文件，可右键选择“打开”，或在终端执行一次 `chmod +x *.sh *.command`。缺少依赖时，macOS 优先使用 Homebrew；Linux 支持 `apt`、`dnf` 和 `pacman` 系列发行版。

也可直接指定其他磁盘：

```bash
./install-ai-aligner.sh --install-root "/Volumes/Media/LRC Editor AI"
```

## 硬件选择与下载大小

| 电脑类型                                   | 加速方式                 | 预计下载 | 预计安装后占用 |
| ------------------------------------------ | ------------------------ | -------: | -------------: |
| 至少 4 GB 显存的 NVIDIA GPU，Windows/Linux | 独立 CUDA 12.8 + cuDNN 9 |  7–10 GB |       12–18 GB |
| AMD／Intel GPU 或无独显，Windows/Linux     | CPU int8                 |   4–6 GB |        8–12 GB |
| Apple Silicon 或 Intel Mac                 | CPU int8                 |   4–6 GB |        8–12 GB |

下载前会显示检测到的 GPU、显存、驱动、最终后端、预计网络下载量、预计安装占用和建议可用空间。Windows 可用 `-EstimateOnly`，macOS/Linux 可用 `--estimate-only`，只查看方案而不写入文件；`-CpuOnly`／`--cpu-only` 可强制使用通用 CPU 模式。

GPU 加速与本机其他机器学习环境完全隔离。NVIDIA 运行库只放在本组件的 `environment` 目录，启动时也只临时加入当前对齐服务进程，不修改系统 CUDA 路径。安装器会同时检测 PyTorch 与 CTranslate2，并实际加载一次 `large-v3-turbo`；CUDA、驱动、显存或动态库任一检查失败都会自动切换到 CPU。CPU 模式功能完整，只是处理速度较慢。

CPU 模式请预留至少 15 GB，CUDA 模式请预留至少 22 GB。下载中断后直接重新运行同一脚本即可续装，不会重复创建模型副本。

全部安装和模型检测成功后，安装器会自动删除可重新生成的 uv 软件包下载缓存；安装中断时则保留缓存供续传。模型和私有 Python／CUDA 运行库不会被当作下载垃圾清理。

## 模型来源

- `large-v3-turbo` 使用 faster-whisper 标准的 `download_model` 接口下载。faster-whisper 官方模型别名指向 Hugging Face 上的 [`mobiuslabsgmbh/faster-whisper-large-v3-turbo`](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo)。
- `htdemucs_ft` 使用 Demucs 标准的 `demucs.pretrained.get_model` 接口，从 Meta 官方 [`dl.fbaipublicfiles.com/demucs`](https://dl.fbaipublicfiles.com/demucs/) 模型站点下载。
- PyTorch 来自官方 `download.pytorch.org` wheel 索引；独立 CUDA 运行库使用 NVIDIA 自有的 PyPI 软件包；Git、FFmpeg 和 uv 使用平台包管理器或固定版本的 uv 官方安装器。
- CUDA 模式会把 NVIDIA 的 [`nvidia-cublas-cu12`](https://pypi.org/project/nvidia-cublas-cu12/) 与 [`nvidia-cudnn-cu12`](https://pypi.org/project/nvidia-cudnn-cu12/) 固定版本安装在用户选择的目录内部。

安装器会在下载前显示每个模型的来源，不使用项目自建镜像、第三方网盘或 LRC Editor 站点分发模型。

## 固定目录

Windows 默认安装位置为 `%LOCALAPPDATA%\LRC Editor\AI Aligner`。安装提示可直接选择其他磁盘，例如 `D:\LRC Editor AI`，全部文件都会放进该目录。

| 路径                     | 内容                                             |
| ------------------------ | ------------------------------------------------ |
| `models\torch`           | `htdemucs_ft` 人声分离模型                       |
| `models\faster-whisper`  | `large-v3-turbo` 语音模型                        |
| `models\huggingface`     | Hugging Face 共用模型缓存                        |
| `environment`            | 隔离的引擎依赖                                   |
| `environment/.../nvidia` | 启用 GPU 时使用的独立 CUDA／cuBLAS／cuDNN 运行库 |
| `python`                 | uv 管理的 Python 运行环境                        |
| `engine`                 | 固定版本且未修改的 `lyrics-forced-aligner` 源码  |
| `runtime`                | 本机任务、可复用分析缓存和结果                   |

也可指定其他固定位置：

```powershell
.\install-ai-aligner.ps1 -InstallRoot "E:\LRC Editor AI"
```

启动时使用同一路径：

```powershell
.\start-ai-aligner.ps1 -InstallRoot "E:\LRC Editor AI"
```

## 运行规则

- 功能默认关闭。关闭时页面不会探测本机端口、传输媒体或创建模型任务。
- 浏览器扩展不能直接启动任意本机程序，因此只在需要时启动组件，用完后按 `Ctrl+C` 停止。
- 重复运行启动器时会识别已有服务并直接退出，不会创建第二个进程。
- 一个任务在准备、排队或处理期间，扩展会拒绝第二次上传和第二个任务。
- 输出精度跟随编辑器设置：两位小数请求 `lrc2`，其他设置请求 `lrc3`。
- 剩余时间只由网页根据本机服务已经上报的进度采样估算，不会增加模型计算，也不会降低推理速度。
- 默认每次任务都绕过可复用工作缓存。选定精度的 LRC 完整返回编辑器后，LRC Editor 自己的本机包装服务会删除该任务上传的音频、生成结果和分析工作文件；未正常收尾的默认任务也会在宽限期后或下次启动时清理。
- “设置 → 保留并复用 AI 对轴任务缓存”默认关闭；明确开启后才会保留同一音频的可复用分析数据以加快再次对轴。模型权重和隔离运行环境不属于单次任务缓存。
- 只有歌词行顺序完全不变，且全部时间戳均为有限、非负、唯一并严格递增时，结果才会应用。
- AI 结果作为一次可撤销操作写入编辑器，并保留歌曲名、艺人和专辑信息。

安装器固定使用 [`lyrics-forced-aligner`](https://github.com/samgum/lyrics-forced-aligner) 的 `4898a3cbc569349c5db87bbc931c9d6fa124d64d` 版本。清理接口由 LRC Editor 项目自己的本机包装层提供，不会修改固定引擎源码，也不会修改其他位置的原项目仓库。
