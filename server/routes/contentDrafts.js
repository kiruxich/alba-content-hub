import { Router } from 'express';
import { db } from '../db.js';
import { translateToEnglish } from '../lib/translateToEnglish.js';
import { isLocalClaudeAgentConfigured, generateContentDraft } from '../lib/localClaudeAgent.js';

const router = Router();

const FORMAT_KEYS = ['tgPost', 'reelsScript', 'threads', 'pinterest'];

// POST /generate { topic, productId? } - writes all 4 formats from a topic,
// on Sonnet via local-claude-agent (see generateContentDraft). Nothing is
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

    let productContext = '';
    if (productId) {
        const info = (await db.execute({ sql: 'SELECT * FROM project_info WHERE product_id = ?', args: [productId] })).rows[0];
        if (info) {
            productContext = [info.about, info.target_audience, info.value_proposition].filter(Boolean).join(' ');
        }
    }
    const settings = (await db.execute('SELECT tone_of_voice, post_formula FROM agent_settings WHERE id = 1')).rows[0];

    try {
        const result = await generateContentDraft({
            topic,
            productContext,
            toneOfVoice: settings?.tone_of_voice || '',
            postFormula: settings?.post_formula || '',
        });
        for (const key of FORMAT_KEYS) {
            if (typeof result?.[key]?.title !== 'string') throw new Error(`generation missing "${key}"`);
        }
        res.json(result);
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
