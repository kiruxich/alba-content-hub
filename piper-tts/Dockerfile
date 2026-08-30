FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the voice model into the image at build time (no runtime download,
# no risk of the model being unavailable when a container starts).
ENV PIPER_VOICES_DIR=/app/voices
RUN mkdir -p /app/voices \
    && python -m piper.download_voices ru_RU-dmitri-medium --data-dir /app/voices

COPY main.py .

EXPOSE 8789
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8789"]
