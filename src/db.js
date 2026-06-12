import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
// Audio lives at data/audio/<uploader user id>/<file>; stored_name in the DB
// is the path relative to AUDIO_DIR (e.g. "3/a1b2c3.mp3").
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');

fs.mkdirSync(AUDIO_DIR, { recursive: true });

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

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  dialect     TEXT,
  description TEXT,
  -- P2-1: per-project public visibility, unused in v1 but present in the model
  is_public   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id),
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
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audio_entry ON audio_files(entry_id);
`);

// Migration: language tag on recordings ('dene' or 'english').
const audioCols = db.prepare(`PRAGMA table_info(audio_files)`).all().map((c) => c.name);
if (!audioCols.includes('language')) {
  db.exec(`ALTER TABLE audio_files ADD COLUMN language TEXT NOT NULL DEFAULT 'dene'
           CHECK (language IN ('dene', 'english'))`);
}

// Migration: optional category on entries.
const entryCols = db.prepare(`PRAGMA table_info(entries)`).all().map((c) => c.name);
if (!entryCols.includes('category')) {
  db.exec(`ALTER TABLE entries ADD COLUMN category TEXT`);
}

// Each user gets at most one recording per language per entry.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_one_per_lang
         ON audio_files(entry_id, uploaded_by, language)`);

export default db;

// ---- Role helpers -------------------------------------------------------

/**
 * Effective role of a user in a project: 'admin', 'member', or null.
 * Superadmins are implicit admins of every project.
 */
export function roleIn(user, projectId) {
  if (user.is_superadmin) return 'admin';
  const row = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND project_id = ?')
    .get(user.id, projectId);
  return row ? row.role : null;
}

/** Projects visible to a user (all of them for superadmins), with role. */
export function projectsFor(user) {
  if (user.is_superadmin) {
    return db
      .prepare(`SELECT p.*, 'admin' AS role FROM projects p ORDER BY p.name`)
      .all();
  }
  return db
    .prepare(
      `SELECT p.*, m.role FROM projects p
       JOIN memberships m ON m.project_id = p.id
       WHERE m.user_id = ? ORDER BY p.name`
    )
    .all(user.id);
}

/** IDs of projects the user may read. */
export function projectIdsFor(user) {
  return projectsFor(user).map((p) => p.id);
}
