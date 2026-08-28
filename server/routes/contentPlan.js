import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT blocks FROM content_plan WHERE id = 1');
    res.json({ blocks: JSON.parse(result.rows[0]?.blocks || '[]') });
});

router.put('/', async (req, res) => {
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    await db.execute({ sql: 'UPDATE content_plan SET blocks = ? WHERE id = 1', args: [JSON.stringify(blocks)] });
    res.json({ blocks });
});

export default router;
