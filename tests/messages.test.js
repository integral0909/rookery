import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBody } from '../src/server/model/messages.js';
import { startApp } from './helpers.js';

async function setup(t) {
  const env = await startApp(t);
  const ada = env.client();
  const grace = env.client();
  ada.user = (await ada.post('/api/auth/register', { username: 'ada', password: 'lovelace!' })).body.user;
  grace.user = (await grace.post('/api/auth/register', { username: 'grace', password: 'hopper123' })).body.user;
  const general = (await ada.get('/api/channels')).body.channels[0];
  return { ...env, ada, grace, general, path: `/api/channels/${general.id}/messages` };
}

test('message bodies are normalised', () => {
  assert.equal(normalizeBody('  hello  \r\n\r\n\r\n\r\nworld   '), 'hello\n\nworld');
  assert.throws(() => normalizeBody('   \n  '), /empty/);
  assert.throws(() => normalizeBody('x'.repeat(4001)), /limited/);
  assert.throws(() => normalizeBody(42), /string/);
});

test('post and page through history', async (t) => {
  const { ada, path } = await setup(t);
  for (let i = 1; i <= 7; i++) assert.equal((await ada.post(path, { body: `m${i}` })).status, 200);
  const last = (await ada.get(`${path}?limit=3`)).body;
  assert.deepEqual(last.messages.map((m) => m.body), ['m5', 'm6', 'm7']);
  assert.equal(last.hasMore, true);
  const older = (await ada.get(`${path}?limit=3&before=${last.messages[0].id}`)).body;
  assert.deepEqual(older.messages.map((m) => m.body), ['m2', 'm3', 'm4']);
  const oldest = (await ada.get(`${path}?limit=3&before=${older.messages[0].id}`)).body;
  assert.deepEqual(oldest.messages.map((m) => m.body), ['m1']);
  assert.equal(oldest.hasMore, false);
  const newer = (await ada.get(`${path}?limit=10&after=${older.messages[2].id}`)).body;
  assert.deepEqual(newer.messages.map((m) => m.body), ['m5', 'm6', 'm7']);
  const mid = (await ada.get(`${path}?limit=4&around=${older.messages[1].id}`)).body;
  assert.deepEqual(mid.messages.map((m) => m.body), ['m1', 'm2', 'm3', 'm4']);
  assert.equal((await ada.get(`${path}?limit=0`)).status, 400);
});

test('threads keep replies out of the channel history', async (t) => {
  const { ada, grace, path } = await setup(t);
  const root = (await ada.post(path, { body: 'Release on Friday?' })).body.message;
  await grace.post(path, { body: 'Yes', parentId: root.id });
  const reply2 = (await ada.post(path, { body: 'Great', parentId: root.id })).body.message;
  assert.equal(reply2.parentId, root.id);
  // Replies to replies are refused; threads are one level deep.
  assert.equal((await ada.post(path, { body: 'nested', parentId: reply2.id })).status, 400);
  const history = (await ada.get(path)).body.messages;
  assert.deepEqual(history.map((m) => m.body), ['Release on Friday?']);
  assert.equal(history[0].replyCount, 2);
  const thread = (await grace.get(`/api/messages/${reply2.id}/thread`)).body;
  assert.equal(thread.root.id, root.id);
  assert.deepEqual(thread.replies.map((m) => m.body), ['Yes', 'Great']);
});

test('replies must belong to the same channel', async (t) => {
  const { ada, path } = await setup(t);
  const root = (await ada.post(path, { body: 'here' })).body.message;
  const other = (await ada.post('/api/channels', { name: 'random' })).body.channel;
  const res = await ada.post(`/api/channels/${other.id}/messages`, { body: 'there', parentId: root.id });
  assert.equal(res.status, 404);
});

test('only authors edit; authors and owners delete', async (t) => {
  const { ada, grace, path } = await setup(t);
  const mine = (await grace.post(path, { body: 'typo herre' })).body.message;
  assert.equal((await ada.patch(`/api/messages/${mine.id}`, { body: 'hijack' })).status, 403);
  const edited = (await grace.patch(`/api/messages/${mine.id}`, { body: 'typo here' })).body.message;
  assert.equal(edited.body, 'typo here');
  assert.ok(edited.editedAt >= edited.createdAt);

  // ada created #general, so she owns it and can moderate.
  assert.equal((await ada.delete(`/api/messages/${mine.id}`)).status, 204);
  const gone = (await grace.get(`/api/messages/${mine.id}`)).body.message;
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, '');
  assert.equal((await grace.patch(`/api/messages/${mine.id}`, { body: 'back' })).status, 409);

  const adas = (await ada.post(path, { body: 'mine' })).body.message;
  assert.equal((await grace.delete(`/api/messages/${adas.id}`)).status, 403);
});

test('messages in private channels are hidden from outsiders', async (t) => {
  const { ada, grace } = await setup(t);
  const ch = (await ada.post('/api/channels', { name: 'hush', private: true })).body.channel;
  const msg = (await ada.post(`/api/channels/${ch.id}/messages`, { body: 'secret' })).body.message;
  assert.equal((await grace.get(`/api/messages/${msg.id}`)).status, 404);
  assert.equal((await grace.get(`/api/messages/${msg.id}/thread`)).status, 404);
  assert.equal((await grace.delete(`/api/messages/${msg.id}`)).status, 404);
});
