// Deliberately a *light* load test, not a stress-testing tool: capped
// concurrency and duration regardless of what's requested, since this runs
// against real (client) production sites and the point is a quick health
// snapshot, not maximum throughput. Only ever run this against sites you're
// authorized to test.
const MAX_CONCURRENCY = 20;
const MAX_DURATION_MS = 15000;

export async function runLoadTest(url, { concurrency = 10, durationMs = 5000 } = {}) {
    const effectiveConcurrency = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
    const effectiveDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));

    const results = [];
    const endAt = Date.now() + effectiveDuration;

    async function worker() {
        while (Date.now() < endAt) {
            const start = Date.now();
            try {
                const response = await fetch(url, { method: 'GET' });
                await response.arrayBuffer(); // consume the body so timing reflects full transfer
                results.push({ ok: response.ok, status: response.status, ms: Date.now() - start });
            } catch (e) {
                results.push({ ok: false, status: 0, ms: Date.now() - start, error: e.message });
            }
        }
    }

    await Promise.all(Array.from({ length: effectiveConcurrency }, worker));

    const times = results.map(r => r.ms).sort((a, b) => a - b);
    const errors = results.filter(r => !r.ok).length;
    const percentile = (p) => {
        if (times.length === 0) return 0;
        return times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
    };
    const statusCounts = {};
    for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

    return {
        concurrency: effectiveConcurrency,
        durationMs: effectiveDuration,
        totalRequests: results.length,
        errors,
        errorRate: results.length ? errors / results.length : 0,
        requestsPerSecond: results.length ? Math.round((results.length / effectiveDuration) * 1000 * 10) / 10 : 0,
        avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        minMs: times[0] || 0,
        maxMs: times[times.length - 1] || 0,
        p50Ms: percentile(50),
        p95Ms: percentile(95),
        statusCounts,
    };
}
