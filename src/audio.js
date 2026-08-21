// Archival audio pipeline (#8b): probe provenance, hash masters, and generate
// disposable mono-MP3 playback derivatives with ffmpeg. Shared by the HTTP layer
// (src/api.js) and the startup backfill (scripts/audio-backfill.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseFile } from 'music-metadata';
import db, { AUDIO_DIR } from './db.js';

// Masters are the source of truth; derivatives are regenerable playback copies.
export const MASTERS_DIR = path.join(AUDIO_DIR, 'masters');
export const DERIVED_DIR = path.join(AUDIO_DIR, 'derived');
fs.mkdirSync(MASTERS_DIR, { recursive: true });
fs.mkdirSync(DERIVED_DIR, { recursive: true });

// Probe duration + provenance. Duration is required (rejects unreadable files);
// the rest is advisory metadata stored on the master.
export async function probeAudio(filePath) {
  const meta = await parseFile(filePath);
  const f = meta.format || {};
  const duration = f.duration;
  if (!duration || !isFinite(duration) || duration <= 0) throw new Error('no duration');
  return {
    duration,
    sampleRate: f.sampleRate ?? null,
    channels: f.numberOfChannels ?? null,
    bitDepth: f.bitsPerSample ?? null,
    codec: f.codec || f.container || null,
  };
}

// Streaming SHA-256 so we never read a 500 MB master fully into memory.
export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(absPath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// --- ffmpeg detection --------------------------------------------------------
const FFMPEG = process.env.AUDIO_FFMPEG_PATH || 'ffmpeg';
let _ffmpegAvailable = false;
// Resolves once we know whether ffmpeg is on this host; callers gate on it so
// derivative generation degrades gracefully (e.g. local Windows dev, CI).
export const ffmpegReady = new Promise((resolve) => {
  try {
    const p = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
    p.on('error', () => {
      console.warn('[audio] ffmpeg not found — playback derivatives disabled; masters stream directly');
      resolve(false);
    });
    p.on('exit', (code) => {
      _ffmpegAvailable = code === 0;
      if (code === 0) console.log('[audio] ffmpeg available — playback derivatives enabled');
      resolve(_ffmpegAvailable);
    });
  } catch {
    resolve(false);
  }
});
export const derivativesEnabled = () => _ffmpegAvailable;

// --- derivative generation (bounded concurrency) -----------------------------
const queue = [];
let active = 0;
const MAX_JOBS = 2;

// Fire-and-forget from the request path; waits for ffmpeg detection first.
export function enqueueDerivative(audioId) {
  ffmpegReady.then((ok) => {
    if (!ok) return;
    queue.push(audioId);
    pump();
  });
}
function pump() {
  while (_ffmpegAvailable && active < MAX_JOBS && queue.length) {
    const id = queue.shift();
    active++;
    generateDerivative(id).finally(() => { active--; pump(); });
  }
}

// Transcode a master to a mono MP3 playback derivative. Writes to a temp file
// and only publishes (rename + DB update) on a clean exit, so a failed/half
// encode never becomes the playback copy and the backfill can retry. Resolves
// true if a derivative now exists.
export function generateDerivative(audioId) {
  return new Promise((resolve) => {
    const a = db
      .prepare('SELECT id, stored_name, uploaded_by, playback_stored_name FROM audio_files WHERE id = ?')
      .get(audioId);
    if (!a || a.playback_stored_name) return resolve(false);
    const master = path.join(AUDIO_DIR, a.stored_name);
    if (!fs.existsSync(master)) return resolve(false);
    const dir = path.join(DERIVED_DIR, String(a.uploaded_by));
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(a.stored_name, path.extname(a.stored_name));
    const rel = `derived/${a.uploaded_by}/${base}.mp3`;
    const outTmp = path.join(AUDIO_DIR, `${rel}.tmp`);
    const outFinal = path.join(AUDIO_DIR, rel);
    // -f mp3 is required: the temp file ends in .tmp, and without an explicit
    // format ffmpeg infers it from the extension and exits 1 ("unable to find a
    // suitable output format"). stderr is piped so a failure logs its reason.
    const ff = spawn(FFMPEG, ['-nostdin', '-y', '-i', master, '-ac', '1', '-codec:a', 'libmp3lame', '-q:a', '5', '-f', 'mp3', outTmp],
                     { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    ff.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-400); });
    ff.on('error', (e) => {
      console.error(`[audio] ffmpeg error for audio ${audioId}:`, e.message);
      fs.rm(outTmp, { force: true }, () => {});
      resolve(false);
    });
    ff.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[audio] ffmpeg exited ${code} for audio ${audioId}: ${errTail.trim().split('\n').pop() || 'no stderr'}`);
        fs.rm(outTmp, { force: true }, () => {});
        return resolve(false);
      }
      try {
        fs.renameSync(outTmp, outFinal);
        db.prepare('UPDATE audio_files SET playback_stored_name = ?, playback_mime_type = ? WHERE id = ?')
          .run(rel, 'audio/mpeg', audioId);
        resolve(true);
      } catch (e) {
        console.error(`[audio] failed to finalize derivative for ${audioId}:`, e.message);
        resolve(false);
      }
    });
  });
}
