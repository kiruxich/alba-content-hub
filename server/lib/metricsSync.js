import { db } from '../db.js';

// Phase 3: pulls view/engagement metrics BACK from each platform for posts
// that already went out (external_post_id set by the publish flow - see
// server/routes/telegram.js for the Telegram side; VK/Instagram/YouTube
// publishers are a separate, parallel piece of work) and writes them into
// scheduled_events. This is the read-back half; server/routes/events.js's
// existing PUT /:id already accepts metrics writes, but nothing calls it
// automatically today - this module is what's meant to drive it going
// forward (see syncMetrics() below, which updates scheduled_events directly
// rather than round-tripping through HTTP).

// How often a synced row gets refreshed. Chosen to balance freshness against
// API quota usage - YouTube's Data API in particular has a modest daily
// quota, and social metrics rarely move enough hour-to-hour to justify
// polling more often for posts that are more than a few hours old.
const SYNC_INTERVAL_SECONDS = 6 * 60 * 60; // 6 hours

// --- credentials -------------------------------------------------------
// Same settings-lookup pattern as server/routes/telegram.js (telegram_settings)
// and server/lib/telegramApproval.js: secrets live in the DB, never in the
// browser. VK/Instagram/YouTube don't have their own settings tables yet in
// this codebase, so this reads the generic `platform_connections` table that
// already exists in server/db.js (platform, access_token, refresh_token,
// expires_at, status, account_name, connected_at) - it was added ahead of
// this task and looks like the intended home for these tokens; the parallel
// publish-side task should end up writing to the same table (or writing to
// platform-specific tables), in which case this lookup will need small
// tweaks. If a platform-specific settings table shows up later, swap the
// lookup below rather than the calling code.
async function getPlatformConnection(platform) {
    try {
        const res = await db.execute({
            sql: 'SELECT access_token, refresh_token, status, account_name FROM platform_connections WHERE platform = ?',
            args: [platform],
        });
        return res.rows[0] || null;
    } catch (e) {
        // Defensive: don't let a missing/renamed table take down the whole
        // sync run for every other platform.
        console.debug(`metricsSync: platform_connections lookup failed for "${platform}":`, e.message);
        return null;
    }
}

async function updateEventMetrics(id, { views, saves, clicks }) {
    await db.execute({
        sql: `UPDATE scheduled_events
              SET metrics_views = ?, metrics_saves = ?, metrics_clicks = ?, metrics_synced_at = strftime('%s','now')
              WHERE id = ?`,
        args: [Math.round(views || 0), Math.round(saves || 0), Math.round(clicks || 0), id],
    });
}

// --- Telegram ------------------------------------------------------------
// Researched for this task: the Bot API has no method that returns a channel
// post's view count. That number (MTProto's Message.views) only exists on
// Telegram's client API, which needs a full logged-in user/MTProto session
// (e.g. via Telethon or GramJS) - not something a bot token can do, and not
// something this server should be doing (it would mean holding a personal
// account session, a very different trust/security shape than a bot token).
// getChatMessageCount and friends don't help either - they count messages,
// not views. So there is genuinely nothing to sync here today; this isn't a
// missing-credentials situation, it's an API capability gap. Skipping by
// design, not by accident - revisit only if an MTProto-based reader is ever
// deliberately added as its own, separately-secured component.
async function fetchTelegramMetrics(rows) {
    console.debug(`metricsSync: skipping Telegram sync for ${rows.length} row(s) - the Bot API does not expose post view counts`);
    return { updated: 0, skipped: rows.length, reason: 'not_supported_by_bot_api' };
}

// --- VK --------------------------------------------------------------------
// wall.getById returns likes/views/reposts/comments as {count} objects for a
// batch of posts in one call, addressed as "<owner_id>_<post_id>" strings -
// external_post_id must already be stored in that exact shape by the VK
// publisher for this to line up.
//
// Metric mapping (VK has no literal "saves" or "clicks" concept on a wall
// post, so the two closest proxies are used - documented so this doesn't
// look like an oversight later):
//   metrics_views  <- views.count   (literal match)
//   metrics_saves  <- likes.count   (proxy: nearest thing to a "save"/
//                                    appreciation signal VK exposes here)
//   metrics_clicks <- reposts.count (proxy: nearest thing to a click-through/
//                                    distribution signal; VK's real link-click
//                                    stats live behind the separate, ads-only
//                                    Statistics API, not wall.getById)
const VK_API_VERSION = '5.199';

