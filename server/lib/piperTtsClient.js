// Client for the self-hosted piper-tts Coolify service (piper-tts/) - free,
// offline neural TTS. Mirrors server/lib/parserWorkerClient.js's addressing
// scheme: Coolify container names change on every redeploy, so sibling
// services are reached via the Docker bridge gateway IP + published port,
// never by container-name DNS.
const WORKER_URL = process.env.PIPER_WORKER_URL || 'http://10.0.1.1:8789';
const WORKER_TOKEN = process.env.PIPER_WORKER_TOKEN || '';

export function isPiperConfigured() {
    return Boolean(WORKER_TOKEN);
}

export async function generatePiperVoiceover({ text, voice } = {}) {
    if (!text || !text.trim()) throw new Error('Текст для озвучки не указан');
    if (!isPiperConfigured()) {
        throw new Error('Piper не настроен — добавьте PIPER_WORKER_TOKEN в переменные окружения');
    }

    const res = await fetch(`${WORKER_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Token': WORKER_TOKEN },
        body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Piper: ${res.status} ${detail.slice(0, 300)}`);
    }
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    return { audioBuffer, contentType: 'audio/wav', estimatedCostUsd: 0 };
}
