import { Router } from 'express';
import { db } from '../db.js';
import { createVideoJob, getVideoJob, cancelVideoJob, fetchVideoFile } from '../lib/videoWorkerClient.js';

const router = Router();

// Overridable in case the hub is ever reached through a different public
// hostname than the request it's currently serving (e.g. behind a proxy that
// doesn't forward Host correctly) - falls back to reflecting the incoming
// request's own host, which is correct for the normal Coolify-fronted setup.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function publicBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
    return `${req.protocol}://${req.get('host')}`;
}

function serialize(row) {
    return {
        jobId: row.id,
        status: row.status,
        log: row.log || '',
        error: row.error || null,
        videoUrl: row.video_url,
        audioUrl: row.audio_url,
        captionText: row.caption_text || '',
        assetId: row.asset_id || null,
        createdAt: row.created_at,
    };
}

async function resolveAssetUrl(assetId) {
    const row = (await db.execute({ sql: 'SELECT url FROM media_assets WHERE id = ?', args: [assetId] })).rows[0];
    return row ? row.url : null;
}

// Kicks off an assembly job. Accepts either already-hosted URLs directly
// (videoUrl/audioUrl) or ids into media_assets (videoAssetId/audioAssetId) -
// whichever the caller has on hand is fine, since it's not yet clear from
// this task alone whether upstream generation steps will hand back a raw URL
// or a media_assets row. Mixing is fine too (e.g. a direct videoUrl plus an
// audioAssetId).
router.post('/', async (req, res) => {
    const b = req.body || {};
    let videoUrl = (b.videoUrl || '').trim();
    let audioUrl = (b.audioUrl || '').trim();
    const captionText = b.captionText || '';
    const outputFormat = b.outputFormat || 'mp4';

    if (!videoUrl && b.videoAssetId) {
        videoUrl = await resolveAssetUrl(b.videoAssetId);
        if (!videoUrl) return res.status(404).json({ error: `video asset ${b.videoAssetId} not found` });
    }
    if (!audioUrl && b.audioAssetId) {
        audioUrl = await resolveAssetUrl(b.audioAssetId);
        if (!audioUrl) return res.status(404).json({ error: `audio asset ${b.audioAssetId} not found` });
    }
    if (!videoUrl || !audioUrl) {
        return res.status(400).json({ error: 'Provide videoUrl+audioUrl or videoAssetId+audioAssetId' });
    }

    try {
        const job = await createVideoJob({ videoUrl, audioUrl, captionText, outputFormat });
        await db.execute({
            sql: `INSERT INTO video_assembly_jobs (id, job_id, video_url, audio_url, caption_text, status)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [job.job_id, job.job_id, videoUrl, audioUrl, captionText, job.status || 'queued'],
        });
        const result = await db.execute({ sql: 'SELECT * FROM video_assembly_jobs WHERE id = ?', args: [job.job_id] });
        res.status(201).json(serialize(result.rows[0]));
    } catch (e) {
        res.status(502).json({ error: `Не удалось запустить сборку видео: ${e.message}` });
    }
});

// Polled by the frontend while a job is queued/running - refreshes status
// from the worker and, the first time it observes 'done', downloads the
// assembled file through the /file proxy below and saves it as a new
// media_assets row (type='video') so it slots into the same
// covers/media-picker flow as any other asset. asset_id on the row is the
// "already saved" guard so repeated polling after completion doesn't insert
// duplicates.
router.get('/:jobId', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM video_assembly_jobs WHERE id = ?', args: [req.params.jobId] })).rows[0];
    if (!row) return res.status(404).json({ error: 'job not found' });

    try {
        const job = await getVideoJob(row.job_id);
        let assetId = row.asset_id || null;

        if (job.status === 'done' && !assetId && job.files?.output) {
            const url = `${publicBaseUrl(req)}/api/video-assembly/${row.id}/file`;
            assetId = `${Date.now()}`;
            await db.execute({
                sql: `INSERT INTO media_assets (id, url, type, tags, source) VALUES (?, ?, 'video', '[]', 'video-worker')`,
                args: [assetId, url],
            });
        }

        await db.execute({
            sql: `UPDATE video_assembly_jobs SET status = ?, log = ?, error = ?, asset_id = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [job.status, job.log || '', job.error || null, assetId, row.id],
        });
        const result = await db.execute({ sql: 'SELECT * FROM video_assembly_jobs WHERE id = ?', args: [row.id] });
        res.json(serialize(result.rows[0]));
    } catch (e) {
        res.json(serialize(row));
    }
});

router.post('/:jobId/cancel', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM video_assembly_jobs WHERE id = ?', args: [req.params.jobId] })).rows[0];
    if (!row) return res.status(404).json({ error: 'job not found' });
    try {
        await cancelVideoJob(row.job_id);
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Streams the assembled file straight from video-worker - this is what the
// media_assets.url saved in GET /:jobId above actually points at, since
// video-worker itself only sits on the internal Docker bridge address, not a
// public one that Instagram/YouTube could fetch from directly.
router.get('/:jobId/file', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM video_assembly_jobs WHERE id = ?', args: [req.params.jobId] })).rows[0];
    if (!row) return res.status(404).send('not found');
    try {
        const workerRes = await fetchVideoFile(row.job_id);
        res.setHeader('Content-Type', workerRes.headers.get('content-type') || 'video/mp4');
        res.setHeader('Content-Disposition', workerRes.headers.get('content-disposition') || 'inline');
        const buf = Buffer.from(await workerRes.arrayBuffer());
        res.send(buf);
    } catch (e) {
        res.status(502).send('Не удалось скачать файл: ' + e.message);
    }
});

export default router;
