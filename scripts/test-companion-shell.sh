#!/usr/bin/env bash
set -euo pipefail

test_root="$(mktemp -d "${TMPDIR:-/tmp}/lrc-editor-uv-space.XXXXXX")"
cleanup() {
    case "$test_root" in
        "${TMPDIR:-/tmp}"/lrc-editor-uv-space.*) rm -rf -- "$test_root" ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT

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

bash -n companion/*.sh companion/*.command
