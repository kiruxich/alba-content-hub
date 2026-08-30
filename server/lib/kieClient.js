// Thin server-to-server client for kie.ai (https://kie.ai) - a credit-based
// aggregator API that fronts multiple gen-AI models behind one unified async
// "jobs" API. Used here for:
//   - Flux (flux-2/pro-text-to-image) for AI-generated post covers
//   - Kling (kling-2.6/text-to-video) for AI-generated short video covers
//
// Same style as translateToEnglish.js / telegramApproval.js: no SDK, plain
// fetch, no secrets logged, callers get a clear Error on failure instead of
// a thrown fetch exception with a cryptic message.
//
// API shape (per https://docs.kie.ai/ as of writing - the "unified jobs"
// endpoints, not the older per-model REST paths):
//   POST {base}/api/v1/jobs/createTask   { model, input, callBackUrl? }
//     -> { code, msg, data: { taskId } }
//   GET  {base}/api/v1/jobs/recordInfo?taskId=...
//     -> { code, msg, data: { state, resultJson, failMsg, failCode, creditsConsumed, ... } }
//   state is one of: waiting | queuing | generating | success | fail
//   resultJson is a JSON-encoded string containing { resultUrls: [...] }
//
// We don't use callBackUrl (no public callback endpoint set up for this
// deployment) - we poll recordInfo instead, which kie.ai explicitly supports
// as a fallback to webhooks.

const KIE_BASE_URL = process.env.KIE_BASE_URL || 'https://api.kie.ai';
const KIE_API_KEY = process.env.KIE_API_KEY || '';

export function isKieConfigured() {
    return Boolean(KIE_API_KEY);
}

function authHeaders(extra = {}) {
    return {
        Authorization: `Bearer ${KIE_API_KEY}`,
        ...extra,
    };
}

async function createTask(model, input) {
    const res = await fetch(`${KIE_BASE_URL}/api/v1/jobs/createTask`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model, input }),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* leave data = {} */ }

    if (!res.ok || !data?.data?.taskId) {
        throw new Error(`kie.ai createTask (${model}) failed: ${data.msg || res.statusText || res.status}`);
    }
    return data.data.taskId;
}

// Polls GET /jobs/recordInfo until the task reaches a terminal state
// (success/fail) or the timeout elapses. Returns { url, creditsConsumed }.
async function pollTask(taskId, { timeoutMs = 180000, intervalMs = 4000 } = {}) {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const res = await fetch(
            `${KIE_BASE_URL}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
            { headers: authHeaders() },
        );
        let data = {};
        try { data = await res.json(); } catch (_) { /* leave data = {} */ }

        if (!res.ok) {
            throw new Error(`kie.ai recordInfo failed: ${data.msg || res.statusText || res.status}`);
        }

        const state = data?.data?.state;
        if (state === 'success') {
            let resultUrls = [];
            try { resultUrls = JSON.parse(data.data.resultJson || '{}').resultUrls || []; } catch (_) { /* ignore */ }
            const url = resultUrls[0];
            if (!url) throw new Error('kie.ai task succeeded but returned no result URL');
            return { url, creditsConsumed: Number(data.data.creditsConsumed || 0) };
        }
        if (state === 'fail') {
            throw new Error(`kie.ai generation failed: ${data.data.failMsg || data.data.failCode || 'unknown error'}`);
        }
        // waiting / queuing / generating (or an unrecognized value) - keep polling.

        if (Date.now() >= deadline) {
            throw new Error('kie.ai task timed out waiting for completion');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

// Text-to-image via Flux. Throws if KIE_API_KEY is unset - callers should
// check isKieConfigured() first to return a clean 503 instead of surfacing
// this as a generic failure.
export async function generateImage(prompt, { aspectRatio = '1:1', resolution = '1K' } = {}) {
    if (!isKieConfigured()) throw new Error('kie.ai is not configured (KIE_API_KEY unset)');
    const taskId = await createTask('flux-2/pro-text-to-image', {
        prompt,
        aspect_ratio: aspectRatio,
        resolution,
    });
    return pollTask(taskId, { timeoutMs: 180000, intervalMs: 4000 });
}

// Text-to-video via Kling. Video generation runs noticeably longer than
// image generation, hence the longer timeout/interval.
export async function generateVideo(prompt, { aspectRatio = '16:9', duration = '5', sound = false } = {}) {
    if (!isKieConfigured()) throw new Error('kie.ai is not configured (KIE_API_KEY unset)');
    const taskId = await createTask('kling-2.6/text-to-video', {
        prompt,
        aspect_ratio: aspectRatio,
        duration: String(duration),
        sound,
    });
    return pollTask(taskId, { timeoutMs: 420000, intervalMs: 6000 });
}
