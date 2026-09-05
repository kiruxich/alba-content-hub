// Общие сборщики контекста для всех точек ИИ-генерации.
//
// Раньше каждая генерация знала только про свой экран: роадмап видел лишь
// «О проекте» своего продукта, генерация поста - только описание продукта и
// тон голоса, скрипт звонка - вообще ничего о том, что Alba продаёт. При этом
// в системе уже лежали и стратегия (контент-план), и выводы агентов, и
// реальные метрики публикаций - просто никто их не читал.
//
// Каждый сборщик возвращает готовый человекочитаемый текст или пустую строку и
// НИКОГДА не бросает: контекст - это обогащение, и упавший запрос к одной
// таблице не должен ронять генерацию целиком. Отсюда try/catch вокруг каждого.
import { db } from '../db.js';

// Ограничители на всякий случай: контекст уходит в промпт, и разросшийся
// контент-план не должен вытеснять собственно задачу.
const MAX_FIELD = 600;
const MAX_RECOMMENDATIONS = 4;

function clip(text, max = MAX_FIELD) {
    const s = String(text || '').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

// «О проекте» одного продукта. Раньше эта же выборка была продублирована в
// contentDrafts.js своей копией - теперь она одна.
export async function buildProductContext(productId) {
    if (!productId) return '';
    try {
        const info = (await db.execute({
            sql: 'SELECT about, target_audience, value_proposition, key_differentiators FROM project_info WHERE product_id = ?',
            args: [productId],
        })).rows[0];
        if (!info) return '';
        return [
            info.about && `О продукте: ${clip(info.about)}`,
            info.target_audience && `Аудитория: ${clip(info.target_audience)}`,
            info.value_proposition && `Ценность: ${clip(info.value_proposition)}`,
            info.key_differentiators && `Отличия: ${clip(info.key_differentiators)}`,
        ].filter(Boolean).join('\n');
    } catch {
        return '';
    }
}

// Каталог продуктов одной строкой на продукт. Нужен там, где модель продаёт
// от лица студии, а не пишет про один конкретный продукт: скрипт звонка без
// этого не знает, что вообще можно предложить собеседнику.
export async function buildProductsCatalogContext() {
    try {
        const rows = (await db.execute(
            'SELECT product_id, about, value_proposition FROM project_info'
        )).rows;
        if (!rows.length) return '';
        const { PRODUCTS } = await import('./products.js');
        const titleOf = id => PRODUCTS.find(p => p.id === id)?.title || id;
        const lines = rows
            .map(r => {
                const pitch = clip(r.value_proposition || r.about, 200);
                return pitch ? `- ${titleOf(r.product_id)}: ${pitch}` : null;
            })
            .filter(Boolean);
        return lines.length ? `Продукты студии:\n${lines.join('\n')}` : '';
    } catch {
        return '';
    }
}

// Последние выводы агента Insights (см. docs/insights-agent-routine.md) -
// «что реально сработало» в опубликованном контенте. Хранятся в agent_runs
// тем же способом, что и выводы «Маркетолога», которые контент-план уже
// подмешивает в стратегический бриф.
export async function buildInsightsContext() {
    try {
        const row = (await db.execute(
            "SELECT run_date, brief_json FROM agent_runs WHERE agent_name = 'insights' AND status = 'success' AND brief_json IS NOT NULL ORDER BY id DESC LIMIT 1"
        )).rows[0];
        if (!row) return '';
        const parsed = JSON.parse(row.brief_json);
        const lines = [`Выводы агента «Insights» (от ${row.run_date}): ${clip(parsed.summary)}`];
        const recs = (parsed.recommendations || []).slice(0, MAX_RECOMMENDATIONS);
        if (recs.length) {
            lines.push('Рекомендации по итогам публикаций:');
            for (const r of recs) {
                const text = typeof r === 'string' ? r : r?.text;
                if (text) lines.push(`- ${clip(text, 240)}`);
            }
        }
        return lines.join('\n');
    } catch {
        return '';
    }
}

// Фактические результаты публикаций за период: какие форматы и площадки
// реально собирают просмотры. Это сырые цифры из scheduled_events, в отличие
// от buildInsightsContext(), где лежит уже осмысленный вывод агента. Нужны
// оба: агент мог не запускаться неделями, а цифры есть всегда.
export async function buildPerformanceContext({ days = 30 } = {}) {
    try {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString().slice(0, 10);
        const rows = (await db.execute({
            sql: `SELECT se.platform, se.metrics_views, se.metrics_saves,
                         COALESCE(se.format, i.format) AS format
                  FROM scheduled_events se
                  JOIN ideas i ON i.id = se.idea_id
                  WHERE se.raw_date >= ? AND se.publish_status = 'published'`,
            args: [sinceStr],
        })).rows;
        if (!rows.length) return '';

        const byFormat = new Map();
        for (const r of rows) {
            const key = r.format || 'Без формата';
            if (!byFormat.has(key)) byFormat.set(key, { n: 0, views: 0, saves: 0 });
            const g = byFormat.get(key);
            g.n += 1;
            g.views += Number(r.metrics_views || 0);
            g.saves += Number(r.metrics_saves || 0);
        }
        const ranked = [...byFormat.entries()]
            .map(([format, g]) => ({ format, n: g.n, avgViews: Math.round(g.views / g.n), avgSaves: Math.round(g.saves / g.n) }))
            .sort((a, b) => b.avgViews - a.avgViews)
            .slice(0, 5);
        // Все нули - это не «сработало плохо», а «метрики ещё не собрались»
        // (см. METRICS_COLLECTION_DAYS на фронте). Такой контекст только
        // введёт модель в заблуждение.
        if (ranked.every(r => r.avgViews === 0 && r.avgSaves === 0)) return '';

        return `Фактические результаты за последние ${days} дней (публикаций: ${rows.length}):\n` +
            ranked.map(r => `- ${r.format}: ${r.n} публ., в среднем ${r.avgViews} просмотров, ${r.avgSaves} сохранений`).join('\n');
    } catch {
        return '';
    }
}

// Состояние продаж: сколько лидов и сделок в CRM и на каких стадиях. Для
// роадмапа продвижения это разница между «нужен первый трафик» и «трафик
// есть, ломается конверсия».
export async function buildSalesContext() {
    try {
        const [companies, deals] = await Promise.all([
            db.execute('SELECT COUNT(*) AS n FROM crm_companies'),
            db.execute('SELECT stage, amount FROM crm_deals'),
        ]);
        const companyCount = Number(companies.rows[0]?.n || 0);
        const dealRows = deals.rows;
        if (!companyCount && !dealRows.length) return '';
        const byStage = new Map();
        for (const d of dealRows) byStage.set(d.stage, (byStage.get(d.stage) || 0) + 1);
        const won = dealRows.filter(d => d.stage === 'won');
        const parts = [`В CRM компаний: ${companyCount}, сделок: ${dealRows.length}`];
        if (byStage.size) {
            parts.push(`по стадиям: ${[...byStage.entries()].map(([s, n]) => `${s} — ${n}`).join(', ')}`);
        }
        if (won.length) {
            parts.push(`выиграно ${won.length} на ${won.reduce((a, d) => a + (d.amount || 0), 0)} ₽`);
        }
        return `Состояние продаж: ${parts.join('; ')}.`;
    } catch {
        return '';
    }
}

// Склеивает непустые куски в один блок. Отдельная функция, потому что иначе
// каждый вызывающий писал бы свой filter(Boolean).join и рано или поздно
// уронил бы пустую строку с двойным переносом в промпт.
export function joinContext(...parts) {
    return parts.map(p => String(p || '').trim()).filter(Boolean).join('\n\n');
}
