#!/usr/bin/env bash
set -euo pipefail

launcher_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
resolver="$launcher_root/resolve-ai-aligner-install.sh"
requested_root=""
if [[ "${1:-}" == "--install-root" ]]; then
    requested_root="${2:-}"
fi
if [[ ! -f "$resolver" ]]; then
    echo "The installation locator is missing." >&2
    exit 1
fi
source "$resolver"
if ! install_root="$(lrc_ai_resolve_install_root "$launcher_root" "$requested_root")"; then
    echo "No complete LRC Editor AI Aligner installation was found."
    exit 0
fi
pid_path="$install_root/runtime/service.pid"

is_aligner_process() {
    local process_id="$1"
    local command_line
    command_line="$(ps -p "$process_id" -o command= 2>/dev/null || true)"
    [[ "$command_line" == *"$install_root/"* && "$command_line" == *"lrc_editor_companion_server"* ]]
}

service_process_id=""
if [[ -f "$pid_path" ]]; then
    candidate="$(tr -d '[:space:]' < "$pid_path")"
    if [[ "$candidate" =~ ^[0-9]+$ ]] && is_aligner_process "$candidate"; then
        service_process_id="$candidate"
    fi
fi
if [[ -z "$service_process_id" ]] && command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r candidate; do
        if [[ "$candidate" =~ ^[0-9]+$ ]] && is_aligner_process "$candidate"; then
            service_process_id="$candidate"
            break
        fi
    done < <(pgrep -f "lrc_editor_companion_server" || true)
fi

if [[ -z "$service_process_id" ]]; then
    rm -f -- "$pid_path"
    echo "LRC Editor AI Aligner is not running."
    exit 0
fi

kill "$service_process_id"
for _ in {1..50}; do
    if ! kill -0 "$service_process_id" 2>/dev/null; then
        break
    fi
    sleep 0.2
done
if kill -0 "$service_process_id" 2>/dev/null; then
    kill -KILL "$service_process_id"
fi
rm -f -- "$pid_path"
echo "LRC Editor AI Aligner stopped."
