import { Router } from 'express';
import { publishIdea } from '../lib/publishIdea.js';

const router = Router();

// Thin wrapper over publishIdea() - see server/lib/publishIdea.js for the
// actual logic, shared with the calendar auto-publish scheduler.
router.post('/post', async (req, res) => {
    const { ideaId, channelId, lang } = req.body || {};
    try {
        const result = await publishIdea('telegram', { ideaId, channelId, lang });
        res.json(result);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

export default router;
