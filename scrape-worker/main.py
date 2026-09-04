"""HTTP-обёртка ScrapeGraphAI-воркера.

Повторяет контракт parser-worker/main.py (очередь job'ов, общий токен в
X-Worker-Token, поллинг статуса, отдача файла), чтобы на стороне хаба клиент
был таким же по форме - см. server/lib/scrapeWorkerClient.js.
"""
import asyncio
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from scrape_core import Job, run_scrape_job

DATA_DIR = os.environ.get("SCRAPE_DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
WORKER_TOKEN = os.environ.get("SCRAPE_WORKER_TOKEN", "")

app = FastAPI(title="alba-scrape-worker")


@app.middleware("http")
async def require_worker_token(request, call_next):
    if WORKER_TOKEN and request.url.path != "/health":
        if request.headers.get("x-worker-token") != WORKER_TOKEN:
            return JSONResponse({"detail": "bad worker token"}, status_code=401)
    return await call_next(request)


jobs: dict[str, Job] = {}
queue: asyncio.Queue = asyncio.Queue()


class CreateJobRequest(BaseModel):
    niche_id: str
    category: str
    city: str = ""
    # Список сайтов подбирает хаб (local-claude-agent + WebSearch), а не этот
    # воркер: у агента уже есть поиск, и держать здесь второй поисковый
    # бэкенд с собственными ключами/лимитами незачем.
    sites: list[str] = []
    max_sites: int = 30


async def worker_loop():
    while True:
        job: Job = await queue.get()
        if job.cancelled:
            queue.task_done()
            continue
        try:
            job.task = asyncio.current_task()
            await run_scrape_job(job)
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


@app.get("/health")
async def health():
    return {"ok": True, "model": os.environ.get("SCRAPE_MODEL", "qwen2.5:7b")}


@app.post("/jobs")
async def create_job(body: CreateJobRequest):
    job_id = str(uuid.uuid4())[:8]
    job = Job(
        job_id, body.category, body.city, body.sites,
        os.path.join(DATA_DIR, job_id), max_sites=body.max_sites,
    )
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
        "log": "\n".join(job.log_lines[-200:]),
        "stats": job.stats,
        # Строки отдаём прямо в статусе - их десятки, не тысячи, и хабу они
        # нужны как данные (для сводной базы), а не только как файл.
        "rows": job.rows,
        "files": {"raw": os.path.exists(job.raw_path)},
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
        job.cancelled = True
        job.status = "cancelled"
        job.log("⏹ Остановлено пользователем (было в очереди)")
        return {"ok": True, "cancelled": True}
    return {"ok": True, "cancelled": False}


@app.get("/jobs/{job_id}/file")
async def get_file(job_id: str):
    job = jobs.get(job_id)
    if not job or not os.path.exists(job.raw_path):
        raise HTTPException(404, "file not found")
    return FileResponse(job.raw_path, filename=f"{job.category or 'scrape'}.xlsx")
