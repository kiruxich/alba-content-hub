// CRM: компании, контакты, сделки и общая лента активностей.
//
// Заказчики собираются парсерами (parser_niches / scrape_niches) - это сырьё,
// которое перезаписывается при каждом перезапуске сбора. CRM - это то, что
// человек делает с этим сырьём дальше: кому позвонил, что ответили, на какой
// стадии сделка. Поэтому таблицы отдельные, а импорт идёт в одну сторону:
// сводная база -> CRM, с дедупом по домену и телефону.
import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db.js';

const router = Router();

// Стадии сделки. Хранятся в crm_deals.stage строкой без CHECK-constraint
// (как ideas.status), так что порядок/названия правятся здесь и не требуют
// миграции. isClosed - стадии, которые не считаются в «в работе».
export const CRM_STAGES = [
    { id: 'new', title: 'Новый лид', color: '#8e8e93' },
    { id: 'contacted', title: 'Связались', color: '#0a84ff' },
    { id: 'proposal', title: 'Отправили КП', color: '#bf5af2' },
    { id: 'negotiation', title: 'Переговоры', color: '#ff9f0a' },
    { id: 'won', title: 'Выиграно', color: '#30d158', isClosed: true, isWon: true },
    { id: 'lost', title: 'Отказ', color: '#ff453a', isClosed: true },
];
const STAGE_IDS = CRM_STAGES.map(s => s.id);

const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'task', 'stage_change'];

function now() { return Math.floor(Date.now() / 1000); }
function newId() { return crypto.randomUUID(); }

// ---------- НОРМАЛИЗАЦИЯ (те же правила, что в сводной базе) ----------
// Дедуп при импорте обязан совпадать с тем, как склеиваются строки в
// /api/scrape-niches/merged, иначе одна и та же компания приедет в CRM
// дважды - разными «источниками» одного и того же лида.
function domainKey(site) {
    const m = String(site || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/i);
    return m ? m[1].toLowerCase() : '';
}
function phoneKey(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}
function nameKey(name, city) {
    const n = String(name || '').toLowerCase().replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
    return n ? `${n}|${String(city || '').toLowerCase().trim()}` : '';
}

// ---------- СЕРИАЛИЗАЦИЯ ----------
const company = r => ({
    id: r.id, name: r.name, domain: r.domain || '', phone: r.phone || '', email: r.email || '',
    address: r.address || '', city: r.city || '', niche: r.niche || '',
    telegram: r.telegram || '', vk: r.vk || '', instagram: r.instagram || '',
    description: r.description || '', source: r.source || 'manual',
    createdAt: r.created_at, updatedAt: r.updated_at,
});
const contact = r => ({
    id: r.id, companyId: r.company_id || null, name: r.name, role: r.role || '',
    phone: r.phone || '', email: r.email || '', telegram: r.telegram || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
});
const deal = r => ({
    id: r.id, title: r.title, companyId: r.company_id || null, contactId: r.contact_id || null,
    productId: r.product_id || null, stage: r.stage || 'new', amount: r.amount || 0,
    closeDate: r.close_date || null, lostReason: r.lost_reason || '',
    createdAt: r.created_at, updatedAt: r.updated_at,
});
const activity = r => ({
    id: r.id, kind: r.kind || 'note', body: r.body || '',
    companyId: r.company_id || null, contactId: r.contact_id || null, dealId: r.deal_id || null,
    dueAt: r.due_at || null, done: Boolean(r.done),
    createdAt: r.created_at, updatedAt: r.updated_at,
});

