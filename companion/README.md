# LRC Editor local AI alignment

[English](./README.md) · [简体中文](./README-zh.md)

This optional companion runs the verified `lyrics-forced-aligner` engine entirely on your computer. LRC Editor sends the media already loaded in the page and the current editor lyrics with their old timestamps removed. No audio, lyrics, model data, or generated result is sent to the LRC Editor site or a project server.

## Install on Windows

1. Download and extract the `lrc-editor-ai-aligner` package from the latest [LRC Editor release](https://github.com/samgum/lrc-editor/releases/latest).
2. Double-click `install-ai-aligner.cmd`, choose 1 for the C drive default, 2 for `D:\LRC Editor AI`, or 3 for a custom directory, then allow the downloads to finish.
3. Double-click `start-ai-aligner.cmd` only when AI alignment is needed. Keep its terminal open.
4. Install or update LRC Editor Media Bridge to v0.4.6 or later.
5. In LRC Editor, turn on **Settings → Enable local AI alignment**, load media, open the editor, and select **AI align**.

The installer uses WinGet when FFmpeg or uv is missing. The verified engine snapshot is already included in the release package, so no private repository access or Git installation is required. It always downloads a uv-managed Python 3.11 runtime into the chosen `python` directory and creates `environment` from that exact executable. It does not reuse, register, or add a system Python to `PATH`; no preinstalled Python or Python command is required. Removing the selected AI directory removes this private Python as well.

## Install on macOS or Linux

1. Extract the macOS/Linux companion archive.
2. On macOS, double-click `install-ai-aligner.command`. On Linux, run `./install-ai-aligner.sh` in a terminal.
3. Choose the installation directory when prompted. The macOS default is `~/Library/Application Support/LRC Editor/AI Aligner`; the Linux default is `${XDG_DATA_HOME:-~/.local/share}/LRC Editor/AI Aligner`.
4. Start on demand with `start-ai-aligner.command` on macOS or `./start-ai-aligner.sh` on Linux.

The archive contains `INSTALL-macOS.txt` and `INSTALL-Linux.txt`; follow the guide for the current operating system instead of the Windows instructions.

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

Before downloading, the installer shows the detected GPU, VRAM, driver, selected backend, selected Hugging Face source, estimated network download, estimated installed size, and free-space recommendation. Use `-EstimateOnly` on Windows or `--estimate-only` on macOS/Linux to inspect the plan without changing files. Use `-CpuOnly` or `--cpu-only` to force the universal CPU path.

CUDA acceleration is isolated from other machine-learning installations. NVIDIA runtime packages live under this companion's `environment` directory, and their library directories are added only to the local aligner process. The installer does not change the system CUDA path. PyTorch and CTranslate2 are both checked, and the full `large-v3-turbo` model is loaded once during installation; any CUDA, driver, VRAM, or library failure selects CPU mode automatically. CPU mode remains fully functional, though slower.

Allow at least 15 GB of free space for CPU mode or 22 GB for CUDA mode. Interrupted downloads can be resumed by running the same installer again.

After every successful installation and model verification, the installer removes the rebuildable uv package-download cache. Interrupted installations keep that cache for resume. Models and the private Python/CUDA runtime are never treated as download garbage.

## Model sources

- The interactive installer offers **Official Hugging Face** and **HF-Mirror**. The default is official. Automation can use `-ModelSource official|hf-mirror` on Windows or `--model-source official|hf-mirror` on macOS/Linux. The selected fixed endpoint is stored in `install-state.json` and reused by the launcher.
- `large-v3-turbo` is downloaded with faster-whisper's standard `download_model` API. Its model alias maps to [`mobiuslabsgmbh/faster-whisper-large-v3-turbo`](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo); `HF_ENDPOINT` selects the official Hub or HF-Mirror before `huggingface_hub` is imported.
- In official mode, `htdemucs_ft` uses Demucs' standard API and Meta's official [`dl.fbaipublicfiles.com/demucs`](https://dl.fbaipublicfiles.com/demucs/) host. In HF-Mirror mode, the four original `.th` files are fetched through the public `iBoostAI/Demucs-v4` Hugging Face repository. The installer verifies each complete SHA-256 against the known official file before copying it into the Demucs cache, then removes the temporary mirror cache. Mismatched files are never loaded.
- PyTorch packages come from the official `download.pytorch.org` wheel index. Private CUDA libraries use NVIDIA-owned PyPI packages. FFmpeg and uv use their platform package manager or the pinned official uv installer.
- CUDA mode pins NVIDIA's [`nvidia-cublas-cu12`](https://pypi.org/project/nvidia-cublas-cu12/) and [`nvidia-cudnn-cu12`](https://pypi.org/project/nvidia-cudnn-cu12/) runtime packages inside the selected installation directory.

The installer prints each model source before downloading it. HF-Mirror is a third-party public mirror and remains an explicit user choice; the LRC Editor site does not proxy or store model files.

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
- The browser extension cannot start an arbitrary local executable without the broader `nativeMessaging` permission, which this project does not request. The website can stop an already-running service. When no complete installation exists, the downloaded start launcher offers to install first and continues starting automatically.
- Starting the launcher twice detects the existing service and exits without creating a second process.
- Downloaded start, stop, and uninstall launchers automatically resolve the location recorded by the installer and then check the platform default. They do not ask users to locate a completed installation manually.
- Use `stop-ai-aligner.cmd`, `stop-ai-aligner.command`, or `stop-ai-aligner.sh` to stop only the verified companion process.
- Use the matching `uninstall-ai-aligner` command for removal. It requires `UNINSTALL` and the exact install path as two separate confirmations.
- The extension refuses a second upload or job while one is being prepared, queued, or processed.
- Output precision follows the editor setting: two-digit timestamps request `lrc2`; every other setting requests `lrc3`.
- Remaining time is estimated in the web page from already reported progress samples; it does not add model work or reduce inference speed.
- By default, each job bypasses the reusable work cache. After the requested LRC is fully downloaded, the LRC Editor wrapper deletes that job's uploaded media, generated outputs, and analysis work. Abandoned default jobs are also removed after a grace period or on the next service start.
- **Settings → Keep and reuse AI task cache** is off by default. Enabling it retains reusable analysis data for faster repeated alignment of the same media. Model weights and the isolated runtime are never part of per-task cleanup.
- Results are accepted only when every lyric line remains in order and all timestamps are finite, non-negative, unique, and strictly increasing.
- Applying an AI result is one undoable editor operation and preserves title, artist, and album metadata.

The installer copies the minimal engine snapshot bundled in [`engine-bundle`](./engine-bundle/README.md), verified as revision `4898a3cbc569349c5db87bbc931c9d6fa124d64d`. It keeps this small bundle beside an installation so the installed launcher can repair itself without network access. It never clones the private development repository. The control, cancellation, service-stop, and cache APIs are supplied by the LRC Editor companion wrapper; the bundled engine remains unmodified.
