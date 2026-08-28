import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// The bot token lives only in the database; it is read here and used in a
// server-to-server fetch, so it never reaches the browser.
router.post('/post', async (req, res) => {
    const { ideaId } = req.body || {};
    const ideaRes = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [ideaId] });
    const idea = ideaRes.rows[0];
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.token || !settings.chat_id) {
        return res.status(400).json({ error: 'Telegram bot is not configured' });
    }

    const messageText = `*${idea.title}*\n\n${idea.desc || ''}\n\n👉 _${idea.cta || ''}_\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;

    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: settings.chat_id, text: messageText, parse_mode: 'Markdown' }),
        });
        const data = await tgRes.json();
        if (!data.ok) return res.status(502).json({ error: data.description || 'Telegram API error' });
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: 'Failed to reach Telegram API' });
    }
});

export default router;
