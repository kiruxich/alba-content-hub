// Vercel serverless entry point. Every request to /api/* is rewritten here
// (see vercel.json) and handled by the same Express app used for local dev.
import app from '../server/app.js';

export default app;
