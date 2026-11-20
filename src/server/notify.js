import { channelRow, unreadCounts } from './model/channels.js';
import { messageRow } from './model/messages.js';

// Strips code so `@names` inside backticks are not treated as mentions.
function withoutCode(body) {
  return body.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// Returns the lower-cased names mentioned in a message body, including the
// broadcast words channel, everyone and here.
export function parseMentions(body) {
  const names = new Set();
  const re = /(^|[^\w@./-])@([a-z0-9][a-z0-9._-]*)/gi;
  for (const m of withoutCode(body).matchAll(re)) {
    names.add(m[2].replace(/[._-]+$/, '').toLowerCase());
  }
  return names;
}

// Ranks why someone is being notified; a person gets one notification per
// message, for the strongest reason.
const RANK = { mention: 4, dm: 3, reply: 2, channel: 1 };

export function recipients(db, { message, channel, isOnline = () => false }) {
  const members = new Map();
  for (const row of db
    .prepare(
      `SELECT m.user_id, m.muted, u.username FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = ? AND u.deactivated_at IS NULL`,
    )
    .all(channel.id)) {
    if (row.user_id !== message.user_id) members.set(row.user_id, row);
  }
  const out = new Map();
  const give = (userId, kind) => {
    if (!members.has(userId)) return;
    const prev = out.get(userId);
    if (!prev || RANK[kind] > RANK[prev]) out.set(userId, kind);
  };

  const names = parseMentions(message.body);
  for (const member of members.values()) {
    if (names.has(member.username.toLowerCase())) give(member.user_id, 'mention');
  }
  const loud = channel.kind !== 'dm';
  for (const member of members.values()) {
    if (member.muted) continue;
    if (channel.kind === 'dm') give(member.user_id, 'dm');
    if (loud && (names.has('channel') || names.has('everyone'))) give(member.user_id, 'channel');
    if (loud && names.has('here') && isOnline(member.user_id)) give(member.user_id, 'channel');
  }
  if (message.parent_id) {
    // Everyone who started or replied to the thread follows it.
    const followers = db
      .prepare('SELECT DISTINCT user_id FROM messages WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL')
      .all(message.parent_id, message.parent_id);
    for (const { user_id } of followers) if (!members.get(user_id)?.muted) give(user_id, 'reply');
  }
  return out;
}

export function presentNotification(db, row) {
  const message = messageRow(db, row.message_id);
  const channel = channelRow(db, row.channel_id);
  const actor = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(row.actor_id);
  return {
    id: row.id,
    kind: row.kind,
    messageId: row.message_id,
    parentId: message?.parent_id ?? null,
    channelId: row.channel_id,
    channelName: channel?.name ?? null,
    channelKind: channel?.kind,
    actorId: row.actor_id,
    actorName: actor?.display_name ?? 'someone',
    preview: message ? message.body.slice(0, 140) : '',
    createdAt: row.created_at,
    read: !!row.read_at,
  };
}

// Creates notifications for new and edited messages, removes them for
// deleted ones, and tells the hub who to ping.
export function startNotifier({ db, hooks, isOnline }) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notifications (user_id, kind, message_id, channel_id, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const notify = ({ message, channel }) => {
    const now = Date.now();
    for (const [userId, kind] of recipients(db, { message, channel, isOnline: isOnline() })) {
      const { changes, lastInsertRowid } = insert.run(userId, kind, message.id, channel.id, message.user_id, now);
      if (!changes) continue;
      const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(lastInsertRowid);
      hooks.emit('notificationCreated', { userId, notification: presentNotification(db, row) });
    }
  };
  hooks.on('messageCreated', notify);
  hooks.on('messageUpdated', notify);
  hooks.on('messageDeleted', ({ message }) => {
    const users = db.prepare('SELECT user_id FROM notifications WHERE message_id = ?').all(message.id);
    db.prepare('DELETE FROM notifications WHERE message_id = ?').run(message.id);
    for (const { user_id } of users) hooks.emit('notificationsChanged', { userId: user_id, channelId: message.channel_id });
  });
  hooks.on('memberRemoved', ({ channel, userId }) => {
    if (channel.kind === 'public') return;
    db.prepare('DELETE FROM notifications WHERE user_id = ? AND channel_id = ?').run(userId, channel.id);
    hooks.emit('notificationsChanged', { userId, channelId: channel.id });
  });
}

export { unreadCounts };
