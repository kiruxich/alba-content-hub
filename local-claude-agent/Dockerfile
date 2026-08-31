# Runs on the user's own PC (not the VPS) - see README.md for why. Installs
# the real `claude` CLI so the container authenticates as the user's actual
# Claude account/subscription (via `claude setup-token`, run once after the
# container is up), not a separate pay-per-token API key.
FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY server.js .

# `claude --dangerously-skip-permissions` (needed since there's no TTY here
# to approve tool use interactively) refuses to run as root/sudo - has to be
# a real non-root user. Auth state from `claude setup-token` lives under
# $HOME/.claude - mount a named volume at this path (see README.md) so it
# survives container restarts/rebuilds instead of needing to re-auth every time.
ENV HOME=/home/agent
RUN usermod -d /home/agent node \
    && mkdir -p /home/agent && chown -R node:node /home/agent /app
USER node

EXPOSE 8790
CMD ["node", "server.js"]
