import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// DENE_DATA_DIR overrides the data location (used by the test runner to give
// each `npm test` an isolated throwaway database + audio store).
export const DATA_DIR = process.env.DENE_DATA_DIR || path.join(ROOT, 'data');
// Audio lives at data/audio/<uploader user id>/<file>; stored_name in the DB
// is the path relative to AUDIO_DIR (e.g. "3/a1b2c3.mp3").
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
// Public translation-request uploads: data/requests/<request id>/<file>.
export const REQUESTS_DIR = path.join(DATA_DIR, 'requests');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'dene.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Organizations (#5): the explicit data owner. Platform administration
-- (is_superadmin: deploys, accounts, service ops) is separate from organization
-- authority over the corpus — a superadmin has NO implicit corpus access; all
-- project access flows from organization or project membership.
CREATE TABLE IF NOT EXISTS organizations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  slug       TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner_admin', 'admin', 'member')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, user_id)
);

-- Consent profiles (#6): reusable, org-owned bundles of permitted uses.
-- Profiles are EDITABLE, but recordings carry an immutable SNAPSHOT of the
-- permissions at assignment time — editing a profile never silently rewrites
-- the consent basis of existing recordings.
CREATE TABLE IF NOT EXISTS consent_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  allow_language_learning         INTEGER NOT NULL DEFAULT 0,
  allow_asr_training              INTEGER NOT NULL DEFAULT 0,
  allow_tts_training              INTEGER NOT NULL DEFAULT 0,
  allow_translation_model_training INTEGER NOT NULL DEFAULT 0,
  allow_research                  INTEGER NOT NULL DEFAULT 0,
  allow_commercial_use            INTEGER NOT NULL DEFAULT 0,
  allow_redistribution            INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (organization_id, name)
);

-- Audit trail for consent assignment and revocation on recordings.
CREATE TABLE IF NOT EXISTS consent_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  audio_id     INTEGER REFERENCES audio_files(id) ON DELETE SET NULL,
  action       TEXT NOT NULL CHECK (action IN ('assign', 'revoke')),
  profile_name TEXT,
  note         TEXT,
  changed_by   INTEGER NOT NULL REFERENCES users(id),
  changed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  dialect     TEXT,
  description TEXT,
  -- P2-1: per-project public visibility, unused in v1 but present in the model
  is_public   INTEGER NOT NULL DEFAULT 0,
  -- Owning organization. Nullable in SQL for migration order; the API requires
  -- it on every new project.
  organization_id INTEGER REFERENCES organizations(id),
  -- Default consent profile stamped onto new recordings (#6); NULL = new
  -- recordings start consent-unknown until an admin assigns permissions.
  default_consent_profile_id INTEGER REFERENCES consent_profiles(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member', 'translator')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  kind         TEXT NOT NULL DEFAULT 'word' CHECK (kind IN ('word', 'phrase')),
  dene_text    TEXT NOT NULL,
  english_text TEXT NOT NULL,
  source_doc   TEXT,
  notes        TEXT,
  category     TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'verified')),
  created_by   INTEGER NOT NULL REFERENCES users(id),
  updated_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_creator ON entries(created_by);

