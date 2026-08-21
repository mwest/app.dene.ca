import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';

import db, { AUDIO_DIR, REQUESTS_DIR, roleIn, projectsFor, projectIdsFor, orgRole, orgsFor } from './db.js';
import { embed, toBlob, fromBlob, cosine, MODEL } from './embed.js';
import { MASTERS_DIR, DERIVED_DIR, probeAudio, enqueueDerivative, sha256File } from './audio.js';
import { createRequire } from 'node:module';
import { backfillEmbeddings } from '../scripts/embed-backfill.js';
import { APP_URL, inviteEmail, requestFormEmail, requestNotifyEmail, resetEmail, sendMail } from './mail.js';
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

// archiver is CommonJS (classic factory API); pkg version goes in the export manifest.
const cjsRequire = createRequire(import.meta.url);
const archiver = cjsRequire('archiver');
const pkg = cjsRequire('../package.json');

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Light in-memory rate limit; protects the public, unauthenticated endpoints
// (login brute force, and the email-sending request/reset flows).
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { rateBuckets.set(key, hits); return true; }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

api.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return bad(res, 'Email and password are required');
  // The per-EMAIL cap is the real brute-force defense: it bounds guesses against
  // any single account regardless of source. The per-IP cap only guards against
  // one host hammering many accounts, so it's set generously — community users
  // often share one public IP (a school or band office signing in together), and
  // a tight per-IP cap would lock the whole room out during group onboarding.
  if (rateLimited(`login-email:${String(email).trim().toLowerCase()}`, 10, 15 * 60 * 1000) ||
      rateLimited(`login-ip:${req.ip}`, 100, 15 * 60 * 1000)) {
    return bad(res, 'Too many sign-in attempts — please try again later', 429);
  }
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
  // The per-EMAIL cap prevents reset-email bombing of a known address (and the
  // Resend cost that comes with it) — that's the real abuse to stop, so it stays
  // tight. The per-IP cap is only shared-host collateral protection, so it's set
  // generously to avoid locking out a shared office/school connection. Still
  // answers ok below so addresses can't be probed.
  if (rateLimited(`forgot-email:${email.toLowerCase()}`, 3, 60 * 60 * 1000) ||
      rateLimited(`forgot-ip:${req.ip}`, 50, 60 * 60 * 1000)) {
    return res.json({ ok: true });
  }
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

// ---------------------------------------------------------------------------
// Public translation requests — email -> tokened form -> superadmin inbox
// ---------------------------------------------------------------------------

const REQUEST_LINK_HOURS = 7 * 24;

const pruneExpiredRequests = () =>
  db.prepare(
    `DELETE FROM translation_requests WHERE status = 'invited' AND expires_at < datetime('now')`
  ).run();

// Step 1: requester enters their email and gets a unique form link.
api.post('/requests/start', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'A valid email is required');
  if (rateLimited(`req-ip:${req.ip}`, 30, 60 * 60 * 1000) ||
      rateLimited(`req-email:${email.toLowerCase()}`, 3, 60 * 60 * 1000)) {
    return bad(res, 'Too many requests — please try again later', 429);
  }
  pruneExpiredRequests();
  const token = crypto.randomBytes(32).toString('hex');
  // A repeat ask from the same email refreshes the pending link instead of
  // piling up rows.
  const existing = db
    .prepare(`SELECT id FROM translation_requests WHERE email = ? AND status = 'invited'`)
    .get(email);
  if (existing) {
    db.prepare(
      `UPDATE translation_requests SET token_hash = ?,
         expires_at = datetime('now', '+${REQUEST_LINK_HOURS} hours') WHERE id = ?`
    ).run(hashToken(token), existing.id);
  } else {
    db.prepare(
      `INSERT INTO translation_requests (token_hash, email, expires_at)
       VALUES (?, ?, datetime('now', '+${REQUEST_LINK_HOURS} hours'))`
    ).run(hashToken(token), email);
  }
  const link = `${APP_URL}/#/request/${token}`;
  const { sent } = await sendMail({ to: email, ...requestFormEmail({ link }) });
  const out = { ok: true, sent };
  if (process.env.NODE_ENV !== 'production') out.form_link = link; // dev/test convenience
  res.json(out);
});

function loadRequestByToken(req, res, next) {
  if (!/^[a-f0-9]{64}$/.test(String(req.params.token))) {
    return bad(res, 'This link is invalid or has expired', 404);
  }
  const row = db
    .prepare(
      `SELECT * FROM translation_requests WHERE token_hash = ?
         AND (status = 'submitted' OR expires_at >= datetime('now'))`
    )
    .get(hashToken(req.params.token));
  if (!row) return bad(res, 'This link is invalid or has expired', 404);
  req.request = row;
  next();
}

// Step 2a: the form page loads its state (email is fixed server-side).
api.get('/requests/form/:token', loadRequestByToken, (req, res) => {
  const { email, name, dialect, details, status } = req.request;
  res.json({ email, name, dialect, details, status });
});

const REQUEST_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.rtf', '.csv', '.xlsx',
  '.jpg', '.jpeg', '.png', '.heic',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.zip',
]);
const MAX_REQUEST_FILE_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_FILES = 5;

const requestUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(REQUESTS_DIR, String(req.request.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) =>
      cb(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_REQUEST_FILE_BYTES, files: MAX_REQUEST_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!REQUEST_EXTS.has(ext)) {
      return cb(new Error(`Unsupported file type (${ext || 'no extension'})`));
    }
    cb(null, true);
  },
});

// Step 2b: submit the form (multipart, up to 5 files), then notify superadmins.
api.post('/requests/form/:token', loadRequestByToken, (req, res, next) => {
  if (req.request.status === 'submitted') {
    return bad(res, 'This request has already been submitted');
  }
  requestUpload.array('files', MAX_REQUEST_FILES)(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 100 MB'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `You can attach at most ${MAX_REQUEST_FILES} files`
        : err.message || 'Upload failed';
      return bad(res, msg);
    }
    next();
  });
}, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const dialect = String(req.body?.dialect ?? '').trim();
  const details = String(req.body?.details ?? '').trim();
  if (!name || !dialect || !details) {
    for (const f of req.files ?? []) fs.rm(f.path, { force: true }, () => {});
    return bad(res, 'Name, dialect, and request details are required');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE translation_requests SET name = ?, dialect = ?, details = ?,
         status = 'submitted', submitted_at = datetime('now') WHERE id = ?`
    ).run(name, dialect, details, req.request.id);
    const ins = db.prepare(
      `INSERT INTO request_files (request_id, stored_name, original_name, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const f of req.files ?? []) {
      ins.run(req.request.id, `${req.request.id}/${f.filename}`, f.originalname,
              f.mimetype || 'application/octet-stream', f.size);
    }
  })();

  const mail = requestNotifyEmail({
    name, email: req.request.email, dialect, details,
    fileCount: (req.files ?? []).length,
    link: `${APP_URL}/#/jobs/${req.request.id}`,
  });
  for (const admin of db.prepare('SELECT email FROM users WHERE is_superadmin = 1').all()) {
    await sendMail({ to: admin.email, ...mail });
  }
  res.json({ ok: true });
});

api.use(requireAuth); // everything below requires a session

api.get('/me', (req, res) => {
  res.json({ user: req.user, projects: projectsFor(req.user), orgs: orgsFor(req.user) });
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

// Change your own display name.
api.post('/me/name', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return bad(res, 'Name is required');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, name });
});

// ---------------------------------------------------------------------------
// Organizations (#5) — the explicit data owner. Platform administration
// (is_superadmin) is provisioning and account support only; corpus authority
// flows from organization roles.
// ---------------------------------------------------------------------------

const isOrgAdmin = (user, orgId) => ['owner_admin', 'admin'].includes(orgRole(user, orgId));

/** Middleware: :id names a project; caller must be an admin of its OWNING ORG
 *  (project-level admins manage members and review, not project lifecycle). */
function requireOrgAdminOfProject(req, res, next) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!project) return bad(res, 'Project not found', 404);
  if (!project.organization_id || !isOrgAdmin(req.user, project.organization_id)) {
    return bad(res, 'Organization admin access required', 403);
  }
  req.project = project;
  next();
}

/** IDs of orgs where the caller holds admin authority. */
const adminOrgIdsFor = (user) =>
  orgsFor(user).filter((o) => o.role === 'owner_admin' || o.role === 'admin').map((o) => o.id);

api.get('/orgs', (req, res) => {
  res.json({ orgs: orgsFor(req.user) });
});

// Provisioning (platform): create an organization. The creator — or, if given,
// an existing user named by owner_email — becomes its owner_admin.
api.post('/orgs', requireSuperadmin, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return bad(res, 'Organization name is required');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
  let owner = req.user;
  if (req.body?.owner_email) {
    owner = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.owner_email).trim());
    if (!owner) return bad(res, 'No account with that owner email');
  }
  try {
    const info = db.transaction(() => {
      const i = db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)').run(name, slug);
      db.prepare('INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (?, ?, ?)')
        .run(i.lastInsertRowid, owner.id, 'owner_admin');
      return i;
    })();
    res.status(201).json(db.prepare('SELECT * FROM organizations WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'An organization with that name already exists');
    throw e;
  }
});

api.patch('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (orgRole(req.user, org.id) !== 'owner_admin') return bad(res, 'Organization owner access required', 403);
  const name = String(req.body?.name ?? '').trim();
  if (!name) return bad(res, 'Organization name is required');
  db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, org.id);
  res.json(db.prepare('SELECT * FROM organizations WHERE id = ?').get(org.id));
});

api.get('/orgs/:id/members', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (!isOrgAdmin(req.user, org.id)) return bad(res, 'Organization admin access required', 403);
  const members = db
    .prepare(
      `SELECT u.id, u.email, u.name, om.role, om.created_at
       FROM organization_memberships om JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = ? ORDER BY om.role, u.name`
    )
    .all(org.id);
  res.json({ org: { id: org.id, name: org.name }, members });
});

