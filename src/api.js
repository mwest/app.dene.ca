import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import db, { AUDIO_DIR, roleIn, projectsFor, projectIdsFor } from './db.js';
import { APP_URL, inviteEmail, resetEmail, sendMail } from './mail.js';
import {
  COOKIE_NAME,
  cookieOptions,
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  requireSuperadmin,
  verifyPassword,
} from './auth.js';

const api = express.Router();
api.use(express.json());

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

api.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return bad(res, 'Email and password are required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return bad(res, 'Invalid email or password', 401);
  }
  const token = createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions());
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  if (req.cookies[COOKIE_NAME]) destroySession(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Password tokens (invites + resets) — public endpoints, token-authenticated
// ---------------------------------------------------------------------------

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Create a single-use token for a user; replaces any prior one of the same purpose. */
function createPasswordToken(userId, purpose, hours) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    `INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at)
     VALUES (?, ?, ?, datetime('now', '+${Number(hours)} hours'))`
  ).run(hashToken(token), userId, purpose);
  return token;
}

function lookupPasswordToken(token) {
  db.prepare(`DELETE FROM password_tokens WHERE expires_at < datetime('now')`).run();
  return db
    .prepare(
      `SELECT t.*, u.name, u.email FROM password_tokens t
       JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
    )
    .get(hashToken(token));
}

const setPasswordLink = (token) => `${APP_URL}/#/set-password/${token}`;

/** Generate an invite token + send the email. Returns {invite_sent, invite_link}. */
async function sendInvite(user, invitedBy, projectName) {
  const link = setPasswordLink(createPasswordToken(user.id, 'invite', 7 * 24));
  const { sent } = await sendMail({ to: user.email, ...inviteEmail({ name: user.name, link, invitedBy, projectName }) });
  return { invite_sent: sent, invite_link: link };
}

// Request a reset link. Always answers ok so addresses can't be probed.
api.post('/password/forgot', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!email) return bad(res, 'Email is required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const link = setPasswordLink(createPasswordToken(user.id, 'reset', 2));
    await sendMail({ to: user.email, ...resetEmail({ name: user.name, link }) });
  }
  res.json({ ok: true });
});

// Token preview so the set-password page can greet the user.
api.get('/password/token/:token', (req, res) => {
  const t = lookupPasswordToken(req.params.token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  res.json({ valid: true, name: t.name, email: t.email, purpose: t.purpose });
});

// Set a new password using a valid token (single use, signs out everywhere).
api.post('/password/reset', (req, res) => {
  const { token, password } = req.body ?? {};
  const t = token && lookupPasswordToken(token);
  if (!t) return bad(res, 'This link is invalid or has expired', 404);
  if (!password || String(password).length < 8) {
    return bad(res, 'Password must be at least 8 characters');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), t.user_id);
  db.prepare('DELETE FROM password_tokens WHERE user_id = ?').run(t.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(t.user_id);
  res.json({ ok: true });
});

api.use(requireAuth); // everything below requires a session

api.get('/me', (req, res) => {
  res.json({ user: req.user, projects: projectsFor(req.user) });
});

api.post('/me/password', (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password) return bad(res, 'Both passwords are required');
  if (String(new_password).length < 8) return bad(res, 'New password must be at least 8 characters');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current_password, row.password_hash)) {
    return bad(res, 'Current password is incorrect', 403);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(new_password),
    req.user.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM entries e WHERE e.project_id = ?) AS entry_count,
    (SELECT COUNT(*) FROM audio_files a JOIN entries e ON e.id = a.entry_id
      WHERE e.project_id = ?) AS audio_count,
    (SELECT COALESCE(SUM(a.duration_seconds), 0) FROM audio_files a
      JOIN entries e ON e.id = a.entry_id WHERE e.project_id = ?) AS audio_seconds
