import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function toDateStr(d) {
    return d.toISOString().slice(0, 10);
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

function avg(values) {
    if (values.length === 0) return 0;
    return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

// One row = one publication (an idea posted on one platform - see the
// comment on scheduled_events.platform in server/db.js). We join to `ideas`
// for context (title/rubric) and treat every scheduled_events row whose
// raw_date falls in the window as "published" - there's no separate
// draft/live status on scheduled_events itself, it's populated once a post
// is actually scheduled/sent.
async function fetchPublications(periodStart, periodEnd) {
    const result = await db.execute({
        sql: `
            SELECT
                se.id AS event_id, se.raw_date, se.platform, se.format AS event_format,
                se.metrics_views, se.metrics_saves, se.metrics_clicks,
                i.id AS idea_id, i.title, i.format AS idea_format, i.funnel,
                i.rubric_id, i.agent_meta
            FROM scheduled_events se
            JOIN ideas i ON i.id = se.idea_id
            WHERE se.raw_date >= ? AND se.raw_date <= ?
            ORDER BY se.raw_date ASC
        `,
        args: [periodStart, periodEnd],
    });
    return result.rows;
}

function pickFormat(row) {
    return row.event_format || row.idea_format || 'Без формата';
}

// Best-effort only: `ideas` has no persisted product_id column today, so this
// can only recover a product for agent-authored ideas whose agentMeta happens
// to carry a targetProduct/target_product key (set by whatever produced the
// idea, e.g. a future Generator run seeded from a Researcher trend). Ideas
// created manually or without that key are simply left out of byProduct
// rather than dumped into a misleading "unknown" bucket. If ideas ever gets a
// real product_id column, switch this to read that column directly instead.
function pickProduct(row) {
    if (!row.agent_meta) return null;
    try {
        const meta = JSON.parse(row.agent_meta);
        return meta.targetProduct || meta.target_product || null;
    } catch {
        return null;
    }
}

function groupAggregate(rows, keyFn) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyFn(row);
        if (key === null || key === undefined) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

router.get('/brief', async (req, res) => {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));

    const now = new Date();
    const periodEnd = toDateStr(now);
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - (days - 1));
    const periodStart = toDateStr(startDate);

    const rows = await fetchPublications(periodStart, periodEnd);
    const publishedCount = rows.length;

    if (publishedCount === 0) {
        return res.json({
            status: 'insufficient_data',
            periodStart,
            periodEnd,
            days,
            publishedCount: 0,
            message: `No publications with data found between ${periodStart} and ${periodEnd}. Nothing to analyze yet.`,
        });
    }

    // byFormat
    const byFormatGroups = groupAggregate(rows, pickFormat);
    const byFormat = [...byFormatGroups.entries()]
        .map(([format, items]) => ({
            format,
            count: items.length,
            avgViews: avg(items.map(r => r.metrics_views || 0)),
            avgSaves: avg(items.map(r => r.metrics_saves || 0)),
            avgClicks: avg(items.map(r => r.metrics_clicks || 0)),
        }))
        .sort((a, b) => b.avgViews - a.avgViews);

    // byProduct (best-effort, see pickProduct)
    const byProductGroups = groupAggregate(rows, pickProduct);
    const byProduct = [...byProductGroups.entries()]
        .map(([product, items]) => ({
            product,
            count: items.length,
            avgViews: avg(items.map(r => r.metrics_views || 0)),
            avgSaves: avg(items.map(r => r.metrics_saves || 0)),
        }))
        .sort((a, b) => b.avgViews - a.avgViews);
    const productAttributedCount = [...byProductGroups.values()].reduce((n, items) => n + items.length, 0);

    // rubricPerformance - only ideas with a rubric_id, joined to content_rubrics for a readable name
    const rubricRows = rows.filter(r => r.rubric_id);
    let rubricPerformance = [];
    if (rubricRows.length > 0) {
        const rubricIds = [...new Set(rubricRows.map(r => r.rubric_id))];
        const placeholders = rubricIds.map(() => '?').join(',');
        const rubricNamesRes = await db.execute({
            sql: `SELECT id, name FROM content_rubrics WHERE id IN (${placeholders})`,
            args: rubricIds,
        });
        const nameById = {};
        rubricNamesRes.rows.forEach(r => { nameById[r.id] = r.name; });

        const byRubricGroups = groupAggregate(rubricRows, r => r.rubric_id);
        rubricPerformance = [...byRubricGroups.entries()]
            .map(([rubricId, items]) => ({
                rubricId,
                rubricName: nameById[rubricId] || rubricId,
                count: items.length,
                avgViews: avg(items.map(r => r.metrics_views || 0)),
                avgSaves: avg(items.map(r => r.metrics_saves || 0)),
            }))
            .sort((a, b) => b.avgViews - a.avgViews);
    }

    // top/underperformers by views
    const toPerformerShape = (r) => ({
        ideaId: r.idea_id,
        title: r.title,
        format: pickFormat(r),
        platform: r.platform || 'telegram',
        rawDate: r.raw_date,
        views: r.metrics_views || 0,
        saves: r.metrics_saves || 0,
        clicks: r.metrics_clicks || 0,
    });
    const sortedByViewsDesc = [...rows].sort((a, b) => (b.metrics_views || 0) - (a.metrics_views || 0));
    const topPerformers = sortedByViewsDesc.slice(0, 5).map(toPerformerShape);
    const underperformers = sortedByViewsDesc
        .slice()
        .reverse()
        .slice(0, 5)
        .map(toPerformerShape);

    const totalViews = rows.reduce((n, r) => n + (r.metrics_views || 0), 0);
    const allMetricsZero = totalViews === 0 && rows.every(r => !(r.metrics_saves || 0) && !(r.metrics_clicks || 0));

    res.json({
        status: 'ok',
        periodStart,
        periodEnd,
        days,
        publishedCount,
        // True when every publication in the window still has zero metrics
        // (e.g. the metrics-sync job hasn't populated real numbers yet).
        // Averages/top-performers below are still computed but will all read
        // as zero/tied - a consuming agent should treat that as "no signal
        // yet" rather than "everything performed equally badly".
        metricsPending: allMetricsZero,
        byFormat,
        byProduct,
        byProductNote: 'Best-effort: only agent-authored ideas whose agentMeta carries a targetProduct are attributed. ' +
            `${productAttributedCount} of ${publishedCount} publications in this window were attributable to a product.`,
        topPerformers,
        underperformers,
        rubricPerformance,
    });
});

