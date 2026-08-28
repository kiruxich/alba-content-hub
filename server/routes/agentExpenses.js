import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        timestamp: row.timestamp,
        agentName: row.agent_name,
        modelUsed: row.model_used,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedTokens: row.cached_tokens,
        kieCreditsSpent: row.kie_credits_spent,
        totalUsd: row.total_usd,
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM agent_expenses ORDER BY timestamp DESC LIMIT 200');
    res.json(result.rows.map(serialize));
});

// Powers the Cost Tracker's "spent today / spent this month" widgets.
router.get('/summary', async (req, res) => {
    const today = await db.execute(`
        SELECT COALESCE(SUM(total_usd), 0) as total FROM agent_expenses
        WHERE date(timestamp, 'unixepoch') = date('now')
    `);
    const month = await db.execute(`
        SELECT COALESCE(SUM(total_usd), 0) as total FROM agent_expenses
        WHERE strftime('%Y-%m', timestamp, 'unixepoch') = strftime('%Y-%m', 'now')
    `);
    res.json({ todayUsd: today.rows[0].total, monthUsd: month.rows[0].total });
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.agentName) return res.status(400).json({ error: 'agentName is required' });
    await db.execute({
        sql: `INSERT INTO agent_expenses (agent_name, model_used, input_tokens, output_tokens, cached_tokens, kie_credits_spent, total_usd)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [b.agentName, b.modelUsed || null, b.inputTokens || 0, b.outputTokens || 0,
            b.cachedTokens || 0, b.kieCreditsSpent || 0, b.totalUsd || 0],
    });
    res.status(201).json({ ok: true });
});

export default router;
