import { Router } from 'express';
import { db } from '../db.js';
import { publish as publishToVk } from '../lib/socialPublishers/vk.js';
import { publish as publishToInstagram } from '../lib/socialPublishers/instagram.js';
import { publish as publishToYoutube } from '../lib/socialPublishers/youtube.js';
import { publish as publishToThreads } from '../lib/socialPublishers/threads.js';

const router = Router();

// Server reads everything it posts from the DB, exactly like
// server/routes/telegram.js - the client only ever sends an idea id, never
// the post content itself.
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

router.post('/vk', async (req, res) => {
    const { ideaId } = req.body || {};
    if (!ideaId) return res.status(400).json({ error: 'ideaId is required' });
    const idea = await loadIdea(ideaId);
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT access_token, group_id FROM vk_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.access_token || !settings.group_id) {
        return res.status(400).json({ error: 'VK не настроен' });
    }

    const coverAsset = await loadCoverAsset(idea);
    const result = await publishToVk(idea, { accessToken: settings.access_token, groupId: settings.group_id }, coverAsset?.url || null);
    if (!result.success) return res.status(502).json({ error: result.error || 'VK publish failed' });
    res.json({ ok: true, externalPostId: result.externalPostId });
});

router.post('/instagram', async (req, res) => {
    const { ideaId } = req.body || {};
    if (!ideaId) return res.status(400).json({ error: 'ideaId is required' });
    const idea = await loadIdea(ideaId);
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT access_token, business_account_id FROM instagram_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.access_token || !settings.business_account_id) {
        return res.status(400).json({ error: 'Instagram не настроен' });
    }

    const coverAsset = await loadCoverAsset(idea);
    const result = await publishToInstagram(idea, { accessToken: settings.access_token, businessAccountId: settings.business_account_id }, coverAsset);
    if (!result.success) return res.status(502).json({ error: result.error || 'Instagram publish failed' });
    res.json({ ok: true, externalPostId: result.externalPostId });
});

router.post('/youtube', async (req, res) => {
    const { ideaId } = req.body || {};
    if (!ideaId) return res.status(400).json({ error: 'ideaId is required' });
    const idea = await loadIdea(ideaId);
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT client_id, client_secret, refresh_token FROM youtube_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.client_id || !settings.client_secret || !settings.refresh_token) {
        return res.status(400).json({ error: 'YouTube не настроен' });
    }

    const coverAsset = await loadCoverAsset(idea);
    const result = await publishToYoutube(idea, {
        clientId: settings.client_id,
        clientSecret: settings.client_secret,
        refreshToken: settings.refresh_token,
    }, coverAsset);
    if (!result.success) return res.status(502).json({ error: result.error || 'YouTube publish failed' });
    res.json({ ok: true, externalPostId: result.externalPostId });
});

router.post('/threads', async (req, res) => {
    const { ideaId } = req.body || {};
    if (!ideaId) return res.status(400).json({ error: 'ideaId is required' });
    const idea = await loadIdea(ideaId);
    if (!idea) return res.status(404).json({ error: 'idea not found' });

    const settingsRes = await db.execute('SELECT access_token, user_id FROM threads_settings WHERE id = 1');
    const settings = settingsRes.rows[0];
    if (!settings.access_token || !settings.user_id) {
        return res.status(400).json({ error: 'Threads не настроен' });
    }

    const coverAsset = await loadCoverAsset(idea);
    const result = await publishToThreads(idea, { accessToken: settings.access_token, userId: settings.user_id }, coverAsset);
    if (!result.success) return res.status(502).json({ error: result.error || 'Threads publish failed' });
    res.json({ ok: true, externalPostId: result.externalPostId });
});

export default router;
