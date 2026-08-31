import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { db } from '../db.js';
import { generateParserQueries } from '../lib/generateParserQueries.js';
import { createParserJob, getParserJob, cancelParserJob, dedupeParserJob, archiveParserJob, fetchParserFile } from '../lib/parserWorkerClient.js';
import { isLocalClaudeAgentConfigured, generateNicheDescription } from '../lib/localClaudeAgent.js';

const router = Router();
const WORKER_TOKEN = process.env.PARSER_WORKER_TOKEN || '';

// Memory storage, not disk - Vercel's filesystem is read-only/ephemeral (see
// server/db.js), and the parsed workbook is small enough to hold as a buffer
// for the one trip through XLSX.read() before it's re-encoded into the DB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Shared by every Telegram notification this file sends (captcha alert, job
// done, job failed) - reads the bot token/chat set in Settings and swallows
// failures, same as agentResearcher.js's notifyTelegram: a broken/unset
// Telegram config should never fail the parent request.
async function notifyTelegram(text) {
    const settingsRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings?.token || !settings?.chat_id) return;
    try {
        await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.chat_id, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('parserNiches: failed to notify Telegram:', e.message);
    }
}

// job.stats' exact shape comes from the Python parser-worker (not part of
// this repo) and isn't documented anywhere in the hub codebase, so this
// checks the field names that would plausibly hold a result count instead of
// assuming one - falls back to null (omitted from the message) if none match.
function extractResultCount(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const candidates = ['total', 'count', 'results', 'found', 'companies', 'rows', 'total_found', 'unique_count', 'raw_count'];
    for (const key of candidates) {
        if (typeof stats[key] === 'number') return stats[key];
    }
    return null;
}

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

// "✨ Сгенерировать" next to the description field - writes a description via
// local-claude-agent (see server/lib/localClaudeAgent.js) from just the
// niche's category name. Returns the text for the user to review/edit before
// saving rather than writing it directly - PUT /:id is what actually persists it.
router.post('/:id/generate-description', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });
    if (!row.category || !row.category.trim()) return res.status(400).json({ error: 'Сначала укажите название ниши' });

    try {
        const result = await generateNicheDescription(row.category);
        res.json({ description: result.description });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
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
                  raw_file = NULL, dedup_file = NULL, archive_file = NULL,
                  raw_upload_data = NULL, raw_upload_name = NULL, updated_at = strftime('%s','now') WHERE id = ?`,
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
        // row.status is what this niche's status was *before* this poll -
        // compared against job.status (the worker's answer for *this* poll)
        // to detect a fresh transition into a terminal state. Once the DB
        // row itself reads 'done'/'error', the next poll's row.status ===
        // job.status and this is skipped, so the alert fires exactly once
        // per completion no matter how often the frontend polls afterward.
        if (row.status !== job.status && (job.status === 'done' || job.status === 'error')) {
            const count = extractResultCount(job.stats);
            if (job.status === 'done') {
                const foundLine = count !== null ? `Найдено записей: ${count}\n` : '';
                await notifyTelegram(`✅ *Парсер 2ГИС завершил нишу «${row.category}»*\n\n${foundLine}Подробности — в приложении.`);
            } else {
                const logTail = (job.log || '').trim().split('\n').filter(Boolean).slice(-1)[0];
                const errorLine = logTail ? `Последняя строка лога: ${logTail}\n` : '';
                await notifyTelegram(`❌ *Парсер 2ГИС завершился с ошибкой на нише «${row.category}»*\n\n${errorLine}Подробности — в приложении.`);
            }
        }

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

// "Загрузить Excel" - alternative to running the live 2GIS scraper: accepts
// an already-prepared .xlsx of leads and stores it straight on the row, so
// the rest of the card (download, status badge) behaves as if a scrape had
// produced it. Dedupe/archive still require an actual worker job_id (they
// call out to parser-worker), so they stay unavailable for upload-only rows
// - see isActive/jobId gating in public/js/app.js.
router.post('/:id/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: 'Не удалось загрузить файл: ' + err.message });
        next();
    });
}, async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });
    if (ACTIVE_STATUSES.includes(row.status)) {
        return res.status(409).json({ error: 'Парсинг ещё идёт — дождитесь завершения перед загрузкой файла' });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });

    const originalName = req.file.originalname || 'raw.xlsx';
    if (!/\.xlsx$/i.test(originalName)) {
        return res.status(400).json({ error: 'Поддерживаются только файлы .xlsx' });
    }

    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
        return res.status(400).json({ error: 'Не удалось прочитать Excel-файл: ' + e.message });
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName && workbook.Sheets[sheetName];
    const rows = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) : [];
    if (!rows.length) {
        return res.status(400).json({ error: 'Файл пустой или не содержит строк с данными' });
    }

    // Rebuild a clean single-sheet workbook so the download endpoint always
    // hands back a consistent shape, whatever the original file's extra
    // sheets/formatting looked like.
    const cleanWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(cleanWb, XLSX.utils.json_to_sheet(rows), 'Leads');
    const outBuf = XLSX.write(cleanWb, { type: 'buffer', bookType: 'xlsx' });

    await db.execute({
        sql: `UPDATE parser_niches SET status = 'done', raw_file = 'raw.xlsx', dedup_file = NULL, archive_file = NULL,
              raw_upload_data = ?, raw_upload_name = ?, log = ?, updated_at = strftime('%s','now') WHERE id = ?`,
        args: [
            outBuf.toString('base64'),
            originalName,
            `Загружен файл «${originalName}» — ${rows.length} строк.`,
            row.id,
        ],
    });
    const result = await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

router.get('/:id/download/:kind', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).send('not found');

    // Uploaded raw data lives right on the row (no worker job backs it) -
    // serve it directly instead of going through fetchParserFile below.
    if (req.params.kind === 'raw' && row.raw_upload_data) {
        const buf = Buffer.from(row.raw_upload_data, 'base64');
        const filename = (row.raw_upload_name || 'raw.xlsx').replace(/"/g, '');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(buf);
    }

    if (!row.job_id) return res.status(404).send('not found');
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
    await notifyTelegram(`🤖 *Парсер 2ГИС встретил капчу на нише «${category}»*\n\nРешите её вручную здесь: ${novncUrl}`);
    res.json({ ok: true });
});

export default router;
