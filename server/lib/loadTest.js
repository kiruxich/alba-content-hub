// Deliberately a *light* load test, not a stress-testing tool: capped
// concurrency and duration regardless of what's requested, since this runs
// against real (client) production sites and the point is a quick health
// snapshot, not maximum throughput. Only ever run this against sites you're
// authorized to test.
const MAX_CONCURRENCY = 20;
const MAX_DURATION_MS = 15000;

// Request-count mode still caps out at MAX_DURATION_MS - a user asking for a
// huge requestCount must never hang longer than the existing worst case, the
// duration cap is the safety net regardless of which mode is used.
const MAX_REQUEST_COUNT = 5000;

export async function runLoadTest(url, { concurrency = 10, durationMs = 5000, requestCount } = {}) {
    const effectiveConcurrency = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
    const useRequestCount = requestCount != null && Number.isFinite(Number(requestCount)) && Number(requestCount) > 0;
    const effectiveRequestCount = useRequestCount
        ? Math.max(1, Math.min(Math.floor(Number(requestCount)), MAX_REQUEST_COUNT))
        : null;

    // In request-count mode the safety net is always the hard MAX_DURATION_MS
    // cap (not the user-suppliable durationMs). In duration mode, behavior is
    // unchanged from before requestCount existed.
    const effectiveDuration = useRequestCount
        ? MAX_DURATION_MS
        : Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));

    const results = [];
    const loopStart = Date.now();
    const endAt = loopStart + effectiveDuration;

    async function worker() {
        while (Date.now() < endAt) {
            if (useRequestCount && results.length >= effectiveRequestCount) break;
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

    // Duration mode keeps reporting the clamped requested duration exactly as
    // before (backwards compatible). Count mode reports how long it actually
    // took to gather the requested requests, which is far more meaningful
    // than the MAX_DURATION_MS safety cap it ran under.
    const reportedDurationMs = useRequestCount ? (Date.now() - loopStart) : effectiveDuration;

    return {
        concurrency: effectiveConcurrency,
        durationMs: reportedDurationMs,
        requestCount: effectiveRequestCount,
        hitDurationCap: useRequestCount && results.length < effectiveRequestCount,
        totalRequests: results.length,
        errors,
        errorRate: results.length ? errors / results.length : 0,
        requestsPerSecond: results.length ? Math.round((results.length / reportedDurationMs) * 1000 * 10) / 10 : 0,
        avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        minMs: times[0] || 0,
        maxMs: times[times.length - 1] || 0,
        p50Ms: percentile(50),
        p95Ms: percentile(95),
        statusCounts,
    };
}
