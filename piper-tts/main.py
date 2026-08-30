"""Piper TTS microservice - free, self-hosted, offline neural text-to-speech.

Sibling service to parser-worker/video-worker (same repo, own Coolify
deployment). Unlike those, synthesis is CPU-fast (real-time on a single
core for short text), so this is a plain synchronous request/response API -
no job queue needed.

Auth: same shared-secret-header pattern as parser-worker/video-worker
(require_worker_token), checked on every route except /health.
"""
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

WORKER_TOKEN = os.environ.get("PIPER_WORKER_TOKEN", "")
VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR", "/app/voices"))
DEFAULT_VOICE = "ru_RU-dmitri-medium"

app = FastAPI()


@app.middleware("http")
async def require_worker_token(request: Request, call_next):
    if request.url.path != "/health":
        if not WORKER_TOKEN or request.headers.get("X-Worker-Token") != WORKER_TOKEN:
            return Response(status_code=401, content="unauthorized")
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "voices": [p.stem for p in VOICES_DIR.glob("*.onnx")]}


@app.post("/synthesize")
async def synthesize(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    voice = (body.get("voice") or DEFAULT_VOICE).strip()

    if not text:
        raise HTTPException(400, "text is required")

    model_path = VOICES_DIR / f"{voice}.onnx"
    config_path = VOICES_DIR / f"{voice}.onnx.json"
    if not model_path.exists() or not config_path.exists():
        available = [p.stem for p in VOICES_DIR.glob("*.onnx")]
        raise HTTPException(400, f"unknown voice '{voice}', available: {available}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        # piper is CPU-bound and synchronous - runs in a worker thread via
        # subprocess.run's own blocking call, but FastAPI's threadpool
        # handles that fine for this service's traffic pattern (short text,
        # sub-second synthesis, no long-running jobs to coordinate).
        result = subprocess.run(
            ["piper", "-m", str(model_path), "-c", str(config_path), "-f", out_path],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise HTTPException(502, f"piper synthesis failed: {result.stderr.decode('utf-8', 'replace')[:500]}")

        audio_bytes = Path(out_path).read_bytes()
        if not audio_bytes:
            raise HTTPException(502, "piper produced no audio output")
        return Response(content=audio_bytes, media_type="audio/wav")
    finally:
        Path(out_path).unlink(missing_ok=True)
