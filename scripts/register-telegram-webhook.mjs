// One-off script: registers this deployment's public webhook URL with
// Telegram (so replies to approval messages reach
// server/routes/telegramWebhook.js) and generates + stores the secret token
// that route verifies on every incoming request.
//
// Run this ONCE per deployment (and again any time the public URL changes,
// or to rotate the secret) - it is deliberately NOT run automatically on
// every server boot, since re-registering on every restart would be
// pointless churn against Telegram's API and isn't needed for the webhook
// to keep working.
//
// Usage (from the project root, against the real deployed DB):
//   node --env-file-if-exists=.env scripts/register-telegram-webhook.mjs https://your-domain.com/api/telegram/webhook
//
// Requirements:
//   - telegram_settings.token must already be set (Settings tab in the app,
//     or directly in the DB) - this script reads it, it never hardcodes or
//     prompts for a token.
//   - TURSO_DATABASE_URL / TURSO_AUTH_TOKEN must point at the real database
//     (via .env) - otherwise this only touches the local dev file DB, which
//     is harmless but pointless to register a public webhook against.
//   - The URL must be publicly reachable over HTTPS (Telegram requires this
//     for webhooks) - a Coolify-deployed VPS domain, not localhost.
//
// What it does:
//   1. Reads the bot token from telegram_settings.
//   2. Generates a random secret and saves it to telegram_settings.webhook_secret.
//   3. Calls Telegram's setWebhook with that URL and secret_token, so Telegram
//      includes it as the X-Telegram-Bot-Api-Secret-Token header on every
//      call - telegramWebhook.js rejects anything that doesn't match.

import crypto from 'node:crypto';
import { db } from '../server/db.js';

const url = process.argv[2];
if (!url) {
    console.error('Usage: node scripts/register-telegram-webhook.mjs <public-webhook-url>');
    console.error('Example: node --env-file-if-exists=.env scripts/register-telegram-webhook.mjs https://hub.example.com/api/telegram/webhook');
    process.exit(1);
}
if (!/^https:\/\//i.test(url)) {
    console.error('Telegram requires an https:// webhook URL.');
    process.exit(1);
}

const settingsRes = await db.execute('SELECT token FROM telegram_settings WHERE id = 1');
const token = settingsRes.rows[0]?.token;
if (!token) {
    console.error('telegram_settings.token is empty - set the bot token in the app (Settings) first, then re-run this script.');
    process.exit(1);
}

const secret = crypto.randomBytes(32).toString('hex');
await db.execute({ sql: 'UPDATE telegram_settings SET webhook_secret = ? WHERE id = 1', args: [secret] });

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
});
const data = await res.json();

if (!data.ok) {
    console.error('setWebhook failed:', data.description);
    process.exit(1);
}

console.log('Webhook registered:', url);
console.log('Secret token generated and stored in telegram_settings.webhook_secret.');
console.log('(telegramWebhook.js verifies every incoming request against this value - nothing further to configure.)');
