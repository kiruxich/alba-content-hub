import { db } from '../db.js';

// Reads agent_settings.budget_daily_cap_usd and compares it against today's
// total spend from agent_expenses (same "today" definition as the
// /api/agent-expenses/summary endpoint's `today` query - kept identical on
// purpose so the cap check and the Cost Tracker UI never disagree about what
// "today" spent means).
//
// A cap of 0, null, or unset is treated as "no cap" (not "block everything")
// since that's both the natural reading of an empty budget field and safer
// as a default - nothing currently writes real spend into agent_expenses, so
// treating unset-cap as a hard block would silently freeze every agent run.
export async function checkBudgetCap() {
    const settingsResult = await db.execute('SELECT budget_daily_cap_usd FROM agent_settings WHERE id = 1');
    const capUsd = settingsResult.rows[0]?.budget_daily_cap_usd ?? null;

    const todayResult = await db.execute(`
        SELECT COALESCE(SUM(total_usd), 0) as total FROM agent_expenses
        WHERE date(timestamp, 'unixepoch') = date('now')
    `);
    const spentTodayUsd = todayResult.rows[0].total;

    const hasCap = capUsd !== null && capUsd !== undefined && Number(capUsd) > 0;
    const exceeded = hasCap && Number(spentTodayUsd) >= Number(capUsd);

    return {
        capUsd: hasCap ? Number(capUsd) : null,
        spentTodayUsd: Number(spentTodayUsd),
        exceeded,
    };
}
