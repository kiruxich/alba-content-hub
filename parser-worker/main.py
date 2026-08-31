import asyncio
import os
import uuid
import zipfile

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from parser_core import Job, run_parser_job, dedupe_franchises, render_live_page

DATA_DIR = os.environ.get("PARSER_DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
NOVNC_URL = os.environ.get("NOVNC_URL", "https://vnc.alba-creation.ru")
HUB_CALLBACK_URL = os.environ.get("HUB_CALLBACK_URL", "")  # e.g. http://10.0.1.1:3001/api/parser-niches
WORKER_TOKEN = os.environ.get("PARSER_WORKER_TOKEN", "")

app = FastAPI(title="alba-parser-worker")


@app.middleware("http")
async def require_worker_token(request, call_next):
    # Defense in depth on top of the ufw rule scoping this port to the
    # Coolify docker subnet - every request (except /health) must carry the
    # shared token the Node backend sends.
    if WORKER_TOKEN and request.url.path != "/health":
        if request.headers.get("x-worker-token") != WORKER_TOKEN:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "bad worker token"}, status_code=401)
    return await call_next(request)


jobs: dict[str, Job] = {}
queue: asyncio.Queue = asyncio.Queue()


class QueryItem(BaseModel):
    query: str
    keywords: list[str] = []


class CityConfig(BaseModel):
    slug: str
    label: str = ""
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


class CreateJobRequest(BaseModel):
    niche_id: str
    category: str
    description: str = ""
    queries: list[QueryItem]
    # Resolved server-side by the hub (local-claude-agent + WebSearch, cached
    # in its own DB) - this worker no longer has its own city list, only the
    # Moscow fallback for when the caller omits this entirely.
    city: CityConfig | None = None


class RenderRequest(BaseModel):
    url: str
    timeout_ms: int = 25000


async def notify_captcha(job: Job):
    if not HUB_CALLBACK_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{HUB_CALLBACK_URL}/{job.id}/captcha-alert",
                json={"novncUrl": NOVNC_URL, "category": job.category},
                headers={"X-Worker-Token": WORKER_TOKEN} if WORKER_TOKEN else {},
            )
    except Exception as e:
        job.log(f"Не удалось уведомить hub о капче: {e}")


async def worker_loop():
    while True:
        job: Job = await queue.get()
        if job.cancelled:
            # Cancelled while still sitting in the queue, before any task
            # existed to call .cancel() on - honor it now instead of running
            # a scrape the operator already tried to stop.
            queue.task_done()
            continue
        try:
            job.on_captcha = notify_captcha
            job.task = asyncio.current_task()
            await run_parser_job(job)
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.log("⏹ Остановлено пользователем")
        except Exception as e:
            job.status = "error"
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
    job_id = str(uuid.uuid4())[:8]
    out_dir = os.path.join(DATA_DIR, job_id)
    city = body.city.model_dump() if body.city else None
    job = Job(job_id, body.category, body.description, [q.model_dump() for q in body.queries], out_dir, city=city)
    jobs[job_id] = job
    await queue.put(job)
    job.log(f"Job поставлен в очередь (позиция: {queue.qsize()})")
    return {"job_id": job_id, "status": job.status, "city": job.city}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "city": job.city,
        "log": "\n".join(job.log_lines[-200:]),
        "stats": job.stats,
        "files": {
            "raw": os.path.exists(job.raw_path),
            "dedup": os.path.exists(job.dedup_path),
            "archive": os.path.exists(job.archive_path),
        },
    }


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.task and not job.task.done():
        job.task.cancel()
        return {"ok": True, "cancelled": True}
    if job.status == "queued":
        # Not dequeued yet, so there's no task to cancel - worker_loop checks
        # this flag right after pulling it off the queue and skips running it.
        job.cancelled = True
        job.status = "cancelled"
        job.log("⏹ Остановлено пользователем (было в очереди)")
        return {"ok": True, "cancelled": True}
    return {"ok": True, "cancelled": False}


ACTIVE_STATUSES = {"queued", "running", "captcha"}


@app.post("/jobs/{job_id}/dedupe")
async def dedupe_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.status in ACTIVE_STATUSES:
        raise HTTPException(409, "scrape still running - wait for it to finish first")
    if not os.path.exists(job.raw_path):
        raise HTTPException(400, "raw file not ready yet")
    try:
        # openpyxl is synchronous; running it inline would block this whole
        # event loop (including any other job's page.goto/timeouts) for
        # however long the workbook takes to load and rewrite.
        stats = await asyncio.to_thread(dedupe_franchises, job.raw_path, job.dedup_path)
        job.log(f"Дубликаты/франшизы удалены: {stats['deleted_rows']} строк, {stats['franchise_domains']} сетей")
        return {"ok": True, **stats}
    except Exception as e:
        raise HTTPException(500, str(e))


def _write_archive(archive_path, files):
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, arcname=os.path.basename(f))


@app.post("/jobs/{job_id}/archive")
async def archive_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.status in ACTIVE_STATUSES:
        raise HTTPException(409, "scrape still running - wait for it to finish first")
    files = [p for p in [job.raw_path, job.dedup_path] if os.path.exists(p)]
    if not files:
        raise HTTPException(400, "nothing to archive yet")
    await asyncio.to_thread(_write_archive, job.archive_path, files)
    return {"ok": True}


@app.get("/jobs/{job_id}/files/{kind}")
async def get_file(job_id: str, kind: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    path = {"raw": job.raw_path, "dedup": job.dedup_path, "archive": job.archive_path}.get(kind)
    if not path or not os.path.exists(path):
        raise HTTPException(404, "file not ready")
    filename = f"{job.category}-{kind}.{'zip' if kind == 'archive' else 'xlsx'}"
    return FileResponse(path, filename=filename)


@app.post("/render")
async def render_page(body: RenderRequest):
    """Used by the hub's url-checker 'live' scan mode. Unlike /jobs, this is
    a synchronous one-off - not queued through the niche-scraping pipeline -
    since it's a single ad-hoc navigation, not a long grid scrape. Runs the
    same headed Chromium under Xvfb as the 2GIS scraper (see parser_core.py's
    run_parser_job), the only browser this repo runs."""
    timeout_ms = max(5000, min(body.timeout_ms, 60000))
    try:
        result = await asyncio.wait_for(render_live_page(body.url, timeout_ms), timeout=(timeout_ms / 1000) + 20)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(504, "render timed out")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/health")
async def health():
    return {"ok": True, "queue_size": queue.qsize(), "jobs": len(jobs)}
