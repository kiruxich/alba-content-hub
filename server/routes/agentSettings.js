import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

function serialize(row) {
    return {
        sources: JSON.parse(row.sources || '[]'),
        keywords: JSON.parse(row.keywords || '[]'),
        toneOfVoice: row.tone_of_voice || '',
        budgetDailyCapUsd: row.budget_daily_cap_usd,
        videoGenerationEnabled: Boolean(row.video_generation_enabled),
        platformAutoPublish: JSON.parse(row.platform_auto_publish || '{}'),
        productOfWeekOverride: row.product_of_week_override || null,
        weeklySchedule: JSON.parse(row.weekly_schedule || '[]'),
        postFormula: row.post_formula || '',
    };
}

router.get('/', async (req, res) => {
    const result = await db.execute('SELECT * FROM agent_settings WHERE id = 1');
    res.json(serialize(result.rows[0]));
});

router.put('/', async (req, res) => {
    const b = req.body || {};
    const current = (await db.execute('SELECT * FROM agent_settings WHERE id = 1')).rows[0];

    const sources = b.sources !== undefined ? JSON.stringify(b.sources) : current.sources;
    const keywords = b.keywords !== undefined ? JSON.stringify(b.keywords) : current.keywords;
    const tone_of_voice = b.toneOfVoice !== undefined ? b.toneOfVoice : current.tone_of_voice;
    const budget_daily_cap_usd = b.budgetDailyCapUsd !== undefined ? b.budgetDailyCapUsd : current.budget_daily_cap_usd;
    const video_generation_enabled = b.videoGenerationEnabled !== undefined
        ? (b.videoGenerationEnabled ? 1 : 0) : current.video_generation_enabled;
    const platform_auto_publish = b.platformAutoPublish !== undefined
        ? JSON.stringify(b.platformAutoPublish) : current.platform_auto_publish;
    const product_of_week_override = b.productOfWeekOverride !== undefined
        ? b.productOfWeekOverride : current.product_of_week_override;
    const weekly_schedule = b.weeklySchedule !== undefined ? JSON.stringify(b.weeklySchedule) : current.weekly_schedule;
    const post_formula = b.postFormula !== undefined ? b.postFormula : current.post_formula;

    await db.execute({
        sql: `UPDATE agent_settings SET sources = ?, keywords = ?, tone_of_voice = ?, budget_daily_cap_usd = ?,
              video_generation_enabled = ?, platform_auto_publish = ?, product_of_week_override = ?,
              weekly_schedule = ?, post_formula = ? WHERE id = 1`,
        args: [sources, keywords, tone_of_voice, budget_daily_cap_usd, video_generation_enabled,
            platform_auto_publish, product_of_week_override, weekly_schedule, post_formula],
    });
    const result = await db.execute('SELECT * FROM agent_settings WHERE id = 1');
    res.json(serialize(result.rows[0]));
});

export default router;
