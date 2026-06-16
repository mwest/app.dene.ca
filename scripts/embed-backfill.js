// Embed entries whose English embedding is missing or from an older model.
// Exposed as a function so the server can run it on startup (the reliable path:
// same process that serves search, with the baked model and NODE_ENV=production);
// also runnable standalone: `node scripts/embed-backfill.js`.
import { pathToFileURL } from 'node:url';
import db from '../src/db.js';
import { embed, toBlob, MODEL } from '../src/embed.js';

export async function backfillEmbeddings(log = () => {}) {
  const rows = db
    .prepare(
      `SELECT id, english_text FROM entries
       WHERE english_text <> '' AND (embedding IS NULL OR embedding_model IS NOT ?)`
    )
    .all(MODEL);
  if (!rows.length) return 0;
  log(`embedding ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} with ${MODEL}…`);
  const update = db.prepare('UPDATE entries SET embedding = ?, embedding_model = ? WHERE id = ?');
  let done = 0;
  for (const r of rows) {
    try {
      update.run(toBlob(await embed(r.english_text)), MODEL, r.id);
    } catch (e) {
      log(`entry ${r.id} failed: ${e.message}`);
    }
    if (++done % 200 === 0 || done === rows.length) log(`${done}/${rows.length}`);
  }
  return done;
}

// Standalone CLI invocation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillEmbeddings((m) => console.log(m)).then(() => {
    console.log('Done.');
    process.exit(0);
  });
}
