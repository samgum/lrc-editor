from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import traceback
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .export import (
    export_enhanced_lrc_beta,
    export_json,
    export_lrc,
    export_srt,
    format_lrc_timestamp,
)
from .hybrid_pipeline import align_file_hybrid
from .word_timing import attach_word_timing_beta

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = PROJECT_ROOT / "web"
RUNTIME_ROOT = PROJECT_ROOT / "runtime"
CACHE_ROOT = PROJECT_ROOT / ".cache"
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
DEFAULT_SERVER_PORT = 8765


def _server_port() -> int:
    raw_port = os.environ.get("LYRICS_ALIGNER_PORT", "").strip()
    if not raw_port:
        return DEFAULT_SERVER_PORT
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise RuntimeError(
            "LYRICS_ALIGNER_PORT 必须是 1 到 65535 之间的整数。"
        ) from exc
    if not 1 <= port <= 65535:
        raise RuntimeError(
            "LYRICS_ALIGNER_PORT 必须是 1 到 65535 之间的整数。"
        )
    return port


@dataclass(slots=True)
class Job:
    id: str
    audio_name: str
    transcript_name: str
    directory: Path
    audio_path: Path
    transcript_path: Path
    audio_digest: str
    separate: bool
    bypass_cache: bool = False
    preserve_blank_lines: bool = True
    word_timing_beta: bool = False
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    detail: str = "等待 GPU"
    error: str | None = None
    outputs: dict[str, Path] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    preview: list[dict[str, Any]] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "audio_name": self.audio_name,
            "transcript_name": self.transcript_name,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "detail": self.detail,
            "error": self.error,
            "bypass_cache": self.bypass_cache,
            "preserve_blank_lines": self.preserve_blank_lines,
            "word_timing_beta": self.word_timing_beta,
            "summary": self.summary,
            "preview": self.preview,
        }
        if self.status == "complete":
            payload["downloads"] = {
                name: f"/api/jobs/{self.id}/download/{name}"
                for name in self.outputs
            }
        return payload


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lyrics-align")

app = FastAPI(
    title="Lyrics Forced Aligner",
    version="0.2.27",
    docs_url="/api/docs",
)
app.mount("/static", StaticFiles(directory=WEB_ROOT), name="static")


def _safe_name(filename: str | None, fallback: str) -> str:
    name = Path(filename or fallback).name
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return sanitized or fallback


async def _save_upload(
    upload: UploadFile,
    destination: Path,
    *,
    limit: int,
) -> tuple[int, str]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    digest = hashlib.sha256()
    with destination.open("wb") as handle:
        while chunk := await upload.read(1024 * 1024):
            written += len(chunk)
            if written > limit:
                raise HTTPException(
                    status_code=413,
                    detail="上传文件超过本地任务允许的大小。",
                )
            handle.write(chunk)
            digest.update(chunk)
    await upload.close()
    if written == 0:
        raise HTTPException(status_code=400, detail="上传文件为空。")
    return written, digest.hexdigest()


def _set_job(job_id: str, **changes: Any) -> None:
    with jobs_lock:
        job = jobs[job_id]
        for key, value in changes.items():
            setattr(job, key, value)


