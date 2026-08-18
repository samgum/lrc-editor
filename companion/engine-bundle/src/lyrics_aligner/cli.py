from __future__ import annotations

import argparse
import json
from pathlib import Path

from .evaluation import evaluate_reference_axes
from .export import export_json, export_lrc, export_srt
from .hybrid_pipeline import align_file_hybrid
from .pipeline import align_file


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lyrics-align",
        description=(
            "在本机用人声分离、多语言 Whisper 锚点和结构复核"
            "对齐歌词与音频。"
        ),
    )
    parser.add_argument("audio", type=Path, help="音频或视频文件")
    parser.add_argument("transcript", type=Path, help="TXT/LRC/SRT 文字稿")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("outputs"),
        help="输出目录（默认 outputs）",
    )
    parser.add_argument(
        "--language",
        default="auto",
        help="语言名；auto 根据每行文字脚本选择多个识别通道",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="auto、cuda:0 或 cpu",
    )
    parser.add_argument(
        "--model",
        default="Qwen/Qwen3-ForcedAligner-0.6B",
        help="qwen 基线所用模型",
    )
    parser.add_argument(
        "--whisper-model",
        default="large-v3-turbo",
        help="hybrid 粗锚点模型",
    )
    parser.add_argument(
        "--backend",
        choices=("hybrid", "qwen", "whisperx"),
        default="hybrid",
        help="默认使用经歌曲实测的分层流程",
    )
    parser.add_argument(
        "--no-separation",
        action="store_true",
        help="hybrid 模式跳过 Demucs 人声分离",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(".cache"),
        help="模型缓存目录",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=900.0,
        help="允许的最长音频秒数（默认 900）",
    )
    parser.add_argument(
        "--onset-compensation",
        type=float,
        default=0.25,
        help="歌声起点经验补偿秒数（默认 0.25）",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="若输入含 LRC 轴，输出与参考轴的误差指标",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.backend == "hybrid":
        result = align_file_hybrid(
            args.audio,
            args.transcript,
            languages=None if args.language == "auto" else [args.language],
            separate=not args.no_separation,
            whisper_model=args.whisper_model,
            device=args.device,
            work_dir=args.output_dir / ".work",
            cache_dir=args.cache_dir,
            max_audio_seconds=args.max_duration,
            onset_compensation=args.onset_compensation,
        )
    else:
        result = align_file(
            args.audio,
            args.transcript,
            language=args.language,
            model_id=args.model,
            device=args.device,
            backend=args.backend,
            work_dir=args.output_dir / ".work",
        )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = args.audio.stem
    outputs = {
        args.output_dir / f"{stem}.aligned.lrc": export_lrc(result, 3),
        args.output_dir / f"{stem}.aligned.2digits.lrc": export_lrc(result, 2),
        args.output_dir / f"{stem}.aligned.srt": export_srt(result),
        args.output_dir / f"{stem}.aligned.json": export_json(result),
    }
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8", newline="\n")

    summary: dict[str, object] = {
        "backend": result.backend,
        "model": result.model_id,
        "language": result.language,
        "lines": len(result.lines),
        "processing_seconds": round(result.processing_seconds, 3),
        "outputs": [str(path.resolve()) for path in outputs],
    }
    if args.evaluate:
        summary["metrics"] = evaluate_reference_axes(result).to_dict()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
