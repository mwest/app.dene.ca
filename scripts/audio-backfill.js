// Backfill recording provenance/derivatives (#8b): compute the SHA-256 of any
// master/legacy file that lacks one, and generate a playback MP3 for any master
// missing one (when ffmpeg is available). Idempotent and best-effort — runs on
// startup from the web process (like the embedding backfill) and also standalone:
// `node scripts/audio-backfill.js`.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import db, { AUDIO_DIR } from '../src/db.js';
import { sha256File, ffmpegReady, generateDerivative } from '../src/audio.js';

export async function backfillAudio(log = () => {}) {
  // 1. Checksums for any recording (master or legacy) missing one.
  const needHash = db.prepare('SELECT id, stored_name FROM audio_files WHERE sha256 IS NULL').all();
  if (needHash.length) log(`hashing ${needHash.length} recording(s)…`);
  const setHash = db.prepare('UPDATE audio_files SET sha256 = ? WHERE id = ?');
  let hashed = 0;
  for (const r of needHash) {
    const abs = path.join(AUDIO_DIR, r.stored_name);
    if (!fs.existsSync(abs)) continue; // file gone (e.g. deleted) — skip
    try {
      setHash.run(await sha256File(abs), r.id);
      hashed++;
    } catch (e) {
      log(`hash of audio ${r.id} failed: ${e.message}`);
    }
  }

  // 2. Playback derivatives for masters that lack one (only if ffmpeg is here).
  let derived = 0;
  if (await ffmpegReady) {
    const needDeriv = db
      .prepare("SELECT id FROM audio_files WHERE archive_class = 'lossless_master' AND playback_stored_name IS NULL")
      .all();
    if (needDeriv.length) log(`generating ${needDeriv.length} playback derivative(s)…`);
    for (const r of needDeriv) {
      if (await generateDerivative(r.id)) derived++;
    }
  }

  if (hashed || derived) log(`done: ${hashed} hashed, ${derived} derivatives`);
  return { hashed, derived };
}

// Standalone CLI invocation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backfillAudio((m) => console.log(m)).then((s) => {
    console.log('Done.', JSON.stringify(s));
    process.exit(0);
  });
}