`);

api.get('/projects', (req, res) => {
  const projects = projectsFor(req.user).map((p) => ({
    ...p,
    ...projectStats.get(p.id, p.id, p.id),
  }));
  res.json({ projects });
});

api.post('/projects', requireSuperadmin, (req, res) => {
  const { name, dialect, description } = req.body ?? {};
  if (!name || !String(name).trim()) return bad(res, 'Project name is required');
  try {
    const info = db
      .prepare('INSERT INTO projects (name, dialect, description) VALUES (?, ?, ?)')
      .run(String(name).trim(), dialect || null, description || null);
    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'A project with that name already exists');
    throw e;
  }
});

api.patch('/projects/:id', requireSuperadmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return bad(res, 'Project not found', 404);
  const { name, dialect, description } = req.body ?? {};
  try {
    db.prepare('UPDATE projects SET name = ?, dialect = ?, description = ? WHERE id = ?').run(
      name?.trim() || project.name,
      dialect !== undefined ? (dialect?.trim() || null) : project.dialect,
      description !== undefined ? (description?.trim() || null) : project.description,
      project.id
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'A project with that name already exists');
    throw e;
  }
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
});

// Permanently delete a project with all entries, recordings, and memberships.
// Requires the exact project name as confirmation.
api.delete('/projects/:id', requireSuperadmin, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return bad(res, 'Project not found', 404);
  const { confirm_name } = req.body ?? {};
  if (confirm_name !== project.name) {
    return bad(res, 'Type the exact project name to confirm deletion');
  }

  const files = db
    .prepare(
      `SELECT a.stored_name FROM audio_files a
       JOIN entries e ON e.id = a.entry_id WHERE e.project_id = ?`
    )
    .all(project.id);
  let deletedEntries = 0;
  db.transaction(() => {
    // audio_files rows cascade from entries; memberships cascade from projects
    deletedEntries = db.prepare('DELETE FROM entries WHERE project_id = ?').run(project.id).changes;
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  })();
  for (const f of files) {
    fs.rm(path.join(AUDIO_DIR, f.stored_name), { force: true }, () => {});
  }
  res.json({ ok: true, deleted_entries: deletedEntries, deleted_recordings: files.length });
});

function requireProjectAdmin(req, res, next) {
  const projectId = Number(req.params.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return bad(res, 'Project not found', 404);
  if (roleIn(req.user, projectId) !== 'admin') {
    return bad(res, 'Project admin access required', 403);
  }
  req.project = project;
  next();
}

// ---------------------------------------------------------------------------
// Membership management
// ---------------------------------------------------------------------------

api.get('/projects/:id/members', requireProjectAdmin, (req, res) => {
  const members = db
    .prepare(
      `SELECT u.id, u.email, u.name, m.role, m.created_at,
              (SELECT COUNT(*) FROM entries e WHERE e.project_id = m.project_id AND e.created_by = u.id) AS entry_count
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ?
       ORDER BY m.role, u.name`
    )
    .all(req.project.id);
  res.json({ members });
});

// Add a member: existing user by email, or create a new account. With no
// password, the new account gets an invite email with a set-password link.
api.post('/projects/:id/members', requireProjectAdmin, async (req, res) => {
  const { email, name, password, role } = req.body ?? {};
  if (!email || !String(email).trim()) return bad(res, 'Email is required');
  const memberRole = role === 'admin' ? 'admin' : 'member';
  if (memberRole === 'admin' && !req.user.is_superadmin) {
    return bad(res, 'Only the superadmin can assign project admins', 403);
  }

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  let invite = null;
  if (!user) {
    if (!name) {
      return bad(res, 'No account with that email — provide a name to create one');
    }
    if (password !== undefined && String(password).length < 8) {
      return bad(res, 'Password must be at least 8 characters');
    }
    // No password -> locked placeholder; invite email carries a set-password link.
    const hash = hashPassword(password ?? crypto.randomBytes(32).toString('hex'));
    const info = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(String(email).trim(), String(name).trim(), hash);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    if (password === undefined) {
      invite = await sendInvite(user, req.user.name, req.project.name);
    }
  }

  const existing = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND project_id = ?')
    .get(user.id, req.project.id);
  if (existing) {
    if (existing.role === memberRole) return bad(res, 'Already a member of this project');
    if (!req.user.is_superadmin) return bad(res, 'Only the superadmin can change roles', 403);
    db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND project_id = ?').run(
      memberRole, user.id, req.project.id
    );
  } else {
    db.prepare('INSERT INTO memberships (user_id, project_id, role) VALUES (?, ?, ?)').run(
      user.id, req.project.id, memberRole
    );
  }
  res.status(201).json({ ok: true, user_id: user.id, ...(invite ?? {}) });
});

api.delete('/projects/:id/members/:userId', requireProjectAdmin, (req, res) => {
  const membership = db
    .prepare('SELECT * FROM memberships WHERE user_id = ? AND project_id = ?')
    .get(req.params.userId, req.project.id);
  if (!membership) return bad(res, 'Not a member of this project', 404);
  if (membership.role === 'admin' && !req.user.is_superadmin) {
    return bad(res, 'Only the superadmin can remove a project admin', 403);
  }
  // Membership is removed; sessions stay valid but every request re-checks
  // membership, so access to this project's data ends immediately. Past
  // contributions keep their created_by attribution.
  db.prepare('DELETE FROM memberships WHERE user_id = ? AND project_id = ?').run(
    req.params.userId, req.project.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// User management (superadmin)
// ---------------------------------------------------------------------------

api.get('/users', requireSuperadmin, (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_superadmin, u.created_at,
              (SELECT COUNT(*) FROM entries e WHERE e.created_by = u.id) AS entry_count,
              (SELECT COUNT(*) FROM audio_files a WHERE a.uploaded_by = u.id) AS audio_count,
              (SELECT group_concat(p.name || CASE m.role WHEN 'admin' THEN ' (admin)' ELSE '' END, ', ')
                 FROM memberships m JOIN projects p ON p.id = m.project_id
                 WHERE m.user_id = u.id) AS memberships
       FROM users u ORDER BY u.is_superadmin DESC, u.name`
    )
    .all();
  res.json({ users });
});

