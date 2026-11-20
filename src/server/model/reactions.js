import { HttpError } from '../http.js';

export const MAX_KINDS = 20;

const SHORTCODE = /^:[a-z0-9_+-]{1,30}:$/;
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|‍|️)+$/u;

export function checkEmoji(value) {
  const emoji = String(value || '').trim();
  if (!emoji || emoji.length > 32 || !(SHORTCODE.test(emoji) || EMOJI.test(emoji)) || /^[0-9#*]+$/.test(emoji)) {
    throw new HttpError(400, 'that is not an emoji', 'invalid');
  }
  return emoji;
}

// Reactions for many messages at once, as { messageId: [{ emoji, userIds }] }
// ordered by when each emoji was first used on the message.
export function reactionsFor(db, messageIds) {
  const out = new Map(messageIds.map((id) => [id, []]));
  if (!messageIds.length) return out;
  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_id, created_at FROM reactions
        WHERE message_id IN (SELECT value FROM json_each(?))
        ORDER BY message_id, created_at, user_id`,
    )
    .all(JSON.stringify(messageIds));
  for (const row of rows) {
    const list = out.get(row.message_id);
    let entry = list.find((r) => r.emoji === row.emoji);
    if (!entry) list.push((entry = { emoji: row.emoji, userIds: [] }));
    entry.userIds.push(row.user_id);
  }
  return out;
}

export function addReaction(db, messageId, userId, emoji) {
  const kinds = db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?').get(messageId).n;
  const exists = db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?').get(messageId, emoji);
  if (!exists && kinds >= MAX_KINDS) throw new HttpError(409, `a message can have at most ${MAX_KINDS} different reactions`);
  return (
    db
      .prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(messageId, userId, emoji, Date.now()).changes > 0
  );
}

export function removeReaction(db, messageId, userId, emoji) {
  return db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji).changes > 0;
}
