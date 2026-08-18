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
install_root="$(lrc_ai_resolve_install_root "$launcher_root" "$requested_root")"
location_registry="$(lrc_ai_location_registry || true)"
if [[ "$install_root" != /* ]]; then
    echo "Install directory must be an absolute path." >&2
    exit 1
fi
install_root="${install_root%/}"
if [[ -z "$install_root" || "$install_root" == "/" || "$install_root" == "$HOME" || \
    ! -f "$install_root/install-state.json" || ! -d "$install_root/engine" ]]; then
    echo "This directory is not a verified LRC Editor AI Aligner installation: $install_root" >&2
    exit 1
fi
if [[ ! -t 0 ]]; then
    echo "Uninstall requires an interactive terminal for two confirmations." >&2
    exit 1
fi

echo "LRC Editor AI Aligner will be permanently removed."
echo "Directory: $install_root"
echo "This deletes the engine, models, private Python/CUDA runtime, settings, and task data."
echo "FFmpeg, Homebrew, and package-manager prerequisites outside this directory are not removed."
echo
read -r -p "First confirmation: type UNINSTALL: " first_confirmation
if [[ "$first_confirmation" != "UNINSTALL" ]]; then
    echo "Uninstall cancelled."
    exit 0
fi
read -r -p "Second confirmation: type the complete directory shown above: " second_confirmation
if [[ "$second_confirmation" != "$install_root" ]]; then
    echo "The directory did not match. Uninstall cancelled."
    exit 0
fi

if [[ -x "$install_root/stop-ai-aligner.sh" ]]; then
    "$install_root/stop-ai-aligner.sh" --install-root "$install_root"
fi
cd /
rm -rf -- "$install_root"
if [[ -e "$install_root" ]]; then
    echo "Some files could not be removed from $install_root" >&2
    exit 1
fi
for location_file in "$launcher_root/install-location.txt" "$location_registry"; do
    if [[ -n "$location_file" && -f "$location_file" ]]; then
        recorded_root=""
        IFS= read -r recorded_root < "$location_file" || true
        recorded_root="${recorded_root%$'\r'}"
        if [[ "${recorded_root%/}" == "$install_root" ]]; then
            rm -f -- "$location_file"
        fi
    fi
done
echo "LRC Editor AI Aligner was removed."
