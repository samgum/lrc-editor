#!/usr/bin/env bash
set -euo pipefail

engine_repository="https://github.com/samgum/lyrics-forced-aligner.git"
engine_revision="4898a3cbc569349c5db87bbc931c9d6fa124d64d"
install_root=""
cpu_only=0
skip_prerequisites=0
skip_models=0
estimate_only=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-root)
            install_root="${2:-}"
            shift 2
            ;;
        --cpu-only)
            cpu_only=1
            shift
            ;;
        --skip-prerequisite-install)
            skip_prerequisites=1
            shift
            ;;
        --skip-model-download)
            skip_models=1
            shift
            ;;
        --estimate-only)
            estimate_only=1
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

os_name="$(uname -s)"
case "$os_name" in
    Darwin)
        default_install_root="$HOME/Library/Application Support/LRC Editor/AI Aligner"
        ;;
    Linux)
        data_root="${XDG_DATA_HOME:-$HOME/.local/share}"
        default_install_root="$data_root/LRC Editor/AI Aligner"
        ;;
    *)
        echo "This installer supports macOS and Linux. Use install-ai-aligner.ps1 on Windows." >&2
        exit 1
        ;;
esac

if [[ -z "$install_root" ]]; then
    if [[ "$estimate_only" -eq 1 || ! -t 0 ]]; then
        install_root="$default_install_root"
    else
        echo "Choose one directory for the engine, models, private GPU runtime, and job cache."
        echo "Default: $default_install_root"
        read -r -p "Install directory (press Enter to use the default): " install_root
        install_root="${install_root:-$default_install_root}"
    fi
