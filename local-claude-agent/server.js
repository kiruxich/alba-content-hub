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
// These are short, narrowly-scoped tasks (find some feeds, write a couple
// sentences, turn a post into a script) - Haiku handles them fine and costs
// far less of the account's usage than Sonnet/Opus would for the same work.
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

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
        '--model', MODEL,
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

// task: keyword-discovery
// body: { existingKeywords: string[], niches: string[] }
// Proposes new RSS-filter keywords - the agent keeps only feed articles that
// match one of these. Candidates are just proposed here; hub itself decides
// which ones actually get saved (there's no live-validity check possible for
// a keyword the way there is for an RSS URL).
app.post('/run/keyword-discovery', requireToken, async (req, res) => {
    const existingKeywords = Array.isArray(req.body?.existingKeywords) ? req.body.existingKeywords : [];
    const niches = Array.isArray(req.body?.niches) ? req.body.niches : [];
    if (niches.length === 0) return res.status(400).json({ error: 'niches is required (non-empty array)' });

    const prompt = `You are helping curate keyword filters for a content-marketing research agent that scans RSS feeds daily and keeps only articles matching at least one of these keywords. The agent's products/niches: ${niches.join(', ')}.

Already-used keywords (do NOT suggest these again, or close variants of them):
${existingKeywords.length ? existingKeywords.map(k => `- ${k}`).join('\n') : '(none yet)'}

Suggest 5-10 NEW keywords/short phrases relevant to these niches that would help catch relevant industry news and trend articles - a mix of broad category terms and more specific ones, in Russian or English depending on what's natural for each niche. Each keyword should be 1-3 words, no full sentences.

Respond with a JSON array of objects: [{ "keyword": "...", "reason": "short reason this fits, in Russian" }, ...]`;

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
// Writes a description for generateParserQueries.js (server/lib) to build
// 2GIS search queries from - IMPORTANT: that function does NOT read this as
// prose. It lowercases `category + ' ' + description`, splits on whitespace/
// punctuation, dedupes, and takes only the FIRST 8 unique words as the
// actual keywords sent to 2GIS. A fluent sentence ("Ниша охватывает
// компании, оказывающие услуги...") wastes those 8 slots on connector words
// ("ниша", "охватывает", "в") instead of real search synonyms - so the
// prompt below asks for a keyword list, not a description, even though the
// field/response key stays "description" for compatibility with that code.
app.post('/run/niche-description', requireToken, async (req, res) => {
    const category = (req.body?.category || '').trim();
    if (!category) return res.status(400).json({ error: 'category is required' });

    const prompt = `A downstream script will take your answer, lowercase it, split it into individual words on whitespace/commas/punctuation, and use only the FIRST 8 unique words as literal search keywords for finding "${category}" businesses on 2ГИС (a Russian business directory). It does NOT read your answer as a sentence - only isolated bare words matter, in order. Any character that isn't a plain letter (quotation marks «», "", punctuation) stays glued to the word and breaks the match.

Write a comma-separated list of alternate names and search synonyms Russian users would actually type into 2ГИС to find this type of business - most common/important term first. Rules: each item is 1-2 bare words with NO surrounding punctuation (no quotation marks of any kind around a term); NO connecting words anywhere in the list, including "и" before the last item - a normal Russian list would put "и" there, but do not, since this is parsed by a script, not read as a sentence; no sentence structure at all, just terms separated by commas. Example for "барбершопы" (plain words, no quotes, no "и"): барбершоп, барбер, мужская парикмахерская, стрижка бороды, мужской салон, barbershop. Russian, unless a term is commonly searched in Latin script (e.g. brand-style words).

Respond with a JSON object: { "description": "term one, term two, term three, ..." } - the description value itself must be plain comma-separated text, no quotation marks inside it.`;

    try {
        const result = await runClaudeForJson(prompt);
        if (typeof result?.description !== 'string' || !result.description.trim()) throw new Error('expected { description }');
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

// task: script-section
// body: { heading: string, prompt: string, nicheName: string, nicheSubtitle?: string, toneOfVoice?: string }
// Writes the text for ONE section of a live cold-call sales script (see
// "Скрипты" tab / niches table) - each section is generated independently
// so the user can iterate on one part (e.g. "Боль") without regenerating
// the whole script, but toneOfVoice (Центр агентов' shared "Тон голоса"
// field) is always passed in so independently-generated sections still
// read consistently with each other.
app.post('/run/script-section', requireToken, async (req, res) => {
    const heading = (req.body?.heading || '').trim();
    const prompt = (req.body?.prompt || '').trim();
    const nicheName = (req.body?.nicheName || '').trim();
    const nicheSubtitle = (req.body?.nicheSubtitle || '').trim();
    const toneOfVoice = (req.body?.toneOfVoice || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (!nicheName) return res.status(400).json({ error: 'nicheName is required' });

    const fullPrompt = `You are writing one section ("${heading || 'без названия'}") of a Russian-language live cold-call sales script, for a salesperson calling businesses in the "${nicheName}" niche${nicheSubtitle ? ` (${nicheSubtitle})` : ''}.
${toneOfVoice ? `\nOverall tone/style to follow for this whole script: ${toneOfVoice}\n` : ''}
Instruction for this specific section: ${prompt}

Write ONLY the section's script text itself - natural spoken Russian the salesperson would actually say, or a numbered list of prepared questions/talking points if that fits the section better. No markdown formatting, no headers, no meta-commentary about the script.

Respond with a JSON object: { "text": "..." }`;

    try {
        const result = await runClaudeForJson(fullPrompt);
        if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('expected { text }');
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

// task: legal-review
// body: { findings: {ruleId,file,message,excerpt}[], snippets: Record<string,string> }
// Second-opinion pass over legitAgent's regex-based legal findings (see
// server/routes/urlChecker.js) - a rule like "ADV.ERID.MISSING" fires on any
// page with the word "реклама" and no erid attribute nearby, which can't
// distinguish a real undisclosed ad from a false-positive text match. This
// gives each finding a verdict using the page snippet as evidence, same as
// legitAgent's own optional reviewFindings() step, just running on the
// user's own Claude subscription instead of requiring a separate OpenAI-
// compatible API key. Structured input only (findings/snippets), never a
// raw prompt string from the caller - same bounded-task design as the rest
// of this file.
app.post('/run/legal-review', requireToken, async (req, res) => {
    const findings = Array.isArray(req.body?.findings) ? req.body.findings : [];
    const snippets = req.body?.snippets && typeof req.body.snippets === 'object' ? req.body.snippets : {};
    if (findings.length === 0) return res.json({ reviewed: [] });

    const items = findings.slice(0, 30).map(f => ({
        ruleId: String(f?.ruleId || ''),
        file: String(f?.file || ''),
        message: String(f?.message || ''),
        excerpt: String(f?.excerpt || ''),
        snippet: String(snippets[f?.file] || '').slice(0, 4000),
    }));

    const prompt = `Review compliance findings from a Russian legal-compliance scanner (152-ФЗ personal data law, 38-ФЗ advertising law, ЗоЗПП consumer protection law). Each finding was flagged by a regex-based rule and may be a false positive - use the snippet (the page's actual HTML/text) to judge whether it really confirms the violation described in "message".

Reply with a JSON array only, one object per finding, in the same order: { "ruleId", "file", "verdict", "reason" }. Verdict must be exactly one of: "confirm" (snippet clearly confirms the violation), "reject" (snippet shows this is a false positive / doesn't apply), "ask_human" (can't tell for certain from the snippet alone). Reason: one short sentence in Russian explaining the verdict.

${JSON.stringify(items, null, 2)}`;

    try {
        const result = await runClaudeForJson(prompt);
        if (!Array.isArray(result)) throw new Error('expected a JSON array');
        res.json({ reviewed: result });
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

app.listen(PORT, () => {
    console.log(`local-claude-agent listening on :${PORT}`);
    if (!AGENT_TOKEN) console.warn('WARNING: AGENT_TOKEN is not set - every request will be rejected with 500 until it is.');
});
