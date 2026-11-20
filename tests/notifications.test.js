import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEmoji } from '../src/server/model/reactions.js';
import { parseMentions } from '../src/server/notify.js';
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
  const say = (c, body, extra = {}) => c.post(`/api/channels/${extra.channel ?? general.id}/messages`, { body, ...extra, channel: undefined });
  const notes = async (c) => (await c.get('/api/notifications')).body;
  return { ...env, ...users, general, say, notes };
}

test('mention parsing skips code and emails and trims punctuation', () => {
  assert.deepEqual([...parseMentions('hey @Ada, and @grace. cc @here')], ['ada', 'grace', 'here']);
  assert.deepEqual([...parseMentions('mail ada@example.com or `@linus` or\n```\n@grace\n```')], []);
  assert.deepEqual([...parseMentions('@a.b_c- ok')], ['a.b_c']);
});

test('emoji validation', () => {
  assert.equal(checkEmoji('👍'), '👍');
  assert.equal(checkEmoji('👩🏽‍💻'), '👩🏽‍💻');
  assert.equal(checkEmoji(':party_parrot:'), ':party_parrot:');
  for (const bad of ['', 'abc', '1', '<b>', ':no spaces:', 'x'.repeat(40)]) assert.throws(() => checkEmoji(bad), /emoji/);
});

test('reactions toggle per person and group by emoji', async (t) => {
  const { ada, grace, linus, say } = await setup(t);
  const m = (await say(ada, 'ship it')).body.message;
  const path = (e) => `/api/messages/${m.id}/reactions/${encodeURIComponent(e)}`;
  await grace.put(path('🚀'));
  await linus.put(path('🚀'));
  await linus.put(path('🚀'));
  const r = (await ada.put(path(':tada:'))).body.reactions;
  assert.deepEqual(r, [
    { emoji: '🚀', userIds: [grace.user.id, linus.user.id] },
    { emoji: ':tada:', userIds: [ada.user.id] },
  ]);
  await grace.delete(path('🚀'));
  const msg = (await ada.get(`/api/messages/${m.id}`)).body.message;
  assert.deepEqual(msg.reactions[0], { emoji: '🚀', userIds: [linus.user.id] });
  assert.equal((await ada.put(path('nope'))).status, 400);
  await ada.delete(`/api/messages/${m.id}`);
  assert.equal((await grace.put(path('🚀'))).status, 409);
});

test('reactions are pushed to the channel', async (t) => {
  const { ada, grace, say } = await setup(t);
  const gs = connect(grace);
  await gs.opened;
  t.after(() => gs.close());
  const m = (await say(ada, 'hi')).body.message;
  await ada.put(`/api/messages/${m.id}/reactions/${encodeURIComponent('👋')}`);
  const e = await gs.next('reactions.updated');
  assert.equal(e.messageId, m.id);
  assert.deepEqual(e.reactions, [{ emoji: '👋', userIds: [ada.user.id] }]);
});

test('mentions notify members only, once, never the author', async (t) => {
  const { ada, grace, linus, say, notes } = await setup(t);
  const ch = (await ada.post('/api/channels', { name: 'core', private: true, memberIds: [grace.user.id] })).body.channel;
  await say(ada, '@grace @grace @linus @ada look', { channel: ch.id });
  const g = await notes(grace);
  assert.equal(g.notifications.length, 1);
  assert.equal(g.notifications[0].kind, 'mention');
  assert.equal(g.notifications[0].actorName, 'ada');
  assert.equal(g.notifications[0].channelName, 'core');
  assert.equal(g.unreadCount, 1);
  assert.equal((await notes(linus)).notifications.length, 0);
  assert.equal((await notes(ada)).notifications.length, 0);
});

test('@channel and @here respect muting and presence; named mentions pierce mute', async (t) => {
  const { ada, grace, linus, general, say, notes } = await setup(t);
  await linus.put(`/api/channels/${general.id}/mute`, { muted: true });
  await say(ada, '@channel standup in 5');
  assert.equal((await notes(grace)).notifications[0].kind, 'channel');
  assert.equal((await notes(linus)).notifications.length, 0);

  // Only grace is connected, so only she hears @here.
  const gs = connect(grace);
  await gs.opened;
  t.after(() => gs.close());
  await gs.next('hello');
  await say(ada, '@here quick one');
  assert.equal((await notes(grace)).notifications.length, 2);
  const pushed = await gs.next('notification.created');
  assert.equal(pushed.notification.preview, '@here quick one');
  assert.equal(pushed.mentionCount, 2);

  await say(ada, '@linus you too');
  assert.equal((await notes(linus)).notifications[0].kind, 'mention');
});

