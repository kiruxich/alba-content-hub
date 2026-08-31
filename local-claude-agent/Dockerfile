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

# Auth state from `claude setup-token` lives under $HOME/.claude - mount a
# named volume at this path (see README.md) so it survives container
# restarts/rebuilds instead of needing to re-auth every time.
ENV HOME=/home/agent
RUN mkdir -p /home/agent && chmod 777 /home/agent

EXPOSE 8790
CMD ["node", "server.js"]
