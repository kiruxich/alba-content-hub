import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { isKieConfigured, generateImage, generateVideo } from '../lib/kieClient.js';
import { generateVoiceover, isElevenLabsConfigured } from '../lib/elevenLabsClient.js';
import { generatePiperVoiceover, isPiperConfigured } from '../lib/piperTtsClient.js';
import { isObjectStorageConfigured, uploadBuffer, uploadFromUrl } from '../lib/objectStorage.js';

const router = Router();

// Memory storage, not disk - same reasoning as parserNiches.js's upload
// endpoint: the file only needs to live as a buffer long enough to hand off
// to objectStorage.uploadBuffer(), and Vercel's filesystem is read-only/
// ephemeral anyway.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Agent identity used for kie.ai-driven spend rows in agent_expenses -
// distinguishes AI-generated-cover spend from Researcher/Generator LLM
// token spend, which use their own agent_name values.
const KIE_AGENT_NAME = 'generator';

// kie.ai's returned URLs point at its own temp storage
// (tempfile.aiquickdraw.com as of writing) which is NOT permanent - if
// object storage is configured, download the result and re-upload it so the
// media_assets row keeps working after the temp link expires. Best-effort:
// a failure here (network hiccup downloading from kie.ai, bucket unreachable,
// etc.) falls back to the original kie.ai URL rather than failing a
// generation that otherwise succeeded - kie.ai credits were already spent by
// this point, so surfacing an error to the user would be worse than serving
// a link that works today but may expire later.
async function rehostIfConfigured(kieUrl, keyPrefix) {
    if (!isObjectStorageConfigured()) return kieUrl;
    try {
        const { url } = await uploadFromUrl(kieUrl, { keyPrefix });
        return url;
    } catch (e) {
        console.error(`rehostIfConfigured: failed to re-upload ${kieUrl} to object storage, falling back to kie.ai URL:`, e.message);
        return kieUrl;
    }
}