CREATE TABLE IF NOT EXISTS audio_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  stored_name      TEXT NOT NULL,
  original_name    TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  language         TEXT NOT NULL DEFAULT 'dene' CHECK (language IN ('dene', 'english')),
  speaker          TEXT,
  recording_notes  TEXT,
  uploaded_by      INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- Archival versioning (#8b): the current row per (entry, uploaded_by, language)
  -- has is_current=1; re-recording supersedes the old row rather than overwriting
  -- it, so masters are never destroyed. New recordings are 'lossless_master';
  -- pre-existing MP3/M4A recordings are 'legacy_lossy'. stored_name is the master;
  -- playback_stored_name is a disposable mono MP3 derivative served for playback.
  -- archive_class/capture_method allowed values are enforced in the API (ALTER
  -- can't add a CHECK, so we keep the columns plain for migrated DBs too).
  is_current           INTEGER NOT NULL DEFAULT 1,
  supersedes_audio_id  INTEGER,
  archive_class        TEXT,     -- 'lossless_master' | 'legacy_lossy'
  sha256               TEXT,
  sample_rate_hz       INTEGER,
  channels             INTEGER,
  bit_depth            INTEGER,
  codec                TEXT,
  playback_stored_name TEXT,
  playback_mime_type   TEXT,
  capture_method       TEXT,     -- 'browser_recording' | 'uploaded_file'
  capture_device       TEXT,
  -- Consent snapshot (#6): permissions carried BY the recording, stamped at
  -- assignment/recording time from a consent profile. NULL allow_* columns mean
  -- consent-unknown — excluded from purpose-filtered exports until assigned.
  consent_profile_name TEXT,
  allow_language_learning          INTEGER,
  allow_asr_training               INTEGER,
  allow_tts_training               INTEGER,
  allow_translation_model_training INTEGER,
  allow_research                   INTEGER,
  allow_commercial_use             INTEGER,
  allow_redistribution             INTEGER,
  consent_recorded_at  TEXT,
  consent_method       TEXT,     -- 'project_default_profile' | 'bulk_assign'
  consent_reference    TEXT,
  restrictions_notes   TEXT,
  revoked_at           TEXT,
  revoked_by           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audio_entry ON audio_files(entry_id);

-- Public translation requests: a tokened form link is emailed to the
-- requester ('invited'); once they submit, superadmins see it as a job.
CREATE TABLE IF NOT EXISTS translation_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL COLLATE NOCASE,
  name         TEXT,
  dialect      TEXT,
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'submitted')),
  expires_at   TEXT NOT NULL,
  submitted_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES translation_requests(id) ON DELETE CASCADE,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_request_files_request ON request_files(request_id);

-- Translator compensation. Rates are per (translator, project, work type) and
-- can change any time. Each billable event is logged once into work_log with
-- the amount snapshotted at that moment, so rate changes only affect future
-- work. Balances aggregate per translator across projects; payments record
-- money already paid offline (the app never moves money). All amounts are
-- integer cents (CAD).
CREATE TABLE IF NOT EXISTS translator_rates (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('translation', 'recording')),
  rate_cents INTEGER NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id, type)
);

CREATE TABLE IF NOT EXISTS work_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN ('translation', 'recording', 'adjustment')),
  entry_id    INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  audio_id    INTEGER REFERENCES audio_files(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  note        TEXT,
  -- Soft reference to the accepted work_item this ledger row bills for (NULL for
  -- legacy rows and manual adjustments). Intentionally NOT a foreign key: ledger
  -- rows must outlive the work_item/entry they came from (money already earned).
  work_item_id INTEGER,
  -- Owning organization, PERSISTED (not derived via the projects join) because
  -- project_id is ON DELETE SET NULL — attribution must survive project deletion
  -- so org-scoped admin views stay complete. NULL = pre-org legacy.
  organization_id INTEGER REFERENCES organizations(id),
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_log_user ON work_log(user_id);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paid_on     TEXT,
  method      TEXT,
  note        TEXT,
  -- The organization the payment was made on behalf of (tenant scoping).
  -- NULL = pre-org legacy: hidden from admin views, still in the contributor's /me.
  organization_id INTEGER REFERENCES organizations(id),
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

CREATE TABLE IF NOT EXISTS rate_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  old_cents  INTEGER,
  new_cents  INTEGER NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work items: the canonical unit of claimable, paid translator/speaker work.
-- A translation item covers completing one incomplete phrase; a recording item
-- covers one speaker recording one entry in one language (so many speakers can
-- each hold their own item for the same entry). Under the current auto-accept
-- policy a claim goes claimed -> accepted on submit in one transaction; the
-- 'queued'/'submitted'/'rejected' states exist for the future admin-review phase.
CREATE TABLE IF NOT EXISTS work_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entry_id         INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('translation', 'recording')),
  language         TEXT,  -- recording: 'dene'|'english'; translation: NULL
  assigned_to      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('queued', 'claimed', 'submitted', 'accepted', 'rejected', 'cancelled')),
  rate_cents       INTEGER,  -- rate snapshot captured at claim/adoption
  claimed_at       TEXT,
  lease_expires_at TEXT,
  submitted_at     TEXT,
  reviewed_at      TEXT,
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Paid rework: an accepted (billed) slot can only be paid again through an
  -- admin-authorized rework item referencing the work it redoes.
  rework_authorized     INTEGER NOT NULL DEFAULT 0,
  rework_of_work_item_id INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_items_entry ON work_items(entry_id);
CREATE INDEX IF NOT EXISTS idx_work_items_assignee ON work_items(assigned_to);
-- At most one active translation job per entry (a phrase is translated once).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_translation_active
  ON work_items(entry_id)
  WHERE type = 'translation' AND status IN ('claimed', 'submitted');
-- At most one active recording job per (entry, language, speaker) — many speakers
-- may each record the same entry, but not hold two live claims on the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_recording_active
  ON work_items(entry_id, language, assigned_to)
  WHERE type = 'recording' AND status IN ('claimed', 'submitted');