// Общий CRUD-конструктор: три объекта отличаются только таблицей, списком
// полей и сериализатором, а маршруты у них ровно одинаковые. Писать их
// трижды руками - три места, где потом разъедется поведение.
function crudRoutes(path, table, fields, serialize, { required = [] } = {}) {
    router.get(path, async (req, res) => {
        const rows = (await db.execute(`SELECT * FROM ${table} ORDER BY updated_at DESC`)).rows;
        res.json(rows.map(serialize));
    });

    router.post(path, async (req, res) => {
        const body = req.body || {};
        for (const f of required) {
            if (!String(body[f.js] ?? '').trim()) return res.status(400).json({ error: `${f.js} is required` });
        }
        const id = newId();
        // В INSERT попадают только реально присланные поля. Иначе
        // normalizeValue вернула бы '' для каждого пропущенного, и DEFAULT из
        // схемы не сработал бы: сделка без явного stage заводилась со
        // stage='' и выпадала из всех колонок доски.
        const given = fields.filter(f => body[f.js] !== undefined);
        const cols = ['id', ...given.map(f => f.sql)];
        const vals = [id, ...given.map(f => normalizeValue(f, body[f.js]))];
        await db.execute({
            sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            args: vals,
        });
        const row = (await db.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [id] })).rows[0];
        res.status(201).json(serialize(row));
    });

    router.put(`${path}/:id`, async (req, res) => {
        const row = (await db.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [req.params.id] })).rows[0];
        if (!row) return res.status(404).json({ error: 'not found' });
        const body = req.body || {};
        // Патчим только присланные поля: фронт шлёт по одному полю на
        // инлайн-правку в таблице, а не всю запись целиком.
        const touched = fields.filter(f => body[f.js] !== undefined);
        if (touched.length) {
            await db.execute({
                sql: `UPDATE ${table} SET ${touched.map(f => `${f.sql} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
                args: [...touched.map(f => normalizeValue(f, body[f.js])), now(), req.params.id],
            });
        }
        const updated = (await db.execute({ sql: `SELECT * FROM ${table} WHERE id = ?`, args: [req.params.id] })).rows[0];
        res.json(serialize(updated));
    });

    router.delete(`${path}/:id`, async (req, res) => {
        await db.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [req.params.id] });
        res.status(204).end();
    });
}

function normalizeValue(field, value) {
    if (field.type === 'int') {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n) : 0;
    }
    if (field.type === 'nullableInt') {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n) : null;
    }
    if (field.type === 'bool') return value ? 1 : 0;
    if (field.type === 'id') return value ? String(value) : null;
    return String(value ?? '').trim();
}

const COMPANY_FIELDS = [
    { js: 'name', sql: 'name' }, { js: 'domain', sql: 'domain' }, { js: 'phone', sql: 'phone' },
    { js: 'email', sql: 'email' }, { js: 'address', sql: 'address' }, { js: 'city', sql: 'city' },
    { js: 'niche', sql: 'niche' }, { js: 'telegram', sql: 'telegram' }, { js: 'vk', sql: 'vk' },
    { js: 'instagram', sql: 'instagram' }, { js: 'description', sql: 'description' },
    { js: 'source', sql: 'source' },
];
const CONTACT_FIELDS = [
    { js: 'companyId', sql: 'company_id', type: 'id' }, { js: 'name', sql: 'name' },
    { js: 'role', sql: 'role' }, { js: 'phone', sql: 'phone' }, { js: 'email', sql: 'email' },
    { js: 'telegram', sql: 'telegram' },
];
const DEAL_FIELDS = [
    { js: 'title', sql: 'title' }, { js: 'companyId', sql: 'company_id', type: 'id' },
    { js: 'contactId', sql: 'contact_id', type: 'id' }, { js: 'productId', sql: 'product_id', type: 'id' },
    { js: 'stage', sql: 'stage' }, { js: 'amount', sql: 'amount', type: 'int' },
    { js: 'closeDate', sql: 'close_date', type: 'nullableInt' }, { js: 'lostReason', sql: 'lost_reason' },
];
const ACTIVITY_FIELDS = [
    { js: 'kind', sql: 'kind' }, { js: 'body', sql: 'body' },
    { js: 'companyId', sql: 'company_id', type: 'id' }, { js: 'contactId', sql: 'contact_id', type: 'id' },
    { js: 'dealId', sql: 'deal_id', type: 'id' },
    { js: 'dueAt', sql: 'due_at', type: 'nullableInt' }, { js: 'done', sql: 'done', type: 'bool' },
];

