import { isRequestAuthenticated, isAuthConfigured } from '../lib/auth.js';

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Вход — Alba Content Hub</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  form {
    width: 100%; max-width: 340px; padding: 32px; background: #1c1c1e; border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; gap: 14px;
  }
  h1 { margin: 0 0 4px 0; font-size: 20px; }
  input {
    padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.15);
    background: #2c2c2e; color: #fff; font-size: 14px;
  }
  button {
    padding: 12px; border-radius: 10px; border: none; background: #0a84ff; color: #fff;
    font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  #error { color: #ff453a; font-size: 13px; min-height: 16px; }
</style>
</head>
<body>
<form id="login-form">
  <h1>Alba Content Hub</h1>
  <input type="email" id="email" placeholder="Email" autocomplete="username" required>
  <input type="password" id="password" placeholder="Пароль" autocomplete="current-password" required>
  <div id="error"></div>
  <button type="submit" id="submit-btn">Войти</button>
</form>
<script>
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  const errorEl = document.getElementById('error');
  btn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Ошибка входа'; btn.disabled = false; return; }
    window.location.reload();
  } catch (err) {
    errorEl.textContent = 'Не удалось связаться с сервером';
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;

// Gates every request. Left permanently open (no-op) if auth isn't
// configured (ADMIN_EMAIL/ADMIN_PASSWORD_HASH/SESSION_SECRET unset), so the
// app keeps working exactly as before for local dev where nobody's set
// those env vars - the hub is only actually locked down once they're set in
// production.
export function requireAuth(req, res, next) {
    if (!isAuthConfigured()) return next();
    if (req.path === '/api/auth/login') return next();
    if (isRequestAuthenticated(req)) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    res.status(200).type('html').send(LOGIN_PAGE);
}
