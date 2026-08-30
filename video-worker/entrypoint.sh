#!/bin/bash
set -e

# Simpler than parser-worker/entrypoint.sh - no Xvfb/x11vnc/websockify to
# start first, just the FastAPI app itself.
exec uvicorn main:app --host 0.0.0.0 --port 8788