-- At most one PENDING rework authorization per slot — a duplicate would abort
-- the claim transaction when both try to become claimed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_recording_queued_rework
  ON work_items(entry_id, language, assigned_to)
  WHERE type = 'recording' AND status = 'queued';
`);

// Migration: language tag on recordings ('dene' or 'english').
const audioCols = db.prepare(`PRAGMA table_info(audio_files)`).all().map((c) => c.name);
if (!audioCols.includes('language')) {
  db.exec(`ALTER TABLE audio_files ADD COLUMN language TEXT NOT NULL DEFAULT 'dene'
           CHECK (language IN ('dene', 'english'))`);
}

// Migration (#8b): archival versioning + provenance columns on recordings.
for (const [col, ddl] of [
  ['is_current', `ALTER TABLE audio_files ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1`],
  ['supersedes_audio_id', `ALTER TABLE audio_files ADD COLUMN supersedes_audio_id INTEGER`],
  ['archive_class', `ALTER TABLE audio_files ADD COLUMN archive_class TEXT`],
  ['sha256', `ALTER TABLE audio_files ADD COLUMN sha256 TEXT`],
  ['sample_rate_hz', `ALTER TABLE audio_files ADD COLUMN sample_rate_hz INTEGER`],
  ['channels', `ALTER TABLE audio_files ADD COLUMN channels INTEGER`],
  ['bit_depth', `ALTER TABLE audio_files ADD COLUMN bit_depth INTEGER`],
  ['codec', `ALTER TABLE audio_files ADD COLUMN codec TEXT`],
  ['playback_stored_name', `ALTER TABLE audio_files ADD COLUMN playback_stored_name TEXT`],
  ['playback_mime_type', `ALTER TABLE audio_files ADD COLUMN playback_mime_type TEXT`],
  ['capture_method', `ALTER TABLE audio_files ADD COLUMN capture_method TEXT`],
  ['capture_device', `ALTER TABLE audio_files ADD COLUMN capture_device TEXT`],
]) {
  if (!audioCols.includes(col)) db.exec(ddl);
}
// Recordings that predate #8b are legacy lossy source assets (kept, not
// transcoded). New recordings set archive_class='lossless_master' explicitly, so
// they are never NULL — this only ever labels pre-existing rows.
db.exec(`UPDATE audio_files SET archive_class = 'legacy_lossy' WHERE archive_class IS NULL`);

// Migration: optional category on entries.
const entryCols = db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name);
if (!entryCols.includes('category')) {
  db.exec(`ALTER TABLE entries ADD COLUMN category TEXT`);
}

// Migration: entry kind ('word' or 'phrase'). Existing rows are dictionary
// words. ALTER can't carry the CHECK constraint, so the allowed values are
// enforced in the API; new databases get the CHECK from the CREATE TABLE above.
if (!entryCols.includes('kind')) {
  db.exec(`ALTER TABLE entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'word'`);
}

// Migration: semantic-search embedding of the English text (+ which model
// produced it, so a model change can be detected and re-backfilled).
if (!entryCols.includes('embedding')) {
  db.exec(`ALTER TABLE entries ADD COLUMN embedding BLOB`);
}
if (!entryCols.includes('embedding_model')) {
  db.exec(`ALTER TABLE entries ADD COLUMN embedding_model TEXT`);
}

// Migration: 'translator' membership role. SQLite cannot alter a CHECK
// constraint, so older databases get the memberships table rebuilt once.
const memTableSql = db
  .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memberships'`)
  .get().sql;
if (!memTableSql.includes('translator')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE memberships_new (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('admin', 'member', 'translator')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, project_id)
      );
      INSERT INTO memberships_new SELECT user_id, project_id, role, created_at FROM memberships;
      DROP TABLE memberships;
      ALTER TABLE memberships_new RENAME TO memberships;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

// Each user gets at most one CURRENT recording per language per entry. Superseded
// versions share the same (entry, uploaded_by, language), so the uniqueness is
// scoped to is_current=1. Replaces the old unconditional index (#8b).
db.exec(`DROP INDEX IF EXISTS idx_audio_one_per_lang`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_current_one_per_lang
         ON audio_files(entry_id, uploaded_by, language) WHERE is_current = 1`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audio_supersedes ON audio_files(supersedes_audio_id)`);

