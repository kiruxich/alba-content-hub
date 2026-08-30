// Thin client for the Python video-worker service (Phase 2 Shorts pipeline) -
// same Docker-sibling setup as parser-worker (see server/lib/parserWorkerClient.js's
// header comment): reached from inside the hub's container via the Docker
// bridge gateway IP, on its own port so it doesn't collide with parser-worker's 8787.
const WORKER_URL = process.env.VIDEO_WORKER_URL || 'http://10.0.1.1:8788';
const WORKER_TOKEN = process.env.VIDEO_WORKER_TOKEN || '';

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
        throw new Error(`video-worker ${path}: ${detail}`);
    }
    return res;
}

export async function createVideoJob({ videoUrl, audioUrl, captionText, outputFormat }) {
    const res = await workerFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({
            video_url: videoUrl,
            audio_url: audioUrl,
            caption_text: captionText || '',
            output_format: outputFormat || 'mp4',
        }),
    });
    return res.json();
}

export async function getVideoJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}`);
    return res.json();
}

export async function cancelVideoJob(jobId) {
    const res = await workerFetch(`/jobs/${jobId}/cancel`, { method: 'POST' });
    return res.json();
}

export async function fetchVideoFile(jobId) {
    return workerFetch(`/jobs/${jobId}/file`);
}
