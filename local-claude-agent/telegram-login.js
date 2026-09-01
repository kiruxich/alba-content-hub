// One-time interactive login for the Telegram-watch feature (see README.md
// "Telegram source watching"). Logs in as a REAL Telegram user account via
// MTProto (not a bot - reading arbitrary public channels' posts needs a user
// session, bots can't do this) and prints a session string to save into
// .env as TELEGRAM_SESSION. Run once via:
//   docker compose run --rm agent node telegram-login.js
// (needs an interactive terminal - phone number, login code, and 2FA
// password if you have one enabled - never run this non-interactively).
//
// The printed session string is a long-lived credential equivalent to being
// logged into this Telegram account - treat it like a password: it only
// goes into .env (gitignored, never committed), never logged or sent
// anywhere except read directly by server.js on this same machine.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const apiId = Number(process.env.TELEGRAM_API_ID || '');
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
    console.error('TELEGRAM_API_ID / TELEGRAM_API_HASH not set. Get them (free) from https://my.telegram.org -> API development tools, then put them in .env before running this.');
    process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

await client.start({
    phoneNumber: async () => await ask('Номер телефона (с кодом страны, напр. +79991234567): '),
    password: async () => await ask('Пароль двухфакторной аутентификации (если включена, иначе Enter): '),
    phoneCode: async () => await ask('Код из Telegram (пришёл в приложение/SMS): '),
    onError: (err) => console.error(err),
});

console.log('\nВход выполнен. Сохраните эту строку в .env как TELEGRAM_SESSION (это секрет уровня пароля - никому не показывайте и не коммитьте):\n');
console.log(client.session.save());
console.log('\nПосле сохранения в .env перезапустите контейнер: docker compose up -d --build');

rl.close();
await client.destroy();
process.exit(0);
