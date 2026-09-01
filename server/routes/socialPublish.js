import { Router } from 'express';
import { publishIdea } from '../lib/publishIdea.js';

const router = Router();

// Thin wrappers over publishIdea() - see server/lib/publishIdea.js for the
// actual per-platform logic, shared with the calendar auto-publish
// scheduler so both entry points behave identically.
function makePublishRoute(platform) {
    return async (req, res) => {
        const { ideaId, boardId, groupId, lang } = req.body || {};
        try {
            const result = await publishIdea(platform, { ideaId, boardId, groupId, lang });
            res.json(result);
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    };
}

router.post('/vk', makePublishRoute('vk'));
router.post('/instagram', makePublishRoute('instagram'));
router.post('/youtube', makePublishRoute('youtube'));
router.post('/threads', makePublishRoute('threads'));
router.post('/pinterest', makePublishRoute('pinterest'));

export default router;
