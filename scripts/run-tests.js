// `npm test`: boot the app against a throwaway data directory, run the smoke
// suite against it, and exit with the suite's status. Works locally (Windows or
// POSIX) and in CI; never touches the developer's real data/dene.db.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const EMAIL = 'ci-admin@test.ca';
const PASS = 'ci-admin-pass-1';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dene-test-'));
const env = { ...process.env, DENE_DATA_DIR: dataDir, PORT: String(PORT) };
delete env.NODE_ENV; // dev behavior: _test_lease_seconds etc. must work

console.log(`[test] data dir: ${dataDir}`);

// 1. Bootstrap the superadmin in the throwaway DB.
const boot = spawnSync(process.execPath, ['scripts/create-superadmin.js', EMAIL, 'CI Admin', PASS], {
  env, stdio: 'inherit',
});
if (boot.status !== 0) { console.error('[test] superadmin bootstrap failed'); process.exit(1); }

// 2. Start the server.
const server = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
let serverExited = false;
server.on('exit', (code) => { serverExited = true; if (code) console.error(`[test] server exited ${code}`); });

// 3. Wait for it to answer, then run the suite.
const started = Date.now();
async function waitForServer() {
  while (Date.now() - started < 60_000) {
    if (serverExited) throw new Error('server died before answering');
    try {
      const r = await fetch(`${BASE}/api/me`);
      if (r.status === 401) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not answer within 60s');
}

let status = 1;
try {
  await waitForServer();
  const suite = spawnSync(process.execPath, ['scripts/smoke-test.js', BASE, EMAIL, PASS], {
    env, stdio: 'inherit',
  });
  status = suite.status ?? 1;
} catch (err) {
  console.error(`[test] ${err.message}`);
} finally {
  server.kill();
  // Best-effort cleanup; Windows may briefly hold the WAL file.
  setTimeout(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave to OS temp */ }
    process.exit(status);
  }, 500);
}
