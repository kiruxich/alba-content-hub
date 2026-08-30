import asyncio
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from video_core import Job, run_assembly_job

DATA_DIR = os.environ.get("VIDEO_WORKER_DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
WORKER_TOKEN = os.environ.get("VIDEO_WORKER_TOKEN", "")

app = FastAPI(title="alba-video-worker")


@app.middleware("http")
async def require_worker_token(request, call_next):
    # Same defense-in-depth pattern as parser-worker/main.py's
    # require_worker_token: the ufw rule scoping this port to the Coolify
    # docker subnet is the primary control, this is the second layer. Every
    # request except /health must carry the shared token the Node backend
    # sends.
    if WORKER_TOKEN and request.url.path != "/health":
        if request.headers.get("x-worker-token") != WORKER_TOKEN:
            return JSONResponse({"detail": "bad worker token"}, status_code=401)
    return await call_next(request)


jobs: dict[str, Job] = {}
queue: asyncio.Queue = asyncio.Queue()


class CreateJobRequest(BaseModel):
    video_url: str
    audio_url: str
    caption_text: str = ""
    output_format: str = "mp4"


async def worker_loop():
    while True:
        job: Job = await queue.get()
        if job.cancelled:
            # Cancelled while still sitting in the queue, before any task
            # existed to call .cancel() on - honor it now instead of running
            # an assembly the caller already tried to stop. Same pattern as
            # parser-worker/main.py's worker_loop.
            queue.task_done()
            continue
        try:
            job.task = asyncio.current_task()
            await run_assembly_job(job)
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.log("⏹ Остановлено пользователем")
        except Exception as e:
            job.status = "error"
            job.error = str(e)
            job.log(f"Фатальная ошибка: {e}")
        finally:
            job.task = None
        queue.task_done()


@app.on_event("startup")
async def startup():
    os.makedirs(DATA_DIR, exist_ok=True)
    asyncio.create_task(worker_loop())


@app.post("/jobs")
async def create_job(body: CreateJobRequest):
    if not body.video_url.strip() or not body.audio_url.strip():
        raise HTTPException(400, "video_url and audio_url are required")
    job_id = str(uuid.uuid4())[:8]
    out_dir = os.path.join(DATA_DIR, job_id)
    job = Job(job_id, body.video_url, body.audio_url, body.caption_text, body.output_format, out_dir)
    jobs[job_id] = job
    await queue.put(job)
    job.log(f"Job поставлен в очередь (позиция: {queue.qsize()})")
    return {"job_id": job_id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "error": job.error,
        "log": "\n".join(job.log_lines[-200:]),
        "output_format": job.output_format,
        "files": {
            "output": os.path.exists(job.output_path),
        },
    }


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    # Mirrors parser-worker/main.py's cancel_job exactly: handles both an
    # in-flight job (cancel the asyncio.Task, which run_assembly_job's
    # CancelledError handler turns into killing the ffmpeg child too) and a
    # job still sitting in the queue (no task exists yet, so just flag it -
    # worker_loop checks job.cancelled right after dequeuing).
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.task and not job.task.done():
        job.task.cancel()
        return {"ok": True, "cancelled": True}
    if job.status == "queued":
        job.cancelled = True
        job.status = "cancelled"
        job.log("⏹ Остановлено пользователем (было в очереди)")
        return {"ok": True, "cancelled": True}
    return {"ok": True, "cancelled": False}


# DELETE alias for the same cancel semantics as POST /jobs/{id}/cancel above -
# offered because a DELETE /jobs/{id} reads more RESTfully for "stop/remove
# this job" from the Node client's point of view. Both routes share the exact
# same handler/behavior; neither actually erases the Job record (matching
# parser-worker, which also never removes finished jobs from its dict) - just
# stops it running.
@app.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    return await cancel_job(job_id)


@app.get("/jobs/{job_id}/file")
async def get_file(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if not os.path.exists(job.output_path):
        raise HTTPException(404, "output not ready")
    return FileResponse(job.output_path, filename=f"short-{job.id}.{job.output_format}")


@app.get("/health")
async def health():
    return {"ok": True, "queue_size": queue.qsize(), "jobs": len(jobs)}
