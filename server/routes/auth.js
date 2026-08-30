import { Router } from 'express';
import { verifyCredentials, issueSessionCookie, clearSessionCookie, isRequestAuthenticated, isAuthConfigured } from '../lib/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
    if (!isAuthConfigured()) {
        return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
    }
    const { email, password } = req.body || {};
    const ok = await verifyCredentials(email, password);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
    issueSessionCookie(res);
    res.json({ ok: true });
});

router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    res.json({ authenticated: isRequestAuthenticated(req) });
});

export default router;
