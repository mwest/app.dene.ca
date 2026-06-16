// Build-time: download and cache the embedding model into the image so
// production loads it offline (no runtime download to stall on). The Dockerfile
// runs this before setting NODE_ENV=production, so the fetch is allowed.
import { embed, MODEL } from '../src/embed.js';

await embed('warm up the model cache');
console.log(`cached ${MODEL}`);
process.exit(0);
