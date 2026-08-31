import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// One-time upgrade path for blocks saved before the timeline UI existed:
// the old shape had no `kind`/`period`, just {id, title, color, text}.
// q1-q4 become 'quarter' entries with their product name pulled out of the
// old combined title; everything else becomes a 'note'.
const LEGACY_QUARTER_META = {
    q1: { title: 'ДУЭТ', period: 'Январь — Март' },
    q2: { title: 'InSights', period: 'Апрель — Июнь' },
    q3: { title: '«Хранитель»', period: 'Июль — Сентябрь' },
    q4: { title: 'Crista & Фантазия', period: 'Октябрь — Декабрь' },
};

function migrateBlock(b) {
    if (b.kind === 'quarter' || b.kind === 'note') return b;
    const meta = LEGACY_QUARTER_META[b.id];
    if (meta) {
        return { id: b.id, kind: 'quarter', title: meta.title, period: meta.period, color: b.color, text: b.text };
    }
    return { id: b.id, kind: 'note', title: b.title, color: b.color, text: b.text };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT blocks FROM content_plan WHERE id = 1');
    const blocks = JSON.parse(result.rows[0]?.blocks || '[]').map(migrateBlock);
    res.json({ blocks });
});

router.put('/', async (req, res) => {
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    await db.execute({ sql: 'UPDATE content_plan SET blocks = ? WHERE id = 1', args: [JSON.stringify(blocks)] });
    res.json({ blocks });
});

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Month index (0-11) -> which quarter block's period it likely falls in.
// Periods are free-text ("Январь — Март"), not real dates, so this is a
// best-effort match on the standard Jan-Mar/Apr-Jun/Jul-Sep/Oct-Dec split -
// if a quarter's period text has been edited to something else, this still
// falls back sanely (just won't find a match for that one).
const QUARTER_MONTH_RANGES = [
    { months: [0, 1, 2], match: /янв|февр|март/i },
    { months: [3, 4, 5], match: /апрел|май|июн/i },
    { months: [6, 7, 8], match: /июл|август|сентябр/i },
    { months: [9, 10, 11], match: /октябр|ноябр|декабр/i },
];

// Shared by GET /context below and server/routes/contentDrafts.js's
// suggest-topic (folds the same briefing into "Подобрать тему" so its
// "why relevant" can reference the current goal/quarter, not just news).
export async function buildContentPlanContext() {
    const [planResult, settingsResult] = await Promise.all([
        db.execute('SELECT blocks FROM content_plan WHERE id = 1'),
        db.execute('SELECT weekly_schedule FROM agent_settings WHERE id = 1'),
    ]);
    const blocks = JSON.parse(planResult.rows[0]?.blocks || '[]').map(migrateBlock);
    const weeklySchedule = JSON.parse(settingsResult.rows[0]?.weekly_schedule || '[]');

    const goal = blocks.find(b => b.id === 'goal' || (b.kind === 'note' && /бизнес-цел/i.test(b.title || '')));
    const distribution = blocks.find(b => b.id === 'distribution' || (b.kind === 'note' && /дистрибуц/i.test(b.title || '')));

    const now = new Date();
    const monthIdx = now.getMonth();
    const quarterRange = QUARTER_MONTH_RANGES.find(r => r.months.includes(monthIdx));
    const currentQuarter = quarterRange
        ? blocks.find(b => b.kind === 'quarter' && quarterRange.match.test(b.period || ''))
        : null;

    const todayKey = WEEKDAY_KEYS[now.getDay()];
    const todayFocus = weeklySchedule.find(d => d.day === todayKey);

    const lines = [];
    if (goal?.text) lines.push(`Главная бизнес-цель: ${goal.text}`);
    if (distribution?.text) lines.push(`Модель дистрибуции: ${distribution.text}`);
    if (currentQuarter) lines.push(`Текущий фокус квартала (${currentQuarter.period}) — ${currentQuarter.title}: ${currentQuarter.text}`);
    if (todayFocus?.focus) lines.push(`Фокус сегодняшнего дня (${todayFocus.label}): ${todayFocus.focus}`);

    return lines.join('\n\n');
}

// GET /api/content-plan/context - a compact, always-current strategic
// briefing assembled from this page's own data (goal/distribution notes +
// whichever quarter matches today's month) plus agent_settings' weekly
// schedule (today's day-of-week product focus). Meant to be fetched by the
// Generator routine (a Claude Code routine, not this backend - see
// server/routes/agentResearcher.js's similar comment) so that editing the
// Контент-план page actually changes what Generator sees on its next run,
// instead of requiring someone to manually copy text into generator_prompt.
router.get('/context', async (req, res) => {
    const context = await buildContentPlanContext();
    res.json({ context, asOf: new Date().toISOString() });
});

export default router;
