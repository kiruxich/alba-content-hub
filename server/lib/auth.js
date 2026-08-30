// Single-admin authentication for the whole hub - no registration, no user
// table. One email/password pair, configured entirely via env vars
// (ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET), checked by
// requireAuth middleware (server/middleware/requireAuth.js) in front of
// every route. Session state is a signed cookie (HMAC-SHA256), not a
// server-side session store - there's exactly one possible session identity,
// so there's nothing to look up.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE_NAME = 'alba_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isAuthConfigured() {
    return Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH && SESSION_SECRET);
}

export async function verifyCredentials(email, password) {
    if (!isAuthConfigured()) return false;
    if ((email || '').trim().toLowerCase() !== process.env.ADMIN_EMAIL.trim().toLowerCase()) return false;
    return bcrypt.compare(password || '', process.env.ADMIN_PASSWORD_HASH);
}

function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function verify(token) {
    if (!token || !SESSION_SECRET) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    // Constant-time comparison - a naive `sig === expectedSig` would leak
    // timing information an attacker could use to forge a valid signature
    // byte-by-byte.
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
        if (!payload.exp || Date.now() > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

export function issueSessionCookie(res) {
    const token = sign({ exp: Date.now() + SESSION_MAX_AGE_MS });
    res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_MS,
    });
}

export function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE_NAME);
}

export function isRequestAuthenticated(req) {
    if (!isAuthConfigured()) return false;
    const token = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    return Boolean(verify(token));
}

function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
}