// Migration: ledger idempotency. Link each billed row to its work_item and make
// that link unique, so re-submitting a work item can never double-bill. Legacy
// rows keep work_item_id NULL. Fresh DBs already have the column from the
// CREATE TABLE above; existing DBs get it added here.
const workLogCols = db.prepare(`PRAGMA table_info(work_log)`).all().map((c) => c.name);
if (!workLogCols.includes('work_item_id')) {
  db.exec(`ALTER TABLE work_log ADD COLUMN work_item_id INTEGER`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_log_item
         ON work_log(work_item_id) WHERE work_item_id IS NOT NULL`);

// Migration (#6): consent snapshot columns on recordings + the project default
// profile pointer. All nullable — existing recordings stay consent-unknown until
// an org admin assigns a profile (bulk or per project default going forward).
for (const [col, ddl] of [
  ['consent_profile_name', `ALTER TABLE audio_files ADD COLUMN consent_profile_name TEXT`],
  ['allow_language_learning', `ALTER TABLE audio_files ADD COLUMN allow_language_learning INTEGER`],
  ['allow_asr_training', `ALTER TABLE audio_files ADD COLUMN allow_asr_training INTEGER`],
  ['allow_tts_training', `ALTER TABLE audio_files ADD COLUMN allow_tts_training INTEGER`],
  ['allow_translation_model_training', `ALTER TABLE audio_files ADD COLUMN allow_translation_model_training INTEGER`],
  ['allow_research', `ALTER TABLE audio_files ADD COLUMN allow_research INTEGER`],
  ['allow_commercial_use', `ALTER TABLE audio_files ADD COLUMN allow_commercial_use INTEGER`],
  ['allow_redistribution', `ALTER TABLE audio_files ADD COLUMN allow_redistribution INTEGER`],
  ['consent_recorded_at', `ALTER TABLE audio_files ADD COLUMN consent_recorded_at TEXT`],
  ['consent_method', `ALTER TABLE audio_files ADD COLUMN consent_method TEXT`],
  ['consent_reference', `ALTER TABLE audio_files ADD COLUMN consent_reference TEXT`],
  ['restrictions_notes', `ALTER TABLE audio_files ADD COLUMN restrictions_notes TEXT`],
  ['revoked_at', `ALTER TABLE audio_files ADD COLUMN revoked_at TEXT`],
  ['revoked_by', `ALTER TABLE audio_files ADD COLUMN revoked_by INTEGER`],
]) {
  if (!audioCols.includes(col)) db.exec(ddl);
}
const projCols6 = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
if (!projCols6.includes('default_consent_profile_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN default_consent_profile_id INTEGER REFERENCES consent_profiles(id)`);
}

