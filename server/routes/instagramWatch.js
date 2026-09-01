import { Router } from 'express';
import { db } from '../db.js';

const router = Router();
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Manually-curated watch list (server/db.js's instagram_watch_accounts) -
// deliberately separate from RSS/agent_settings, same reasoning as
// telegram_watch_channels: Instagram has no open discovery API, competitor
// accounts have to be found by the user browsing Instagram themselves, so
// this list must never be wiped by any RSS save/discover action.
router.get('/accounts', async (req, res) => {
    const result = await db.execute('SELECT id, username, label, created_at FROM instagram_watch_accounts ORDER BY created_at ASC');
    res.json(result.rows.map(r => ({ id: r.id, username: r.username, label: r.label || '', createdAt: r.created_at })));
});

router.post('/accounts', async (req, res) => {
    const username = String(req.body?.username || '').trim().replace(/^@/, '');
    const label = String(req.body?.label || '').trim();
    if (!username) return res.status(400).json({ error: 'username обязателен' });

    const existing = await db.execute({ sql: 'SELECT id FROM instagram_watch_accounts WHERE username = ?', args: [username] });
    if (existing.rows.length) return res.status(409).json({ error: 'Этот аккаунт уже в списке' });

    const result = await db.execute({
        sql: 'INSERT INTO instagram_watch_accounts (username, label) VALUES (?, ?)',
        args: [username, label],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), username, label, createdAt: Math.floor(Date.now() / 1000) });
});

router.delete('/accounts/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM instagram_watch_accounts WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

// Live scan on demand only - Business Discovery only works for a KNOWN
// username (no open search/discovery on Instagram's API, unlike VK/YouTube -
// see docs/inst.md), and needs OUR OWN configured Instagram Business
// account + a valid Page access token (either language's row works, this is
// read-only). Nothing is cached/persisted server-side, same as Telegram
// watch - always a fresh call.
router.post('/scan', async (req, res) => {
    const accounts = await db.execute('SELECT username FROM instagram_watch_accounts ORDER BY created_at ASC');
    const usernames = accounts.rows.map(r => r.username);
    if (usernames.length === 0) return res.status(400).json({ error: 'Список аккаунтов пуст - сначала добавьте хотя бы один' });

    const settingsRow = (await db.execute("SELECT access_token, business_account_id FROM instagram_settings WHERE lang = 'ru' AND access_token != ''")).rows[0]
        || (await db.execute("SELECT access_token, business_account_id FROM instagram_settings WHERE lang = 'en' AND access_token != ''")).rows[0];
    if (!settingsRow) return res.status(400).json({ error: 'Instagram не настроен (ни RU, ни EN аккаунт) - см. docs/inst.md' });

    const limit = Math.min(Number(req.body?.limit) || 10, 25);
    const results = [];
    for (const username of usernames) {
        try {
            const fields = `business_discovery.username(${username}){username,followers_count,media_count,media.limit(${limit}){caption,like_count,comments_count,timestamp,permalink,media_url,media_type}}`;
            const url = new URL(`${GRAPH_API_BASE}/${settingsRow.business_account_id}`);
            url.searchParams.set('fields', fields);
            url.searchParams.set('access_token', settingsRow.access_token);
            const data = await (await fetch(url)).json();
            if (data.error) throw new Error(data.error.message || `Instagram API error ${data.error.code || ''}`);

            const bd = data.business_discovery;
            const posts = (bd?.media?.data || []).map(m => ({
                caption: m.caption || '',
                likeCount: m.like_count ?? null,
                commentsCount: m.comments_count ?? null,
                timestamp: m.timestamp || null,
                link: m.permalink || null,
                mediaUrl: m.media_url || null,
                mediaType: m.media_type || null,
            }));
            results.push({ username, followersCount: bd?.followers_count ?? null, posts, error: null });
        } catch (e) {
            results.push({ username, followersCount: null, posts: [], error: e.message });
        }
    }
    res.json({ accounts: results });
});

export default router;
