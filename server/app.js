import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import ideasRouter from './routes/ideas.js';
import eventsRouter from './routes/events.js';
import settingsRouter from './routes/settings.js';
import telegramRouter from './routes/telegram.js';
import telegramWebhookRouter from './routes/telegramWebhook.js';
import contentPlanRouter from './routes/contentPlan.js';
import nichesRouter from './routes/niches.js';
import projectInfoRouter from './routes/projectInfo.js';
import agentSettingsRouter from './routes/agentSettings.js';
import agentExpensesRouter from './routes/agentExpenses.js';
import agentRunsRouter from './routes/agentRuns.js';
import agentResearcherRouter from './routes/agentResearcher.js';
import urlCheckerRouter from './routes/urlChecker.js';
import parserNichesRouter from './routes/parserNiches.js';
import scrapeNichesRouter from './routes/scrapeNiches.js';
import mediaAssetsRouter from './routes/mediaAssets.js';
import contentRubricsRouter from './routes/contentRubrics.js';
import metricsSyncRouter from './routes/metricsSync.js';
import videoAssemblyRouter from './routes/videoAssembly.js';
import insightsRouter from './routes/insights.js';
import marketingRouter from './routes/marketing.js';
import socialPublishRouter from './routes/socialPublish.js';
import authRouter from './routes/auth.js';
import contentDraftsRouter from './routes/contentDrafts.js';
import telegramWatchRouter from './routes/telegramWatch.js';
import instagramWatchRouter from './routes/instagramWatch.js';
import { requireAuth } from './middleware/requireAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// Gates everything below - single-admin login, see server/lib/auth.js. A
// no-op until ADMIN_EMAIL/ADMIN_PASSWORD_HASH/SESSION_SECRET are set.
app.use('/api/auth', authRouter);
app.use(requireAuth);

app.use('/api/ideas', ideasRouter);
app.use('/api/events', eventsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/telegram/webhook', telegramWebhookRouter);
app.use('/api/content-plan', contentPlanRouter);
app.use('/api/niches', nichesRouter);
app.use('/api/project-info', projectInfoRouter);
app.use('/api/agent-settings', agentSettingsRouter);
app.use('/api/agent-expenses', agentExpensesRouter);
app.use('/api/agent-runs', agentRunsRouter);
app.use('/api/agent-researcher', agentResearcherRouter);
app.use('/api/url-checker', urlCheckerRouter);
app.use('/api/parser-niches', parserNichesRouter);
app.use('/api/scrape-niches', scrapeNichesRouter);
app.use('/api/media-assets', mediaAssetsRouter);
app.use('/api/content-rubrics', contentRubricsRouter);
app.use('/api/video-assembly', videoAssemblyRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/marketing', marketingRouter);
app.use('/api/metrics-sync', metricsSyncRouter);
app.use('/api/publish', socialPublishRouter);
app.use('/api/content-drafts', contentDraftsRouter);
app.use('/api/telegram-watch', telegramWatchRouter);
app.use('/api/instagram-watch', instagramWatchRouter);

// Traditional Node hosting (pnpm start): serve the Vite-built frontend from the
// same process. On Vercel this branch is never hit - static files are served
// straight from the "dist" output directory, and only /api/* is rewritten here.
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
    });
}

// Route handlers are async; this turns a rejected promise into a JSON error
// response instead of Express's default HTML error page.
app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

export default app;
