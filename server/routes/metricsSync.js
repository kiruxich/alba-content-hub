import { Router } from 'express';
import { syncMetrics } from '../lib/metricsSync.js';

const router = Router();

// Pulls view/engagement metrics back from each platform (VK, Instagram,
// YouTube; Telegram is a documented no-op - see server/lib/metricsSync.js)
// for scheduled_events rows with an external_post_id, and writes them back.
//
// Not wired to a cron yet - this project's crons live as /etc/cron.d/* files
// on the VPS (set up over SSH, out of scope here), mirroring the existing
// /etc/cron.d/alba-researcher entry. Suggested cadence: every 6 hours,
// matching SYNC_INTERVAL_SECONDS in metricsSync.js, e.g.:
//   0 */6 * * * root curl -fsS -X POST http://localhost:<port>/api/metrics-sync/run
// (adjust host/port to match how alba-researcher's cron entry invokes its
// own /run endpoint).
router.post('/run', async (req, res) => {
    try {
        const byPlatform = await syncMetrics();
        const platforms = Object.keys(byPlatform);
        const updated = platforms.reduce((sum, p) => sum + (byPlatform[p].updated || 0), 0);
        const skipped = platforms.reduce((sum, p) => sum + (byPlatform[p].skipped || 0), 0);

        // success: synced at least one row. skipped: nothing was due, or
        // every platform found something to sync but had nothing configured/
        // nothing to update. failed only on an unexpected exception (below).
        const status = updated > 0 ? 'success' : 'skipped';

        res.json({ status, updated, skipped, byPlatform });
    } catch (e) {
        console.error('metrics-sync run failed:', e);
        res.status(500).json({ status: 'failed', error: e.message });
    }
});

export default router;
