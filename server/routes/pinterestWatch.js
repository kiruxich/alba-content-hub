import { Router } from 'express';
import Parser from 'rss-parser';
import { db } from '../db.js';

const router = Router();
const rssParser = new Parser({ timeout: 10000 });

// Manually-curated watch list (server/db.js's pinterest_watch_boards) - same
// reasoning as telegram_watch_channels/instagram_watch_accounts: Pinterest
// has no open search API, so competitor boards have to be found by the user
// browsing Pinterest themselves. Unlike Instagram though, Pinterest exposes a
// public, tokenless RSS feed per profile/board, so scanning reuses the same
// rss-parser dependency as agent_settings.sources instead of needing OAuth.
router.get('/boards', async (req, res) => {
    const result = await db.execute('SELECT id, path, label, created_at FROM pinterest_watch_boards ORDER BY created_at ASC');
    res.json(result.rows.map(r => ({ id: r.id, path: r.path, label: r.label || '', createdAt: r.created_at })));
});

router.post('/boards', async (req, res) => {
    const path = String(req.body?.path || '').trim()
        .replace(/^@/, '')
        .replace(/^https?:\/\/([a-z]{2,3}\.)?pinterest\.[a-z.]+\//i, '')
        .replace(/\/+$/, '');
    const label = String(req.body?.label || '').trim();
    if (!path) return res.status(400).json({ error: 'Укажите профиль или борд (например username или username/board)' });

    const existing = await db.execute({ sql: 'SELECT id FROM pinterest_watch_boards WHERE path = ?', args: [path] });
    if (existing.rows.length) return res.status(409).json({ error: 'Этот борд уже в списке' });

    const result = await db.execute({
        sql: 'INSERT INTO pinterest_watch_boards (path, label) VALUES (?, ?)',
        args: [path, label],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), path, label, createdAt: Math.floor(Date.now() / 1000) });
});

router.delete('/boards/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM pinterest_watch_boards WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

// Live scan on demand only, same as Telegram/Instagram watch - nothing is
// cached/persisted server-side, always a fresh fetch of each board's feed.
router.post('/scan', async (req, res) => {
    const boards = await db.execute('SELECT path, label FROM pinterest_watch_boards ORDER BY created_at ASC');
    if (boards.rows.length === 0) return res.status(400).json({ error: 'Список бордов пуст - сначала добавьте хотя бы один' });

    const limit = Math.min(Number(req.body?.limit) || 10, 25);
    const results = await Promise.all(boards.rows.map(async (row) => {
        const path = row.path;
        try {
            const feed = await rssParser.parseURL(`https://www.pinterest.com/${path}.rss`);
            const posts = (feed.items || []).slice(0, limit).map(item => ({
                title: item.title || '',
                link: item.link || null,
                pubDate: item.pubDate || item.isoDate || null,
                image: item.enclosure?.url || null,
            }));
            return { path, label: row.label || feed.title || path, posts, error: null };
        } catch (e) {
            return { path, label: row.label || path, posts: [], error: e.message };
        }
    }));
    res.json({ boards: results });
});

export default router;
