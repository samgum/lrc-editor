#!/usr/bin/env bash
set -euo pipefail

install_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == "--install-root" ]]; then
    install_root="${2:-}"
fi
engine_root="$install_root/engine"
environment_root="$install_root/environment"
model_root="$install_root/models"
venv_python="$environment_root/bin/python"
companion_server="$install_root/lrc_editor_companion_server.py"
state_path="$install_root/install-state.json"
ports=(8765 {8876..8895})

if [[ ! -x "$venv_python" || ! -f "$engine_root/src/lyrics_aligner/server.py" || ! -f "$companion_server" ]]; then
    echo "The AI aligner is not installed. Run install-ai-aligner.sh first." >&2
    exit 1
fi
for prerequisite in curl ffmpeg ffprobe; do
    if ! command -v "$prerequisite" >/dev/null 2>&1; then
        echo "$prerequisite is unavailable. Run install-ai-aligner.sh again." >&2
        exit 1
    fi
done

for port in "${ports[@]}"; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/openapi.json" 2>/dev/null |
        grep -q '"title"[[:space:]]*:[[:space:]]*"Lyrics Forced Aligner"'; then
        echo "Lyrics Forced Aligner is already running at http://127.0.0.1:$port"
        exit 0
    fi
done

selected_port="$("$venv_python" - <<'PY'
import socket

for port in [8765, *range(8876, 8896)]:
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", port))
        print(port)
        break
    except OSError:
        pass
PY
)"
if [[ -z "$selected_port" ]]; then
    echo "No supported local port is available. Checked 8765 and 8876-8895." >&2
    exit 1
fi

acceleration="cpu"
cuda_device=""
gpu_name=""
if [[ -f "$state_path" ]]; then
    acceleration="$("$venv_python" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("acceleration", "cpu"))' "$state_path")"
    cuda_device="$("$venv_python" -c 'import json,sys; value=json.load(open(sys.argv[1], encoding="utf-8")).get("cudaDevice"); print("" if value is None else value)' "$state_path")"
    gpu_name="$("$venv_python" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("gpuName") or "")' "$state_path")"
fi
if [[ "$acceleration" == "cuda" ]]; then
    site_packages="$("$venv_python" -c 'import site; print(site.getsitepackages()[0])')"
    private_cuda_paths="$site_packages/nvidia/cublas/lib:$site_packages/nvidia/cudnn/lib"
    export LD_LIBRARY_PATH="$private_cuda_paths${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export CUDA_VISIBLE_DEVICES="$cuda_device"
    echo "Acceleration: isolated NVIDIA CUDA ($gpu_name)"
else
    export CUDA_VISIBLE_DEVICES=-1
    echo "Acceleration: CPU compatibility mode"
fi

export PYTHONPATH="$install_root:$engine_root/src"
export TORCH_HOME="$model_root/torch"
export HF_HOME="$model_root/huggingface"
export HF_HUB_DISABLE_SYMLINKS_WARNING=1
export LYRICS_ALIGNER_PORT="$selected_port"
export PYTHONWARNINGS="ignore:pkg_resources is deprecated as an API:UserWarning${PYTHONWARNINGS:+,$PYTHONWARNINGS}"

echo "Lyrics Forced Aligner is starting at http://127.0.0.1:$selected_port"
echo "Keep this terminal open while AI alignment is in use. Press Ctrl+C or run stop-ai-aligner.sh to stop."
cd "$engine_root"
exec "$venv_python" -m lrc_editor_companion_server