// Add or change an org member (existing accounts only — account creation stays a
// platform/user-management concern). Only owner_admins manage org roles.
api.post('/orgs/:id/members', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (orgRole(req.user, org.id) !== 'owner_admin') return bad(res, 'Organization owner access required', 403);
  const role = ['owner_admin', 'admin', 'member'].includes(req.body?.role) ? req.body.role : 'member';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body?.email ?? '').trim());
  if (!user) return bad(res, 'No account with that email — create the account first');
  // Never demote the last owner (including an owner demoting themselves).
  const existing = db
    .prepare('SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?')
    .get(org.id, user.id);
  if (existing?.role === 'owner_admin' && role !== 'owner_admin') {
    const owners = db
      .prepare(`SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = ? AND role = 'owner_admin'`)
      .get(org.id).n;
    if (owners <= 1) return bad(res, 'An organization must keep at least one owner');
  }
  db.prepare(
    `INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(org.id, user.id, role);
  res.status(201).json({ ok: true, user_id: user.id, role });
});

// Delete an EMPTY organization (owns no projects). Owner-only; memberships and
// consent profiles cascade. Financial history (work_log/payments) must outlive
// the org, so any rows attributed to it are detached to legacy (NULL org) —
// they remain visible to the contributor via /me, invisible to admin views.
api.delete('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (orgRole(req.user, org.id) !== 'owner_admin') return bad(res, 'Organization owner access required', 403);
  if (db.prepare('SELECT 1 FROM projects WHERE organization_id = ? LIMIT 1').get(org.id)) {
    return bad(res, 'This organization still owns projects — move or delete them first');
  }
  db.transaction(() => {
    db.prepare('UPDATE work_log SET organization_id = NULL WHERE organization_id = ?').run(org.id);
    db.prepare('UPDATE payments SET organization_id = NULL WHERE organization_id = ?').run(org.id);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(org.id);
  })();
  res.json({ ok: true });
});

api.delete('/orgs/:id/members/:userId', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (orgRole(req.user, org.id) !== 'owner_admin') return bad(res, 'Organization owner access required', 403);
  const target = db
    .prepare('SELECT * FROM organization_memberships WHERE organization_id = ? AND user_id = ?')
    .get(org.id, req.params.userId);
  if (!target) return bad(res, 'Not a member of this organization', 404);
  if (target.role === 'owner_admin') {
    const owners = db
      .prepare(`SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = ? AND role = 'owner_admin'`)
      .get(org.id).n;
    if (owners <= 1) return bad(res, 'An organization must keep at least one owner');
  }
  db.prepare('DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?')
    .run(org.id, req.params.userId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Consent profiles (#6) — org-owned bundles of permitted uses. Recordings carry
// an immutable snapshot; editing a profile never rewrites past consent.
// ---------------------------------------------------------------------------

const CONSENT_FLAGS = [
  'allow_language_learning', 'allow_asr_training', 'allow_tts_training',
  'allow_translation_model_training', 'allow_research', 'allow_commercial_use',
  'allow_redistribution',
];

api.get('/orgs/:id/consent-profiles', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (!isOrgAdmin(req.user, org.id)) return bad(res, 'Organization admin access required', 403);
  res.json({ profiles: db.prepare('SELECT * FROM consent_profiles WHERE organization_id = ? ORDER BY name').all(org.id) });
});

api.post('/orgs/:id/consent-profiles', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.params.id);
  if (!org) return bad(res, 'Organization not found', 404);
  if (!isOrgAdmin(req.user, org.id)) return bad(res, 'Organization admin access required', 403);
  const name = String(req.body?.name ?? '').trim();
  if (!name) return bad(res, 'Profile name is required');
  const flags = CONSENT_FLAGS.map((f) => (req.body?.[f] ? 1 : 0));
  try {
    const info = db.prepare(
      `INSERT INTO consent_profiles (organization_id, name, visibility, ${CONSENT_FLAGS.join(', ')}, notes, created_by)
       VALUES (?, ?, ?, ${CONSENT_FLAGS.map(() => '?').join(', ')}, ?, ?)`
    ).run(org.id, name, req.body?.visibility === 'public' ? 'public' : 'private',
          ...flags, req.body?.notes?.trim() || null, req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM consent_profiles WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'A profile with that name already exists in this organization');
    throw e;
  }
});

function loadConsentProfile(req, res, next) {
  const profile = db.prepare('SELECT * FROM consent_profiles WHERE id = ?').get(req.params.id);
  if (!profile) return bad(res, 'Consent profile not found', 404);
  if (!isOrgAdmin(req.user, profile.organization_id)) return bad(res, 'Organization admin access required', 403);
  req.consentProfile = profile;
  next();
}

api.patch('/consent-profiles/:id', loadConsentProfile, (req, res) => {
  const p = req.consentProfile;
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : p.name;
  if (!name) return bad(res, 'Profile name is required');
  const flags = CONSENT_FLAGS.map((f) => (req.body?.[f] !== undefined ? (req.body[f] ? 1 : 0) : p[f]));
  db.prepare(
    `UPDATE consent_profiles SET name = ?, visibility = ?, ${CONSENT_FLAGS.map((f) => `${f} = ?`).join(', ')}, notes = ?
     WHERE id = ?`
  ).run(name, req.body?.visibility === undefined ? p.visibility : (req.body.visibility === 'public' ? 'public' : 'private'),
        ...flags, req.body?.notes !== undefined ? (req.body.notes?.trim() || null) : p.notes, p.id);
  res.json(db.prepare('SELECT * FROM consent_profiles WHERE id = ?').get(p.id));
});

api.delete('/consent-profiles/:id', loadConsentProfile, (req, res) => {
  // Snapshots on recordings reference the profile only by NAME, so they are
  // untouched; clear project defaults that point at it before deleting.
  db.transaction(() => {
    db.prepare('UPDATE projects SET default_consent_profile_id = NULL WHERE default_consent_profile_id = ?')
      .run(req.consentProfile.id);
    db.prepare('DELETE FROM consent_profiles WHERE id = ?').run(req.consentProfile.id);
  })();
  res.json({ ok: true });
});

// Choose (or clear) the profile stamped onto NEW recordings in this project.
api.put('/projects/:id/consent-default', requireOrgAdminOfProject, (req, res) => {
  const profileId = req.body?.profile_id ? Number(req.body.profile_id) : null;
  if (profileId) {
    const profile = db.prepare('SELECT * FROM consent_profiles WHERE id = ?').get(profileId);
    if (!profile || profile.organization_id !== req.project.organization_id) {
      return bad(res, 'The profile must belong to the project’s organization');
    }
  }
  db.prepare('UPDATE projects SET default_consent_profile_id = ? WHERE id = ?').run(profileId, req.project.id);
  res.json({ ok: true, default_consent_profile_id: profileId });
});

// Bulk-assign a profile snapshot to this project's consent-UNKNOWN recordings
// (already-assigned and revoked recordings are never touched). One audit row per
// recording, all in one transaction.
api.post('/projects/:id/consent/assign', requireOrgAdminOfProject, (req, res) => {
  const profile = db.prepare('SELECT * FROM consent_profiles WHERE id = ?').get(Number(req.body?.profile_id));
  if (!profile || profile.organization_id !== req.project.organization_id) {
    return bad(res, 'A consent profile from the project’s organization is required');
  }
  const language = req.body?.language === 'dene' || req.body?.language === 'english' ? req.body.language : null;
  const targets = db
    .prepare(
      `SELECT a.id FROM audio_files a JOIN entries e ON e.id = a.entry_id
       WHERE e.project_id = ? AND a.consent_profile_name IS NULL AND a.revoked_at IS NULL
         ${language ? 'AND a.language = ?' : ''}`
    )
    .all(...(language ? [req.project.id, language] : [req.project.id]));
  const stamp = db.prepare(
    `UPDATE audio_files SET consent_profile_name = ?, ${CONSENT_FLAGS.map((f) => `${f} = ?`).join(', ')},
       consent_recorded_at = datetime('now'), consent_method = 'bulk_assign', consent_reference = ?
     WHERE id = ?`
  );
  const audit = db.prepare(
    `INSERT INTO consent_changes (audio_id, action, profile_name, note, changed_by) VALUES (?, 'assign', ?, ?, ?)`
  );
  const note = req.body?.note?.trim() || null;
  db.transaction(() => {
    for (const t of targets) {
      stamp.run(profile.name, ...CONSENT_FLAGS.map((f) => profile[f]), note, t.id);
      audit.run(t.id, profile.name, note, req.user.id);
    }
  })();
  res.json({ ok: true, assigned: targets.length, profile: profile.name });
});

// Consent snapshot for new recordings in a project (NULL = consent-unknown).
function consentSnapshotFor(projectId) {
  const row = db
    .prepare(
      `SELECT cp.* FROM projects p JOIN consent_profiles cp ON cp.id = p.default_consent_profile_id
       WHERE p.id = ?`
    )
    .get(projectId);
  if (!row) return null;
  const snap = { consent_profile_name: row.name, consent_method: 'project_default_profile' };
  for (const f of CONSENT_FLAGS) snap[f] = row[f];
  return snap;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM entries e WHERE e.project_id = ?) AS entry_count,
    (SELECT COUNT(*) FROM audio_files a JOIN entries e ON e.id = a.entry_id
      WHERE e.project_id = ? AND a.is_current = 1) AS audio_count,
    (SELECT COALESCE(SUM(a.duration_seconds), 0) FROM audio_files a
      JOIN entries e ON e.id = a.entry_id WHERE e.project_id = ? AND a.is_current = 1) AS audio_seconds
`);

api.get('/projects', (req, res) => {
  const projects = projectsFor(req.user).map((p) => ({
    ...p,
    ...projectStats.get(p.id, p.id, p.id),
  }));
  res.json({ projects });
});

// Create a project inside an organization the caller administers. With one org
// (the common case) organization_id can be omitted and defaults to it.
api.post('/projects', (req, res) => {
  const { name, dialect, description } = req.body ?? {};
  if (!name || !String(name).trim()) return bad(res, 'Project name is required');
  const adminOrgs = adminOrgIdsFor(req.user);
  let orgId = req.body?.organization_id ? Number(req.body.organization_id) : null;
  if (orgId) {
    if (!adminOrgs.includes(orgId)) return bad(res, 'Organization admin access required', 403);
  } else if (adminOrgs.length === 1) {
    orgId = adminOrgs[0];
  } else if (adminOrgs.length === 0) {
    return bad(res, 'Organization admin access required', 403);
  } else {
    return bad(res, 'You administer multiple organizations — specify organization_id');
  }
  try {
    const info = db
      .prepare('INSERT INTO projects (name, dialect, description, organization_id) VALUES (?, ?, ?, ?)')
      .run(String(name).trim(), dialect || null, description || null, orgId);
    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'A project with that name already exists');
    throw e;
  }
});

