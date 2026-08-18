from __future__ import annotations

import contextvars
import hmac
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from lyrics_aligner import server as engine
from lyrics_aligner import audio as aligner_audio
from lyrics_aligner import separation as aligner_separation
from lyrics_aligner.backends import faster_whisper_backend

app = engine.app
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])
_runtime_root = engine.RUNTIME_ROOT.resolve()
_pid_path = _runtime_root / "service.pid"
_keep_marker = ".lrc-editor-keep-cache"
_terminal_seen: dict[str, float] = {}
_control_token = secrets.token_urlsafe(32)
_cancel_events: dict[str, threading.Event] = {}
_job_devices: dict[str, str] = {}
_job_context = threading.local()
_uvicorn_server: uvicorn.Server | None = None
_requested_device: contextvars.ContextVar[str] = contextvars.ContextVar(
    "lrc_editor_requested_device",
    default="auto",
)


class AlignmentCancelled(RuntimeError):
    pass


_original_run_job = engine._run_job
_original_set_job = engine._set_job
_original_align_file_hybrid = engine.align_file_hybrid
_original_executor = engine.executor


def _cancel_event(job_id: str) -> threading.Event:
    return _cancel_events.setdefault(job_id, threading.Event())


def _cancellable_set_job(job_id: str, **changes: object) -> None:
    terminal = changes.get("status") in {"complete", "failed"}
    if _cancel_event(job_id).is_set() and not terminal:
        raise AlignmentCancelled("Alignment stopped by the user")
    _original_set_job(job_id, **changes)


def _device_align_file_hybrid(*args: object, **kwargs: object):
    job_id = getattr(_job_context, "job_id", "")
    kwargs["device"] = _job_devices.get(job_id, "auto")
    return _original_align_file_hybrid(*args, **kwargs)


def _run_job(job_id: str) -> None:
    event = _cancel_event(job_id)
    if event.is_set():
        _original_set_job(
            job_id,
            status="failed",
            stage="failed",
            detail="任务已停止",
            error="Alignment stopped by the user",
        )
        _job_devices.pop(job_id, None)
        _cancel_events.pop(job_id, None)
        return
    _job_context.job_id = job_id
    try:
        _original_run_job(job_id)
    finally:
        _job_context.job_id = ""
        _job_devices.pop(job_id, None)
        _cancel_events.pop(job_id, None)


class _DeviceExecutor:
    def submit(self, function, *args, **kwargs):
        if args and isinstance(args[0], str):
            _job_devices[args[0]] = _requested_device.get()
        return _original_executor.submit(function, *args, **kwargs)


