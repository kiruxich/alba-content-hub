// Threads publisher - uses Meta's Threads Publishing API, a two-step flow:
// create a media container, then publish it. Despite both being Meta
// products, this is a DIFFERENT API from Instagram's Graph API - separate
// base URL (graph.threads.net, not graph.facebook.com), separate app type
// in the Meta developer console (a "Threads use case" app, not a Facebook
// Page app), and a Threads user access token tied to a Threads account
// rather than a Facebook Page token. See server/routes/settings.js for how
// these are stored.
//
// Unlike Instagram, Threads DOES support text-only posts (media_type=TEXT,
// no image_url/video_url needed) - so a cover image is optional here, not
// required. This module is self-contained: a failure here can't affect
// Telegram/VK/Instagram/YouTube.

import { pickLangFields } from '../resolveIdeaLang.js';

const THREADS_API_VERSION = 'v1.0';
const THREADS_API_BASE = `https://graph.threads.net/${THREADS_API_VERSION}`;

async function threadsCall(path, params, method = 'GET') {
    const url = new URL(`${THREADS_API_BASE}${path}`);
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
        throw new Error(data.error.message || `Threads Graph API error ${data.error.code || ''}`);
    }
    return data;
}

// Threads posts cap at 500 characters (emoji counted as UTF-8 bytes) - unlike
// Instagram/VK's captions this module doesn't hardcode hashtags into a
// caption that could easily blow that budget, but it also doesn't enforce
// the limit itself; Threads will reject an oversized post with a clear error.
function buildText(idea, lang) {
    const { title, desc, cta } = pickLangFields(idea, lang);
    return `${title}\n\n${desc || ''}\n\n${cta || ''}\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;
}

// Threads containers use a `status` field (IN_PROGRESS/FINISHED/ERROR/
// PUBLISHED/EXPIRED) - note this is a different field name than Instagram's
// `status_code`. Meta recommends polling at most once a minute for up to
// five minutes; this module polls faster since idea covers are small.
async function waitForContainerReady(containerId, accessToken, { attempts = 10, delayMs = 1500 } = {}) {
    for (let i = 0; i < attempts; i++) {
        const status = await threadsCall(`/${containerId}`, { fields: 'status', access_token: accessToken });
        if (status.status === 'FINISHED') return true;
        if (status.status === 'ERROR') throw new Error('Threads отклонил медиа-контейнер (status ERROR)');
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Threads не подтвердил готовность медиа за отведённое время');
}

// idea: the row from `ideas`. credentials: { accessToken, userId } - a
// Threads user access token (threads_basic + threads_content_publish scopes)
// and the Threads user id it publishes to (from GET /me on graph.threads.net).
// coverAsset: { url, type } from media_assets for idea.cover_asset_id, or
// null/undefined - Threads posts text-only when there's no cover.
// lang: 'ru' (default) or 'en' - selects idea.title/desc/cta vs the _en mirror,
// see server/lib/resolveIdeaLang.js.
export async function publish(idea, credentials, coverAsset, lang) {
    const { accessToken, userId } = credentials || {};
    if (!accessToken || !userId) {
        return { success: false, error: 'Threads не настроен (нет access_token или user_id)' };
    }

    const text = buildText(idea, lang);
    const hasMedia = Boolean(coverAsset && coverAsset.url);
    const isVideo = hasMedia && coverAsset.type === 'video';

    try {
        const containerParams = !hasMedia
            ? { media_type: 'TEXT', text, access_token: accessToken }
            : isVideo
                ? { media_type: 'VIDEO', video_url: coverAsset.url, text, access_token: accessToken }
                : { media_type: 'IMAGE', image_url: coverAsset.url, text, access_token: accessToken };

        const container = await threadsCall(`/${userId}/threads`, containerParams, 'POST');
        if (!container.id) return { success: false, error: 'Threads не вернул id медиа-контейнера' };

        if (hasMedia) {
            await waitForContainerReady(container.id, accessToken);
        }

        const published = await threadsCall(`/${userId}/threads_publish`, {
            creation_id: container.id,
            access_token: accessToken,
        }, 'POST');

        if (!published.id) return { success: false, error: 'Threads не подтвердил публикацию' };
        return { success: true, externalPostId: String(published.id) };
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось опубликовать пост в Threads' };
    }
}
