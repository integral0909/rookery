import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../src/server/auth.js';
import { createSession, userForToken } from '../src/server/auth.js';
import { openDatabase } from '../src/server/db.js';
import { run } from '../src/cli.js';

function cli() {
  const db = openDatabase(':memory:');
  const lines = [];
  const exec = (args, env = {}) => run(args, { db, print: (l) => lines.push(l), env });
  return { db, lines, exec };
}

test('user create makes the first account an admin and joins #general', async () => {
  const { db, lines, exec } = cli();
  await exec(['user', 'create', 'ada'], { ROOKERY_PASSWORD: 'lovelace!' });
  await exec(['user', 'create', 'grace']);
  const ada = db.prepare('SELECT * FROM users WHERE username = ?').get('ada');
  assert.equal(ada.is_admin, 1);
  assert.equal(await verifyPassword('lovelace!', ada.password_hash), true);
  assert.match(lines[1], /^created grace with password \S{16}$/);
  const general = db.prepare("SELECT id FROM channels WHERE name = 'general'").get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE channel_id = ?').get(general.id).n, 2);
  await assert.rejects(exec(['user', 'create', 'ada']), /already exists/);
  await assert.rejects(exec(['user', 'create', 'bad name']), /invalid username/);
});

test('reset-password, promote and deactivate end sessions where needed', async () => {
  const { db, exec } = cli();
  await exec(['user', 'create', 'ada'], { ROOKERY_PASSWORD: 'first-pass' });
  await exec(['user', 'create', 'grace'], { ROOKERY_PASSWORD: 'first-pass' });
  const grace = db.prepare("SELECT id FROM users WHERE username = 'grace'").get().id;
  const token = createSession(db, grace);
  await exec(['user', 'reset-password', 'grace'], { ROOKERY_PASSWORD: 'second-pass' });
  assert.equal(userForToken(db, token), null);
  const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(grace).password_hash;
  assert.equal(await verifyPassword('second-pass', hash), true);
  await exec(['user', 'promote', 'grace']);
  assert.equal(db.prepare('SELECT is_admin FROM users WHERE id = ?').get(grace).is_admin, 1);
  const token2 = createSession(db, grace);
  await exec(['user', 'deactivate', 'grace']);
  assert.equal(userForToken(db, token2), null);
  await assert.rejects(exec(['user', 'promote', 'nobody']), /no user called nobody/);
});

test('backup writes a readable copy and refuses to overwrite', async () => {
  const { exec } = cli();
  await exec(['demo']);
  const file = join(mkdtempSync(join(tmpdir(), 'rookery-backup-')), 'copy.db');
  await exec(['backup', file]);
  const copy = new DatabaseSync(file);
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 10);
  assert.ok(copy.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'export'").get().n > 0);
  copy.close();
  await assert.rejects(exec(['backup', file]), /already exists/);
});

test('demo data only goes into an empty database; stats and help print', async () => {
  const { lines, exec } = cli();
  await exec(['demo']);
  assert.match(lines.at(-1), /demo team created: maya, tomas, priya, jun, elena/);
  await assert.rejects(exec(['demo']), /empty database/);
  lines.length = 0;
  await exec(['stats']);
  assert.match(lines[0], /users\s+5 active/);
  assert.match(lines[1], /3 public, 1 private, 1 direct/);
  lines.length = 0;
  await exec([]);
  assert.match(lines[0], /^Usage/);
  await assert.rejects(exec(['frobnicate']), /unknown command/);
});
