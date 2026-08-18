#!/bin/bash
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
cd "$HOME" || exit 1
"$script_dir/stop-ai-aligner.sh"
status=$?
echo
read -r -n 1 -s -p "Press any key to close..."
echo
exit "$status"
