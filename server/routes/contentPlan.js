import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// One-time upgrade path for blocks saved before the timeline UI existed:
// the old shape had no `kind`/`period`, just {id, title, color, text}.
// q1-q4 become 'quarter' entries with their product name pulled out of the
// old combined title; everything else becomes a 'note'.
const LEGACY_QUARTER_META = {
    q1: { title: 'ДУЭТ', period: 'Январь — Март' },
    q2: { title: 'InSights', period: 'Апрель — Июнь' },
    q3: { title: '«Хранитель»', period: 'Июль — Сентябрь' },
    q4: { title: 'Crista & Фантазия', period: 'Октябрь — Декабрь' },
};

function migrateBlock(b) {
    if (b.kind === 'quarter' || b.kind === 'note') return b;
    const meta = LEGACY_QUARTER_META[b.id];
    if (meta) {
        return { id: b.id, kind: 'quarter', title: meta.title, period: meta.period, color: b.color, text: b.text };
    }
    return { id: b.id, kind: 'note', title: b.title, color: b.color, text: b.text };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT blocks FROM content_plan WHERE id = 1');
    const blocks = JSON.parse(result.rows[0]?.blocks || '[]').map(migrateBlock);
    res.json({ blocks });
});

router.put('/', async (req, res) => {
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    await db.execute({ sql: 'UPDATE content_plan SET blocks = ? WHERE id = 1', args: [JSON.stringify(blocks)] });
    res.json({ blocks });
});

export default router;