def _run_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs[job_id]
        audio_path = job.audio_path
        transcript_path = job.transcript_path
        cache_name = (
            f"{job.audio_digest}-"
            f"{'vocals' if job.separate else 'mix'}"
        )
        work_dir = (
            job.directory / "work-no-cache"
            if job.bypass_cache
            else RUNTIME_ROOT / "work-cache" / cache_name
        )
        separate = job.separate
        bypass_cache = job.bypass_cache
        preserve_blank_lines = job.preserve_blank_lines
        word_timing_beta = job.word_timing_beta
    _set_job(
        job_id,
        status="running",
        stage="prepare",
        progress=0.01,
        detail="任务已开始",
    )

    def progress(stage: str, value: float, detail: str) -> None:
        reported_stage = stage
        reported_detail = detail
        reported_value = value
        if word_timing_beta:
            reported_value = value * 0.9
            if stage == "done":
                reported_stage = "merge"
                reported_detail = "逐行对齐完成，准备生成逐字 Beta"
        _set_job(
            job_id,
            stage=reported_stage,
            progress=max(0.0, min(1.0, reported_value)),
            detail=reported_detail,
        )

    try:
        alignment_source = audio_path
        if not bypass_cache:
            cached_source_dir = work_dir / "source"
            cached_source_dir.mkdir(parents=True, exist_ok=True)
            cached_source = cached_source_dir / (
                "input" + audio_path.suffix.casefold()
            )
            if not cached_source.is_file():
                partial = cached_source.with_suffix(
                    cached_source.suffix + ".partial"
                )
                shutil.copy2(audio_path, partial)
                partial.replace(cached_source)
            alignment_source = cached_source
        result = align_file_hybrid(
            alignment_source,
            transcript_path,
            separate=separate,
            work_dir=work_dir,
            cache_dir=CACHE_ROOT,
            preserve_blank_lines=preserve_blank_lines,
            progress_callback=progress,
        )
        if word_timing_beta:
            _set_job(
                job_id,
                stage="word-align",
                progress=0.92,
                detail="正在生成逐字时间 Beta；逐行起点保持锁定",
            )
            analysis_audio = Path(
                str(
                    result.metadata.get(
                        "analysis_audio",
                        work_dir / "alignment-input.wav",
                    )
                )
            )
            try:
                result = attach_word_timing_beta(
                    result,
                    analysis_audio,
                )
            except Exception as word_error:
                result.warnings.append(
                    "逐字 Beta 未完成；逐行结果仍然有效。"
                )
                result.metadata["word_timing_beta"] = {
                    "status": "failed",
                    "line_starts_locked": True,
                    "aligned_lines": 0,
                    "fallback_lines": len(result.lines),
                    "token_count": 0,
                    "error": str(word_error),
                }
        output_dir = job.directory / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(job.audio_name).stem
        output_paths = {
            "lrc3": output_dir / f"{stem}.aligned.lrc",
            "lrc2": output_dir / f"{stem}.aligned.2digits.lrc",
            "srt": output_dir / f"{stem}.aligned.srt",
            "json": output_dir / f"{stem}.aligned.json",
        }
        contents = {
            "lrc3": export_lrc(result, 3),
            "lrc2": export_lrc(result, 2),
            "srt": export_srt(result),
            "json": export_json(result),
        }
        word_timing_summary = result.metadata.get("word_timing_beta", {})
        if (
            word_timing_beta
            and int(word_timing_summary.get("aligned_lines", 0)) > 0
        ):
            output_paths["word_lrc"] = (
                output_dir / f"{stem}.word-beta.lrc"
            )
            contents["word_lrc"] = export_enhanced_lrc_beta(result, 3)
        for name, path in output_paths.items():
            path.write_text(
                contents[name],
                encoding="utf-8",
                newline="\n",
            )
        archive = output_dir / f"{stem}.aligned.all.zip"
        with zipfile.ZipFile(
            archive,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as package:
            for path in output_paths.values():
                package.write(path, arcname=path.name)
        output_paths["all"] = archive

        anchors = result.metadata.get("anchors", [])
        low_confidence = sum(
            bool(anchor.get("interpolated"))
            or float(anchor.get("confidence", 0.0)) < 0.4
            for anchor in anchors
        )
        preview = [
            {
                "line": item.line.index,
                "time": format_lrc_timestamp(item.start, 3),
                "seconds": item.start,
                "text": item.line.text,
                "language": item.language,
                "warnings": list(item.warnings),
            }
            for item in result.lines[:200]
        ]
        summary = {
            "backend": result.backend,
            "model": result.model_id,
            "language": result.language,
            "lines": len(result.lines),
            "duration": result.metadata.get("duration"),
            "processing_seconds": round(result.processing_seconds, 2),
            "separation": result.metadata.get("separation"),
            "passes": result.metadata.get("languages", []),
            "low_confidence_lines": low_confidence,
            "reference_axes_used": False,
            "cache_policy": "bypass" if bypass_cache else "reuse",
            "preserve_blank_lines": preserve_blank_lines,
            "word_timing_beta": {
                "requested": word_timing_beta,
                "status": (
                    word_timing_summary.get("status", "not_requested")
                    if word_timing_beta
                    else "not_requested"
                ),
                "line_starts_locked": True,
                "aligned_lines": int(
                    word_timing_summary.get("aligned_lines", 0)
                ),
                "fallback_lines": int(
                    word_timing_summary.get("fallback_lines", 0)
                ),
                "token_count": int(
                    word_timing_summary.get("token_count", 0)
                ),
            },
        }
        _set_job(
            job_id,
            status="complete",
            stage="done",
            progress=1.0,
            detail="对齐与导出完成",
            outputs=output_paths,
            summary=summary,
            preview=preview,
        )
    except Exception as error:
        error_log = job.directory / "error.log"
        error_log.write_text(traceback.format_exc(), encoding="utf-8")
        _set_job(
            job_id,
            status="failed",
            stage="failed",
            detail="任务未完成",
            error=str(error),
        )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/api/health")
def health() -> dict[str, object]:
    with jobs_lock:
        running = sum(job.status == "running" for job in jobs.values())
        queued = sum(job.status == "queued" for job in jobs.values())
    return {
        "ok": True,
        "gpu_queue": {"running": running, "queued": queued},
        "max_duration_seconds": 900,
    }


@app.post("/api/jobs")
async def create_job(
    audio: UploadFile = File(...),
    transcript: UploadFile | None = File(None),
    transcript_text: str | None = Form(None),
    separate: bool = Form(True),
    bypass_cache: bool = Form(False),
    preserve_blank_lines: bool = Form(True),
    word_timing_beta: bool = Form(False),
) -> dict[str, object]:
    if transcript is None and not (transcript_text or "").strip():
        raise HTTPException(
            status_code=400,
            detail="请上传歌词文件或粘贴文字稿。",
        )
    job_id = uuid.uuid4().hex
    directory = RUNTIME_ROOT / "jobs" / job_id
    audio_name = _safe_name(audio.filename, "audio.bin")
    audio_path = directory / "input" / audio_name
    _, audio_digest = await _save_upload(
        audio,
        audio_path,
        limit=MAX_UPLOAD_BYTES,
    )

    if transcript is not None and transcript.filename:
        transcript_name = _safe_name(transcript.filename, "lyrics.txt")
        transcript_path = directory / "input" / transcript_name
        await _save_upload(
            transcript,
            transcript_path,
            limit=MAX_TRANSCRIPT_BYTES,
        )
    else:
        text = (transcript_text or "").strip()
        if len(text.encode("utf-8")) > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(status_code=413, detail="文字稿过大。")
        transcript_name = "pasted-lyrics.txt"
        transcript_path = directory / "input" / transcript_name
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(
            text + "\n",
            encoding="utf-8",
            newline="\n",
        )

    job = Job(
        id=job_id,
        audio_name=audio_name,
        transcript_name=transcript_name,
        directory=directory,
        audio_path=audio_path,
        transcript_path=transcript_path,
        audio_digest=audio_digest,
        separate=separate,
        bypass_cache=bypass_cache,
        preserve_blank_lines=preserve_blank_lines,
        word_timing_beta=word_timing_beta,
    )
    with jobs_lock:
        jobs[job_id] = job
    executor.submit(_run_job, job_id)
    return job.public()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, object]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="找不到这个任务。")
        return job.public()


@app.get("/api/jobs/{job_id}/download/{output_name}")
def download(job_id: str, output_name: str) -> FileResponse:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="找不到这个任务。")
        path = job.outputs.get(output_name)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="输出文件尚不可用。")
    return FileResponse(path, filename=path.name)


def main() -> None:
    import uvicorn

    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    uvicorn.run(
        "lyrics_aligner.server:app",
        host="127.0.0.1",
        port=_server_port(),
        reload=False,
    )


if __name__ == "__main__":
    main()
