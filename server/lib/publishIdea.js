import { db } from '../db.js';
import { resolveLangError, pickLangFields } from './resolveIdeaLang.js';
import { telegramApiBase } from './telegramApiBase.js';
import { publish as publishToVk } from './socialPublishers/vk.js';
import { publish as publishToInstagram } from './socialPublishers/instagram.js';
import { publish as publishToYoutube } from './socialPublishers/youtube.js';
import { publish as publishToThreads } from './socialPublishers/threads.js';
import { publish as publishToPinterest } from './socialPublishers/pinterest.js';

// Single entry point for actually publishing an idea, extracted out of
// server/routes/telegram.js and server/routes/socialPublish.js so the
// calendar auto-publish scheduler (server/lib/calendarScheduler.js) can call
// the exact same logic in-process, without a network hop back into the
// hub's own auth-gated /api/* routes (a loopback fetch() would 401 in
// production, same as any unauthenticated request). Both the HTTP routes and
// the scheduler now call publishIdea() below; the routes just map thrown
// errors to the same status codes they always returned.

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

async function loadIdea(ideaId) {
    const ideaRes = await db.execute({ sql: 'SELECT * FROM ideas WHERE id = ?', args: [ideaId] });
    return ideaRes.rows[0] || null;
}

async function loadCoverAsset(idea) {
    if (!idea.cover_asset_id) return null;
    const assetRes = await db.execute({ sql: 'SELECT url, type FROM media_assets WHERE id = ?', args: [idea.cover_asset_id] });
    const row = assetRes.rows[0];
    return row ? { url: row.url, type: row.type } : null;
}

function normalizeLang(lang) {
    return lang === 'en' ? 'en' : 'ru';
}

async function publishTelegram({ ideaId, channelId, lang }) {
    const idea = await loadIdea(ideaId);
    if (!idea) throw httpError(404, 'idea not found');

    const settingsRes = await db.execute('SELECT token FROM telegram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.token) throw httpError(400, 'Telegram бот не настроен: укажите Bot Token в настройках публикаций');

    if (!channelId) throw httpError(400, 'Не выбран канал для публикации. Добавьте хотя бы один канал в настройках Telegram.');
    const channelRes = await db.execute({ sql: 'SELECT * FROM telegram_channels WHERE id = ?', args: [channelId] });
    const channel = channelRes.rows[0];
    if (!channel) throw httpError(400, 'Выбранный канал не найден - возможно, он был удалён. Выберите другой канал.');

    const effectiveLang = normalizeLang(lang);
    const langError = resolveLangError(idea, effectiveLang);
    if (langError) throw httpError(400, langError);
    const { title, desc, cta } = pickLangFields(idea, effectiveLang);

    const messageText = `*${title}*\n\n${desc || ''}\n\n👉 _${cta || ''}_\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;

    let data;
    try {
        const tgRes = await fetch(`${telegramApiBase()}/bot${settings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channel.chat_id, text: messageText, parse_mode: 'Markdown' }),
        });
        data = await tgRes.json();
    } catch (e) {
        throw httpError(502, 'Failed to reach Telegram API');
    }
    if (!data.ok) throw httpError(502, data.description || 'Telegram API error');
    return { ok: true };
}

