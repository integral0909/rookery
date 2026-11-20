import {
  clearedCookie,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  sessionCookie,
  Throttle,
  tokenFromRequest,
  verifyPassword,
} from '../auth.js';
import { HttpError, readJson } from '../http.js';
import { bool, id, text, USERNAME } from '../validate.js';

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    deactivated: !!row.deactivated_at,
  };
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export default function users(router, { secureCookies = false } = {}) {
  const throttle = new Throttle();
  const cookie = (token) => sessionCookie(token, { secure: secureCookies });

  router.post('/api/auth/register', async ({ req, res, db, hooks, limits, address }) => {
    const body = await readJson(req);
    const username = text(body, 'username', { min: 2, max: 32, pattern: USERNAME });
    const displayName = text(body, 'displayName', { max: 64, optional: true }) || username;
    const password = text(body, 'password', { min: 8, max: 200, trim: false });

    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count > 0 && !getSetting(db, 'openSignup', true)) {
      throw new HttpError(403, 'sign-up is closed on this server', 'signup_closed');
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'that username is taken', 'username_taken');
    }
    limits.signup.take(address);
    const hash = await hashPassword(password);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(username, displayName, hash, Date.now(), count === 0 ? 1 : 0);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid));
    hooks.emit('userCreated', user);
    res.setHeader('set-cookie', cookie(createSession(db, user.id)));
    return { user };
  });

  router.post('/api/auth/login', async ({ req, res, db }) => {
    const body = await readJson(req);
    const username = text(body, 'username', { max: 32 });
    const password = text(body, 'password', { max: 200, trim: false });
    const key = username.toLowerCase();
    throttle.check(key);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = row && !row.deactivated_at && (await verifyPassword(password, row.password_hash));
    if (!ok) {
      throttle.fail(key);
      throw new HttpError(401, 'wrong username or password', 'bad_credentials');
    }
    throttle.reset(key);
    res.setHeader('set-cookie', cookie(createSession(db, row.id)));
    return { user: publicUser(row) };
  });

  router.post('/api/auth/logout', ({ req, res, db }) => {
    destroySession(db, tokenFromRequest(req));
    res.setHeader('set-cookie', clearedCookie());
  });

  router.get('/api/me', ({ db, requireUser }) => {
    const me = requireUser();
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(me.id)) };
  });

  router.patch('/api/me', async ({ req, db, requireUser, hooks }) => {
    const me = requireUser();
    const body = await readJson(req);
    const displayName = text(body, 'displayName', { max: 64 });
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, me.id);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(me.id));
    hooks.emit('userUpdated', user);
    return { user };
  });

  router.post('/api/me/password', async ({ req, db, requireUser }) => {
    const me = requireUser();
    const body = await readJson(req);
    const current = text(body, 'currentPassword', { max: 200, trim: false });
    const next = text(body, 'newPassword', { min: 8, max: 200, trim: false });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
    if (!(await verifyPassword(current, row.password_hash))) {
      throw new HttpError(403, 'current password is wrong', 'bad_credentials');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), me.id);
    // Sign out everywhere else; the session making this request stays.
    destroyUserSessions(db, me.id, tokenFromRequest(req));
  });

  router.get('/api/users', ({ url, db, requireUser }) => {
    requireUser();
    const q = (url.searchParams.get('q') || '').trim();
    const rows = q
      ? db
          .prepare(
            `SELECT * FROM users
              WHERE deactivated_at IS NULL AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
              ORDER BY username LIMIT 20`,
          )
          .all(...Array(2).fill(`%${q.replace(/[\\%_]/g, '\\$&')}%`))
      : db.prepare('SELECT * FROM users ORDER BY username LIMIT 500').all();
    return { users: rows.map(publicUser) };
  });

  router.get('/api/admin/settings', ({ db, requireAdmin }) => {
    requireAdmin();
    return { openSignup: getSetting(db, 'openSignup', true) };
  });

  router.patch('/api/admin/settings', async ({ req, db, requireAdmin }) => {
    requireAdmin();
    const body = await readJson(req);
    const openSignup = bool(body, 'openSignup', { optional: true });
    if (openSignup !== undefined) setSetting(db, 'openSignup', openSignup);
    return { openSignup: getSetting(db, 'openSignup', true) };
  });

  router.patch('/api/admin/users/:id', async ({ req, params, db, requireAdmin, hooks }) => {
    const admin = requireAdmin();
    const userId = id(params.id);
    const body = await readJson(req);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, 'no such user');
    if (userId === admin.id) throw new HttpError(400, 'you cannot change your own admin status or account here');
    const deactivated = bool(body, 'deactivated', { optional: true });
    const isAdmin = bool(body, 'isAdmin', { optional: true });
    if (deactivated !== undefined) {
      db.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(deactivated ? Date.now() : null, userId);
      if (deactivated) destroyUserSessions(db, userId);
    }
    if (isAdmin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    hooks.emit('userUpdated', user);
    if (user.deactivated) hooks.emit('userDeactivated', user);
    return { user };
  });
}
