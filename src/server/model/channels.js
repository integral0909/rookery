import { transaction } from '../db.js';
import { HttpError } from '../http.js';

export const MAX_DM_MEMBERS = 9;

export function channelRow(db, channelId) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
}

export function membership(db, channelId, userId) {
  return db.prepare('SELECT * FROM memberships WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
}

export function memberIds(db, channelId) {
  return db
    .prepare('SELECT user_id FROM memberships WHERE channel_id = ? ORDER BY user_id')
    .all(channelId)
    .map((r) => r.user_id);
}

export function present(db, row, userId) {
  const mine = membership(db, row.id, userId);
  const out = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archived: !!row.archived_at,
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE channel_id = ?').get(row.id).n,
    member: !!mine,
    role: mine?.role ?? null,
    muted: !!mine?.muted,
    ...unreadCounts(db, row.id, userId),
  };
  if (row.kind === 'dm') out.memberIds = memberIds(db, row.id);
  return out;
}

// Who may read a channel: members always; anyone for public channels.
export function canRead(db, row, user) {
  if (!row) return false;
  if (row.kind === 'public') return true;
  return !!membership(db, row.id, user.id);
}

export function readable(db, channelId, user) {
  const row = channelRow(db, channelId);
  if (!canRead(db, row, user)) throw new HttpError(404, 'no such channel');
  return row;
}

export function writable(db, channelId, user) {
  const row = readable(db, channelId, user);
  if (row.archived_at) throw new HttpError(409, 'this channel is archived', 'archived');
  if (!membership(db, row.id, user.id)) throw new HttpError(403, 'join the channel first', 'not_member');
  return row;
}

export function canManage(db, row, user) {
  if (row.kind === 'dm') return false;
  return user.isAdmin || membership(db, row.id, user.id)?.role === 'owner';
}

export function addMember(db, channelId, userId, role = 'member') {
  return (
    db
      .prepare('INSERT OR IGNORE INTO memberships (channel_id, user_id, role, joined_at, last_read_id) VALUES (?, ?, ?, ?, ?)')
      .run(channelId, userId, role, Date.now(), latestMessageId(db, channelId)).changes > 0
  );
}

export function removeMember(db, channelId, userId) {
  return db.prepare('DELETE FROM memberships WHERE channel_id = ? AND user_id = ?').run(channelId, userId).changes > 0;
}

function latestMessageId(db, channelId) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?').get(channelId).id;
}

export function createChannel(db, { kind, name, topic = '', createdBy, members = [] }) {
  if (db.prepare('SELECT 1 FROM channels WHERE name = ?').get(name)) {
    throw new HttpError(409, `#${name} already exists`, 'name_taken');
  }
  return transaction(db, () => {
    const { lastInsertRowid: id } = db
      .prepare('INSERT INTO channels (kind, name, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, name, topic, createdBy, Date.now());
    if (createdBy) addMember(db, id, createdBy, 'owner');
    for (const userId of members) addMember(db, id, userId);
    return channelRow(db, id);
  });
}

// One DM channel per set of people: the same members always get the same
// conversation back.
export function openDm(db, userIds) {
  const ids = [...new Set(userIds)].sort((a, b) => a - b);
  if (ids.length < 2) throw new HttpError(400, 'a direct message needs someone else in it');
  if (ids.length > MAX_DM_MEMBERS) throw new HttpError(400, `direct messages hold at most ${MAX_DM_MEMBERS} people`);
  const found = db.prepare('SELECT COUNT(*) AS n FROM users WHERE deactivated_at IS NULL AND id IN (SELECT value FROM json_each(?))').get(JSON.stringify(ids)).n;
  if (found !== ids.length) throw new HttpError(400, 'unknown or deactivated user in the list');
  const key = ids.join(',');
  const existing = db.prepare('SELECT * FROM channels WHERE dm_key = ?').get(key);
  if (existing) return { row: existing, created: false };
  return transaction(db, () => {
    const { lastInsertRowid: id } = db
      .prepare("INSERT INTO channels (kind, dm_key, created_at) VALUES ('dm', ?, ?)")
      .run(key, Date.now());
    for (const userId of ids) addMember(db, id, userId);
    return { row: channelRow(db, id), created: true };
  });
}

export function listForUser(db, userId) {
  return db
    .prepare(
      `SELECT c.* FROM channels c JOIN memberships m ON m.channel_id = c.id
        WHERE m.user_id = ? ORDER BY c.kind = 'dm', c.name, c.id`,
    )
    .all(userId);
}

export function browsePublic(db, userId) {
  return db
    .prepare(
      `SELECT * FROM channels
        WHERE kind = 'public' AND archived_at IS NULL
          AND id NOT IN (SELECT channel_id FROM memberships WHERE user_id = ?)
        ORDER BY name`,
    )
    .all(userId);
}

export function unreadCounts(db, channelId, userId) {
  const m = membership(db, channelId, userId);
  if (!m) return { unreadCount: 0, mentionCount: 0, lastReadId: 0 };
  const unreadCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE channel_id = ? AND parent_id IS NULL AND id > ? AND user_id != ? AND deleted_at IS NULL`,
    )
    .get(channelId, m.last_read_id, userId).n;
  const mentionCount = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND channel_id = ? AND read_at IS NULL')
    .get(userId, channelId).n;
  return { unreadCount, mentionCount, lastReadId: m.last_read_id };
}
