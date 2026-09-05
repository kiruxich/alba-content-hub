import { Router } from 'express';
import { db } from '../db.js';
import { translateToEnglish } from '../lib/translateToEnglish.js';
import { validateDraft } from '../lib/editorValidation.js';
import { sendIdeaForApproval } from '../lib/telegramApproval.js';
import { isKieConfigured, generateImage, generateVideo } from '../lib/kieClient.js';
import { generateVoiceover, isElevenLabsConfigured } from '../lib/elevenLabsClient.js';
import { generatePiperVoiceover, isPiperConfigured } from '../lib/piperTtsClient.js';
import { isObjectStorageConfigured, uploadBuffer, uploadFromUrl } from '../lib/objectStorage.js';
import { createVideoJob } from '../lib/videoWorkerClient.js';
import { isLocalClaudeAgentConfigured, generateReelsScript } from '../lib/localClaudeAgent.js';

const router = Router();

// Same agent_expenses identity kie.ai-driven spend uses in mediaAssets.js -
// kept in sync deliberately so Cost Tracker doesn't need to know this
// endpoint exists separately from the manual generate-cover/generate-video
// routes.
const KIE_AGENT_NAME = 'generator';

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
        voiceoverAssetId: row.voiceover_asset_id || null,
        videoAssetId: row.video_asset_id || null,
    };
}

const upsertSql = `
    INSERT INTO ideas (id, title, desc, format, funnel, status, cta, target_groups, metrics_views, metrics_saves, metrics_clicks, metrics_leads, source, agent_meta, draft_text, content_type, expires_at, rubric_id, quality_flags, cover_asset_id, voiceover_asset_id, title_en, desc_en, cta_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, desc = excluded.desc, format = excluded.format,
        funnel = excluded.funnel, status = excluded.status, cta = excluded.cta,
        target_groups = excluded.target_groups,
        metrics_views = excluded.metrics_views, metrics_saves = excluded.metrics_saves,
        metrics_clicks = excluded.metrics_clicks, metrics_leads = excluded.metrics_leads,
        source = excluded.source, agent_meta = excluded.agent_meta, draft_text = excluded.draft_text,
        content_type = excluded.content_type, expires_at = excluded.expires_at,
        rubric_id = excluded.rubric_id, quality_flags = excluded.quality_flags,
        cover_asset_id = excluded.cover_asset_id, voiceover_asset_id = excluded.voiceover_asset_id,
        title_en = excluded.title_en, desc_en = excluded.desc_en, cta_en = excluded.cta_en
`;

