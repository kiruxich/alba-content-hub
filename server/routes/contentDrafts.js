import { Router } from 'express';
import { db } from '../db.js';
import { translateToEnglish } from '../lib/translateToEnglish.js';
import { isLocalClaudeAgentConfigured, generateContentDraft, suggestContentTopic } from '../lib/localClaudeAgent.js';

const router = Router();

const FORMAT_KEYS = ['tgPost', 'reelsScript', 'threads', 'pinterest'];

async function buildProductContext(productId) {
    if (!productId) return '';
    const info = (await db.execute({ sql: 'SELECT * FROM project_info WHERE product_id = ?', args: [productId] })).rows[0];
    if (!info) return '';
    return [info.about, info.target_audience, info.value_proposition].filter(Boolean).join(' ');
}

// POST /generate { topic, productId?, formats?: string[] } - writes the
// requested formats (default: all 4, for back-compat) from a topic, on
// Sonnet via local-claude-agent (see generateContentDraft). Nothing is
// persisted here - the "Создание контента" page holds drafts client-side
// until the user explicitly promotes a format into Хранилище (POST
// /api/ideas), same as how a manually-typed idea always worked.
router.post('/generate', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }
    const topic = (req.body?.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    const productId = req.body?.productId || null;
    const requestedFormats = Array.isArray(req.body?.formats)
        ? req.body.formats.filter(k => FORMAT_KEYS.includes(k))
        : [];
    const formats = requestedFormats.length ? requestedFormats : FORMAT_KEYS;

    const productContext = await buildProductContext(productId);
    const settings = (await db.execute('SELECT tone_of_voice, post_formula FROM agent_settings WHERE id = 1')).rows[0];

    try {
        const result = await generateContentDraft({
            topic,
            productContext,
            toneOfVoice: settings?.tone_of_voice || '',
            postFormula: settings?.post_formula || '',
            formats,
        });
        for (const key of formats) {
            if (typeof result?.[key]?.title !== 'string') throw new Error(`generation missing "${key}"`);
        }
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// POST /suggest-topic { productId?, excludeTopics?: string[] } - asks
// local-claude-agent (Sonnet + WebSearch) to pitch one fresh, currently
// relevant post topic instead of the user having to think one up. Uses the
// same product context /generate does, plus the ~20 most recent idea titles
// (so it doesn't repeat what's already in Хранилище) merged with whatever
// this browser tab already suggested/typed this session (excludeTopics -
// freshly-suggested topics aren't persisted anywhere until promoted, so the
// client is what remembers them between clicks).
router.post('/suggest-topic', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }
    const productId = req.body?.productId || null;
    const excludeTopics = Array.isArray(req.body?.excludeTopics)
        ? req.body.excludeTopics.filter(t => typeof t === 'string' && t.trim())
        : [];

    const productContext = await buildProductContext(productId);
    const recentTitles = (await db.execute('SELECT title FROM ideas ORDER BY created_at DESC LIMIT 20')).rows
        .map(r => r.title).filter(Boolean);
    const usedTopics = [...new Set([...excludeTopics, ...recentTitles])];

    try {
        const result = await suggestContentTopic({ productContext, usedTopics });
        if (typeof result?.topic !== 'string' || !result.topic.trim()) throw new Error('agent did not return a topic');
        res.json({ topic: result.topic.trim() });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// POST /translate { items: { tgPost: {title,desc,cta}, reelsScript: {...}, threads: {...}, pinterest: {...} } }
// Translates whichever formats are present via the same free, self-hosted
// LibreTranslate instance ideas' own :id/translate route uses (see
// translateToEnglish.js) - a separate route because these drafts aren't
// persisted ideas yet, so there's no id to translate by.
router.post('/translate', async (req, res) => {
    const items = req.body?.items || {};
    try {
        const entries = await Promise.all(FORMAT_KEYS.map(async (key) => {
            const block = items[key];
            if (!block) return [key, null];
            const { titleEn, descEn, ctaEn } = await translateToEnglish({ title: block.title, desc: block.desc, cta: block.cta });
            return [key, { title: titleEn, desc: descEn, cta: ctaEn }];
        }));
        res.json(Object.fromEntries(entries.filter(([, v]) => v)));
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

export default router;
