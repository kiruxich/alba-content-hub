# scrape-worker

Вторая база заказчиков: обход сайтов компаний моделью (ScrapeGraphAI) на
локальной Ollama. Дополняет `parser-worker/` (2ГИС), а не заменяет его.

## Зачем отдельно от 2ГИС

| | 2ГИС-парсер | scrape-worker |
|---|---|---|
| Источник | один каталог, известная вёрстка | произвольные сайты компаний |
| Даёт | название, адрес, телефон | + email, telegram, vk, чем компания живёт |
| Не находит | тех, кого нет в 2ГИС | тех, у кого нет сайта |
| Разбор | фиксированные селекторы | LLM по тексту страницы |

Обе базы сливаются в сводную на стороне хаба — см. `mergeRows()` в
`server/routes/scrapeNiches.js` (склейка по последним 10 цифрам телефона,
домену и названию+городу).

## Как работает один запуск

1. Хаб просит `local-claude-agent` (задача `find-client-sites`, WebSearch)
   подобрать сайты компаний по нише и городу. Агент возвращает **только
   URL** — контакты с них снимаются с живой страницы, потому что выдуманный
   моделью телефон проверить нечем.
2. Воркер открывает каждый сайт Playwright'ом, дочитывает страницу контактов,
   если нашёл на неё ссылку, и отдаёт текст в `SmartScraperGraph`.
3. Модель возвращает JSON с контактами. Телефоны и email дополнительно
   ловятся регулярками — если модель их проглядела, лид не теряется.
4. Строки уходят в хаб в теле статуса job'а и складываются в
   `scrape_niches.results_json`, плюс доступны XLSX-выгрузкой.

## Запуск (локально/на своём сервере через docker compose)

```bash
cd scrape-worker
export SCRAPE_WORKER_TOKEN=$(openssl rand -hex 24)
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5:7b
docker compose exec ollama ollama pull nomic-embed-text
```

## Запуск через Coolify

Это compose из двух сервисов (ollama + сам воркер) — **Build pack: Docker
Compose**, не Dockerfile (тот поднимет только один контейнер без ollama
вообще, и SmartScraperGraph будет не с кем говорить). Файл называется
`docker-compose.yaml`, не `.yml` — Coolify по умолчанию ищет именно `.yaml`
и не находит `.yml` сам, без ручного указания пути.

1. New Resource → Git Repository → этот репозиторий.
2. Base directory: `/scrape-worker`.
3. Build pack: **Docker Compose** (не Dockerfile).
4. Environment variable: `SCRAPE_WORKER_TOKEN` = `openssl rand -hex 24`.
5. После первого деплоя — `ollama pull` (см. выше) нужно выполнить внутри
   контейнера `ollama` этого стека: `docker compose exec ollama ollama pull
   qwen2.5:7b` и `... nomic-embed-text` (SSH на сервер, найти папку деплоя
   этого Coolify-ресурса, там и лежит тот же `docker-compose.yaml`).
6. Открыть порт 8790 из docker-подсети Coolify (см.
   `infra/ansible/tasks/setup_selfhosted_ufw.yml`), как у остальных
   self-hosted сервисов — иначе хаб до воркера не достучится.

Без `ollama pull` первый job упадёт с `model not found` — это не баг воркера,
модель качается один раз в volume `ollama-models`.

Затем в `.env` хаба:

```
SCRAPE_WORKER_URL=http://<хост>:8790
SCRAPE_WORKER_TOKEN=<тот же токен>
```

Порт хоста — 8790, не 8788: тот уже занят video-worker, если оба воркера
живут на одном сервере (см. docker-compose.yaml).

Проверить связку можно прямо из интерфейса: «Заказчики» → ScrapeGraph, вверху
панели видно, на связи ли воркер и какая модель поднята.

## Переменные окружения

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | адрес Ollama |
| `SCRAPE_MODEL` | `qwen2.5:7b` | модель для разбора страниц |
| `SCRAPE_EMBED_MODEL` | `nomic-embed-text` | эмбеддинги для чанкинга длинных страниц |
| `SCRAPE_WORKER_TOKEN` | — | общий секрет с хабом (`X-Worker-Token`) |
| `SCRAPE_PAGE_TIMEOUT_MS` | `25000` | таймаут загрузки одной страницы |
| `SCRAPE_MAX_PAGE_CHARS` | `12000` | сколько текста страницы уходит в модель |

## Чего здесь нет

Xvfb, noVNC и ручного решения капчи — в отличие от `parser-worker`. Обычные
корпоративные сайты не закрыты анти-ботом так, как 2ГИС; сайт, который не
отдался с первого раза, просто пропускается и попадает в `failed` в
статистике job'а.
