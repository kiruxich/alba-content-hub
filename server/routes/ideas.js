import { Router } from 'express';
import { db } from '../db.js';

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
        targetGroups: JSON.parse(row.target_groups || '[]'),
        metrics: {
            views: row.metrics_views,
            saves: row.metrics_saves,
            clicks: row.metrics_clicks,
            leads: row.metrics_leads,
        },
    };
}

const upsertSql = `
    INSERT INTO ideas (id, title, desc, format, funnel, status, cta, target_groups, metrics_views, metrics_saves, metrics_clicks, metrics_leads)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, desc = excluded.desc, format = excluded.format,
        funnel = excluded.funnel, status = excluded.status, cta = excluded.cta,
        target_groups = excluded.target_groups,
        metrics_views = excluded.metrics_views, metrics_saves = excluded.metrics_saves,
        metrics_clicks = excluded.metrics_clicks, metrics_leads = excluded.metrics_leads
`;

function upsertArgs(row) {
    return [row.id, row.title, row.desc, row.format, row.funnel, row.status, row.cta,
        row.target_groups, row.metrics_views, row.metrics_saves, row.metrics_clicks, row.metrics_leads];
}

// GET /api/ideas?q=search+term  -- indexed LIKE scan over title/desc
router.get('/', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) {
        const result = await db.execute('SELECT * FROM ideas ORDER BY created_at DESC');
        return res.json(result.rows.map(serialize));
    }
    const like = `%${q}%`;
    const result = await db.execute({
        sql: 'SELECT * FROM ideas WHERE title LIKE ? OR desc LIKE ? OR format LIKE ? OR funnel LIKE ? ORDER BY created_at DESC',
        args: [like, like, like, like],
    });
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) {
        return res.status(400).json({ error: 'title is required' });
    }
    const id = String(Date.now());
    await db.execute({
        sql: upsertSql,
        args: upsertArgs({
            id,
            title: b.title.trim(),
            desc: b.desc || '',
            format: b.format || 'TG Пост',
            funnel: b.funnel || 'TOFU',
            status: b.status || 'idea',
            cta: b.cta || '',
            target_groups: JSON.stringify(b.targetGroups || []),
            metrics_views: 0, metrics_saves: 0, metrics_clicks: 0, metrics_leads: 0,
        }),
    });
    const result = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
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
    };
    await db.execute({ sql: upsertSql, args: upsertArgs(merged) });
    const result = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [existing.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM ideas WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM scheduled_events WHERE idea_id = ?', args: [req.params.id] });
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
