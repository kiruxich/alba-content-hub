// VK (VKontakte) publisher - posts to a community wall via wall.post.
//
// VK API version pinned to 5.199 (current stable as of this writing - VK
// requires every request to name a version; unlike Telegram/Instagram it
// does NOT accept an external image URL as an attachment, so a photo has to
// be uploaded to VK's own storage first via a 3-call dance
// (photos.getWallUploadServer -> upload -> photos.saveWallPhoto) before it
// can be attached to the post. See publish() below.
//
// This module is self-contained: it never touches the DB or other
// platforms' code, and a failure here can't affect Telegram/Instagram/YouTube.

const VK_API_VERSION = '5.199';
const VK_API_BASE = 'https://api.vk.com/method';

async function vkCall(method, params) {
    const url = new URL(`${VK_API_BASE}/${method}`);
    url.searchParams.set('v', VK_API_VERSION);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
        const msg = data.error.error_msg || `VK error ${data.error.error_code}`;
        throw new Error(msg);
    }
    return data.response;
}

// Uploads a cover image to the community's wall attachment storage and
// returns a "photo<owner_id>_<id>" attachment string, or null if anything in
// this optional step fails - a failed photo attach must never block posting
// the text itself.
async function tryUploadCoverPhoto(groupId, accessToken, coverUrl) {
    try {
        const uploadServer = await vkCall('photos.getWallUploadServer', { group_id: groupId, access_token: accessToken });
        const imageRes = await fetch(coverUrl);
        if (!imageRes.ok) throw new Error(`failed to fetch cover image (${imageRes.status})`);
        const imageBlob = await imageRes.blob();

        const form = new FormData();
        form.append('photo', imageBlob, 'cover.jpg');
        const uploadRes = await fetch(uploadServer.upload_url, { method: 'POST', body: form });
        const uploadData = await uploadRes.json();
        if (!uploadData.photo || uploadData.photo === '[]') throw new Error('VK upload server rejected the image');

        const saved = await vkCall('photos.saveWallPhoto', {
            group_id: groupId,
            photo: uploadData.photo,
            server: uploadData.server,
            hash: uploadData.hash,
            access_token: accessToken,
        });
        const photo = saved && saved[0];
        if (!photo) throw new Error('photos.saveWallPhoto returned nothing');
        return `photo${photo.owner_id}_${photo.id}`;
    } catch (e) {
        return null;
    }
}

function buildMessage(idea) {
    return `${idea.title}\n\n${idea.desc || ''}\n\n${idea.cta || ''}\n\n#${idea.funnel || 'TOFU'} #AlbaCreation`;
}

// idea: the row from `ideas`. credentials: { accessToken, groupId }.
// coverUrl: optional public URL of the idea's cover image (from media_assets).
export async function publish(idea, credentials, coverUrl) {
    const { accessToken, groupId } = credentials || {};
    if (!accessToken || !groupId) {
        return { success: false, error: 'VK не настроен (нет access_token или group_id)' };
    }

    const message = buildMessage(idea);
    const attachment = coverUrl ? await tryUploadCoverPhoto(groupId, accessToken, coverUrl) : null;

    try {
        const response = await vkCall('wall.post', {
            owner_id: -Math.abs(Number(groupId)),
            from_group: 1,
            message,
            attachments: attachment || undefined,
            access_token: accessToken,
        });
        if (!response || !response.post_id) {
            return { success: false, error: 'VK API вернул ответ без post_id' };
        }
        return { success: true, externalPostId: String(response.post_id) };
    } catch (e) {
        return { success: false, error: e.message || 'Не удалось опубликовать пост в VK' };
    }
}
