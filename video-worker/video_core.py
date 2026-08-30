import asyncio
import os
import time

import httpx

# ffmpeg outputs a 1080x1920 (portrait, Shorts/Reels-friendly) H.264/AAC mp4.
# A non-9:16 input video is letterboxed (scaled to fit, padded with black
# bars) rather than cropped or rejected, so odd aspect-ratio source clips
# still produce a usable Short instead of failing the job.
OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920

DOWNLOAD_CHUNK_SIZE = 1024 * 256
DOWNLOAD_TIMEOUT = httpx.Timeout(120.0, connect=15.0)

# Only used when caption_text is supplied. Installed via fonts-dejavu-core in
# the Dockerfile; overridable in case a deployment wants a different face.
FONT_FILE = os.environ.get("VIDEO_WORKER_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")


class Job:
    """In-memory state for one assembly run - mirrors parser-worker's Job
    (parser-worker/parser_core.py): same queued/task/cancelled bookkeeping so
    main.py's worker_loop and cancel endpoint can reuse that exact pattern,
    just driving an ffmpeg mux instead of a Playwright scrape."""

    def __init__(self, job_id, video_url, audio_url, caption_text, output_format, out_dir):
        self.id = job_id
        self.video_url = video_url
        self.audio_url = audio_url
        self.caption_text = caption_text or ""
        self.output_format = (output_format or "mp4").lstrip(".")
        self.out_dir = out_dir
        self.status = "queued"  # queued|running|done|error|cancelled
        self.log_lines = []
        self.error = None
        self.output_path = os.path.join(out_dir, f"output.{self.output_format}")
        self.task = None  # asyncio.Task running this job, set by worker_loop - used to cancel
        self.proc = None  # asyncio subprocess for the running ffmpeg, so cancel can kill it too
        self.cancelled = False  # set when cancelled while still queued (before a task exists)

    def log(self, msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        self.log_lines.append(line)
        print(f"[{self.id}] {line}", flush=True)


def escape_drawtext(text: str) -> str:
    """Escapes text for use inside an ffmpeg drawtext filter argument, per
    https://ffmpeg.org/ffmpeg-filters.html#drawtext - backslash first, then
    the filtergraph-special characters (: and %). Straight single quotes
    aren't escaped for drawtext (the escaping rules for the outer filter
    quoting are awkward) - they're swapped for a typographic apostrophe
    instead, which is safe and looks fine for a burned-in caption."""
    text = text.replace("\\", "\\\\")
    text = text.replace(":", "\\:")
    text = text.replace("'", "’")
    text = text.replace("%", "\\%")
    return text


def build_ffmpeg_args(video_path: str, audio_path: str, output_path: str, caption_text: str = "") -> list[str]:
    """Builds the ffmpeg argv. Passed straight to asyncio.create_subprocess_exec
    (no shell), so there's no shell-quoting concern beyond ffmpeg's own
    filtergraph escaping handled by escape_drawtext.

    Audio handling: REPLACES the video's original audio track with audio_path
    (the generated voice-over) rather than mixing/ducking the two under it.
    This is a deliberate v1 choice for a narrated-Shorts pipeline. Overlaying
    the original clip audio under the voice-over is NOT implemented.

    -shortest trims output to the shorter of the two input streams (no
    looping the video to match a longer voice-over, no freezing on the last
    frame) - simplest predictable v1 behavior.

    Caption handling: if caption_text is set, burns it in via drawtext as a
    single centered line near the bottom of the frame, no automatic line
    wrapping/multi-line layout, no timing/karaoke. It depends on FONT_FILE
    existing in the container. A caption wider than the frame will overflow
    rather than wrap - acceptable for a v1 nice-to-have, not production
    caption rendering.
    """
    vf_parts = [
        f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease",
        f"pad={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black",
        "setsar=1",
    ]
    if caption_text:
        escaped = escape_drawtext(caption_text)
        vf_parts.append(
            f"drawtext=fontfile={FONT_FILE}:text='{escaped}':fontcolor=white:fontsize=54:"
            "box=1:boxcolor=black@0.5:boxborderw=20:x=(w-text_w)/2:y=h-th-140"
        )
    vf = ",".join(vf_parts)

    return [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-vf", vf,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]


async def _download(client: httpx.AsyncClient, url: str, dest_path: str, job: Job):
    async with client.stream("GET", url) as resp:
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            async for chunk in resp.aiter_bytes(DOWNLOAD_CHUNK_SIZE):
                f.write(chunk)
    job.log(f"Скачано: {url} -> {os.path.basename(dest_path)}")


async def run_assembly_job(job: Job):
    """Downloads job.video_url/job.audio_url, runs ffmpeg (via
    asyncio.create_subprocess_exec, so it never blocks the event loop) to mux
    them into a vertical Short at job.output_path. Mutates job.status/log as
    it goes. Raises asyncio.CancelledError (after killing any in-flight
    ffmpeg child) if job.task.cancel() is called mid-run - same contract as
    parser-worker's run_parser_job."""
    os.makedirs(job.out_dir, exist_ok=True)
    job.status = "running"
    job.log("Старт сборки видео")

    video_path = os.path.join(job.out_dir, "input_video")
    audio_path = os.path.join(job.out_dir, "input_audio")

    try:
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            await _download(client, job.video_url, video_path, job)
            await _download(client, job.audio_url, audio_path, job)

        args = build_ffmpeg_args(video_path, audio_path, job.output_path, job.caption_text)
        job.log(f"Запуск ffmpeg: {' '.join(args)}")

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        job.proc = proc
        try:
            stdout, _ = await proc.communicate()
        except asyncio.CancelledError:
            # The asyncio.Task got cancelled (job.task.cancel() from the
            # /cancel endpoint) while ffmpeg was still running - kill the
            # child too, otherwise it'd keep encoding orphaned in the
            # background after the job is reported as cancelled.
            proc.kill()
            await proc.wait()
            raise

        if stdout:
            tail = stdout.decode(errors="replace").strip().splitlines()[-40:]
            for line in tail:
                job.log(f"ffmpeg: {line}")

        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg exited with code {proc.returncode}")

        job.status = "done"
        job.log("🏁 Сборка завершена")
    finally:
        job.proc = None
        for p in (video_path, audio_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