function upsertArgs(row) {
    return [row.id, row.title, row.desc, row.format, row.funnel, row.status, row.cta,
        row.target_groups, row.metrics_views, row.metrics_saves, row.metrics_clicks, row.metrics_leads,
        row.source, row.agent_meta, row.draft_text,
        row.content_type, row.expires_at, row.rubric_id, row.quality_flags, row.cover_asset_id, row.voiceover_asset_id,
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

// GET /api/ideas/needs-regeneration
//
// Agent-authored drafts a Telegram reviewer sent back for rework instead of
// approving/rejecting outright: see the free-text reply branch in
// server/routes/telegramWebhook.js, which appends { text, at } entries to
// agentMeta.regenerateNotes on the idea (and separately logs the same note
// on the telegram_approvals row for audit purposes only - this endpoint
// reads the idea, not that row). An idea shows up here only while it is
// still in 'idea' status (not yet approved/published) and has at least one
// pending note - once a fresh draftText is PUT back to /api/ideas/:id, the
// PUT handler clears agentMeta.regenerateNotes and the idea drops off this
// list on its own.
//
// Response: 200 { items: Idea[] }
//   Each Idea is the normal serialized shape returned by GET /api/ideas
//   (id, title, desc, format, funnel, status, cta, targetGroups, metrics,
//   source, agentMeta, draftText, contentType, expiresAt, rubricId,
//   qualityFlags, coverAssetId, ...) plus a convenience top-level
//   `regenerateNotes` field mirroring agentMeta.regenerateNotes - an array
//   of { text: string, at: number } entries (at = ms epoch of the Telegram
//   reply). draftText carries the current businessProblem/technicalSolution/
//   businessResult/cta fields to revise; agentMeta may also carry other
//   agent-set context (e.g. sourceUrl) worth preserving in the rewrite.
//
// Full integration contract for a caller (the Generator agent) lives in
// docs/generator-regeneration.md.
router.get('/needs-regeneration', async (req, res) => {
    // agent_meta is opaque JSON - filter broadly in SQL (LIKE is a cheap
    // pre-filter, same pattern as the free-text search above) then confirm
    // precisely in JS, since libSQL here isn't queried with json_extract
    // anywhere else in this codebase.
    const result = await db.execute({
        sql: "SELECT * FROM ideas WHERE status = 'idea' AND agent_meta IS NOT NULL AND agent_meta LIKE '%regenerateNotes%' ORDER BY created_at DESC",
        args: [],
    });
    const items = result.rows
        .map(serialize)
        .filter((idea) => Array.isArray(idea.agentMeta?.regenerateNotes) && idea.agentMeta.regenerateNotes.length > 0)
        .map((idea) => ({ ...idea, regenerateNotes: idea.agentMeta.regenerateNotes }));
    res.json({ items });
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
            voiceover_asset_id: b.voiceoverAssetId || null,
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
    const resolvedSource = b.source !== undefined ? b.source : existing.source;
    const resolvedFormat = b.format !== undefined ? b.format : existing.format;

    // Regeneration: agentMeta isn't in the request body on a typical
    // "here's the revised draft" PUT (only draftText is), so the base object
    // to carry forward is whatever agentMeta the caller sent, or failing
    // that the idea's existing agentMeta - never dropped just because this
    // PUT didn't mention it. If that base has a non-empty regenerateNotes
    // array (set by the Telegram webhook's free-text reply branch, see
    // server/routes/telegramWebhook.js) and this PUT is delivering an actual
    // new draftText, the notes have now been addressed: clear the array so
    // the idea drops off GET /api/ideas/needs-regeneration, but leave every
    // other agentMeta key untouched.
    let agentMetaObj = b.agentMeta !== undefined
        ? (b.agentMeta ? { ...b.agentMeta } : null)
        : (existing.agent_meta ? JSON.parse(existing.agent_meta) : null);
    if (b.draftText && agentMetaObj && Array.isArray(agentMetaObj.regenerateNotes) && agentMetaObj.regenerateNotes.length > 0) {
        agentMetaObj = { ...agentMetaObj, regenerateNotes: [] };
    }

    // Same editor/quality-gate recompute as POST (see validateDraft above):
    // when an agent-sourced idea's draftText is (re)written, desc and
    // quality_flags must be rebuilt from it too, or the assembled post text
    // shown everywhere else in the app would stay frozen at the pre-rework
    // version even though draftText itself changed underneath it. Only
    // triggers when draftText is actually present in this PUT - a normal
    // edit that doesn't touch draftText leaves desc/quality_flags exactly as
    // before.
    let desc = b.desc !== undefined ? b.desc : existing.desc;
    let qualityFlags = b.qualityFlags !== undefined ? b.qualityFlags : JSON.parse(existing.quality_flags || '[]');
    if (resolvedSource === 'agent' && b.draftText) {
        const { flags, assembledText } = validateDraft({ ...b.draftText, format: resolvedFormat });
        qualityFlags = flags;
        desc = assembledText;
    }

    const merged = {
        id: existing.id,
        title: b.title !== undefined ? String(b.title).trim() : existing.title,
        desc,
        format: resolvedFormat,
        funnel: b.funnel !== undefined ? b.funnel : existing.funnel,
        status: b.status !== undefined ? b.status : existing.status,
        cta: b.cta !== undefined ? b.cta : existing.cta,
        target_groups: b.targetGroups !== undefined ? JSON.stringify(b.targetGroups) : existing.target_groups,
        metrics_views: b.metrics?.views !== undefined ? b.metrics.views : existing.metrics_views,
        metrics_saves: b.metrics?.saves !== undefined ? b.metrics.saves : existing.metrics_saves,
        metrics_clicks: b.metrics?.clicks !== undefined ? b.metrics.clicks : existing.metrics_clicks,
        metrics_leads: b.metrics?.leads !== undefined ? b.metrics.leads : existing.metrics_leads,
        source: resolvedSource,
        agent_meta: agentMetaObj ? JSON.stringify(agentMetaObj) : null,
        draft_text: b.draftText !== undefined ? (b.draftText ? JSON.stringify(b.draftText) : null) : existing.draft_text,
        content_type: b.contentType !== undefined ? b.contentType : existing.content_type,
        expires_at: b.expiresAt !== undefined ? b.expiresAt : existing.expires_at,
        rubric_id: b.rubricId !== undefined ? b.rubricId : existing.rubric_id,
        quality_flags: JSON.stringify(qualityFlags),
        cover_asset_id: b.coverAssetId !== undefined ? b.coverAssetId : existing.cover_asset_id,
        voiceover_asset_id: b.voiceoverAssetId !== undefined ? b.voiceoverAssetId : existing.voiceover_asset_id,
        title_en: b.titleEn !== undefined ? b.titleEn : existing.title_en,
        desc_en: b.descEn !== undefined ? b.descEn : existing.desc_en,
        cta_en: b.ctaEn !== undefined ? b.ctaEn : existing.cta_en,
    };
    await db.execute({ sql: upsertSql, args: upsertArgs(merged) });

    // Bridge manually-entered views/saves/clicks (the "📊 ROI" modal) into
    // scheduled_events too - the Insights agent's weekly brief reads
    // scheduled_events.metrics_*, NOT ideas.metrics_* (see
    // server/routes/insights.js), so without this a manual entry here was
    // silently invisible to Insights. This matters most for Telegram, which
    // can never get real numbers from metricsSync.js (the Bot API has no
    // view-count endpoint) - manual entry is the only way those posts' real
    // performance ever reaches Insights. Best-effort: if an idea was posted
    // to more than one platform/date, the same entered numbers get applied
    // to every scheduled_events row for it, since the ROI modal only takes
    // one aggregate figure per idea, not one per publication. Leads has no
    // scheduled_events column (it's a business/CRM signal Insights doesn't
    // use), so it stays ideas-only.
    if (b.metrics && (b.metrics.views !== undefined || b.metrics.saves !== undefined || b.metrics.clicks !== undefined)) {
        await db.execute({
            sql: `UPDATE scheduled_events SET
                    metrics_views = ?, metrics_saves = ?, metrics_clicks = ?, metrics_synced_at = strftime('%s','now')
                  WHERE idea_id = ?`,
            args: [merged.metrics_views, merged.metrics_saves, merged.metrics_clicks, existing.id],
        });
    }

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
    // An empty/malformed import used to still run `DELETE FROM ideas` below,
    // silently wiping every idea for nothing - require at least one real
    // (titled) item before touching the table at all.
    if (!items.some(item => item && item.title)) {
        return res.status(400).json({ error: 'Файл не содержит ни одной идеи с названием — импорт отменён' });
    }

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
                    rubric_id: null, quality_flags: '[]', cover_asset_id: null, voiceover_asset_id: null,
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

// --- AUTO-GENERATE MEDIA CHAIN (Банк идей "✨ Сгенерировать" button) ---
//
// kie.ai's returned URLs point at its own temp storage which isn't
// permanent - same rehosting-if-configured fallback as mediaAssets.js's
// rehostIfConfigured(): best-effort, falls back to the kie.ai URL on any
// failure rather than failing a generation that already spent credits.
async function rehostGeneratedUrl(kieUrl, keyPrefix) {
    if (!isObjectStorageConfigured()) return kieUrl;
    try {
        const { url } = await uploadFromUrl(kieUrl, { keyPrefix });
        return url;
    } catch (e) {
        console.error(`ideas/auto-generate: failed to re-upload ${kieUrl} to object storage, falling back to kie.ai URL:`, e.message);
        return kieUrl;
    }
}

// Builds a reasonable *image* prompt from an idea's title/desc rather than
// just dumping the raw post text at kie.ai (which is written as a post, not
// an image brief).
function buildImagePromptFromIdea(idea) {
    const context = (idea.desc || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    return `Обложка для поста на тему: "${idea.title}".${context ? ` Контекст: ${context}.` : ''} Стиль: минималистичный, современный, привлекающий внимание, без текста на изображении.`;
}

function newAssetId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function insertMediaAssetRow({ url, type, productId, tags }) {
    const id = newAssetId();
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
              VALUES (?, ?, ?, ?, NULL, ?, 'ai_generated')`,
        args: [id, url, type, productId || null, JSON.stringify(tags || [])],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
    return result.rows[0];
}

function serializeAsset(row) {
    return {
        id: row.id,
        url: row.url,
        type: row.type,
        productId: row.product_id || null,
        tags: JSON.parse(row.tags || '[]'),
        source: row.source || 'manual',
        usedCount: row.used_count || 0,
        createdAt: row.created_at,
    };
}

// POST /api/ideas/:id/auto-generate
//
// One-click "make media for this idea" from the Банк идей card - kicks off
// cover image generation (kie.ai Flux) and voiceover generation (ElevenLabs
// if configured, else Piper) in parallel, and - only when the idea's format
// is exactly 'Reels / Shorts' - also generates a short video clip (kie.ai
// Kling) and, once both that clip and the voiceover are ready, starts a
// video-worker assembly job that stitches them into the final short.
//
// Best-effort aggregation: a failure in any one step (kie.ai/ElevenLabs/
// Piper not configured, out of credits, network error, ...) does NOT abort
// the whole request - each step reports its own { asset } or { error } so
// the caller can see exactly what succeeded. This mirrors how every other
// optional integration in this app degrades (a normal error surfaced per
// step, not a hard failure of the whole action).
//
// Assembly is job-based (video-worker sits on an internal-network address
// and can take a while to render) - this endpoint only kicks the job off via
// createVideoJob() and returns { jobId, status }; the same
// GET /api/video-assembly/:jobId endpoint the existing manual flow already
// uses is what the frontend polls to find out when the job is done and to
// pick up the resulting media_assets row.
//
// Response 200 (only 404s if the idea itself doesn't exist):
// {
//   idea: <serialized idea - coverAssetId/voiceoverAssetId/videoAssetId
//          updated for whichever steps succeeded>,
//   cover: { asset } | { error },
//   voiceover: { asset } | { error },
//   video: { asset } | { error } | null,        // null when format isn't 'Reels / Shorts'
//   assembly: { jobId, status } | { error } | null,
// }
router.post('/:id/auto-generate', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'idea not found' });

    const idea = serialize(row);
    const productId = (idea.targetGroups && idea.targetGroups[0]) || null;
    const ideaTag = `idea:${idea.id}`;
    const isReels = idea.format === 'Reels / Shorts';
    const imagePrompt = buildImagePromptFromIdea(idea);

    // requestedProvider: 'elevenlabs' | 'piper' | undefined (auto-pick, old
    // behavior). Explicit choice from the "Сгенерировать" options modal - see
    // public/js/app.js's autoGenerateIdeaMedia(). If the requested provider
    // fails at runtime (e.g. ElevenLabs configured but the plan isn't paid -
    // a 403, not a "not configured" case isConfigured() can catch), this
    // automatically retries once with the other provider if it's available,
    // rather than just failing the whole voiceover step.
    const requestedProvider = ['elevenlabs', 'piper'].includes(req.body?.voiceoverProvider) ? req.body.voiceoverProvider : null;

    // Reels/Shorts get a scene-by-scene shot list + a voiceover script
    // tailored for a 20-40s video, via local-claude-agent (best-effort - see
    // server/lib/localClaudeAgent.js). Falls back to using the post text
    // directly for the voiceover (old behavior) when local-claude-agent isn't
    // configured/reachable, exactly like every other optional integration here.
    let reelsScript = null;
    if (isReels && isLocalClaudeAgentConfigured()) {
        try {
            // Тон голоса тот же, что у всей остальной генерации: сценарий
            // Reels озвучивается от лица бренда, и звучать он должен так же,
            // как посты, а не нейтральным дикторским текстом.
            const voiceRow = (await db.execute('SELECT tone_of_voice FROM agent_settings WHERE id = 1')).rows[0];
            reelsScript = await generateReelsScript(idea.title, idea.desc || '', voiceRow?.tone_of_voice || '');
        } catch (e) {
            console.error('ideas/auto-generate: reels script generation failed, falling back to post text:', e.message);
        }
    }

    async function runCover() {
        if (!isKieConfigured()) return { error: 'kie.ai не настроен — добавьте KIE_API_KEY в переменные окружения' };
        try {
            const { url: kieUrl, creditsConsumed } = await generateImage(imagePrompt);
            const url = await rehostGeneratedUrl(kieUrl, 'covers');
            const assetRow = await insertMediaAssetRow({ url, type: 'image', productId, tags: [ideaTag, 'auto-generated'] });
            await db.execute({
                sql: `INSERT INTO agent_expenses (agent_name, model_used, kie_credits_spent) VALUES (?, ?, ?)`,
                args: [KIE_AGENT_NAME, 'flux-2/pro-text-to-image', creditsConsumed || 0],
            });
            return { asset: serializeAsset(assetRow) };
        } catch (e) {
            console.error('ideas/auto-generate: cover generation failed:', e.message);
            return { error: `Не удалось сгенерировать обложку: ${e.message}` };
        }
    }

    async function generateWithProvider(provider, text) {
        if (provider === 'piper') {
            return { voiceover: await generatePiperVoiceover({ text }), modelUsed: 'piper:ru_RU-dmitri-medium' };
        }
        return { voiceover: await generateVoiceover({ text }), modelUsed: 'elevenlabs:eleven_multilingual_v2' };
    }

    async function runVoiceover() {
        const text = (reelsScript?.voiceoverText || idea.desc || idea.title || '').trim();
        if (!text) return { error: 'У идеи нет текста для озвучки' };

        const elevenAvailable = isElevenLabsConfigured();
        const piperAvailable = isPiperConfigured();
        // Explicit choice from the modal wins if that provider is actually
        // configured; otherwise fall back to auto-pick (prefer ElevenLabs,
        // same as the old default) so a stale/unavailable selection doesn't
        // just hard-fail.
        let provider = requestedProvider && (requestedProvider === 'elevenlabs' ? elevenAvailable : piperAvailable)
            ? requestedProvider
            : (elevenAvailable ? 'elevenlabs' : (piperAvailable ? 'piper' : null));
        if (!provider) return { error: 'Ни ElevenLabs, ни Piper не настроены — добавьте ELEVENLABS_API_KEY или PIPER_WORKER_TOKEN' };

        let usedFallback = false;
        let voiceover, modelUsed;
        try {
            ({ voiceover, modelUsed } = await generateWithProvider(provider, text));
        } catch (e) {
            // Runtime failure (e.g. ElevenLabs key present but the plan isn't
            // paid - a 403 isConfigured() can't detect ahead of time) - retry
            // once with the other provider if one is available, instead of
            // failing the whole step over something the picker couldn't know.
            const otherProvider = provider === 'elevenlabs' ? 'piper' : 'elevenlabs';
            const otherAvailable = otherProvider === 'elevenlabs' ? elevenAvailable : piperAvailable;
            if (!otherAvailable) return { error: `Не удалось сгенерировать озвучку (${provider}): ${e.message}` };
            try {
                ({ voiceover, modelUsed } = await generateWithProvider(otherProvider, text));
                provider = otherProvider;
                usedFallback = true;
            } catch (e2) {
                return { error: `Не удалось сгенерировать озвучку ни через ${provider === 'elevenlabs' ? 'ElevenLabs' : 'Piper'}, ни через ${otherProvider === 'elevenlabs' ? 'ElevenLabs' : 'Piper'}: ${e2.message}` };
            }
        }

        try {
            let url;
            if (isObjectStorageConfigured()) {
                try {
                    ({ url } = await uploadBuffer(voiceover.audioBuffer, { contentType: voiceover.contentType, keyPrefix: 'voiceovers' }));
                } catch (e) {
                    console.error('ideas/auto-generate: voiceover object storage upload failed, falling back to base64 data URL:', e.message);
                }
            }
            if (!url) url = `data:${voiceover.contentType};base64,${voiceover.audioBuffer.toString('base64')}`;

            const assetRow = await insertMediaAssetRow({ url, type: 'audio', productId, tags: [ideaTag, 'auto-generated'] });
            await db.execute({
                sql: `INSERT INTO agent_expenses (agent_name, model_used, total_usd) VALUES ('generator', ?, ?)`,
                args: [modelUsed, voiceover.estimatedCostUsd || 0],
            });
            return { asset: serializeAsset(assetRow), provider, usedFallback };
        } catch (e) {
            return { error: `Не удалось сгенерировать озвучку: ${e.message}` };
        }
    }

    async function runVideo() {
        if (!isReels) return null;
        if (!isKieConfigured()) return { error: 'kie.ai не настроен — добавьте KIE_API_KEY в переменные окружения' };
        try {
            const { url: kieUrl, creditsConsumed } = await generateVideo(imagePrompt);
            const url = await rehostGeneratedUrl(kieUrl, 'covers');
            const assetRow = await insertMediaAssetRow({ url, type: 'video', productId, tags: [ideaTag, 'auto-generated'] });
            await db.execute({
                sql: `INSERT INTO agent_expenses (agent_name, model_used, kie_credits_spent) VALUES (?, ?, ?)`,
                args: [KIE_AGENT_NAME, 'kling-2.6/text-to-video', creditsConsumed || 0],
            });
            return { asset: serializeAsset(assetRow) };
        } catch (e) {
            return { error: `Не удалось сгенерировать видео: ${e.message}` };
        }
    }

    const [coverResult, voiceoverResult, videoResult] = await Promise.all([runCover(), runVoiceover(), runVideo()]);

    let assemblyResult = null;
    if (isReels) {
        if (videoResult?.asset && voiceoverResult?.asset) {
            try {
                const job = await createVideoJob({
                    videoUrl: videoResult.asset.url,
                    audioUrl: voiceoverResult.asset.url,
                    captionText: idea.title,
                    outputFormat: 'mp4',
                });
                await db.execute({
                    sql: `INSERT INTO video_assembly_jobs (id, job_id, video_url, audio_url, caption_text, status)
                          VALUES (?, ?, ?, ?, ?, ?)`,
                    args: [job.job_id, job.job_id, videoResult.asset.url, voiceoverResult.asset.url, idea.title, job.status || 'queued'],
                });
                assemblyResult = { jobId: job.job_id, status: job.status || 'queued' };
            } catch (e) {
                assemblyResult = { error: `Не удалось запустить сборку ролика: ${e.message}` };
            }
        } else {
            assemblyResult = { error: 'Сборка ролика пропущена: нет и видео, и озвучки одновременно' };
        }
    }

    // Persist whichever asset ids succeeded onto the idea itself - same
    // cover_asset_id column the manual media picker already reads/writes.
    const updates = {};
    if (coverResult?.asset) updates.cover_asset_id = coverResult.asset.id;
    if (voiceoverResult?.asset) updates.voiceover_asset_id = voiceoverResult.asset.id;
    if (videoResult?.asset) updates.video_asset_id = videoResult.asset.id;
    if (Object.keys(updates).length) {
        const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
        await db.execute({ sql: `UPDATE ideas SET ${setClauses} WHERE id = ?`, args: [...Object.values(updates), idea.id] });
    }

    const finalRow = (await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [idea.id] })).rows[0];
    res.json({
        idea: serialize(finalRow),
        cover: coverResult,
        voiceover: voiceoverResult,
        video: videoResult,
        assembly: assemblyResult,
        reelsScript,
    });
});

export default router;
