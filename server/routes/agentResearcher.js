import { Router } from 'express';
import Parser from 'rss-parser';
import { db } from '../db.js';
import { embed, cosineSimilarity } from '../lib/embeddings.js';
import { PRODUCTS } from '../lib/products.js';
import { checkBudgetCap } from '../lib/checkBudgetCap.js';

const router = Router();
const rssParser = new Parser({ timeout: 10000 });

function stripHtml(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function truncate(text, max = 400) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Cheap non-cryptographic hash, only used to detect when a product's "about"
// text has changed so its embedding needs recomputing - not a security value.
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
    return String(hash);
}

// Builds the text that gets embedded per product. Pulls in all five
// project_info fields (not just `about`) - target audience, value prop, key
// differentiators, common objections and keywords all carry signal about
// what makes a trend relevant to a given product, and folding them into the
// embedding input directly improves how well incoming RSS candidates get
// matched to the right product below.
function buildEmbeddingText(row, fallbackTitle) {
    const about = row?.about || '';
    const targetAudience = row?.target_audience || '';
    const valueProposition = row?.value_proposition || '';
    const keyDifferentiators = row?.key_differentiators || '';
    const commonObjections = row?.common_objections || '';
    const keywords = row?.keywords || '';

    if (!about && !targetAudience && !valueProposition && !keyDifferentiators && !commonObjections && !keywords) {
        return fallbackTitle;
    }

    return [
        `О продукте: ${about}`,
        `Целевая аудитория: ${targetAudience}`,
        `Главный посыл: ${valueProposition}`,
        `Отличия от конкурентов: ${keyDifferentiators}`,
        `Частые возражения: ${commonObjections}`,
        `Ключевые слова: ${keywords}`,
    ].join('\n');
}

async function getProductVectors() {
    const infoResult = await db.execute(
        'SELECT product_id, about, target_audience, value_proposition, key_differentiators, common_objections, keywords FROM project_info'
    );
    const infoById = {};
    infoResult.rows.forEach(r => { infoById[r.product_id] = r; });

    const vectors = {};
    for (const product of PRODUCTS) {
        const aboutText = buildEmbeddingText(infoById[product.id], product.title);
        const hash = simpleHash(aboutText);

        const cached = await db.execute({
            sql: 'SELECT vector, source_text_hash FROM product_embeddings WHERE product_id = ?',
            args: [product.id],
        });
        const existing = cached.rows[0];

        if (existing && existing.source_text_hash === hash) {
            vectors[product.id] = JSON.parse(existing.vector);
            continue;
        }

        const vec = await embed(aboutText);
        await db.execute({
            sql: `INSERT INTO product_embeddings (product_id, vector, source_text_hash, updated_at)
                  VALUES (?, ?, ?, strftime('%s','now'))
                  ON CONFLICT(product_id) DO UPDATE SET
                      vector = excluded.vector, source_text_hash = excluded.source_text_hash, updated_at = excluded.updated_at`,
            args: [product.id, JSON.stringify(vec), hash],
        });
        vectors[product.id] = vec;
    }
    return vectors;
}

async function fetchCandidates(sources) {
    const candidates = [];
    for (const url of sources) {
        try {
            const feed = await rssParser.parseURL(url);
            for (const item of feed.items.slice(0, 15)) {
                const rawText = item.contentSnippet || item.content || item.summary || item.title || '';
                const cleaned = truncate(stripHtml(rawText));
                if (!cleaned) continue;
                candidates.push({
                    title: item.title || '',
                    link: item.link || '',
                    text: cleaned,
                    pubDate: item.pubDate || null,
                });
            }
        } catch (e) {
            console.error(`Researcher: failed to fetch ${url}:`, e.message);
        }
    }
    return candidates;
}

async function logRun(runDate, status, log, trendsFound, costUsd, briefJson) {
    await db.execute({
        sql: `INSERT INTO agent_runs (run_date, agent_name, status, log, cost_usd, trends_found, brief_json) VALUES (?, 'researcher', ?, ?, ?, ?, ?)`,
        args: [runDate, status, log, costUsd, trendsFound, briefJson ? JSON.stringify(briefJson) : null],
    });
}

