import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The VPS this now runs on silently hangs (no error, no timeout) any HTTP
// request to Turso past the ~5th one on a kept-alive connection - some
// middlebox on that network path breaks on connection reuse specifically
// (confirmed: fresh connections always work instantly, reused ones stall
// forever). Forcing "Connection: close" makes undici drop the socket after
// every response instead of pooling it, which sidesteps the issue entirely.
function noKeepAliveFetch(input, init) {
    // @libsql/client calls this with a pre-built Request object as `input`
    // (not a bare URL string) - cloning its headers instead of init.headers
    // is what keeps the Authorization header intact.
    if (input instanceof Request) {
        const headers = new Headers(input.headers);
        headers.set('Connection', 'close');
        return fetch(new Request(input, { headers }));
    }
    const headers = new Headers((init && init.headers) || {});
    headers.set('Connection', 'close');
    return fetch(input, { ...init, headers });
}

function makeClient() {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) {
        // Production (Vercel) and any dev session pointed at a real Turso db.
        return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN, fetch: noKeepAliveFetch });
    }
    // Local dev fallback: a file-based libSQL db, no Turso account needed.
    // Vercel's filesystem is read-only/ephemeral per invocation, so this branch
    // must never be reached in production - set TURSO_DATABASE_URL there.
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return createClient({ url: `file:${path.join(dataDir, 'alba-content-hub.db')}` });
}

export const db = makeClient();

// SQLite errors on ALTER TABLE ADD COLUMN if the column already exists, so
// this checks PRAGMA table_info first - safe to run on every startup, unlike
// a bare ALTER TABLE which would only be safe to run once.
async function ensureColumn(table, column, definition) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const exists = info.rows.some(r => r.name === column);
    if (!exists) {
        try {
            await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        } catch (e) {
            // The check-then-ALTER above isn't atomic across processes - if two
            // instances cold-start at once against the same DB, both can see
            // the column missing and race to add it. The loser just needs to
            // not crash; the column is there either way.
            if (!/duplicate column name/i.test(e.message)) throw e;
        }
    }
}

await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    desc TEXT DEFAULT '',
    format TEXT DEFAULT 'TG Пост',
    funnel TEXT DEFAULT 'TOFU',
    status TEXT DEFAULT 'idea',
    cta TEXT DEFAULT '',
    target_groups TEXT DEFAULT '[]',
    metrics_views INTEGER DEFAULT 0,
    metrics_saves INTEGER DEFAULT 0,
    metrics_clicks INTEGER DEFAULT 0,
    metrics_leads INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_title ON ideas(title);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);

CREATE TABLE IF NOT EXISTS scheduled_events (
    id INTEGER PRIMARY KEY,
    idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    date_str TEXT,
    raw_date TEXT NOT NULL,
    color TEXT,
    format TEXT,
    cta TEXT,
    desc TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_raw_date ON scheduled_events(raw_date);

CREATE TABLE IF NOT EXISTS plan_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily INTEGER NOT NULL DEFAULT 1,
    weekly INTEGER NOT NULL DEFAULT 7
);
INSERT OR IGNORE INTO plan_settings (id, daily, weekly) VALUES (1, 1, 7);

-- token: the one bot token used for everything Telegram (both the publish
-- channels below and admin notifications). chat_id: NOT a publish target -
-- it's the single admin/notifications chat used by the idea-approval
-- workflow (server/lib/telegramApproval.js), agent researcher summaries and
-- parser job alerts (agentResearcher.js, parserNiches.js), and reply
-- correlation (telegramWebhook.js). Left untouched by the multi-channel
-- publish feature below on purpose - those flows are unrelated to the Bank
-- of Ideas "Опубликовать" modal and must keep working unchanged.
CREATE TABLE IF NOT EXISTS telegram_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT DEFAULT '',
    chat_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO telegram_settings (id, token, chat_id) VALUES (1, '', '');

-- Channels the bot (telegram_settings.token) can publish ideas to from the
-- Bank of Ideas "Опубликовать" modal - one bot, many channels it's admin of.
-- See server/routes/telegram.js's /post route (takes a channelId, resolves
-- chat_id here server-side) and server/routes/settings.js for CRUD.
CREATE TABLE IF NOT EXISTS telegram_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- VK: a community (group) access token with wall permission, plus the group
-- id it posts to. See server/lib/socialPublishers/vk.js.
CREATE TABLE IF NOT EXISTS vk_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    group_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO vk_settings (id, access_token, group_id) VALUES (1, '', '');

