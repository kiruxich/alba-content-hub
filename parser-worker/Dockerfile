FROM python:3.11-slim

# Xvfb (virtual display so headed Chromium looks like a real browser to
# 2GIS's anti-bot checks - headless mode gets detected and blocked) plus
# x11vnc/noVNC (so a human can solve a CAPTCHA remotely by watching the same
# virtual display over the browser) are bundled into the same image as the
# FastAPI job-queue app, the same pattern Selenium's own Docker images use.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Installs Chromium plus every native lib it needs (apt, via --with-deps) -
# this is why python:slim (not alpine) and a real apt-get are required here.
RUN playwright install --with-deps chromium

COPY . .

ENV DISPLAY=:99
ENV PARSER_DATA_DIR=/app/data

RUN chmod +x /app/entrypoint.sh

EXPOSE 8787 6080

ENTRYPOINT ["/app/entrypoint.sh"]
