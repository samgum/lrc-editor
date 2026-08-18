from __future__ import annotations

import re
import os
import shutil
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import HTTPException
from lyrics_aligner import server as engine

app = engine.app
_runtime_root = engine.RUNTIME_ROOT.resolve()
_pid_path = _runtime_root / "service.pid"
_keep_marker = ".lrc-editor-keep-cache"
_terminal_seen: dict[str, float] = {}


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
    engine.RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    _remove_abandoned_default_jobs()
    threading.Thread(target=_janitor, name="lrc-editor-cache-janitor", daemon=True).start()
    _write_pid()
    try:
        uvicorn.run(app, host="127.0.0.1", port=engine._server_port(), reload=False)
    finally:
        _remove_pid()


if __name__ == "__main__":
    main()
