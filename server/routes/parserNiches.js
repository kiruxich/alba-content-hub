import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import crypto from 'crypto';
import { db } from '../db.js';
import { generateParserQueries } from '../lib/generateParserQueries.js';
import { createParserJob, getParserJob, cancelParserJob, dedupeParserJob, archiveParserJob, fetchParserFile } from '../lib/parserWorkerClient.js';
import { isObjectStorageConfigured, uploadBuffer, publicUrlForKey } from '../lib/objectStorage.js';

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

// Durable archival of niche files into S3-compatible object storage - the
// only place any of raw/dedup/archive survive a re-run (which nulls the DB
// columns, see /:id/run below) or the parser-worker cleaning up an old
// job_id's files. Entirely best-effort: every function here swallows its own
// errors and is a silent no-op when isObjectStorageConfigured() is false, so
// archival can never block or break the upload/run/status flows it hooks
// into - identical in spirit to rehostIfConfigured() in mediaAssets.js.
async function archiveFileVersion(nicheId, kind, buffer, contentType, originalFilename) {
    if (!isObjectStorageConfigured()) return;
    try {
        const { key } = await uploadBuffer(buffer, { contentType, keyPrefix: `parser-niches/${nicheId}` });
        await db.execute({
            sql: `INSERT INTO parser_niche_file_versions (id, niche_id, kind, s3_key, original_filename) VALUES (?, ?, ?, ?, ?)`,
            args: [crypto.randomUUID(), nicheId, kind, key, originalFilename || null],
        });
    } catch (e) {
        console.error(`parserNiches: failed to archive ${kind} file for niche ${nicheId} to object storage:`, e.message);
    }
}

// Worker-produced dedup/archive (and worker-scraped raw) files only exist on
// parser-worker's disk, keyed by job_id - fetches the bytes once via the
// same fetchParserFile() the download route uses, then archives them.
async function archiveWorkerFile(nicheId, jobId, kind, fallbackFilename) {
    try {
        const workerRes = await fetchParserFile(jobId, kind);
        const contentType = workerRes.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await workerRes.arrayBuffer());
        await archiveFileVersion(nicheId, kind, buf, contentType, fallbackFilename);
    } catch (e) {
        console.error(`parserNiches: failed to fetch ${kind} file from worker for archival (niche ${nicheId}):`, e.message);
    }
}

// Call this with a niche row *before* any UPDATE that would null or replace
// raw_file/dedup_file/archive_file/raw_upload_data (a re-run, a fresh
// upload) - archives whatever's currently on the row so the impending
// overwrite never permanently loses it. Must be called before row.job_id is
// itself replaced by a new job, since dedup/archive bytes only exist on the
// worker under the job_id that produced them. No-op (no worker round-trips
// either) when object storage isn't configured.
async function archiveExistingNicheFiles(row) {
    if (!isObjectStorageConfigured()) return;
    // Uploaded raw lives locally as base64 - archive directly, no worker round-trip.
    if (row.raw_upload_data) {
        await archiveFileVersion(
            row.id, 'raw',
            Buffer.from(row.raw_upload_data, 'base64'),
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            row.raw_upload_name || 'raw.xlsx',
        );
    }
    if (row.job_id) {
        for (const kind of ['raw', 'dedup', 'archive']) {
            if (kind === 'raw' && row.raw_upload_data) continue; // already handled above
            if (!row[`${kind}_file`]) continue;
            await archiveWorkerFile(row.id, row.job_id, kind, row[`${kind}_file`]);
        }
    }
}

// Called from the status-poll route: compares the row as it was *before*
// this poll against the worker's fresh job.files flags, and archives any
// kind that just transitioned from unavailable to available - this is what
// protects a scrape's raw/dedup/archive output from disappearing once
// job_id changes on the next run or parser-worker cleans up the job dir,
// since otherwise those bytes are never durably saved anywhere in this app.
async function archiveNewlyAvailableFiles(row, job) {
    if (!isObjectStorageConfigured() || !row.job_id || !job?.files) return;
    for (const kind of ['raw', 'dedup', 'archive']) {
        if (job.files[kind] && !row[`${kind}_file`]) {
            const filename = kind === 'archive' ? 'archive.zip' : `${kind}.xlsx`;
            await archiveWorkerFile(row.id, row.job_id, kind, filename);
        }
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

        // Archive whatever raw/dedup/archive this row currently holds before
        // the UPDATE below nulls all of it - row.job_id here is still the
        // *old* job, which is required for fetching worker-produced files.
        try { await archiveExistingNicheFiles(row); } catch (e) { console.error('parserNiches: archival before run failed:', e.message); }

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

        // Archive any raw/dedup/archive file that just became available on
        // this poll, before it's ever at risk of being lost to a re-run or
        // the worker cleaning up this job_id's directory later.
        try { await archiveNewlyAvailableFiles(row, job); } catch (e) { console.error('parserNiches: archival on status transition failed:', e.message); }

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

    // Archive whatever this row currently has (a previous upload, or
    // worker-produced dedup/archive from an earlier scrape) before the
    // UPDATE below overwrites/clears it.
    try { await archiveExistingNicheFiles(row); } catch (e) { console.error('parserNiches: archival before upload failed:', e.message); }
    // Also archive this brand-new upload itself right away, rather than
    // relying only on some future overwrite to trigger the archival above.
    await archiveFileVersion(row.id, 'raw', outBuf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalName);

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

// History of durably-archived files for this niche (most recent first) -
// populates the "История версий" list in the card. Doesn't expose s3_key
// directly; use the download route below to fetch a version's bytes.
router.get('/:id/versions', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT id FROM parser_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'niche not found' });
    const result = await db.execute({
        sql: `SELECT id, kind, original_filename, created_at FROM parser_niche_file_versions
              WHERE niche_id = ? ORDER BY created_at DESC, id DESC`,
        args: [req.params.id],
    });
    res.json(result.rows.map(r => ({
        id: r.id,
        kind: r.kind,
        filename: r.original_filename || '',
        createdAt: r.created_at,
    })));
});

// Streams a specific archived version's bytes straight from object storage -
// same proxy-download shape as /:id/download/:kind above, just sourced from
// S3 instead of parser-worker.
router.get('/:id/versions/:versionId/download', async (req, res) => {
    const version = (await db.execute({
        sql: 'SELECT * FROM parser_niche_file_versions WHERE id = ? AND niche_id = ?',
        args: [req.params.versionId, req.params.id],
    })).rows[0];
    if (!version) return res.status(404).send('not found');
    if (!isObjectStorageConfigured()) return res.status(503).send('Object storage is not configured');
    try {
        const s3Res = await fetch(publicUrlForKey(version.s3_key));
        if (!s3Res.ok) throw new Error(`${s3Res.status} ${s3Res.statusText}`);
        const filename = (version.original_filename || `${version.kind}.bin`).replace(/"/g, '');
        res.setHeader('Content-Type', s3Res.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        const buf = Buffer.from(await s3Res.arrayBuffer());
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
