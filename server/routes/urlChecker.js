import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSources, defaultCatalog, dedupeFindings } from '@legit-agent/core';
import PDFDocument from 'pdfkit';
import { runLoadTest } from '../lib/loadTest.js';
import { renderLivePage } from '../lib/parserWorkerClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(__dirname, '..', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'fonts', 'Roboto-Bold.ttf');

const router = Router();

function normalizeUrl(input) {
    let url = String(input || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
        return new URL(url).toString();
    } catch {
        return null;
    }
}

// POST /api/url-checker/scan {url, mode?, concurrency?, durationMs?, requestCount?}
// Runs the legitAgent static rule catalog (152-FZ / 38-FZ / ZoZPP) against the
// page's HTML, plus a bounded load test.
//
// mode: 'fast' (default) - plain server-side fetch() of the raw HTML, no
//   browser, no cookie-banner interaction, no SPA hydration.
// mode: 'live' - delegates to parser-worker's headed-Chromium /render
//   endpoint (the only process in this repo that runs a browser), which
//   navigates the page, waits for it to settle, best-effort declines a
//   cookie-consent banner if it can confidently find one, and returns the
//   fully hydrated post-JS HTML. Slower, but sees what the actual page
//   showed a real visitor instead of just the initial HTML response.
router.post('/scan', async (req, res) => {
    const url = normalizeUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'valid url is required' });
    const mode = req.body?.mode === 'live' ? 'live' : 'fast';

    const report = { url, checkedAt: new Date().toISOString(), mode };

    const fetchStart = Date.now();
    let html = '';
    try {
        if (mode === 'live') {
            const rendered = await renderLivePage(url);
            html = rendered.html || '';
            const finalUrl = rendered.final_url || url;
            const headers = rendered.headers || {};
            report.health = {
                ok: !!rendered.ok,
                status: rendered.status ?? null,
                finalUrl,
                https: finalUrl.startsWith('https://'),
                responseTimeMs: Date.now() - fetchStart,
                contentLength: html.length,
                securityHeaders: {
                    'strict-transport-security': headers['strict-transport-security'] || null,
                    'content-security-policy': headers['content-security-policy'] || null,
                    'x-content-type-options': headers['x-content-type-options'] || null,
                    'x-frame-options': headers['x-frame-options'] || null,
                },
            };
            report.cookieBanner = rendered.cookie_banner || null;
        } else {
            const pageRes = await fetch(url, { redirect: 'follow' });
            html = await pageRes.text();
            report.health = {
                ok: pageRes.ok,
                status: pageRes.status,
                finalUrl: pageRes.url,
                https: pageRes.url.startsWith('https://'),
                responseTimeMs: Date.now() - fetchStart,
                contentLength: html.length,
                securityHeaders: {
                    'strict-transport-security': pageRes.headers.get('strict-transport-security') || null,
                    'content-security-policy': pageRes.headers.get('content-security-policy') || null,
                    'x-content-type-options': pageRes.headers.get('x-content-type-options') || null,
                    'x-frame-options': pageRes.headers.get('x-frame-options') || null,
                },
            };
        }
    } catch (e) {
        report.health = { ok: false, error: mode === 'live' ? `Полная проверка (браузер) недоступна: ${e.message}` : e.message };
    }

    report.findings = html
        ? dedupeFindings(scanSources([{ relativePath: 'index.html', source: html }], defaultCatalog()))
        : [];
    report.findingsSummary = { high: 0, medium: 0, low: 0 };
    for (const f of report.findings) {
        report.findingsSummary[f.severity] = (report.findingsSummary[f.severity] || 0) + 1;
    }

    try {
        const requestCount = req.body?.requestCount !== undefined && req.body?.requestCount !== null && req.body?.requestCount !== ''
            ? Number(req.body.requestCount)
            : undefined;
        // Request-count mode is still bounded by loadTest.js's own hard
        // MAX_DURATION_MS (15s) safety net - a large requestCount at the
        // default concurrency=10 would rarely finish in time (e.g. 1000
        // requests at ~250ms each needs ~25s at concurrency 10, but only
        // ~12.5s at concurrency 20). Auto-scale concurrency toward that cap
        // when the caller didn't explicitly ask for a specific one, so
        // "количество запросов" actually has a realistic shot at being hit.
        const explicitConcurrency = Number(req.body?.concurrency) || 0;
        const autoConcurrency = requestCount ? Math.min(20, Math.max(10, Math.ceil(requestCount / 50))) : 10;
        report.loadTest = await runLoadTest(url, {
            concurrency: explicitConcurrency || autoConcurrency,
            durationMs: Number(req.body?.durationMs) || 5000,
            requestCount,
        });
    } catch (e) {
        report.loadTest = { error: e.message };
    }

    res.json(report);
});

