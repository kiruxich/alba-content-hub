import { Router } from 'express';
import { db } from '../db.js';
import { listBoards, createBoard } from '../lib/socialPublishers/pinterest.js';

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

// Telegram publish-target channels (see telegram_channels in server/db.js) -
// distinct from the bot token above: one bot, many channels it's admin of,
// picked in the Bank of Ideas "Опубликовать" modal. Full CRUD since there's
// no secret here, just a label + chat id.
router.get('/telegram-channels', async (req, res) => {
    const result = await db.execute('SELECT id, label, chat_id, created_at FROM telegram_channels ORDER BY created_at ASC');
    res.json(result.rows.map(row => ({ id: row.id, label: row.label, chatId: row.chat_id, createdAt: row.created_at })));
});

router.post('/telegram-channels', async (req, res) => {
    const { label, chatId } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'Укажите название канала' });
    if (!chatId || !String(chatId).trim()) return res.status(400).json({ error: 'Укажите chat_id канала' });
    const result = await db.execute({
        sql: 'INSERT INTO telegram_channels (label, chat_id) VALUES (?, ?)',
        args: [String(label).trim(), String(chatId).trim()],
    });
    const id = Number(result.lastInsertRowid);
    res.status(201).json({ id, label: String(label).trim(), chatId: String(chatId).trim() });
});

