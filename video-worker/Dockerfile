FROM python:3.11-slim

# No headed browser here (unlike parser-worker's Xvfb/x11vnc/novnc stack) -
# just the ffmpeg binary this service shells out to, plus a font so burned-in
# captions (video_core.py's optional drawtext step) have something to render
# with.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV VIDEO_WORKER_DATA_DIR=/app/data

RUN chmod +x /app/entrypoint.sh

EXPOSE 8788

ENTRYPOINT ["/app/entrypoint.sh"]
