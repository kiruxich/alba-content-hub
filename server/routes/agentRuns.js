import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        runDate: row.run_date,
        agentName: row.agent_name,
        status: row.status,
        log: row.log,
        costUsd: row.cost_usd,
        trendsFound: row.trends_found,
        createdAt: row.created_at,
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.runDate || !b.agentName || !b.status) {
        return res.status(400).json({ error: 'runDate, agentName and status are required' });
    }
    await db.execute({
        sql: `INSERT INTO agent_runs (run_date, agent_name, status, log, cost_usd, trends_found)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [b.runDate, b.agentName, b.status, b.log || '', b.costUsd || 0, b.trendsFound || 0],
    });
    res.status(201).json({ ok: true });
});

export default router;
