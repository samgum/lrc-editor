#!/bin/bash
cd "$(dirname "$0")" || exit 1
./install-ai-aligner.sh
status=$?
echo
read -r -n 1 -s -p "Press any key to close..."
echo
exit "$status"
