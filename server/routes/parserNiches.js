import { Router } from 'express';
import { db } from '../db.js';
import { generateParserQueries } from '../lib/generateParserQueries.js';
import { createParserJob, getParserJob, cancelParserJob, dedupeParserJob, archiveParserJob, fetchParserFile } from '../lib/parserWorkerClient.js';

const router = Router();
const WORKER_TOKEN = process.env.PARSER_WORKER_TOKEN || '';

function serialize(row) {
    return {
        id: row.id,
        category: row.category,
        description: row.description || '',
        status: row.status,
        log: row.log || '',
        stats: row.stats_json ? JSON.parse(row.stats_json) : null,
        files: {
            raw: Boolean(row.raw_file),
            dedup: Boolean(row.dedup_file),
            archive: Boolean(row.archive_file),
        },
        jobId: row.job_id,
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM parser_niches ORDER BY created_at ASC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const { category, description } = req.body || {};
    if (!category || !category.trim()) return res.status(400).json({ error: 'category is required' });
    const id = String(Date.now());
    await db.execute({
        sql: 'INSERT INTO parser_niches (id, category, description, status) VALUES (?, ?, ?, ?)',
        args: [id, category.trim(), description || '', 'idle'],
    });
    const result = await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [id] });
    res.json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });
    const { category, description } = req.body || {};
    await db.execute({
        sql: `UPDATE parser_niches SET category = ?, description = ?, updated_at = strftime('%s','now') WHERE id = ?`,
        args: [category !== undefined ? category : row.category, description !== undefined ? (description || '') : row.description, row.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT job_id FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (row?.job_id) {
        // Best-effort - the niche row (the only place job_id lived) is about to
        // be gone, so this is the last chance to stop an active scrape instead
        // of leaving it running on the VPS with nothing left to cancel it.
        try { await cancelParserJob(row.job_id); } catch (_) {}
    }
    await db.execute({ sql: 'DELETE FROM parser_niches WHERE id = ?', args: [req.params.id] });
    res.status(204).end();
});

// "Обновить парсер" - (re)generate the query list for this niche and kick
// off a fresh scrape job on the worker.
router.post('/:id/run', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });

    try {
        const queries = await generateParserQueries(row.category, row.description);
        const job = await createParserJob({ nicheId: row.id, category: row.category, description: row.description, queries });

        await db.execute({
            sql: `UPDATE parser_niches SET status = 'queued', queries_json = ?, job_id = ?, log = '', stats_json = NULL,
                  raw_file = NULL, dedup_file = NULL, archive_file = NULL, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [JSON.stringify(queries), job.job_id, row.id],
        });
        const result = await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [row.id] });
        res.json(serialize(result.rows[0]));
    } catch (e) {
        res.status(502).json({ error: `Не удалось запустить парсер: ${e.message}` });
    }
});

// Polled by the frontend while a job is queued/running/captcha to refresh
// status, log tail and stats from the worker.
router.get('/:id/status', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });
    if (!row.job_id) return res.json(serialize(row));

    try {
        const job = await getParserJob(row.job_id);
        await db.execute({
            sql: `UPDATE parser_niches SET status = ?, log = ?, stats_json = ?,
                  raw_file = ?, dedup_file = ?, archive_file = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [
                job.status, job.log, JSON.stringify(job.stats),
                job.files.raw ? 'raw.xlsx' : null,
                job.files.dedup ? 'dedup.xlsx' : null,
                job.files.archive ? 'archive.zip' : null,
                row.id,
            ],
        });
        const result = await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [row.id] });
        res.json(serialize(result.rows[0]));
    } catch (e) {
        res.json(serialize(row));
    }
});

router.post('/:id/cancel', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row || !row.job_id) return res.status(404).json({ error: 'no job for this niche yet' });
    try {
        await cancelParserJob(row.job_id);
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

const ACTIVE_STATUSES = ['queued', 'running', 'captcha', 'dedupe_running'];

router.post('/:id/dedupe', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row || !row.job_id) return res.status(404).json({ error: 'no job for this niche yet' });
    if (ACTIVE_STATUSES.includes(row.status)) {
        return res.status(409).json({ error: 'Парсинг ещё идёт — дождитесь завершения перед чисткой дублей' });
    }
    try {
        await dedupeParserJob(row.job_id);
        await db.execute({ sql: `UPDATE parser_niches SET status = 'dedupe_running' WHERE id = ?`, args: [row.id] });
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

router.post('/:id/archive', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row || !row.job_id) return res.status(404).json({ error: 'no job for this niche yet' });
    if (ACTIVE_STATUSES.includes(row.status)) {
        return res.status(409).json({ error: 'Парсинг ещё идёт — дождитесь завершения перед архивацией' });
    }
    try {
        await archiveParserJob(row.job_id);
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

router.get('/:id/download/:kind', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row || !row.job_id) return res.status(404).send('not found');
    try {
        const workerRes = await fetchParserFile(row.job_id, req.params.kind);
        res.setHeader('Content-Type', workerRes.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', workerRes.headers.get('content-disposition') || 'attachment');
        const buf = Buffer.from(await workerRes.arrayBuffer());
        res.send(buf);
    } catch (e) {
        res.status(502).send('Не удалось скачать файл: ' + e.message);
    }
});

// Called by the parser-worker (not the browser) when it hits a CAPTCHA -
// forwards the noVNC link to the existing Telegram bot.
router.post('/:id/captcha-alert', async (req, res) => {
    // Unlike other routes, this one is unconditional: unlike PARSER_WORKER_URL
    // being unset (which just breaks outbound calls loudly), an unset
    // PARSER_WORKER_TOKEN here would silently let anyone on the internet get
    // an arbitrary link relayed into the studio's Telegram bot as a trusted
    // message - so a missing token means "reject", not "skip the check".
    if (!WORKER_TOKEN || req.headers['x-worker-token'] !== WORKER_TOKEN) {
        return res.status(401).json({ error: 'bad worker token' });
    }
    const { novncUrl, category } = req.body || {};

    const settingsRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (settings?.token && settings?.chat_id) {
        const text = `🤖 Парсер 2ГИС встретил капчу на нише «${category}».\nРешите её вручную здесь: ${novncUrl}`;
        try {
            await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: settings.chat_id, text }),
            });
        } catch (e) {
            console.error('captcha-alert: failed to notify Telegram:', e.message);
        }
    }
    res.json({ ok: true });
});

export default router;
