import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        url: row.url,
        type: row.type,
        productId: row.product_id || null,
        rubricId: row.rubric_id || null,
        tags: JSON.parse(row.tags || '[]'),
        source: row.source || 'manual',
        usedCount: row.used_count || 0,
        createdAt: row.created_at,
    };
}

// GET /api/media-assets?product_id=insights&type=image
router.get('/', async (req, res) => {
    const productId = (req.query.product_id || '').trim();
    const type = (req.query.type || '').trim();

    const clauses = [];
    const args = [];
    if (productId) {
        clauses.push('product_id = ?');
        args.push(productId);
    }
    if (type) {
        clauses.push('type = ?');
        args.push(type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.execute({
        sql: `SELECT * FROM media_assets ${where} ORDER BY created_at DESC`,
        args,
    });
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    const url = (b.url || '').trim();
    const type = (b.type || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!type) return res.status(400).json({ error: 'type is required' });

    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO media_assets (id, url, type, product_id, rubric_id, tags, source)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
            id, url, type,
            b.productId || null,
            b.rubricId || null,
            JSON.stringify(b.tags || []),
            b.source || 'manual',
        ],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'asset not found' });

    const b = req.body || {};
    const merged = {
        url: b.url !== undefined ? String(b.url).trim() : row.url,
        type: b.type !== undefined ? String(b.type).trim() : row.type,
        product_id: b.productId !== undefined ? (b.productId || null) : row.product_id,
        rubric_id: b.rubricId !== undefined ? (b.rubricId || null) : row.rubric_id,
        tags: b.tags !== undefined ? JSON.stringify(b.tags || []) : row.tags,
    };
    await db.execute({
        sql: `UPDATE media_assets SET url = ?, type = ?, product_id = ?, rubric_id = ?, tags = ? WHERE id = ?`,
        args: [merged.url, merged.type, merged.product_id, merged.rubric_id, merged.tags, row.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM media_assets WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'asset not found' });
    res.status(204).end();
});

// Called whenever an idea's cover gets set to this asset (or any other future
// "this asset got used somewhere" event) - just an incrementing counter, no
// per-usage log.
router.post('/:id/use', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'asset not found' });
    await db.execute({ sql: 'UPDATE media_assets SET used_count = used_count + 1 WHERE id = ?', args: [row.id] });
    const result = await db.execute({ sql: 'SELECT * FROM media_assets WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

export default router;