async function fetchVkMetrics(rows) {
    const conn = await getPlatformConnection('vk');
    if (!conn?.access_token) {
        console.debug('metricsSync: skipping VK sync - no access_token in platform_connections (platform="vk")');
        return { updated: 0, skipped: rows.length, reason: 'missing_credentials' };
    }

    const byExternalId = {};
    rows.forEach(r => { byExternalId[r.external_post_id] = r; });

    let updated = 0;
    // wall.getById accepts a large batch, but keep it conservative (VK
    // itself caps "posts" around a few hundred IDs per call).
    const ids = Object.keys(byExternalId);
    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const url = new URL('https://api.vk.com/method/wall.getById');
        url.searchParams.set('posts', batch.join(','));
        url.searchParams.set('access_token', conn.access_token);
        url.searchParams.set('v', VK_API_VERSION);

        let data;
        try {
            const resp = await fetch(url);
            data = await resp.json();
        } catch (e) {
            console.debug('metricsSync: VK request failed:', e.message);
            continue;
        }
        if (data.error) {
            console.debug('metricsSync: VK API error:', data.error.error_msg || data.error);
            continue;
        }
        for (const post of data.response || []) {
            const key = `${post.owner_id}_${post.id}`;
            const row = byExternalId[key];
            if (!row) continue;
            await updateEventMetrics(row.id, {
                views: post.views?.count ?? row.metrics_views,
                saves: post.likes?.count ?? row.metrics_saves,
                clicks: post.reposts?.count ?? row.metrics_clicks,
            });
            updated++;
        }
    }
    return { updated, skipped: rows.length - updated, reason: updated < rows.length ? 'not_found_or_api_error' : null };
}