async function publishSocial(platform, { ideaId, boardId, groupId, lang }) {
    const idea = await loadIdea(ideaId);
    if (!idea) throw httpError(404, 'idea not found');

    const effectiveLang = normalizeLang(lang);
    const langError = resolveLangError(idea, effectiveLang);
    if (langError) throw httpError(400, langError);

    const coverAsset = await loadCoverAsset(idea);
    // Instagram/YouTube/Threads each hold two credential rows keyed by
    // `lang` (see server/db.js's migrateSettingsTableToLangKey) - the
    // account is picked automatically from the post's own language, same
    // effectiveLang already resolved above for the post text itself. No
    // separate account selector for those three anywhere in the publish flow.
    // VK is different: one token, many communities (vk_groups) - same shape
    // as Telegram's channelId, picked explicitly in the publish modal.
    let result;
    if (platform === 'vk') {
        if (!groupId) throw httpError(400, 'Не выбрано сообщество для публикации. Добавьте хотя бы одно в настройках VK.');
        const groupRow = (await db.execute({ sql: 'SELECT group_id, access_token FROM vk_groups WHERE id = ?', args: [groupId] })).rows[0];
        if (!groupRow) throw httpError(400, 'Выбранное сообщество не найдено - возможно, оно было удалено. Выберите другое.');
        // Each VK community's own token can only post to its own wall (unlike
        // a Telegram bot token) - see server/db.js's vk_groups comment. Falls
        // back to vk_settings.access_token only for the rare case of a user
        // token with groups+wall scope shared across communities.
        let accessToken = groupRow.access_token;
        if (!accessToken) {
            const settings = (await db.execute('SELECT access_token FROM vk_settings WHERE id = 1')).rows[0];
            accessToken = settings.access_token;
        }
        if (!accessToken) throw httpError(400, 'У этого сообщества нет токена, и общий токен VK тоже не настроен');
        result = await publishToVk(idea, { accessToken, groupId: groupRow.group_id }, coverAsset?.url || null, effectiveLang);
    } else if (platform === 'instagram') {
        const settings = (await db.execute({ sql: 'SELECT access_token, business_account_id FROM instagram_settings WHERE lang = ?', args: [effectiveLang] })).rows[0];
        if (!settings.access_token || !settings.business_account_id) throw httpError(400, `Instagram (${effectiveLang.toUpperCase()}) не настроен`);
        result = await publishToInstagram(idea, { accessToken: settings.access_token, businessAccountId: settings.business_account_id }, coverAsset, effectiveLang);
    } else if (platform === 'youtube') {
        const settings = (await db.execute({ sql: 'SELECT client_id, client_secret, refresh_token FROM youtube_settings WHERE lang = ?', args: [effectiveLang] })).rows[0];
        if (!settings.client_id || !settings.client_secret || !settings.refresh_token) throw httpError(400, `YouTube (${effectiveLang.toUpperCase()}) не настроен`);
        result = await publishToYoutube(idea, { clientId: settings.client_id, clientSecret: settings.client_secret, refreshToken: settings.refresh_token }, coverAsset, effectiveLang);
    } else if (platform === 'threads') {
        const settings = (await db.execute({ sql: 'SELECT access_token, user_id FROM threads_settings WHERE lang = ?', args: [effectiveLang] })).rows[0];
        if (!settings.access_token || !settings.user_id) throw httpError(400, `Threads (${effectiveLang.toUpperCase()}) не настроен`);
        result = await publishToThreads(idea, { accessToken: settings.access_token, userId: settings.user_id }, coverAsset, effectiveLang);
    } else if (platform === 'pinterest') {
        const settings = (await db.execute('SELECT access_token, default_board_id FROM pinterest_settings WHERE id = 1')).rows[0];
        if (!settings.access_token) throw httpError(400, 'Pinterest не настроен');
        const resolvedBoardId = boardId || settings.default_board_id;
        if (!resolvedBoardId) throw httpError(400, 'Не выбрана доска для публикации');
        result = await publishToPinterest(idea, { accessToken: settings.access_token }, coverAsset, effectiveLang, resolvedBoardId);
    } else {
        throw httpError(400, `unknown platform: ${platform}`);
    }
    if (!result.success) throw httpError(502, result.error || `${platform} publish failed`);
    return { ok: true, externalPostId: result.externalPostId };
}

export async function publishIdea(platform, { ideaId, channelId, boardId, groupId, lang }) {
    if (!ideaId) throw httpError(400, 'ideaId is required');
    if (platform === 'telegram') return publishTelegram({ ideaId, channelId, lang });
    return publishSocial(platform, { ideaId, boardId, groupId, lang });
}
