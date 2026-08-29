// Run at build time (see vercel.json buildCommand) so the embedding model
// lands on disk under server/models/ before Vercel packages the serverless
// function - see server/lib/embeddings.js for why this can't happen at
// request time instead.
import { embed } from '../server/lib/embeddings.js';

console.log('Prefetching embedding model (Xenova/multilingual-e5-small)...');
await embed('warm up');
console.log('Embedding model ready.');