// Migration (#5): explicit data ownership. Attach any pre-organization projects
// to a default org and grant owner_admin to every superadmin AT THIS MOMENT —
// the explicit, revocable grants must exist before the code stops treating
// is_superadmin as implicit project admin. Runs once (idempotent); fresh installs
// with no projects skip it and provision orgs via POST /orgs instead.
const projCols = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
if (!projCols.includes('organization_id')) {
  db.exec(`ALTER TABLE projects ADD COLUMN organization_id INTEGER REFERENCES organizations(id)`);
}
if (db.prepare(`SELECT 1 FROM projects WHERE organization_id IS NULL LIMIT 1`).get()) {
  db.transaction(() => {
    let org = db.prepare(`SELECT id FROM organizations WHERE slug = 'dene-voice-project'`).get();
    if (!org) {
      org = { id: db.prepare(`INSERT INTO organizations (name, slug) VALUES ('Dene Voice Project', 'dene-voice-project')`).run().lastInsertRowid };
    }
    db.prepare(`UPDATE projects SET organization_id = ? WHERE organization_id IS NULL`).run(org.id);
    const grant = db.prepare(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES (?, ?, 'owner_admin')
       ON CONFLICT(organization_id, user_id) DO NOTHING`
    );
    for (const u of db.prepare(`SELECT id FROM users WHERE is_superadmin = 1`).all()) {
      grant.run(org.id, u.id);
    }
  })();
}

// Migration (hardening): paid-rework columns on work_items, and persisted
// organization attribution on the money tables (work_log/payments) so tenant
// scoping survives project deletion (work_log.project_id is ON DELETE SET NULL).
const wiCols = db.prepare(`PRAGMA table_info(work_items)`).all().map((c) => c.name);
if (!wiCols.includes('rework_authorized')) {
  db.exec(`ALTER TABLE work_items ADD COLUMN rework_authorized INTEGER NOT NULL DEFAULT 0`);
}
if (!wiCols.includes('rework_of_work_item_id')) {
  db.exec(`ALTER TABLE work_items ADD COLUMN rework_of_work_item_id INTEGER`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_recording_queued_rework
         ON work_items(entry_id, language, assigned_to)
         WHERE type = 'recording' AND status = 'queued'`);

const wlCols2 = db.prepare(`PRAGMA table_info(work_log)`).all().map((c) => c.name);
if (!wlCols2.includes('organization_id')) {
  db.exec(`ALTER TABLE work_log ADD COLUMN organization_id INTEGER REFERENCES organizations(id)`);
}
const payCols = db.prepare(`PRAGMA table_info(payments)`).all().map((c) => c.name);
if (!payCols.includes('organization_id')) {
  db.exec(`ALTER TABLE payments ADD COLUMN organization_id INTEGER REFERENCES organizations(id)`);
}
// Backfill attribution: rows tied to a live project take that project's org; the
// remainder (NULL project — old adjustments, orphans, and all old payments) can
// be mapped safely only when a SINGLE organization exists. In a multi-org world
// unmappable rows stay NULL = legacy: hidden from admin views, visible in /me.
db.transaction(() => {
  db.exec(`UPDATE work_log SET organization_id =
             (SELECT p.organization_id FROM projects p WHERE p.id = work_log.project_id)
           WHERE organization_id IS NULL AND project_id IS NOT NULL`);
  const orgs = db.prepare(`SELECT id FROM organizations`).all();
  if (orgs.length === 1) {
    db.prepare(`UPDATE work_log SET organization_id = ? WHERE organization_id IS NULL`).run(orgs[0].id);
    db.prepare(`UPDATE payments SET organization_id = ? WHERE organization_id IS NULL`).run(orgs[0].id);
  }
})();

// Migration (hardening #10): session tokens are now stored hashed. Existing
// rows hold raw tokens that would no longer resolve — clear them once (everyone
// signs in again), gated by PRAGMA user_version so this never re-runs.
if (db.pragma('user_version', { simple: true }) < 1) {
  db.exec('DELETE FROM sessions');
  db.pragma('user_version = 1');
}

export default db;

// ---- Role helpers -------------------------------------------------------
// Platform administration (is_superadmin) grants NO corpus access: every project
// role flows from an organization role or a project membership. The migration
// above ensures the people who previously relied on the implicit superadmin rule
// hold an explicit (and revocable) owner_admin grant instead.

/** Role of a user in an organization: 'owner_admin', 'admin', 'member', or null. */
export function orgRole(user, orgId) {
  const row = db
    .prepare('SELECT role FROM organization_memberships WHERE user_id = ? AND organization_id = ?')
    .get(user.id, orgId);
  return row ? row.role : null;
}

/** Organizations the user belongs to, with role. */
export function orgsFor(user) {
  return db
    .prepare(
      `SELECT o.id, o.name, o.slug, om.role FROM organizations o
       JOIN organization_memberships om ON om.organization_id = o.id
       WHERE om.user_id = ? ORDER BY o.name`
    )
    .all(user.id);
}

/**
 * Effective role of a user in a project: 'admin', 'member', 'translator', or null.
 * Org owner_admins/admins are admins of every project their organization owns;
 * otherwise the project membership row decides.
 */
export function roleIn(user, projectId) {
  const viaOrg = db
    .prepare(
      `SELECT 1 FROM projects p
       JOIN organization_memberships om ON om.organization_id = p.organization_id
       WHERE p.id = ? AND om.user_id = ? AND om.role IN ('owner_admin', 'admin')`
    )
    .get(projectId, user.id);
  if (viaOrg) return 'admin';
  const row = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND project_id = ?')
    .get(user.id, projectId);
  return row ? row.role : null;
}

/** Projects visible to a user, with role. Org-admin authority wins over a plain
 *  project membership when both exist. */
export function projectsFor(user) {
  return db
    .prepare(
      `SELECT p.*, MIN(src.rank) AS rank,
              CASE MIN(src.rank) WHEN 1 THEN 'admin' ELSE MAX(src.role) END AS role
       FROM (
         SELECT p2.id AS pid, 1 AS rank, 'admin' AS role
           FROM projects p2
           JOIN organization_memberships om ON om.organization_id = p2.organization_id
          WHERE om.user_id = ? AND om.role IN ('owner_admin', 'admin')
         UNION ALL
         SELECT m.project_id AS pid, 2 AS rank, m.role AS role
           FROM memberships m WHERE m.user_id = ?
       ) src
       JOIN projects p ON p.id = src.pid
       GROUP BY p.id ORDER BY p.name`
    )
    .all(user.id, user.id)
    .map(({ rank, ...p }) => p);
}

/** IDs of projects the user may read. */
export function projectIdsFor(user) {
  return projectsFor(user).map((p) => p.id);
}
