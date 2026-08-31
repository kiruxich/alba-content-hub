// Telegram's Bot API (api.telegram.org) is unreachable directly from this
// app's VPS - confirmed via SSH: consistent 10s timeouts to api.telegram.org
// while other hosts (google.com, github.com) resolve instantly, so it's a
// targeted block of that specific host, not general VPS connectivity.
// TELEGRAM_API_BASE_URL routes every Telegram call in this app through a
// Cloudflare Worker proxy instead (cloudflare-worker-telegram-proxy/) when
// set; falls back to the real api.telegram.org otherwise, so this stays a
// no-op for any deployment that isn't affected by the block.
export function telegramApiBase() {
    return (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');
}
