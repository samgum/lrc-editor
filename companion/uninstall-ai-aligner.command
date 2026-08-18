#!/bin/bash
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
uninstall_script="$script_dir/uninstall-ai-aligner.sh"
cd "$HOME" || exit 1
"$uninstall_script"
status=$?
echo
read -r -n 1 -s -p "Press any key to close..."
echo
exit "$status"