router.delete('/telegram-channels/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM telegram_channels WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

// VK, Instagram, YouTube, and Threads settings follow the exact same
// write-mostly pattern as Telegram above: secrets never round-trip back to
// the browser in full, only a masked preview + whether they're configured.
// See server/lib/socialPublishers/*.js for what each is used for.
//
// RU/EN dual accounts: unlike Telegram (its own multi-channel setup), VK
// (its own multi-group setup, see /vk-groups below) and Pinterest (single
// account), Instagram/YouTube/Threads hold TWO separate credential rows -
// one per language (see server/db.js's migrateSettingsTableToLangKey).
// Every GET/PUT for those three takes `?lang=ru|en` (GET, default 'ru') /
// body `lang` (PUT, default 'ru') so existing callers that don't pass it
// yet keep working against the RU account unchanged.
// server/lib/publishIdea.js picks the account automatically from the post's
// own language at publish time - there's no separate account picker in the
// publish flow itself for these three.
function resolveLang(value) {
    return value === 'en' ? 'en' : 'ru';
}

// VK: one token, many communities it can post to (mirrors Telegram, not the
// RU/EN split above) - group_id here is legacy/unused now that /vk-groups
// exists, kept only so an old row's data isn't silently dropped.
router.get('/vk', async (req, res) => {
    const result = await db.execute('SELECT access_token FROM vk_settings WHERE id = 1');
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/vk', async (req, res) => {
    const { accessToken } = req.body || {};
    const currentRes = await db.execute('SELECT access_token FROM vk_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    await db.execute({ sql: 'UPDATE vk_settings SET access_token = ? WHERE id = 1', args: [nextToken] });
    res.json({
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

// VK publish-target communities (see vk_groups in server/db.js) - same
// shape as /telegram-channels above: one token (saved via PUT /vk), many
// communities it's allowed to post to, picked in the publish modal.
// Token is write-only (never round-trips back in full - only hasToken/
// tokenPreview, same pattern as the platform settings below) since each
// row's token is a real credential, not a public id like group_id.
router.get('/vk-groups', async (req, res) => {
    const result = await db.execute('SELECT id, label, group_id, access_token, lang, created_at FROM vk_groups ORDER BY created_at ASC');
    res.json(result.rows.map(row => ({
        id: row.id, label: row.label, groupId: row.group_id, lang: row.lang || null, createdAt: row.created_at,
        hasToken: Boolean(row.access_token),
        tokenPreview: row.access_token ? `••••${row.access_token.slice(-4)}` : '',
    })));
});

// VK community access tokens are scoped to the community they were created
// from (unlike a Telegram bot token) - groups.getById with a community
// token, called with NO group_id param, resolves to that one community
// automatically, so the user only ever pastes the token, never has to hunt
// down a numeric id themselves.
router.post('/vk-groups', async (req, res) => {
    const { accessToken, label, lang } = req.body || {};
    const token = String(accessToken || '').trim();
    if (!token) return res.status(400).json({ error: 'Укажите токен доступа сообщества' });

    let resolved;
    try {
        const url = new URL('https://api.vk.com/method/groups.getById');
        url.searchParams.set('v', '5.199');
        url.searchParams.set('access_token', token);
        const data = await (await fetch(url)).json();
        if (data.error) throw new Error(data.error.error_msg || `VK error ${data.error.error_code}`);
        resolved = (data.response?.groups || data.response)?.[0];
        if (!resolved) throw new Error('VK не вернул информацию о сообществе для этого токена');
    } catch (e) {
        return res.status(400).json({ error: `Не удалось проверить токен: ${e.message}` });
    }

    const resolvedLang = lang === 'ru' || lang === 'en' ? lang : null;
    const finalLabel = (label && String(label).trim()) || resolved.name || `VK ${resolved.id}`;
    const result = await db.execute({
        sql: 'INSERT INTO vk_groups (label, group_id, access_token, lang) VALUES (?, ?, ?, ?)',
        args: [finalLabel, String(resolved.id), token, resolvedLang],
    });
    const id = Number(result.lastInsertRowid);
    res.status(201).json({
        id, label: finalLabel, groupId: String(resolved.id), lang: resolvedLang,
        hasToken: true, tokenPreview: `••••${token.slice(-4)}`,
    });
});

router.delete('/vk-groups/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM vk_groups WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

// VK/YouTube trend sources (see vk_trend_sources/youtube_trend_sources in
// server/db.js) - what Researcher scans for trend candidates alongside RSS
// (server/routes/agentResearcher.js), NOT publish targets. Kept as their own
// tables/endpoints (mirroring vk-groups/telegram-channels above) rather than
// mixed into agent_settings.sources, since Центр агентов shows them in their
// own fields, not the shared RSS textarea.
router.get('/vk-trend-sources', async (req, res) => {
    const result = await db.execute('SELECT id, group_id, label, created_at FROM vk_trend_sources ORDER BY created_at ASC');
    res.json(result.rows.map(row => ({ id: row.id, groupId: row.group_id, label: row.label || '', createdAt: row.created_at })));
});

router.post('/vk-trend-sources', async (req, res) => {
    const groupId = String(req.body?.groupId || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!groupId) return res.status(400).json({ error: 'Укажите ID или короткое имя сообщества' });
    const result = await db.execute({
        sql: 'INSERT INTO vk_trend_sources (group_id, label) VALUES (?, ?)',
        args: [groupId, label],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), groupId, label, createdAt: Math.floor(Date.now() / 1000) });
});

router.delete('/vk-trend-sources/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM vk_trend_sources WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

router.get('/youtube-trend-sources', async (req, res) => {
    const result = await db.execute('SELECT id, channel_id, label, created_at FROM youtube_trend_sources ORDER BY created_at ASC');
    res.json(result.rows.map(row => ({ id: row.id, channelId: row.channel_id, label: row.label || '', createdAt: row.created_at })));
});

router.post('/youtube-trend-sources', async (req, res) => {
    const channelId = String(req.body?.channelId || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!channelId) return res.status(400).json({ error: 'Укажите ID канала' });
    const result = await db.execute({
        sql: 'INSERT INTO youtube_trend_sources (channel_id, label) VALUES (?, ?)',
        args: [channelId, label],
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), channelId, label, createdAt: Math.floor(Date.now() / 1000) });
});

router.delete('/youtube-trend-sources/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM youtube_trend_sources WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
});

router.get('/instagram', async (req, res) => {
    const lang = resolveLang(req.query.lang);
    const result = await db.execute({ sql: 'SELECT access_token, business_account_id FROM instagram_settings WHERE lang = ?', args: [lang] });
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        businessAccountId: row.business_account_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/instagram', async (req, res) => {
    const { accessToken, businessAccountId, lang: rawLang } = req.body || {};
    const lang = resolveLang(rawLang);
    const currentRes = await db.execute({ sql: 'SELECT access_token, business_account_id FROM instagram_settings WHERE lang = ?', args: [lang] });
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    const nextAccountId = businessAccountId !== undefined ? businessAccountId.trim() : current.business_account_id;
    await db.execute({ sql: 'UPDATE instagram_settings SET access_token = ?, business_account_id = ? WHERE lang = ?', args: [nextToken, nextAccountId, lang] });
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
    const lang = resolveLang(req.query.lang);
    const result = await db.execute({ sql: 'SELECT client_id, client_secret, refresh_token, channel_title FROM youtube_settings WHERE lang = ?', args: [lang] });
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
    const { clientId, clientSecret, refreshToken, channelTitle, lang: rawLang } = req.body || {};
    const lang = resolveLang(rawLang);
    const currentRes = await db.execute({ sql: 'SELECT client_id, client_secret, refresh_token, channel_title FROM youtube_settings WHERE lang = ?', args: [lang] });
    const current = currentRes.rows[0];
    const nextClientId = clientId !== undefined ? clientId.trim() : current.client_id;
    const nextClientSecret = clientSecret !== undefined && clientSecret !== '' ? clientSecret.trim() : current.client_secret;
    const nextRefreshToken = refreshToken !== undefined && refreshToken !== '' ? refreshToken.trim() : current.refresh_token;
    const nextChannelTitle = channelTitle !== undefined ? channelTitle.trim() : current.channel_title;
    await db.execute({
        sql: 'UPDATE youtube_settings SET client_id = ?, client_secret = ?, refresh_token = ?, channel_title = ? WHERE lang = ?',
        args: [nextClientId, nextClientSecret, nextRefreshToken, nextChannelTitle, lang],
    });
    res.json({
        clientId: nextClientId,
        channelTitle: nextChannelTitle,
        hasClientSecret: Boolean(nextClientSecret),
        hasRefreshToken: Boolean(nextRefreshToken),
        configured: Boolean(nextClientId && nextClientSecret && nextRefreshToken),
    });
});

// Threads follows the same write-mostly pattern as VK/Instagram above: the
// access token never round-trips back to the browser in full, only a masked
// preview + whether it's configured. See server/lib/socialPublishers/threads.js.
router.get('/threads', async (req, res) => {
    const lang = resolveLang(req.query.lang);
    const result = await db.execute({ sql: 'SELECT access_token, user_id FROM threads_settings WHERE lang = ?', args: [lang] });
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        userId: row.user_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/threads', async (req, res) => {
    const { accessToken, userId, lang: rawLang } = req.body || {};
    const lang = resolveLang(rawLang);
    const currentRes = await db.execute({ sql: 'SELECT access_token, user_id FROM threads_settings WHERE lang = ?', args: [lang] });
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    const nextUserId = userId !== undefined ? userId.trim() : current.user_id;
    await db.execute({ sql: 'UPDATE threads_settings SET access_token = ?, user_id = ? WHERE lang = ?', args: [nextToken, nextUserId, lang] });
    res.json({
        userId: nextUserId,
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

// Pinterest follows the same write-mostly pattern as VK/Instagram/Threads
// above, plus a saved default board id (every Pin needs one - see
// server/lib/socialPublishers/pinterest.js). /pinterest/boards proxies
// Pinterest's own boards list/create so the frontend never needs the raw
// access token to populate the board picker.
router.get('/pinterest', async (req, res) => {
    const result = await db.execute('SELECT access_token, default_board_id FROM pinterest_settings WHERE id = 1');
    const row = result.rows[0];
    const hasToken = Boolean(row.access_token);
    res.json({
        defaultBoardId: row.default_board_id || '',
        hasToken,
        tokenPreview: hasToken ? `••••${row.access_token.slice(-4)}` : '',
    });
});

router.put('/pinterest', async (req, res) => {
    const { accessToken, defaultBoardId } = req.body || {};
    const currentRes = await db.execute('SELECT access_token, default_board_id FROM pinterest_settings WHERE id = 1');
    const current = currentRes.rows[0];
    const nextToken = accessToken !== undefined && accessToken !== '' ? accessToken.trim() : current.access_token;
    const nextBoardId = defaultBoardId !== undefined ? String(defaultBoardId).trim() : current.default_board_id;
    await db.execute({ sql: 'UPDATE pinterest_settings SET access_token = ?, default_board_id = ? WHERE id = 1', args: [nextToken, nextBoardId] });
    res.json({
        defaultBoardId: nextBoardId,
        hasToken: Boolean(nextToken),
        tokenPreview: nextToken ? `••••${nextToken.slice(-4)}` : '',
    });
});

router.get('/pinterest/boards', async (req, res) => {
    const result = await db.execute('SELECT access_token FROM pinterest_settings WHERE id = 1');
    const accessToken = result.rows[0]?.access_token;
    if (!accessToken) return res.status(400).json({ error: 'Pinterest не настроен' });
    try {
        res.json(await listBoards(accessToken));
    } catch (e) {
        res.status(502).json({ error: e.message || 'Не удалось получить список досок' });
    }
});

router.post('/pinterest/boards', async (req, res) => {
    const result = await db.execute('SELECT access_token FROM pinterest_settings WHERE id = 1');
    const accessToken = result.rows[0]?.access_token;
    if (!accessToken) return res.status(400).json({ error: 'Pinterest не настроен' });
    try {
        const board = await createBoard(accessToken, req.body?.name, req.body?.description);
        res.status(201).json(board);
    } catch (e) {
        res.status(502).json({ error: e.message || 'Не удалось создать доску' });
    }
});

export default router;
