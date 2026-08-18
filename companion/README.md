# LRC Editor local AI alignment

[English](./README.md) · [简体中文](./README-zh.md)

This optional companion runs the verified `lyrics-forced-aligner` engine entirely on your computer. LRC Editor sends the media already loaded in the page and the current editor lyrics with their old timestamps removed. No audio, lyrics, model data, or generated result is sent to the LRC Editor site or a project server.

## Install on Windows

1. Download and extract the `lrc-editor-ai-aligner` package from the latest [LRC Editor release](https://github.com/samgum/lrc-editor/releases/latest).
2. Right-click `install-ai-aligner.ps1`, choose **Run with PowerShell**, choose an installation directory, and allow the downloads to finish.
3. Double-click `start-ai-aligner.cmd` only when AI alignment is needed. Keep its terminal open.
4. Install or update LRC Editor Media Bridge to v0.4.0 or later.
5. In LRC Editor, turn on **Settings → Enable local AI alignment**, load media, open the editor, and select **AI align**.

The installer uses WinGet when Git, FFmpeg, or uv is missing. uv downloads an isolated Python 3.11 runtime into the companion directory; no system Python installation or Python command is required.

## Install on macOS or Linux

1. Extract the macOS/Linux companion archive.
2. On macOS, double-click `install-ai-aligner.command`. On Linux, run `./install-ai-aligner.sh` in a terminal.
3. Choose the installation directory when prompted. The macOS default is `~/Library/Application Support/LRC Editor/AI Aligner`; the Linux default is `${XDG_DATA_HOME:-~/.local/share}/LRC Editor/AI Aligner`.
4. Start on demand with `start-ai-aligner.command` on macOS or `./start-ai-aligner.sh` on Linux.

If macOS blocks a downloaded command file, right-click it and choose **Open**, or run `chmod +x *.sh *.command` once in Terminal. Homebrew is used for missing macOS prerequisites when available. Linux supports `apt`, `dnf`, and `pacman` package families.

Choose another disk from the command line with:

```bash
./install-ai-aligner.sh --install-root "/Volumes/Media/LRC Editor AI"
```

## Hardware selection and download size

| Computer                                          | Acceleration                | Expected download | Expected installed size |
| ------------------------------------------------- | --------------------------- | ----------------: | ----------------------: |
| NVIDIA GPU with at least 4 GB VRAM, Windows/Linux | Private CUDA 12.8 + cuDNN 9 |           7–10 GB |                12–18 GB |
| AMD/Intel GPU or no discrete GPU, Windows/Linux   | CPU int8                    |            4–6 GB |                 8–12 GB |
| Apple Silicon or Intel Mac                        | CPU int8                    |            4–6 GB |                 8–12 GB |

Before downloading, the installer shows the detected GPU, VRAM, driver, selected backend, estimated network download, estimated installed size, and free-space recommendation. Use `-EstimateOnly` on Windows or `--estimate-only` on macOS/Linux to inspect the plan without changing files. Use `-CpuOnly` or `--cpu-only` to force the universal CPU path.

CUDA acceleration is isolated from other machine-learning installations. NVIDIA runtime packages live under this companion's `environment` directory, and their library directories are added only to the local aligner process. The installer does not change the system CUDA path. PyTorch and CTranslate2 are both checked, and the full `large-v3-turbo` model is loaded once during installation; any CUDA, driver, VRAM, or library failure selects CPU mode automatically. CPU mode remains fully functional, though slower.

Allow at least 15 GB of free space for CPU mode or 22 GB for CUDA mode. Interrupted downloads can be resumed by running the same installer again.

## Model sources

- `large-v3-turbo` is downloaded with faster-whisper's standard `download_model` API. The official faster-whisper model alias maps to [`mobiuslabsgmbh/faster-whisper-large-v3-turbo`](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo) on Hugging Face.
- `htdemucs_ft` is downloaded with Demucs' standard `demucs.pretrained.get_model` API from Meta's official [`dl.fbaipublicfiles.com/demucs`](https://dl.fbaipublicfiles.com/demucs/) model host.
- PyTorch packages come from the official `download.pytorch.org` wheel index. Private CUDA libraries use NVIDIA-owned PyPI packages. Git, FFmpeg, and uv use their platform package manager or the pinned official uv installer.
- CUDA mode pins NVIDIA's [`nvidia-cublas-cu12`](https://pypi.org/project/nvidia-cublas-cu12/) and [`nvidia-cudnn-cu12`](https://pypi.org/project/nvidia-cudnn-cu12/) runtime packages inside the selected installation directory.

The installer prints each model source before downloading it. It does not use a project mirror, third-party cloud drive, or the LRC Editor site for model files.

## Fixed directory layout

The default Windows installation directory is `%LOCALAPPDATA%\LRC Editor\AI Aligner`. The prompt can place the complete installation on another drive, such as `D:\LRC Editor AI`.

| Path                     | Contents                                          |
| ------------------------ | ------------------------------------------------- |
| `models\torch`           | `htdemucs_ft` vocal-separation weights            |
| `models\faster-whisper`  | `large-v3-turbo` speech model                     |
| `models\huggingface`     | shared Hugging Face model cache                   |
| `environment`            | isolated engine dependencies                      |
| `environment/.../nvidia` | private CUDA/cuBLAS/cuDNN runtime when selected   |
| `python`                 | uv-managed Python runtime                         |
| `engine`                 | pinned, unmodified `lyrics-forced-aligner` source |
| `runtime`                | local jobs, reusable analysis cache, and results  |

Choose another fixed location with:

```powershell
.\install-ai-aligner.ps1 -InstallRoot "E:\LRC Editor AI"
```

Use the same path when starting:

```powershell
.\start-ai-aligner.ps1 -InstallRoot "E:\LRC Editor AI"
```

## Runtime behavior

- The setting is off by default. When it is off, the page does not probe the local ports, upload media, or start a model task.
- The browser extension cannot start an arbitrary local executable. Start the companion only when needed and stop it with `Ctrl+C` afterward.
- Starting the launcher twice detects the existing service and exits without creating a second process.
- The extension refuses a second upload or job while one is being prepared, queued, or processed.
- Output precision follows the editor setting: two-digit timestamps request `lrc2`; every other setting requests `lrc3`.
- Results are accepted only when every lyric line remains in order and all timestamps are finite, non-negative, unique, and strictly increasing.
- Applying an AI result is one undoable editor operation and preserves title, artist, and album metadata.

The installer pins [`lyrics-forced-aligner`](https://github.com/samgum/lyrics-forced-aligner) revision `4898a3cbc569349c5db87bbc931c9d6fa124d64d`. It does not modify a separate checkout of that repository.
