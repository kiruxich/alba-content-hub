import { pipeline, env } from '@xenova/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_ID = 'Xenova/multilingual-e5-small';

// Model files are pre-fetched into this project-local directory at build time
// (scripts/prefetch-embedding-model.mjs), not node_modules' default cache, so
// Vercel's build output includes them (see vercel.json functions.includeFiles)
// and the serverless function never needs a network call to Hugging Face at
// request time - a 129MB download on every cold start would be slow, flaky,
// and billed as function execution time.
env.cacheDir = path.join(__dirname, '..', 'models');

let extractorPromise = null;
function getExtractor() {
    if (!extractorPromise) {
        extractorPromise = pipeline('feature-extraction', MODEL_ID, { quantized: true });
    }
    return extractorPromise;
}

// e5 models are trained with a "query: " / "passage: " prefix convention.
// For a plain symmetric similarity comparison (article vs. product
// description, neither is really a "search query") the documented approach
// is to use "query: " on both sides.
export async function embed(text) {
    const extractor = await getExtractor();
    const output = await extractor(`query: ${text}`, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// Both vectors are already L2-normalized (normalize: true above), so the dot
// product alone equals cosine similarity - no need for the full formula.
export function cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}
