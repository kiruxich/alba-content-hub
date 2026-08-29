import { Router } from 'express';
import { db } from '../db.js';
import { translateToEnglish } from '../lib/translateToEnglish.js';
import { validateDraft } from '../lib/editorValidation.js';
import { sendIdeaForApproval } from '../lib/telegramApproval.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        title: row.title,
        desc: row.desc,
        format: row.format,
        funnel: row.funnel,
        status: row.status,
        cta: row.cta,
        titleEn: row.title_en || '',
        descEn: row.desc_en || '',
        ctaEn: row.cta_en || '',
        targetGroups: JSON.parse(row.target_groups || '[]'),
        metrics: {
            views: row.metrics_views,
            saves: row.metrics_saves,
            clicks: row.metrics_clicks,
            leads: row.metrics_leads,
        },
        source: row.source || 'manual',
        agentMeta: row.agent_meta ? JSON.parse(row.agent_meta) : null,
        draftText: row.draft_text ? JSON.parse(row.draft_text) : null,
        contentType: row.content_type || 'evergreen',
        expiresAt: row.expires_at || null,
        rubricId: row.rubric_id || null,
        qualityFlags: JSON.parse(row.quality_flags || '[]'),
        coverAssetId: row.cover_asset_id || null,
    };
}

const upsertSql = `
    INSERT INTO ideas (id, title, desc, format, funnel, status, cta, target_groups, metrics_views, metrics_saves, metrics_clicks, metrics_leads, source, agent_meta, draft_text, content_type, expires_at, rubric_id, quality_flags, cover_asset_id, title_en, desc_en, cta_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, desc = excluded.desc, format = excluded.format,
        funnel = excluded.funnel, status = excluded.status, cta = excluded.cta,
        target_groups = excluded.target_groups,
        metrics_views = excluded.metrics_views, metrics_saves = excluded.metrics_saves,
        metrics_clicks = excluded.metrics_clicks, metrics_leads = excluded.metrics_leads,
        source = excluded.source, agent_meta = excluded.agent_meta, draft_text = excluded.draft_text,
        content_type = excluded.content_type, expires_at = excluded.expires_at,
        rubric_id = excluded.rubric_id, quality_flags = excluded.quality_flags,
        cover_asset_id = excluded.cover_asset_id,
        title_en = excluded.title_en, desc_en = excluded.desc_en, cta_en = excluded.cta_en
`;

function upsertArgs(row) {
    return [row.id, row.title, row.desc, row.format, row.funnel, row.status, row.cta,
        row.target_groups, row.metrics_views, row.metrics_saves, row.metrics_clicks, row.metrics_leads,
        row.source, row.agent_meta, row.draft_text,
        row.content_type, row.expires_at, row.rubric_id, row.quality_flags, row.cover_asset_id,
        row.title_en ?? null, row.desc_en ?? null, row.cta_en ?? null];
}

// GET /api/ideas?q=search+term  -- indexed LIKE scan over title/desc
// GET /api/ideas?source=agent   -- filter to AI-generated drafts (AI Agent Center)
router.get('/', async (req, res) => {
    const q = (req.query.q || '').trim();
    const source = (req.query.source || '').trim();

    const clauses = [];
    const args = [];
    if (q) {
        clauses.push('(title LIKE ? OR desc LIKE ? OR format LIKE ? OR funnel LIKE ? OR agent_meta LIKE ?)');
        const like = `%${q}%`;
        args.push(like, like, like, like, like);
    }
    if (source) {
        clauses.push('source = ?');
        args.push(source);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.execute({
        sql: `SELECT * FROM ideas ${where} ORDER BY created_at DESC`,
        args,
    });
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) {
        return res.status(400).json({ error: 'title is required' });
    }
    const id = String(Date.now());

    // Editor / quality-gate: agent-authored drafts carry their "Золотая
    // середина" structure as separate fields in draftText - the server
    // recomputes quality_flags itself (never trusts the caller's) and
    // assembles the final post text from those fields, rather than the
    // client sending pre-joined desc text.
    let desc = b.desc || '';
    let qualityFlags = b.qualityFlags || [];
    if (b.source === 'agent' && b.draftText) {
        const { flags, assembledText } = validateDraft({ ...b.draftText, format: b.format });
        qualityFlags = flags;
        desc = assembledText;
    }

    await db.execute({
        sql: upsertSql,
        args: upsertArgs({
            id,
            title: b.title.trim(),
            desc,
            format: b.format || 'TG Пост',
            funnel: b.funnel || 'TOFU',
            status: b.status || 'idea',
            cta: b.cta || '',
            target_groups: JSON.stringify(b.targetGroups || []),
            metrics_views: 0, metrics_saves: 0, metrics_clicks: 0, metrics_leads: 0,
            source: b.source || 'manual',
            agent_meta: b.agentMeta ? JSON.stringify(b.agentMeta) : null,
            draft_text: b.draftText ? JSON.stringify(b.draftText) : null,
            content_type: b.contentType || 'evergreen',
            expires_at: b.expiresAt || null,
            rubric_id: b.rubricId || null,
            quality_flags: JSON.stringify(qualityFlags),
            cover_asset_id: b.coverAssetId || null,
            title_en: null, desc_en: null, cta_en: null,
        }),
    });
    const result = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [id] });
    const savedIdea = serialize(result.rows[0]);

    // Agent-authored drafts go to Telegram for human approval instead of
    // sitting silently in the "AI Agent Center" until someone happens to
    // check - see server/lib/telegramApproval.js and the reply handler in
    // server/routes/telegramWebhook.js. Best-effort: a Telegram hiccup must
    // never fail idea creation itself.
    if (savedIdea.source === 'agent') {
        try {
            await sendIdeaForApproval(savedIdea);
        } catch (e) {
            console.error('Failed to send idea for Telegram approval:', e.message);
        }
    }

    res.status(201).json(savedIdea);
});

