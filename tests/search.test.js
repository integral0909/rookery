import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ftsExpression, MARK_END, MARK_START, parseQuery } from '../src/server/search.js';
import { startApp } from './helpers.js';

test('query parsing pulls out filters, phrases and negations', () => {
  const p = parseQuery('deploy "blue green" -staging from:@Ada in:#Ops after:2026-01-02 is:thread note:x');
  assert.deepEqual(p.terms, [
    { text: 'deploy', neg: false },
    { text: 'staging', neg: true },
    { text: 'note:x', neg: false },
  ]);
  assert.deepEqual(p.phrases, [{ text: 'blue green', neg: false }]);
  assert.deepEqual(p.from, ['ada']);
  assert.deepEqual(p.in, ['ops']);
  assert.equal(p.after, Date.UTC(2026, 0, 2));
  assert.ok(p.is.has('thread'));
  assert.throws(() => parseQuery('before:2026-02-30'), /date/);
  assert.throws(() => parseQuery('on:yesterday'), /date/);
});

test('FTS expressions quote everything and prefix the last word', () => {
  assert.equal(ftsExpression(parseQuery('deploy serv')), '"deploy" AND "serv"*');
  assert.equal(ftsExpression(parseQuery('a" OR b')), '"a" AND "OR" AND "b"');
  assert.equal(ftsExpression(parseQuery('NEAR(x y) *')), '("NEAR" "x") AND "y"');
  assert.equal(ftsExpression(parseQuery('"exact words" -spam')), '("exact words") NOT "spam"');
  assert.equal(ftsExpression(parseQuery('-only')), null);
});

async function setup(t) {
  const env = await startApp(t);
  const ada = env.client();
  const grace = env.client();
  ada.user = (await ada.post('/api/auth/register', { username: 'ada', password: 'lovelace!' })).body.user;
  grace.user = (await grace.post('/api/auth/register', { username: 'grace', password: 'hopper123' })).body.user;
  const general = (await ada.get('/api/channels')).body.channels[0];
  const ops = (await ada.post('/api/channels', { name: 'ops' })).body.channel;
  const hush = (await ada.post('/api/channels', { name: 'hush', private: true })).body.channel;
  const say = async (c, ch, body, extra) => (await c.post(`/api/channels/${ch.id}/messages`, { body, ...extra })).body.message;
  const find = async (c, q) => (await c.get(`/api/search?q=${encodeURIComponent(q)}`)).body;
  return { ...env, ada, grace, general, ops, hush, say, find };
}

test('search finds stemmed words with highlighted snippets', async (t) => {
  const { ada, grace, general, say, find } = await setup(t);
  await say(ada, general, 'We are deploying the new servers tonight');
  await say(grace, general, 'Lunch is at noon');
  const r = await find(grace, 'deploy server');
  assert.equal(r.total, 1);
  assert.equal(r.results[0].channel.name, 'general');
  assert.ok(r.results[0].snippet.includes(`${MARK_START}deploying${MARK_END}`));
  assert.equal((await find(grace, 'lun')).total, 1, 'prefix match while typing');
  assert.equal((await find(grace, 'café')).total, 0);
  await say(ada, general, 'Meet at the cafe');
  assert.equal((await find(grace, 'café')).total, 1, 'diacritics are folded');
});

test('private channels are only searchable by their members', async (t) => {
  const { ada, grace, hush, ops, say, find } = await setup(t);
  await say(ada, hush, 'quarterly numbers look great');
  await say(ada, ops, 'quarterly patching window');
  assert.equal((await find(ada, 'quarterly')).total, 2);
  const g = await find(grace, 'quarterly');
  assert.equal(g.total, 1);
  assert.equal(g.results[0].channel.name, 'ops', 'public channels are searchable without joining');
});

test('filters narrow results, even without words', async (t) => {
  const { ada, grace, general, ops, say, find } = await setup(t);
  await grace.post(`/api/channels/${ops.id}/join`);
  const root = await say(ada, ops, 'rollback plan for release');
  await say(grace, ops, 'release notes drafted', { parentId: root.id });
  await say(grace, general, 'release party friday');
  assert.equal((await find(ada, 'release from:@grace')).total, 2);
  assert.equal((await find(grace, 'release from:me in:#ops')).total, 1);
  assert.equal((await find(ada, 'release is:thread')).total, 2);
  assert.equal((await find(ada, 'release -party')).total, 2);
  assert.equal((await find(ada, 'from:@ada')).total, 1);
  assert.equal((await find(ada, 'in:#general')).total, 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await find(ada, `release on:${today}`)).total, 3);
  assert.equal((await find(ada, `release before:${today}`)).total, 0);
  await ada.put(`/api/messages/${root.id}/reactions/${encodeURIComponent('👍')}`);
  assert.equal((await find(ada, 'has:reaction')).total, 1);
});

test('edits re-index and deletions disappear from search', async (t) => {
  const { ada, general, say, find } = await setup(t);
  const m = await say(ada, general, 'the password is hunter2');
  assert.equal((await find(ada, 'hunter2')).total, 1);
  await ada.patch(`/api/messages/${m.id}`, { body: 'the password is in the vault' });
  assert.equal((await find(ada, 'hunter2')).total, 0);
  assert.equal((await find(ada, 'vault')).total, 1);
  await ada.delete(`/api/messages/${m.id}`);
  assert.equal((await find(ada, 'vault')).total, 0);
});

test('relevance and recency ordering, paging, and hostile input', async (t) => {
  const { ada, general, say } = await setup(t);
  await say(ada, general, 'kiwi');
  await say(ada, general, 'kiwi kiwi kiwi smoothie kiwi');
  await say(ada, general, 'banana and kiwi');
  const rel = (await ada.get('/api/search?q=kiwi')).body.results.map((r) => r.message.body);
  assert.equal(rel[0], 'kiwi kiwi kiwi smoothie kiwi');
  const recent = (await ada.get('/api/search?q=kiwi&sort=recent')).body.results.map((r) => r.message.body);
  assert.equal(recent[0], 'banana and kiwi');
  const page = (await ada.get('/api/search?q=kiwi&sort=recent&limit=1&offset=1')).body;
  assert.equal(page.total, 3);
  assert.deepEqual(page.results.map((r) => r.message.body), ['kiwi kiwi kiwi smoothie kiwi']);
  for (const q of ['"', 'AND', '*', 'NEAR(', ')(', '^x', 'col:umn', '"unterminated']) {
    const res = await ada.get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, q);
  }
  assert.deepEqual((await ada.get('/api/search?q=')).body, { results: [], total: 0 });
});
