import { createClient } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeClient() {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) {
        // Production (Vercel) and any dev session pointed at a real Turso db.
        return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
    }
    // Local dev fallback: a file-based libSQL db, no Turso account needed.
    // Vercel's filesystem is read-only/ephemeral per invocation, so this branch
    // must never be reached in production - set TURSO_DATABASE_URL there.
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return createClient({ url: `file:${path.join(dataDir, 'alba-content-hub.db')}` });
}

export const db = makeClient();

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

CREATE TABLE IF NOT EXISTS telegram_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT DEFAULT '',
    chat_id TEXT DEFAULT ''
);
INSERT OR IGNORE INTO telegram_settings (id, token, chat_id) VALUES (1, '', '');
`);
