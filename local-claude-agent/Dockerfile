# Runs on the user's own PC (not the VPS) - see README.md for why. Installs
# the real `claude` CLI so the container authenticates as the user's actual
# Claude account/subscription (via `claude setup-token`, run once after the
# container is up), not a separate pay-per-token API key.
FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json .
# python3/make/g++ are needed only to compile native addons pulled in by the
# `telegram` (GramJS) package (bufferutil, utf-8-validate - node-gyp
# performance shims for its websocket transport) - node:22-slim has neither
# by default, and npm install fails without them. Removed again right after
# so they don't bloat the final image (they're a build-time-only need).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY server.js telegram-login.js ./

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