// The future Insights cloud routine (see docs/insights-agent-routine.md) POSTs
// its conclusions here after reading GET /brief. Stored via the same
// agent_runs table Researcher uses (agent_name distinguishes the rows), with
// the structured payload in brief_json - that column name is a historical
// leftover from Researcher's "trend brief" use case, but the table/column
// pattern (run_date, agent_name, status, log, brief_json) is generic enough
// to reuse as-is here rather than adding a parallel table/column.
router.post('/conclusions', async (req, res) => {
    const b = req.body || {};
    const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
    const recommendations = Array.isArray(b.recommendations) ? b.recommendations : [];

    if (!summary) {
        return res.status(400).json({ error: 'summary is required' });
    }

    const runDate = new Date().toISOString().slice(0, 10);
    const payload = {
        summary,
        recommendations,
        generatedAt: Date.now(),
    };

    await db.execute({
        sql: `INSERT INTO agent_runs (run_date, agent_name, status, log, brief_json) VALUES (?, 'insights', 'success', ?, ?)`,
        args: [runDate, summary, JSON.stringify(payload)],
    });

    res.status(201).json({ ok: true, runDate });
});

// Mirrors GET /api/agent-researcher/latest-brief exactly: 404 with the same
// { error } shape when no successful run has been stored yet.
router.get('/latest', async (req, res) => {
    const result = await db.execute(
        "SELECT run_date, brief_json FROM agent_runs WHERE agent_name = 'insights' AND status = 'success' AND brief_json IS NOT NULL ORDER BY id DESC LIMIT 1"
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'no successful insights run yet' });
    res.json(JSON.parse(row.brief_json));
});

export default router;
