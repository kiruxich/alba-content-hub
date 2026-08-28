import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        name: row.name,
        subtitle: row.subtitle,
        sections: JSON.parse(row.sections || '[]'),
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM niches ORDER BY created_at ASC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    const id = String(Date.now());
    await db.execute({
        sql: 'INSERT INTO niches (id, name, subtitle, sections) VALUES (?, ?, ?, ?)',
        args: [id, b.name.trim(), b.subtitle || '', JSON.stringify(b.sections || [])],
    });
    const result = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.put('/:id', async (req, res) => {
    const existingRes = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [req.params.id] });
    const existing = existingRes.rows[0];
    if (!existing) return res.status(404).json({ error: 'niche not found' });

    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : existing.name;
    const subtitle = b.subtitle !== undefined ? b.subtitle : existing.subtitle;
    const sections = b.sections !== undefined ? JSON.stringify(b.sections) : existing.sections;

    await db.execute({
        sql: 'UPDATE niches SET name = ?, subtitle = ?, sections = ? WHERE id = ?',
        args: [name, subtitle, sections, existing.id],
    });
    const result = await db.execute({ sql: 'SELECT * FROM niches WHERE id = ?', args: [existing.id] });
    res.json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM niches WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'niche not found' });
    res.status(204).end();
});

export default router;