// POST /api/url-checker/pdf - body is the exact report object returned by
// /scan (client re-sends what it already has, no re-scanning needed).
router.post('/pdf', async (req, res) => {
    const report = req.body || {};
    if (!report.url) return res.status(400).json({ error: 'report data is required' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="site-check-${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);
    doc.font('Regular'); // pdfkit's built-in Helvetica has no Cyrillic glyphs
    doc.pipe(res);

    doc.font('Bold').fontSize(20).fillColor('#000').text('Отчёт проверки сайта');
    doc.font('Regular');
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor('#555').text(report.url);
    doc.text(`Дата: ${new Date(report.checkedAt || Date.now()).toLocaleString('ru-RU')}`);
    doc.moveDown();

    doc.font('Bold').fillColor('#000').fontSize(14).text('Доступность');
    doc.font('Regular').fontSize(10).fillColor('#333');
    if (report.health?.ok !== undefined) {
        doc.text(`Статус: ${report.health.status ?? '—'}   HTTPS: ${report.health.https ? 'да' : 'нет'}   Время ответа: ${report.health.responseTimeMs ?? '—'} мс`);
        const headers = report.health.securityHeaders || {};
        const missing = Object.entries(headers).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) doc.fillColor('#a60').text(`Отсутствуют заголовки безопасности: ${missing.join(', ')}`);
    } else {
        doc.fillColor('#c00').text(`Ошибка: ${report.health?.error || 'нет данных'}`);
    }
    doc.moveDown();

    const findings = report.findings || [];
    const summary = report.findingsSummary || {};
    doc.font('Bold').fillColor('#000').fontSize(14).text(`Юридические риски (152-ФЗ / 38-ФЗ / ЗоЗПП) — найдено ${findings.length}`);
    doc.font('Regular').fontSize(9).fillColor('#333')
        .text(`Критично: ${summary.high || 0}   Средне: ${summary.medium || 0}   Низко: ${summary.low || 0}`);
    doc.moveDown(0.5);

    if (findings.length === 0) {
        doc.fontSize(10).fillColor('#333').text('Находок не обнаружено статическим анализом HTML.');
    } else {
        for (const f of findings) {
            doc.font('Bold').fontSize(10).fillColor('#000').text(`[${String(f.severity).toUpperCase()}] ${f.ruleId}`);
            doc.font('Regular').fontSize(9).fillColor('#333').text(f.message);
            if (f.fix) doc.fillColor('#0a5').text(`Исправление: ${f.fix}`);
            doc.moveDown(0.4);
        }
    }
    doc.moveDown();

    doc.font('Bold').fillColor('#000').fontSize(14).text('Нагрузочный тест');
    doc.font('Regular').fontSize(9).fillColor('#333');
    const lt = report.loadTest || {};
    if (lt.error) {
        doc.fillColor('#c00').text(`Ошибка: ${lt.error}`);
    } else {
        doc.text(`Запросов: ${lt.totalRequests ?? '—'}   Ошибок: ${lt.errors ?? 0} (${Math.round((lt.errorRate || 0) * 100)}%)   RPS: ${lt.requestsPerSecond ?? '—'}`);
        doc.text(`Время ответа — среднее: ${lt.avgMs ?? '—'} мс, p50: ${lt.p50Ms ?? '—'} мс, p95: ${lt.p95Ms ?? '—'} мс, макс: ${lt.maxMs ?? '—'} мс`);
    }

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor('#888').text(
        'Это эвристическая проверка кода/HTML, а не юридическое заключение. legitAgent не заменяет юриста и не гарантирует соответствие закону. Нагрузочный тест предназначен только для сайтов, на проверку которых у вас есть разрешение.',
        { width: 480 }
    );

    doc.end();
});

export default router;
