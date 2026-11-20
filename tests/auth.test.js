import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, parseCookies, Throttle, verifyPassword } from '../src/server/auth.js';
import { startApp } from './helpers.js';

test('password hashes verify and differ per salt', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong horse', a), false);
  assert.equal(await verifyPassword('x', 'plain$text'), false);
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; rookery_session=abc%3D; empty='), { a: '1', rookery_session: 'abc=', empty: '' });
});

test('throttle locks a key after the limit and expires', () => {
  let now = 0;
  const t = new Throttle({ limit: 2, windowMs: 1000, now: () => now });
  t.fail('x');
  t.fail('x');
  assert.throws(() => t.check('x'), /too many attempts/);
  t.check('y');
  now = 1500;
  t.check('x');
});

test('the first account is an admin, later ones are not', async (t) => {
  const { client } = await startApp(t);
  const a = client();
  const first = await a.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  assert.equal(first.status, 200);
  assert.equal(first.body.user.isAdmin, true);
  assert.equal(first.body.user.displayName, 'ada');
  const second = await client().post('/api/auth/register', { username: 'grace', displayName: 'Grace H', password: 'hopper123' });
  assert.equal(second.body.user.isAdmin, false);
  assert.equal(second.body.user.displayName, 'Grace H');
});

test('register validates input and rejects duplicate usernames case-insensitively', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  assert.equal((await c.post('/api/auth/register', { username: 'a', password: 'longenough' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { username: 'bad name', password: 'longenough' })).status, 400);
  const short = await c.post('/api/auth/register', { username: 'okay', password: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /password/);
  await c.post('/api/auth/register', { username: 'Linus', password: 'longenough' });
  const dup = await client().post('/api/auth/register', { username: 'linus', password: 'longenough' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'username_taken');
});

test('sessions: me, logout, login, wrong password', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  assert.equal((await c.get('/api/me')).status, 401);
  await c.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  assert.equal((await c.get('/api/me')).body.user.username, 'ada');
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'ada', password: 'nope-nope' })).status, 401);
  const ok = await c.post('/api/auth/login', { username: 'ADA', password: 'lovelace!' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
});

test('session cookie is HttpOnly and SameSite', async (t) => {
  const { client } = await startApp(t);
  const res = await client().post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('changing the password signs out other sessions only', async (t) => {
  const { client } = await startApp(t);
  const laptop = client();
  const phone = client();
  await laptop.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  await phone.post('/api/auth/login', { username: 'ada', password: 'lovelace!' });
  const bad = await laptop.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'babbage!!' });
  assert.equal(bad.status, 403);
  assert.equal((await laptop.post('/api/me/password', { currentPassword: 'lovelace!', newPassword: 'babbage!!' })).status, 204);
  assert.equal((await laptop.get('/api/me')).status, 200);
  assert.equal((await phone.get('/api/me')).status, 401);
  assert.equal((await client().post('/api/auth/login', { username: 'ada', password: 'babbage!!' })).status, 200);
});

test('cross-origin writes are refused', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'ada', password: 'lovelace!' }),
  });
  assert.equal(res.status, 403);
});

test('login is throttled after repeated failures', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  await c.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  for (let i = 0; i < 10; i++) await c.post('/api/auth/login', { username: 'ada', password: 'guess' + i });
  const locked = await c.post('/api/auth/login', { username: 'ada', password: 'lovelace!' });
  assert.equal(locked.status, 429);
});

test('admins can close sign-up and deactivate users', async (t) => {
  const { client } = await startApp(t);
  const admin = client();
  await admin.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  const grace = client();
  const g = await grace.post('/api/auth/register', { username: 'grace', password: 'hopper123' });
  assert.equal((await grace.patch('/api/admin/settings', { openSignup: false })).status, 403);
  assert.deepEqual((await admin.patch('/api/admin/settings', { openSignup: false })).body, { openSignup: false });
  const closed = await client().post('/api/auth/register', { username: 'linus', password: 'longenough' });
  assert.equal(closed.body.code, 'signup_closed');

  const off = await admin.patch(`/api/admin/users/${g.body.user.id}`, { deactivated: true });
  assert.equal(off.body.user.deactivated, true);
  assert.equal((await grace.get('/api/me')).status, 401);
  assert.equal((await client().post('/api/auth/login', { username: 'grace', password: 'hopper123' })).status, 401);
});

test('user directory search escapes LIKE wildcards', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  await c.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  await client().post('/api/auth/register', { username: 'a_b', password: 'longenough' });
  await client().post('/api/auth/register', { username: 'axb', password: 'longenough' });
  const found = await c.get('/api/users?q=a_');
  assert.deepEqual(found.body.users.map((u) => u.username), ['a_b']);
  assert.equal((await c.get('/api/users')).body.users.length, 3);
});
