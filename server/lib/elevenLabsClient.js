// Wraps ElevenLabs' text-to-speech REST API for voice-over generation
// (Phase 2 video-Shorts pipeline: this produces the narration track that a
// separate FFmpeg step later combines with a generated video clip and
// captions). Mirrors the pattern of translateToEnglish.js/telegramApproval.js:
// gated behind an env var, no secrets ever logged, clear Russian-language
// errors surfaced to the caller.
//
// API reference (checked live, Aug 2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//   header: xi-api-key: <ELEVENLABS_API_KEY>
//   body:   { text, model_id, voice_settings? }
//   -> 200 with the raw audio bytes (default output_format: mp3_44100_128)
// Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

// "Rachel" - one of the default voices available in every ElevenLabs account
// (used throughout their own docs/examples), picked as a safe default when
// the caller doesn't supply a voiceId. Any valid voice_id from the account's
// voice library (GET /v1/voices) can be passed instead.
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

// Cost estimate ONLY, for our own agent_expenses tracking - not an invoice.
// ElevenLabs' pay-as-you-go API pricing (separate from subscription-plan
// credit pools) is $0.10 per 1,000 characters for the eleven_multilingual_v2
// model as of their public pricing page (checked Aug 2026). Flash/Turbo
// models are cheaper (~$0.05/1000) but we default to multilingual_v2 for
// quality, so we estimate against that rate. Actual billing happens on the
// ElevenLabs account itself and may differ (discounts, a different model,
// subscription credits instead of pay-as-you-go, etc).
const USD_PER_CHARACTER = 0.0001;

export function isElevenLabsConfigured() {
    return Boolean(ELEVENLABS_API_KEY);
}

export function estimateVoiceoverCostUsd(text) {
    return (text?.length || 0) * USD_PER_CHARACTER;
}

// Generates a voice-over from `text` via ElevenLabs TTS.
// Returns { audioBuffer: Buffer, contentType: 'audio/mpeg', characterCount, estimatedCostUsd }.
// Throws an Error with a Russian, UI-safe message on any failure (not
// configured, empty text, ElevenLabs API error, network failure) - callers
// can surface err.message directly to the user.
export async function generateVoiceover({ text, voiceId } = {}) {
    if (!isElevenLabsConfigured()) {
        throw new Error('ElevenLabs не настроен: отсутствует переменная окружения ELEVENLABS_API_KEY');
    }

    const cleanText = (text || '').trim();
    if (!cleanText) {
        throw new Error('Текст для озвучки не указан');
    }

    const voice = (voiceId || '').trim() || DEFAULT_VOICE_ID;

    let res;
    try {
        res = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(voice)}`, {
            method: 'POST',
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
            },
            body: JSON.stringify({
                text: cleanText,
                model_id: DEFAULT_MODEL_ID,
            }),
        });
    } catch (e) {
        throw new Error('Не удалось связаться с ElevenLabs API: ' + e.message);
    }

    if (!res.ok) {
        let detail = res.statusText;
        try {
            const data = await res.json();
            detail = data?.detail?.message || data?.detail || detail;
        } catch (_) {
            // ElevenLabs sometimes returns a non-JSON error body - fall back
            // to the HTTP status text already in `detail`.
        }
        throw new Error(`Ошибка ElevenLabs API (${res.status}): ${detail}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    return {
        audioBuffer,
        contentType: 'audio/mpeg',
        characterCount: cleanText.length,
        estimatedCostUsd: estimateVoiceoverCostUsd(cleanText),
    };
}
