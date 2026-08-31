// Pinterest publisher - Pinterest API v5 (https://api.pinterest.com/v5).
// Unlike every other platform in this app, a Pin has NO text-only mode -
// every Pin requires an image (or video), and every Pin must belong to a
// board (board_id is a required field, not optional). That's why publish()
// below refuses to run without a coverAsset, and why this module also
// exports listBoards()/createBoard() - the publish flow needs a board picker,
// not just a token, unlike VK/Instagram/Threads which only need credentials.
//
// This module is self-contained: it never touches the DB or other
// platforms' code, and a failure here can't affect VK/Instagram/YouTube/Threads.

import { pickLangFields } from '../resolveIdeaLang.js';

const PINTEREST_API_BASE = 'https://api.pinterest.com/v5';

async function pinterestCall(path, accessToken, { method = 'GET', body } = {}) {
    const res = await fetch(`${PINTEREST_API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.message || data.error || `Pinterest API error ${res.status}`);
    }
    return data;
}

// Pinterest titles cap at 100 chars, descriptions at 800 - unlike the other
// platforms' buildText() helpers this returns two separate fields since
// Pinterest's Pin object has distinct title/description fields rather than
// one caption blob.
function buildPinFields(idea, lang) {
    const { title, desc, cta } = pickLangFields(idea, lang);
    const description = [desc, cta ? `👉 ${cta}` : ''].filter(Boolean).join('\n\n').slice(0, 800);
    return { title: (title || '').slice(0, 100), description };
}

// idea: the row from `ideas`. credentials: { accessToken }. coverAsset:
// { url, type } from media_assets for idea.cover_asset_id - REQUIRED, unlike
// every other publisher here, since Pinterest has no text-only Pin type.
// boardId: which board to Pin to (picked in the UI, or the account's saved
// default - resolved by the caller, not this module). lang: 'ru' (default)
// or 'en' - see server/lib/resolveIdeaLang.js.
export async function publish(idea, credentials, coverAsset, lang, boardId) {
    const { accessToken } = credentials || {};
    if (!accessToken) {
        return { success: false, error: 'Pinterest не настроен (нет access_token)' };
    }
    if (!boardId) {
        return { success: false, error: 'Не выбрана доска для публикации' };
    }
    if (!coverAsset || !coverAsset.url) {
        return { success: false, error: 'Pinterest требует обложку — у идеи нет привязанного изображения' };
    }
    if (coverAsset.type === 'video') {
        // Pinterest supports video Pins, but they need a separate multi-step
        // upload (register upload -> PUT the file -> poll processing status)
        // that's meaningfully different from the image_url flow below - not
        // implemented here since every cover generated in this app so far is
        // an image. Fail clearly rather than silently mishandling it.
        return { success: false, error: 'Публикация видео в Pinterest пока не поддерживается — только изображения' };
    }

    const { title, description } = buildPinFields(idea, lang);

    try {
        const pin = await pinterestCall('/pins', accessToken, {
            method: 'POST',
            body: {
                board_id: boardId,
                title,
                description,
                media_source: { source_type: 'image_url', url: coverAsset.url },
            },
        });
        if (!pin.id) return { success: false, error: 'Pinterest не вернул id пина' };
        return { success: true, externalPostId: String(pin.id) };
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось опубликовать пин в Pinterest' };
    }
}

// Boards list for the publish-flow picker (and the settings tab's default-board
// select) - { id, name }[], most recently created isn't guaranteed first so
// callers should sort/display as-is or by name.
export async function listBoards(accessToken) {
    if (!accessToken) return [];
    const data = await pinterestCall('/boards?page_size=100', accessToken);
    return (data.items || []).map(b => ({ id: b.id, name: b.name }));
}

export async function createBoard(accessToken, name, description) {
    if (!name || !name.trim()) throw new Error('Укажите название доски');
    const board = await pinterestCall('/boards', accessToken, {
        method: 'POST',
        body: { name: name.trim(), description: description || undefined },
    });
    if (!board.id) throw new Error('Pinterest не вернул id доски');
    return { id: board.id, name: board.name };
}
