from __future__ import annotations

import argparse
import json
from pathlib import Path

from .backends.qwen_asr import (
    QwenASRBackend,
    qwen_timed_pass_to_dict,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--language", required=True)
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-0.6B")
    parser.add_argument(
        "--forced-aligner",
        default="Qwen/Qwen3-ForcedAligner-0.6B",
    )
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--forced-aligner-adapter", type=Path)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    backend = QwenASRBackend(
        model_id=args.model,
        device=args.device,
        adapter=args.adapter,
        forced_aligner_model_id=args.forced_aligner,
        forced_aligner_adapter=args.forced_aligner_adapter,
    )
    result = backend.transcribe_timed(
        args.audio,
        language=args.language,
    )
    payload = qwen_timed_pass_to_dict(result)
    payload["source"] = str(args.audio.resolve())
    payload["source_size"] = args.audio.stat().st_size
    payload["source_mtime_ns"] = args.audio.stat().st_mtime_ns
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


if __name__ == "__main__":
    main()
