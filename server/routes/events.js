import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// A row here is one idea's publication on one platform ("scheduled_events" is
// the original calendar-slot name; conceptually it's now a per-platform
// publication - see the Phase 1 planning notes in server/db.js).
function serialize(row) {
    return {
        id: row.id,
        ideaId: row.idea_id,
        title: row.title,
        dateStr: row.date_str,
        rawDate: row.raw_date,
        color: row.color,
        format: row.format,
        cta: row.cta,
        desc: row.desc,
        platform: row.platform || 'telegram',
        externalPostId: row.external_post_id || null,
        metrics: {
            views: row.metrics_views || 0,
            saves: row.metrics_saves || 0,
            clicks: row.metrics_clicks || 0,
        },
        metricsSyncedAt: row.metrics_synced_at || null,
        utmCode: row.utm_code || null,
        publishAt: row.publish_at || null,
        channelId: row.channel_id || null,
        boardId: row.board_id || null,
        lang: row.lang || 'ru',
        publishStatus: row.publish_status || 'pending',
        publishError: row.publish_error || null,
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM scheduled_events ORDER BY raw_date ASC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.rawDate || !b.title) return res.status(400).json({ error: 'rawDate and title are required' });

    const id = Date.now();
    const platform = b.platform || 'telegram';
    // Auto-generated so every publication is traceable back from a lead:
    // the landing page/lead-bot echoes this code back on conversion.
    const utmCode = `${b.ideaId ? `idea${b.ideaId}` : `pub${id}`}_${platform}`;
    await db.execute({
        sql: `
            INSERT INTO scheduled_events (id, idea_id, title, date_str, raw_date, color, format, cta, desc, platform, external_post_id, utm_code, publish_at, channel_id, board_id, lang, publish_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [id, b.ideaId ?? null, b.title, b.dateStr || '', b.rawDate,
            b.color || '#0a84ff', b.format || 'TG Пост', b.cta || '', b.desc || '',
            platform, b.externalPostId || null, utmCode,
            b.publishAt || null, b.channelId || null, b.boardId || null, b.lang || 'ru',
            b.publishAt ? 'pending' : null],
    });
    const result = await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

// Resets a failed auto-publish back to pending so the scheduler picks it up
// again on its next tick - the scheduler itself never retries on its own.
router.post('/:id/retry', async (req, res) => {
    const existing = (await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!existing) return res.status(404).json({ error: 'event not found' });
    if (!existing.publish_at) return res.status(400).json({ error: 'у этой записи нет времени автопубликации' });

    await db.execute({
        sql: `UPDATE scheduled_events SET publish_status = 'pending', publish_error = NULL WHERE id = ?`,
        args: [req.params.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [req.params.id] });
    res.json(serialize(result.rows[0]));
});

// Used by the future metrics-sync job to write back per-platform view/save/click
// counts, and to record the platform's own post id once published there.
router.put('/:id', async (req, res) => {
    const existingRes = await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [req.params.id] });
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'event not found' });

    const b = req.body || {};
    const metrics_views = b.metrics?.views !== undefined ? b.metrics.views : existing.metrics_views;
    const metrics_saves = b.metrics?.saves !== undefined ? b.metrics.saves : existing.metrics_saves;
    const metrics_clicks = b.metrics?.clicks !== undefined ? b.metrics.clicks : existing.metrics_clicks;
    const external_post_id = b.externalPostId !== undefined ? b.externalPostId : existing.external_post_id;
    const touchedMetricsOrPostId = b.metrics !== undefined || b.externalPostId !== undefined;
    const metrics_synced_at = touchedMetricsOrPostId ? Math.floor(Date.now() / 1000) : existing.metrics_synced_at;

    await db.execute({
        sql: `UPDATE scheduled_events SET metrics_views = ?, metrics_saves = ?, metrics_clicks = ?, external_post_id = ?, metrics_synced_at = ? WHERE id = ?`,
        args: [metrics_views, metrics_saves, metrics_clicks, external_post_id, metrics_synced_at, req.params.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [req.params.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM scheduled_events WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
});

export default router;