// Create an account without any project membership. If no password is given,
// the account is created locked and an invite email with a set-password link
// is sent instead.
api.post('/users', requireSuperadmin, async (req, res) => {
  const { email, name, password } = req.body ?? {};
  if (!email?.trim() || !name?.trim()) {
    return bad(res, 'Email and name are required');
  }
  if (password !== undefined && String(password).length < 8) {
    return bad(res, 'Password must be at least 8 characters');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim())) {
    return bad(res, 'An account with that email already exists');
  }
  // No password -> unguessable placeholder; the invite link sets the real one.
  const hash = hashPassword(password ?? crypto.randomBytes(32).toString('hex'));
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
    .run(email.trim(), name.trim(), hash);
  const out = { ok: true, user_id: info.lastInsertRowid };
  if (password === undefined) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    Object.assign(out, await sendInvite(user, req.user.name, null));
  }
  res.status(201).json(out);
});

// Edit name, reset password, or grant/revoke superadmin.
api.patch('/users/:id', requireSuperadmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return bad(res, 'User not found', 404);
  const { name, password, is_superadmin } = req.body ?? {};
  if (name !== undefined && !name.trim()) return bad(res, 'Name cannot be empty');
  if (password !== undefined && String(password).length < 8) {
    return bad(res, 'Password must be at least 8 characters');
  }
  if (is_superadmin !== undefined && user.id === req.user.id && !is_superadmin) {
    return bad(res, 'You cannot remove your own superadmin access');
  }
  db.prepare('UPDATE users SET name = ?, password_hash = ?, is_superadmin = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : user.name,
    password !== undefined ? hashPassword(password) : user.password_hash,
    is_superadmin !== undefined ? (is_superadmin ? 1 : 0) : user.is_superadmin,
    user.id
  );
  if (password !== undefined) {
    // a password reset signs the user out everywhere
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }
  res.json({ ok: true });
});

