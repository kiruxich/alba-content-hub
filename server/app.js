import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import ideasRouter from './routes/ideas.js';
import eventsRouter from './routes/events.js';
import settingsRouter from './routes/settings.js';
import telegramRouter from './routes/telegram.js';
import contentPlanRouter from './routes/contentPlan.js';
import nichesRouter from './routes/niches.js';
import projectInfoRouter from './routes/projectInfo.js';
import agentSettingsRouter from './routes/agentSettings.js';
import agentExpensesRouter from './routes/agentExpenses.js';
import agentRunsRouter from './routes/agentRuns.js';
import agentResearcherRouter from './routes/agentResearcher.js';
import urlCheckerRouter from './routes/urlChecker.js';
import parserNichesRouter from './routes/parserNiches.js';
import mediaAssetsRouter from './routes/mediaAssets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/ideas', ideasRouter);
app.use('/api/events', eventsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/content-plan', contentPlanRouter);
app.use('/api/niches', nichesRouter);
app.use('/api/project-info', projectInfoRouter);
app.use('/api/agent-settings', agentSettingsRouter);
app.use('/api/agent-expenses', agentExpensesRouter);
app.use('/api/agent-runs', agentRunsRouter);
app.use('/api/agent-researcher', agentResearcherRouter);
app.use('/api/url-checker', urlCheckerRouter);
app.use('/api/parser-niches', parserNichesRouter);
app.use('/api/media-assets', mediaAssetsRouter);

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
