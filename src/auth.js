import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from './db.js';

const SESSION_DAYS = 30;
export const COOKIE_NAME = 'dene_session';

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
  ).run(token, userId);
  return token;
}

export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
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
    .get(token);
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
