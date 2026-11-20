import { HttpError, readJson } from '../http.js';
import * as channels from '../model/channels.js';
import { messageRow } from '../model/messages.js';
import { presentNotification, unreadCounts } from '../notify.js';
import { id, int } from '../validate.js';

export default function notificationRoutes(router, { hooks }) {
  router.get('/api/notifications', ({ url, db, requireUser }) => {
    const me = requireUser();
    const q = url.searchParams;
    const limit = int(q.get('limit'), 'limit', { min: 1, max: 100, fallback: 30 });
    const before = q.has('before') ? id(q.get('before'), 'before') : Number.MAX_SAFE_INTEGER;
    const onlyUnread = q.get('unread') === '1';
    const rows = db
      .prepare(
        `SELECT * FROM notifications WHERE user_id = ? AND id < ? ${onlyUnread ? 'AND read_at IS NULL' : ''}
          ORDER BY id DESC LIMIT ?`,
      )
      .all(me.id, before, limit + 1);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(me.id).n;
    return {
      notifications: rows.slice(0, limit).map((r) => presentNotification(db, r)),
      hasMore: rows.length > limit,
      unreadCount: unread,
    };
  });

  router.post('/api/notifications/read', async ({ req, db, requireUser }) => {
    const me = requireUser();
    const body = await readJson(req);
    const now = Date.now();
    let changed;
    if (body.all === true) {
      changed = db.prepare('SELECT DISTINCT channel_id FROM notifications WHERE user_id = ? AND read_at IS NULL').all(me.id);
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, me.id);
    } else {
      if (!Array.isArray(body.ids) || body.ids.length > 500) throw new HttpError(400, 'ids must be a list of up to 500', 'invalid');
      const ids = JSON.stringify(body.ids.map((v) => id(v, 'ids')));
      changed = db
        .prepare(`SELECT DISTINCT channel_id FROM notifications WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
        .all(me.id, ids);
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))').run(
        now,
        me.id,
        ids,
      );
    }
    for (const { channel_id } of changed) hooks.emit('notificationsChanged', { userId: me.id, channelId: channel_id });
  });

  // Marks a channel read up to a message. The marker only moves forward, and
  // mentions in the channel (not in threads) up to that point are cleared.
  router.post('/api/channels/:id/read', async ({ req, params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    if (!channels.membership(db, row.id, me.id)) throw new HttpError(403, 'join the channel first', 'not_member');
    const body = await readJson(req);
    const upTo =
      body.messageId == null
        ? db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ? AND parent_id IS NULL').get(row.id).id
        : id(body.messageId, 'messageId');
    db.prepare('UPDATE memberships SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?').run(upTo, row.id, me.id);
    db.prepare(
      `UPDATE notifications SET read_at = ?
        WHERE user_id = ? AND channel_id = ? AND read_at IS NULL AND message_id <= ?
          AND message_id IN (SELECT id FROM messages WHERE channel_id = ? AND parent_id IS NULL)`,
    ).run(Date.now(), me.id, row.id, upTo, row.id);
    const counts = unreadCounts(db, row.id, me.id);
    hooks.emit('channelRead', { userId: me.id, channelId: row.id, ...counts });
    return counts;
  });

  router.post('/api/messages/:id/thread/read', ({ params, db, requireUser }) => {
    const me = requireUser();
    const message = messageRow(db, id(params.id));
    const channel = message && channels.channelRow(db, message.channel_id);
    if (!channel || !channels.canRead(db, channel, me)) throw new HttpError(404, 'no such message');
    const rootId = message.parent_id ?? message.id;
    const { changes } = db
      .prepare(
        `UPDATE notifications SET read_at = ?
          WHERE user_id = ? AND read_at IS NULL
            AND message_id IN (SELECT id FROM messages WHERE id = ? OR parent_id = ?)`,
      )
      .run(Date.now(), me.id, rootId, rootId);
    if (changes) hooks.emit('notificationsChanged', { userId: me.id, channelId: channel.id });
  });
}
