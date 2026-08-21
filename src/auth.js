import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from './db.js';

const SESSION_DAYS = 30;
export const COOKIE_NAME = 'dene_session';

// Sessions are stored HASHED at rest (hardening #10): the DB holds
// sha256(token), the raw high-entropy token lives only in the client cookie.
// Database exfiltration therefore never yields usable bearer tokens — the same
// pattern password-reset tokens already use.
const hashSessionToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  ).run(hashSessionToken(token), userId);
  return token; // raw token goes to the cookie only
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(hashSessionToken(token));
}

/** Sign the user out everywhere EXCEPT the session identified by keepRawToken
 *  (used after a self-service password change: other devices lose access, the
 *  session that changed the password stays signed in). */
export function destroyOtherSessions(userId, keepRawToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
    .run(userId, hashSessionToken(keepRawToken ?? ''));
}

export function userForToken(token) {
  if (!token) return null;
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_superadmin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(hashSessionToken(token));
}

/** Express middleware: attach req.user or reject with 401. */
export function requireAuth(req, res, next) {
  const user = userForToken(req.cookies[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

export function requireSuperadmin(req, res, next) {
  if (!req.user.is_superadmin) {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
  };
}
