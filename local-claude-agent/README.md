# local-claude-agent

Runs on **your own PC**, not the VPS. A tiny HTTP wrapper around the real
`claude` CLI, so a few specific buttons on the hub (RSS-source discovery,
parser-niche description, Reels script generation) can ask Claude to do
research/writing on demand, billed under your existing Claude subscription
usage instead of a separate pay-per-token Anthropic API key.

It only exposes three fixed tasks (`/run/rss-discovery`, `/run/niche-description`,
`/run/reels-script`) - not a generic "run any prompt" endpoint - and the `claude`
CLI itself is invoked with `--allowedTools WebSearch` only (no Bash/Edit/Write),
so even a leaked tunnel URL/token can't be used to run arbitrary commands
against your machine or account.

Runs as two containers via Docker Compose - the agent itself, and an `ngrok`
sidecar that tunnels it to a fixed public URL. Both have `restart:
unless-stopped`, so once set up, `docker compose up -d` is the only manual
step you ever need - both come back automatically whenever Docker Desktop
starts (including after a reboot), no LaunchAgent or manual relaunch required.

## 1. One-time setup

**a) A Claude Code auth token** (needs a Claude subscription) - run once,
anywhere you have the `claude` CLI (doesn't have to be in the container):

```bash
claude setup-token
```

Follow the prompts (opens a browser login, or prints a URL to open manually -
if pasting the URL doesn't work because your terminal wrapped it across
lines, press `c` in the prompt to copy the unwrapped URL to your clipboard
instead of selecting the text by hand). It prints a long-lived (1-year)
token starting `sk-ant-oat01-...` at the end - **copy it, you won't see it
again**.

**b) A free ngrok account + reserved domain** (stays constant across
restarts, unlike a random one-off tunnel URL):

1. Sign up at [ngrok.com](https://dashboard.ngrok.com/signup) (free)
2. Copy your authtoken from the dashboard
3. Go to [dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains) →
   "New Domain" - the free tier includes one reserved `*.ngrok-free.app`
   domain that's yours permanently, no configuration needed on renewal

## 2. Configure

Create `local-claude-agent/.env` (gitignored - never commit this):

```
AGENT_TOKEN=<random secret - e.g. output of: openssl rand -hex 24>
CLAUDE_CODE_OAUTH_TOKEN=<the sk-ant-oat01-... token from step 1a>
NGROK_AUTHTOKEN=<your ngrok authtoken from step 1b>
NGROK_DOMAIN=https://<your-reserved-domain>.ngrok-free.app
```

## 3. Run it

```bash
cd local-claude-agent
docker compose up -d --build
```

Verify it worked:

```bash
curl -s https://<your-domain>.ngrok-free.app/health -H "ngrok-skip-browser-warning: true"
# {"ok":true}

curl -s -X POST https://<your-domain>.ngrok-free.app/run/niche-description \
  -H "X-Agent-Token: <your AGENT_TOKEN>" \
  -H "ngrok-skip-browser-warning: true" \
  -H "Content-Type: application/json" \
  -d '{"category":"кальянные"}'
# {"description": "..."} within ~15 seconds
```

## 4. Wire it into hub

On hub's Coolify env vars, set:

```
LOCAL_CLAUDE_AGENT_URL=https://<your-domain>.ngrok-free.app
LOCAL_CLAUDE_AGENT_TOKEN=<your AGENT_TOKEN>
```

Same graceful-no-op pattern as every other optional integration in this app -
the "Обновить"/"Сгенерировать" buttons that use this will just show a normal
"не настроен" error until both are set, and again whenever your PC/Docker
happens to be off (a normal network-error toast, not a crash).

## 5. Telegram source watching (optional)

A separate feature in Центр агентов - a manually-curated list of Telegram
channels you can browse for inspiration, scanned live on demand (never on a
schedule - this always requires your Mac to actually be running when you
click "Обновить", unlike RSS/VK/YouTube which run automatically on the VPS).
Reading arbitrary public channels' posts needs a real Telegram user
(MTProto) session - a bot token can't do this - so this is a one-time
interactive login as your own Telegram account, done once on this container.

**a) Get API credentials** (free, one-time) - go to
[my.telegram.org](https://my.telegram.org) → log in with your phone number →
"API development tools" → fill in any app name/short name → copy the
`api_id` and `api_hash` shown.

**b) Add them to `.env`:**

```
TELEGRAM_API_ID=<api_id from my.telegram.org>
TELEGRAM_API_HASH=<api_hash from my.telegram.org>
```

**c) Log in interactively** (needs a real terminal - phone number, the login
code Telegram sends you, and your 2FA password if you have one enabled):

```bash
docker compose run --rm agent node telegram-login.js
```

It prints a session string at the end - **treat it like a password** (it's
equivalent to being logged into your Telegram account). Add it to `.env`:

```
TELEGRAM_SESSION=<the printed session string>
```

Then restart the persistent container so it picks up the new env vars:

```bash
docker compose up -d --build
```

That's it - no separate tunnel/domain needed, this reuses the same
container and `LOCAL_CLAUDE_AGENT_URL`/`TOKEN` already wired into hub. The
channel list itself (which channels to watch) is managed entirely from
hub's UI (Центр агентов → «Telegram — отслеживание каналов»), not here -
this container only ever does the live fetch when asked.

## Notes

- **Must be running when you click the button.** This isn't a background
  service on the VPS - if your PC/Docker Desktop is off, the request just
  fails like any other unreachable server. Because both containers are
  `restart: unless-stopped`, simply having Docker Desktop running is enough -
  no manual relaunch after a reboot.
- **The reserved ngrok domain never changes** - `LOCAL_CLAUDE_AGENT_URL` on
  hub only needs to be set once.
- To re-authenticate (e.g. the Claude token expires or is revoked), rerun
  `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then
  `docker compose up -d --build` again.
- ngrok's free tier serves an interstitial "you're about to visit..." page to
  plain browser visits - the `ngrok-skip-browser-warning` header (already
  sent by hub's client, see `server/lib/localClaudeAgent.js`) skips it for
  API calls.