// --- Instagram ---------------------------------------------------------
// GET /<IG_MEDIA_ID>/insights on the Graph API, using the same Page/Business
// access token the publish flow uses. `impressions` was deprecated as a
// media-insights metric in Graph API v22 in favor of `views`, so this reads
// `views` (falling back to `reach` if a given media object doesn't return
// it, e.g. against an older API version still in use).
//
// Metric mapping:
//   metrics_views  <- views (fallback: reach)   (literal-ish match)
//   metrics_saves  <- saved                     (literal match - IG's
//                                                 "saved" metric IS a save)
//   metrics_clicks <- shares                    (proxy: IG's media insights
//                                                 have no organic link-click
//                                                 metric; "shares" is the
//                                                 closest distribution signal
//                                                 available without the
//                                                 ads-only Marketing API)
async function fetchInstagramMetrics(rows) {
    const conn = await getPlatformConnection('instagram');
    if (!conn?.access_token) {
        console.debug('metricsSync: skipping Instagram sync - no access_token in platform_connections (platform="instagram")');
        return { updated: 0, skipped: rows.length, reason: 'missing_credentials' };
    }

    let updated = 0;
    for (const row of rows) {
        try {
            const url = new URL(`https://graph.instagram.com/${row.external_post_id}/insights`);
            url.searchParams.set('metric', 'views,reach,saved,shares');
            url.searchParams.set('access_token', conn.access_token);
            const resp = await fetch(url);
            const data = await resp.json();
            if (data.error) {
                console.debug(`metricsSync: Instagram insights error for ${row.external_post_id}:`, data.error.message || data.error);
                continue;
            }
            const byName = {};
            for (const m of data.data || []) {
                byName[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
            }
            await updateEventMetrics(row.id, {
                views: byName.views ?? byName.reach ?? row.metrics_views,
                saves: byName.saved ?? row.metrics_saves,
                clicks: byName.shares ?? row.metrics_clicks,
            });
            updated++;
        } catch (e) {
            console.debug(`metricsSync: Instagram fetch failed for ${row.external_post_id}:`, e.message);
        }
    }
    return { updated, skipped: rows.length - updated, reason: updated < rows.length ? 'not_found_or_api_error' : null };
}

// --- YouTube -----------------------------------------------------------
// videos.list?part=statistics&id=... returns viewCount/likeCount/commentCount
// per video, up to 50 IDs per call. Read access to a public video's stats
// only needs an API key (no OAuth) - so this prefers YOUTUBE_API_KEY when
// set, and only falls back to the same OAuth token the publish flow uses
// (platform_connections.access_token) if no API key is configured. That's
// the one credential path in this file that isn't the platform_connections
// lookup by default; documenting it here so it doesn't look inconsistent.
//
// Metric mapping (YouTube has no "saves" metric available to a normal API
// key/OAuth token - "favorited" exists in the schema but Google froze it at
// 0 for all videos years ago, so it's not used):
//   metrics_views  <- statistics.viewCount     (literal match)
//   metrics_saves  <- statistics.likeCount     (proxy: nearest positive-
//                                                signal metric available)
//   metrics_clicks <- statistics.commentCount  (proxy: nearest engagement-
//                                                driven-navigation metric;
//                                                YouTube's real click-through
//                                                stats live in YouTube
//                                                Analytics API, which needs
//                                                channel-owner OAuth, not
//                                                just a video ID)
async function getYoutubeCredentials() {
    if (process.env.YOUTUBE_API_KEY) return { type: 'api_key', value: process.env.YOUTUBE_API_KEY };
    const conn = await getPlatformConnection('youtube');
    if (conn?.access_token) return { type: 'oauth', value: conn.access_token };
    return null;
}

async function fetchYoutubeMetrics(rows) {
    const creds = await getYoutubeCredentials();
    if (!creds) {
        console.debug('metricsSync: skipping YouTube sync - no YOUTUBE_API_KEY env var and no access_token in platform_connections (platform="youtube")');
        return { updated: 0, skipped: rows.length, reason: 'missing_credentials' };
    }

    const byId = {};
    rows.forEach(r => { byId[r.external_post_id] = r; });
    const ids = Object.keys(byId);

    let updated = 0;
    for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const url = new URL('https://www.googleapis.com/youtube/v3/videos');
        url.searchParams.set('part', 'statistics');
        url.searchParams.set('id', batch.join(','));
        const headers = {};
        if (creds.type === 'api_key') url.searchParams.set('key', creds.value);
        else headers.Authorization = `Bearer ${creds.value}`;

        let data;
        try {
            const resp = await fetch(url, { headers });
            data = await resp.json();
        } catch (e) {
            console.debug('metricsSync: YouTube request failed:', e.message);
            continue;
        }
        if (data.error) {
            console.debug('metricsSync: YouTube API error:', data.error.message || data.error);
            continue;
        }
        for (const item of data.items || []) {
            const row = byId[item.id];
            if (!row) continue;
            await updateEventMetrics(row.id, {
                views: Number(item.statistics?.viewCount ?? row.metrics_views),
                saves: Number(item.statistics?.likeCount ?? row.metrics_saves),
                clicks: Number(item.statistics?.commentCount ?? row.metrics_clicks),
            });
            updated++;
        }
    }
    return { updated, skipped: rows.length - updated, reason: updated < rows.length ? 'not_found_or_api_error' : null };
}

