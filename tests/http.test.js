import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, openDatabase } from '../src/server/db.js';
import { Router } from '../src/server/http.js';
import { startApp } from './helpers.js';

test('router matches params and reports wrong methods', () => {
  const r = new Router();
  r.get('/api/channels/:id/messages', () => 'list');
  const hit = r.match('GET', '/api/channels/42/messages');
  assert.deepEqual(hit.params, { id: '42' });
  assert.equal(r.match('POST', '/api/channels/42/messages').methodNotAllowed, true);
  assert.equal(r.match('GET', '/api/channels/42'), null);
});

test('migrations run once and record the schema version', () => {
  const db = openDatabase(':memory:');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(version >= 1);
  assert.equal(migrate(db), version);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
  db.close();
});

test('health, 404 and 405 responses are JSON', async (t) => {
  const { client } = await startApp(t);
  const c = client();
  assert.deepEqual((await c.get('/api/health')).body, { ok: true });
  const missing = await c.get('/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not found');
  assert.equal((await c.post('/api/health')).status, 405);
});

test('static files are served and paths cannot escape the public folder', async (t) => {
  const { base } = await startApp(t);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const spa = await fetch(`${base}/c/general`);
  assert.equal(spa.status, 200);
  const escape = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(escape.status, 404);
});
