// Remove smoke-test artifacts (projects named "Smoke Test ...", @test.ca users).
import db from '../src/db.js';

const pids = db.prepare(`SELECT id FROM projects WHERE name LIKE 'Smoke Test %'`).all().map((r) => r.id);
for (const id of pids) {
  db.prepare('DELETE FROM entries WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}
const info = db.prepare(`DELETE FROM users WHERE email LIKE '%@test.ca'`).run();
console.log(`Removed ${pids.length} test projects and ${info.changes} test users`);