async function notifyTelegram(brief) {
    const settingsRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings?.token || !settings?.chat_id) return;

    const lines = brief.trends.map((t, i) =>
        `${i + 1}. *${t.topic}*\n   Продукт: ${t.target_product} · релевантность ${t.relevance_score}\n   ${t.source_url}`
    );
    const text = `🔎 *Сводка Researcher за ${brief.date}*\n\n${lines.join('\n\n') || 'Актуальных тем не найдено сегодня.'}`;

    try {
        await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.chat_id, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('Researcher: failed to notify Telegram:', e.message);
    }
}

async function runResearcher(req, res) {
    // Vercel adds this header automatically when CRON_SECRET is set as an env
    // var - checked only if the var is actually configured, so this endpoint
    // stays testable by hand before that's set up.
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const startedAt = Date.now();
    const runDate = new Date().toISOString().slice(0, 10);

    try {
        const budgetStatus = await checkBudgetCap();
        if (budgetStatus.exceeded) {
            await logRun(
                runDate, 'skipped',
                `Daily budget cap of $${budgetStatus.capUsd} reached (spent $${budgetStatus.spentTodayUsd} today).`,
                0, 0
            );
            return res.json({ status: 'skipped', reason: 'budget_exceeded' });
        }

        const settingsResult = await db.execute('SELECT sources FROM agent_settings WHERE id = 1');
        const sources = JSON.parse(settingsResult.rows[0]?.sources || '[]');

        if (sources.length === 0) {
            await logRun(runDate, 'skipped', 'No RSS sources configured in agent_settings.', 0, 0);
            return res.json({ status: 'skipped', reason: 'no_sources' });
        }

        const [candidates, productVectors] = await Promise.all([
            fetchCandidates(sources),
            getProductVectors(),
        ]);

        if (candidates.length === 0) {
            await logRun(runDate, 'skipped', 'Sources returned no usable items.', 0, 0);
            return res.json({ status: 'skipped', reason: 'no_candidates' });
        }

        // Lightweight dedup: skip anything whose exact title already exists
        // among recent agent-authored ideas, so the same trend isn't proposed
        // twice. (Semantic near-duplicate detection is a fast-follow.)
        const recentIdeas = await db.execute(
            "SELECT title FROM ideas WHERE source = 'agent' ORDER BY created_at DESC LIMIT 30"
        );
        const recentTitles = new Set(recentIdeas.rows.map(r => (r.title || '').toLowerCase()));

        const scored = [];
        for (const candidate of candidates) {
            if (recentTitles.has(candidate.title.toLowerCase())) continue;
            const vec = await embed(candidate.text);
            let best = null;
            for (const [productId, productVec] of Object.entries(productVectors)) {
                const score = cosineSimilarity(vec, productVec);
                if (!best || score > best.score) best = { productId, score };
            }
            if (best) scored.push({ ...candidate, targetProduct: best.productId, score: best.score });
        }

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 3);

        const brief = {
            date: runDate,
            trends: top.map((t, i) => ({
                id: `trend_${i + 1}`,
                topic: t.title,
                snippet: t.text,
                source_url: t.link,
                target_product: t.targetProduct,
                relevance_score: Math.round(t.score * 1000) / 1000,
                target_funnel: 'TOFU',
            })),
        };

        const durationSec = Math.round((Date.now() - startedAt) / 1000);
        // Local embeddings only, no LLM call in this step - genuinely free.
        await logRun(
            runDate, 'success',
            `Scanned ${candidates.length} candidates from ${sources.length} source(s) in ${durationSec}s, picked ${top.length}.`,
            top.length, 0, brief
        );
        await notifyTelegram(brief);

        res.json({ status: 'success', brief });
    } catch (e) {
        console.error('Researcher run failed:', e);
        await logRun(runDate, 'failed', e.message, 0, 0);
        res.status(500).json({ error: e.message });
    }
}

// Vercel Cron Jobs issue GET requests; POST is kept for manual/local testing.
router.get('/run', runResearcher);
router.post('/run', runResearcher);

// Consumed by the Generator agent (a Claude Code routine, not this backend)
// to pick up the day's trends without re-scanning RSS itself.
router.get('/latest-brief', async (req, res) => {
    const result = await db.execute(
        "SELECT run_date, brief_json FROM agent_runs WHERE agent_name = 'researcher' AND status = 'success' AND brief_json IS NOT NULL ORDER BY id DESC LIMIT 1"
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'no successful researcher run yet' });
    res.json(JSON.parse(row.brief_json));
});

export default router;
