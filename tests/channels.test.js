import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.js';

async function team(t, names = ['ada', 'grace', 'linus']) {
  const env = await startApp(t);
  const people = {};
  for (const name of names) {
    const c = env.client();
    const res = await c.post('/api/auth/register', { username: name, password: 'password-' + name });
    c.user = res.body.user;
    people[name] = c;
  }
  return { ...env, ...people };
}

test('everyone joins #general, which cannot be left or renamed', async (t) => {
  const { ada, grace } = await team(t);
  const list = (await grace.get('/api/channels')).body.channels;
  assert.deepEqual(list.map((c) => c.name), ['general']);
  const general = list[0];
  assert.equal(general.memberCount, 3);
  assert.equal((await grace.post(`/api/channels/${general.id}/leave`)).status, 400);
  assert.equal((await ada.patch(`/api/channels/${general.id}`, { name: 'all' })).status, 400);
  assert.equal((await ada.patch(`/api/channels/${general.id}`, { archived: true })).status, 400);
});

test('public channels: create, browse, join, leave', async (t) => {
  const { ada, grace } = await team(t);
  const made = await ada.post('/api/channels', { name: 'Design', topic: 'Pixels' });
  assert.equal(made.status, 200);
  const design = made.body.channel;
  assert.equal(design.name, 'design');
  assert.equal(design.role, 'owner');
  assert.equal((await grace.post('/api/channels', { name: 'design' })).status, 409);
  assert.equal((await grace.post('/api/channels', { name: 'has space' })).status, 400);

  const browse = (await grace.get('/api/channels?browse=1')).body.channels;
  assert.deepEqual(browse.map((c) => c.name), ['design']);
  assert.equal((await grace.post(`/api/channels/${design.id}/messages`, { body: 'hi' })).body.code, 'not_member');
  assert.equal((await grace.post(`/api/channels/${design.id}/join`)).body.channel.member, true);
  assert.equal((await grace.get('/api/channels?browse=1')).body.channels.length, 0);
  assert.equal((await grace.post(`/api/channels/${design.id}/leave`)).status, 204);
  // Reading a public channel does not require membership.
  assert.equal((await grace.get(`/api/channels/${design.id}/messages`)).status, 200);
});

test('private channels are invisible to outsiders and invite-only', async (t) => {
  const { ada, grace, linus } = await team(t);
  const secret = (await ada.post('/api/channels', { name: 'leadership', private: true, memberIds: [grace.user.id] })).body.channel;
  assert.equal(secret.kind, 'private');
  assert.equal(secret.memberCount, 2);
  assert.equal((await linus.get(`/api/channels/${secret.id}`)).status, 404);
  assert.equal((await linus.get(`/api/channels/${secret.id}/messages`)).status, 404);
  assert.equal((await linus.post(`/api/channels/${secret.id}/join`)).status, 404);
  assert.ok(!(await linus.get('/api/channels?browse=1')).body.channels.some((c) => c.id === secret.id));
  // Members who are not owners cannot invite.
  assert.equal((await grace.post(`/api/channels/${secret.id}/members`, { userId: linus.user.id })).status, 403);
  assert.deepEqual((await ada.post(`/api/channels/${secret.id}/members`, { userId: linus.user.id })).body.added, [linus.user.id]);
  assert.equal((await linus.get(`/api/channels/${secret.id}`)).status, 200);
  assert.equal((await grace.delete(`/api/channels/${secret.id}/members/${linus.user.id}`)).status, 403);
  assert.equal((await ada.delete(`/api/channels/${secret.id}/members/${linus.user.id}`)).status, 204);
  assert.equal((await linus.get(`/api/channels/${secret.id}`)).status, 404);
});

test('topics by members, renames and archiving by owners', async (t) => {
  const { ada, grace, linus } = await team(t);
  const ch = (await ada.post('/api/channels', { name: 'ops' })).body.channel;
  await grace.post(`/api/channels/${ch.id}/join`);
  assert.equal((await grace.patch(`/api/channels/${ch.id}`, { topic: 'Pager rota' })).body.channel.topic, 'Pager rota');
  assert.equal((await linus.patch(`/api/channels/${ch.id}`, { topic: 'nope' })).status, 403);
  assert.equal((await grace.patch(`/api/channels/${ch.id}`, { name: 'oncall' })).status, 403);
  assert.equal((await ada.patch(`/api/channels/${ch.id}`, { name: 'oncall' })).body.channel.name, 'oncall');
  assert.equal((await ada.patch(`/api/channels/${ch.id}`, { archived: true })).body.channel.archived, true);
  const posted = await grace.post(`/api/channels/${ch.id}/messages`, { body: 'still here?' });
  assert.equal(posted.body.code, 'archived');
  assert.equal((await linus.post(`/api/channels/${ch.id}/join`)).status, 409);
});

test('direct messages are found again by the same members', async (t) => {
  const { ada, grace, linus } = await team(t);
  const dm = (await ada.post('/api/dms', { userIds: [grace.user.id] })).body.channel;
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.name, null);
  assert.deepEqual(dm.memberIds, [ada.user.id, grace.user.id]);
  const again = (await grace.post('/api/dms', { userIds: [ada.user.id] })).body.channel;
  assert.equal(again.id, dm.id);
  assert.equal((await linus.get(`/api/channels/${dm.id}/messages`)).status, 404);
  assert.equal((await ada.post('/api/dms', { userIds: [] })).status, 400);
  assert.equal((await ada.post('/api/dms', { userIds: [999] })).status, 400);
  const group = (await ada.post('/api/dms', { userIds: [grace.user.id, linus.user.id] })).body.channel;
  assert.notEqual(group.id, dm.id);
  assert.equal((await ada.post(`/api/channels/${dm.id}/leave`)).status, 400);
  assert.equal((await ada.patch(`/api/channels/${dm.id}`, { topic: 'x' })).status, 400);
});

test('muting a channel is per member', async (t) => {
  const { ada, grace } = await team(t);
  const general = (await ada.get('/api/channels')).body.channels[0];
  assert.equal((await ada.put(`/api/channels/${general.id}/mute`, { muted: true })).body.channel.muted, true);
  assert.equal((await grace.get(`/api/channels/${general.id}`)).body.channel.muted, false);
});
