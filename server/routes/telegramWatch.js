import { Router } from 'express';
import { db } from '../db.js';
import { validateTelegramWatchChannel, scanTelegramWatchChannels, isLocalClaudeAgentConfigured } from '../lib/localClaudeAgent.js';

const router = Router();

// Manually-curated watch list (server/db.js's telegram_watch_channels) - kept
// entirely separate from agent_settings.sources (RSS) so nothing here is
// ever touched by saveAgentSettingsForm()/discoverRssSources(). See
// local-claude-agent/README.md "Telegram source watching" for why this
// needs a real Telegram user session on the user's own Mac.
router.get('/channels', async (req, res) => {
    const result = await db.execute('SELECT id, username, label, created_at FROM telegram_watch_channels ORDER BY created_at ASC');
    res.json(result.rows.map(r => ({ id: r.id, username: r.username, label: r.label || '', createdAt: r.created_at })));
});

router.post('/channels', async (req, res) => {
    const username = String(req.body?.username || '').trim().replace(/^@/, '');
    const label = String(req.body?.label || '').trim();
    if (!username) return res.status(400).json({ error: 'username обязателен' });

    const existing = await db.execute({ sql: 'SELECT id FROM telegram_watch_channels WHERE username = ?', args: [username] });
    if (existing.rows.length) return res.status(409).json({ error: 'Этот канал уже в списке' });

    // Validate via the live session if it's configured - if the Mac/tunnel
    // isn't up right now, don't block adding the channel (the user may add
    // several while planning, before ever running a scan) - just skip the
    // check silently in that case.
    let resolvedTitle = '';
    if (isLocalClaudeAgentConfigured()) {
        try {
            const info = await validateTelegramWatchChannel(username);
            resolvedTitle = info.title || '';
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }

    const result = await db.execute({
        sql: 'INSERT INTO telegram_watch_channels (username, label) VALUES (?, ?)',
        args: [username, label || resolvedTitle],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), username, label: label || resolvedTitle, createdAt: Math.floor(Date.now() / 1000) });
});

router.delete('/channels/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM telegram_watch_channels WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

// Live scan on demand only - never scheduled/cached, this always needs the
// user's Mac running right now (see local-claude-agent/README.md). Nothing
// gets persisted server-side; the frontend just renders whatever comes back.
router.post('/scan', async (req, res) => {
    const channels = await db.execute('SELECT username FROM telegram_watch_channels ORDER BY created_at ASC');
    const usernames = channels.rows.map(r => r.username);
    if (usernames.length === 0) return res.status(400).json({ error: 'Список каналов пуст - сначала добавьте хотя бы один' });

    try {
        const result = await scanTelegramWatchChannels(usernames, req.body?.limit);
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

export default router;
