import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';

import db from './src/db.js';
import api from './src/api.js';
import { backfillEmbeddings } from './scripts/embed-backfill.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');

const app = express();
app.disable('x-powered-by');
// In production the app sits behind Fly.io's TLS-terminating proxy
app.set('trust proxy', 1);
app.use(cookieParser());

app.use('/api', api);
// no-cache (revalidate every load) for code and markup so deploys show up
// immediately; other static assets can be cached for a day.
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));
// SPA fallback: any non-API path serves the app shell.
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), {
    headers: { 'Cache-Control': 'no-cache' },
  });
});

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

app.listen(PORT, () => {
  console.log(`Dene Voice Library running at http://localhost:${PORT}`);
  if (userCount === 0) {
    console.log('');
    console.log('No accounts exist yet. Create the superadmin with:');
    console.log('  npm run create-superadmin -- <email> <name> <password>');
  }
  // Embed any entries missing an English embedding, in the background. Runs in
  // the web process (baked model, NODE_ENV=production) so semantic search has
  // data without a separate/SSH step; idempotent, so it no-ops once caught up.
  backfillEmbeddings((m) => console.log(`[embed] ${m}`))
    .catch((e) => console.error('[embed] backfill failed:', e.message));
});