api.delete('/users/:id', requireSuperadmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return bad(res, 'User not found', 404);
  if (user.id === req.user.id) return bad(res, 'You cannot delete your own account');
  const contributions =
    db.prepare('SELECT COUNT(*) AS n FROM entries WHERE created_by = ? OR updated_by = ?')
      .get(user.id, user.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM audio_files WHERE uploaded_by = ?').get(user.id).n;
  if (contributions > 0) {
    return bad(
      res,
      'This user has contributions, so the account cannot be deleted (attribution must be preserved). Remove them from their projects instead — they will lose all access.'
    );
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // memberships/sessions cascade
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dashboard / stats
// ---------------------------------------------------------------------------

api.get('/projects/:id/stats', (req, res) => {
  const projectId = Number(req.params.id);
  if (!roleIn(req.user, projectId)) return bad(res, 'Not a member of this project', 403);
  const stats = projectStats.get(projectId, projectId, projectId);
  const recent = db
    .prepare(
      `SELECT e.id, e.dene_text, e.english_text, e.updated_at, u.name AS updated_by_name
       FROM entries e JOIN users u ON u.id = e.updated_by
       WHERE e.project_id = ? ORDER BY e.updated_at DESC, e.id DESC LIMIT 10`
    )
    .all(projectId);
  const contributors = db
    .prepare(
      `SELECT u.id, u.name, COUNT(*) AS entry_count
       FROM entries e JOIN users u ON u.id = e.created_by
       WHERE e.project_id = ? GROUP BY u.id ORDER BY entry_count DESC`
    )
    .all(projectId);
  res.json({ ...stats, recent, contributors });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

// Audio visibility: every member of a project can see and play all recordings
// on that project's entries. Editing/deleting a recording remains restricted
// to its uploader or a project admin.
const entrySelect = `
  SELECT e.*, p.name AS project_name, p.dialect,
         cu.name AS created_by_name, uu.name AS updated_by_name,
         (SELECT COUNT(*) FROM audio_files a WHERE a.entry_id = e.id) AS audio_count,
         (SELECT COALESCE(SUM(a.duration_seconds), 0) FROM audio_files a
            WHERE a.entry_id = e.id) AS audio_seconds
  FROM entries e
  JOIN projects p ON p.id = e.project_id
  JOIN users cu ON cu.id = e.created_by
  JOIN users uu ON uu.id = e.updated_by
`;

// Positional params consumed by entrySelect, in SQL text order.
const entryParams = () => [];

api.get('/entries', (req, res) => {
  const visible = projectIdsFor(req.user);
  if (visible.length === 0) return res.json({ entries: [], total: 0 });

  const where = [];
  const params = [];

  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  if (projectId) {
    if (!visible.includes(projectId)) return bad(res, 'Not a member of this project', 403);
    where.push('e.project_id = ?');
    params.push(projectId);
  } else {
    where.push(`e.project_id IN (${visible.map(() => '?').join(',')})`);
    params.push(...visible);
  }

  if (req.query.q) {
    const like = `%${String(req.query.q).trim()}%`;
    where.push('(e.dene_text LIKE ? OR e.english_text LIKE ? OR e.source_doc LIKE ? OR e.notes LIKE ? OR e.category LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (req.query.contributor) {
    where.push('e.created_by = ?');
    params.push(Number(req.query.contributor));
  }
  // All project members can see every recording.
  if (req.query.has_audio === 'yes') {
    where.push('EXISTS (SELECT 1 FROM audio_files a WHERE a.entry_id = e.id)');
  } else if (req.query.has_audio === 'no') {
    where.push('NOT EXISTS (SELECT 1 FROM audio_files a WHERE a.entry_id = e.id)');
  }
  if (req.query.status) {
    where.push('e.status = ?');
    params.push(String(req.query.status));
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM entries e ${whereSql}`)
    .get(...params).n;

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const entries = db
    .prepare(`${entrySelect} ${whereSql} ORDER BY e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...entryParams(req.user), ...params, limit, offset);

  res.json({ entries, total, limit, offset });
});

function loadEntry(req, res, next) {
  const entry = db
    .prepare(`${entrySelect} WHERE e.id = ?`)
    .get(...entryParams(req.user), req.params.id);
  if (!entry) return bad(res, 'Entry not found', 404);
  const role = roleIn(req.user, entry.project_id);
  if (!role) return bad(res, 'Not a member of this project', 403);
  req.entry = entry;
  req.projectRole = role;
  next();
}

const canEditEntry = (req) =>
  req.projectRole === 'admin' || req.entry.created_by === req.user.id;

api.post('/entries', (req, res) => {
  const { project_id, dene_text, english_text, source_doc, notes, category } = req.body ?? {};
  const projectId = Number(project_id);
  if (!projectId || !roleIn(req.user, projectId)) {
    return bad(res, 'You are not a member of that project', 403);
  }
  if (!dene_text?.trim() || !english_text?.trim()) {
    return bad(res, 'Both Dene text and English text are required');
  }
  const info = db
    .prepare(
      `INSERT INTO entries (project_id, dene_text, english_text, source_doc, notes, category, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, dene_text.trim(), english_text.trim(), source_doc?.trim() || null,
         notes?.trim() || null, category?.trim() || null, req.user.id, req.user.id);
  const entry = db
    .prepare(`${entrySelect} WHERE e.id = ?`)
    .get(...entryParams(req.user), info.lastInsertRowid);
  res.status(201).json(entry);
});

api.get('/entries/:id', loadEntry, (req, res) => {
  // All project members see every recording.
  const audio = db
    .prepare(
      `SELECT a.*, u.name AS uploaded_by_name FROM audio_files a
       JOIN users u ON u.id = a.uploaded_by
       WHERE a.entry_id = ?
       ORDER BY a.language, a.created_at`
    )
    .all(req.entry.id);
  res.json({ ...req.entry, audio, can_edit: canEditEntry(req), role: req.projectRole });
});

api.patch('/entries/:id', loadEntry, (req, res) => {
  if (!canEditEntry(req)) return bad(res, 'You can only edit your own entries', 403);
  const { dene_text, english_text, source_doc, notes, category, status } = req.body ?? {};
  if (dene_text !== undefined && !dene_text.trim()) return bad(res, 'Dene text cannot be empty');
  if (english_text !== undefined && !english_text.trim()) return bad(res, 'English text cannot be empty');
  if (status !== undefined) {
    if (req.projectRole !== 'admin') return bad(res, 'Only project admins can change review status', 403);
    if (!['draft', 'reviewed', 'verified'].includes(status)) return bad(res, 'Invalid status');
  }
  db.prepare(
    `UPDATE entries SET
       dene_text = ?, english_text = ?, source_doc = ?, notes = ?, category = ?, status = ?,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    dene_text !== undefined ? dene_text.trim() : req.entry.dene_text,
    english_text !== undefined ? english_text.trim() : req.entry.english_text,
    source_doc !== undefined ? (source_doc?.trim() || null) : req.entry.source_doc,
    notes !== undefined ? (notes?.trim() || null) : req.entry.notes,
    category !== undefined ? (category?.trim() || null) : req.entry.category,
    status !== undefined ? status : req.entry.status,
    req.user.id,
    req.entry.id
  );
  res.json(
    db.prepare(`${entrySelect} WHERE e.id = ?`).get(...entryParams(req.user), req.entry.id)
  );
});

api.delete('/entries/:id', loadEntry, (req, res) => {
  if (!canEditEntry(req)) return bad(res, 'You can only delete your own entries', 403);
  const files = db.prepare('SELECT stored_name FROM audio_files WHERE entry_id = ?').all(req.entry.id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.entry.id);
  for (const f of files) {
    fs.rm(path.join(AUDIO_DIR, f.stored_name), { force: true }, () => {});
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Audio attachments
// ---------------------------------------------------------------------------

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a']);
const MAX_AUDIO_BYTES = 500 * 1024 * 1024; // 500 MB

const upload = multer({
  storage: multer.diskStorage({
    // Files are organized per uploader: data/audio/<userID>/<file>
    destination: (req, file, cb) => {
      const dir = path.join(AUDIO_DIR, String(req.user.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) {
      return cb(new Error('Unsupported audio format — use WAV, MP3, or M4A'));
    }
    cb(null, true);
  },
});

// Single-file upload with friendly multer error messages.
function audioUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large (max 500 MB)'
          : err.message || 'Upload failed';
      return bad(res, msg);
    }
    next();
  });
}

async function probeAudio(filePath) {
  const meta = await parseFile(filePath);
  const duration = meta.format.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    throw new Error('no duration');
  }
  return duration;
}

// Upsert: each user has at most one recording per language per entry, so a new
// upload for the same language replaces their previous one.
api.post('/entries/:id/audio', loadEntry, audioUpload, async (req, res) => {
  if (!req.file) return bad(res, 'No audio file provided');
  const filePath = req.file.path;
  const language = req.body.language === 'english' ? 'english' : 'dene';
  let duration;
  try {
    duration = await probeAudio(filePath);
  } catch {
    fs.rm(filePath, { force: true }, () => {});
    return bad(res, 'Could not read that audio file — it may be corrupt or in an unsupported format. The entry was not changed.');
  }

  const storedName = `${req.user.id}/${req.file.filename}`;
  const mime = req.file.mimetype || 'application/octet-stream';
  const speaker = req.body.speaker?.trim() || null;
  const notes = req.body.recording_notes?.trim() || null;

  const existing = db
    .prepare('SELECT * FROM audio_files WHERE entry_id = ? AND uploaded_by = ? AND language = ?')
    .get(req.entry.id, req.user.id, language);

  let id;
  if (existing) {
    db.prepare(
      `UPDATE audio_files SET stored_name = ?, original_name = ?, mime_type = ?,
         size_bytes = ?, duration_seconds = ?, speaker = ?, recording_notes = ?,
         created_at = datetime('now')
       WHERE id = ?`
    ).run(storedName, req.file.originalname, mime, req.file.size, duration,
          speaker ?? existing.speaker, notes ?? existing.recording_notes, existing.id);
    fs.rm(path.join(AUDIO_DIR, existing.stored_name), { force: true }, () => {});
    id = existing.id;
  } else {
    id = db
      .prepare(
        `INSERT INTO audio_files
           (entry_id, stored_name, original_name, mime_type, size_bytes, duration_seconds,
            language, speaker, recording_notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.entry.id, storedName, req.file.originalname, mime, req.file.size,
           duration, language, speaker, notes, req.user.id).lastInsertRowid;
  }
  res.status(existing ? 200 : 201)
    .json({ ...db.prepare('SELECT * FROM audio_files WHERE id = ?').get(id), replaced: !!existing });
});

function loadAudio(req, res, next) {
  const audio = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.params.id);
  if (!audio) return bad(res, 'Audio file not found', 404);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(audio.entry_id);
  const role = roleIn(req.user, entry.project_id);
  if (!role) return bad(res, 'Not a member of this project', 403);
  req.audio = audio;
  req.audioRole = role;
  next();
}

api.get('/audio/:id/stream', loadAudio, (req, res) => {
  // Any member of the entry's project can listen (loadAudio enforces membership).
  res.sendFile(path.join(AUDIO_DIR, req.audio.stored_name), {
    headers: {
      'Content-Type': req.audio.mime_type,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(req.audio.original_name)}`,
    },
  });
});

api.patch('/audio/:id', loadAudio, (req, res) => {
  if (req.audioRole !== 'admin' && req.audio.uploaded_by !== req.user.id) {
    return bad(res, 'You can only edit audio you uploaded', 403);
  }
  const { speaker, recording_notes } = req.body ?? {};
  db.prepare('UPDATE audio_files SET speaker = ?, recording_notes = ? WHERE id = ?').run(
    speaker !== undefined ? (speaker?.trim() || null) : req.audio.speaker,
    recording_notes !== undefined ? (recording_notes?.trim() || null) : req.audio.recording_notes,
    req.audio.id
  );
  res.json(db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.audio.id));
});

api.delete('/audio/:id', loadAudio, (req, res) => {
  if (req.audioRole !== 'admin' && req.audio.uploaded_by !== req.user.id) {
    return bad(res, 'You can only delete audio you uploaded', 403);
  }
  db.prepare('DELETE FROM audio_files WHERE id = ?').run(req.audio.id);
  fs.rm(path.join(AUDIO_DIR, req.audio.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Export (P1-2): CSV / JSON with audio file references
// ---------------------------------------------------------------------------

api.get('/projects/:id/export', requireProjectAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.id, e.dene_text, e.english_text, e.source_doc, e.notes, e.category, e.status,
              cu.name AS contributor, e.created_at, e.updated_at
       FROM entries e JOIN users cu ON cu.id = e.created_by
       WHERE e.project_id = ? ORDER BY e.id`
    )
    .all(req.project.id);
  const audioByEntry = new Map();
  for (const a of db
    .prepare(
      `SELECT a.entry_id, a.stored_name, a.original_name, a.duration_seconds, a.language, a.speaker
       FROM audio_files a JOIN entries e ON e.id = a.entry_id WHERE e.project_id = ?`
    )
    .all(req.project.id)) {
    if (!audioByEntry.has(a.entry_id)) audioByEntry.set(a.entry_id, []);
    audioByEntry.get(a.entry_id).push({
      file: `audio/${a.stored_name}`,
      original_name: a.original_name,
      duration_seconds: a.duration_seconds,
      language: a.language,
      speaker: a.speaker,
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${req.project.name.replace(/[^\w-]+/g, '_')}_${stamp}`;

  if (req.query.format === 'csv') {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'entry_id,dene_text,english_text,category,source_doc,notes,status,contributor,created_at,updated_at,dene_audio_files,english_audio_files,audio_duration_seconds\n';
    const lines = rows.map((r) => {
      const audio = audioByEntry.get(r.id) ?? [];
      return [
        r.id, r.dene_text, r.english_text, r.category, r.source_doc, r.notes, r.status,
        r.contributor, r.created_at, r.updated_at,
        audio.filter((a) => a.language === 'dene').map((a) => a.file).join(';'),
        audio.filter((a) => a.language === 'english').map((a) => a.file).join(';'),
        audio.reduce((s, a) => s + a.duration_seconds, 0).toFixed(2),
      ].map(esc).join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    // BOM so Excel opens Dene characters correctly
    return res.send('\uFEFF' + header + lines.join('\n') + '\n');
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
  res.json({
    project: { id: req.project.id, name: req.project.name, dialect: req.project.dialect },
    exported_at: new Date().toISOString(),
    entries: rows.map((r) => ({ ...r, audio: audioByEntry.get(r.id) ?? [] })),
  });
});

// ---------------------------------------------------------------------------
// Bulk import (P1-4): superadmin-only CSV of Dene/English text pairs
// ---------------------------------------------------------------------------

// Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv' && ext !== '.txt') return cb(new Error('Upload a .csv file'));
    cb(null, true);
  },
});

const MAX_IMPORT_ROWS = 10000;

api.post('/projects/:id/import', requireSuperadmin, (req, res, next) => {
  csvUpload.single('file')(req, res, (err) => {
    if (err) {
      return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 10 MB)' : err.message);
    }
    next();
  });
}, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return bad(res, 'Project not found', 404);
  if (!req.file) return bad(res, 'No CSV file provided');

  const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return bad(res, 'The CSV file is empty');

  // Find the Dene and English columns from the header row; if there is no
  // recognizable header, assume column 1 = Dene, column 2 = English.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const header = rows[0].map(norm);
  let deneIdx = header.findIndex((h) => h.includes('dene'));
  let engIdx = header.findIndex((h) => h.includes('english') || h === 'eng');
  let catIdx = header.findIndex((h) => h.includes('categor'));
  let dataRows;
  if (deneIdx >= 0 && engIdx >= 0) {
    dataRows = rows.slice(1);
  } else if (rows[0].length >= 2) {
    deneIdx = 0;
    engIdx = 1;
    catIdx = 2; // optional third column
    dataRows = rows;
  } else {
    return bad(res, 'Could not find Dene and English columns — use a header row like "dene_text,english_text" or a two-column file (Dene first, English second)');
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return bad(res, `Too many rows (${dataRows.length}) — max ${MAX_IMPORT_ROWS} per import. Split the file and try again.`);
  }

  // Idempotent: skip pairs that already exist in the project, and duplicates
  // within the file itself.
  const seen = new Set(
    db.prepare('SELECT dene_text, english_text FROM entries WHERE project_id = ?')
      .all(project.id)
      .map((e) => JSON.stringify([e.dene_text, e.english_text]))
  );
  const sourceDoc = `CSV import: ${req.file.originalname}`;
  const insert = db.prepare(
    `INSERT INTO entries (project_id, dene_text, english_text, category, source_doc, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let imported = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  db.transaction(() => {
    for (const r of dataRows) {
      const dene = (r[deneIdx] ?? '').trim();
      const english = (r[engIdx] ?? '').trim();
      const category = catIdx >= 0 ? (r[catIdx] ?? '').trim() || null : null;
      if (!dene || !english) { skippedInvalid++; continue; }
      const key = JSON.stringify([dene, english]);
      if (seen.has(key)) { skippedDuplicates++; continue; }
      seen.add(key);
      insert.run(project.id, dene, english, category, sourceDoc, req.user.id, req.user.id);
      imported++;
    }
  })();

  res.json({
    ok: true,
    imported,
    skipped_duplicates: skippedDuplicates,
    skipped_invalid: skippedInvalid,
    total_rows: dataRows.length,
  });
});

// ---------------------------------------------------------------------------

api.use((req, res) => bad(res, 'Not found', 404));

// JSON error handler so API errors never return HTML.
api.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  bad(res, 'Internal server error', 500);
});

export default api;