class _SubprocessProxy:
    def __getattr__(self, name: str):
        return getattr(subprocess, name)

    def run(self, *popenargs, input=None, capture_output=False, timeout=None, check=False, **kwargs):
        job_id = getattr(_job_context, "job_id", "")
        if not job_id:
            return subprocess.run(
                *popenargs,
                input=input,
                capture_output=capture_output,
                timeout=timeout,
                check=check,
                **kwargs,
            )
        event = _cancel_event(job_id)
        if event.is_set():
            raise AlignmentCancelled("Alignment stopped by the user")
        if input is not None and kwargs.get("stdin") is not None:
            raise ValueError("stdin and input arguments may not both be used")
        if capture_output:
            if kwargs.get("stdout") is not None or kwargs.get("stderr") is not None:
                raise ValueError("stdout and stderr arguments may not be used with capture_output")
            kwargs["stdout"] = subprocess.PIPE
            kwargs["stderr"] = subprocess.PIPE
        process = subprocess.Popen(*popenargs, **kwargs)
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        pending_input = input
        try:
            while True:
                if event.is_set():
                    process.terminate()
                    try:
                        process.communicate(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                    raise AlignmentCancelled("Alignment stopped by the user")
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    process.kill()
                    stdout, stderr = process.communicate()
                    raise subprocess.TimeoutExpired(process.args, timeout, output=stdout, stderr=stderr)
                try:
                    stdout, stderr = process.communicate(
                        input=pending_input,
                        timeout=0.2 if remaining is None else min(0.2, remaining),
                    )
                    break
                except subprocess.TimeoutExpired:
                    pending_input = None
        finally:
            pending_input = None
        completed = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
        if check:
            completed.check_returncode()
        return completed


engine._run_job = _run_job
engine._set_job = _cancellable_set_job
engine.align_file_hybrid = _device_align_file_hybrid
engine.executor = _DeviceExecutor()
_subprocess_proxy = _SubprocessProxy()
aligner_audio.subprocess = _subprocess_proxy
aligner_separation.subprocess = _subprocess_proxy
faster_whisper_backend.subprocess = _subprocess_proxy


def _runtime_child(path: Path) -> Path:
    resolved = path.resolve()
    if resolved == _runtime_root or _runtime_root not in resolved.parents:
        raise RuntimeError("Refusing to clean a path outside the local aligner runtime")
    return resolved


def _tree_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _remove_tree(path: Path) -> int:
    target = _runtime_child(path)
    reclaimed = _tree_size(target)
    if target.exists():
        shutil.rmtree(target)
    return reclaimed


def _job_cache_path(job: engine.Job) -> Path:
    suffix = "vocals" if job.separate else "mix"
    return engine.RUNTIME_ROOT / "work-cache" / f"{job.audio_digest}-{suffix}"


def _delete_job(job: engine.Job, *, reusable_cache: bool) -> int:
    reclaimed = _remove_tree(job.directory)
    if reusable_cache and not job.bypass_cache:
        reclaimed += _remove_tree(_job_cache_path(job))
    return reclaimed


@app.delete("/api/jobs/{job_id}/cache")
def delete_job_cache(job_id: str) -> dict[str, object]:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid local alignment job ID")
    with engine.jobs_lock:
        job = engine.jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Local alignment job was not found")
        if job.status in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="Local alignment job is still running")
        engine.jobs.pop(job_id, None)
        _terminal_seen.pop(job_id, None)
    try:
        reclaimed = _delete_job(job, reusable_cache=True)
    except OSError as error:
        with engine.jobs_lock:
            engine.jobs[job_id] = job
        raise HTTPException(status_code=500, detail=f"Unable to delete local task cache: {error}") from error
    return {"deleted": True, "reclaimed_bytes": reclaimed}


@app.get("/api/lrc-editor/capabilities")
def companion_capabilities() -> dict[str, object]:
    visible_cuda = os.environ.get("CUDA_VISIBLE_DEVICES", "-1").strip()
    gpu_available = visible_cuda not in {"", "-1"}
    return {
        "control_token": _control_token,
        "gpu_available": gpu_available,
        "device_options": ["auto", "cpu"],
    }


@app.post("/api/lrc-editor/jobs")
async def create_companion_job(
    audio: UploadFile = File(...),
    transcript: UploadFile | None = File(None),
    transcript_text: str | None = Form(None),
    separate: bool = Form(True),
    bypass_cache: bool = Form(False),
    preserve_blank_lines: bool = Form(True),
    word_timing_beta: bool = Form(False),
    device: str = Form("auto"),
) -> dict[str, object]:
    selected_device = device if device in {"auto", "cpu"} else "auto"
    context_token = _requested_device.set(selected_device)
    try:
        return await engine.create_job(
            audio=audio,
            transcript=transcript,
            transcript_text=transcript_text,
            separate=separate,
            bypass_cache=bypass_cache,
            preserve_blank_lines=preserve_blank_lines,
            word_timing_beta=word_timing_beta,
        )
    finally:
        _requested_device.reset(context_token)


def _require_control_token(value: str | None) -> None:
    if value is None or not hmac.compare_digest(value, _control_token):
        raise HTTPException(status_code=403, detail="Invalid companion control token")


def _cleanup_cancelled_job(job_id: str) -> None:
    for _ in range(300):
        time.sleep(0.1)
        with engine.jobs_lock:
            job = engine.jobs.get(job_id)
            if job is None:
                return
            if job.status not in {"complete", "failed"}:
                continue
            if not job.bypass_cache:
                return
            engine.jobs.pop(job_id, None)
            _terminal_seen.pop(job_id, None)
        try:
            _delete_job(job, reusable_cache=True)
        except OSError:
            pass
        return


