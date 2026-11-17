#!/usr/bin/env bash
set -euo pipefail

tmp_base="${TMPDIR:-/tmp}"
tmp_base="${tmp_base%/}"
test_root="$(mktemp -d "$tmp_base/lrc-editor-uv-space.XXXXXX")"
cleanup() {
    case "$test_root" in
        "$tmp_base"/lrc-editor-uv-space.*) rm -rf -- "$test_root" ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT

export HOME="$test_root/isolated-home"
export XDG_CONFIG_HOME="$test_root/xdg-config"
export XDG_DATA_HOME="$test_root/xdg-data"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

spaced_root="$test_root/LRC Editor AI"
mkdir -p "$spaced_root"
printf '#!/usr/bin/env bash\necho uv 0.12.5\n' > "$spaced_root/uv"
chmod +x "$spaced_root/uv"
uv_command="$spaced_root/uv"
installed_uv_version="$("$uv_command" --version | awk '{ print $2 }')"
[[ "$installed_uv_version" == "0.12.5" ]]

launcher_root="$test_root/Downloaded Package"
installed_root="$test_root/Installed LRC Editor AI"
mkdir -p "$launcher_root" "$installed_root/engine" "$installed_root/environment"
printf '{}\n' > "$installed_root/install-state.json"
printf '%s\n' "$installed_root" > "$launcher_root/install-location.txt"
source companion/resolve-ai-aligner-install.sh
resolved_root="$(lrc_ai_resolve_install_root "$launcher_root" "")"
[[ "$resolved_root" == "$installed_root" ]]

missing_root="$test_root/Missing Package"
mkdir -p "$missing_root"
if lrc_ai_resolve_install_root "$missing_root" "" >/dev/null; then
    echo "Resolver unexpectedly accepted a missing installation" >&2
    exit 1
fi

registry_file="$(lrc_ai_location_registry)"
mkdir -p "$(dirname "$registry_file")"
printf '%s\n' "$installed_root" > "$registry_file"
resolved_from_registry="$(lrc_ai_resolve_install_root "$missing_root" "")"
[[ "$resolved_from_registry" == "$installed_root" ]]

bash -n companion/*.sh companion/*.command
