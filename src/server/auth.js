import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'rookery_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// Stored as scrypt$N$r$p$salt$hash so the cost can be raised later without
// invalidating existing passwords.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(db, userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now + SESSION_DAYS * 86400_000,
  );
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(db, userId, exceptToken = null) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function userForToken(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.deactivated_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row || row.expires_at <= now || row.deactivated_at) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin };
}

export function pruneSessions(db, now = Date.now()) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure = false } = {}) {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

// State-changing requests from a browser must come from our own origin.
// Requests without an Origin header (curl, tests, same-origin GETs) pass.
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'bad origin');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
}

// Counts failed logins per key (username or address) in a sliding window.
export class Throttle {
  constructor({ limit = 10, windowMs = 15 * 60_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map();
  }

  check(key) {
    const recent = this.#recent(key);
    if (recent.length >= this.limit) {
      const retry = Math.ceil((recent[0] + this.windowMs - this.now()) / 1000);
      throw new HttpError(429, `too many attempts, try again in ${retry}s`);
    }
  }

  fail(key) {
    const recent = this.#recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  reset(key) {
    this.failures.delete(key);
  }

  #recent(key) {
    const cutoff = this.now() - this.windowMs;
    return (this.failures.get(key) || []).filter((t) => t > cutoff);
  }
}
