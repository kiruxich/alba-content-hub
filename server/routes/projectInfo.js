import { Router } from 'express';
import { db } from '../db.js';

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

export default router;