api.patch('/projects/:id', requireOrgAdminOfProject, (req, res) => {
  const project = req.project;
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
api.delete('/projects/:id', requireOrgAdminOfProject, (req, res) => {
  const project = req.project;
  const { confirm_name } = req.body ?? {};
  if (confirm_name !== project.name) {
    return bad(res, 'Type the exact project name to confirm deletion');
  }

  const files = db
    .prepare(
      `SELECT a.stored_name, a.playback_stored_name FROM audio_files a
       JOIN entries e ON e.id = a.entry_id WHERE e.project_id = ?`
    )
    .all(project.id);
  let deletedEntries = 0;
  db.transaction(() => {
    // audio_files rows cascade from entries; memberships cascade from projects
    deletedEntries = db.prepare('DELETE FROM entries WHERE project_id = ?').run(project.id).changes;
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  })();
  for (const f of files) rmAudioFiles(f); // remove every version's master + derivative
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
  const memberRole = ['admin', 'translator'].includes(role) ? role : 'member';
  if (memberRole === 'admin' && !isOrgAdmin(req.user, req.project.organization_id)) {
    return bad(res, 'Only an organization admin can assign project admins', 403);
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
    if ((existing.role === 'admin' || memberRole === 'admin') && !isOrgAdmin(req.user, req.project.organization_id)) {
      return bad(res, 'Only an organization admin can change admin roles', 403);
    }
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
  if (membership.role === 'admin' && !isOrgAdmin(req.user, req.project.organization_id)) {
    return bad(res, 'Only an organization admin can remove a project admin', 403);
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
              (SELECT COUNT(*) FROM audio_files a WHERE a.uploaded_by = u.id AND a.is_current = 1) AS audio_count,
              (SELECT group_concat(p.name || ' (' ||
                        CASE m.role WHEN 'admin' THEN 'Project admin'
                                    WHEN 'translator' THEN 'Translator'
                                    ELSE 'Member' END || ')', ', ')
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
    db.prepare('SELECT COUNT(*) AS n FROM audio_files WHERE uploaded_by = ? AND is_current = 1').get(user.id).n;
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
// Translation jobs (superadmin) — review submitted public requests
// ---------------------------------------------------------------------------

api.get('/requests', requireSuperadmin, (req, res) => {
  pruneExpiredRequests();
  const requests = db
    .prepare(
      `SELECT r.id, r.email, r.name, r.dialect, r.status, r.submitted_at, r.created_at,
              (SELECT COUNT(*) FROM request_files f WHERE f.request_id = r.id) AS file_count
       FROM translation_requests r
       ORDER BY COALESCE(r.submitted_at, r.created_at) DESC, r.id DESC`
    )
    .all();
  res.json({ requests });
});

// More specific than /requests/:id below, so register it first.
api.get('/requests/files/:id/download', requireSuperadmin, (req, res) => {
  const f = db.prepare('SELECT * FROM request_files WHERE id = ?').get(req.params.id);
  if (!f) return bad(res, 'File not found', 404);
  // Uploaded content is untrusted: only audio may render inline (for the
  // in-app player); everything else downloads as an opaque attachment so a
  // crafted HTML/SVG file can never execute on this origin.
  const inline = f.mime_type.startsWith('audio/') && !req.query.dl;
  res.sendFile(path.join(REQUESTS_DIR, f.stored_name), {
    headers: {
      'Content-Type': inline ? f.mime_type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

api.get('/requests/:id', requireSuperadmin, (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return bad(res, 'Not found', 404);
  const request = db.prepare('SELECT * FROM translation_requests WHERE id = ?').get(req.params.id);
  if (!request) return bad(res, 'Request not found', 404);
  const files = db
    .prepare(
      `SELECT id, original_name, mime_type, size_bytes, created_at
       FROM request_files WHERE request_id = ? ORDER BY id`
    )
    .all(request.id);
  const { token_hash, ...rest } = request;
  res.json({ ...rest, files });
});

api.delete('/requests/:id', requireSuperadmin, (req, res) => {
  const request = db.prepare('SELECT * FROM translation_requests WHERE id = ?').get(req.params.id);
  if (!request) return bad(res, 'Request not found', 404);
  db.prepare('DELETE FROM translation_requests WHERE id = ?').run(request.id); // files cascade
  fs.rm(path.join(REQUESTS_DIR, String(request.id)), { recursive: true, force: true }, () => {});
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
  // Optional ?kind scopes the contributor list/counts to one entry kind so the
  // Dictionary and Phrases filters each show only their own contributors.
  const kind = req.query.kind === 'word' || req.query.kind === 'phrase' ? req.query.kind : null;
  const contributors = db
    .prepare(
      `SELECT u.id, u.name, COUNT(*) AS entry_count
       FROM entries e JOIN users u ON u.id = e.created_by
       WHERE e.project_id = ?${kind ? ' AND e.kind = ?' : ''} GROUP BY u.id ORDER BY entry_count DESC`
    )
    .all(...(kind ? [projectId, kind] : [projectId]));
  res.json({ ...stats, recent, contributors });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

// Audio visibility: every member of a project can see and play all recordings
// on that project's entries. Editing/deleting a recording remains restricted
// to its uploader or a project admin.
const entrySelect = `
  SELECT e.id, e.project_id, e.kind, e.dene_text, e.english_text, e.source_doc,
         e.notes, e.category, e.status, e.created_by, e.updated_by,
         e.created_at, e.updated_at,
         p.name AS project_name, p.dialect,
         cu.name AS created_by_name, uu.name AS updated_by_name,
         (SELECT COUNT(*) FROM audio_files a WHERE a.entry_id = e.id AND a.is_current = 1) AS audio_count,
         (SELECT COALESCE(SUM(a.duration_seconds), 0) FROM audio_files a
            WHERE a.entry_id = e.id AND a.is_current = 1) AS audio_seconds
  FROM entries e
  JOIN projects p ON p.id = e.project_id
  JOIN users cu ON cu.id = e.created_by
  JOIN users uu ON uu.id = e.updated_by
`;

// Positional params consumed by entrySelect, in SQL text order.
const entryParams = () => [];

api.get('/entries', async (req, res) => {
  const visible = projectIdsFor(req.user);
  if (visible.length === 0) return res.json({ entries: [], total: 0 });

  const q = String(req.query.q ?? '').trim();
  const semantic = !!q && (req.query.semantic === '1' || req.query.semantic === 'yes');
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

  // Keyword (substring) filter — skipped in semantic mode, where every in-scope
  // entry is instead ranked purely by meaning (see below).
  if (q && !semantic) {
    const like = `%${q}%`;
    where.push('(e.dene_text LIKE ? OR e.english_text LIKE ? OR e.source_doc LIKE ? OR e.notes LIKE ? OR e.category LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (req.query.contributor) {
    where.push('e.created_by = ?');
    params.push(Number(req.query.contributor));
  }
  // has_audio filters on whether ANY user has recorded the entry — useful for
  // admin/list views. All project members can see every recording.
  if (req.query.has_audio === 'yes') {
    where.push('EXISTS (SELECT 1 FROM audio_files a WHERE a.entry_id = e.id AND a.is_current = 1)');
  } else if (req.query.has_audio === 'no') {
    where.push('NOT EXISTS (SELECT 1 FROM audio_files a WHERE a.entry_id = e.id AND a.is_current = 1)');
  }
  // needs_my_audio builds a per-speaker recording queue: entries where THIS user
  // has claimable paid recording work in the given language. That means: no
  // current recording of mine AND no accepted (already-billed) work item for the
  // slot — deleting a billed recording does not re-open the obligation — OR an
  // admin-authorized rework item queued for me. Matches what a claim will offer,
  // so dashboard counts and sessions agree. Dene/English stay independent.
  const needsMine = req.query.needs_my_audio;
  if (needsMine === 'dene' || needsMine === 'english') {
    where.push(
      `((NOT EXISTS (SELECT 1 FROM audio_files a
                     WHERE a.entry_id = e.id AND a.uploaded_by = ? AND a.language = ? AND a.is_current = 1)
         AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.entry_id = e.id
                           AND w.type = 'recording' AND w.language = ? AND w.assigned_to = ?
                           AND w.status = 'accepted'))
        OR EXISTS (SELECT 1 FROM work_items w WHERE w.entry_id = e.id
                     AND w.type = 'recording' AND w.language = ? AND w.assigned_to = ?
                     AND w.status = 'queued' AND w.rework_authorized = 1))`
    );
    params.push(req.user.id, needsMine, needsMine, req.user.id, needsMine, req.user.id);
  }
  if (req.query.status) {
    where.push('e.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.kind === 'word' || req.query.kind === 'phrase') {
    where.push('e.kind = ?');
    params.push(req.query.kind);
  }
  // A complete entry has both sides filled. Words always are; phrases may have
  // one side blank ('') until translated. The recording queue passes this so
  // incomplete phrases aren't offered for recording.
  if (req.query.complete === 'yes') {
    where.push("e.dene_text <> '' AND e.english_text <> ''");
  } else if (req.query.complete === 'no') {
    where.push("(e.dene_text = '' OR e.english_text = '')");
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  if (semantic) {
    // Rank the in-scope entries by cosine similarity of their English embedding
    // to the query, with substring matches boosted above pure meaning matches.
    const cands = db
      .prepare(`SELECT e.id, e.dene_text, e.english_text, e.embedding FROM entries e ${whereSql}`)
      .all(...params);
    let qvec;
    try { qvec = await embed(q); }
    catch { return bad(res, 'Semantic search is temporarily unavailable', 503); }
    // Rank purely by semantic similarity — exact substring matches are not
    // boosted, so a closer-in-meaning result can outrank a literal one.
    const ranked = cands
      .map((c) => ({
        id: c.id,
        score: c.embedding ? cosine(qvec, fromBlob(c.embedding)) : -1,
      }))
      .sort((a, b) => b.score - a.score);

    const total = ranked.length;
    const pageIds = ranked.slice(offset, offset + limit).map((r) => r.id);
    let entries = [];
    if (pageIds.length) {
      const rows = db
        .prepare(`${entrySelect} WHERE e.id IN (${pageIds.map(() => '?').join(',')})`)
        .all(...entryParams(req.user), ...pageIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      entries = pageIds.map((id) => byId.get(id)).filter(Boolean); // preserve rank order
    }
    return res.json({ entries, total, limit, offset, semantic: true });
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM entries e ${whereSql}`)
    .get(...params).n;
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

// Paid work flows EXCLUSIVELY through work items (claim -> submit ->
// accept+bill, transactional and idempotent). The old best-effort logWork()
// helper is gone: generic edit/upload endpoints never write ledger rows, and
// translators are rejected from them entirely (their flow is the sessions).
function rejectTranslators(req, res, next) {
  if (req.projectRole === 'translator') {
    return bad(res, 'Translators work through recording/translation sessions — paid work needs a claimed work item', 403);
  }
  next();
}

// Project admins may edit any entry; members may edit only their own. UI hiding
// is not authorization, so this is the server-side gate for generic entry edits
// and deletes. Translators are intentionally NOT granted general edit rights:
// their work goes through the dedicated /translate endpoint (completing an
// incomplete phrase) and their own recordings — not arbitrary entry edits.
// Corrections to completed work are handled by an admin, or (once work items
// land) by reopening the translator's own claimed work item.
const canEditEntry = (req) =>
  req.projectRole === 'admin' ||
  (req.projectRole === 'member' && req.entry.created_by === req.user.id);

// Best-effort: (re)compute the English embedding for an entry in the background.
// Never blocks or fails the request; the backfill script catches any misses.
function storeEmbedding(entryId, english) {
  const text = String(english ?? '').trim();
  if (!text) {
    db.prepare('UPDATE entries SET embedding = NULL, embedding_model = NULL WHERE id = ?').run(entryId);
    return;
  }
  embed(text)
    .then((vec) => {
      db.prepare('UPDATE entries SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(toBlob(vec), MODEL, entryId);
    })
    .catch((e) => console.error(`[embed] entry ${entryId}:`, e.message));
}

// Write both sides of an entry and refresh its embedding. Shared by the legacy
// /translate endpoint and the work-item submit path. Synchronous (safe inside a
// transaction): storeEmbedding only schedules async work, it never awaits here.
function applyTranslation(entry, nextDene, nextEnglish, userId) {
  db.prepare(
    `UPDATE entries SET dene_text = ?, english_text = ?, updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextDene, nextEnglish, userId, entry.id);
  if (nextEnglish !== entry.english_text) storeEmbedding(entry.id, nextEnglish);
}

api.post('/entries', (req, res) => {
  const { project_id, dene_text, english_text, source_doc, notes, category } = req.body ?? {};
  const projectId = Number(project_id);
  const role = roleIn(req.user, projectId);
  if (!projectId || !role) {
    return bad(res, 'You are not a member of that project', 403);
  }
  if (role === 'translator') {
    return bad(res, 'Translators add recordings, not entries', 403);
  }
  const kind = req.body?.kind === 'phrase' ? 'phrase' : 'word';
  const dene = dene_text?.trim() || '';
  const english = english_text?.trim() || '';
  // Words need both sides; a phrase needs at least one (the missing side is
  // stored as '' and the phrase is flagged incomplete until translated).
  if (kind === 'phrase') {
    if (!dene && !english) return bad(res, 'Enter a Dene phrase, an English meaning, or both');
  } else if (!dene || !english) {
    return bad(res, 'Both Dene text and English text are required');
  }
  const info = db
    .prepare(
      `INSERT INTO entries (project_id, kind, dene_text, english_text, source_doc, notes, category, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, kind, dene, english, source_doc?.trim() || null,
         notes?.trim() || null, category?.trim() || null, req.user.id, req.user.id);
  storeEmbedding(info.lastInsertRowid, english);
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
       WHERE a.entry_id = ? AND a.is_current = 1
       ORDER BY a.language, a.created_at`
    )
    .all(req.entry.id);
  res.json({ ...req.entry, audio, can_edit: canEditEntry(req), role: req.projectRole });
});

api.patch('/entries/:id', loadEntry, (req, res) => {
  if (!canEditEntry(req)) return bad(res, 'You can only edit your own entries', 403);
  const { dene_text, english_text, source_doc, notes, category, status } = req.body ?? {};
  // Resolve the resulting two sides, then enforce the per-kind rule: words need
  // both; phrases need at least one (an emptied side is stored as '').
  const nextDene = dene_text !== undefined ? dene_text.trim() : req.entry.dene_text;
  const nextEnglish = english_text !== undefined ? english_text.trim() : req.entry.english_text;
  if (req.entry.kind === 'phrase') {
    if (!nextDene && !nextEnglish) return bad(res, 'A phrase must keep a Dene phrase or an English meaning');
  } else {
    if (!nextDene) return bad(res, 'Dene text cannot be empty');
    if (!nextEnglish) return bad(res, 'English text cannot be empty');
  }
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
    nextDene,
    nextEnglish,
    source_doc !== undefined ? (source_doc?.trim() || null) : req.entry.source_doc,
    notes !== undefined ? (notes?.trim() || null) : req.entry.notes,
    category !== undefined ? (category?.trim() || null) : req.entry.category,
    status !== undefined ? status : req.entry.status,
    req.user.id,
    req.entry.id
  );
  if (nextEnglish !== req.entry.english_text) storeEmbedding(req.entry.id, nextEnglish);
  res.json(
    db.prepare(`${entrySelect} WHERE e.id = ?`).get(...entryParams(req.user), req.entry.id)
  );
});

api.delete('/entries/:id', loadEntry, (req, res) => {
  if (!canEditEntry(req)) return bad(res, 'You can only delete your own entries', 403);
  const files = db
    .prepare('SELECT stored_name, playback_stored_name FROM audio_files WHERE entry_id = ?')
    .all(req.entry.id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.entry.id);
  for (const f of files) rmAudioFiles(f); // every version's master + derivative
  res.json({ ok: true });
});

// Fill in a phrase's missing side directly (members/admins; unbilled). Paid
// translation flows through work items; translators use the translation session.
api.post('/entries/:id/translate', loadEntry, rejectTranslators, (req, res) => {
  if (req.entry.kind !== 'phrase') return bad(res, 'Only phrases can be translated here');
  const incomplete = req.entry.dene_text === '' || req.entry.english_text === '';
  if (!incomplete && !canEditEntry(req)) return bad(res, 'This phrase is already complete', 403);
  const { dene_text, english_text } = req.body ?? {};
  const nextDene = dene_text !== undefined ? String(dene_text).trim() : req.entry.dene_text;
  const nextEnglish = english_text !== undefined ? String(english_text).trim() : req.entry.english_text;
  if (!nextDene && !nextEnglish) return bad(res, 'Enter a Dene phrase or an English meaning');
  applyTranslation(req.entry, nextDene, nextEnglish, req.user.id);
  res.json(db.prepare(`${entrySelect} WHERE e.id = ?`).get(...entryParams(req.user), req.entry.id));
});

// ---------------------------------------------------------------------------
// Audio attachments
// ---------------------------------------------------------------------------

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a']);
const MAX_AUDIO_BYTES = 500 * 1024 * 1024; // 500 MB

// Content-Type served for a recording is derived from its (server-generated)
// extension, never from the client-supplied upload MIME — a spoofed type like
// text/html served inline would otherwise execute as script on this origin.
const AUDIO_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const audioMimeFor = (storedName) =>
  AUDIO_MIME[path.extname(storedName).toLowerCase()] || 'application/octet-stream';

const upload = multer({
  storage: multer.diskStorage({
    // Masters are organized per uploader: data/audio/masters/<userID>/<file>
    destination: (req, file, cb) => {
      const dir = path.join(MASTERS_DIR, String(req.user.id));
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

// Absolute paths of the files backing an audio row (master + optional derivative),
// for cleanup on delete. probeAudio lives in ./audio.js now.
function audioFiles(row) {
  const out = [path.join(AUDIO_DIR, row.stored_name)];
  if (row.playback_stored_name) out.push(path.join(AUDIO_DIR, row.playback_stored_name));
  return out;
}
const rmAudioFiles = (row) => audioFiles(row).forEach((f) => fs.rm(f, { force: true }, () => {}));

// Save an uploaded master as a NEW immutable version for its slot. The prior
// current version (if any) is superseded, never overwritten or deleted. Kicks off
// background derivative generation. Returns { audioId, hadCurrent }. Never bills —
// callers decide billing (bill once, on the first version for a slot).
function saveMasterRecording({ entry, userId, file, probe, language, speaker, notes, captureMethod, captureDevice }) {
  const storedName = `masters/${userId}/${file.filename}`;
  const prior = db
    .prepare('SELECT id FROM audio_files WHERE entry_id = ? AND uploaded_by = ? AND language = ? AND is_current = 1')
    .get(entry.id, userId, language);
  // Stamp the project's default consent profile (if any) onto the new version at
  // save time — the recording carries its own immutable permission snapshot (#6).
  const consent = consentSnapshotFor(entry.project_id);
  const audioId = db.transaction(() => {
    if (prior) db.prepare('UPDATE audio_files SET is_current = 0 WHERE id = ?').run(prior.id);
    const id = db
      .prepare(
        `INSERT INTO audio_files
           (entry_id, stored_name, original_name, mime_type, size_bytes, duration_seconds,
            language, speaker, recording_notes, uploaded_by,
            is_current, supersedes_audio_id, archive_class,
            sample_rate_hz, channels, bit_depth, codec, capture_method, capture_device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'lossless_master', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id, storedName, file.originalname, file.mimetype || 'application/octet-stream',
        file.size, probe.duration, language, speaker, notes, userId,
        prior?.id ?? null, probe.sampleRate, probe.channels, probe.bitDepth, probe.codec,
        captureMethod || null, captureDevice || null
      ).lastInsertRowid;
    if (consent) {
      db.prepare(
        `UPDATE audio_files SET consent_profile_name = ?, ${CONSENT_FLAGS.map((f) => `${f} = ?`).join(', ')},
           consent_recorded_at = datetime('now'), consent_method = ? WHERE id = ?`
      ).run(consent.consent_profile_name, ...CONSENT_FLAGS.map((f) => consent[f]), consent.consent_method, id);
    }
    return id;
  })();
  // NOTE: no derivative enqueue here — callers do it AFTER their own outer
  // transaction commits (this function may run inside one, as a savepoint).
  return { audioId, hadCurrent: !!prior };
}

// Record (or re-record) a master. Re-recording supersedes the prior version
// rather than replacing it — old masters are never destroyed (#8b). Billed once,
// on the first version for a (entry, user, language) slot.
api.post('/entries/:id/audio', loadEntry, rejectTranslators, audioUpload, async (req, res) => {
  if (!req.file) return bad(res, 'No audio file provided');
  const filePath = req.file.path;
  // Can't record an incomplete phrase — it must be translated first.
  if (req.entry.kind === 'phrase' && (req.entry.dene_text === '' || req.entry.english_text === '')) {
    fs.rm(filePath, { force: true }, () => {});
    return bad(res, 'Add the translation before recording this phrase');
  }
  const language = req.body.language === 'english' ? 'english' : 'dene';
  let probe;
  try {
    probe = await probeAudio(filePath);
  } catch {
    fs.rm(filePath, { force: true }, () => {});
    return bad(res, 'Could not read that audio file — it may be corrupt or in an unsupported format. The entry was not changed.');
  }

  const { audioId, hadCurrent } = saveMasterRecording({
    entry: req.entry, userId: req.user.id, file: req.file, probe, language,
    speaker: req.body.speaker?.trim() || null,
    notes: req.body.recording_notes?.trim() || null,
    captureMethod: req.body.capture_method === 'browser_recording' ? 'browser_recording' : 'uploaded_file',
    captureDevice: req.body.capture_device?.trim() || null,
  });
  enqueueDerivative(audioId);
  // Direct uploads are NOT billable: paid work flows exclusively through
  // work items (claim -> submit -> accept+bill in one transaction).
  res.status(hadCurrent ? 200 : 201)
    .json({ ...db.prepare('SELECT * FROM audio_files WHERE id = ?').get(audioId), replaced: hadCurrent });
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
  // Serve the lightweight playback derivative when it exists; otherwise stream the
  // master directly (e.g. before the derivative is generated, or without ffmpeg).
  const serveName = req.audio.playback_stored_name || req.audio.stored_name;
  res.sendFile(path.join(AUDIO_DIR, serveName), {
    headers: {
      'Content-Type': audioMimeFor(serveName),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(req.audio.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Download the archival master (admins and the uploader). Always the lossless
// original, as an attachment.
api.get('/audio/:id/master', loadAudio, (req, res) => {
  if (req.audioRole !== 'admin' && req.audio.uploaded_by !== req.user.id) {
    return bad(res, 'Only the uploader or a project admin can download the master', 403);
  }
  res.sendFile(path.join(AUDIO_DIR, req.audio.stored_name), {
    headers: {
      'Content-Type': audioMimeFor(req.audio.stored_name),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(req.audio.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// Superseded versions of this recording's slot, newest first (uploader/admin).
api.get('/audio/:id/history', loadAudio, (req, res) => {
  if (req.audioRole !== 'admin' && req.audio.uploaded_by !== req.user.id) {
    return bad(res, 'Only the uploader or a project admin can view version history', 403);
  }
  const versions = db
    .prepare(
      `SELECT id, original_name, duration_seconds, size_bytes, archive_class, sha256,
              sample_rate_hz, channels, bit_depth, codec, is_current, created_at
       FROM audio_files
       WHERE entry_id = ? AND uploaded_by = ? AND language = ? AND is_current = 0
       ORDER BY id DESC`
    )
    .all(req.audio.entry_id, req.audio.uploaded_by, req.audio.language);
  res.json({ versions });
});

// Revoke consent on a recording (#6). Organization-admin only, audited. The
// asset stays in the archive (flagged) but is excluded from purpose-filtered
// exports and any future public/AI-training surface. Physical deletion remains
// a separate, explicit action under the owner's policy.
api.post('/audio/:id/revoke', loadAudio, (req, res) => {
  const org = db
    .prepare('SELECT p.organization_id AS oid FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ?')
    .get(req.audio.entry_id);
  if (!org?.oid || !isOrgAdmin(req.user, org.oid)) {
    return bad(res, 'Organization admin access required', 403);
  }
  if (req.audio.revoked_at) return bad(res, 'This recording is already revoked');
  const note = req.body?.note?.trim() || null;
  db.transaction(() => {
    db.prepare(`UPDATE audio_files SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?`)
      .run(req.user.id, req.audio.id);
    db.prepare(`INSERT INTO consent_changes (audio_id, action, profile_name, note, changed_by)
                VALUES (?, 'revoke', ?, ?, ?)`)
      .run(req.audio.id, req.audio.consent_profile_name, note, req.user.id);
  })();
  res.json(db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.audio.id));
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
  const a = req.audio;
  // Deleting recordings in a BILLED slot is a financial act (it interacts with
  // the one-paid-obligation-per-slot rule): org admins only. Project-level
  // admins and the uploader are blocked once an accepted work item exists.
  const billed = db
    .prepare(
      `SELECT 1 FROM work_items WHERE entry_id = ? AND type = 'recording'
       AND language = ? AND assigned_to = ? AND status = 'accepted' LIMIT 1`
    )
    .get(a.entry_id, a.language, a.uploaded_by);
  if (billed) {
    const org = db
      .prepare(`SELECT p.organization_id AS oid FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ?`)
      .get(a.entry_id);
    if (!org?.oid || !isOrgAdmin(req.user, org.oid)) {
      return bad(res, 'This recording is billed work — an organization admin must delete it (or authorize a paid re-record)', 403);
    }
  }
  // Deleting the CURRENT version promotes the most recent superseded version back
  // to current (so the slot is never left "has history but no current" — that
  // state would confuse the recording queue and billing). Deleting a superseded
  // version just removes it. Only the deleted row's files are removed.
  db.transaction(() => {
    db.prepare('DELETE FROM audio_files WHERE id = ?').run(a.id);
    if (a.is_current) {
      const prev = db
        .prepare(
          `SELECT id FROM audio_files
           WHERE entry_id = ? AND uploaded_by = ? AND language = ? AND is_current = 0
           ORDER BY id DESC LIMIT 1`
        )
        .get(a.entry_id, a.uploaded_by, a.language);
      if (prev) db.prepare('UPDATE audio_files SET is_current = 1 WHERE id = ?').run(prev.id);
    }
  })();
  rmAudioFiles(a);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Work items (#3/#4): claimable, leased units of paid work with a transactional
// submit-and-bill. Sessions claim a small batch, then submit or release each.
// Under the current auto-accept policy, submit == accept in one transaction.
// ---------------------------------------------------------------------------

const LEASE_MINUTES = 45;
const MAX_CLAIM = 20;

function loadWorkItem(req, res, next) {
  const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(req.params.id);
  if (!item) return bad(res, 'Work item not found', 404);
  const role = roleIn(req.user, item.project_id);
  if (!role) return bad(res, 'Not a member of this project', 403);
  if (item.assigned_to !== req.user.id && role !== 'admin') {
    return bad(res, 'This work item is not assigned to you', 403);
  }
  req.workItem = item;
  req.projectRole = role;
  next();
}

// Insert the ledger row for an accepted work item, snapshotting the rate at
// accept time (matching the legacy "rate at time of work" invariant). Stamps the
// owning organization so tenant-scoped views survive project deletion. Idempotent:
// the unique index on work_log(work_item_id) makes a repeat a silent no-op, so a
// double-submit can never double-bill. Runs inside the caller's transaction.
function billWorkItem(item, { entryId = item.entry_id ?? null, audioId = null }) {
  const rate = db
    .prepare('SELECT rate_cents FROM translator_rates WHERE user_id = ? AND project_id = ? AND type = ?')
    .get(item.assigned_to, item.project_id, item.type);
  const orgId = db
    .prepare('SELECT organization_id FROM projects WHERE id = ?')
    .get(item.project_id)?.organization_id ?? null;
  db.prepare(
    `INSERT INTO work_log (user_id, project_id, type, entry_id, audio_id, amount_cents, work_item_id, organization_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) WHERE work_item_id IS NOT NULL DO NOTHING`
  ).run(item.assigned_to, item.project_id, item.type, entryId, audioId,
        rate?.rate_cents ?? 0, item.id, orgId, item.assigned_to);
}

// Guarded accept: only a still-claimed item can transition to accepted. Throwing
// on 0 changes (inside the caller's transaction) closes the concurrent
// double-submit race — the loser rolls back cleanly instead of double-inserting.
function acceptWorkItem(id) {
  const changed = db.prepare(
    `UPDATE work_items SET status = 'accepted', submitted_at = datetime('now'),
       reviewed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'claimed'`
  ).run(id).changes;
  if (changed === 0) throw new Error('work item is no longer claimed');
}

// Session-friendly response: the work item plus the entry (translation) or the
// current recording for its slot (recording).
function submitResult(item) {
  const out = { ok: true, work_item_id: item.id, type: item.type, status: item.status };
  if (item.type === 'translation') {
    out.entry = db.prepare(`${entrySelect} WHERE e.id = ?`).get(...entryParams(item), item.entry_id);
  } else {
    out.audio = db
      .prepare('SELECT * FROM audio_files WHERE entry_id = ? AND uploaded_by = ? AND language = ? AND is_current = 1 ORDER BY id DESC')
      .get(item.entry_id, item.assigned_to, item.language);
  }
  return out;
}

// Claim a batch of work. Runs as ONE synchronous transaction (no awaits) so
// concurrent claims cannot hand the same job to two people; the partial unique
// indexes are a backstop for that invariant and the future admin-reassign flow.
api.post('/projects/:id/work/claim', (req, res) => {
  const projectId = Number(req.params.id);
  const role = roleIn(req.user, projectId);
  if (!role) return bad(res, 'Not a member of this project', 403);
  const type = req.body?.type;
  if (type !== 'translation' && type !== 'recording') return bad(res, 'Invalid work type');
  const language = type === 'recording' ? (req.body?.language === 'english' ? 'english' : 'dene') : null;
  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), MAX_CLAIM);

  // Lease window; a short lease is allowed outside production to exercise expiry.
  let leaseExpr = `datetime('now', '+${LEASE_MINUTES} minutes')`;
  if (process.env.NODE_ENV !== 'production' && req.body?._test_lease_seconds !== undefined) {
    const secs = Number(req.body._test_lease_seconds) || 0;
    leaseExpr = `datetime('now', '${secs < 0 ? '-' : '+'}${Math.abs(secs)} seconds')`;
  }

  const rateCents = db
    .prepare('SELECT rate_cents FROM translator_rates WHERE user_id = ? AND project_id = ? AND type = ?')
    .get(req.user.id, projectId, type)?.rate_cents ?? null;

  const claimedIds = db.transaction(() => {
    // Free lapsed leases. Ordinary claims are cancelled (the slot returns to the
    // pool); ADMIN-AUTHORIZED REWORK goes back to 'queued' so the authorization
    // survives an abandoned session instead of silently evaporating.
    db.prepare(
      `UPDATE work_items SET status = 'queued', claimed_at = NULL, lease_expires_at = NULL,
         updated_at = datetime('now')
       WHERE project_id = ? AND type = ? AND status = 'claimed' AND rework_authorized = 1
         AND lease_expires_at < datetime('now')`
    ).run(projectId, type);
    db.prepare(
      `UPDATE work_items SET status = 'cancelled', updated_at = datetime('now')
       WHERE project_id = ? AND type = ? AND status = 'claimed' AND lease_expires_at < datetime('now')`
    ).run(projectId, type);

    const ids = [];
    // Step 0: adopt any admin-authorized rework queued FOR ME (these bypass the
    // normal candidate discovery and its accepted-slot exclusion by design).
    for (const w of db
      .prepare(
        `SELECT id, rate_cents FROM work_items
         WHERE project_id = ? AND type = ? AND status = 'queued' AND assigned_to = ?
           AND rework_authorized = 1 ${type === 'recording' ? 'AND language = ?' : ''}
         ORDER BY id LIMIT ?`
      )
      .all(...(type === 'recording'
        ? [projectId, type, req.user.id, language, limit]
        : [projectId, type, req.user.id, limit]))) {
      db.prepare(
        `UPDATE work_items SET status = 'claimed', claimed_at = datetime('now'),
           lease_expires_at = ${leaseExpr}, rate_cents = COALESCE(rate_cents, ?),
           updated_at = datetime('now')
         WHERE id = ? AND status = 'queued'`
      ).run(rateCents, w.id);
      ids.push(w.id);
    }

    const remaining = limit - ids.length;
    let candidates = [];
    if (remaining > 0 && type === 'translation') {
      candidates = db
        .prepare(
          `SELECT e.id FROM entries e
           WHERE e.project_id = ? AND e.kind = 'phrase'
             AND (e.dene_text = '' OR e.english_text = '')
             AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.entry_id = e.id
                               AND w.type = 'translation' AND w.status IN ('claimed', 'submitted'))
           ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`
        )
        .all(projectId, remaining);
    } else if (remaining > 0) {
      // The accepted-item exclusion enforces "one paid obligation per slot":
      // deleting a billed recording does NOT make the slot claimable again —
      // only an admin-authorized rework item (adopted above) reopens payment.
      candidates = db
        .prepare(
          `SELECT e.id FROM entries e
           WHERE e.project_id = ? AND e.dene_text <> '' AND e.english_text <> ''
             AND NOT EXISTS (SELECT 1 FROM audio_files a WHERE a.entry_id = e.id
                               AND a.uploaded_by = ? AND a.language = ? AND a.is_current = 1)
             AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.entry_id = e.id
                               AND w.type = 'recording' AND w.language = ? AND w.assigned_to = ?
                               AND w.status IN ('claimed', 'submitted', 'accepted'))
           ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`
        )
        .all(projectId, req.user.id, language, language, req.user.id, remaining);
    }

    const ins = db.prepare(
      `INSERT INTO work_items (project_id, entry_id, type, language, assigned_to, status, rate_cents, claimed_at, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, datetime('now'), ${leaseExpr})`
    );
    for (const c of candidates) ids.push(ins.run(projectId, c.id, type, language, req.user.id, rateCents).lastInsertRowid);
    return ids;
  })();

  if (!claimedIds.length) return res.json({ items: [] });
  const items = db
    .prepare(`SELECT * FROM work_items WHERE id IN (${claimedIds.map(() => '?').join(',')})`)
    .all(...claimedIds);
  const entryIds = items.map((i) => i.entry_id);
  const entryRows = db
    .prepare(`${entrySelect} WHERE e.id IN (${entryIds.map(() => '?').join(',')})`)
    .all(...entryParams(req.user), ...entryIds);
  const byId = new Map(entryRows.map((r) => [r.id, r]));
  const out = items.map((i) => ({
    work_item_id: i.id, type: i.type, language: i.language,
    lease_expires_at: i.lease_expires_at, entry: byId.get(i.entry_id),
  }));
  res.json({ items: out });
});

// Submit a claimed work item; auto-accepts and bills in one transaction.
api.post('/work/:id/submit', loadWorkItem, (req, res) => {
  const item = req.workItem;
  if (item.status === 'accepted') return res.json(submitResult(item)); // idempotent replay
  if (item.status !== 'claimed') return bad(res, 'This work item is no longer active', 409);

  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(item.entry_id);
  if (!entry) return bad(res, 'Entry not found', 404);

  if (item.type === 'translation') {
    const incomplete = entry.dene_text === '' || entry.english_text === '';
    // Stale-claim guard: if the phrase was completed by someone else (or an admin
    // via the legacy path) while this claim was held, don't apply or bill.
    if (!incomplete) {
      db.prepare(`UPDATE work_items SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(item.id);
      return bad(res, 'This phrase was already completed by someone else', 409);
    }
    const { dene_text, english_text } = req.body ?? {};
    const nextDene = dene_text !== undefined ? String(dene_text).trim() : entry.dene_text;
    const nextEnglish = english_text !== undefined ? String(english_text).trim() : entry.english_text;
    if (!nextDene || !nextEnglish) return bad(res, 'Enter both a Dene phrase and an English meaning to complete it');
    db.transaction(() => {
      applyTranslation(entry, nextDene, nextEnglish, req.user.id);
      acceptWorkItem(item.id);
      billWorkItem(item, { entryId: entry.id });
    })();
    return res.json(submitResult(db.prepare('SELECT * FROM work_items WHERE id = ?').get(item.id)));
  }

  // recording: multipart upload
  audioUpload(req, res, async () => {
    if (!req.file) return bad(res, 'No audio file provided');
    const filePath = req.file.path;
    if (entry.dene_text === '' || entry.english_text === '') {
      fs.rm(filePath, { force: true }, () => {});
      return bad(res, 'Add the translation before recording this phrase');
    }
    const language = item.language === 'english' ? 'english' : 'dene';
    let probe;
    try {
      probe = await probeAudio(filePath); // before the transactions — no awaits inside them
    } catch {
      fs.rm(filePath, { force: true }, () => {});
      return bad(res, 'Could not read that audio file — it may be corrupt or in an unsupported format. Nothing was changed.');
    }
    // A rework item ALWAYS records a new take (that's what the admin authorized),
    // superseding any current audio. A normal item with a current recording for
    // the slot (e.g. recorded on the entry page mid-session) accepts against that
    // existing audio instead of saving a duplicate — and still bills, so an
    // accepted item can never exist without its ledger row.
    const existing = item.rework_authorized
      ? null
      : db
          .prepare('SELECT id FROM audio_files WHERE entry_id = ? AND uploaded_by = ? AND language = ? AND is_current = 1')
          .get(entry.id, req.user.id, language);
    let savedAudioId = null;
    try {
      db.transaction(() => {
        if (existing) {
          acceptWorkItem(item.id);
          billWorkItem(item, { audioId: existing.id });
        } else {
          // saveMasterRecording's internal transaction nests as a SAVEPOINT here,
          // so audio version + acceptance + ledger commit or roll back together.
          const { audioId } = saveMasterRecording({
            entry, userId: req.user.id, file: req.file, probe, language,
            speaker: req.body.speaker?.trim() || null,
            notes: req.body.recording_notes?.trim() || null,
            captureMethod: 'browser_recording',
            captureDevice: req.body.capture_device?.trim() || null,
          });
          savedAudioId = audioId;
          acceptWorkItem(item.id);
          billWorkItem(item, { audioId });
        }
      })();
    } catch (err) {
      fs.rm(filePath, { force: true }, () => {}); // never keep an uncommitted upload
      console.error(`[work] recording submit for item ${item.id} rolled back:`, err.message);
      return bad(res, 'This work item is no longer active', 409);
    }
    if (existing) fs.rm(filePath, { force: true }, () => {}); // discard the duplicate upload
    else if (savedAudioId) enqueueDerivative(savedAudioId);   // derivative only after commit
    return res.json(submitResult(db.prepare('SELECT * FROM work_items WHERE id = ?').get(item.id)));
  });
});

// Release a still-claimed item back to the queue (Skip / Exit a session).
// Admin-authorized rework returns to 'queued' — skipping a rework take must not
// destroy the authorization; ordinary claims are cancelled back to the pool.
api.post('/work/:id/release', loadWorkItem, (req, res) => {
  if (req.workItem.status === 'claimed') {
    if (req.workItem.rework_authorized) {
      db.prepare(
        `UPDATE work_items SET status = 'queued', claimed_at = NULL, lease_expires_at = NULL,
           updated_at = datetime('now') WHERE id = ?`
      ).run(req.workItem.id);
    } else {
      db.prepare(`UPDATE work_items SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(req.workItem.id);
    }
  }
  res.json({ ok: true });
});

// Authorize a PAID re-record of an already-billed slot (#hardening-2). Deleting
// or superseding an accepted recording never re-opens billing by itself; an org
// admin must explicitly create this rework item, which the speaker's next
// recording-session claim adopts.
api.post('/entries/:id/audio-rework', (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!entry) return bad(res, 'Entry not found', 404);
  const org = db.prepare('SELECT organization_id FROM projects WHERE id = ?').get(entry.project_id);
  if (!org?.organization_id || !isOrgAdmin(req.user, org.organization_id)) {
    return bad(res, 'Organization admin access required', 403);
  }
  const userId = Number(req.body?.user_id);
  const language = req.body?.language === 'english' ? 'english' : 'dene';
  if (!userId || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
    return bad(res, 'A valid user_id is required');
  }
  const prior = db
    .prepare(
      `SELECT id FROM work_items WHERE entry_id = ? AND type = 'recording'
       AND language = ? AND assigned_to = ? AND status = 'accepted' ORDER BY id DESC`
    )
    .get(entry.id, language, userId);
  if (!prior) return bad(res, 'No accepted (billed) recording work exists for this slot — a normal claim already covers it');
  const open = db
    .prepare(
      `SELECT status FROM work_items WHERE entry_id = ? AND type = 'recording'
       AND language = ? AND assigned_to = ? AND status IN ('queued', 'claimed', 'submitted')`
    )
    .get(entry.id, language, userId);
  if (open) return bad(res, `A ${open.status} work item already exists for this slot`, 409);
  const info = db
    .prepare(
      `INSERT INTO work_items (project_id, entry_id, type, language, assigned_to, status,
                               rework_authorized, rework_of_work_item_id)
       VALUES (?, ?, 'recording', ?, ?, 'queued', 1, ?)`
    )
    .run(entry.project_id, entry.id, language, userId, prior.id);
  res.status(201).json({ ok: true, work_item_id: info.lastInsertRowid, rework_of_work_item_id: prior.id });
});

// ---------------------------------------------------------------------------
// Export (P1-2): CSV / JSON with audio file references
// ---------------------------------------------------------------------------

api.get('/projects/:id/export', requireProjectAdmin, (req, res) => {
  // Optional ?kind exports just the dictionary words or just the phrases;
  // without it, the file contains everything (the kind column distinguishes them).
  const kind = req.query.kind === 'word' || req.query.kind === 'phrase' ? req.query.kind : null;
  const kindSql = kind ? ' AND e.kind = ?' : '';
  const kindArg = kind ? [kind] : [];
  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.dene_text, e.english_text, e.source_doc, e.notes, e.category, e.status,
              cu.name AS contributor, e.created_at, e.updated_at
       FROM entries e JOIN users cu ON cu.id = e.created_by
       WHERE e.project_id = ?${kindSql} ORDER BY e.id`
    )
    .all(req.project.id, ...kindArg);
  const audioByEntry = new Map();
  for (const a of db
    .prepare(
      `SELECT a.entry_id, a.stored_name, a.original_name, a.duration_seconds, a.language, a.speaker
       FROM audio_files a JOIN entries e ON e.id = a.entry_id
       WHERE e.project_id = ? AND a.is_current = 1${kindSql}`
    )
    .all(req.project.id, ...kindArg)) {
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
  const base = `${req.project.name.replace(/[^\w-]+/g, '_')}_${stamp}${kind ? `_${kind}s` : ''}`;

  if (req.query.format === 'csv') {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'entry_id,kind,dene_text,english_text,category,source_doc,notes,status,contributor,created_at,updated_at,dene_audio_files,english_audio_files,audio_duration_seconds\n';
    const lines = rows.map((r) => {
      const audio = audioByEntry.get(r.id) ?? [];
      return [
        r.id, r.kind, r.dene_text, r.english_text, r.category, r.source_doc, r.notes, r.status,
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

// Owner archive (#7): a single streamed ZIP with the entries, the actual master
// recordings (+ playback derivatives), machine-readable metadata, and SHA-256
// checksums that match the DB — restorable without the running app. Includes each
// recording's CURRENT master (or legacy file); superseded versions stay in the app
// (noted in the manifest). Purpose-filtered exports / permissions await #6.
const csvEsc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sha256Hex = (str) => crypto.createHash('sha256').update(str).digest('hex');

// Purpose-filtered exports (#6): each purpose maps to one consent flag. A
// recording is included only when its SNAPSHOT explicitly allows the purpose and
// it is not revoked — permission is never inferred from membership/visibility,
// and consent-unknown recordings are excluded.
const EXPORT_PURPOSES = {
  learning: 'allow_language_learning',
  asr: 'allow_asr_training',
  tts: 'allow_tts_training',
  translation_model: 'allow_translation_model_training',
  research: 'allow_research',
  commercial: 'allow_commercial_use',
  redistribution: 'allow_redistribution',
};

api.get('/projects/:id/export-bundle', requireProjectAdmin, async (req, res) => {
  const kind = req.query.kind === 'word' || req.query.kind === 'phrase' ? req.query.kind : null;
  const kindSql = kind ? ' AND e.kind = ?' : '';
  const kindArg = kind ? [kind] : [];
  const purpose = req.query.purpose ? String(req.query.purpose) : null;
  if (purpose && !EXPORT_PURPOSES[purpose]) {
    return bad(res, `Unknown purpose — use one of: ${Object.keys(EXPORT_PURPOSES).join(', ')}`);
  }
  const purposeSql = purpose ? ` AND a.${EXPORT_PURPOSES[purpose]} = 1 AND a.revoked_at IS NULL` : '';

  const rows = db
    .prepare(
      `SELECT e.id, e.kind, e.dene_text, e.english_text, e.source_doc, e.notes, e.category, e.status,
              cu.name AS contributor, e.created_at, e.updated_at
       FROM entries e JOIN users cu ON cu.id = e.created_by
       WHERE e.project_id = ?${kindSql} ORDER BY e.id`
    )
    .all(req.project.id, ...kindArg);
  const recs = db
    .prepare(
      `SELECT a.*, uu.name AS uploaded_by_name FROM audio_files a
       JOIN entries e ON e.id = a.entry_id
       JOIN users uu ON uu.id = a.uploaded_by
       WHERE e.project_id = ? AND a.is_current = 1${kindSql}${purposeSql}
       ORDER BY a.entry_id, a.language, a.id`
    )
    .all(req.project.id, ...kindArg);
  // Consent census over ALL current recordings in scope (pre purpose filter),
  // so the manifest states what was excluded and why.
  const census = db
    .prepare(
      `SELECT
         SUM(CASE WHEN a.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
         SUM(CASE WHEN a.revoked_at IS NULL AND a.consent_profile_name IS NULL THEN 1 ELSE 0 END) AS consent_unknown,
         SUM(CASE WHEN a.revoked_at IS NULL AND a.consent_profile_name IS NOT NULL THEN 1 ELSE 0 END) AS consented,
         COUNT(*) AS total
       FROM audio_files a JOIN entries e ON e.id = a.entry_id
       WHERE e.project_id = ? AND a.is_current = 1${kindSql}`
    )
    .get(req.project.id, ...kindArg);
  const orgRow = req.project.organization_id
    ? db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(req.project.organization_id)
    : null;

  // Pre-scan files BEFORE we start streaming (headers commit on first byte): collect
  // the include-list, checksums, and per-entry audio refs; skip any missing files.
  const files = [];         // { abs, name } to stream from disk
  const checksumLines = [];
  const audioByEntry = new Map();
  const recordingsJson = [];
  let masterCount = 0, legacyCount = 0, derivCount = 0, missing = 0;

  for (const a of recs) {
    const abs = path.join(AUDIO_DIR, a.stored_name);
    const bundlePath = `audio/${a.stored_name}`;
    if (!fs.existsSync(abs)) { missing++; continue; }
    let sha = a.sha256;
    if (!sha) {
      try { sha = await sha256File(abs); db.prepare('UPDATE audio_files SET sha256 = ? WHERE id = ?').run(sha, a.id); }
      catch { /* leave unchecked */ }
    }
    files.push({ abs, name: bundlePath });
    if (sha) checksumLines.push(`${sha}  ${bundlePath}`);
    if (a.archive_class === 'legacy_lossy') legacyCount++; else masterCount++;

    let derivPath = null;
    if (a.playback_stored_name) {
      const dabs = path.join(AUDIO_DIR, a.playback_stored_name);
      if (fs.existsSync(dabs)) {
        derivPath = `audio/${a.playback_stored_name}`;
        files.push({ abs: dabs, name: derivPath });
        derivCount++;
        try { checksumLines.push(`${await sha256File(dabs)}  ${derivPath}`); } catch { /* skip */ }
      }
    }

    if (!audioByEntry.has(a.entry_id)) audioByEntry.set(a.entry_id, []);
    audioByEntry.get(a.entry_id).push({ language: a.language, file: bundlePath });
    recordingsJson.push({
      entry_id: a.entry_id, language: a.language, speaker: a.speaker, uploaded_by: a.uploaded_by_name,
      archive_class: a.archive_class, duration_seconds: a.duration_seconds,
      sample_rate_hz: a.sample_rate_hz, channels: a.channels, bit_depth: a.bit_depth, codec: a.codec,
      sha256: sha ?? null, file: bundlePath, derivative: derivPath,
      consent: a.consent_profile_name
        ? {
            profile: a.consent_profile_name,
            method: a.consent_method,
            recorded_at: a.consent_recorded_at,
            permissions: Object.fromEntries(CONSENT_FLAGS.map((f) => [f, !!a[f]])),
            revoked_at: a.revoked_at,
          }
        : { profile: null, status: a.revoked_at ? 'revoked' : 'consent_unknown', revoked_at: a.revoked_at },
    });
  }

  // --- generated text files (built in memory so we can checksum them) ---
  const csvHeader = 'entry_id,kind,dene_text,english_text,category,source_doc,notes,status,contributor,created_at,updated_at,dene_audio_files,english_audio_files\n';
  const entriesCsv = '﻿' + csvHeader + rows.map((r) => {
    const au = audioByEntry.get(r.id) ?? [];
    return [
      r.id, r.kind, r.dene_text, r.english_text, r.category, r.source_doc, r.notes, r.status,
      r.contributor, r.created_at, r.updated_at,
      au.filter((x) => x.language === 'dene').map((x) => x.file).join(';'),
      au.filter((x) => x.language === 'english').map((x) => x.file).join(';'),
    ].map(csvEsc).join(',');
  }).join('\n') + '\n';
  const entriesJson = JSON.stringify(
    { project: { id: req.project.id, name: req.project.name, dialect: req.project.dialect },
      entries: rows.map((r) => ({ ...r, audio: audioByEntry.get(r.id) ?? [] })) }, null, 2);
  const speakerCount = new Map(), uploaderCount = new Map();
  for (const a of recordingsJson) {
    if (a.speaker) speakerCount.set(a.speaker, (speakerCount.get(a.speaker) ?? 0) + 1);
    uploaderCount.set(a.uploaded_by, (uploaderCount.get(a.uploaded_by) ?? 0) + 1);
  }
  const speakersJson = JSON.stringify({
    speakers: [...speakerCount].map(([name, recordings]) => ({ name, recordings })),
    uploaders: [...uploaderCount].map(([name, recordings]) => ({ name, recordings })),
  }, null, 2);
  const recordingsJsonStr = JSON.stringify({ recordings: recordingsJson }, null, 2);
  const manifest = {
    schema_version: '1.1',
    exported_at: new Date().toISOString(),
    application_version: pkg.version,
    organization: orgRow, // the data owner (#5)
    project: { id: req.project.id, name: req.project.name, dialect: req.project.dialect },
    kind: kind || 'all',
    permission_filter: purpose || null,
    entry_count: rows.length,
    recording_count: masterCount + legacyCount,
    master_audio_count: masterCount,
    legacy_lossy_audio_count: legacyCount,
    derivative_count: derivCount,
    missing_files: missing,
    consent: {
      consented: census.consented ?? 0,
      consent_unknown: census.consent_unknown ?? 0,
      revoked: census.revoked ?? 0,
      excluded_by_purpose_filter: purpose ? (census.total ?? 0) - (masterCount + legacyCount) : 0,
    },
    note: purpose
      ? `Purpose-filtered export ("${purpose}"): only recordings whose consent snapshot explicitly allows this use are included; consent-unknown and revoked recordings are excluded. Permission is never inferred from membership or visibility.`
      : 'Contains the current version of each recording. Superseded (re-recorded) master versions are retained in the application and are not included in this archive.',
  };
  const manifestStr = JSON.stringify(manifest, null, 2);
  const readme = [
    `Dene Voice Library — corpus export`,
    `Project: ${req.project.name}${req.project.dialect ? ` (${req.project.dialect})` : ''}`,
    `Exported: ${manifest.exported_at}  ·  app v${pkg.version}  ·  schema ${manifest.schema_version}`,
    ``,
    `Contents:`,
    `  manifest.json     summary + counts`,
    `  entries.csv/json  the dictionary/phrase entries`,
    `  recordings.json   one record per current recording, with audio properties + sha256`,
    `  speakers.json     speakers and uploaders with counts`,
    `  checksums.sha256  SHA-256 of every file below (verify: sha256sum -c checksums.sha256)`,
    `  audio/masters/    lossless WAV masters (source of truth)`,
    `  audio/derived/    disposable mono-MP3 playback copies (regenerable from masters)`,
    `  audio/<uid>/      legacy lossy source recordings (pre-dating lossless capture)`,
    ``,
    `Master checksums match the values stored in the application database.`,
    `${missing ? `NOTE: ${missing} referenced file(s) were missing on the server and were omitted.` : ''}`,
  ].join('\n');

  // permissions.json: the consent basis of every included recording plus the
  // audit trail of assignments/revocations for this project's recordings.
  const auditRows = db
    .prepare(
      `SELECT cc.audio_id, cc.action, cc.profile_name, cc.note, u.name AS changed_by, cc.changed_at
       FROM consent_changes cc
       JOIN audio_files a ON a.id = cc.audio_id
       JOIN entries e ON e.id = a.entry_id
       JOIN users u ON u.id = cc.changed_by
       WHERE e.project_id = ? ORDER BY cc.changed_at, cc.id`
    )
    .all(req.project.id);
  const permissionsJson = JSON.stringify({
    purpose_filter: purpose || null,
    flags: CONSENT_FLAGS,
    recordings: recordingsJson.map((r) => ({ file: r.file, consent: r.consent })),
    audit: auditRows,
  }, null, 2);

  // Text files also go into checksums.sha256 (which necessarily can't list itself).
  for (const [name, content] of [
    ['manifest.json', manifestStr], ['README.txt', readme], ['entries.csv', entriesCsv],
    ['entries.json', entriesJson], ['recordings.json', recordingsJsonStr], ['speakers.json', speakersJson],
    ['permissions.json', permissionsJson],
  ]) checksumLines.push(`${sha256Hex(content)}  ${name}`);
  const checksumsStr = checksumLines.join('\n') + '\n';

  // --- stream the ZIP ---
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${req.project.name.replace(/[^\w-]+/g, '_')}_${stamp}${kind ? `_${kind}s` : ''}${purpose ? `_${purpose}` : ''}_archive`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
  const archive = archiver('zip', { store: true }); // audio is incompressible; STORE keeps CPU low
  archive.on('warning', (err) => console.warn('[export] archive warning:', err.message));
  archive.on('error', (err) => { console.error('[export] archive error:', err.message); res.destroy(err); });
  archive.pipe(res);
  archive.append(manifestStr, { name: 'manifest.json' });
  archive.append(readme, { name: 'README.txt' });
  archive.append(entriesCsv, { name: 'entries.csv' });
  archive.append(entriesJson, { name: 'entries.json' });
  archive.append(recordingsJsonStr, { name: 'recordings.json' });
  archive.append(speakersJson, { name: 'speakers.json' });
  archive.append(permissionsJson, { name: 'permissions.json' });
  archive.append(checksumsStr, { name: 'checksums.sha256' });
  for (const f of files) archive.file(f.abs, { name: f.name });
  archive.finalize();
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

api.post('/projects/:id/import', requireOrgAdminOfProject, (req, res, next) => {
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
  const kind = req.body?.kind === 'phrase' ? 'phrase' : 'word';

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
  if (deneIdx >= 0 || engIdx >= 0) {
    dataRows = rows.slice(1); // recognizable header (one or both sides named)
  } else {
    deneIdx = 0;
    engIdx = 1;
    catIdx = 2; // no header: assume Dene, English, [Category]
    dataRows = rows;
  }
  // Words need both columns; phrases need at least one.
  if (kind === 'word' && (deneIdx < 0 || engIdx < 0)) {
    return bad(res, 'For a dictionary import, include both a Dene and an English column (header like "dene_text,english_text" or a two-column file).');
  }
  if (kind === 'phrase' && deneIdx < 0 && engIdx < 0) {
    return bad(res, 'Include a Dene and/or English column (header like "dene_text,english_text").');
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    return bad(res, `Too many rows (${dataRows.length}) — max ${MAX_IMPORT_ROWS} per import. Split the file and try again.`);
  }

  // Idempotent: skip pairs that already exist in the project, and duplicates
  // within the file itself.
  // Dedup is scoped by kind so the same text may exist as both a word and a phrase.
  const seen = new Set(
    db.prepare('SELECT dene_text, english_text FROM entries WHERE project_id = ? AND kind = ?')
      .all(project.id, kind)
      .map((e) => JSON.stringify([e.dene_text, e.english_text]))
  );
  const sourceDoc = `CSV import: ${req.file.originalname}`;
  const insert = db.prepare(
    `INSERT INTO entries (project_id, kind, dene_text, english_text, category, source_doc, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let imported = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  db.transaction(() => {
    for (const r of dataRows) {
      const dene = (deneIdx >= 0 ? r[deneIdx] ?? '' : '').trim();
      const english = (engIdx >= 0 ? r[engIdx] ?? '' : '').trim();
      const category = catIdx >= 0 ? (r[catIdx] ?? '').trim() || null : null;
      // Words require both sides; phrases require at least one.
      const valid = kind === 'phrase' ? (dene || english) : (dene && english);
      if (!valid) { skippedInvalid++; continue; }
      const key = JSON.stringify([dene, english]);
      if (seen.has(key)) { skippedDuplicates++; continue; }
      seen.add(key);
      insert.run(project.id, kind, dene, english, category, sourceDoc, req.user.id, req.user.id);
      imported++;
    }
  })();

  // Imported rows have no embeddings yet — embed them in the background so
  // semantic ("Smart") search works without waiting for a server restart.
  if (imported > 0) {
    backfillEmbeddings((m) => console.log('[embed:import]', m))
      .catch((e) => console.error('[embed:import] backfill failed:', e.message));
  }

  res.json({
    ok: true,
    imported,
    skipped_duplicates: skippedDuplicates,
    skipped_invalid: skippedInvalid,
    total_rows: dataRows.length,
  });
});

// ---------------------------------------------------------------------------
// Translator compensation — superadmin manages; translators see their own total
// ---------------------------------------------------------------------------

const sumWork = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM work_log WHERE user_id = ?');
const sumPaid = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE user_id = ?');

function totalsFor(userId) {
  const earned = sumWork.get(userId).c;
  const paid = sumPaid.get(userId).c;
  return { earned_cents: earned, paid_cents: paid, balance_cents: earned - paid };
}

// Shared by the superadmin detail and a translator's own view.
const workLogFor = db.prepare(
  `SELECT w.id, w.type, w.amount_cents, w.note, w.created_at, w.entry_id,
          p.name AS project_name, e.dene_text, e.english_text
   FROM work_log w
   LEFT JOIN projects p ON p.id = w.project_id
   LEFT JOIN entries e ON e.id = w.entry_id
   WHERE w.user_id = ? ORDER BY w.created_at DESC, w.id DESC`
);
const paymentsFor = db.prepare(
  `SELECT id, amount_cents, paid_on, method, note, created_at FROM payments
   WHERE user_id = ? ORDER BY COALESCE(paid_on, created_at) DESC, id DESC`
);

// Any signed-in user sees their own running total, work log, and payments.
api.get('/me/compensation', (req, res) => {
  res.json({
    ...totalsFor(req.user.id),
    work: workLogFor.all(req.user.id),
    payments: paymentsFor.all(req.user.id),
  });
});

// Compensation is ORGANIZATION authority, not platform administration — and
// admin views are STRICTLY tenant-scoped: sharing one org with a contributor
// authorizes seeing that org's slice of their work, never their whole account.
// Scoping filters on the PERSISTED organization_id of ledger/payment rows (it
// survives project deletion). The contributor's own /me view stays global.
function requireAnyOrgAdmin(req, res, next) {
  const ids = adminOrgIdsFor(req.user);
  if (!ids.length) return bad(res, 'Organization admin access required', 403);
  req.adminOrgIds = ids;
  next();
}

const orgPh = (req) => req.adminOrgIds.map(() => '?').join(',');

/** Is this user connected (membership, ledger, or payment) to the caller's
 *  admin orgs? */
function userInAdminOrgs(req, userId) {
  const ph = orgPh(req);
  return !!db
    .prepare(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM memberships m JOIN projects p ON p.id = m.project_id
         WHERE m.user_id = ? AND p.organization_id IN (${ph}))
       OR EXISTS (SELECT 1 FROM work_log w WHERE w.user_id = ? AND w.organization_id IN (${ph}))
       OR EXISTS (SELECT 1 FROM payments py WHERE py.user_id = ? AND py.organization_id IN (${ph}))`
    )
    .get(userId, ...req.adminOrgIds, userId, ...req.adminOrgIds, userId, ...req.adminOrgIds);
}

// Org-scoped variants of the /me queries, for administrator views.
function totalsScoped(userId, orgIds) {
  const ph = orgIds.map(() => '?').join(',');
  const earned = db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM work_log WHERE user_id = ? AND organization_id IN (${ph})`)
    .get(userId, ...orgIds).c;
  const paid = db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE user_id = ? AND organization_id IN (${ph})`)
    .get(userId, ...orgIds).c;
  return { earned_cents: earned, paid_cents: paid, balance_cents: earned - paid };
}
function workLogScoped(userId, orgIds) {
  const ph = orgIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT w.id, w.type, w.amount_cents, w.note, w.created_at, w.entry_id,
              p.name AS project_name, e.dene_text, e.english_text
       FROM work_log w
       LEFT JOIN projects p ON p.id = w.project_id
       LEFT JOIN entries e ON e.id = w.entry_id
       WHERE w.user_id = ? AND w.organization_id IN (${ph})
       ORDER BY w.created_at DESC, w.id DESC`
    )
    .all(userId, ...orgIds);
}
function paymentsScoped(userId, orgIds) {
  const ph = orgIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, amount_cents, paid_on, method, note, created_at FROM payments
       WHERE user_id = ? AND organization_id IN (${ph})
       ORDER BY COALESCE(paid_on, created_at) DESC, id DESC`
    )
    .all(userId, ...orgIds);
}

// Everyone there is money to account for in the caller's orgs: current/past
// translators and anyone with org-attributed ledger or payment history there.
api.get('/compensation', requireAnyOrgAdmin, (req, res) => {
  const ph = orgPh(req);
  const people = db
    .prepare(
      `SELECT u.id, u.name, u.email FROM users u
       WHERE u.id IN (SELECT m.user_id FROM memberships m JOIN projects p ON p.id = m.project_id
                       WHERE m.role = 'translator' AND p.organization_id IN (${ph}))
          OR u.id IN (SELECT w.user_id FROM work_log w WHERE w.organization_id IN (${ph}))
          OR u.id IN (SELECT py.user_id FROM payments py WHERE py.organization_id IN (${ph}))
       ORDER BY u.name`
    )
    .all(...req.adminOrgIds, ...req.adminOrgIds, ...req.adminOrgIds);
  res.json({ translators: people.map((p) => ({ ...p, ...totalsScoped(p.id, req.adminOrgIds) })) });
});

api.get('/compensation/:userId', requireAnyOrgAdmin, (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return bad(res, 'User not found', 404);
  if (!userInAdminOrgs(req, user.id)) return bad(res, 'Organization admin access required', 403);
  const ph = orgPh(req);
  const rates = db
    .prepare(
      `SELECT r.project_id, p.name AS project_name, r.type, r.rate_cents, r.updated_at
       FROM translator_rates r JOIN projects p ON p.id = r.project_id
       WHERE r.user_id = ? AND p.organization_id IN (${ph}) ORDER BY p.name, r.type`
    )
    .all(user.id, ...req.adminOrgIds);
  const work = workLogScoped(user.id, req.adminOrgIds);
  const payments = paymentsScoped(user.id, req.adminOrgIds);
  // Projects the person belongs to WITHIN the caller's orgs — the set rates
  // can be managed for.
  const projects = db
    .prepare(
      `SELECT p.id, p.name FROM projects p JOIN memberships m ON m.project_id = p.id
       WHERE m.user_id = ? AND p.organization_id IN (${ph}) ORDER BY p.name`
    )
    .all(user.id, ...req.adminOrgIds);
  res.json({ user, ...totalsScoped(user.id, req.adminOrgIds), rates, work, payments, projects });
});

// Set or change a per-project rate; logs an audit row.
api.put('/compensation/:userId/rates', requireAnyOrgAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return bad(res, 'User not found', 404);
  const projectId = Number(req.body?.project_id);
  const type = req.body?.type;
  const rateCents = Math.round(Number(req.body?.rate_cents));
  const project = projectId ? db.prepare('SELECT organization_id FROM projects WHERE id = ?').get(projectId) : null;
  if (!project) return bad(res, 'A valid project is required');
  if (!req.adminOrgIds.includes(project.organization_id)) {
    return bad(res, 'Organization admin access required', 403);
  }
  if (type !== 'translation' && type !== 'recording') return bad(res, 'Invalid rate type');
  if (!Number.isFinite(rateCents) || rateCents < 0) return bad(res, 'Rate must be zero or more');
  const existing = db
    .prepare('SELECT rate_cents FROM translator_rates WHERE user_id = ? AND project_id = ? AND type = ?')
    .get(user.id, projectId, type);
  db.prepare(
    `INSERT INTO translator_rates (user_id, project_id, type, rate_cents, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, project_id, type) DO UPDATE SET
       rate_cents = excluded.rate_cents, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(user.id, projectId, type, rateCents, req.user.id);
  db.prepare(
    `INSERT INTO rate_changes (user_id, project_id, type, old_cents, new_cents, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.id, projectId, type, existing?.rate_cents ?? null, rateCents, req.user.id);
  res.json({ ok: true });
});

// Resolve which org a new payment/adjustment is on behalf of: the caller's sole
// admin org by default, else an explicit organization_id from the body
// (validated against the caller's admin orgs). Mirrors POST /projects.
function resolveMoneyOrg(req, res) {
  let orgId = req.body?.organization_id ? Number(req.body.organization_id) : null;
  if (orgId) {
    if (!req.adminOrgIds.includes(orgId)) { bad(res, 'Organization admin access required', 403); return null; }
  } else if (req.adminOrgIds.length === 1) {
    orgId = req.adminOrgIds[0];
  } else {
    bad(res, 'You administer multiple organizations — specify organization_id'); return null;
  }
  return orgId;
}

// Record a payment already made offline (the app never moves money). Stamped
// with the paying organization for tenant scoping.
api.post('/compensation/:userId/payments', requireAnyOrgAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return bad(res, 'User not found', 404);
  if (!userInAdminOrgs(req, user.id)) return bad(res, 'Organization admin access required', 403);
  const orgId = resolveMoneyOrg(req, res);
  if (!orgId) return;
  const amount = Math.round(Number(req.body?.amount_cents));
  if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'Payment amount must be greater than zero');
  const paidOn = req.body?.paid_on?.trim() || new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO payments (user_id, amount_cents, paid_on, method, note, organization_id, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, amount, paidOn, req.body?.method?.trim() || null, req.body?.note?.trim() || null, orgId, req.user.id);
  res.status(201).json({ ok: true, ...totalsScoped(user.id, req.adminOrgIds) });
});

// Manual ledger adjustment (+/-): bonuses, corrections, pricing unrated work.
// A project is required so the adjustment is org-attributable.
api.post('/compensation/:userId/adjustments', requireAnyOrgAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return bad(res, 'User not found', 404);
  if (!userInAdminOrgs(req, user.id)) return bad(res, 'Organization admin access required', 403);
  const amount = Math.round(Number(req.body?.amount_cents));
  if (!Number.isFinite(amount) || amount === 0) return bad(res, 'Adjustment amount cannot be zero');
  const note = req.body?.note?.trim();
  if (!note) return bad(res, 'An adjustment note is required');
  const projectId = Number(req.body?.project_id);
  const proj = projectId ? db.prepare('SELECT organization_id FROM projects WHERE id = ?').get(projectId) : null;
  if (!proj) return bad(res, 'A project is required so the adjustment is attributed to an organization');
  if (!req.adminOrgIds.includes(proj.organization_id)) {
    return bad(res, 'Organization admin access required', 403);
  }
  db.prepare(
    `INSERT INTO work_log (user_id, project_id, type, amount_cents, note, organization_id, created_by)
     VALUES (?, ?, 'adjustment', ?, ?, ?, ?)`
  ).run(user.id, projectId, amount, note, proj.organization_id, req.user.id);
  res.status(201).json({ ok: true, ...totalsScoped(user.id, req.adminOrgIds) });
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
