// Вторая база заказчиков: ниши ScrapeGraphAI-воркера + сводная база,
// объединяющая её с 2ГИС-парсером (server/routes/parserNiches.js).
//
// Пайплайн одной ниши:
//   1. local-claude-agent (WebSearch, задача find-client-sites) подбирает
//      сайты компаний по нише и городу;
//   2. scrape-worker обходит их Playwright'ом и разбирает моделью на
//      локальной Ollama (см. scrape-worker/scrape_core.py);
//   3. строки складываются в scrape_niches.results_json - как данные, а не
//      только файлом, потому что из них строится сводная база.
import { Router } from 'express';
import XLSX from 'xlsx';
import crypto from 'crypto';
import { db } from '../db.js';
import { isLocalClaudeAgentConfigured, findClientSites } from '../lib/localClaudeAgent.js';
import {
    isScrapeWorkerConfigured, createScrapeJob, getScrapeJob,
    cancelScrapeJob, fetchScrapeFile, scrapeWorkerHealth,
} from '../lib/scrapeWorkerClient.js';
import { fetchParserFile } from '../lib/parserWorkerClient.js';

const router = Router();

function parseJson(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function serialize(row) {
    return {
        id: row.id,
        category: row.category,
        city: row.city || '',
        status: row.status || 'idle',
        log: row.log || '',
        stats: parseJson(row.stats_json, {}),
        sites: parseJson(row.sites_json, []),
        results: parseJson(row.results_json, []),
        jobId: row.job_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// ---------- НОРМАЛИЗАЦИЯ И СЛИЯНИЕ ------------------------------------

// Последние 10 цифр - единственная надёжная форма телефона на стыке двух
// баз: 2ГИС пишет «+7 (843) 000-00-00», сайт компании - «8 843 0000000»,
// и совпадают они только по цифрам без кода страны.
function phoneKey(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}

function domainKey(site) {
    const m = String(site || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/i);
    return m ? m[1].toLowerCase() : '';
}

function nameKey(name, city) {
    const n = String(name || '').toLowerCase().replace(/[«»"'`]/g, '').replace(/\s+/g, ' ').trim();
    return n ? `${n}|${String(city || '').toLowerCase().trim()}` : '';
}

// Ключей у строки может быть несколько (телефон, домен, имя) - совпадение по
// любому means это одна и та же организация. Поэтому склейка идёт не по
// одному полю, а по объединению ключей, иначе компания с двумя телефонами
// или сменившимся доменом попала бы в сводную дважды.
function rowKeys(row) {
    const keys = [];
    for (const p of String(row.phone || '').split(/[,;]/)) {
        const k = phoneKey(p);
        if (k) keys.push(`tel:${k}`);
    }
    const d = domainKey(row.site);
    if (d) keys.push(`dom:${d}`);
    const n = nameKey(row.name, row.city);
    if (n) keys.push(`name:${n}`);
    return keys;
}

function mergeRows(rows) {
    const byKey = new Map();
    const merged = [];

    for (const row of rows) {
        const keys = rowKeys(row);
        const hit = keys.map(k => byKey.get(k)).find(Boolean);
        if (!hit) {
            const entry = { ...row, sources: [row.source] };
            merged.push(entry);
            keys.forEach(k => byKey.set(k, entry));
            continue;
        }
        // Слияние «непустое побеждает пустое»: 2ГИС почти всегда даёт адрес,
        // ScrapeGraph - email и соцсети, и терять ни то, ни другое нельзя.
        for (const field of ['name', 'address', 'phone', 'site', 'email', 'telegram', 'vk', 'instagram', 'description', 'city']) {
            if (!hit[field] && row[field]) hit[field] = row[field];
        }
        if (!hit.sources.includes(row.source)) hit.sources.push(row.source);
        rowKeys(hit).forEach(k => { if (!byKey.has(k)) byKey.set(k, hit); });
    }
    return merged;
}

// Читает XLSX-выгрузку 2ГИС-ниши. Файл может лежать тремя способами
// (загружен руками в dedup/raw, или остался у воркера под job_id) - порядок
// важен: дедуплицированная выгрузка предпочтительнее сырой.
async function readParserNicheRows(row) {
    const attempts = [];
    if (row.dedup_upload_data) attempts.push(() => Buffer.from(row.dedup_upload_data, 'base64'));
    if (row.raw_upload_data) attempts.push(() => Buffer.from(row.raw_upload_data, 'base64'));
    if (row.job_id && row.dedup_file) attempts.push(async () => Buffer.from(await (await fetchParserFile(row.job_id, 'dedup')).arrayBuffer()));
    if (row.job_id && row.raw_file) attempts.push(async () => Buffer.from(await (await fetchParserFile(row.job_id, 'raw')).arrayBuffer()));

    for (const attempt of attempts) {
        try {
            const buf = await attempt();
            const wb = XLSX.read(buf, { type: 'buffer' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            return json.map(r => ({
                name: String(r['Название'] || '').trim(),
                address: String(r['Адрес'] || '').trim(),
                phone: String(r['Телефон'] || '').trim(),
                site: String(r['Сайт'] || r['URL'] || '').trim(),
                email: '', telegram: '', vk: '', instagram: '', description: '',
                city: '', category: row.category, source: '2gis',
            })).filter(r => r.name || r.phone || r.site);
        } catch (_) {
            continue; // следующий источник файла
        }
    }
    return [];
}

// ---------- СВОДНАЯ БАЗА ----------------------------------------------
// Объявлена ДО '/:id', иначе Express разберёт "merged" как идентификатор ниши.
router.get('/merged', async (req, res) => {
    const wanted = (req.query.category || '').trim().toLowerCase();

    const scrapeRows = (await db.execute('SELECT * FROM scrape_niches')).rows;
    const parserRows = (await db.execute('SELECT * FROM parser_niches')).rows;

    const all = [];
    for (const row of scrapeRows) {
        if (wanted && String(row.category || '').toLowerCase() !== wanted) continue;
        for (const r of parseJson(row.results_json, [])) {
            all.push({ ...r, city: r.city || row.city || '', category: row.category, source: 'scrape' });
        }
    }
    for (const row of parserRows) {
        if (wanted && String(row.category || '').toLowerCase() !== wanted) continue;
        for (const r of await readParserNicheRows(row)) all.push(r);
    }

    const merged = mergeRows(all);
    const categories = [...new Set([...scrapeRows, ...parserRows].map(r => r.category).filter(Boolean))].sort();
    res.json({
        categories,
        rows: merged,
        stats: {
            total: merged.length,
            both: merged.filter(r => r.sources.length > 1).length,
            onlyParser: merged.filter(r => r.sources.length === 1 && r.sources[0] === '2gis').length,
            onlyScrape: merged.filter(r => r.sources.length === 1 && r.sources[0] === 'scrape').length,
            withEmail: merged.filter(r => r.email).length,
        },
    });
});

router.get('/merged/download', async (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    const data = await (await fetch(`${base}/api/scrape-niches/merged${req.query.category ? `?category=${encodeURIComponent(req.query.category)}` : ''}`)).json();
    const sourceLabel = (s) => (s.length > 1 ? 'оба' : (s[0] === '2gis' ? '2ГИС' : 'ScrapeGraph'));
    const aoa = [['№', 'Название', 'Ниша', 'Город', 'Адрес', 'Телефон', 'Сайт', 'Email', 'Telegram', 'VK', 'Instagram', 'Источник']];
    data.rows.forEach((r, i) => aoa.push([
        i + 1, r.name, r.category || '', r.city || '', r.address, r.phone,
        r.site, r.email, r.telegram, r.vk, r.instagram, sourceLabel(r.sources),
    ]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Сводная база');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="merged-customers.xlsx"');
    res.send(buf);
});

router.get('/health', async (req, res) => {
    if (!isScrapeWorkerConfigured()) return res.json({ configured: false });
    try {
        res.json({ configured: true, ...(await scrapeWorkerHealth()) });
    } catch (e) {
        res.json({ configured: true, ok: false, error: e.message });
    }
});

// ---------- CRUD ниш ---------------------------------------------------

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM scrape_niches ORDER BY created_at DESC');
    res.json(result.rows.map(serialize));
});

router.post('/', async (req, res) => {
    const category = (req.body?.category || '').trim();
    if (!category) return res.status(400).json({ error: 'category is required' });
    const id = crypto.randomUUID();
    await db.execute({
        sql: 'INSERT INTO scrape_niches (id, category, city) VALUES (?, ?, ?)',
        args: [id, category, (req.body?.city || '').trim()],
    });
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [id] })).rows[0];
    res.status(201).json(serialize(row));
});

router.put('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await db.execute({
        sql: `UPDATE scrape_niches SET category = ?, city = ?, updated_at = strftime('%s','now') WHERE id = ?`,
        args: [
            req.body?.category !== undefined ? String(req.body.category).trim() : row.category,
            req.body?.city !== undefined ? String(req.body.city).trim() : (row.city || ''),
            req.params.id,
        ],
    });
    const updated = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    res.json(serialize(updated));
});

