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

// One-time table rebuild for the RU/EN dual-account settings tables
// (vk_settings, instagram_settings, youtube_settings, threads_settings -
// Telegram and Pinterest are deliberately excluded, see the callers below).
// These tables were originally a single-row singleton (id INTEGER PRIMARY
// KEY CHECK (id = 1)) - that CHECK constraint makes it impossible to just
// ALTER TABLE + INSERT a second row for the 'en' account, so this rebuilds
// the table onto a `lang` primary key instead, carrying the existing row
// over as 'ru' (real production tokens must survive this) and adding an
// empty 'en' row. Idempotent - skips entirely once `lang` already exists,
// safe to call on every boot like ensureColumn above.
async function migrateSettingsTableToLangKey(table, columns) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    if (info.rows.some(r => r.name === 'lang')) return; // already migrated
    const colNames = columns.map(c => c.split(' ')[0]);
    // Seed the id=1 row here (not in the raw CREATE TABLE block) so this
    // still works as a no-op INSERT OR IGNORE on a fresh table, without
    // ever running against the post-migration `lang`-keyed shape (which has
    // no `id` column and would error on every later boot otherwise).
    await db.execute(`INSERT OR IGNORE INTO ${table} (id, ${colNames.join(', ')}) VALUES (1, ${colNames.map(() => `''`).join(', ')})`);
    const tmpTable = `${table}_lang_migration`;
    await db.execute(`DROP TABLE IF EXISTS ${tmpTable}`);
    await db.execute(`CREATE TABLE ${tmpTable} (lang TEXT PRIMARY KEY CHECK (lang IN ('ru','en')), ${columns.join(', ')})`);
    await db.execute(
        `INSERT OR IGNORE INTO ${tmpTable} (lang, ${colNames.join(', ')}) SELECT 'ru', ${colNames.join(', ')} FROM ${table} WHERE id = 1`
    );
    await db.execute(`INSERT OR IGNORE INTO ${tmpTable} (lang) VALUES ('en')`);
    await db.execute(`DROP TABLE ${table}`);
    await db.execute(`ALTER TABLE ${tmpTable} RENAME TO ${table}`);
}

// One-time reversal of the above: vk_settings briefly went through the
// lang-key migration during initial development of the RU/EN account
// feature, then the design changed to a single token + vk_groups list (see
// the comment on the vk_settings CREATE TABLE below) before that code ever
// shipped - but on any environment where the lang-keyed table was already
// created (this dev DB, and possibly production), the CREATE TABLE IF NOT
// EXISTS below is a no-op and boot fails. This rebuilds vk_settings back
// onto its original `id INTEGER PRIMARY KEY CHECK (id = 1)` shape, carrying
// the 'ru' row's token/group_id over (the only row that could ever have
// held a real value). Idempotent - skips once `id` already exists.
async function migrateVkSettingsBackToIdKey() {
    const info = await db.execute(`PRAGMA table_info(vk_settings)`);
    if (info.rows.length === 0 || info.rows.some(r => r.name === 'id')) return; // not created yet, or already correct shape
    await db.execute(`DROP TABLE IF EXISTS vk_settings_id_migration`);
    await db.execute(`CREATE TABLE vk_settings_id_migration (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT DEFAULT '', group_id TEXT DEFAULT '')`);
    await db.execute(
        `INSERT OR IGNORE INTO vk_settings_id_migration (id, access_token, group_id) SELECT 1, access_token, group_id FROM vk_settings WHERE lang = 'ru'`
    );
    await db.execute(`INSERT OR IGNORE INTO vk_settings_id_migration (id, access_token, group_id) VALUES (1, '', '')`);
    await db.execute(`DROP TABLE vk_settings`);
    await db.execute(`ALTER TABLE vk_settings_id_migration RENAME TO vk_settings`);
}
await migrateVkSettingsBackToIdKey();

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

