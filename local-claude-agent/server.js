// Local Claude agent - runs on the user's own PC (Docker + a tunnel), not on
// the VPS. Reached by hub over the internet (via the tunnel URL) to run a
// small set of FIXED research/writing tasks using the user's own Claude
// subscription instead of a separate pay-per-token Anthropic API key -
// the actual `claude` CLI, non-interactively (`-p`), authenticated via
// `claude setup-token` (a long-lived token tied to the account's plan, same
// billing/usage pool as this very Claude Code session - see README.md).
//
// Deliberately NOT a generic "run whatever prompt you send me" endpoint:
// hub sends a fixed `task` name + narrow structured params, and this process
// builds the actual prompt itself from a local template. That keeps a leaked
// tunnel URL/token from being able to run arbitrary instructions against the
// user's own Claude account - only these specific, bounded tasks are
// reachable, and the CLI itself is restricted to a read-only tool (WebSearch).
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: '256kb' }));

const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const PORT = process.env.PORT || 8790;
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // web search + writing can take a couple minutes

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireToken(req, res, next) {
    if (!AGENT_TOKEN) return res.status(500).json({ error: 'AGENT_TOKEN not configured on this container' });
    const provided = req.headers['x-agent-token'] || '';
    if (!provided || !timingSafeEqual(provided, AGENT_TOKEN)) {
        return res.status(401).json({ error: 'bad agent token' });
    }
    next();
}

// Runs `claude -p <prompt>` non-interactively, scoped to WebSearch only (no
// Bash/Edit/Write - this container should never modify anything, local or
// remote, only research and write text). --dangerously-skip-permissions is
// required because there's no TTY here to approve WebSearch's first use.
async function runClaude(prompt) {
    const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--allowedTools', 'WebSearch',
        '--dangerously-skip-permissions',
    ];
    const { stdout } = await execFileAsync('claude', args, {
        timeout: CLAUDE_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    // `-p --output-format json` wraps the final assistant text in `.result`
    // (single-result JSON mode) - see `claude --help`.
    if (parsed.is_error) throw new Error(parsed.result || 'claude CLI reported an error');
    return parsed.result;
}

// Asks the model to answer as a single JSON value (no prose wrapper) and
// parses it - throws with the raw text attached if it didn't comply, so
// callers can decide whether to retry or surface the raw text to the user.
// Retries once on a malformed/truncated response (observed in practice -
// occasional cut-off JSON) before giving up, since a fresh generation
// attempt is usually well-formed.
async function runClaudeForJsonOnce(prompt) {
    const text = await runClaude(`${prompt}\n\nRespond with ONLY a single JSON value - no markdown fences, no prose before or after it.`);
    // The model doesn't always honor "no markdown fences" - strip a ```json
    // ... ``` (or bare ``` ... ```) wrapper if present before parsing, rather
    // than failing on otherwise-valid JSON.
    const unwrapped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
        return JSON.parse(unwrapped);
    } catch (e) {
        const err = new Error(`claude did not return valid JSON: ${e.message}`);
        err.rawText = text;
        throw err;
    }
}

async function runClaudeForJson(prompt) {
    try {
        return await runClaudeForJsonOnce(prompt);
    } catch (e) {
        return await runClaudeForJsonOnce(prompt);
    }
}

app.get('/health', (req, res) => res.json({ ok: true }));

// task: rss-discovery
// body: { existingSources: string[], niches: string[] }
// Finds RSS/Atom feeds relevant to the given niches that are not already in
// existingSources. Each candidate is validated by hub itself (a real fetch
// for a valid feed) before being saved - this endpoint only proposes.
app.post('/run/rss-discovery', requireToken, async (req, res) => {
    const existingSources = Array.isArray(req.body?.existingSources) ? req.body.existingSources : [];
    const niches = Array.isArray(req.body?.niches) ? req.body.niches : [];
    if (niches.length === 0) return res.status(400).json({ error: 'niches is required (non-empty array)' });

    const prompt = `You are helping curate RSS/Atom feed sources for a content-marketing research agent that scans them daily for trend ideas. The agent's products/niches: ${niches.join(', ')}.

Already-subscribed sources (do NOT suggest these again):
${existingSources.length ? existingSources.map(s => `- ${s}`).join('\n') : '(none yet)'}

Use web search to find 6-10 NEW, real, currently-active RSS or Atom feed URLs relevant to these niches (mix of Russian and English sources is fine, prefer feeds you can find direct evidence actually exist and are maintained - e.g. found via the publication's own site, not guessed from a pattern). Do not invent URLs you haven't seen evidence for.

Respond with a JSON array of objects: [{ "url": "...", "reason": "short reason this fits, in Russian" }, ...]`;

    try {
        const result = await runClaudeForJson(prompt);
        if (!Array.isArray(result)) throw new Error('expected a JSON array');
        res.json({ candidates: result });
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

// task: niche-description
// body: { category: string }
// Writes a short description used by generateParserQueries() to build 2GIS
// search queries for this niche.
app.post('/run/niche-description', requireToken, async (req, res) => {
    const category = (req.body?.category || '').trim();
    if (!category) return res.status(400).json({ error: 'category is required' });

    const prompt = `Write a short (2-4 sentence) description in Russian for the business niche "${category}", meant as input for generating 2GIS (Russian business-directory) search queries. Describe what kind of businesses fall in this niche and what search terms/synonyms a person might use to find them on 2GIS in Russia. No preamble.

Respond with a JSON object: { "description": "..." }`;

    try {
        const result = await runClaudeForJson(prompt);
        if (typeof result?.description !== 'string' || !result.description.trim()) throw new Error('expected { description }');
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

// task: reels-script
// body: { title: string, postText: string }
// Writes a short vertical-video (Reels/Shorts) scene-by-scene script/voiceover
// from an already-written post, for the idea-card "Сгенерировать" auto-chain.
app.post('/run/reels-script', requireToken, async (req, res) => {
    const title = (req.body?.title || '').trim();
    const postText = (req.body?.postText || '').trim();
    if (!postText) return res.status(400).json({ error: 'postText is required' });

    const prompt = `Turn this already-written social post into a short vertical video (Reels/Shorts, 20-40 seconds) script in Russian. Post title: "${title}". Post text:\n\n${postText}\n\nWrite: a short scene-by-scene shot list (what's shown), and a separate voiceover script (what's said, natural spoken Russian, timed to roughly fit 20-40 seconds when read aloud).

Respond with a JSON object: { "shotList": ["scene 1 description", "scene 2 description", ...], "voiceoverText": "..." }`;

    try {
        const result = await runClaudeForJson(prompt);
        if (typeof result?.voiceoverText !== 'string' || !result.voiceoverText.trim()) throw new Error('expected { shotList, voiceoverText }');
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

app.listen(PORT, () => {
    console.log(`local-claude-agent listening on :${PORT}`);
    if (!AGENT_TOKEN) console.warn('WARNING: AGENT_TOKEN is not set - every request will be rejected with 500 until it is.');
});
