// Proxies requests to api.telegram.org - Telegram's Bot API is unreachable
// directly from the VPS this hub runs on (confirmed: consistent 10s timeouts
// to api.telegram.org while google.com/github.com resolve instantly - the
// VPS's network path to Telegram specifically is blocked, not a general
// connectivity issue). Cloudflare's own network isn't blocked, so routing
// through a Worker sidesteps it.
//
// Usage: hub calls https://<this-worker>.workers.dev/bot<TOKEN>/<method> as
// if it were https://api.telegram.org/bot<TOKEN>/<method> directly - same
// path/query/method/body, just a different hostname.
export default {
    async fetch(request) {
        const url = new URL(request.url);
        const target = `https://api.telegram.org${url.pathname}${url.search}`;
        const proxied = new Request(target, request);
        return fetch(proxied);
    },
};
