// Тонкий клиент к Python-сервису scrape-worker (ScrapeGraphAI на локальной
// Ollama) - второй источник базы заказчиков рядом с 2ГИС-парсером.
// По форме повторяет parserWorkerClient.js: тот же общий токен в заголовке,
// та же очередь job'ов и поллинг статуса. Отличие одно: статус здесь несёт с
// собой сами строки (rows), а не только флаг «файл готов» - сводная база на
// стороне хаба собирается из данных, а не из распарсенного XLSX.
const WORKER_URL = process.env.SCRAPE_WORKER_URL || '';
const WORKER_TOKEN = process.env.SCRAPE_WORKER_TOKEN || '';

export function isScrapeWorkerConfigured() {
    return Boolean(WORKER_URL);
}

async function workerFetch(path, options = {}) {
    if (!isScrapeWorkerConfigured()) {
        throw new Error('SCRAPE_WORKER_URL не настроен — поднимите scrape-worker (см. scrape-worker/docker-compose.yml)');
    }
    let res;
    try {
        res = await fetch(`${WORKER_URL.replace(/\/$/, '')}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(WORKER_TOKEN ? { 'X-Worker-Token': WORKER_TOKEN } : {}),
                ...(options.headers || {}),
            },
        });
    } catch (e) {
        // Воркер и Ollama живут отдельным compose-стеком, который вполне
        // может быть просто выключен - это нормальная ошибка для пользователя,
        // а не падение хаба.
        throw new Error('Не удалось достучаться до scrape-worker — проверьте, что контейнер запущен');
    }
    if (!res.ok) {
        let detail = res.statusText;
        try { detail = (await res.json()).detail || detail; } catch (_) {}
        throw new Error(`scrape-worker ${path}: ${detail}`);
    }
    return res;
}

export async function createScrapeJob({ nicheId, category, city, sites, maxSites }) {
    const res = await workerFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({
            niche_id: nicheId, category, city: city || '',
            sites: sites || [], max_sites: maxSites || 30,
        }),
    });
    return res.json();
}

export async function getScrapeJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}`);
    return res.json();
}

export async function cancelScrapeJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/cancel`, { method: 'POST' });
    return res.json();
}

export async function fetchScrapeFile(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/file`);
    return Buffer.from(await res.arrayBuffer());
}

export async function scrapeWorkerHealth() {
    const res = await workerFetch('/health');
    return res.json();
}
