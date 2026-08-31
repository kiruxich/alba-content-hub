// Client for local-claude-agent (see local-claude-agent/README.md) - a small
// HTTP wrapper the user runs on their own PC (Docker + a tunnel), running the
// real `claude` CLI under their own subscription. Gated behind
// LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN, same graceful-no-op
// pattern as every other optional integration in this codebase (kie.ai,
// ElevenLabs, S3, ...) - and additionally can fail simply because the user's
// PC/container/tunnel happens to be off right now, which callers should
// surface as a normal error, not a crash.
const AGENT_URL = (process.env.LOCAL_CLAUDE_AGENT_URL || '').replace(/\/$/, '');
const AGENT_TOKEN = process.env.LOCAL_CLAUDE_AGENT_TOKEN || '';

export function isLocalClaudeAgentConfigured() {
    return Boolean(AGENT_URL && AGENT_TOKEN);
}

async function callTask(task, body, { timeoutMs = 3 * 60 * 1000 } = {}) {
    if (!isLocalClaudeAgentConfigured()) {
        throw new Error('LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN не настроены');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${AGENT_URL}/run/${task}`, {
            method: 'POST',
            // ngrok-skip-browser-warning: without it, ngrok's free-tier tunnels
            // return an HTML interstitial page instead of proxying through to
            // the container - harmless no-op header for other tunnel providers.
            headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN, 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `local-claude-agent вернул ${res.status}`);
        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error('local-claude-agent не ответил вовремя — проверьте, что контейнер и туннель на ПК запущены');
        }
        if (e.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message)) {
            throw new Error('Не удалось достучаться до local-claude-agent — проверьте, что контейнер/туннель на ПК запущены');
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

export function discoverRssSources(existingSources, niches) {
    return callTask('rss-discovery', { existingSources, niches });
}

export function discoverKeywords(existingKeywords, niches) {
    return callTask('keyword-discovery', { existingKeywords, niches });
}

export function resolveCity(cityName) {
    return callTask('resolve-city', { cityName }, { timeoutMs: 90 * 1000 });
}

export function generateColdCallPitch({ category, prompt, toneOfVoice }) {
    return callTask('cold-call-pitch', { category, prompt, toneOfVoice }, { timeoutMs: 3 * 60 * 1000 });
}

export function generateNicheDescription(category) {
    return callTask('niche-description', { category });
}

export function generateReelsScript(title, postText) {
    return callTask('reels-script', { title, postText });
}

export function generateScriptSection({ heading, prompt, nicheName, nicheSubtitle, toneOfVoice }) {
    return callTask('script-section', { heading, prompt, nicheName, nicheSubtitle, toneOfVoice });
}

// Runs on Sonnet server-side (see local-claude-agent/server.js), longer
// timeout than the other tasks - it can write up to 4 full pieces of copy in
// one call. `formats` (subset of tgPost/reelsScript/threads/pinterest)
// defaults to all 4 server-side when omitted/empty.
export function generateContentDraft({ topic, productContext, toneOfVoice, postFormula, formats }) {
    return callTask('content-draft', { topic, productContext, toneOfVoice, postFormula, formats }, { timeoutMs: 4 * 60 * 1000 });
}

// Also Sonnet (see local-claude-agent/server.js) - a real topic pitch that
// gets typed straight into a publish-bound draft, using WebSearch to ground
// it in something actually current. `usedTopics` lets the caller keep
// re-rolling without getting the same suggestion twice.
export function suggestContentTopic({ productContext, usedTopics }) {
    return callTask('suggest-topic', { productContext, usedTopics }, { timeoutMs: 90 * 1000 });
}

// Short timeout (vs the 3-minute default) - reviewing a handful of short
// legal findings is quick, and this is a nice-to-have enrichment on top of
// the url-checker's static scan, not something the caller should wait long
// for if the user's PC/tunnel happens to be slow to respond right now.
export function reviewLegalFindings(findings, snippets) {
    return callTask('legal-review', { findings, snippets }, { timeoutMs: 60 * 1000 });
}
