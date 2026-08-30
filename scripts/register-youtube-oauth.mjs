// One-off, interactive script: performs Google's OAuth2 flow for a "Desktop
// app" client to obtain a YouTube refresh token, and saves it (plus the
// client id/secret) into youtube_settings, so server/lib/socialPublishers/
// youtube.js can mint access tokens on every publish without any further
// manual steps.
//
// Run this ONCE per Google Cloud project (and again only if the refresh
// token is later revoked) - it is a manual, interactive setup step, not
// something the server runs on its own.
//
// Usage (from the project root, against the real deployed DB):
//   node --env-file-if-exists=.env scripts/register-youtube-oauth.mjs <client_id> <client_secret>
//
// Prerequisites (you create these yourself in Google Cloud Console - this
// script only consumes them, it does not create a Cloud project):
//   1. Create/select a project at https://console.cloud.google.com/
//   2. Enable "YouTube Data API v3" (APIs & Services -> Library).
//   3. Configure the OAuth consent screen (APIs & Services -> OAuth consent
//      screen) - "External" user type is fine for a single-channel studio;
//      add your own Google account as a Test user if the app stays in
//      "Testing" publishing status (this is fine - no Google review needed
//      just to publish to your own channel).
//   4. Create credentials -> OAuth client ID -> Application type
//      "Desktop app" (APIs & Services -> Credentials). Copy the Client ID
//      and Client secret it gives you - those are the two arguments below.
//
// What it does:
//   1. Starts a tiny local HTTP server on http://127.0.0.1:<random free port>
//      (the loopback redirect flow - see below) and builds the Google
//      authorization URL with PKCE.
//   2. Prints that URL for you to open in your OWN browser (this script
//      never tries to auto-open one - it may be running headless/over SSH).
//   3. You sign in and approve access; Google redirects the browser back to
//      the local server with an authorization code, which this script picks
//      up automatically (no copy/paste needed).
//   4. Exchanges the code for tokens at Google's token endpoint, confirms a
//      refresh_token came back (see the note on access_type/prompt below).
//   5. Optionally fetches the channel's title via YouTube Data API's
//      channels.list?mine=true for a nicer confirmation message.
//   6. Saves client_id, client_secret, refresh_token, channel_title into
//      youtube_settings (id = 1), via the same UPDATE shape
//      server/routes/settings.js uses - this script talks to the DB
//      directly, not through the HTTP API.
//
// On the OAuth flow itself (verified against Google's current docs as of
// this writing - see the script's PR/commit description for sources):
//   - The old "out-of-band" (urn:ietf:wg:oauth:2.0:oob) copy-paste flow is
//     fully deprecated and no longer works for any client.
//   - Custom URI schemes (myapp://callback) are also no longer supported for
//     new installed-app clients.
//   - What DOES still work for "Desktop app" OAuth clients: the loopback IP
//     redirect flow - redirect_uri = http://127.0.0.1:<port>/<path>. Unlike
//     "Web application" clients, Desktop app clients are NOT required to
//     pre-register the exact port in Cloud Console; Google matches loopback
//     redirect URIs on host, ignoring the port. So this script asks the OS
//     for any free port at start time instead of hardcoding one.
//   - access_type=offline + prompt=consent are both passed on the
//     authorization request. Google only returns a refresh_token on a
//     user's FIRST consent for a given client+scope combination (or, for a
//     Desktop app client, on every request when access_type=offline is
//     set - but prompt=consent is added here too so a refresh token is
//     reliably reissued even if this is a re-run after the user revoked or
//     never got one, without them needing to know why).
//   - PKCE (code_challenge/code_verifier, S256) is added on top since it's
//     Google's current recommendation for installed apps, even though these
//     clients also get a client_secret from Cloud Console.

import crypto from 'node:crypto';
import http from 'node:http';
import { db } from '../server/db.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// youtube.upload: what youtube.js actually needs to call videos.insert.
// youtube.readonly: needed for the channels.list?mine=true lookup below
// (youtube.upload alone does not grant read access to channel metadata).
const SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
];

function usageAndExit(message) {
    if (message) console.error(`Ошибка: ${message}\n`);
    console.error('Использование:');
    console.error('  node scripts/register-youtube-oauth.mjs <client_id> <client_secret>');
    console.error('');
    console.error('client_id и client_secret берутся из своего проекта в Google Cloud Console:');
    console.error('  1. https://console.cloud.google.com/ - создать/выбрать проект');
    console.error('  2. APIs & Services -> Library -> включить "YouTube Data API v3"');
    console.error('  3. APIs & Services -> OAuth consent screen -> настроить (тип "External"');
    console.error('     подходит; пока статус "Testing" - добавить свой Google-аккаунт в Test users)');
    console.error('  4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID ->');
    console.error('     Application type: "Desktop app" -> скопировать Client ID и Client secret');
    process.exit(1);
}

