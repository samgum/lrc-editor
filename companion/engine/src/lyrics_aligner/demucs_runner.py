from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

import soundfile
import torch
from demucs.audio import prevent_clip
from demucs.separate import main as demucs_main


def _save_lossless_audio(
    wav: torch.Tensor,
    path: str | Path,
    samplerate: int,
    bitrate: int = 320,
    clip: Literal["rescale", "clamp", "tanh", "none"] = "rescale",
    bits_per_sample: Literal[16, 24, 32] = 16,
    as_float: bool = False,
    preset: Literal[2, 3, 4, 5, 6, 7] = 2,
) -> None:
    """Demucs save hook that avoids Torchaudio/TorchCodec on Windows.

    Demucs 4 calls ``torchaudio.save``. Torchaudio 2.10 routes that through
    TorchCodec, whose Windows wheel needs a shared-FFmpeg installation. The
    project already has a working static FFmpeg, so requiring a second system
    FFmpeg would be brittle. SoundFile writes the separated tensor directly to
    a lossless WAV instead.
    """

    del bitrate, preset
    destination = Path(path)
    if destination.suffix.lower() != ".wav":
        raise ValueError("本项目的人声分离只写无损 WAV。")
    destination.parent.mkdir(parents=True, exist_ok=True)

    prepared = prevent_clip(wav, mode=clip)
    samples = prepared.detach().to(device="cpu", dtype=torch.float32)
    audio = samples.transpose(0, 1).contiguous().numpy()
    if as_float:
        subtype = "FLOAT"
    else:
        subtype = {16: "PCM_16", 24: "PCM_24", 32: "PCM_32"}[bits_per_sample]
    soundfile.write(
        str(destination),
        audio,
        samplerate,
        format="WAV",
        subtype=subtype,
    )


def main() -> None:
    # demucs.separate imported save_audio into its own module namespace, so
    # replace that binding rather than demucs.audio.save_audio.
    import demucs.separate

    demucs.separate.save_audio = _save_lossless_audio
    demucs_main(sys.argv[1:])


if __name__ == "__main__":
    main()
