import { Router } from 'express';
import { db } from '../db.js';
import { resolveLangError, pickLangFields } from '../lib/resolveIdeaLang.js';

const router = Router();

// The bot token lives only in the database; it is read here and used in a
// server-to-server fetch, so it never reaches the browser. channelId
// references telegram_channels (see server/db.js) - the client picks a
// channel in the "Опубликовать" modal, the actual chat_id is resolved here.
router.post('/post', async (req, res) => {
    const { ideaId, channelId, lang } = req.body || {};
    const ideaRes = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [ideaId] });
    const idea = ideaRes.rows[0];
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT token FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.token) {
        return res.status(400).json({ error: 'Telegram бот не настроен: укажите Bot Token в настройках публикаций' });
    }

    if (!channelId) {
        return res.status(400).json({ error: 'Не выбран канал для публикации. Добавьте хотя бы один канал в настройках Telegram.' });
    }
    const channelRes = await db.execute({ sql: 'SELECT * FROM telegram_channels WHERE id = ?', args: [channelId] });
    const channel = channelRes.rows[0];
    if (!channel) {
        return res.status(400).json({ error: 'Выбранный канал не найден - возможно, он был удалён. Выберите другой канал.' });
    }

    const effectiveLang = lang === 'en' ? 'en' : 'ru';
    const langError = resolveLangError(idea, effectiveLang);
    if (langError) return res.status(400).json({ error: langError });
    const { title, desc, cta } = pickLangFields(idea, effectiveLang);

    const messageText = `*${title}*\n\n${desc || ''}\n\n👉 _${cta || ''}_\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;

    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channel.chat_id, text: messageText, parse_mode: 'Markdown' }),
        });
        const data = await tgRes.json();
        if (!data.ok) return res.status(502).json({ error: data.description || 'Telegram API error' });
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: 'Failed to reach Telegram API' });
    }
});

export default router;