@app.post("/api/lrc-editor/jobs/{job_id}/cancel")
def cancel_companion_job(
    job_id: str,
    control_token: str | None = Header(None, alias="X-LRC-Editor-Control"),
) -> dict[str, object]:
    _require_control_token(control_token)
    if not re.fullmatch(r"[a-f0-9]{32}", job_id, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Invalid local alignment job ID")
    with engine.jobs_lock:
        job = engine.jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Local alignment job was not found")
        if job.status not in {"queued", "running"}:
            return {"accepted": True, "status": job.status}
        _cancel_event(job_id).set()
        job.stage = "stopping"
        job.detail = "正在停止本次对轴"
    threading.Thread(
        target=_cleanup_cancelled_job,
        args=(job_id,),
        name=f"lrc-editor-cancel-{job_id[:8]}",
        daemon=True,
    ).start()
    return {"accepted": True, "status": "stopping"}


def _stop_uvicorn_after_response() -> None:
    time.sleep(0.25)
    if _uvicorn_server is not None:
        _uvicorn_server.should_exit = True


@app.post("/api/lrc-editor/service/stop")
def stop_companion_service(
    control_token: str | None = Header(None, alias="X-LRC-Editor-Control"),
) -> dict[str, object]:
    _require_control_token(control_token)
    with engine.jobs_lock:
        if any(job.status in {"queued", "running"} for job in engine.jobs.values()):
            raise HTTPException(
                status_code=409,
                detail="Stop the current AI alignment task before stopping the service",
            )
    threading.Thread(
        target=_stop_uvicorn_after_response,
        name="lrc-editor-service-stop",
        daemon=True,
    ).start()
    return {"accepted": True}


@app.delete("/api/lrc-editor/cache")
def clear_companion_cache(
    control_token: str | None = Header(None, alias="X-LRC-Editor-Control"),
) -> dict[str, object]:
    _require_control_token(control_token)
    with engine.jobs_lock:
        if any(job.status in {"queued", "running"} for job in engine.jobs.values()):
            raise HTTPException(
                status_code=409,
                detail="Stop the current AI alignment task before clearing its cache",
            )
        engine.jobs.clear()
        _terminal_seen.clear()
    try:
        reclaimed = _remove_tree(engine.RUNTIME_ROOT / "jobs")
        reclaimed += _remove_tree(engine.RUNTIME_ROOT / "work-cache")
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to clear local AI cache: {error}") from error
    return {"deleted": True, "reclaimed_bytes": reclaimed}


def _remove_abandoned_default_jobs() -> None:
    jobs_root = engine.RUNTIME_ROOT / "jobs"
    if not jobs_root.is_dir():
        return
    for directory in jobs_root.iterdir():
        if directory.is_dir() and not (directory / _keep_marker).is_file():
            _remove_tree(directory)


def _janitor() -> None:
    while True:
        time.sleep(5)
        now = time.monotonic()
        cleanup: list[engine.Job] = []
        with engine.jobs_lock:
            for job_id, job in list(engine.jobs.items()):
                if not job.bypass_cache:
                    job.directory.mkdir(parents=True, exist_ok=True)
                    (job.directory / _keep_marker).touch(exist_ok=True)
                    continue
                if job.status not in {"complete", "failed"}:
                    _terminal_seen.pop(job_id, None)
                    continue
                first_seen = _terminal_seen.setdefault(job_id, now)
                if now - first_seen >= 300:
                    engine.jobs.pop(job_id, None)
                    _terminal_seen.pop(job_id, None)
                    cleanup.append(job)
        for job in cleanup:
            try:
                _delete_job(job, reusable_cache=True)
            except OSError:
                pass


def _write_pid() -> None:
    temporary = _pid_path.with_suffix(".pid.tmp")
    temporary.write_text(f"{os.getpid()}\n", encoding="ascii")
    temporary.replace(_pid_path)


def _remove_pid() -> None:
    try:
        if _pid_path.read_text(encoding="ascii").strip() == str(os.getpid()):
            _pid_path.unlink(missing_ok=True)
    except OSError:
        pass


def main() -> None:
    global _uvicorn_server
    engine.RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    _remove_abandoned_default_jobs()
    threading.Thread(target=_janitor, name="lrc-editor-cache-janitor", daemon=True).start()
    _write_pid()
    try:
        config = uvicorn.Config(app, host="127.0.0.1", port=engine._server_port(), reload=False)
        _uvicorn_server = uvicorn.Server(config)
        _uvicorn_server.run()
    finally:
        _uvicorn_server = None
        _remove_pid()


if __name__ == "__main__":
    main()
