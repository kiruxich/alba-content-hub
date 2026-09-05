import { Router } from 'express';
import { db } from '../db.js';
import { isLocalClaudeAgentConfigured, generateRoadmap } from '../lib/localClaudeAgent.js';
import { buildInsightsContext, buildPerformanceContext, buildSalesContext, joinContext } from '../lib/systemContext.js';
import { buildContentPlanContext } from './contentPlan.js';

const router = Router();

const FIELDS = ['about', 'target_audience', 'value_proposition', 'key_differentiators', 'common_objections', 'keywords'];

function rowToJson(r) {
    return {
        productId: r.product_id,
        about: r.about || '',
        targetAudience: r.target_audience || '',
        valueProposition: r.value_proposition || '',
        keyDifferentiators: r.key_differentiators || '',
        commonObjections: r.common_objections || '',
        keywords: r.keywords || '',
        roadmap: JSON.parse(r.roadmap_json || '[]'),
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute(
        'SELECT product_id, about, target_audience, value_proposition, key_differentiators, common_objections, keywords, roadmap_json FROM project_info'
    );
    const map = {};
    result.rows.forEach(r => { map[r.product_id] = rowToJson(r); });
    res.json(map);
});

router.put('/:productId', async (req, res) => {
    const body = req.body || {};
    const about = body.about ?? '';
    const targetAudience = body.targetAudience ?? '';
    const valueProposition = body.valueProposition ?? '';
    const keyDifferentiators = body.keyDifferentiators ?? '';
    const commonObjections = body.commonObjections ?? '';
    const keywords = body.keywords ?? '';

    await db.execute({
        sql: `
            INSERT INTO project_info (product_id, about, target_audience, value_proposition, key_differentiators, common_objections, keywords)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id) DO UPDATE SET
                about = excluded.about,
                target_audience = excluded.target_audience,
                value_proposition = excluded.value_proposition,
                key_differentiators = excluded.key_differentiators,
                common_objections = excluded.common_objections,
                keywords = excluded.keywords
        `,
        args: [req.params.productId, about, targetAudience, valueProposition, keyDifferentiators, commonObjections, keywords],
    });

    const result = await db.execute({
        sql: 'SELECT product_id, about, target_audience, value_proposition, key_differentiators, common_objections, keywords, roadmap_json FROM project_info WHERE product_id = ?',
        args: [req.params.productId],
    });
    res.json(rowToJson(result.rows[0]));
});

// Roadmap items live on the same row (roadmap_json), but get their own
// sub-route so the frontend's add/edit/delete UI can operate on one item at a
// time without resending the other five text fields.
router.put('/:productId/roadmap', async (req, res) => {
    const items = Array.isArray(req.body?.roadmap) ? req.body.roadmap : [];
    const roadmapJson = JSON.stringify(items);

    await db.execute({
        sql: `
            INSERT INTO project_info (product_id, roadmap_json) VALUES (?, ?)
            ON CONFLICT(product_id) DO UPDATE SET roadmap_json = excluded.roadmap_json
        `,
        args: [req.params.productId, roadmapJson],
    });

    res.json({ productId: req.params.productId, roadmap: items });
});

// "✨ Сгенерировать через ИИ" next to "+ Добавить этап" - proposes new
// milestones. Preview-only like discoverRssSources/discoverKeywords in
// agentSettings.js: nothing is saved here, the client shows a checklist and
// the user confirms via the existing PUT .../roadmap.
//
// Контекст собирается со всей системы, а не только из «О проекте» этого
// продукта: этап продвижения зависит от того, куда компания идёт
// (бизнес-цель и фокус квартала из контент-плана), что уже реально
// сработало в контенте (выводы Insights плюс сырые метрики публикаций) и
// на какой стадии продажи (CRM). Роадмап, написанный в отрыве от этого,
// предлагает «запустить блог» там, где блог уже год как идёт.
router.post('/:productId/roadmap/generate', async (req, res) => {
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен (LOCAL_CLAUDE_AGENT_URL/LOCAL_CLAUDE_AGENT_TOKEN)' });
    }
    const productName = (req.body?.productName || '').trim();
    if (!productName) return res.status(400).json({ error: 'productName is required' });

    const row = (await db.execute({
        sql: 'SELECT about, target_audience, value_proposition, key_differentiators, roadmap_json FROM project_info WHERE product_id = ?',
        args: [req.params.productId],
    })).rows[0];
    const existingTitles = row ? JSON.parse(row.roadmap_json || '[]').map(r => r.title).filter(Boolean) : [];

    // Собираем параллельно: каждый сборщик сам глотает свои ошибки и отдаёт
    // пустую строку, так что ни один из них не может уронить генерацию.
    const [strategy, insights, performance, sales] = await Promise.all([
        buildContentPlanContext(),
        buildInsightsContext(),
        buildPerformanceContext({ days: 30 }),
        buildSalesContext(),
    ]);

    try {
        const result = await generateRoadmap({
            productName,
            about: row?.about || '',
            targetAudience: row?.target_audience || '',
            valueProposition: row?.value_proposition || '',
            keyDifferentiators: row?.key_differentiators || '',
            existingTitles,
            systemContext: joinContext(strategy, insights, performance, sales),
        });
        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        res.json({
            candidates: candidates
                .map(c => ({ title: String(c?.title || '').trim(), description: String(c?.description || '').trim() }))
                .filter(c => c.title),
        });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

export default router;
