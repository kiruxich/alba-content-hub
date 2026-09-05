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
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

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

// Telegram-watch (see README.md "Telegram source watching") - a real user
// (MTProto) session, not the publish bot, so it can read arbitrary public
// channels' posts the way a normal Telegram app would. Logged in once via
// `node telegram-login.js` (see that file) - TELEGRAM_SESSION below is the
// resulting long-lived credential. Connected lazily on first use and kept
// connected (not reconnected per-request) to avoid hammering Telegram's
// login flow and tripping flood limits.
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID || '');
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION = process.env.TELEGRAM_SESSION || '';
let telegramClientPromise = null;

function isTelegramWatchConfigured() {
    return Boolean(TELEGRAM_API_ID && TELEGRAM_API_HASH && TELEGRAM_SESSION);
}

async function getTelegramClient() {
    if (!isTelegramWatchConfigured()) {
        throw new Error('TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION not configured - run `node telegram-login.js` once, see README.md');
    }
    if (!telegramClientPromise) {
        const client = new TelegramClient(new StringSession(TELEGRAM_SESSION), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });
        telegramClientPromise = client.connect().then(() => client);
    }
    return telegramClientPromise;
}

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
async function runClaude(prompt, { model } = {}) {
    const args = [
        '-p', prompt,
        '--model', model || MODEL,
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
// attempt is usually well-formed. `model` overrides the container-wide
// default (see MODEL) for tasks that need it - e.g. content-draft, which
// writes real publish-ready copy and should match the quality bar the
// automated Generator routine uses (Sonnet), not the Haiku default used for
// lower-stakes tasks like RSS/keyword discovery.
async function runClaudeForJsonOnce(prompt, { model } = {}) {
    const text = await runClaude(`${prompt}\n\nRespond with ONLY a single JSON value - no markdown fences, no prose before or after it.`, { model });
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

async function runClaudeForJson(prompt, options = {}) {
    try {
        return await runClaudeForJsonOnce(prompt, options);
    } catch (e) {
        return await runClaudeForJsonOnce(prompt, options);
    }
}

app.get('/health', (req, res) => res.json({ ok: true }));

// task: telegram-add-channel
// body: { username: string }
// Resolves a channel/public-chat username to confirm it's real and reachable
// (with this account's session) before hub saves it to its watch list -
// same "validate before save" principle as the RSS-discovery flow's own
// live feed check.
app.post('/run/telegram-add-channel', requireToken, async (req, res) => {
    const username = (req.body?.username || '').trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'username is required' });

    try {
        const client = await getTelegramClient();
        const entity = await client.getEntity(username);
        res.json({
            username,
            title: entity?.title || entity?.firstName || username,
            membersCount: entity?.participantsCount ?? null,
        });
    } catch (e) {
        res.status(502).json({ error: `не удалось найти канал @${username}: ${e.message}` });
    }
});

// task: telegram-scan-channels
// body: { usernames: string[], limit?: number }
// Fetches the most recent posts (limit, default 10) from each channel - live
// each call, nothing is cached/stored on this side. Text-only content
// (media is skipped, not downloaded) since this is for browsing/inspiration,
// not republishing.
app.post('/run/telegram-scan-channels', requireToken, async (req, res) => {
    const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames.map(u => String(u).trim().replace(/^@/, '')).filter(Boolean) : [];
    const limit = Math.min(Number(req.body?.limit) || 10, 25);
    if (usernames.length === 0) return res.status(400).json({ error: 'usernames is required (non-empty array)' });

    let client;
    try {
        client = await getTelegramClient();
    } catch (e) {
        return res.status(502).json({ error: e.message });
    }

    const results = [];
    for (const username of usernames) {
        try {
            const entity = await client.getEntity(username);
            const messages = await client.getMessages(entity, { limit });
            const posts = messages
                .filter(m => m.message && m.message.trim())
                .map(m => ({
                    id: m.id,
                    text: m.message,
                    date: m.date ? new Date(m.date * 1000).toISOString() : null,
                    views: m.views ?? null,
                    forwards: m.forwards ?? null,
                    link: `https://t.me/${username}/${m.id}`,
                }));
            results.push({ username, title: entity?.title || username, posts, error: null });
        } catch (e) {
            results.push({ username, title: username, posts: [], error: e.message });
        }
    }
    res.json({ channels: results });
});

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

// task: resolve-city
// body: { cityName: string }
// Determines the real 2GIS URL slug (https://2gis.ru/<slug>/search/...) and
// a lat/lon bounding box for an arbitrary city the user typed - used by the
// 2GIS parser (server/lib/resolveParserCity.js) to scrape any city, not
// just a fixed pre-baked list. Uses WebSearch to actually confirm the slug
// rather than guessing, since a wrong slug means the whole scrape finds
// nothing.
app.post('/run/resolve-city', requireToken, async (req, res) => {
    const cityName = (req.body?.cityName || '').trim();
    if (!cityName) return res.status(400).json({ error: 'cityName is required' });

    const prompt = `Find the correct 2GIS (2gis.ru - a Russian/CIS business directory and maps service) URL slug for the city "${cityName}", and a lat/lon bounding box covering that city plus its immediate built-up suburbs.

Use web search to confirm the exact URL 2GIS uses for this city - its search pages look like https://2gis.ru/<slug>/search/... (for reference, Moscow is "moscow", Saint Petersburg is "spb"). Do not guess the slug without checking - search for it. Also determine a bounding box (min/max latitude, min/max longitude) tight enough to stay centered on the city, not the whole surrounding region.

If "${cityName}" isn't a real place you can find on 2GIS, or isn't in Russia/CIS where 2GIS operates, say so as an error instead of inventing values.

Respond with a JSON object: { "slug": "...", "label": "${cityName}", "latMin": 00.000, "latMax": 00.000, "lonMin": 00.000, "lonMax": 00.000 }`;

    try {
        const result = await runClaudeForJson(prompt);
        const nums = [result?.latMin, result?.latMax, result?.lonMin, result?.lonMax];
        if (typeof result?.slug !== 'string' || !result.slug.trim() || nums.some(n => typeof n !== 'number')) {
            throw new Error(`не удалось определить город «${cityName}» — проверьте название`);
        }
        res.json(result);
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

// task: roadmap
// body: { productName: string, about?, targetAudience?, valueProposition?,
//         keyDifferentiators?: string, existingTitles?: string[] }
// Suggests promotion-roadmap milestones for a product's "ROADMAP
// ПРОДВИЖЕНИЯ" checklist (see server/routes/projectInfo.js), grounded in
// the same project-info fields the user fills in above it on that page.
// Sonnet, not Haiku - like cold-call-pitch/content-draft, this is real
// planning content the user reviews and keeps, not disposable discovery
// output.
app.post('/run/roadmap', requireToken, async (req, res) => {
    const productName = (req.body?.productName || '').trim();
    if (!productName) return res.status(400).json({ error: 'productName is required' });
    const about = (req.body?.about || '').trim();
    const targetAudience = (req.body?.targetAudience || '').trim();
    const valueProposition = (req.body?.valueProposition || '').trim();
    const keyDifferentiators = (req.body?.keyDifferentiators || '').trim();
    const existingTitles = Array.isArray(req.body?.existingTitles) ? req.body.existingTitles.filter(Boolean) : [];

    const prompt = `You are helping plan a product promotion roadmap for "${productName}".

${about ? `About the product: ${about}\n` : ''}${targetAudience ? `Target audience: ${targetAudience}\n` : ''}${valueProposition ? `Value proposition: ${valueProposition}\n` : ''}${keyDifferentiators ? `Key differentiators: ${keyDifferentiators}\n` : ''}
${existingTitles.length ? `Roadmap steps already planned (do NOT repeat these or close variants):\n${existingTitles.map(t => `- ${t}`).join('\n')}\n` : ''}
Suggest 3-6 NEW, concrete, sequential roadmap milestones for promoting this product (e.g. "MVP", "Первые 10 клиентов", "Запуск партнёрской программы") - each a short title plus a 1-2 sentence description of what it actually involves. Order them roughly by when they'd happen. Write in Russian.

Respond with a JSON array of objects: [{ "title": "...", "description": "..." }, ...]`;

    try {
        const result = await runClaudeForJson(prompt, { model: 'claude-sonnet-5' });
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

// task: cold-call-pitch
// body: { category: string, prompt?: string, toneOfVoice?: string }
// Writes the cold-outreach pitch text sent over Telegram to a lead who's
// still considering the offer (see "Заказчики" tab) - real, publish-ready
// copy, so this runs on Sonnet, not the container's Haiku default. The
// example below is the user's own real, working pitch for hookah lounges -
// used as a structural template (two numbered service pillars, a free
// first-step offer, a contact block), not something to copy verbatim for
// every niche.
app.post('/run/cold-call-pitch', requireToken, async (req, res) => {
    const category = (req.body?.category || '').trim();
    const prompt = (req.body?.prompt || '').trim();
    const toneOfVoice = (req.body?.toneOfVoice || '').trim();
    if (!category) return res.status(400).json({ error: 'category is required' });

    const fullPrompt = `Write a cold-outreach pitch message in Russian, from Alba Creation (a web/software studio), for a business in the "${category}" niche. This gets sent over Telegram to a lead who's still deciding whether to work with the studio - it needs to read as a real, personal message, not a mass-market ad.

Here is a real, working pitch (for hookah lounges) to use as a STRUCTURAL TEMPLATE - match its shape (short personal intro, two numbered service offerings each with a bolded benefit-driven subheading and bullet points, a "what I propose as a first step" free-trial-style CTA, then a contact block with Telegram/phone/site), but write NEW, niche-appropriate substance for "${category}" - do not reuse hookah-specific details unless they're genuinely relevant:

---
Добрый день! Меня зовут Кирилл, владелец IT-студии Alba Creation.

Предлагаю связку из двух инструментов, которая закроет две главные бизнес-задачи: привлечение новых гостей и превращение их в постоянников.

1. запуск сайта: захват трафика с Яндекс Карт и победа над конкурентами

Простой прайс-лист не передает обновленную атмосферу и не конвертирует входящий поток. Сайт решит эту проблему:
• Приоритет на Яндекс Картах: Яндекс автоматически поднимает выше карточки заведений с полноценным сайтом.
• Забор «молчаливого» трафика: До 40% пользователей принципиально не любят звонить в шумное заведение. Сайт позволяет им за 5 секунд оценить новый интерьер, посмотреть актуальное меню и забронировать стол в 1 клик.
• Перелив трафика в ваш Telegram-канал: Сайт станет хабом, который дополнительно генерирует подписки в ваши соцсети.

2. Telegram бот для роста числа постоянников:

Если сайт приводит гостя первый раз, то бот делает так, чтобы он возвращался снова и снова. В портфолио у нас есть релевантный кейс для кальянной Blisski — там мы реализовывали полноценную экосистему:
• Интерактивная бронь по схеме зала: гость сам кликает на конкретный столик, а не заполняет слепую форму.
• История забивок и конструктор миксов: гость больше не забывает, что курил в прошлый раз, и может легко повторить свой любимый сет.
• Вызов кальянщика в 1 клик: кнопка прямо из бота к конкретному столику (не нужно искать персонал в темном зале).
• Управляемая база: удобная админка с изменением цен/табаков за 1 минуту, картой лояльности и рассылками анонсов без риска бана от Telegram.

Результат Blisski: за счет такого сервиса заведение сформировало сильное ядро постоянников и существенно увеличило процент повторных визитов.

Что предлагаю в качестве первого шага:

Чтобы вы не оценивали идею на словах, я могу на днях бесплатно сделать концепт главной страницы конкретно под ваше заведение — с вашей новой атмосферой и меню. Заодно пришлю демо-бота Blisski, чтобы вы сами его протестировали.

Как вам предложение? Если заинтересованы — дайте знать сюда в чат или пишите напрямую:

Telegram: @KirillSklemin
Тел.: +7 (915) 495-42-93
Ссылка на наш сайт: alba-creation.ru
---

${toneOfVoice ? `Tone of voice to follow: ${toneOfVoice}\n` : ''}${prompt ? `Specific instructions for this niche/pitch: ${prompt}` : 'No specific instructions given - use your best judgment for what pain points and service angle fit this niche.'}

If the demo-bot line ("Заодно пришлю демо-бота Blisski") doesn't make sense for this niche, adapt or drop it - only keep it if there's a genuinely relevant portfolio case to reference (mention it generically as "готовый пример из портфолио" if you don't have a specific product name to use).

Respond with a JSON object: { "text": "..." } - the full pitch message as one string with real line breaks (\\n), ready to paste into Telegram as-is.`;

    try {
        const result = await runClaudeForJson(fullPrompt, { model: 'claude-sonnet-5' });
        if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('expected { text }');
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

// Format specs shared by content-draft's prompt/schema builder below - kept
// as data so the prompt only ever mentions the formats actually requested
// (see `formats` on the request), instead of always asking the model to
// write all 4 regardless of what the caller wants.
const CONTENT_FORMAT_SPECS = {
    tgPost: { label: 'tgPost - a Telegram post', desc: 'title, body text (2-4 short paragraphs), and a call-to-action.' },
    reelsScript: { label: 'reelsScript - a script for a 20-40 second vertical video (Reels/Shorts)', desc: 'title, then the body as a readable shot-by-shot script (scene description + spoken line, alternating), and a call-to-action.' },
    threads: { label: 'threads - a Threads post', desc: 'a short punchy hook as the title, body text noticeably shorter and more casual than the Telegram post (Threads favors brevity), and a call-to-action.' },
    pinterest: { label: 'pinterest - a Pinterest pin', desc: 'a short SEO-friendly title, a description (2-3 sentences, keyword-rich for Pinterest search), and a call-to-action.' },
};
const CONTENT_FORMAT_KEYS = Object.keys(CONTENT_FORMAT_SPECS);

// task: content-draft
// body: { topic: string, productContext?: string, toneOfVoice?: string, postFormula?: string, formats?: string[] }
// Writes real, publish-ready copy for the "Создание контента" page - one or
// more of the 4 formats above, from one topic, in one call. `formats`
// defaults to all 4 (back-compat with callers that don't send it yet); only
// the requested keys are asked for and validated, so picking fewer formats
// actually saves the model from writing (and the caller from paying for)
// copy nobody asked for. Unlike every other task in this file, this runs on
// Sonnet, not the container's default Haiku (see MODEL): this is the same
// tier of output as the automated Generator routine produces for actually-
// published content, not a low-stakes research/labeling task.
app.post('/run/content-draft', requireToken, async (req, res) => {
    const topic = (req.body?.topic || '').trim();
    const productContext = (req.body?.productContext || '').trim();
    const toneOfVoice = (req.body?.toneOfVoice || '').trim();
    const postFormula = (req.body?.postFormula || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    const requestedFormats = Array.isArray(req.body?.formats) ? req.body.formats.filter(k => CONTENT_FORMAT_KEYS.includes(k)) : [];
    const formats = requestedFormats.length ? requestedFormats : CONTENT_FORMAT_KEYS;

    const formatList = formats.map((key, i) => `${i + 1}. ${CONTENT_FORMAT_SPECS[key].label}: ${CONTENT_FORMAT_SPECS[key].desc}`).join('\n');
    const schemaFields = formats.map(key => `"${key}": { "title": "...", "desc": "...", "cta": "..." }`).join(', ');

    const prompt = `You are writing content for Alba Creation's content-marketing hub, in ${formats.length} different format${formats.length > 1 ? 's' : ''} for the same topic, all in Russian. Each format is a separate, complete, ready-to-publish piece - not variations of the same text, each adapted to how that platform is actually used.

Topic: "${topic}"
${productContext ? `Product/service context: ${productContext}\n` : ''}${toneOfVoice ? `Tone of voice to follow: ${toneOfVoice}\n` : ''}${postFormula ? `Post structure guideline ("золотая середина"): ${postFormula}\n` : ''}
Write ${formats.length > 1 ? 'all of the following' : 'the following'}:
${formatList}

Respond with a JSON object: { ${schemaFields} }`;

    try {
        const result = await runClaudeForJson(prompt, { model: 'claude-sonnet-5' });
        for (const key of formats) {
            if (typeof result?.[key]?.title !== 'string') throw new Error(`expected "${key}" in response`);
        }
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

// task: suggest-topic
// body: { productContext?: string, usedTopics?: string[] }
// Pitches ONE fresh, currently-relevant post topic for the "Создание
// контента" page's topic field, so the user doesn't have to think one up
// themselves. Uses WebSearch (the container's only allowed tool - see
// runClaude above) to ground the pitch in something actually current rather
// than a generic evergreen topic, and is told which topics were already
// used/suggested so a repeat click proposes something different instead of
// looping on the same idea. Sonnet, same tier as content-draft - this is a
// real pitch that gets typed straight into a publish-bound draft, not a
// low-stakes labeling task.
// body also accepts optional strategyContext (server/routes/contentPlan.js's
// GET /content-plan/context, fetched by the caller) - folded into the prompt
// so "why relevant" can genuinely reference the current business goal/
// quarter focus instead of just restating the news item.
app.post('/run/suggest-topic', requireToken, async (req, res) => {
    const productContext = (req.body?.productContext || '').trim();
    const strategyContext = (req.body?.strategyContext || '').trim();
    const usedTopics = Array.isArray(req.body?.usedTopics)
        ? req.body.usedTopics.filter(t => typeof t === 'string' && t.trim()).slice(0, 40)
        : [];

    const prompt = `You are pitching ONE fresh, currently relevant social-media post topic for a content-marketing hub, in Russian.
${productContext ? `Product/service/niche context: ${productContext}\n` : ''}${strategyContext ? `Current content strategy context (goal, distribution model, this quarter's focus, today's focus): ${strategyContext}\n` : ''}
Use web search to ground this in something genuinely current (a recent news item, trend, seasonal moment, or event relevant to the niche/context above) - do not invent a generic, timeless topic that could have been written on any day. Cite what you actually found (real, verifiable sources - name the publication/site, don't invent URLs you didn't see).
${usedTopics.length ? `Do NOT suggest any of these already-used/suggested topics, or close variants of them:\n${usedTopics.map(t => `- ${t}`).join('\n')}\n` : ''}
Respond with a JSON object:
{
  "topic": "one short, specific post topic in Russian, ready to write a post from",
  "sources": ["short source name/description in Russian - what you found and where, 1-3 items"],
  "whyRelevant": "1-2 sentences in Russian: why this is timely right now, and how it connects to the strategy context above if one was given",
  "publishSuggestion": "1 short sentence in Russian: best format/platform and rough timing to publish this (e.g. 'Reels на этой неделе, пока тема свежая' or 'TG-пост, можно в любое время в этом квартале')"
}`;

    try {
        const result = await runClaudeForJson(prompt, { model: 'claude-sonnet-5' });
        if (typeof result?.topic !== 'string' || !result.topic.trim()) throw new Error('expected { topic }');
        res.json({
            topic: result.topic.trim(),
            sources: Array.isArray(result.sources) ? result.sources.filter(s => typeof s === 'string') : [],
            whyRelevant: typeof result.whyRelevant === 'string' ? result.whyRelevant : '',
            publishSuggestion: typeof result.publishSuggestion === 'string' ? result.publishSuggestion : '',
        });
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

// task: find-client-sites
// body: { category: string, city?: string, excludeDomains?: string[], limit?: number }
// Подбирает сайты компаний ниши в городе - это шаг «поиск» для второй базы
// заказчиков (scrape-worker, ScrapeGraphAI). Сам обход сайтов и извлечение
// контактов делает воркер на локальной Ollama; сюда вынесен только поиск,
// потому что WebSearch у этого контейнера уже есть, а заводить второй
// поисковый бэкенд с собственными ключами ради этого незачем.
// Возвращает только URL - никаких контактов: выдумать телефон модель может,
// а проверить его здесь нечем, поэтому контакты берутся исключительно с
// живой страницы.
app.post('/run/find-client-sites', requireToken, async (req, res) => {
    const category = (req.body?.category || '').trim();
    const city = (req.body?.city || '').trim();
    const excludeDomains = Array.isArray(req.body?.excludeDomains)
        ? req.body.excludeDomains.filter(d => typeof d === 'string' && d.trim()).slice(0, 100)
        : [];
    const limit = Math.min(Math.max(Number(req.body?.limit) || 30, 1), 60);
    if (!category) return res.status(400).json({ error: 'category is required' });

    const prompt = `Найди сайты реальных компаний ниши «${category}»${city ? ` в городе ${city}` : ''}.

Используй веб-поиск. Нужны официальные сайты самих компаний, а НЕ агрегаторы, каталоги и справочники (2gis, yandex, zoon, avito, flamp, отзовики, маркетплейсы, соцсети, hh) - их отбрасывай. Только домены, которые принадлежат конкретной компании.

Не выдумывай адреса сайтов: включай только те, которые реально встретились в результатах поиска. Лучше вернуть 8 проверенных, чем 30 придуманных.
${excludeDomains.length ? `\nЭти домены уже собраны, НЕ предлагай их снова:\n${excludeDomains.map(d => `- ${d}`).join('\n')}\n` : ''}
Верни до ${limit} штук в виде JSON-массива объектов:
[{ "name": "название компании", "url": "https://...", "why": "коротко по-русски, почему это подходящая компания ниши" }]`;

    try {
        const result = await runClaudeForJson(prompt);
        if (!Array.isArray(result)) throw new Error('expected a JSON array');
        const sites = result
            .filter(r => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url.trim()))
            .map(r => ({
                name: typeof r.name === 'string' ? r.name.trim() : '',
                url: r.url.trim(),
                why: typeof r.why === 'string' ? r.why.trim() : '',
            }))
            .slice(0, limit);
        res.json({ sites });
    } catch (e) {
        res.status(502).json({ error: e.message, rawText: e.rawText });
    }
});

app.listen(PORT, () => {
    console.log(`local-claude-agent listening on :${PORT}`);
    if (!AGENT_TOKEN) console.warn('WARNING: AGENT_TOKEN is not set - every request will be rejected with 500 until it is.');
});