fi
if [[ "$install_root" != /* ]]; then
    echo "Install directory must be an absolute path." >&2
    exit 1
fi
if [[ "$install_root" == "/" ]]; then
    echo "Install directory cannot be the filesystem root." >&2
    exit 1
fi

engine_root="$install_root/engine"
environment_root="$install_root/environment"
model_root="$install_root/models"
runtime_root="$install_root/runtime"
python_root="$install_root/python"
download_cache_root="$install_root/download-cache"
venv_python="$environment_root/bin/python"
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
constraints_path="$script_root/ai-constraints.txt"
if [[ ! -f "$constraints_path" ]]; then
    echo "ai-constraints.txt is missing from the installer package." >&2
    exit 1
fi

use_cuda=0
cuda_device=""
gpu_name=""
gpu_memory_mb=0
gpu_driver=""
if [[ "$os_name" == "Linux" && "$cpu_only" -eq 0 ]] && command -v nvidia-smi >/dev/null 2>&1; then
    while IFS=',' read -r index name memory driver; do
        index="$(echo "$index" | xargs)"
        name="$(echo "$name" | xargs)"
        memory="$(echo "$memory" | xargs)"
        driver="$(echo "$driver" | xargs)"
        if [[ "$memory" =~ ^[0-9]+$ ]] && (( memory > gpu_memory_mb )); then
            cuda_device="$index"
            gpu_name="$name"
            gpu_memory_mb="$memory"
            gpu_driver="$driver"
        fi
    done < <(nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null || true)
    if (( gpu_memory_mb >= 4096 )); then
        use_cuda=1
    fi
fi

compute_mode="CPU compatibility mode"
expected_download="approximately 4-6 GB"
expected_installed="approximately 8-12 GB"
required_space="at least 15 GB"
if [[ "$use_cuda" -eq 1 ]]; then
    compute_mode="isolated NVIDIA CUDA 12.8"
    expected_download="approximately 7-10 GB"
    expected_installed="approximately 12-18 GB"
    required_space="at least 22 GB"
fi

echo "LRC Editor AI hardware plan"
echo "Operating system: $os_name ($(uname -m))"
if [[ -n "$gpu_name" ]]; then
    gpu_memory_gb="$(awk -v memory="$gpu_memory_mb" 'BEGIN { printf "%.1f", memory / 1024 }')"
    echo "Detected NVIDIA GPU: $gpu_name ($gpu_memory_gb GB VRAM, driver $gpu_driver)"
    if [[ "$use_cuda" -eq 0 && "$cpu_only" -eq 0 ]]; then
        echo "This GPU has less than 4 GB VRAM; CPU mode avoids out-of-memory failures."
    fi
elif [[ "$os_name" == "Darwin" ]]; then
    echo "macOS uses CPU int8 mode. CTranslate2 does not provide a Metal backend."
elif [[ "$cpu_only" -eq 0 ]]; then
    echo "No supported NVIDIA CUDA device was found. AMD and Intel GPUs use CPU compatibility mode."
fi
if [[ "$cpu_only" -eq 1 ]]; then
    echo "CPU mode was explicitly requested."
fi
echo "Selected acceleration: $compute_mode"
echo "Expected network download: $expected_download"
echo "Expected installed size:    $expected_installed"
echo "Required free space:        $required_space"
echo "Install directory:          $install_root"
space_probe="$install_root"
while [[ ! -d "$space_probe" && "$space_probe" != "/" ]]; do
    space_probe="$(dirname "$space_probe")"
done
available_kb="$(df -Pk "$space_probe" | awk 'NR == 2 { print $4 }')"
available_gb="$(awk -v space="$available_kb" 'BEGIN { printf "%.1f", space / 1024 / 1024 }')"
required_gb=15
if [[ "$use_cuda" -eq 1 ]]; then
    required_gb=22
fi
echo "Available on selected disk: $available_gb GB"
if awk -v available="$available_gb" -v required="$required_gb" 'BEGIN { exit !(available < required) }'; then
    echo "The selected disk has less than the recommended free space. Choose another directory." >&2
    if [[ "$estimate_only" -eq 0 ]]; then
        exit 1
    fi
fi
if [[ "$estimate_only" -eq 1 ]]; then
    echo "Estimate only; no files were downloaded or changed."
    exit 0
fi

install_system_package() {
    local package_name="$1"
    if [[ "$skip_prerequisites" -eq 1 ]]; then
        echo "Missing prerequisite: $package_name" >&2
        exit 1
    fi
    if [[ "$os_name" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
        brew install "$package_name"
        return
    fi
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y "$package_name"
        return
    fi
    if command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y "$package_name"
        return
    fi
    if command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --needed "$package_name"
        return
    fi
    echo "Install $package_name with your system package manager, then rerun this installer." >&2
    exit 1
}

for prerequisite in curl git ffmpeg; do
    if ! command -v "$prerequisite" >/dev/null 2>&1; then
        install_system_package "$prerequisite"
    fi
done
if ! command -v ffprobe >/dev/null 2>&1; then
    install_system_package ffmpeg
fi

mkdir -p "$install_root" "$model_root" "$runtime_root" "$python_root" "$download_cache_root"

uv_command="$(command -v uv || true)"
if [[ -z "$uv_command" ]]; then
    uv_tools="$install_root/tools"
    mkdir -p "$uv_tools"
    echo "Installing private uv from https://astral.sh/uv/0.12.5/install.sh"
    curl -LsSf "https://astral.sh/uv/0.12.5/install.sh" |
        env UV_UNMANAGED_INSTALL="$uv_tools" sh
    uv_command="$uv_tools/uv"
fi
if [[ ! -x "$uv_command" ]]; then
    echo "uv is unavailable after installation." >&2
    exit 1
fi

if [[ -d "$engine_root/.git" ]]; then
    git -C "$engine_root" fetch --depth 1 origin "$engine_revision"
else
    if [[ -e "$engine_root" && -n "$(ls -A "$engine_root" 2>/dev/null)" ]]; then
        echo "$engine_root exists but is not an aligner Git checkout." >&2
        exit 1
    fi
    git clone --filter=blob:none --no-checkout "$engine_repository" "$engine_root"
    git -C "$engine_root" fetch --depth 1 origin "$engine_revision"
fi
git -C "$engine_root" checkout --detach "$engine_revision"
installed_revision="$(git -C "$engine_root" rev-parse HEAD)"
if [[ "$installed_revision" != "$engine_revision" ]]; then
    echo "The installed aligner revision could not be verified." >&2
    exit 1
fi

ensure_symlink() {
    local link_path="$1"
    local target_path="$2"
    mkdir -p "$target_path"
    if [[ -L "$link_path" ]]; then
        local current_target
        current_target="$(readlink "$link_path")"
        if [[ "$current_target" == "$target_path" ]]; then
            return
        fi
        echo "$link_path points to an unexpected target." >&2
        exit 1
    fi
    if [[ -d "$link_path" ]]; then
        if [[ -z "$(ls -A "$link_path")" ]]; then
            rmdir "$link_path"
        else
            echo "$link_path already contains data and cannot be replaced safely." >&2
            exit 1
        fi
    elif [[ -e "$link_path" ]]; then
        echo "$link_path already exists and is not a directory." >&2
        exit 1
    fi
    ln -s "$target_path" "$link_path"
}

ensure_symlink "$engine_root/.cache" "$model_root"
ensure_symlink "$engine_root/runtime" "$runtime_root"

export UV_PYTHON_INSTALL_DIR="$python_root"
export UV_CACHE_DIR="$download_cache_root"
export UV_NO_MODIFY_PATH=1
export UV_MANAGED_PYTHON=1
echo "Installing private Python 3.11 inside the selected directory..."
"$uv_command" python install 3.11 --install-dir "$python_root" --managed-python --no-bin
managed_python="$("$uv_command" python find 3.11 --managed-python --no-project)"
if [[ ! -x "$managed_python" || "$managed_python" != "$python_root"/* ]]; then
    echo "uv selected a Python runtime outside the chosen installation directory." >&2
    exit 1
fi

rebuild_environment=0
if [[ ! -x "$venv_python" ]]; then
    rebuild_environment=1
else
    existing_base="$("$venv_python" -c 'import sys; print(sys.base_prefix)')"
    if [[ "$existing_base" != "$python_root"/* ]]; then
        rebuild_environment=1
    fi
fi
if [[ "$rebuild_environment" -eq 1 ]]; then
    venv_arguments=(venv --python "$managed_python" --managed-python)
    if [[ -e "$environment_root" ]]; then
        venv_arguments+=(--clear)
    fi
    venv_arguments+=("$environment_root")
    "$uv_command" "${venv_arguments[@]}"
fi

reinstall_cpu=0
if [[ "$use_cuda" -eq 1 ]]; then
    if "$uv_command" pip install --upgrade --python "$venv_python" \
        "torch==2.11.0" "torchaudio==2.11.0" --index-url "https://download.pytorch.org/whl/cu128" && \
        "$uv_command" pip install --upgrade --python "$venv_python" \
        "nvidia-cublas-cu12==12.8.4.1" "nvidia-cudnn-cu12==9.8.0.87"; then
        export CUDA_VISIBLE_DEVICES="$cuda_device"
    else
        echo "CUDA packages could not be prepared; falling back to CPU mode."
        use_cuda=0
        compute_mode="CPU compatibility mode"
        reinstall_cpu=1
    fi
fi
if [[ "$use_cuda" -eq 0 ]]; then
    export CUDA_VISIBLE_DEVICES=-1
    cpu_arguments=(pip install --upgrade --python "$venv_python" "torch==2.11.0" "torchaudio==2.11.0")
    if [[ "$reinstall_cpu" -eq 1 ]]; then
        cpu_arguments=(pip install --upgrade --reinstall --python "$venv_python" "torch==2.11.0" "torchaudio==2.11.0")
    fi
    if [[ "$os_name" == "Linux" ]]; then
        cpu_arguments+=(--index-url "https://download.pytorch.org/whl/cpu")
    fi
    "$uv_command" "${cpu_arguments[@]}"
fi

"$uv_command" pip install --upgrade --python "$venv_python" --constraints "$constraints_path" -e "$engine_root"
"$venv_python" -c 'from importlib.metadata import version; import torch; assert version("demucs") == "4.0.1", version("demucs"); assert torch.__version__.startswith("2.11.0"), torch.__version__; print("Pinned dependencies verified:", "demucs", version("demucs"), "torch", torch.__version__)'
site_packages="$("$venv_python" -c 'import site; print(site.getsitepackages()[0])')"
if [[ "$use_cuda" -eq 1 ]]; then
    private_cuda_paths="$site_packages/nvidia/cublas/lib:$site_packages/nvidia/cudnn/lib"
    export LD_LIBRARY_PATH="$private_cuda_paths${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

export PYTHONPATH="$engine_root/src"
export TORCH_HOME="$model_root/torch"
export HF_HOME="$model_root/huggingface"
export HF_HUB_DISABLE_SYMLINKS_WARNING=1
export LRC_EDITOR_MODEL_ROOT="$model_root"

if [[ "$skip_models" -eq 0 ]]; then
    echo "Downloading htdemucs_ft"
    echo "Source: https://dl.fbaipublicfiles.com/demucs/"
    "$venv_python" -c "from demucs.pretrained import get_model; get_model('htdemucs_ft'); print('htdemucs_ft ready')"
    echo "Downloading large-v3-turbo"
    echo "Source: https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    "$venv_python" -c 'import os; from faster_whisper import download_model; download_model("large-v3-turbo", cache_dir=os.path.join(os.environ["LRC_EDITOR_MODEL_ROOT"], "faster-whisper")); print("large-v3-turbo ready")'
fi

if [[ "$use_cuda" -eq 1 ]]; then
    if [[ "$skip_models" -eq 0 ]]; then
        gpu_check='import os, ctranslate2, torch; from faster_whisper import WhisperModel; assert torch.cuda.is_available(); assert ctranslate2.get_cuda_device_count() > 0; model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16", download_root=os.path.join(os.environ["LRC_EDITOR_MODEL_ROOT"], "faster-whisper")); print("CUDA model load verified")'
    else
        gpu_check='import ctranslate2, torch; assert torch.cuda.is_available(); assert ctranslate2.get_cuda_device_count() > 0; print("CUDA libraries verified")'
    fi
    if ! "$venv_python" -c "$gpu_check"; then
        echo "CUDA validation failed; this installation will use CPU mode safely."
        use_cuda=0
        compute_mode="CPU compatibility mode"
        export CUDA_VISIBLE_DEVICES=-1
    fi
fi

if [[ "$use_cuda" -eq 0 && "$skip_models" -eq 0 ]]; then
    "$venv_python" -c 'import os; from faster_whisper import WhisperModel; model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", download_root=os.path.join(os.environ["LRC_EDITOR_MODEL_ROOT"], "faster-whisper")); print("CPU model load verified")'
fi
"$venv_python" -c 'from lyrics_aligner.server import app; assert app.title == "Lyrics Forced Aligner"; assert app.version == "0.2.27"; print("Engine API verified")'

for file_name in install-ai-aligner.sh install-ai-aligner.command ai-constraints.txt lrc_editor_companion_server.py start-ai-aligner.sh start-ai-aligner.command README.md README-zh.md INSTALL.txt; do
    if [[ -f "$script_root/$file_name" && "$script_root/$file_name" != "$install_root/$file_name" ]]; then
        cp "$script_root/$file_name" "$install_root/$file_name"
    fi
done
chmod +x "$install_root/start-ai-aligner.sh" "$install_root/start-ai-aligner.command"

acceleration="cpu"
if [[ "$use_cuda" -eq 1 ]]; then
    acceleration="cuda"
fi
model_bytes="$(du -sk "$model_root" | awk '{ print $1 * 1024 }')"
export LRC_STATE_PATH="$install_root/install-state.json"
export LRC_STATE_REVISION="$installed_revision"
export LRC_STATE_COMPUTE="$compute_mode"
export LRC_STATE_ACCELERATION="$acceleration"
export LRC_STATE_CUDA_DEVICE="$cuda_device"
export LRC_STATE_GPU_NAME="$gpu_name"
export LRC_STATE_GPU_MEMORY="$gpu_memory_mb"
export LRC_STATE_INSTALL_ROOT="$install_root"
export LRC_STATE_MODEL_ROOT="$model_root"
export LRC_STATE_PYTHON_ROOT="$python_root"
export LRC_STATE_MANAGED_PYTHON="$managed_python"
export LRC_STATE_MODEL_BYTES="$model_bytes"
export LRC_STATE_MODELS_DOWNLOADED="$((1 - skip_models))"
export LRC_STATE_EXPECTED_DOWNLOAD="$expected_download"
export LRC_STATE_EXPECTED_INSTALLED="$expected_installed"
"$venv_python" - <<'PY'
import json
import os
from datetime import datetime, timezone

state = {
    "installedAt": datetime.now(timezone.utc).astimezone().isoformat(),
    "engineRevision": os.environ["LRC_STATE_REVISION"],
    "engineVersion": "0.2.27",
    "computeMode": os.environ["LRC_STATE_COMPUTE"],
    "acceleration": os.environ["LRC_STATE_ACCELERATION"],
    "cudaDevice": int(os.environ["LRC_STATE_CUDA_DEVICE"]) if os.environ["LRC_STATE_CUDA_DEVICE"] else None,
    "gpuName": os.environ["LRC_STATE_GPU_NAME"] or None,
    "gpuMemoryMb": int(os.environ["LRC_STATE_GPU_MEMORY"] or 0),
    "installRoot": os.environ["LRC_STATE_INSTALL_ROOT"],
    "modelRoot": os.environ["LRC_STATE_MODEL_ROOT"],
    "pythonRoot": os.environ["LRC_STATE_PYTHON_ROOT"],
    "managedPython": os.environ["LRC_STATE_MANAGED_PYTHON"],
    "modelBytes": int(os.environ["LRC_STATE_MODEL_BYTES"]),
    "modelsDownloaded": os.environ["LRC_STATE_MODELS_DOWNLOADED"] == "1",
    "expectedDownload": os.environ["LRC_STATE_EXPECTED_DOWNLOAD"],
    "expectedInstalledSize": os.environ["LRC_STATE_EXPECTED_INSTALLED"],
}
with open(os.environ["LRC_STATE_PATH"], "w", encoding="utf-8") as handle:
    json.dump(state, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

echo "Cleaning rebuildable package download cache..."
"$uv_command" cache clean
if [[ -d "$download_cache_root" && -z "$(ls -A "$download_cache_root" 2>/dev/null)" ]]; then
    rmdir "$download_cache_root"
fi

echo
echo "Installation complete."
echo "Acceleration: $compute_mode"
echo "Models:      $model_root"
echo "Start:       $install_root/start-ai-aligner.sh"
echo "Stop the foreground service with Ctrl+C. Repeated starts are safely ignored."
