#!/bin/bash
set -e

Xvfb :99 -screen 0 1280x800x24 -ac &
sleep 1

# -localhost: only websockify (in this same container) can reach the raw VNC
# port - nothing outside the container ever sees 5900, only the noVNC web
# port (6080) gets published.
x11vnc -display :99 -forever -shared -rfbport 5900 -localhost -nopw -quiet &

websockify --web=/usr/share/novnc 6080 localhost:5900 &

exec uvicorn main:app --host 0.0.0.0 --port 8787