// ---------- СВОДКА (объявлена до CRUD, иначе '/companies/:id' её перехватит) ----------
router.get('/meta', async (req, res) => {
    const [companies, contacts, deals, activities] = await Promise.all([
        db.execute('SELECT COUNT(*) AS n FROM crm_companies'),
        db.execute('SELECT COUNT(*) AS n FROM crm_contacts'),
        db.execute('SELECT * FROM crm_deals'),
        db.execute("SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'task' AND done = 0"),
    ]);
    const dealRows = deals.rows.map(deal);
    const openDeals = dealRows.filter(d => !CRM_STAGES.find(s => s.id === d.stage)?.isClosed);
    res.json({
        stages: CRM_STAGES,
        counts: {
            companies: Number(companies.rows[0].n),
            contacts: Number(contacts.rows[0].n),
            deals: dealRows.length,
            openDeals: openDeals.length,
            openTasks: Number(activities.rows[0].n),
        },
        pipelineValue: openDeals.reduce((s, d) => s + (d.amount || 0), 0),
        wonValue: dealRows.filter(d => d.stage === 'won').reduce((s, d) => s + (d.amount || 0), 0),
    });
});

// Задачи со сроком - то, что должно быть на виду при открытии CRM.
router.get('/tasks', async (req, res) => {
    const rows = (await db.execute(
        "SELECT * FROM crm_activities WHERE kind = 'task' ORDER BY done ASC, COALESCE(due_at, 9e18) ASC"
    )).rows;
    res.json(rows.map(activity));
});

// Лента по конкретной записи: собственные активности плюс - для компании -
// активности всех её сделок, иначе в карточке компании не видно, что
// происходило по её же сделке.
router.get('/timeline', async (req, res) => {
    const { companyId, contactId, dealId } = req.query;
    const where = [];
    const args = [];
    if (companyId) {
        where.push('(company_id = ? OR deal_id IN (SELECT id FROM crm_deals WHERE company_id = ?))');
        args.push(companyId, companyId);
    }
    if (contactId) { where.push('contact_id = ?'); args.push(contactId); }
    if (dealId) { where.push('deal_id = ?'); args.push(dealId); }
    if (!where.length) return res.json([]);
    const rows = (await db.execute({
        sql: `SELECT * FROM crm_activities WHERE ${where.join(' OR ')} ORDER BY created_at DESC LIMIT 200`,
        args,
    })).rows;
    res.json(rows.map(activity));
});

crudRoutes('/companies', 'crm_companies', COMPANY_FIELDS, company, { required: [{ js: 'name' }] });
crudRoutes('/contacts', 'crm_contacts', CONTACT_FIELDS, contact, { required: [{ js: 'name' }] });
crudRoutes('/deals', 'crm_deals', DEAL_FIELDS, deal, { required: [{ js: 'title' }] });
crudRoutes('/activities', 'crm_activities', ACTIVITY_FIELDS, activity);

