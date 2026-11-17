#!/bin/bash
cd "$(dirname "$0")" || exit 1
./start-ai-aligner.sh
exit_code=$?
if [[ $exit_code -ne 0 && $exit_code -ne 130 ]]; then
    echo
    read -r -p "Press Enter to close this window..." _
fi
exit $exit_code