router.delete('/:id', async (req, res) => {
    await db.execute({ sql: 'DELETE FROM scrape_niches WHERE id = ?', args: [req.params.id] });
    res.status(204).end();
});

router.get('/:id', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(serialize(row));
});

// ---------- ЗАПУСК И ПОЛЛИНГ ------------------------------------------

router.post('/:id/run', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!isLocalClaudeAgentConfigured()) {
        return res.status(503).json({ error: 'local-claude-agent не настроен — без него некому подобрать сайты для обхода' });
    }
    if (!isScrapeWorkerConfigured()) {
        return res.status(503).json({ error: 'SCRAPE_WORKER_URL не настроен — поднимите scrape-worker (scrape-worker/docker-compose.yml)' });
    }

    // Уже собранные домены уходят в промпт как стоп-лист: повторный запуск
    // должен приносить НОВЫЕ компании, а не пересобирать те же самые.
    const known = parseJson(row.results_json, []).map(r => domainKey(r.site)).filter(Boolean);

    await db.execute({
        sql: `UPDATE scrape_niches SET status = 'searching', log = ?, updated_at = strftime('%s','now') WHERE id = ?`,
        args: ['Ищем сайты компаний через local-claude-agent…', req.params.id],
    });

    try {
        const { sites } = await findClientSites({
            category: row.category,
            city: row.city || '',
            excludeDomains: known,
            limit: Number(req.body?.limit) || 30,
        });
        if (!sites?.length) {
            await db.execute({
                sql: `UPDATE scrape_niches SET status = 'error', log = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                args: ['Поиск не вернул ни одного сайта — уточните нишу или город', req.params.id],
            });
            return res.status(502).json({ error: 'Поиск не вернул ни одного сайта' });
        }

        const job = await createScrapeJob({
            nicheId: row.id, category: row.category, city: row.city || '',
            sites: sites.map(s => s.url), maxSites: sites.length,
        });
        await db.execute({
            sql: `UPDATE scrape_niches SET status = 'running', job_id = ?, sites_json = ?, log = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [job.job_id, JSON.stringify(sites), `Найдено сайтов: ${sites.length}. Обход запущен.`, req.params.id],
        });
        const updated = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
        res.json(serialize(updated));
    } catch (e) {
        await db.execute({
            sql: `UPDATE scrape_niches SET status = 'error', log = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [e.message, req.params.id],
        });
        res.status(502).json({ error: e.message });
    }
});

router.get('/:id/status', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!row.job_id) return res.json(serialize(row));

    try {
        const job = await getScrapeJob(row.job_id);
        // results_json перезаписываем только когда воркер что-то вернул -
        // иначе упавший на середине job стёр бы предыдущий удачный сбор.
        const rows = Array.isArray(job.rows) && job.rows.length ? job.rows : parseJson(row.results_json, []);
        await db.execute({
            sql: `UPDATE scrape_niches SET status = ?, log = ?, stats_json = ?, results_json = ?, updated_at = strftime('%s','now') WHERE id = ?`,
            args: [job.status || 'running', job.log || '', JSON.stringify(job.stats || {}), JSON.stringify(rows), req.params.id],
        });
        const updated = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
        res.json(serialize(updated));
    } catch (e) {
        res.json({ ...serialize(row), workerError: e.message });
    }
});

router.post('/:id/cancel', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row?.job_id) return res.status(400).json({ error: 'Нечего останавливать' });
    try {
        await cancelScrapeJob(row.job_id);
        await db.execute({
            sql: `UPDATE scrape_niches SET status = 'cancelled', updated_at = strftime('%s','now') WHERE id = ?`,
            args: [req.params.id],
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

router.get('/:id/download', async (req, res) => {
    const row = (await db.execute({ sql: 'SELECT * FROM scrape_niches WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!row) return res.status(404).send('not found');
    if (row.job_id) {
        try {
            const buf = await fetchScrapeFile(row.job_id);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.category)}.xlsx"`);
            return res.send(buf);
        } catch (_) {
            // Воркер мог уже почистить файлы job'а - собираем XLSX из того,
            // что сохранено в базе, вместо 404.
        }
    }
    const rows = parseJson(row.results_json, []);
    if (!rows.length) return res.status(404).send('Нет собранных данных');
    const aoa = [['№', 'Название', 'Адрес', 'Телефон', 'Сайт', 'Email', 'Telegram', 'VK', 'Instagram', 'Описание']];
    rows.forEach((r, i) => aoa.push([i + 1, r.name, r.address, r.phone, r.site, r.email, r.telegram, r.vk, r.instagram, r.description]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Заказчики');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.category)}.xlsx"`);
    res.send(buf);
});

export default router;