-- One hub setup can post to several VK communities (unlike Instagram/
-- YouTube/Threads, which each need a wholly separate ACCOUNT for RU vs EN) -
-- conceptually mirrors telegram_channels (a picked list of publish targets,
-- not a second account), but VK's own API means each community's access
-- token can only post to that community's own wall - unlike a Telegram bot
-- token, one VK token can't act on behalf of several different communities
-- at once. So the token lives PER ROW here, not once in vk_settings
-- (vk_settings.access_token is kept only as an optional fallback for a user
-- token with groups+wall scope across communities it admins - rare, most
-- users will fill access_token on every row). The 'lang' column is optional
-- (NULL = works for either) and only used to pre-select a sensible default
-- in the publish modal - the picker is still manual, same as Telegram's.
CREATE TABLE IF NOT EXISTS vk_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    group_id TEXT NOT NULL,
    access_token TEXT DEFAULT '',
    lang TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Manually-curated Telegram channels to watch for trend inspiration (NOT the
-- channels above, which are publish TARGETS under our own bot). Reading an
-- arbitrary channel's posts needs a real user (MTProto) session, which only
-- exists on the user's own Mac (local-telegram-agent, see that folder's
-- README) - the Mac has to be running to actually scan, so this list is
-- deliberately separate from agent_settings.sources: it must never be wiped
-- or touched by the RSS save/discover flow, and posts are fetched live on
-- demand (see POST /api/telegram-watch/scan) rather than cached here.
CREATE TABLE IF NOT EXISTS telegram_watch_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Same idea for Instagram - a manually-curated list of accounts to browse
-- for inspiration (competitor discovery has no real API, see
-- server/lib/socialPublishers/instagram.js's comments) - fetched live via
-- Business Discovery on demand, never auto-populated or wiped by RSS actions.
CREATE TABLE IF NOT EXISTS instagram_watch_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- VK communities and YouTube channels Researcher scans for trend candidates
-- alongside RSS (see server/routes/agentResearcher.js) - unlike the two
-- tables above these ARE real public APIs, so they feed the same automatic
-- daily pipeline as RSS sources, just kept in their own fields in the UI
-- (Центр агентов) rather than mixed into the RSS textarea.
CREATE TABLE IF NOT EXISTS vk_trend_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS youtube_trend_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Instagram: a long-lived Page access token (Meta Graph API) plus the
-- connected Instagram Business/Creator account id it publishes to. See
-- server/lib/socialPublishers/instagram.js.
CREATE TABLE IF NOT EXISTS instagram_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    business_account_id TEXT DEFAULT ''
);

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

-- Threads: a Threads user access token (threads_basic + threads_content_publish
-- scopes, from a Meta app with the "Threads use case" - a separate app type
-- from Instagram's Graph API) plus the Threads user id it publishes to. See
-- server/lib/socialPublishers/threads.js.
CREATE TABLE IF NOT EXISTS threads_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    user_id TEXT DEFAULT ''
);

-- Pinterest: a user access token (pins:read, pins:write, boards:read,
-- boards:write scopes) plus an optional default board id - unlike the other
-- platforms every Pin must belong to a board, so the publish flow lets a
-- board be picked per-post (falling back to this default) rather than baking
-- one board in at settings time. See server/lib/socialPublishers/pinterest.js.
CREATE TABLE IF NOT EXISTS pinterest_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT DEFAULT '',
    default_board_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO pinterest_settings (id, access_token, default_board_id) VALUES (1, '', '');

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

