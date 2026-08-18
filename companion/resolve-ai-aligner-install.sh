#!/usr/bin/env bash

lrc_ai_default_install_root() {
    case "$(uname -s)" in
        Darwin) printf '%s\n' "$HOME/Library/Application Support/LRC Editor/AI Aligner" ;;
        Linux) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/LRC Editor/AI Aligner" ;;
        *) return 1 ;;
    esac
}

lrc_ai_location_registry() {
    case "$(uname -s)" in
        Darwin) printf '%s\n' "$HOME/Library/Application Support/LRC Editor/ai-aligner-location.txt" ;;
        Linux) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/lrc-editor/ai-aligner-location.txt" ;;
        *) return 1 ;;
    esac
}

lrc_ai_is_installed() {
    local candidate="${1%/}"
    [[ "$candidate" == /* && -f "$candidate/install-state.json" && -d "$candidate/engine" && \
        -d "$candidate/environment" ]]
}

lrc_ai_read_location() {
    local location_file="$1"
    local candidate=""
    if [[ -f "$location_file" ]]; then
        IFS= read -r candidate < "$location_file" || true
        candidate="${candidate%$'\r'}"
        if lrc_ai_is_installed "$candidate"; then
            printf '%s\n' "${candidate%/}"
            return 0
        fi
    fi
    return 1
}

lrc_ai_resolve_install_root() {
    local launcher_root="${1%/}"
    local requested_root="${2:-}"
    local candidate=""
    local registry=""

    if [[ -n "$requested_root" ]]; then
        printf '%s\n' "${requested_root%/}"
        return 0
    fi
    if lrc_ai_is_installed "$launcher_root"; then
        printf '%s\n' "$launcher_root"
        return 0
    fi
    if candidate="$(lrc_ai_read_location "$launcher_root/install-location.txt")"; then
        printf '%s\n' "$candidate"
        return 0
    fi
    registry="$(lrc_ai_location_registry || true)"
    if [[ -n "$registry" ]] && candidate="$(lrc_ai_read_location "$registry")"; then
        printf '%s\n' "$candidate"
        return 0
    fi
    candidate="$(lrc_ai_default_install_root || true)"
    if [[ -n "$candidate" ]] && lrc_ai_is_installed "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
    fi
    if [[ -t 0 ]]; then
        echo "The installed AI aligner directory could not be found automatically." >&2
        read -r -p "Install directory: " candidate
        printf '%s\n' "${candidate%/}"
        return 0
    fi
    printf '%s\n' "$launcher_root"
}
