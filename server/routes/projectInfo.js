import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT product_id, about FROM project_info');
    const map = {};
    result.rows.forEach(r => { map[r.product_id] = r.about; });
    res.json(map);
});

router.put('/:productId', async (req, res) => {
    const about = req.body?.about ?? '';
    await db.execute({
        sql: `
            INSERT INTO project_info (product_id, about) VALUES (?, ?)
            ON CONFLICT(product_id) DO UPDATE SET about = excluded.about
        `,
        args: [req.params.productId, about],
    });
    res.json({ productId: req.params.productId, about });
});

export default router;