-- Instagram: a long-lived Page access token (Meta Graph API) plus the
-- connected Instagram Business/Creator account id it publishes to. See
-- server/lib/socialPublishers/instagram.js.
CREATE TABLE IF NOT EXISTS instagram_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    business_account_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO instagram_settings (id, access_token, business_account_id) VALUES (1, '', '');

-- YouTube: OAuth2 client credentials + a long-lived refresh token (obtained
-- once via a consent flow, not a simple pasted token - see
-- scripts/register-youtube-oauth.mjs and server/lib/socialPublishers/youtube.js).
CREATE TABLE IF NOT EXISTS youtube_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT DEFAULT '',
    client_secret TEXT DEFAULT '',
    refresh_token TEXT DEFAULT '',
    channel_title TEXT DEFAULT ''
);
INSERT OR IGNORE INTO youtube_settings (id, client_id, client_secret, refresh_token, channel_title) VALUES (1, '', '', '', '');

-- Threads: a Threads user access token (threads_basic + threads_content_publish
-- scopes, from a Meta app with the "Threads use case" - a separate app type
-- from Instagram's Graph API) plus the Threads user id it publishes to. See
-- server/lib/socialPublishers/threads.js.
CREATE TABLE IF NOT EXISTS threads_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    user_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO threads_settings (id, access_token, user_id) VALUES (1, '', '');

-- Two-way approval workflow: one row per idea sent to Telegram for review,
-- keyed by the sendMessage-returned message_id so an incoming reply (whose
-- reply_to_message.message_id points back at it) can be correlated to the
-- idea it's about. See server/lib/telegramApproval.js (creates rows) and
-- server/routes/telegramWebhook.js (consumes them on reply).
CREATE TABLE IF NOT EXISTS telegram_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id TEXT REFERENCES ideas(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    regenerate_notes TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_approvals_message_id ON telegram_approvals(message_id);
CREATE INDEX IF NOT EXISTS idx_telegram_approvals_idea_id ON telegram_approvals(idea_id);

CREATE TABLE IF NOT EXISTS content_plan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    blocks TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS niches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    sections TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS project_info (
    product_id TEXT PRIMARY KEY,
    about TEXT DEFAULT ''
);
-- roadmap_json: JSON array of {id, title, description, status}, status one of
-- planned/in_progress/done. Replaces the old hardcoded single-entry roadmap
-- that used to live in frontend productsData.

-- AI Agent pipeline (Phase 1 schema - see planning discussion). Ideas and
-- scheduled_events (conceptually "publications", one row per idea per
-- platform) gain columns below via ensureColumn() rather than being
-- redefined here, since they already exist with live data.

CREATE TABLE IF NOT EXISTS agent_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER DEFAULT (strftime('%s','now')),
    agent_name TEXT NOT NULL,
    model_used TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    kie_credits_spent NUMERIC DEFAULT 0,
    total_usd NUMERIC DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_expenses_timestamp ON agent_expenses(timestamp);

CREATE TABLE IF NOT EXISTS agent_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sources TEXT DEFAULT '[]',
    keywords TEXT DEFAULT '[]',
    tone_of_voice TEXT DEFAULT '',
    budget_daily_cap_usd NUMERIC DEFAULT 1.0,
    video_generation_enabled INTEGER DEFAULT 0,
    platform_auto_publish TEXT DEFAULT '{}',
    product_of_week_override TEXT
);
INSERT OR IGNORE INTO agent_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    log TEXT DEFAULT '',
    cost_usd NUMERIC DEFAULT 0,
    trends_found INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at);

CREATE TABLE IF NOT EXISTS product_embeddings (
    product_id TEXT PRIMARY KEY,
    vector TEXT NOT NULL,
    source_text_hash TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS platform_connections (
    platform TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    status TEXT DEFAULT 'disconnected',
    account_name TEXT,
    connected_at INTEGER
);

-- Reusable production templates ("рубрики"): the Generator fills a proven
-- structure instead of inventing post shape from scratch every time.
CREATE TABLE IF NOT EXISTS content_rubrics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    structure_template TEXT DEFAULT '[]',
    target_funnel TEXT DEFAULT 'TOFU',
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Reusable generated (or manually uploaded) images/video, so the same cover
-- isn't regenerated for every derivative, and so Instagram/YouTube (which
-- fetch media by public URL, not raw bytes) have something to point at.
CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    type TEXT NOT NULL,
    product_id TEXT,
    rubric_id TEXT,
    tags TEXT DEFAULT '[]',
    source TEXT DEFAULT 'manual',
    used_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Session tokens for whatever admin-login mechanism gets picked (password or
-- Telegram Login Widget both converge on "issue a session token") - the
-- mechanism-specific part is deferred, but the storage shape doesn't change.
CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER
);

