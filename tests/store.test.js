import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../public/js/lib/store.js';

const me = { id: 1, username: 'ada', displayName: 'Ada' };
const grace = { id: 2, username: 'grace', displayName: 'Grace' };
const msg = (id, extra = {}) => ({ id, channelId: 10, userId: 2, parentId: null, body: `m${id}`, createdAt: id * 1000, reactions: [], ...extra });

function store() {
  const s = new Store();
  s.setMe(me);
  s.setUsers([me, grace]);
  s.setChannels([
    { id: 10, kind: 'public', name: 'general', member: true, unreadCount: 0, mentionCount: 0, lastReadId: 0, memberCount: 2 },
    { id: 11, kind: 'dm', name: null, member: true, memberIds: [1, 2], createdAt: 5, unreadCount: 0 },
  ]);
  return s;
}

test('timelines merge older and newer pages without duplicates', () => {
  const s = store();
  s.setTimeline(10, { messages: [msg(5), msg(6)], hasMore: true });
  s.setTimeline(10, { messages: [msg(3), msg(4), msg(5)], hasMore: false }, 'older');
  assert.deepEqual(s.timeline(10).messages.map((m) => m.id), [3, 4, 5, 6]);
  assert.equal(s.timeline(10).hasMore, false);
  s.setTimeline(10, { messages: [msg(6), msg(7)], hasMore: false }, 'newer');
  assert.deepEqual(s.timeline(10).messages.map((m) => m.id), [3, 4, 5, 6, 7]);
});

test('live messages append, count as unread elsewhere, and replace pending', () => {
  const s = store();
  s.setTimeline(10, { messages: [msg(1)], hasMore: false });
  let renders = 0;
  s.on('timeline:10', () => renders++);
  s.apply({ type: 'message.created', message: msg(2) });
  assert.equal(s.timeline(10).messages.length, 2);
  assert.equal(s.channels.get(10).unreadCount, 1);
  s.viewing = 10;
  s.apply({ type: 'message.created', message: msg(3) });
  assert.equal(s.channels.get(10).unreadCount, 1, 'not unread while on screen');
  s.apply({ type: 'message.created', message: msg(3) });
  assert.equal(s.timeline(10).messages.length, 3, 'duplicates ignored');

  const clientId = s.addPending({ channelId: 10, body: 'hello' });
  assert.equal(s.pendingFor(10).length, 1);
  s.apply({ type: 'message.created', message: msg(4, { userId: 1 }), clientId });
  assert.equal(s.pendingFor(10).length, 0);
  assert.equal(s.channels.get(10).lastReadId, 4, 'own messages advance the read marker');
  assert.ok(renders >= 4);
});

test('messages for an unloaded or scrolled-back timeline are not appended', () => {
  const s = store();
  s.apply({ type: 'message.created', message: msg(1) });
  assert.equal(s.timeline(10), undefined);
  s.setTimeline(10, { messages: [msg(1)], hasMore: true, hasNewer: true });
  s.apply({ type: 'message.created', message: msg(9) });
  assert.deepEqual(s.timeline(10).messages.map((m) => m.id), [1]);
});

test('failed sends stay visible until dropped', () => {
  const s = store();
  const id = s.addPending({ channelId: 10, body: 'x' });
  s.failPending(id, 'offline');
  assert.equal(s.pendingFor(10)[0].failed, true);
  s.dropPending(id);
  assert.equal(s.pendingFor(10).length, 0);
});

test('threads receive replies; edits and reactions patch everywhere', () => {
  const s = store();
  s.setTimeline(10, { messages: [msg(1)], hasMore: false });
  s.setThread(msg(1, { replyCount: 0 }), []);
  s.apply({ type: 'message.created', message: msg(2, { parentId: 1 }) });
  assert.equal(s.threads.get(1).replies.length, 1);
  assert.equal(s.timeline(10).messages.length, 1, 'replies stay out of the channel');
  s.apply({ type: 'message.updated', message: msg(1, { replyCount: 1 }) });
  assert.equal(s.timeline(10).messages[0].replyCount, 1);
  assert.equal(s.threads.get(1).root.replyCount, 1);
  s.apply({ type: 'reactions.updated', messageId: 2, channelId: 10, reactions: [{ emoji: '👍', userIds: [1] }] });
  assert.equal(s.findMessage(2).reactions[0].emoji, '👍');
  s.apply({ type: 'message.deleted', message: msg(1, { deleted: true, body: '' }) });
  assert.equal(s.findMessage(1).deleted, true);
});

test('typing expires and is scoped to the thread', () => {
  const s = store();
  s.setTyping(10, 2, null, 0);
  s.setTyping(10, 3, 99, 0);
  assert.deepEqual(s.typers(10, null, 1000).map((u) => u.id), [2]);
  assert.deepEqual(s.typers(10, 99, 1000).map((u) => u.id), [3]);
  assert.deepEqual(s.typers(10, null, 10_000), []);
  s.setTyping(10, 2);
  s.apply({ type: 'message.created', message: msg(5) });
  assert.deepEqual(s.typers(10), [], 'sending a message clears typing');
});

test('channel events, read sync and notifications', () => {
  const s = store();
  s.apply({ type: 'channel.joined', channel: { id: 12, kind: 'private', name: 'core', member: true } });
  assert.deepEqual(s.joinedChannels().rooms.map((c) => c.name), ['core', 'general']);
  s.apply({ type: 'channel.left', channelId: 12 });
  assert.equal(s.channels.has(12), false);
  s.apply({ type: 'channel.left', channelId: 10 });
  assert.equal(s.channels.get(10).member, false, 'public channels stay known after leaving');

  s.channels.get(11).unreadCount = 4;
  s.apply({ type: 'channel.read', channelId: 11, unreadCount: 0, mentionCount: 0, lastReadId: 9 });
  assert.equal(s.channels.get(11).unreadCount, 0);

  const seen = [];
  s.on('notify', (n) => seen.push(n.id));
  s.setNotifications({ notifications: [], unreadCount: 0, hasMore: false });
  s.apply({ type: 'notification.created', notification: { id: 7, channelId: 11, read: false }, mentionCount: 1 });
  assert.equal(s.notifications.unread, 1);
  assert.equal(s.channels.get(11).mentionCount, 1);
  assert.deepEqual(seen, [7]);
  s.markNotificationsRead();
  assert.equal(s.notifications.unread, 0);
});

test('presence and DM titles', () => {
  const s = store();
  s.apply({ type: 'hello', userId: 1, online: [1, 2] });
  assert.ok(s.online.has(2));
  s.apply({ type: 'presence', userId: 2, online: false });
  assert.ok(!s.online.has(2));
  assert.equal(s.channelTitle(s.channels.get(11)), 'Grace');
  assert.equal(s.dmPartner(s.channels.get(11)).id, 2);
  s.apply({ type: 'user.updated', user: { ...grace, displayName: 'Grace H' } });
  assert.equal(s.channelTitle(s.channels.get(11)), 'Grace H');
  assert.deepEqual(s.totalUnread(), { mentions: 0, unread: 0 });
});
