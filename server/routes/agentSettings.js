import { Router } from 'express';
import { db } from '../db.js';
import { isLocalClaudeAgentConfigured, discoverRssSources } from '../lib/localClaudeAgent.js';

const router = Router();

// A candidate URL is only kept if it actually resolves to a real RSS/Atom
// feed right now - local-claude-agent's suggestions are proposals, not
// trusted input, since a web-search-based model can occasionally cite a URL
// it didn't directly verify.
async function isValidFeedUrl(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return false;
        const text = (await res.text()).slice(0, 2000);
        return /<rss[\s>]|<feed[\s>]/i.test(text);
    } catch {
        return false;
    }
}

function serialize(row) {
    return {
        sources: JSON.parse(row.sources || '[]'),
        keywords: JSON.parse(row.keywords || '[]'),
        toneOfVoice: row.tone_of_voice || '',
        budgetDailyCapUsd: row.budget_daily_cap_usd,
        videoGenerationEnabled: Boolean(row.video_generation_enabled),
        platformAutoPublish: JSON.parse(row.platform_auto_publish || '{}'),
        productOfWeekOverride: row.product_of_week_override || null,
        weeklySchedule: JSON.parse(row.weekly_schedule || '[]'),
        postFormula: row.post_formula || '',
        generatorPrompt: row.generator_prompt || '',
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM agent_settings WHERE id = 1');
    res.json(serialize(result.rows[0]));
});

router.put('/', async (req, res) => {
    const b = req.body || {};
    const current = (await db.execute('SELECT * FROM agent_settings WHERE id = 1')).rows[0];

    const sources = b.sources !== undefined ? JSON.stringify(b.sources) : current.sources;
    const keywords = b.keywords !== undefined ? JSON.stringify(b.keywords) : current.keywords;
    const tone_of_voice = b.toneOfVoice !== undefined ? b.toneOfVoice : current.tone_of_voice;
    const budget_daily_cap_usd = b.budgetDailyCapUsd !== undefined ? b.budgetDailyCapUsd : current.budget_daily_cap_usd;
    const video_generation_enabled = b.videoGenerationEnabled !== undefined
        ? (b.videoGenerationEnabled ? 1 : 0) : current.video_generation_enabled;
    const platform_auto_publish = b.platformAutoPublish !== undefined
        ? JSON.stringify(b.platformAutoPublish) : current.platform_auto_publish;
    const product_of_week_override = b.productOfWeekOverride !== undefined
        ? b.productOfWeekOverride : current.product_of_week_override;
    const weekly_schedule = b.weeklySchedule !== undefined ? JSON.stringify(b.weeklySchedule) : current.weekly_schedule;
    const post_formula = b.postFormula !== undefined ? b.postFormula : current.post_formula;
    const generator_prompt = b.generatorPrompt !== undefined ? b.generatorPrompt : current.generator_prompt;

    await db.execute({
        sql: `UPDATE agent_settings SET sources = ?, keywords = ?, tone_of_voice = ?, budget_daily_cap_usd = ?,
              video_generation_enabled = ?, platform_auto_publish = ?, product_of_week_override = ?,
              weekly_schedule = ?, post_formula = ?, generator_prompt = ? WHERE id = 1`,
        args: [sources, keywords, tone_of_voice, budget_daily_cap_usd, video_generation_enabled,
            platform_auto_publish, product_of_week_override, weekly_schedule, post_formula, generator_prompt],
    });
    const result = await db.execute('SELECT * FROM agent_settings WHERE id = 1');
    res.json(serialize(result.rows[0]));
});

// "Обновить" button next to sources/keywords in Центр агентов - proposes new
// RSS sources via local-claude-agent (see server/lib/localClaudeAgent.js),
// validates each candidate for real, and appends only the new valid ones -
// never touches/removes what's already there.
router.post('/discover-sources', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }

    const current = (await db.execute('SELECT * FROM agent_settings WHERE id = 1')).rows[0];
    const existingSources = JSON.parse(current.sources || '[]');

    const nicheRows = (await db.execute('SELECT about FROM project_info')).rows;
    const niches = nicheRows.map(r => (r.about || '').trim()).filter(Boolean);
    if (niches.length === 0) {
        return res.status(400).json({ error: 'Нет описаний продуктов (project_info) — нечего использовать как ниши' });
    }

    let candidates;
    try {
        const result = await discoverRssSources(existingSources, niches);
        candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    } catch (e) {
        return res.status(502).json({ error: e.message });
    }

    const checks = await Promise.all(candidates.map(async (c) => ({
        ...c,
        valid: typeof c?.url === 'string' && !existingSources.includes(c.url) && await isValidFeedUrl(c.url),
    })));
    const added = checks.filter(c => c.valid).map(c => c.url);
    const rejected = checks.filter(c => !c.valid).map(c => c.url).filter(Boolean);

    if (added.length > 0) {
        const merged = [...existingSources, ...added];
        await db.execute({ sql: 'UPDATE agent_settings SET sources = ? WHERE id = 1', args: [JSON.stringify(merged)] });
    }

    res.json({ added, rejected, sources: added.length > 0 ? [...existingSources, ...added] : existingSources });
});

// Dedicated "add one" endpoints - deliberately separate from PUT / (which
// replaces the whole sources/keywords array from whatever the textarea/input
// holds client-side, so a stray edit there could lose an existing entry).
// These only ever append a single new item server-side, never touching or
// re-sending the rest of the list, so there's no way for them to drop
// anything already saved.
router.post('/sources', async (req, res) => {
    const url = (req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Укажите URL источника' });

    const current = (await db.execute('SELECT sources FROM agent_settings WHERE id = 1')).rows[0];
    const sources = JSON.parse(current.sources || '[]');
    if (sources.includes(url)) return res.status(409).json({ error: 'Такой источник уже есть в списке' });

    const merged = [...sources, url];
    await db.execute({ sql: 'UPDATE agent_settings SET sources = ? WHERE id = 1', args: [JSON.stringify(merged)] });
    res.status(201).json({ sources: merged });
});

router.post('/keywords', async (req, res) => {
    const keyword = (req.body?.keyword || '').trim();
    if (!keyword) return res.status(400).json({ error: 'Укажите ключевое слово' });

    const current = (await db.execute('SELECT keywords FROM agent_settings WHERE id = 1')).rows[0];
    const keywords = JSON.parse(current.keywords || '[]');
    if (keywords.includes(keyword)) return res.status(409).json({ error: 'Такое ключевое слово уже есть в списке' });

    const merged = [...keywords, keyword];
    await db.execute({ sql: 'UPDATE agent_settings SET keywords = ? WHERE id = 1', args: [JSON.stringify(merged)] });
    res.status(201).json({ keywords: merged });
});

export default router;
