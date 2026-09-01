import { db } from '../db.js';
import { publishIdea } from './publishIdea.js';

// Auto-publishes calendar entries once their scheduled publish_at time
// arrives (see the schedule modal in app.js, which now captures platform/
// channel/board/lang/time up front instead of leaving publishing as a
// separate manual step). Runs as an in-process interval started from
// server/index.js, not an external VPS cron entry (unlike metrics-sync's
// documented cron setup) - the hub process itself is always running once
// deployed, so this needs no separate server-side setup step, and it works
// "even with nobody's browser open" simply because the check doesn't depend
// on a browser at all.
//
// Calls publishIdea() directly in-process rather than hitting the hub's own
// /api/telegram/post or /api/publish/:platform routes over HTTP - those
// routes sit behind requireAuth, which would 401 a plain loopback fetch()
// in production (no session cookie to send). Direct in-process calls avoid
// that entirely.
const CHECK_INTERVAL_MS = 60 * 1000;

export async function runDueCalendarPublishes() {
    const now = Math.floor(Date.now() / 1000);
    const result = await db.execute({
        sql: `SELECT * FROM scheduled_events WHERE publish_status = 'pending' AND publish_at IS NOT NULL AND publish_at <= ?`,
        args: [now],
    });

    for (const row of result.rows) {
        try {
            const published = await publishIdea(row.platform || 'telegram', {
                ideaId: row.idea_id,
                channelId: row.channel_id,
                boardId: row.board_id,
                groupId: row.vk_group_id,
                lang: row.lang || 'ru',
            });
            await db.execute({
                sql: `UPDATE scheduled_events SET publish_status = 'published', external_post_id = COALESCE(?, external_post_id) WHERE id = ?`,
                args: [published.externalPostId || null, row.id],
            });
        } catch (e) {
            console.error(`calendarScheduler: publish failed for scheduled_events id=${row.id}:`, e.message);
            await db.execute({
                sql: `UPDATE scheduled_events SET publish_status = 'failed', publish_error = ? WHERE id = ?`,
                args: [e.message, row.id],
            });
        }
    }
    return result.rows.length;
}

export function startCalendarScheduler() {
    setInterval(() => {
        runDueCalendarPublishes().catch(e => console.error('calendarScheduler: tick failed:', e));
    }, CHECK_INTERVAL_MS);
    console.log('calendarScheduler: started (checking every 60s)');
}
