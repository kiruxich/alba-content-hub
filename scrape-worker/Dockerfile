FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Chromium + нативные библиотеки к нему. В отличие от parser-worker здесь
# headless и без Xvfb/noVNC: обычные корпоративные сайты не закрыты
# анти-ботом так, как 2ГИС, и человек к капче не подключается.
RUN playwright install --with-deps chromium

COPY . .

ENV SCRAPE_DATA_DIR=/app/data

EXPOSE 8788

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8788"]