-- Cache for arbitrary-city 2GIS resolution (slug + bounding box), keyed by
-- the lowercased city name the user typed on a parser niche card - see
-- server/lib/resolveParserCity.js. Resolving a new city calls
-- local-claude-agent (WebSearch), so this exists to make that a one-time
-- cost per city rather than per run.
CREATE TABLE IF NOT EXISTS parser_city_cache (
    city_name TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    label TEXT NOT NULL,
    lat_min REAL NOT NULL,
    lat_max REAL NOT NULL,
    lon_min REAL NOT NULL,
    lon_max REAL NOT NULL,
    resolved_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Durable, versioned copies of parser_niches' files (raw/dedup/archive),
-- pushed to S3-compatible object storage right before parser_niches' own
-- raw_file/dedup_file/archive_file/raw_upload_data columns would be
-- overwritten or cleared - see server/routes/parserNiches.js. Those columns
-- (and parser-worker's own job_id-keyed temp files) are NOT durable: a
-- re-run of "▶ Обновить парсер" wipes them, and once job_id changes or
-- parser-worker cleans up old job dirs, worker-produced files become
-- unreachable even though the DB still shows the file badge as available.
-- This table is the only durable copy. Writing to it is best-effort and
-- entirely skipped when isObjectStorageConfigured() is false (see
-- server/lib/objectStorage.js) - same graceful-degradation pattern as
-- media_assets covers/voiceovers, so an unconfigured S3 never blocks the
-- underlying user-facing flow (upload, status poll, re-run all still work).
CREATE TABLE IF NOT EXISTS parser_niche_file_versions (
    id TEXT PRIMARY KEY,
    niche_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    original_filename TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_parser_niche_file_versions_niche_id ON parser_niche_file_versions(niche_id);

-- Вторая база заказчиков: ниши для ScrapeGraphAI-воркера (см.
-- scrape-worker/ и server/routes/scrapeNiches.js). Форма повторяет
-- parser_niches, но с двумя отличиями: город здесь - просто строка для
-- поискового запроса (никакого 2ГИС-slug и bounding box не нужно), а
-- результаты лежат прямо в results_json, а не только в XLSX. Второе -
-- ради сводной базы: чтобы слить обе базы, строки нужны как данные, а
-- парсить обратно свой же выгруженный файл было бы нелепо.
CREATE TABLE IF NOT EXISTS scrape_niches (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    city TEXT DEFAULT '',
    status TEXT DEFAULT 'idle',
    log TEXT DEFAULT '',
    stats_json TEXT,
    sites_json TEXT,
    results_json TEXT,
    job_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- CRM. Отдельные таблицы, а не расширение parser_niches/scrape_niches:
-- те две - про СБОР (сырые выгрузки по нишам, перезаписываются при каждом
-- перезапуске парсера), а здесь живёт РАБОТА с клиентом, которую перезапуск
-- сбора не имеет права затирать. Импорт из сводной базы идёт в одну сторону
-- и дедуплицируется по домену/телефону - см. server/routes/crm.js.
CREATE TABLE IF NOT EXISTS crm_companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    niche TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    vk TEXT DEFAULT '',
    instagram TEXT DEFAULT '',
    description TEXT DEFAULT '',
    source TEXT DEFAULT 'manual',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_companies_domain ON crm_companies(domain);
CREATE INDEX IF NOT EXISTS idx_crm_companies_niche ON crm_companies(niche);

CREATE TABLE IF NOT EXISTS crm_contacts (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    name TEXT NOT NULL,
    role TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    telegram TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON crm_contacts(company_id);

-- stage - строка без CHECK-constraint, как ideas.status: набор стадий задан
-- в CRM_STAGES (server/routes/crm.js) и может поменяться без миграции.
CREATE TABLE IF NOT EXISTS crm_deals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company_id TEXT,
    contact_id TEXT,
    product_id TEXT,
    stage TEXT DEFAULT 'new',
    amount INTEGER DEFAULT 0,
    close_date INTEGER,
    lost_reason TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_company ON crm_deals(company_id);

-- Одна таблица на заметки, задачи, звонки и автоматические записи о смене
-- стадии: у Twenty это разные объекты, но здесь они различаются только полем
-- kind и все нужны в одном месте - в общей ленте карточки. Разводить их по
-- трём таблицам значило бы склеивать ленту тремя запросами и UNION'ом ради
-- нулевой выгоды.
CREATE TABLE IF NOT EXISTS crm_activities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'note',
    body TEXT DEFAULT '',
    company_id TEXT,
    contact_id TEXT,
    deal_id TEXT,
    due_at INTEGER,
    done INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_company ON crm_activities(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities(deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON crm_activities(due_at);

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

// RU/EN dual-account migration for Instagram/YouTube/Threads - see
// migrateSettingsTableToLangKey's comment above. Telegram (already has its
// own multi-channel setup) and Pinterest (single account, no RU/EN split
// requested) are deliberately not migrated. VK is ALSO not migrated this
// way - one VK token can post to several communities, so it gets its own
// vk_groups list (mirroring telegram_channels) instead of a second account -
// see the CREATE TABLE below and server/routes/settings.js's /vk-groups.
await migrateSettingsTableToLangKey('instagram_settings', [`access_token TEXT DEFAULT ''`, `business_account_id TEXT DEFAULT ''`]);
await migrateSettingsTableToLangKey('youtube_settings', [`client_id TEXT DEFAULT ''`, `client_secret TEXT DEFAULT ''`, `refresh_token TEXT DEFAULT ''`, `channel_title TEXT DEFAULT ''`]);
await migrateSettingsTableToLangKey('threads_settings', [`access_token TEXT DEFAULT ''`, `user_id TEXT DEFAULT ''`]);

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
// Same idea as cover_asset_id above, filled in by POST /api/ideas/:id/auto-generate
// (server/routes/ideas.js) alongside it - one column per media type the
// auto-generate chain can produce for an idea.
await ensureColumn('ideas', 'voiceover_asset_id', 'TEXT');
await ensureColumn('ideas', 'video_asset_id', 'TEXT');
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
// Auto-publish (see server/lib/calendarScheduler.js): publish_at is a unix
// timestamp (date+time chosen in the schedule modal) distinct from raw_date
// (a plain YYYY-MM-DD used for calendar display/grouping only). channel_id/
// board_id/lang mirror what the manual "Опубликовать" modal already lets you
// pick (publishModalState in app.js), just captured up front instead of on
// the day itself. publish_status starts 'pending' and moves to 'published'
// or 'failed' (with publish_error set) once the scheduler's had a shot at
// it - a failed row is never retried automatically, only via the "Повторить"
// button in the calendar UI, which just resets it back to 'pending'.
await ensureColumn('scheduled_events', 'publish_at', 'INTEGER');
await ensureColumn('scheduled_events', 'channel_id', 'INTEGER');
await ensureColumn('scheduled_events', 'board_id', 'TEXT');
await ensureColumn('scheduled_events', 'vk_group_id', 'INTEGER');
await ensureColumn('vk_groups', 'access_token', "TEXT DEFAULT ''");
await ensureColumn('scheduled_events', 'lang', "TEXT DEFAULT 'ru'");
await ensureColumn('scheduled_events', 'publish_status', "TEXT DEFAULT 'pending'");
await ensureColumn('scheduled_events', 'publish_error', 'TEXT');
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
// Read-only YouTube Data API v3 key (NOT the OAuth client used for
// publishing - see server/lib/socialPublishers/youtube.js) - search.list on
// a channel's uploads is public data and only needs a simple API key, no
// per-account consent flow. Used by Researcher to scan youtube_trend_sources
// alongside RSS/VK, see server/routes/agentResearcher.js.
await ensureColumn('agent_settings', 'youtube_api_key', "TEXT DEFAULT ''");
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
// Franchise-domain dedupe result for an uploaded raw file (POST
// /:id/upload/dedupe) - separate from dedup_file, which only ever points at
// a scraper job's worker-produced dedup.xlsx. Uploaded rows have no job_id,
// so the deduped bytes are stored directly, same reasoning as
// raw_upload_data above.
await ensureColumn('parser_niches', 'dedup_upload_data', 'TEXT');
// Free-text city name to scrape (any city, not a fixed list) - resolved to
// a real 2GIS slug + bounding box at run time via resolveParserCity.js,
// which caches the result in parser_city_cache. Empty/'Москва' short-
// circuits to the worker's built-in Moscow default without calling anything.
await ensureColumn('parser_niches', 'city', "TEXT DEFAULT 'Москва'");
// The cold-outreach pitch text sent over Telegram to a lead once they're
// considering the offer (see server/routes/parserNiches.js's
// /generate-pitch) - separate from `description`, which is 2ГИС search
// keywords, not prose.
// Moved to `niches` (Скрипты) below - the cold-call pitch belongs with the
// call script for a niche, not the 2ГИС scraper card. Column left here
// unused rather than dropped (libSQL DROP COLUMN support is inconsistent).
await ensureColumn('niches', 'cold_call_pitch', "TEXT DEFAULT ''");
// The script text a voiceover was generated from - generate-voiceover only
// ever used it to call ElevenLabs/Piper and threw it away afterwards, so a
// voiceover's media_assets row had no readable content at all (the card
// could only show `url`, which for an unconfigured-S3 fallback is itself a
// giant data:audio/...;base64,... string, not something meant to be read).
await ensureColumn('media_assets', 'transcript', 'TEXT');
// Groups cover/video variants generated while drafting a post in "Создание
// контента" by the draft's topic, so rejected variants aren't lost in one
// flat list - see server/routes/mediaAssets.js's generate-cover/generate-video.
// NULL for anything generated elsewhere (Медиатека's own generate buttons,
// uploads) - those stay outside any folder, same as before this existed.
await ensureColumn('media_assets', 'folder', 'TEXT');
// Voiceovers generated after a post is approved (see ideas.js's
// generate-voiceover-for-idea) are real media_assets rows - the idea's
// voiceoverAssetId still needs somewhere to point - but shouldn't clutter
// the general Медиатека grid; this flags them to be filtered out by default.
await ensureColumn('media_assets', 'hidden', 'INTEGER DEFAULT 0');

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

Перед началом загляни в GET /api/content-plan/context (хаб на этом же хосте) — это актуальная сводка: главная бизнес-цель, модель дистрибуции, фокус текущего квартала и фокус сегодняшнего дня. Учитывай её при выборе акцентов и тона поста.

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
