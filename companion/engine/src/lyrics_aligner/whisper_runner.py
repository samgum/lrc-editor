from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .backends.faster_whisper_backend import (
    FasterWhisperBackend,
    whisper_pass_to_dict,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--language", required=True)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--download-root", type=Path, required=True)
    args = parser.parse_args()

    backend = FasterWhisperBackend(
        args.model,
        device=args.device,
        download_root=args.download_root,
    )
    result = backend.transcribe(args.audio, language=args.language)
    payload = whisper_pass_to_dict(result)
    payload["source"] = str(args.audio.resolve())
    payload["source_size"] = args.audio.stat().st_size
    payload["source_mtime_ns"] = args.audio.stat().st_mtime_ns
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    # CTranslate2 4.6 + this Windows CUDA runtime can abort while destroying
    # the model after a successful inference. This process owns no other state:
    # after the atomic result file is closed, let Windows reclaim the process
    # resources without running the faulty native destructor.
    if os.name == "nt":
        os._exit(0)


if __name__ == "__main__":
    main()
