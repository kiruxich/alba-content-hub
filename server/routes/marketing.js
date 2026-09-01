import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// GET /api/marketing/brief - what the weekly "Маркетолог" routine reads.
// Unlike Insights (which only looks at per-post performance), this is
// spend-efficiency data: Cost Tracker numbers plus the same cost-per-post/
// cost-per-lead calc the Аналитика page shows, so the agent's conclusions
// are grounded in the exact numbers a human sees there, not a re-derivation
// that could drift from the UI.
router.get('/brief', async (req, res) => {
    const [todayRow, monthRow] = await Promise.all([
        db.execute(`SELECT COALESCE(SUM(total_usd), 0) as total FROM agent_expenses WHERE date(timestamp, 'unixepoch') = date('now')`),
        db.execute(`SELECT COALESCE(SUM(total_usd), 0) as total FROM agent_expenses WHERE strftime('%Y-%m', timestamp, 'unixepoch') = strftime('%Y-%m', 'now')`),
    ]);
    const monthUsd = monthRow.rows[0].total;
    const todayUsd = todayRow.rows[0].total;

    const currentMonthKey = new Date().toISOString().slice(0, 7);
    const publishedThisMonth = await db.execute({
        sql: `SELECT COUNT(DISTINCT idea_id) as cnt FROM scheduled_events WHERE publish_status = 'published' AND raw_date LIKE ?`,
        args: [`${currentMonthKey}%`],
    });
    const postsThisMonth = publishedThisMonth.rows[0].cnt;

    const leadsResult = await db.execute(`SELECT COALESCE(SUM(metrics_leads), 0) as total FROM ideas`);
    const totalLeads = leadsResult.rows[0].total;

    const costPerPost = postsThisMonth > 0 ? monthUsd / postsThisMonth : null;
    const costPerLead = totalLeads > 0 ? monthUsd / totalLeads : null;

    // Per-agent breakdown for the month - lets the routine spot a specific
    // agent (e.g. Generator, RSS discovery) burning disproportionate spend
    // relative to what it produces, not just a single lump sum.
    const byAgent = await db.execute({
        sql: `SELECT agent_name, COUNT(*) as runs, COALESCE(SUM(total_usd), 0) as usd
              FROM agent_expenses WHERE strftime('%Y-%m', timestamp, 'unixepoch') = strftime('%Y-%m', 'now')
              GROUP BY agent_name ORDER BY usd DESC`,
    });

    res.json({
        todayUsd,
        monthUsd,
        postsThisMonth,
        totalLeads,
        costPerPost,
        costPerLead,
        byAgent: byAgent.rows.map(r => ({ agentName: r.agent_name, runs: r.runs, usd: r.usd })),
        note: 'Для полной картины по эффективности контента (форматы/рубрики) также загляни в GET /api/insights/latest и GET /api/content-plan/context.',
    });
});

// Same agent_runs pattern as server/routes/insights.js's /conclusions -
// see the comment there for why this table/column shape is reused as-is
// instead of a parallel table.
router.post('/conclusions', async (req, res) => {
    const b = req.body || {};
    const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
    const recommendations = Array.isArray(b.recommendations) ? b.recommendations : [];

    if (!summary) {
        return res.status(400).json({ error: 'summary is required' });
    }

    const runDate = new Date().toISOString().slice(0, 10);
    const payload = { summary, recommendations, generatedAt: Date.now() };

    await db.execute({
        sql: `INSERT INTO agent_runs (run_date, agent_name, status, log, brief_json) VALUES (?, 'marketing', 'success', ?, ?)`,
        args: [runDate, summary, JSON.stringify(payload)],
    });

    res.status(201).json({ ok: true, runDate });
});

// Consumed by server/routes/contentPlan.js's /context endpoint (bridges
// this into what Generator/Researcher already read), and by the frontend
// if a "что думает Маркетолог" widget is ever added.
router.get('/latest', async (req, res) => {
    const result = await db.execute(
        "SELECT run_date, brief_json FROM agent_runs WHERE agent_name = 'marketing' AND status = 'success' AND brief_json IS NOT NULL ORDER BY id DESC LIMIT 1"
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'no successful marketing run yet' });
    res.json({ runDate: row.run_date, ...JSON.parse(row.brief_json) });
});

export default router;
