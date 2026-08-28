import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        id: row.id,
        ideaId: row.idea_id,
        title: row.title,
        dateStr: row.date_str,
        rawDate: row.raw_date,
        color: row.color,
        format: row.format,
        cta: row.cta,
        desc: row.desc,
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM scheduled_events ORDER BY raw_date ASC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const b = req.body || {};
    if (!b.rawDate || !b.title) return res.status(400).json({ error: 'rawDate and title are required' });

    const id = Date.now();
    await db.execute({
        sql: `
            INSERT INTO scheduled_events (id, idea_id, title, date_str, raw_date, color, format, cta, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [id, b.ideaId ?? null, b.title, b.dateStr || '', b.rawDate,
            b.color || '#0a84ff', b.format || 'TG Пост', b.cta || '', b.desc || ''],
    });
    const result = await db.execute({ sql: 'SELECT * FROM scheduled_events WHERE id = ?', args: [id] });
    res.status(201).json(serialize(result.rows[0]));
});

router.delete('/:id', async (req, res) => {
    const del = await db.execute({ sql: 'DELETE FROM scheduled_events WHERE id = ?', args: [req.params.id] });
    if (Number(del.rowsAffected) === 0) return res.status(404).json({ error: 'event not found' });
    res.status(204).end();
});

export default router;