-- One card per niche on the "Заказчики" tab - drives the 2GIS parser worker.
-- status: idle | queued | running | captcha | dedupe_running | done | error
CREATE TABLE IF NOT EXISTS parser_niches (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'idle',
    queries_json TEXT,
    log TEXT DEFAULT '',
    stats_json TEXT,
    raw_file TEXT,
    dedup_file TEXT,
    archive_file TEXT,
    job_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- One row per Shorts-assembly request handed to video-worker (Phase 2) - the
-- same "hub DB row tracks a remote worker's job_id" shape as parser_niches
-- above, just without the persistent-card lifecycle (this is a one-shot job,
-- not a reusable niche). asset_id is filled in once the job finishes and its
-- output has been saved as a media_assets row, and doubles as the "already
-- saved, don't insert a duplicate media_assets row on the next poll" guard.
CREATE TABLE IF NOT EXISTS video_assembly_jobs (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    video_url TEXT NOT NULL,
    audio_url TEXT NOT NULL,
    caption_text TEXT DEFAULT '',
    status TEXT DEFAULT 'queued',
    log TEXT DEFAULT '',
    error TEXT,
    asset_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

// Additive columns on existing tables - safe to run on every startup.
// ideas: distinguish agent-authored drafts from manual ones, and keep the
// raw agent draft alongside the human-edited text (needed later so the
// feedback loop learns from what actually got published, not the draft).
await ensureColumn('ideas', 'source', "TEXT DEFAULT 'manual'");
await ensureColumn('ideas', 'agent_meta', 'TEXT');
await ensureColumn('ideas', 'draft_text', 'TEXT');
// Content lifecycle: 'news' expires and gets auto-archived, 'evergreen' is a
// repurposing candidate once it has enough age + performance, 'case' /
// 'educational' don't expire but aren't repurposing candidates either.
await ensureColumn('ideas', 'content_type', "TEXT DEFAULT 'evergreen'");
await ensureColumn('ideas', 'expires_at', 'INTEGER');
// Which reusable rubric ("Кейс недели", "Разбор ошибки клиента" etc) this
// idea was generated from, if any - lets the Generator fill a proven
// structure instead of inventing post shape every time.
await ensureColumn('ideas', 'rubric_id', 'TEXT');
// Automated pre-publish checks (char limits, missing CTA, dedup) recorded as
// a JSON array of issue codes; empty array = passed the quality gate.
await ensureColumn('ideas', 'quality_flags', "TEXT DEFAULT '[]'");
await ensureColumn('ideas', 'cover_asset_id', 'TEXT');
// English translation of the same post, generated on demand from the
// (always-primary) Russian title/desc/cta - for the studio's English-speaking
// audience. Empty until "Перевести на английский" is clicked.
await ensureColumn('ideas', 'title_en', 'TEXT');
await ensureColumn('ideas', 'desc_en', 'TEXT');
await ensureColumn('ideas', 'cta_en', 'TEXT');

// scheduled_events: one row already represents one idea's post on one day;
// adding `platform` turns it into one row per idea per platform (an idea can
// now have several publications, one per target platform), plus the per-
// platform metrics a future sync job will fill in.
await ensureColumn('scheduled_events', 'platform', "TEXT DEFAULT 'telegram'");
await ensureColumn('scheduled_events', 'external_post_id', 'TEXT');
await ensureColumn('scheduled_events', 'metrics_views', 'INTEGER DEFAULT 0');
await ensureColumn('scheduled_events', 'metrics_saves', 'INTEGER DEFAULT 0');
await ensureColumn('scheduled_events', 'metrics_clicks', 'INTEGER DEFAULT 0');
await ensureColumn('scheduled_events', 'metrics_synced_at', 'INTEGER');
// Per-publication UTM code (e.g. "idea_123_telegram") so the landing
// page/lead-bot can report back which specific post a lead came from -
// this is what makes the ROI numbers real instead of manually guessed.
await ensureColumn('scheduled_events', 'utm_code', 'TEXT');
// Weekly day->product rotation and the required post structure ("Золотая
// середина"), set by the founder. Stored here (not just as Content Plan
// text) so the Generator can read it programmatically once built - the
// Content Plan display and the agent's actual behavior read the same data
// instead of drifting apart.
await ensureColumn('agent_settings', 'weekly_schedule', "TEXT DEFAULT '[]'");
await ensureColumn('agent_settings', 'post_formula', "TEXT DEFAULT ''");
// Editable prompt template the Generator agent uses to turn a Researcher
// brief into a drafted post - surfaced in the "Настройки агентов" tab so it
// can be tuned without touching code.
await ensureColumn('agent_settings', 'generator_prompt', "TEXT DEFAULT ''");
// Latest structured Researcher brief (see agent-researcher/run) - kept
// alongside agent_runs' free-text log so Generator (and the UI) can read the
// exact trends/products it picked without re-scanning RSS sources.
await ensureColumn('agent_runs', 'brief_json', 'TEXT');
// Secret Telegram sends back on every webhook call (set via setWebhook's
// secret_token param, see scripts/register-telegram-webhook.mjs) - verified
// on each incoming request in server/routes/telegramWebhook.js so the
// endpoint can't be driven by spoofed requests once it's public.
await ensureColumn('telegram_settings', 'webhook_secret', 'TEXT');
// Raw lead data uploaded directly as an .xlsx (POST /:id/upload), bypassing
// the 2GIS scraper entirely - stored as base64 bytes right on the row since
// there's no job_id/parser-worker backing an upload to fetch bytes from
// later, unlike scraper-produced files (see the download route in
// parserNiches.js, which fetches those live from the worker by job_id).
await ensureColumn('parser_niches', 'raw_upload_data', 'TEXT');
await ensureColumn('parser_niches', 'raw_upload_name', 'TEXT');

// project_info: moves what used to be hardcoded frontend productsData fields
// (target audience, value proposition) into the DB and adds new fields the
// frontend never had - all six of these feed getProductVectors() in
// server/routes/agentResearcher.js, so richer text here directly improves
// Researcher's trend-to-product matching, not just the product detail page UI.
await ensureColumn('project_info', 'target_audience', "TEXT DEFAULT ''");
await ensureColumn('project_info', 'value_proposition', "TEXT DEFAULT ''");
await ensureColumn('project_info', 'key_differentiators', "TEXT DEFAULT ''");
await ensureColumn('project_info', 'common_objections', "TEXT DEFAULT ''");
await ensureColumn('project_info', 'keywords', "TEXT DEFAULT ''");
// roadmap_json: JSON array of {id, title, description, status}, replacing the
// single hardcoded {step, desc} roadmap entry that used to live in
// productsData in public/js/app.js.
await ensureColumn('project_info', 'roadmap_json', "TEXT DEFAULT '[]'");

// Seed content_plan once with the studio's actual annual plan, shaped for the
// quarterly-timeline UI: 'note' blocks are global strategy cards, 'quarter'
// blocks render as a horizontal roadmap ordered by array position.
// INSERT OR IGNORE is a no-op once row id=1 exists, so this never overwrites
// later edits - see server/routes/contentPlan.js for the one-time migration
// that upgrades any pre-timeline (flat, kind-less) blocks still on disk.
const defaultContentPlanBlocks = [
    {
        id: 'goal', kind: 'note', title: 'Главная бизнес-цель', color: '#0a84ff',
        text: 'Получение квалифицированных лидов (SQL) на заказную веб-разработку и сложные IT-системы.',
    },
    {
        id: 'distribution', kind: 'note', title: 'Модель дистрибуции (Content Multiplier)', color: '#bf5af2',
        text: '1 идея → Shorts / Reels / ВК Клипы → Threads → Telegram-канал с закрепом → Сайт alba-creation.ru / Лид-бот',
    },
    {
        id: 'prompt', kind: 'note', title: 'Промпт-шаблон для Claude (еженедельный генератор сценариев)', color: '#ff375f',
        text: 'Действуй как Chief Marketing Officer IT-студии Alba Creation. Нам нужно создать сценарий для short-video (30-45 сек) и текстовый пост для Telegram/Threads.\n\n- Продукт недели: [Укажи продукт текущего квартала]\n- Тема: [Укажи тему дня из матрицы]\n- Целевая аудитория: Владельцы бизнеса и ЛПР, ценящие окупаемость, безопасность и скорость.\n- Тон: Экспертный, без воды, без погружения в хардкорный код, на языке бизнес-метрик и ROI.\n- Структура:\n  1. Хук (первые 3 секунды, цепляющий боль или цифру).\n  2. Проблема (почему традиционные методы не работают).\n  3. Решение (как Alba Creation или наш продукт закрывает эту задачу).\n  4. CTA (призыв перейти в Telegram-канал за бесплатным аудитом/демо).',
    },
    {
        id: 'q1', kind: 'quarter', title: 'ДУЭТ', period: 'Январь — Март', color: '#bf5af2',
        text: 'Смысловой вектор: Веб-инфраструктура, скорость запуска сайтов, замена устаревшим конструкторам.\n\nB2B-оффер: Бесплатный аудит скорости и конверсии текущего сайта клиента + демо ДУЭТ.',
    },
    {
        id: 'q2', kind: 'quarter', title: 'InSights', period: 'Апрель — Июнь', color: '#0a84ff',
        text: 'Смысловой вектор: Сквозная аналитика, оцифровка показателей, принятие решений на основе данных.\n\nB2B-оффер: Экспресс-разбор системы аналитики бизнеса и поиск слепых зон в воронке.',
    },
    {
        id: 'q3', kind: 'quarter', title: '«Хранитель»', period: 'Июль — Сентябрь', color: '#30d158',
        text: 'Смысловой вектор: Автономные ИИ-архивы в закрытом контуре (152-ФЗ), безопасность данных, мгновенный RAG-поиск.\n\nB2B-оффер: Расчёт экономии человеко-часов и стоимости развёртывания On-Premise / Cloud.',
    },
    {
        id: 'q4', kind: 'quarter', title: 'Crista & Фантазия', period: 'Октябрь — Декабрь', color: '#ff9f0a',
        text: 'Смысловой вектор: Геймдев-бэкстейдж, виральный визуал, сложная 3D-графика и интерактивные WebGL-интерфейсы.\n\nB2B-оффер: Разработка иммерсивных промо-сайтов и сложных нестандартных сервисов под ключ.',
    },
];
await db.execute({
    sql: 'INSERT OR IGNORE INTO content_plan (id, blocks) VALUES (1, ?)',
    args: [JSON.stringify(defaultContentPlanBlocks)],
});

// Seed "О проекте" starters. Alba Creation gets a real description pulled
// from alba-creation.ru; the other (fictional demo) products get a short
// starter derived from their existing productsData fields for the user to
// expand on later.
const defaultProjectInfo = {
    'alba-creation': 'Alba Creation — цифровая студия полного цикла: «IT-решения любого масштаба — от идеи до экосистемы». Бизнес приходит с задачей, студия превращает её в бота, сайт, приложение или целую экосистему — смотря что решает задачу быстрее. Формат работы — remote-first, клиенты в России и за рубежом.\n\nПЯТЬ НАПРАВЛЕНИЙ\n— Экосистемы — платформа, боты, кабинеты, автоматизация: один организм вместо разрозненных сервисов\n— Решения для бизнеса — инструменты под конкретную задачу компании, от подбора блогеров до оцифровки архива\n— Сайты — создание с нуля и превращение устаревших проектов в современные\n— Игры — от полноценного шутера до мини-игры в Telegram\n— Партнёры — рабочие решения, а не скриншоты на слайде\n\nУСЛУГИ\n— Telegram-боты и мини-приложения — продажи, поддержка, уведомления, внутренние процессы, админка и интеграции с CRM/оплатой\n— Сайты и лендинги — корпоративные сайты и продуктовые страницы с упором на скорость и SEO\n— Веб-приложения и дашборды — платформы, админ-панели, личные кабинеты с авторизацией, ролями и масштабируемой архитектурой\n— Автоматизация и интеграции — связка API, парсинг, отчётность, фоновые процессы с мониторингом\n— MVP и запуск продуктов — быстрый вывод ключевой ценности для фаундеров и новых направлений\n— Экосистемы и масштабирование — несколько связанных продуктов с единой архитектурой для зрелого бизнеса\n— Игры и интерактив — веб-игры, мини-игры в Telegram, брендированная геймификация с аналитикой и монетизацией\n\nПОРТФОЛИО (реальные продакшен-проекты, часть под NDA)\n— Веб-приложения: Дуэт (SaaS-конструктор свадебных сайтов-приглашений), Insight (поиск блогеров через граф связей), Хранитель (AI-система управления документами)\n— Экосистемы: Crista (геймифицированное приложение для планирования путешествий), Merfy (SaaS для онлайн-магазинов)\n— Dev-инструменты: legit Agent (проверка кода на соответствие российским законам)\n— Сайты: VYSOTA FITNESS (премиальный фитнес-клуб), КАЛИБР (школа стрелковой подготовки с 3D-сценой), EfrNet (интернет-провайдер с интерактивными инструментами), Murla (лендинг фулфилмент-компании), BrickFrame (витрина LED-дисплеев для LEGO), BIG DAY (лендинг денежных картин с конфигуратором)\n— Telegram-боты: Blisski Loyalty (бот и Mini App для кальянной), КИС КИС Bot (учёт финансов и калькулятор), Murla Client Bot (управление заказами фулфилмента)\n— Игры: Pyrokinesis (narrative FPS/Action-RPG на Godot)\n\nПРОЦЕСС РАБОТЫ\n1. Заявка — контакт через Telegram или email, без форм\n2. Бриф и созвон — цели, аудитория, бюджет, приоритеты\n3. Оценка — предложение с объёмом работ, этапами и стоимостью\n4. Договор — условия, доступы, способ коммуникации\n5. Разработка — итерации с демо и обратной связью\n6. Сдача — передача результата, документация, обучение\n7. Поддержка — опциональное сопровождение и доработки\n\nПочему с нами: прямой контакт с разработчиками без посредников, работающие версии вместо отчётов, быстрое выполнение без затягивания, прозрачность объёма работ и правок, полная передача проекта с документацией, поддержка после запуска.\n\nКонтакты: @albacreation в Telegram, +7 (915) 495-42-93, sklemin0408@gmail.com.',
    'insights': 'InSights — SaaS-платформа для анализа социальных сетей с использованием ИИ. Помогает маркетологам и B2B-клиентам находить релевантных блогеров и оценивать их аудиторию через AI-скоринг, экономя часы ручного подбора инфлюенсеров.',
    'hranitel': 'Хранитель — RAG-система для работы с корпоративными архивами в закрытом контуре, без выхода в интернет. Позволяет находить нужный документ по смыслу за секунды вместо ручного перебора сканов, что особенно критично для Enterprise и госсектора.',
    'duet': 'ДУЭТ — система автоматизации расписаний для образовательных учреждений. Убирает рутину и конфликты в сетке занятий, которые обычно ложатся на завучей и администрацию школ.',
    'crista': 'Crista — CRM для сегмента HoReCa (рестораны, отели), решающая проблему пропущенных бронирований и разрозненной коммуникации с гостями.',
    'fantaziya': 'Фантазия — сервис умных витрин с AI-рекомендациями для интернet-магазинов, подбирающий товары под интерес конкретного покупателя в реальном времени.',
    'legitagent': 'legitAgent — набор open-source npm-пакетов и CLI-инструментов для фронтенд-разработчиков, служащий точкой входа для знакомства разработчиков со студией.',
};
for (const [productId, about] of Object.entries(defaultProjectInfo)) {
    await db.execute({
        sql: 'INSERT OR IGNORE INTO project_info (product_id, about) VALUES (?, ?)',
        args: [productId, about],
    });
}

// Seed target_audience/value_proposition/roadmap_json once from the values
// that used to be hardcoded in productsData (public/js/app.js `target`,
// `value`, `roadmap`) - now that those fields live in the DB and feed the
// Researcher embedding, the frontend's hardcoded copies are the seed source,
// not the ongoing source of truth. key_differentiators/common_objections/
// keywords are new fields with no prior frontend equivalent, so they seed
// empty for the founder to fill in. Guarded per-row on target_audience still
// being at its column default, same "own guard" pattern as generator_prompt
// above - never overwrites a row the founder already edited.
const productSeedFields = {
    'insights': { target: 'B2B, Маркетологи', value: 'Поиск блогеров и AI-скоринг', roadmapStep: 'MVP', roadmapDesc: 'Релиз базового поиска' },
    'hranitel': { target: 'Enterprise, Госсектор', value: 'Поиск по сканам в закрытом контуре', roadmapStep: 'Пилот', roadmapDesc: 'Внедрение в первую корпорацию' },
    'duet': { target: 'Школы, B2G', value: 'Автоматизация расписаний', roadmapStep: 'Серт.', roadmapDesc: 'Получение лицензий' },
    'crista': { target: 'Рестораны, Отели', value: 'Автоматизация бронирований', roadmapStep: 'Бета', roadmapDesc: 'Тест на 3 ресторанах' },
    'fantaziya': { target: 'Ритейл', value: 'Умные витрины', roadmapStep: 'Релиз', roadmapDesc: 'Запуск интеграции с CMS' },
    'legitagent': { target: 'Разработчики', value: 'NPM пакеты и CLI инструменты', roadmapStep: 'v1.0', roadmapDesc: 'Стабильный релиз ядра' },
    'alba-creation': { target: 'Все клиенты', value: 'Full-stack разработка', roadmapStep: 'Масштаб', roadmapDesc: 'Выход на международный рынок' },
};
for (const [productId, f] of Object.entries(productSeedFields)) {
    const roadmapSeed = JSON.stringify([
        { id: `${productId}-seed-1`, title: f.roadmapStep, description: f.roadmapDesc, status: 'planned' },
    ]);
    await db.execute({
        sql: `
            INSERT INTO project_info (product_id, target_audience, value_proposition, roadmap_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(product_id) DO UPDATE SET
                target_audience = CASE WHEN project_info.target_audience = '' THEN excluded.target_audience ELSE project_info.target_audience END,
                value_proposition = CASE WHEN project_info.value_proposition = '' THEN excluded.value_proposition ELSE project_info.value_proposition END,
                roadmap_json = CASE WHEN project_info.roadmap_json = '[]' THEN excluded.roadmap_json ELSE project_info.roadmap_json END
        `,
        args: [productId, f.target, f.value, roadmapSeed],
    });
}

// Seed the first niche script as requested: cold-call script for building
// websites for hookah lounges. INSERT OR IGNORE on a fixed id keeps this
// idempotent across restarts without clobbering later edits.
const defaultNicheSections = [
    {
        id: 'opener', heading: 'Приветствие',
        text: 'Добрый день! Меня зовут [Ваше имя], я представляю веб-студию Alba Creation. Звоню в [название заведения] — подскажите, как к вам лучше обращаться? Есть пара минут? Хочу рассказать про идею, которая может привести вам новых гостей уже в эти выходные.',
    },
    {
        id: 'qualify', heading: 'Квалификация',
        text: '1. У вас сейчас есть отдельный сайт, или гости узнают о вас только через Instagram и 2ГИС/Яндекс.Карты?\n2. Как гости обычно бронируют столик — звонят, пишут в директ, или просто приходят?\n3. Бывает, что вечером в пятницу-субботу все столы заняты, и гости, которые не дозвонились, уезжают к конкурентам?\n4. Часто обновляете меню миксов? Успеваете доносить это до гостей?',
    },
    {
        id: 'pain', heading: 'Боль',
        text: 'Смотрите, в чём проблема: когда человек ищет кальянную в своём районе, он в 90% случаев сначала гуглит или смотрит Яндекс.Карты. Если там нет сайта — только страница в Instagram с разрозненными сторис — он не видит актуальное меню, цены, атмосферу и просто уходит к тому заведению, у которого сайт есть. Вы теряете гостя, даже не узнав о нём.',
    },
    {
        id: 'pitch', heading: 'Оффер / Питч',
        text: 'Мы в Alba Creation делаем сайты именно под кальянные:\n— Онлайн-меню миксов с фото и ценами, которое вы сами обновляете за 2 минуты\n— Онлайн-бронирование стола прямо с сайта или через Telegram-бота — без пропущенных звонков\n— Галерея интерьера и атмосферы, чтобы гость «прогрелся» ещё до визита\n— Интеграция с Яндекс.Картами, 2ГИС и отзывами\n— Адаптация под телефон — большинство гостей ищут вас с мобильного вечером\n\nОбычно сайт под ключ занимает 7–10 дней, всю техническую часть берём на себя.',
    },
    {
        id: 'objections', heading: 'Обработка возражений',
        text: '«У нас есть Instagram, зачем ещё сайт?» — Инста отлично работает на охват и картинку, но не даёт гостю за 10 секунд посмотреть меню и сразу забронировать стол — сайт закрывает именно эту задачу и работает как витрина 24/7, даже когда вы не постите сторис.\n\n«Это дорого» — Понимаю, давайте посчитаем: во сколько вам обходится один гость с рекламы? Сайт — разовая инвестиция, которая удерживает тех, кто УЖЕ вас искал, но не смог найти информацию или забронировать — это самая дешёвая аудитория, которую вы сейчас просто теряете.\n\n«Нет времени этим заниматься» — Мы понимаем, что у вас заведение, а не диджитал-агентство, поэтому всё делаем сами: от вас нужны только фото и меню, весь процесс занимает у вас максимум час суммарно.\n\n«Надо подумать» — Конечно. Давайте вышлю 2-3 примера готовых сайтов для кальянных, вы посмотрите в удобное время — и созвонимся, например, в четверг на 10 минут, чтобы обсудить детали?',
    },
    {
        id: 'close', heading: 'Закрытие',
        text: 'Отлично, тогда сейчас вышлю примеры работ в Telegram/WhatsApp — на какой номер удобнее? И давайте сразу зафиксируем короткий созвон на [день], чтобы я показал, как именно это будет выглядеть для вашего заведения.',
    },
];
await db.execute({
    sql: 'INSERT OR IGNORE INTO niches (id, name, subtitle, sections) VALUES (?, ?, ?, ?)',
    args: ['kalyannye', 'Кальянные', 'Создание сайтов для кальянных лаунджей', JSON.stringify(defaultNicheSections)],
});

// Seed the weekly day->product schedule and post formula once (only while
// still at the column default, so later edits via the UI are never
// overwritten on restart).
const defaultWeeklySchedule = [
    { day: 'mon', label: 'Понедельник', product: 'hranitel', focus: 'Хранитель (Enterprise, документооборот, OCR)' },
    { day: 'tue', label: 'Вторник', product: 'duet', focus: 'ДУЭТ (Event SaaS, генерация сайтов и приглашений)' },
    { day: 'wed', label: 'Среда', product: 'alba-creation', focus: 'Alba Creation (кастомная разработка под ключ, нагрузочные тесты)' },
    { day: 'thu', label: 'Четверг', product: 'insights', focus: 'InSights (AI-аналитика, скоринг блогеров, парсинг)' },
    { day: 'fri', label: 'Пятница', product: null, focus: 'Ретро-кейсы из портфолио студии (Murla, Merfy, Архивариус и др.)' },
    { day: 'sat', label: 'Суббота', product: null, focus: 'Gamedev и Open-Source (Crista, Фантазия, legitAgent)' },
    { day: 'sun', label: 'Воскресенье', product: null, focus: 'Мемы, дедлайны, забавные правки клиентов, вайб фаундера' },
];
const defaultPostFormula = 'Золотая середина — обязательная структура для экспертных постов Пн–Сб:\n1. Бизнес-проблема: какую боль, потерю времени или денег мы решаем.\n2. Техническое решение: как именно мы это закодили (наш стек), простыми бытовыми аналогиями.\n3. Бизнес-результат: измеримая метрика (ускорили в X раз, сэкономили Y бюджета, выдержали Z запросов).';
const defaultGeneratorPrompt = `Ты — копирайтер студии Alba Creation. Пишешь пост для соцсетей на основе темы, которую нашёл агент-исследователь.

Продукт дня: {{product}}
Тема: {{topic}}
Источник: {{snippet}}
Тон голоса: {{tone_of_voice}}
Формат: {{format}}

Обязательно следуй структуре "Золотая середина":
{{post_formula}}

Ответь СТРОГО валидным JSON без пояснений:
{"title": "...", "businessProblem": "...", "technicalSolution": "...", "businessResult": "...", "cta": "..."}`;
await db.execute({
    sql: `UPDATE agent_settings SET weekly_schedule = ?, post_formula = ?
          WHERE id = 1 AND weekly_schedule = '[]'`,
    args: [JSON.stringify(defaultWeeklySchedule), defaultPostFormula],
});
// Separate guard (its own column, not weekly_schedule) - the UPDATE above
// already stopped firing once weekly_schedule was first populated, so
// generator_prompt needs its own once-only seed instead of riding along.
await db.execute({
    sql: `UPDATE agent_settings SET generator_prompt = ? WHERE id = 1 AND generator_prompt = ''`,
    args: [defaultGeneratorPrompt],
});

// Seed a few starter content_rubrics so the feature isn't empty on first
// load. Fixed ids + INSERT OR IGNORE keep this idempotent across restarts,
// same pattern as the niches/project_info seeds above. Each structure
// mirrors the "Золотая середина" shape validateDraft() checks for
// (businessProblem/technicalSolution/businessResult), just phrased per rubric.
const defaultContentRubrics = [
    {
        id: 'rubric-case-of-week', name: 'Кейс недели', target_funnel: 'BOFU',
        description: 'Разбор реального кейса клиента с измеримым результатом - закрывает воронку конкретным доказательством, а не обещаниями.',
        structure_template: ['Проблема клиента', 'Что сделали', 'Результат с цифрами'],
    },
    {
        id: 'rubric-client-mistake', name: 'Разбор ошибки клиента', target_funnel: 'MOFU',
        description: 'Частая ошибка бизнеса до работы с нами и как её избежать - строит экспертность и доверие на конкретном примере.',
        structure_template: ['Типичная ошибка', 'Почему это не работает', 'Как сделать правильно'],
    },
    {
        id: 'rubric-tech-lifehack', name: 'Технический лайфхак', target_funnel: 'TOFU',
        description: 'Короткий практичный приём из нашей разработки, переведённый на язык бизнес-выгоды - на охват и вовлечение.',
        structure_template: ['Задача', 'Техническое решение', 'Что это даёт бизнесу'],
    },
];
for (const r of defaultContentRubrics) {
    await db.execute({
        sql: `INSERT OR IGNORE INTO content_rubrics (id, name, description, structure_template, target_funnel)
              VALUES (?, ?, ?, ?, ?)`,
        args: [r.id, r.name, r.description, JSON.stringify(r.structure_template), r.target_funnel],
    });
}