function mask(secret) {
    if (!secret) return '(пусто)';
    if (secret.length <= 8) return '*'.repeat(secret.length);
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- argument parsing -------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(a => a !== '--dry-run');
const [clientId, clientSecret] = positional;

if (!clientId || !clientId.trim()) usageAndExit('нужен client_id первым аргументом');
if (!clientSecret || !clientSecret.trim()) usageAndExit('нужен client_secret вторым аргументом');

// --- PKCE + state -------------------------------------------------

const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
const state = base64url(crypto.randomBytes(16));

// --- --dry-run: just show the constructed authorization URL, no server, no network ---

if (dryRun) {
    const redirectUri = 'http://127.0.0.1:0/callback'; // placeholder port for inspection only
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    console.log('--dry-run: реальный OAuth-обмен пропущен, ниже только структура URL авторизации.\n');
    console.log(authUrl.toString());
    process.exit(0);
}

// --- start local loopback server on a random free port -------------------------

const server = http.createServer();
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const redirectUri = `http://127.0.0.1:${port}/callback`;

const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

console.log('Откройте эту ссылку в СВОЁМ браузере (скрипт не открывает браузер сам - это может');
console.log('быть SSH-сессия без графического окружения) и разрешите доступ нужному Google-аккаунту:\n');
console.log(authUrl.toString());
console.log('\nОжидаю подтверждения (локальный сервер слушает на http://127.0.0.1:' + port + ')...');

// --- wait for the redirect back to our loopback server -------------------------

let code;
try {
    ({ code } = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Не дождались авторизации за 5 минут - запустите скрипт заново.'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        if (reqUrl.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
        }
        const gotError = reqUrl.searchParams.get('error');
        const gotState = reqUrl.searchParams.get('state');
        const gotCode = reqUrl.searchParams.get('code');

        if (gotError) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                .end('<html><body><h2>Доступ не предоставлен.</h2><p>Можно закрыть эту вкладку и вернуться в терминал.</p></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Google вернул ошибку авторизации: ${gotError}`));
            return;
        }
        if (gotState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end('<html><body><h2>Неверный state, запрос отклонён.</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error('Параметр state не совпал - возможная подмена ответа, прервано из соображений безопасности.'));
            return;
        }
        if (!gotCode) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
                .end('<html><body><h2>Код авторизации отсутствует в ответе.</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            reject(new Error('Google не прислал authorization code.'));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<html><body><h2>Готово! Доступ подтверждён.</h2><p>Можно закрыть эту вкладку и вернуться в терминал.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        resolve({ code: gotCode });
    });
    }));
} catch (e) {
    console.error(`\nОшибка: ${e.message}`);
    process.exit(1);
}

console.log('Код авторизации получен, обмениваю на токены...');

// --- exchange the code for tokens -------------------------

const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
    }),
});
const tokenData = await tokenRes.json().catch(() => ({}));

if (!tokenRes.ok || !tokenData.access_token) {
    console.error('Не удалось обменять код на токены:', tokenData.error_description || tokenData.error || tokenRes.status);
    process.exit(1);
}

if (!tokenData.refresh_token) {
    console.error('\nОшибка: Google не вернул refresh_token.');
    console.error('Обычно это значит, что доступ этому приложению уже был выдан ранее, и Google');
    console.error('не переиздаёт refresh_token на повторном согласии без явного отзыва.');
    console.error('Отзовите доступ здесь: https://myaccount.google.com/permissions');
    console.error('(найдите своё OAuth-приложение в списке и нажмите "Remove Access"), затем запустите этот скрипт заново.');
    process.exit(1);
}

console.log('refresh_token получен.');

// --- optionally fetch channel title for a nicer confirmation -------------------------

let channelTitle = '';
try {
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const chData = await chRes.json();
    channelTitle = chData?.items?.[0]?.snippet?.title || '';
    if (channelTitle) console.log(`Канал: ${channelTitle}`);
    else console.log('Не удалось определить название канала (не критично, продолжаю).');
} catch (e) {
    console.log('Не удалось запросить название канала (не критично, продолжаю):', e.message);
}

// --- save into youtube_settings (id = 1) -------------------------

await db.execute({
    sql: 'UPDATE youtube_settings SET client_id = ?, client_secret = ?, refresh_token = ?, channel_title = ? WHERE id = 1',
    args: [clientId.trim(), clientSecret.trim(), tokenData.refresh_token.trim(), channelTitle],
});

console.log('\nГотово. Сохранено в youtube_settings:');
console.log(`  client_id:     ${mask(clientId)}`);
console.log(`  client_secret: ${mask(clientSecret)}`);
console.log(`  refresh_token: ${mask(tokenData.refresh_token)}`);
console.log(`  channel_title: ${channelTitle || '(не определён)'}`);
console.log('\nYouTube-публикация теперь настроена - server/lib/socialPublishers/youtube.js сможет получать access token по этому refresh_token при каждой публикации.');