// Перетаскивание карточки по доске сделок. Отдельный маршрут, а не PUT с
// одним полем: смена стадии обязана оставлять запись в ленте, иначе история
// «когда сделка дошла до КП» нигде не сохраняется.
router.post('/deals/:id/stage', async (req, res) => {
    const stage = String(req.body?.stage || '');
    if (!STAGE_IDS.includes(stage)) return res.status(400).json({ error: 'unknown stage' });
    const row = (await db.execute({ sql: 'SELECT * FROM crm_deals WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.stage === stage) return res.json(deal(row));

    await db.execute({
        sql: `UPDATE crm_deals SET stage = ?, updated_at = ? WHERE id = ?`,
        args: [stage, now(), req.params.id],
    });
    const from = CRM_STAGES.find(s => s.id === row.stage)?.title || row.stage;
    const to = CRM_STAGES.find(s => s.id === stage)?.title || stage;
    await db.execute({
        sql: `INSERT INTO crm_activities (id, kind, body, company_id, deal_id) VALUES (?, 'stage_change', ?, ?, ?)`,
        args: [newId(), `${from} → ${to}`, row.company_id || null, req.params.id],
    });
    const updated = (await db.execute({ sql: 'SELECT * FROM crm_deals WHERE id = ?', args: [req.params.id] })).rows[0];
    res.json(deal(updated));
});

// ---------- ИМПОРТ ИЗ СВОДНОЙ БАЗЫ ----------
// Читает те же данные, что отдаёт /api/scrape-niches/merged, и заводит по
// каждой организации компанию. Повторный импорт безопасен: существующие
// компании находятся по домену/телефону/названию и только дополняются
// пустыми полями - руками введённые данные не перетираются.
router.post('/import', async (req, res) => {
    const category = (req.body?.category || '').trim();
    const base = `${req.protocol}://${req.get('host')}`;
    let merged;
    try {
        const url = `${base}/api/scrape-niches/merged${category ? `?category=${encodeURIComponent(category)}` : ''}`;
        merged = await (await fetch(url)).json();
    } catch (e) {
        return res.status(502).json({ error: 'Не удалось прочитать сводную базу: ' + e.message });
    }
    const rows = Array.isArray(merged?.rows) ? merged.rows : [];
    if (!rows.length) return res.json({ imported: 0, updated: 0, skipped: 0 });

    const existing = (await db.execute('SELECT * FROM crm_companies')).rows;
    const index = new Map();
    for (const c of existing) {
        if (c.domain) index.set(`dom:${c.domain}`, c);
        const pk = phoneKey(c.phone);
        if (pk) index.set(`tel:${pk}`, c);
        const nk = nameKey(c.name, c.city);
        if (nk) index.set(`name:${nk}`, c);
    }

    let imported = 0, updated = 0, skipped = 0;
    for (const r of rows) {
        const name = String(r.name || '').trim();
        if (!name) { skipped++; continue; }
        const dom = domainKey(r.site);
        const pk = phoneKey(r.phone);
        const nk = nameKey(name, r.city);
        const hit = index.get(`dom:${dom}`) || index.get(`tel:${pk}`) || index.get(`name:${nk}`);

        const incoming = {
            name, domain: dom, phone: r.phone || '', email: r.email || '',
            address: r.address || '', city: r.city || '', niche: r.category || category || '',
            telegram: r.telegram || '', vk: r.vk || '', instagram: r.instagram || '',
            description: r.description || '',
            source: Array.isArray(r.sources) ? (r.sources.length > 1 ? 'both' : r.sources[0]) : 'manual',
        };

        if (hit) {
            // Только пустые поля - импорт не имеет права затирать то, что
            // человек уже поправил руками в карточке.
            const patch = Object.entries(incoming).filter(([k, v]) => v && !hit[k === 'domain' ? 'domain' : k]);
            if (patch.length) {
                await db.execute({
                    sql: `UPDATE crm_companies SET ${patch.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
                    args: [...patch.map(([, v]) => v), now(), hit.id],
                });
                updated++;
            } else {
                skipped++;
            }
            continue;
        }

        const id = newId();
        const cols = Object.keys(incoming);
        await db.execute({
            sql: `INSERT INTO crm_companies (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
            args: [id, ...cols.map(k => incoming[k])],
        });
        const fresh = { id, ...incoming };
        if (dom) index.set(`dom:${dom}`, fresh);
        if (pk) index.set(`tel:${pk}`, fresh);
        if (nk) index.set(`name:${nk}`, fresh);
        imported++;
    }

    res.json({ imported, updated, skipped, total: rows.length });
});

export default router;
