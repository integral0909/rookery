import { transaction } from '../db.js';
import { HttpError } from '../http.js';

export const MAX_BODY = 4000;
export const PAGE = 50;

export function present(row) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    parentId: row.parent_id,
    body: deleted ? '' : row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
  };
}

export function messageRow(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function normalizeBody(body) {
  if (typeof body !== 'string') throw new HttpError(400, 'body must be a string', 'invalid');
  // Keep line breaks, drop trailing whitespace and runs of blank lines.
  const text = body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new HttpError(400, 'message is empty', 'invalid');
  if (text.length > MAX_BODY) throw new HttpError(400, `messages are limited to ${MAX_BODY} characters`, 'invalid');
  return text;
}

export function postMessage(db, { channelId, userId, body, parentId = null, now = Date.now() }) {
  return transaction(db, () => {
    if (parentId !== null) {
      const parent = messageRow(db, parentId);
      if (!parent || parent.channel_id !== channelId) throw new HttpError(404, 'no such message to reply to');
      if (parent.parent_id !== null) throw new HttpError(400, 'replies go on the thread’s first message');
      if (parent.deleted_at) throw new HttpError(409, 'that message was deleted');
      db.prepare('UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?').run(now, parentId);
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO messages (channel_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(channelId, userId, parentId, body, now);
    return messageRow(db, lastInsertRowid);
  });
}

export function editMessage(db, row, body, now = Date.now()) {
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now, row.id);
  return messageRow(db, row.id);
}

export function deleteMessage(db, row, now = Date.now()) {
  db.prepare("UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?").run(now, row.id);
  return messageRow(db, row.id);
}

// Top-level messages of a channel, newest page first, returned oldest-first.
// `before` / `after` are message ids and page through the history.
export function history(db, channelId, { before, after, limit = PAGE } = {}) {
  let rows;
  if (after !== undefined) {
    rows = db
      .prepare('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND id > ? ORDER BY id LIMIT ?')
      .all(channelId, after, limit + 1);
    const more = rows.length > limit;
    return { messages: rows.slice(0, limit), hasMore: more };
  }
  rows = db
    .prepare('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?')
    .all(channelId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const more = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse(), hasMore: more };
}

export function thread(db, parentId) {
  return db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY id').all(parentId);
}

// Messages around one id, for jumping to a search result or a mention.
export function around(db, channelId, id, span = 25) {
  const older = db
    .prepare('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?')
    .all(channelId, id, span + 1);
  const newer = db
    .prepare('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND id >= ? ORDER BY id LIMIT ?')
    .all(channelId, id, span + 1);
  return {
    messages: [...older.slice(0, span).reverse(), ...newer.slice(0, span)],
    hasMore: older.length > span,
    hasNewer: newer.length > span,
  };
}
