import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/plan', async (req, res) => {
    const result = await db.execute('SELECT daily, weekly FROM plan_settings WHERE id = 1');
    res.json(result.rows[0]);
});

router.put('/plan', async (req, res) => {
    const daily = Math.max(1, parseInt(req.body?.daily, 10) || 1);
    const weekly = Math.max(1, parseInt(req.body?.weekly, 10) || 7);
    await db.execute({ sql: 'UPDATE plan_settings SET daily = ?, weekly = ? WHERE id = 1', args: [daily, weekly] });
    res.json({ daily, weekly });
});

// Telegram settings are write-mostly: the bot token never round-trips back to the
// browser in full, only a masked preview + whether one is configured.
router.get('/telegram', async (req, res) => {
    const result = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const row = result.rows[0];
    const hasToken = Boolean(row.token);
    res.json({
        chatId: row.chat_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.token.slice(-4)}` : '',
    });
});

router.put('/telegram', async (req, res) => {
    const { token, chatId } = req.body || {};
    const currentRes = await db.execute('SELECT token, chat_id FROM telegram_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextToken = token !== undefined && token !== '' ? token.trim() : current.token;
    const nextChatId = chatId !== undefined ? chatId.trim() : current.chat_id;
    await db.execute({ sql: 'UPDATE telegram_settings SET token = ?, chat_id = ? WHERE id = 1', args: [nextToken, nextChatId] });
    res.json({
        chatId: nextChatId,
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

export default router;
