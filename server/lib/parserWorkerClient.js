// Thin client for the Python parser-worker service (runs directly on the VPS
// host, not in Docker, so it can drive headed Chromium inside Xvfb). Reached
// from inside the hub's container via the Docker bridge gateway IP.
const WORKER_URL = process.env.PARSER_WORKER_URL || 'http://10.0.1.1:8787';
const WORKER_TOKEN = process.env.PARSER_WORKER_TOKEN || '';

async function workerFetch(path, options = {}) {
    const res = await fetch(`${WORKER_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(WORKER_TOKEN ? { 'X-Worker-Token': WORKER_TOKEN } : {}),
            ...(options.headers || {}),
        },
    });
    if (!res.ok) {
        let detail = res.statusText;
        try { detail = (await res.json()).detail || detail; } catch (_) {}
        throw new Error(`parser-worker ${path}: ${detail}`);
    }
    return res;
}

// `city` is a resolved {slug, label, latMin, latMax, lonMin, lonMax} object
// (see server/lib/resolveParserCity.js) - the worker itself has no city
// list anymore, just the fields below in snake_case (its own convention).
export async function createParserJob({ nicheId, category, description, queries, city }) {
    const cityPayload = city ? {
        slug: city.slug, label: city.label,
        lat_min: city.latMin, lat_max: city.latMax,
        lon_min: city.lonMin, lon_max: city.lonMax,
    } : undefined;
    const res = await workerFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({ niche_id: nicheId, category, description, queries, city: cityPayload }),
    });
    return res.json();
}

export async function getParserJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}`);
    return res.json();
}

export async function cancelParserJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/cancel`, { method: 'POST' });
    return res.json();
}

export async function dedupeParserJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/dedupe`, { method: 'POST' });
    return res.json();
}

export async function archiveParserJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/archive`, { method: 'POST' });
    return res.json();
}

export async function fetchParserFile(jobId, kind) {
    return workerFetch(`/jobs/${jobId}/files/${kind}`);
}

// Used by the url-checker's "live" scan mode: asks parser-worker to open an
// arbitrary URL in its existing headed Chromium (the hub's own Node process
// has no browser and isn't meant to run one - that's parser-worker's job),
// wait for the page to settle, best-effort decline a cookie-consent banner,
// and hand back the fully hydrated post-JS HTML.
export async function renderLivePage(url, { timeoutMs } = {}) {
    const effectiveTimeoutMs = timeoutMs || 25000;
    // Client-side abort a bit past the server-side timeout so a wedged
    // browser on the worker side can't hang this request forever.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), effectiveTimeoutMs + 20000);
    try {
        const res = await workerFetch('/render', {
            method: 'POST',
            body: JSON.stringify({ url, timeout_ms: effectiveTimeoutMs }),
            signal: controller.signal,
        });
        return res.json();
    } finally {
        clearTimeout(abortTimer);
    }
}