router.put('/:id', async (req, res) => {
    const existingRes = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [req.params.id] });
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'idea not found' });

    const b = req.body || {};
    const merged = {
        id: existing.id,
        title: b.title !== undefined ? String(b.title).trim() : existing.title,
        desc: b.desc !== undefined ? b.desc : existing.desc,
        format: b.format !== undefined ? b.format : existing.format,
        funnel: b.funnel !== undefined ? b.funnel : existing.funnel,
        status: b.status !== undefined ? b.status : existing.status,
        cta: b.cta !== undefined ? b.cta : existing.cta,
        target_groups: b.targetGroups !== undefined ? JSON.stringify(b.targetGroups) : existing.target_groups,
        metrics_views: b.metrics?.views !== undefined ? b.metrics.views : existing.metrics_views,
        metrics_saves: b.metrics?.saves !== undefined ? b.metrics.saves : existing.metrics_saves,
        metrics_clicks: b.metrics?.clicks !== undefined ? b.metrics.clicks : existing.metrics_clicks,
        metrics_leads: b.metrics?.leads !== undefined ? b.metrics.leads : existing.metrics_leads,
        source: b.source !== undefined ? b.source : existing.source,
        agent_meta: b.agentMeta !== undefined ? (b.agentMeta ? JSON.stringify(b.agentMeta) : null) : existing.agent_meta,
        draft_text: b.draftText !== undefined ? (b.draftText ? JSON.stringify(b.draftText) : null) : existing.draft_text,
        content_type: b.contentType !== undefined ? b.contentType : existing.content_type,
        expires_at: b.expiresAt !== undefined ? b.expiresAt : existing.expires_at,
        rubric_id: b.rubricId !== undefined ? b.rubricId : existing.rubric_id,
        quality_flags: b.qualityFlags !== undefined ? JSON.stringify(b.qualityFlags) : existing.quality_flags,
        cover_asset_id: b.coverAssetId !== undefined ? b.coverAssetId : existing.cover_asset_id,
        title_en: b.titleEn !== undefined ? b.titleEn : existing.title_en,
        desc_en: b.descEn !== undefined ? b.descEn : existing.desc_en,
        cta_en: b.ctaEn !== undefined ? b.ctaEn : existing.cta_en,
    };
    await db.execute({ sql: upsertSql, args: upsertArgs(merged) });
    const result = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [existing.id] });
    res.json(serialize(result.rows[0]));
});

// "Перевести на английский" - Russian stays the source of truth, this just
// (re)generates the EN mirror from the current RU title/desc/cta.
router.post('/:id/translate', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'idea not found' });

    try {
        const { titleEn, descEn, ctaEn } = await translateToEnglish({ title: row.title, desc: row.desc, cta: row.cta });
        await db.execute({
            sql: 'UPDATE ideas SET title_en = ?, desc_en = ?, cta_en = ? WHERE id = ?',
            args: [titleEn, descEn, ctaEn, row.id],
        });
        const result = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [row.id] });
        res.json(serialize(result.rows[0]));
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    // Must run before the idea delete: once the idea row is gone, the FK's
    // ON DELETE SET NULL fires immediately and sets idea_id to NULL on these
    // rows, so a delete-by-idea_id issued afterwards would match nothing and
    // silently leave the events behind.
    await db.execute({ sql: 'DELETE FROM scheduled_events WHERE idea_id = ?', args: [req.params.id] });
    const del = await db.execute({ sql: 'DELETE FROM ideas WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'idea not found' });
    res.status(204).end();
});

// Bulk replace, used by JSON import
router.post('/import', async (req, res) => {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'expected an array of ideas' });

    const tx = await db.transaction('write');
    try {
        // Only ideas are replaced - scheduled_events survive with idea_id set to
        // NULL via the FK's ON DELETE SET NULL, same as the old localStorage
        // import which never touched the calendar.
        await tx.execute('DELETE FROM ideas');
        for (const item of items) {
            if (!item.title) continue;
            await tx.execute({
                sql: upsertSql,
                args: upsertArgs({
                    id: item.id != null ? String(item.id) : String(Date.now() + Math.random()),
                    title: item.title,
                    desc: item.desc || '',
                    format: item.format || 'TG Пост',
                    funnel: item.funnel || 'TOFU',
                    status: item.status || 'idea',
                    cta: item.cta || '',
                    target_groups: JSON.stringify(item.targetGroups || []),
                    metrics_views: item.metrics?.views || 0,
                    metrics_saves: item.metrics?.saves || 0,
                    metrics_clicks: item.metrics?.clicks || 0,
                    metrics_leads: item.metrics?.leads || 0,
                    // Imported JSON files are always human-curated exports, never agent drafts.
                    source: 'manual', agent_meta: null, draft_text: null,
                    content_type: item.contentType || 'evergreen', expires_at: null,
                    rubric_id: null, quality_flags: '[]', cover_asset_id: null,
                    title_en: item.titleEn || null, desc_en: item.descEn || null, cta_en: item.ctaEn || null,
                }),
            });
        }
        await tx.commit();
    } catch (e) {
        await tx.rollback();
        throw e;
    }
    const result = await db.execute('SELECT * FROM ideas ORDER BY created_at DESC');
    res.json(result.rows.map(serialize));
});

export default router;