// --- Pinterest -----------------------------------------------------------
// Pinterest API v5's pin analytics endpoint (GET /pins/{id}/analytics) needs
// a date range and returns per-day buckets, not a single running total -
// this sums across a wide window (since well before this app existed) so
// the result reads as a cumulative total, same shape as the other
// platforms' metrics_views/saves/clicks. Credentials live in their own
// pinterest_settings table (server/routes/settings.js), not the generic
// platform_connections table the other three platforms share - Pinterest's
// publish flow was built with its own settings table for board_id, so this
// reads from the same place rather than introducing a second source of truth.
//
// Metric mapping:
//   metrics_views  <- IMPRESSION  (literal match - times the Pin was shown)
//   metrics_saves  <- SAVE        (literal match - Pinterest's own "save"
//                                   concept, not a proxy like on other platforms)
//   metrics_clicks <- PIN_CLICK   (literal match - clicks on the Pin itself)
async function fetchPinterestMetrics(rows) {
    const conn = (await db.execute('SELECT access_token FROM pinterest_settings WHERE id = 1')).rows[0];
    if (!conn?.access_token) {
        console.debug('metricsSync: skipping Pinterest sync - no access_token in pinterest_settings');
        return { updated: 0, skipped: rows.length, reason: 'missing_credentials' };
    }

    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let updated = 0;
    for (const row of rows) {
        try {
            const url = new URL(`https://api.pinterest.com/v5/pins/${row.external_post_id}/analytics`);
            url.searchParams.set('start_date', startDate);
            url.searchParams.set('end_date', endDate);
            url.searchParams.set('metric_types', 'IMPRESSION,SAVE,PIN_CLICK');
            const resp = await fetch(url, { headers: { Authorization: `Bearer ${conn.access_token}` } });
            const data = await resp.json();
            if (!resp.ok) {
                console.debug(`metricsSync: Pinterest analytics error for ${row.external_post_id}:`, data.message || data.error || resp.status);
                continue;
            }
            const sumMetric = name => {
                const daily = data.all?.daily_metrics || [];
                return daily.reduce((sum, day) => sum + (day.data_status === 'READY' ? (day.metrics?.[name] || 0) : 0), 0);
            };
            await updateEventMetrics(row.id, {
                views: sumMetric('IMPRESSION') || row.metrics_views,
                saves: sumMetric('SAVE') || row.metrics_saves,
                clicks: sumMetric('PIN_CLICK') || row.metrics_clicks,
            });
            updated++;
        } catch (e) {
            console.debug(`metricsSync: Pinterest fetch failed for ${row.external_post_id}:`, e.message);
        }
    }
    return { updated, skipped: rows.length - updated, reason: updated < rows.length ? 'not_found_or_api_error' : null };
}

const FETCHERS = {
    telegram: fetchTelegramMetrics,
    vk: fetchVkMetrics,
    instagram: fetchInstagramMetrics,
    youtube: fetchYoutubeMetrics,
    pinterest: fetchPinterestMetrics,
};

// Pulls metrics for every scheduled_events row that has an external_post_id
// and is due for a refresh (never synced, or synced more than
// SYNC_INTERVAL_SECONDS ago), grouped by platform, and writes
// metrics_views/metrics_saves/metrics_clicks/metrics_synced_at back.
//
// Never throws for a single platform's failure - each platform's fetcher is
// isolated so one platform being misconfigured or erroring doesn't stop the
// others from syncing. Returns a per-platform summary; the /run route turns
// this into the HTTP response.
export async function syncMetrics() {
    const staleCutoff = Math.floor(Date.now() / 1000) - SYNC_INTERVAL_SECONDS;
    const result = await db.execute({
        sql: `SELECT * FROM scheduled_events
              WHERE external_post_id IS NOT NULL AND external_post_id != ''
              AND (metrics_synced_at IS NULL OR metrics_synced_at < ?)`,
        args: [staleCutoff],
    });

    const byPlatform = {};
    for (const row of result.rows) {
        const platform = row.platform || 'telegram';
        (byPlatform[platform] ||= []).push(row);
    }

    const summary = {};
    for (const [platform, platformRows] of Object.entries(byPlatform)) {
        const fetcher = FETCHERS[platform];
        if (!fetcher) {
            console.debug(`metricsSync: no metrics fetcher for platform "${platform}" - skipping ${platformRows.length} row(s)`);
            summary[platform] = { updated: 0, skipped: platformRows.length, reason: 'unsupported_platform' };
            continue;
        }
        try {
            summary[platform] = await fetcher(platformRows);
        } catch (e) {
            console.error(`metricsSync: ${platform} sync failed:`, e);
            summary[platform] = { updated: 0, skipped: platformRows.length, reason: 'error', error: e.message };
        }
    }
    return summary;
}
