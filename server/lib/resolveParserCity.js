import { db } from '../db.js';
import { isLocalClaudeAgentConfigured, resolveCity as resolveCityViaAgent } from './localClaudeAgent.js';

// Any city other than Moscow (typed free-text by the user on a parser niche
// card) gets resolved to a real 2GIS slug + bounding box via local-claude-
// agent's WebSearch-backed /run/resolve-city task, then cached here keyed by
// the lowercased city name - so the same city typed on multiple niches, or
// re-run later, only ever calls the agent once.
const MOSCOW = { slug: 'moscow', label: 'Москва', latMin: 55.1, latMax: 56.2, lonMin: 36.7, lonMax: 38.4 };

export async function resolveParserCity(cityNameRaw) {
    const cityName = (cityNameRaw || '').trim();
    if (!cityName || ['moscow', 'москва'].includes(cityName.toLowerCase())) {
        return MOSCOW;
    }

    const key = cityName.toLowerCase();
    const cached = (await db.execute({ sql: 'SELECT * FROM parser_city_cache WHERE city_name = ?', args: [key] })).rows[0];
    if (cached) {
        return { slug: cached.slug, label: cached.label, latMin: cached.lat_min, latMax: cached.lat_max, lonMin: cached.lon_min, lonMax: cached.lon_max };
    }

    if (!isLocalClaudeAgentConfigured()) {
        throw new Error(`Город «${cityName}» ещё не определялся, а local-claude-agent не настроен, чтобы найти его автоматически — проверьте, что контейнер/туннель на вашем ПК запущены`);
    }

    const resolved = await resolveCityViaAgent(cityName);
    const nums = [resolved?.latMin, resolved?.latMax, resolved?.lonMin, resolved?.lonMax];
    if (typeof resolved?.slug !== 'string' || !resolved.slug.trim() || nums.some(n => typeof n !== 'number')) {
        throw new Error(`Не удалось определить параметры города «${cityName}»`);
    }

    await db.execute({
        sql: `INSERT INTO parser_city_cache (city_name, slug, label, lat_min, lat_max, lon_min, lon_max)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(city_name) DO UPDATE SET
                slug = excluded.slug, label = excluded.label,
                lat_min = excluded.lat_min, lat_max = excluded.lat_max,
                lon_min = excluded.lon_min, lon_max = excluded.lon_max`,
        args: [key, resolved.slug.trim(), resolved.label || cityName, resolved.latMin, resolved.latMax, resolved.lonMin, resolved.lonMax],
    });

    return { slug: resolved.slug.trim(), label: resolved.label || cityName, latMin: resolved.latMin, latMax: resolved.latMax, lonMin: resolved.lonMin, lonMax: resolved.lonMax };
}