async function insertGeneratedAsset({ url, type, productId, modelUsed, creditsConsumed, folder }) {
    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source, folder)
              VALUES (?, ?, ?, ?, NULL, '[]', 'ai_generated', ?)`,
        args: [id, url, type, productId || null, folder || null],
    });
    // Cost is only logged once generation has already succeeded (the asset
    // row above is inserted first) - a failed/timed-out generation never
    // reaches this point, so agent_expenses only ever reflects confirmed spend.
    await db.execute({
        sql: `INSERT INTO agent_expenses (agent_name, model_used, kie_credits_spent) VALUES (?, ?, ?)`,
        args: [KIE_AGENT_NAME, modelUsed, creditsConsumed || 0],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
    return result.rows[0];
}

function serialize(row) {
    return {
        id: row.id,
        url: row.url,
        type: row.type,
        transcript: row.transcript || null,
        productId: row.product_id || null,
        rubricId: row.rubric_id || null,
        tags: JSON.parse(row.tags || '[]'),
        source: row.source || 'manual',
        usedCount: row.used_count || 0,
        createdAt: row.created_at,
        folder: row.folder || null,
        hidden: Boolean(row.hidden),
    };
}

// GET /api/media-assets?product_id=insights&type=image&folder=...&includeHidden=1
// Hidden by default excludes voiceovers generated post-approval (see
// generate-voiceover below) - those exist only to back an idea's
// voiceoverAssetId, not to be browsed/reused, so they'd just be noise here.
router.get('/', async (req, res) => {
    const productId = (req.query.product_id || '').trim();
    const type = (req.query.type || '').trim();
    const folder = req.query.folder !== undefined ? String(req.query.folder).trim() : undefined;
    const includeHidden = req.query.includeHidden === '1';

    const clauses = [];
    const args = [];
    if (productId) {
        clauses.push('product_id = ?');
        args.push(productId);
    }
    if (type) {
        clauses.push('type = ?');
        args.push(type);
    }
    if (folder !== undefined) {
        if (folder === '') {
            clauses.push('(folder IS NULL OR folder = \'\')');
        } else {
            clauses.push('folder = ?');
            args.push(folder);
        }
    }
    if (!includeHidden) {
        clauses.push('(hidden IS NULL OR hidden = 0)');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.execute({
        sql: `SELECT * FROM media_assets ${where} ORDER BY created_at DESC`,
        args,
    });
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    const url = (b.url || '').trim();
    const type = (b.type || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!type) return res.status(400).json({ error: 'type is required' });

    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, transcript, product_id, rubric_id, tags, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            id, url, type,
            b.transcript ? String(b.transcript) : null,
            b.productId || null,
            b.rubricId || null,
            JSON.stringify(b.tags || []),
            b.source || 'manual',
        ],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'asset not found' });

    const b = req.body || {};
    const merged = {
        url: b.url !== undefined ? String(b.url).trim() : row.url,
        type: b.type !== undefined ? String(b.type).trim() : row.type,
        transcript: b.transcript !== undefined ? (b.transcript ? String(b.transcript) : null) : row.transcript,
        product_id: b.productId !== undefined ? (b.productId || null) : row.product_id,
        rubric_id: b.rubricId !== undefined ? (b.rubricId || null) : row.rubric_id,
        tags: b.tags !== undefined ? JSON.stringify(b.tags || []) : row.tags,
    };
    await db.execute({
        sql: `UPDATE media_assets SET url = ?, type = ?, transcript = ?, product_id = ?, rubric_id = ?, tags = ? WHERE id = ?`,
        args: [merged.url, merged.type, merged.transcript, merged.product_id, merged.rubric_id, merged.tags, row.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM media_assets WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'asset not found' });
    res.status(204).end();
});

// Called whenever an idea's cover gets set to this asset (or any other future
// "this asset got used somewhere" event) - just an incrementing counter, no
// per-usage log.
router.post('/:id/use', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'asset not found' });
    await db.execute({ sql: 'UPDATE media_assets SET used_count = used_count + 1 WHERE id = ?', args: [row.id] });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

// POST /api/media-assets/generate-cover - AI-generate an image cover via
// kie.ai's Flux model and store it as a new media_assets row. Gated behind
// KIE_API_KEY: with no key set, this returns 503 with a Russian message the
// UI surfaces directly (see kieClient.js's isKieConfigured()).
router.post('/generate-cover', async (req, res) => {
    if (!isKieConfigured()) {
        return res.status(503).json({ error: 'kie.ai не настроен — добавьте KIE_API_KEY в переменные окружения' });
    }
    const b = req.body || {};
    const prompt = (b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const { url: kieUrl, creditsConsumed } = await generateImage(prompt);
        const url = await rehostIfConfigured(kieUrl, 'covers');
        const row = await insertGeneratedAsset({
            url,
            type: 'image',
            productId: b.productId,
            modelUsed: 'flux-2/pro-text-to-image',
            creditsConsumed,
            folder: b.folder,
        });
        res.status(201).json(serialize(row));
    } catch (e) {
        console.error('generate-cover: kie.ai request failed:', e.message);
        res.status(502).json({ error: `Не удалось сгенерировать изображение через kie.ai: ${e.message}` });
    }
});

// POST /api/media-assets/generate-video - same idea, but a short video cover
// via kie.ai's Kling model. Generation takes noticeably longer than an image
// (kieClient.js gives it a longer poll timeout).
router.post('/generate-video', async (req, res) => {
    if (!isKieConfigured()) {
        return res.status(503).json({ error: 'kie.ai не настроен — добавьте KIE_API_KEY в переменные окружения' });
    }
    const b = req.body || {};
    const prompt = (b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
        const { url: kieUrl, creditsConsumed } = await generateVideo(prompt);
        const url = await rehostIfConfigured(kieUrl, 'covers');
        const row = await insertGeneratedAsset({
            url,
            type: 'video',
            productId: b.productId,
            modelUsed: 'kling-2.6/text-to-video',
            creditsConsumed,
            folder: b.folder,
        });
        res.status(201).json(serialize(row));
    } catch (e) {
        console.error('generate-video: kie.ai request failed:', e.message);
        res.status(502).json({ error: `Не удалось сгенерировать видео через kie.ai: ${e.message}` });
    }
});

// POST /api/media-assets/generate-voiceover { text, provider?, voiceId?, productId?, rubricId?, tags? }
// Generates a voice-over from `text` via either ElevenLabs (paid, gated
// behind ELEVENLABS_API_KEY - server/lib/elevenLabsClient.js) or Piper
// (free, self-hosted - server/lib/piperTtsClient.js). `provider` is
// 'elevenlabs' (default, for backwards compatibility with existing callers)
// or 'piper'. Stores the result as a new media_assets row (type='audio') and
// logs the spend into agent_expenses (0 for Piper) so it shows up in the
// Cost Tracker either way.
//
// STORAGE NOTE: if object storage is configured (server/lib/objectStorage.js
// - S3_* env vars), the generated audio is uploaded there and media_assets.url
// gets the real public URL. If it's NOT configured, this falls back to the
// original behavior: the audio is stored inline as a base64 `data:` URL in
// media_assets.url. That's fine for short Shorts voice-overs but bloats the
// row and isn't shareable outside this app - it's a deliberate fallback for
// deployments that haven't set up S3-compatible storage, not a bug.
router.post('/generate-voiceover', async (req, res) => {
    const b = req.body || {};
    const text = (b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Текст для озвучки не указан' });

    const provider = (b.provider || 'elevenlabs').trim();
    let voiceover;
    let modelUsed;

    if (provider === 'piper') {
        if (!isPiperConfigured()) {
            return res.status(400).json({ error: 'Piper не настроен: добавьте PIPER_WORKER_TOKEN в переменные окружения' });
        }
        try {
            voiceover = await generatePiperVoiceover({ text, voice: b.voiceId });
        } catch (e) {
            return res.status(502).json({ error: e.message });
        }
        modelUsed = 'piper:ru_RU-dmitri-medium';
    } else {
        if (!isElevenLabsConfigured()) {
            return res.status(400).json({ error: 'ElevenLabs не настроен: добавьте ELEVENLABS_API_KEY в переменные окружения' });
        }
        try {
            voiceover = await generateVoiceover({ text, voiceId: b.voiceId });
        } catch (e) {
            return res.status(502).json({ error: e.message });
        }
        modelUsed = 'elevenlabs:eleven_multilingual_v2';
    }

    let url;
    if (isObjectStorageConfigured()) {
        try {
            ({ url } = await uploadBuffer(voiceover.audioBuffer, { contentType: voiceover.contentType, keyPrefix: 'voiceovers' }));
        } catch (e) {
            console.error('generate-voiceover: object storage upload failed, falling back to base64 data URL:', e.message);
        }
    }
    if (!url) {
        url = `data:${voiceover.contentType};base64,${voiceover.audioBuffer.toString('base64')}`;
    }
    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, transcript, product_id, rubric_id, tags, source, hidden)
              VALUES (?, ?, 'audio', ?, ?, ?, ?, 'ai-generated', ?)`,
        args: [
            id, url, text,
            b.productId || null,
            b.rubricId || null,
            JSON.stringify(b.tags || []),
            b.hidden ? 1 : 0,
        ],
    });

    await db.execute({
        sql: `INSERT INTO agent_expenses (agent_name, model_used, total_usd)
              VALUES ('generator', ?, ?)`,
        args: [modelUsed, voiceover.estimatedCostUsd],
    });

    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

