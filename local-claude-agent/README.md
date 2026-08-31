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

## 1. Build the image

```bash
cd local-claude-agent
docker build -t local-claude-agent .
```

## 2. Run it with a persistent auth volume

```bash
docker volume create claude-agent-auth
docker run -d --name local-claude-agent \
  -p 8790:8790 \
  -e AGENT_TOKEN=$(openssl rand -hex 24) \
  -v claude-agent-auth:/home/agent \
  local-claude-agent
```

Save the `AGENT_TOKEN` value it printed (or `docker inspect local-claude-agent`
to see it again) - you'll paste it into hub's env vars later.

## 3. Authenticate once (needs a Claude subscription)

```bash
docker exec -it local-claude-agent claude setup-token
```

This needs a real terminal (TTY) - it won't produce output piped/backgrounded.
Follow the prompts (opens a browser login, or prints a URL to open manually -
if pasting the URL doesn't work because your terminal wrapped it across lines,
press `c` in the prompt to copy the unwrapped URL to your clipboard instead of
selecting the text by hand). It prints a long-lived (1-year) token starting
`sk-ant-oat01-...` at the end - **copy it, you won't see it again**.

Set it as an env var on the container so it doesn't need to be re-entered on
every rebuild/recreate (`claude setup-token`'s own on-disk config only
persists via the mounted volume, but re-passing the token directly is
simpler and survives even a `docker volume rm`):

```bash
docker rm -f local-claude-agent
docker run -d --name local-claude-agent \
  -p 8790:8790 \
  -e AGENT_TOKEN=<your AGENT_TOKEN from step 2> \
  -e CLAUDE_CODE_OAUTH_TOKEN=<the sk-ant-oat01-... token> \
  -v claude-agent-auth:/home/agent \
  local-claude-agent
```

To get a fresh token later (e.g. it expires after a year, or you revoke it),
just repeat this whole step - you don't need to touch the image or volume.

Verify it worked:

```bash
curl -s -X POST http://localhost:8790/run/niche-description \
  -H "X-Agent-Token: <your AGENT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"category":"кальянные"}'
```

Should return `{"description": "..."}` within ~15 seconds.

## 4. Expose it to the internet with a tunnel

The container only makes an *outbound* connection to the tunnel provider -
you don't need to open any port on your router.

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(free, no Cloudflare-managed domain required for a quick tunnel):

```bash
# one-time
brew install cloudflared   # or the equivalent for your OS

# quick tunnel (URL changes every time you restart it - fine to start with)
cloudflared tunnel --url http://localhost:8790
```

It prints a `https://<random>.trycloudflare.com` URL - that's what hub will
call. For a stable URL across restarts, set up a named tunnel with your own
domain instead (see Cloudflare's docs) - not required to get started.

## 5. Wire it into hub

On hub's Coolify env vars, set:

```
LOCAL_CLAUDE_AGENT_URL=https://<your-tunnel-url>
LOCAL_CLAUDE_AGENT_TOKEN=<the AGENT_TOKEN from step 2>
```

Same graceful-no-op pattern as every other optional integration in this app -
the "Обновить"/"Сгенерировать" buttons that use this will just show a normal
"не настроен" error until both are set, and again whenever your PC/container/
tunnel happens to be off (a normal network-error toast, not a crash).

## Notes

- **Must be running when you click the button.** This isn't a background
  service on the VPS - if your PC is off or the container/tunnel isn't up,
  the request just fails like any other unreachable server.
- **Quick tunnel URLs change on restart** - if you use `cloudflared tunnel --url`
  (not a named tunnel), update `LOCAL_CLAUDE_AGENT_URL` on hub each time you
  restart the tunnel.
- To re-authenticate (e.g. token revoked), just re-run step 3.
