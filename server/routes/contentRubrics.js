import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        structureTemplate: JSON.parse(row.structure_template || '[]'),
        targetFunnel: row.target_funnel || 'TOFU',
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
    };
}

// GET /api/content-rubrics        -- active rubrics only (for pickers, e.g. the idea edit modal)
// GET /api/content-rubrics?all=1  -- everything, including disabled (for the management UI)
router.get('/', async (req, res) => {
    const all = req.query.all === '1';
    const result = await db.execute(
        all
            ? 'SELECT * FROM content_rubrics ORDER BY created_at DESC'
            : 'SELECT * FROM content_rubrics WHERE is_active = 1 ORDER BY created_at DESC'
    );
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = String(Date.now());
    await db.execute({
        sql: `INSERT INTO content_rubrics (id, name, description, structure_template, target_funnel, is_active)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
            id, name,
            b.description || '',
            JSON.stringify(b.structureTemplate || []),
            b.targetFunnel || 'TOFU',
            b.isActive === false ? 0 : 1,
        ],
    });
    const result = await db.execute({ sql: 'SELECT * FROM content_rubrics WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM content_rubrics WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'rubric not found' });

    const b = req.body || {};
    const merged = {
        name: b.name !== undefined ? String(b.name).trim() : row.name,
        description: b.description !== undefined ? b.description : row.description,
        structure_template: b.structureTemplate !== undefined ? JSON.stringify(b.structureTemplate || []) : row.structure_template,
        target_funnel: b.targetFunnel !== undefined ? b.targetFunnel : row.target_funnel,
        is_active: b.isActive !== undefined ? (b.isActive ? 1 : 0) : row.is_active,
    };
    await db.execute({
        sql: `UPDATE content_rubrics SET name = ?, description = ?, structure_template = ?, target_funnel = ?, is_active = ? WHERE id = ?`,
        args: [merged.name, merged.description, merged.structure_template, merged.target_funnel, merged.is_active, row.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM content_rubrics WHERE id = ?', args: [row.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    // Hard delete - rubrics are lightweight reusable templates, not historical
    // records (per the task's explicit scope). ideas.rubric_id is a plain
    // TEXT column with no FK/ON DELETE clause anywhere in db.js, so an idea
    // still pointing at a deleted rubric id simply keeps that dangling id -
    // the frontend picker already renders a now-missing rubric gracefully
    // instead of needing a cascade-null here.
    const del = await db.execute({ sql: 'DELETE FROM content_rubrics WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'rubric not found' });
    res.status(204).end();
});

export default router;
