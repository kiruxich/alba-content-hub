import { Router } from 'express';
import { db } from '../db.js';
import { isLocalClaudeAgentConfigured, generateScriptSection } from '../lib/localClaudeAgent.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        name: row.name,
        subtitle: row.subtitle,
        sections: JSON.parse(row.sections || '[]'),
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM niches ORDER BY created_at ASC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    const id = String(Date.now());
    await db.execute({
        sql: 'INSERT INTO niches (id, name, subtitle, sections) VALUES (?, ?, ?, ?)',
        args: [id, b.name.trim(), b.subtitle || '', JSON.stringify(b.sections || [])],
    });
    const result = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const existingRes = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [req.params.id] });
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'niche not found' });

    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : existing.name;
    const subtitle = b.subtitle !== undefined ? b.subtitle : existing.subtitle;
    const sections = b.sections !== undefined ? JSON.stringify(b.sections) : existing.sections;

    await db.execute({
        sql: 'UPDATE niches SET name = ?, subtitle = ?, sections = ? WHERE id = ?',
        args: [name, subtitle, sections, existing.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [existing.id] });
    res.json(serialize(result.rows[0]));
});

// POST /:id/sections/:sectionId/generate { prompt } - writes one section's
// text via local-claude-agent (see generateScriptSection). Doesn't persist
// anything itself - just like typing directly into the section's textarea,
// the result still needs the page's own "Сохранить скрипт" (PUT /:id) to
// stick, so a generation the user doesn't like can simply be discarded.
router.post('/:id/sections/:sectionId/generate', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }
    const row = (await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });

    const sections = JSON.parse(row.sections || '[]');
    const section = sections.find(s => s.id === req.params.sectionId);
    if (!section) return res.status(404).json({ error: 'section not found' });

    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const settingsRow = (await db.execute('SELECT tone_of_voice FROM agent_settings WHERE id = 1')).rows[0];

    try {
        const result = await generateScriptSection({
            heading: section.heading,
            prompt,
            nicheName: row.name,
            nicheSubtitle: row.subtitle || '',
            toneOfVoice: settingsRow?.tone_of_voice || '',
        });
        res.json({ text: result.text });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM niches WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'niche not found' });
    res.status(204).end();
});

export default router;
