import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.js';
import { connect } from './ws.js';

async function setup(t) {
  const env = await startApp(t);
  const users = {};
  for (const name of ['ada', 'grace', 'linus']) {
    const c = env.client();
    c.user = (await c.post('/api/auth/register', { username: name, password: 'password-' + name })).body.user;
    users[name] = c;
  }
  const general = (await users.ada.get('/api/channels')).body.channels[0];
  const open = async (c) => {
    const s = connect(c);
    await s.opened;
    await s.next('hello');
    t.after(() => s.close());
    return s;
  };
  return { ...env, ...users, general, open };
}

test('sockets need a session and the same origin', async (t) => {
  const { client, ada } = await setup(t);
  await assert.rejects(connect(client()).opened, /401/);
  await assert.rejects(connect(ada, { origin: 'https://evil.example' }).opened, /403/);
  const ok = connect(ada, { origin: ada.base });
  await ok.opened;
  const hello = await ok.next('hello');
  assert.equal(hello.userId, ada.user.id);
  ok.close();
});

test('new messages reach channel members, with the sender’s client id', async (t) => {
  const { ada, grace, general, open } = await setup(t);
  const gs = await open(grace);
  const as = await open(ada);
  await ada.post(`/api/channels/${general.id}/messages`, { body: 'hello team', clientId: 'tmp-1' });
  const got = await gs.next('message.created');
  assert.equal(got.message.body, 'hello team');
  assert.equal(got.message.userId, ada.user.id);
  const echo = await as.next('message.created');
  assert.equal(echo.clientId, 'tmp-1');
});

test('private channel traffic stays private', async (t) => {
  const { ada, grace, linus, open } = await setup(t);
  const ls = await open(linus);
  const gs = await open(grace);
  const ch = (await ada.post('/api/channels', { name: 'hush', private: true, memberIds: [grace.user.id] })).body.channel;
  const joined = await gs.next('channel.joined', (e) => e.channel.id === ch.id);
  assert.equal(joined.channel.name, 'hush');
  await ada.post(`/api/channels/${ch.id}/messages`, { body: 'secret' });
  await gs.next('message.created');
  // Even asking to watch it does not let an outsider listen in.
  ls.send({ type: 'watch', channelId: ch.id });
  await ada.post(`/api/channels/${ch.id}/messages`, { body: 'secret 2' });
  await ls.settle();
  assert.ok(!ls.events.some((e) => e.type === 'message.created' || (e.type === 'channel.joined' && e.channel.id === ch.id)));
});

test('watching a public channel without joining', async (t) => {
  const { ada, linus, open } = await setup(t);
  const ch = (await ada.post('/api/channels', { name: 'lobby' })).body.channel;
  const ls = await open(linus);
  ls.send({ type: 'watch', channelId: ch.id });
  await ls.settle();
  await ada.post(`/api/channels/${ch.id}/messages`, { body: 'anyone?' });
  assert.equal((await ls.next('message.created')).message.body, 'anyone?');
  ls.send({ type: 'unwatch', channelId: ch.id });
  await ls.settle();
  await ada.post(`/api/channels/${ch.id}/messages`, { body: 'bye' });
  await ls.settle();
  assert.ok(!ls.events.some((e) => e.type === 'message.created'));
});

test('thread replies update the root message', async (t) => {
  const { ada, grace, general, open } = await setup(t);
  const gs = await open(grace);
  const root = (await ada.post(`/api/channels/${general.id}/messages`, { body: 'q' })).body.message;
  await ada.post(`/api/channels/${general.id}/messages`, { body: 'a', parentId: root.id });
  const reply = await gs.next('message.created', (e) => e.message.parentId === root.id);
  assert.equal(reply.message.body, 'a');
  const updated = await gs.next('message.updated', (e) => e.message.id === root.id);
  assert.equal(updated.message.replyCount, 1);
});

test('edits and deletions are pushed', async (t) => {
  const { ada, grace, general, open } = await setup(t);
  const gs = await open(grace);
  const m = (await ada.post(`/api/channels/${general.id}/messages`, { body: 'draft' })).body.message;
  await ada.patch(`/api/messages/${m.id}`, { body: 'final' });
  assert.equal((await gs.next('message.updated')).message.body, 'final');
  await ada.delete(`/api/messages/${m.id}`);
  const del = await gs.next('message.deleted');
  assert.equal(del.message.deleted, true);
  assert.equal(del.message.body, '');
});

test('typing is relayed to other members and rate-limited', async (t) => {
  const { ada, grace, general, open } = await setup(t);
  const as = await open(ada);
  const gs = await open(grace);
  as.send({ type: 'typing', channelId: general.id });
  as.send({ type: 'typing', channelId: general.id });
  const typing = await gs.next('typing');
  assert.equal(typing.userId, ada.user.id);
  await as.settle();
  await gs.settle();
  assert.equal(gs.events.filter((e) => e.type === 'typing').length, 0);
  assert.equal(as.events.filter((e) => e.type === 'typing').length, 0);
});

test('presence goes online with the first socket and offline with the last', async (t) => {
  const { ada, grace, open } = await setup(t);
  const as = await open(ada);
  const g1 = connect(grace);
  await g1.opened;
  const fromGrace = (e) => e.userId === grace.user.id;
  assert.deepEqual(await as.next('presence', fromGrace), { type: 'presence', userId: grace.user.id, online: true });
  const g2 = connect(grace);
  await g2.opened;
  g1.close();
  await as.settle();
  assert.ok(!as.events.some((e) => e.type === 'presence' && fromGrace(e)));
  g2.close();
  assert.deepEqual(await as.next('presence', fromGrace), { type: 'presence', userId: grace.user.id, online: false });
});

test('membership changes are announced', async (t) => {
  const { ada, grace, open } = await setup(t);
  const as = await open(ada);
  const gs = await open(grace);
  const ch = (await ada.post('/api/channels', { name: 'crew' })).body.channel;
  await grace.post(`/api/channels/${ch.id}/join`);
  assert.equal((await gs.next('channel.joined', (e) => e.channel.id === ch.id)).channel.member, true);
  assert.equal((await as.next('member.added', (e) => e.channelId === ch.id)).userId, grace.user.id);
  await ada.patch(`/api/channels/${ch.id}`, { topic: 'Rota' });
  assert.equal((await gs.next('channel.updated')).channel.topic, 'Rota');
  await grace.post(`/api/channels/${ch.id}/leave`);
  assert.equal((await gs.next('channel.left')).channelId, ch.id);
});

test('deactivating a user closes their sockets', async (t) => {
  const { ada, grace, open } = await setup(t);
  const gs = await open(grace);
  const closed = new Promise((resolve) => gs.ws.once('close', (code) => resolve(code)));
  await ada.patch(`/api/admin/users/${grace.user.id}`, { deactivated: true });
  assert.equal(await closed, 4001);
});