// POST /api/media-assets/upload - direct file upload as an alternative to
// pasting an already-hosted URL (multipart/form-data, field name 'file' -
// same multer/memoryStorage pattern as parserNiches.js's Excel upload).
// Gated behind object storage being configured: with no S3_* env vars set,
// there's nowhere to put the file (no local disk to keep it on either - see
// objectStorage.js/parserNiches.js's memoryStorage comments), so this
// returns a clear 503 instead of silently failing or hard-requiring S3 for
// the app to run. Server-driven like every other optional integration here
// - the "Загрузить файл" UI option stays visible regardless and just
// surfaces this message if clicked, rather than the frontend guessing
// whether S3 is set up.
router.post('/upload', (req, res, next) => {
    if (!isObjectStorageConfigured()) {
        return res.status(503).json({ error: 'Загрузка файлов недоступна — настройте S3-совместимое хранилище' });
    }
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: 'Не удалось загрузить файл: ' + err.message });
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });

    const b = req.body || {};
    const type = (b.type || '').trim();
    if (!type) return res.status(400).json({ error: 'type is required' });

    let tags = [];
    if (b.tags) {
        try { tags = JSON.parse(b.tags); } catch (_) { tags = []; }
        if (!Array.isArray(tags)) tags = [];
    }

    try {
        const { url } = await uploadBuffer(req.file.buffer, {
            contentType: req.file.mimetype,
            keyPrefix: 'manual',
        });
        const id = String(Date.now());
        await db.execute({
            sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
                  VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
            args: [
                id, url, type,
                b.productId || null,
                b.rubricId || null,
                JSON.stringify(tags),
            ],
        });
        const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
        res.status(201).json(serialize(result.rows[0]));
    } catch (e) {
        console.error('media-assets/upload: object storage upload failed:', e.message);
        res.status(502).json({ error: 'Не удалось загрузить файл в хранилище: ' + e.message });
    }
});

export default router;