test('direct messages and thread replies notify', async (t) => {
  const { ada, grace, linus, say, notes } = await setup(t);
  const dm = (await ada.post('/api/dms', { userIds: [grace.user.id] })).body.channel;
  await say(ada, 'psst', { channel: dm.id });
  assert.equal((await notes(grace)).notifications[0].kind, 'dm');

  const root = (await say(grace, 'thoughts on the logo?')).body.message;
  await say(linus, 'love it', { parentId: root.id });
  await say(ada, 'same', { parentId: root.id });
  const g = (await notes(grace)).notifications.filter((n) => n.kind === 'reply');
  assert.equal(g.length, 2);
  // linus replied earlier, so he follows the thread too.
  const l = (await notes(linus)).notifications;
  assert.deepEqual(l.map((n) => n.kind), ['reply']);
  assert.equal(l[0].parentId, root.id);
});

test('editing in a new mention notifies only the new person', async (t) => {
  const { ada, grace, linus, say, notes } = await setup(t);
  const m = (await say(ada, 'hi @grace')).body.message;
  await ada.patch(`/api/messages/${m.id}`, { body: 'hi @grace and @linus' });
  assert.equal((await notes(grace)).notifications.length, 1);
  assert.equal((await notes(linus)).notifications.length, 1);
});

test('deleting a message withdraws its notifications', async (t) => {
  const { ada, grace, say, notes } = await setup(t);
  const m = (await say(ada, 'oops @grace')).body.message;
  await ada.delete(`/api/messages/${m.id}`);
  assert.deepEqual(await notes(grace), { notifications: [], hasMore: false, unreadCount: 0 });
});

test('unread counts and read markers', async (t) => {
  const { ada, grace, general, say } = await setup(t);
  const counts = async () => (await grace.get(`/api/channels/${general.id}`)).body.channel;
  await say(ada, 'one');
  const two = (await say(ada, 'two @grace')).body.message;
  await say(ada, 'three');
  let c = await counts();
  assert.equal(c.unreadCount, 3);
  assert.equal(c.mentionCount, 1);

  const read = (await grace.post(`/api/channels/${general.id}/read`, { messageId: two.id })).body;
  assert.deepEqual(read, { unreadCount: 1, mentionCount: 0, lastReadId: two.id });
  // Markers never move backwards.
  await grace.post(`/api/channels/${general.id}/read`, { messageId: 1 });
  assert.equal((await counts()).lastReadId, two.id);
  await grace.post(`/api/channels/${general.id}/read`, {});
  c = await counts();
  assert.equal(c.unreadCount, 0);
  // Your own messages are never unread.
  await say(grace, 'me');
  assert.equal((await counts()).unreadCount, 0);
});

test('reading a thread clears its notifications and syncs other tabs', async (t) => {
  const { ada, grace, general, say, notes } = await setup(t);
  const root = (await say(grace, 'q')).body.message;
  await say(ada, 'a1', { parentId: root.id });
  await say(ada, 'a2', { parentId: root.id });
  const tab = connect(grace);
  await tab.opened;
  t.after(() => tab.close());
  await tab.next('hello');
  // Reading the channel does not clear thread replies...
  await grace.post(`/api/channels/${general.id}/read`, {});
  assert.equal((await notes(grace)).unreadCount, 2);
  await tab.next('channel.read');
  // ...reading the thread does.
  await grace.post(`/api/messages/${root.id}/thread/read`);
  assert.equal((await notes(grace)).unreadCount, 0);
  const sync = await tab.next('channel.read');
  assert.equal(sync.mentionCount, 0);
});

test('mark notifications read by id or all at once', async (t) => {
  const { ada, grace, say, notes } = await setup(t);
  for (let i = 0; i < 3; i++) await say(ada, `@grace ${i}`);
  const list = (await notes(grace)).notifications;
  assert.equal((await grace.post('/api/notifications/read', { ids: [list[0].id] })).status, 204);
  assert.equal((await notes(grace)).unreadCount, 2);
  assert.equal((await grace.get('/api/notifications?unread=1')).body.notifications.length, 2);
  await grace.post('/api/notifications/read', { all: true });
  assert.equal((await notes(grace)).unreadCount, 0);
  assert.equal((await grace.post('/api/notifications/read', { ids: 'x' })).status, 400);
  // Someone else's ids do nothing.
  await say(grace, '@ada hi');
  const adaNote = (await notes(ada)).notifications[0];
  await grace.post('/api/notifications/read', { ids: [adaNote.id] });
  assert.equal((await notes(ada)).unreadCount, 1);
});
