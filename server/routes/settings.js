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

// VK, Instagram, and YouTube settings follow the exact same write-mostly
// pattern as Telegram above: secrets never round-trip back to the browser in
// full, only a masked preview + whether they're configured. See
// server/lib/socialPublishers/*.js for what each is used for.

router.get('/vk', async (req, res) => {
    const result = await db.execute('SELECT access_token, group_id FROM vk_settings WHERE id = 1');
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        groupId: row.group_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/vk', async (req, res) => {
    const { accessToken, groupId } = req.body || {};
    const currentRes = await db.execute('SELECT access_token, group_id FROM vk_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    const nextGroupId = groupId !== undefined ? groupId.trim() : current.group_id;
    await db.execute({ sql: 'UPDATE vk_settings SET access_token = ?, group_id = ? WHERE id = 1', args: [nextToken, nextGroupId] });
    res.json({
        groupId: nextGroupId,
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

router.get('/instagram', async (req, res) => {
    const result = await db.execute('SELECT access_token, business_account_id FROM instagram_settings WHERE id = 1');
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        businessAccountId: row.business_account_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/instagram', async (req, res) => {
    const { accessToken, businessAccountId } = req.body || {};
    const currentRes = await db.execute('SELECT access_token, business_account_id FROM instagram_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    const nextAccountId = businessAccountId !== undefined ? businessAccountId.trim() : current.business_account_id;
    await db.execute({ sql: 'UPDATE instagram_settings SET access_token = ?, business_account_id = ? WHERE id = 1', args: [nextToken, nextAccountId] });
    res.json({
        businessAccountId: nextAccountId,
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

// YouTube needs three secrets (client id/secret + refresh token) instead of
// one, since it's a full OAuth2 setup rather than a pasted bot token - see
// server/lib/socialPublishers/youtube.js. All three are required for
// publish to work; the route reports each independently so the UI can point
// out exactly what's missing.
router.get('/youtube', async (req, res) => {
    const result = await db.execute('SELECT client_id, client_secret, refresh_token, channel_title FROM youtube_settings WHERE id = 1');
    const row = result.rows[0];
    res.json({
        clientId: row.client_id || '',
        channelTitle: row.channel_title || '',
        hasClientSecret: Boolean(row.client_secret),
        hasRefreshToken: Boolean(row.refresh_token),
        configured: Boolean(row.client_id && row.client_secret && row.refresh_token),
    });
});

router.put('/youtube', async (req, res) => {
    const { clientId, clientSecret, refreshToken, channelTitle } = req.body || {};
    const currentRes = await db.execute('SELECT client_id, client_secret, refresh_token, channel_title FROM youtube_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextClientId = clientId !== undefined ? clientId.trim() : current.client_id;
    const nextClientSecret = clientSecret !== undefined && clientSecret !== '' ? clientSecret.trim() : current.client_secret;
    const nextRefreshToken = refreshToken !== undefined && refreshToken !== '' ? refreshToken.trim() : current.refresh_token;
    const nextChannelTitle = channelTitle !== undefined ? channelTitle.trim() : current.channel_title;
    await db.execute({
        sql: 'UPDATE youtube_settings SET client_id = ?, client_secret = ?, refresh_token = ?, channel_title = ? WHERE id = 1',
        args: [nextClientId, nextClientSecret, nextRefreshToken, nextChannelTitle],
    });
    res.json({
        clientId: nextClientId,
        channelTitle: nextChannelTitle,
        hasClientSecret: Boolean(nextClientSecret),
        hasRefreshToken: Boolean(nextRefreshToken),
        configured: Boolean(nextClientId && nextClientSecret && nextRefreshToken),
    });
});

export default router;
