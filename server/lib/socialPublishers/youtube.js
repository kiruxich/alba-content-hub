// YouTube publisher - uploads via the Data API v3's videos.insert, using the
// resumable upload protocol.
//
// Unlike VK/Instagram (a single long-lived token pasted into Settings),
// YouTube publishes on behalf of a Google account, so it needs full OAuth2:
// a client id/secret (from a Google Cloud project) plus a refresh token
// obtained once via an interactive consent screen - see
// scripts/register-youtube-oauth.mjs for that one-time setup. This module
// only ever exchanges the refresh token for a short-lived access token per
// call; it never stores an access token.
//
// This module is self-contained: a failure here can't affect
// Telegram/VK/Instagram.

import { pickLangFields } from '../resolveIdeaLang.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Не удалось обновить YouTube access token');
    }
    return data.access_token;
}

function buildDescription(desc, cta, idea) {
    return `${desc || ''}\n\n${cta || ''}\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;
}

// idea: the row from `ideas`. credentials: { clientId, clientSecret, refreshToken }.
// coverAsset: { url, type } from media_assets for idea.cover_asset_id, or null.
// lang: 'ru' (default) or 'en' - selects idea.title/desc/cta vs the _en mirror,
// see server/lib/resolveIdeaLang.js.
export async function publish(idea, credentials, coverAsset, lang) {
    const { clientId, clientSecret, refreshToken } = credentials || {};
    if (!clientId || !clientSecret || !refreshToken) {
        return { success: false, error: 'YouTube не настроен (нужны client_id, client_secret и refresh_token - см. OAuth-настройку)' };
    }
    if (!coverAsset || !coverAsset.url || coverAsset.type !== 'video') {
        return { success: false, error: 'Для публикации в YouTube у идеи должна быть обложка-видео (не изображение)' };
    }

    let accessToken;
    try {
        accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось авторизоваться в YouTube' };
    }

    try {
        const videoRes = await fetch(coverAsset.url);
        if (!videoRes.ok) throw new Error(`не удалось скачать видео-обложку (${videoRes.status})`);
        const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
        const contentType = videoRes.headers.get('content-type') || 'video/mp4';

        const { title, desc, cta } = pickLangFields(idea, lang);
        const videoResource = {
            snippet: { title, description: buildDescription(desc, cta, idea) },
            status: { privacyStatus: 'private' }, // safest default; the project owner can change it in Studio
        };

        const startRes = await fetch(UPLOAD_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Upload-Content-Type': contentType,
                'X-Upload-Content-Length': String(videoBuffer.length),
            },
            body: JSON.stringify(videoResource),
        });
        if (!startRes.ok) {
            const errBody = await startRes.json().catch(() => ({}));
            throw new Error(errBody?.error?.message || `YouTube отклонил начало загрузки (${startRes.status})`);
        }
        const uploadUrl = startRes.headers.get('location');
        if (!uploadUrl) throw new Error('YouTube не вернул URL для загрузки видео');

        const uploadRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': contentType, 'Content-Length': String(videoBuffer.length) },
            body: videoBuffer,
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok || !uploadData.id) {
            throw new Error(uploadData?.error?.message || 'YouTube не подтвердил загрузку видео');
        }
        return { success: true, externalPostId: String(uploadData.id) };
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось загрузить видео на YouTube' };
    }
}
