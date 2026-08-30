// Instagram publisher - uses Meta's Instagram Content Publishing API
// (part of the Graph API), a two-step flow: create a media container, then
// publish it. Requires a connected Instagram Business/Creator account and a
// Page access token (see server/routes/settings.js for how these are stored).
//
// Unlike Telegram/VK, Instagram has no text-only post - every publish needs
// an image or video, referenced by a publicly reachable URL (Meta fetches it
// server-side, it isn't uploaded as bytes). This module is self-contained:
// a failure here can't affect Telegram/VK/YouTube.

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function graphCall(path, params, method = 'GET') {
    const url = new URL(`${GRAPH_API_BASE}${path}`);
    let body;
    if (method === 'GET') {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
    } else {
        body = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) body.set(key, String(value));
        }
    }
    const res = await fetch(url, { method, body });
    const data = await res.json();
    if (data.error) {
        throw new Error(data.error.message || `Instagram Graph API error ${data.error.code || ''}`);
    }
    return data;
}

function buildCaption(idea) {
    return `${idea.title}\n\n${idea.desc || ''}\n\n${idea.cta || ''}\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;
}

async function waitForContainerReady(containerId, accessToken, { attempts = 10, delayMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i++) {
        const status = await graphCall(`/${containerId}`, { fields: 'status_code', access_token: accessToken });
        if (status.status_code === 'FINISHED') return true;
        if (status.status_code === 'ERROR') throw new Error('Instagram отклонил медиа-контейнер (status ERROR)');
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Instagram не подтвердил готовность медиа за отведённое время');
}

// idea: the row from `ideas`. credentials: { accessToken, businessAccountId }.
// coverAsset: { url, type } from media_assets for idea.cover_asset_id, or null.
export async function publish(idea, credentials, coverAsset) {
    const { accessToken, businessAccountId } = credentials || {};
    if (!accessToken || !businessAccountId) {
        return { success: false, error: 'Instagram не настроен (нет access_token или business_account_id)' };
    }
    if (!coverAsset || !coverAsset.url) {
        return { success: false, error: 'Для публикации в Instagram у идеи должна быть обложка (изображение или видео)' };
    }

    const caption = buildCaption(idea);
    const isVideo = coverAsset.type === 'video';

    try {
        const containerParams = isVideo
            ? { video_url: coverAsset.url, caption, media_type: 'REELS', access_token: accessToken }
            : { image_url: coverAsset.url, caption, access_token: accessToken };

        const container = await graphCall(`/${businessAccountId}/media`, containerParams, 'POST');
        if (!container.id) return { success: false, error: 'Instagram не вернул id медиа-контейнера' };

        if (isVideo) {
            await waitForContainerReady(container.id, accessToken);
        }

        const published = await graphCall(`/${businessAccountId}/media_publish`, {
            creation_id: container.id,
            access_token: accessToken,
        }, 'POST');

        if (!published.id) return { success: false, error: 'Instagram не подтвердил публикацию' };
        return { success: true, externalPostId: String(published.id) };
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось опубликовать пост в Instagram' };
    }
}
