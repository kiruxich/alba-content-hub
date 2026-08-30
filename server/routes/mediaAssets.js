import { Router } from 'express';
import { db } from '../db.js';
import { isKieConfigured, generateImage, generateVideo } from '../lib/kieClient.js';
import { generateVoiceover, isElevenLabsConfigured } from '../lib/elevenLabsClient.js';
import { generatePiperVoiceover, isPiperConfigured } from '../lib/piperTtsClient.js';

const router = Router();

// Agent identity used for kie.ai-driven spend rows in agent_expenses -
// distinguishes AI-generated-cover spend from Researcher/Generator LLM
// token spend, which use their own agent_name values.
const KIE_AGENT_NAME = 'generator';

async function insertGeneratedAsset({ url, type, productId, modelUsed, creditsConsumed }) {
    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
              VALUES (?, ?, ?, ?, NULL, '[]', 'ai_generated')`,
        args: [id, url, type, productId || null],
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
        productId: row.product_id || null,
        rubricId: row.rubric_id || null,
        tags: JSON.parse(row.tags || '[]'),
        source: row.source || 'manual',
        usedCount: row.used_count || 0,
        createdAt: row.created_at,
    };
}

// GET /api/media-assets?product_id=insights&type=image
router.get('/', async (req, res) => {
    const productId = (req.query.product_id || '').trim();
    const type = (req.query.type || '').trim();

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
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
            id, url, type,
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
        product_id: b.productId !== undefined ? (b.productId || null) : row.product_id,
        rubric_id: b.rubricId !== undefined ? (b.rubricId || null) : row.rubric_id,
        tags: b.tags !== undefined ? JSON.stringify(b.tags || []) : row.tags,
    };
    await db.execute({
        sql: `UPDATE media_assets SET url = ?, type = ?, product_id = ?, rubric_id = ?, tags = ? WHERE id = ?`,
        args: [merged.url, merged.type, merged.product_id, merged.rubric_id, merged.tags, row.id],
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
        const { url, creditsConsumed } = await generateImage(prompt);
        const row = await insertGeneratedAsset({
            url,
            type: 'image',
            productId: b.productId,
            modelUsed: 'flux-2/pro-text-to-image',
            creditsConsumed,
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
        const { url, creditsConsumed } = await generateVideo(prompt);
        const row = await insertGeneratedAsset({
            url,
            type: 'video',
            productId: b.productId,
            modelUsed: 'kling-2.6/text-to-video',
            creditsConsumed,
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
// STORAGE NOTE: this project has no S3/object-storage client yet - the
// Медиатека today only catalogs externally-hosted URLs (see its own
// placeholder text mentioning "S3 alba-creation.ru"), and Vercel's
// filesystem is read-only/ephemeral so a local static file wouldn't
// survive between invocations either (see server/routes/parserNiches.js's
// multer memoryStorage comment). Until real object storage exists, the
// generated audio is stored inline as a base64 `data:` URL in
// media_assets.url. That's fine for short Shorts voice-overs but bloats
// the row and isn't shareable outside this app - swap this for a real
// upload once an S3-compatible client is wired up.
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

    const dataUrl = `data:${voiceover.contentType};base64,${voiceover.audioBuffer.toString('base64')}`;
    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
              VALUES (?, ?, 'audio', ?, ?, ?, 'ai-generated')`,
        args: [
            id, dataUrl,
            b.productId || null,
            b.rubricId || null,
            JSON.stringify(b.tags || []),
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

export default router;
