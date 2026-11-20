import { HttpError, readJson } from '../http.js';
import * as channels from '../model/channels.js';
import * as messages from '../model/messages.js';
import * as reactions from '../model/reactions.js';
import { id, int } from '../validate.js';

export const EDIT_WINDOW_MS = 24 * 3600_000;

export default function messageRoutes(router, { hooks }) {
  router.get('/api/channels/:id/messages', ({ url, params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    const q = url.searchParams;
    const limit = int(q.get('limit'), 'limit', { min: 1, max: 200, fallback: messages.PAGE });
    let page;
    if (q.has('around')) page = messages.around(db, row.id, id(q.get('around'), 'around'), Math.ceil(limit / 2));
    else {
      page = messages.history(db, row.id, {
        before: q.has('before') ? id(q.get('before'), 'before') : undefined,
        after: q.has('after') ? int(q.get('after'), 'after') : undefined,
        limit,
      });
    }
    return { ...page, messages: messages.presentAll(db, page.messages) };
  });

  router.post('/api/channels/:id/messages', async ({ req, params, db, requireUser, limits }) => {
    const me = requireUser();
    limits.message.take(me.id);
    const row = channels.writable(db, id(params.id), me);
    const body = await readJson(req);
    const parentId = body.parentId == null ? null : id(body.parentId, 'parentId');
    const message = messages.postMessage(db, {
      channelId: row.id,
      userId: me.id,
      body: messages.normalizeBody(body.body),
      parentId,
    });
    // Sending a message means you have read everything before it.
    if (parentId === null) {
      db.prepare('UPDATE memberships SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?').run(
        message.id,
        row.id,
        me.id,
      );
    }
    hooks.emit('messageCreated', { message, channel: row, author: me, clientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null });
    return { message: messages.presentOne(db, message) };
  });

  router.get('/api/messages/:id', ({ params, db, requireUser }) => {
    const me = requireUser();
    const { message } = visible(db, id(params.id), me);
    return { message: messages.presentOne(db, message) };
  });

  router.get('/api/messages/:id/thread', ({ params, db, requireUser }) => {
    const me = requireUser();
    const { message } = visible(db, id(params.id), me);
    const root = message.parent_id ? messages.messageRow(db, message.parent_id) : message;
    return { root: messages.presentOne(db, root), replies: messages.presentAll(db, messages.thread(db, root.id)) };
  });

  router.patch('/api/messages/:id', async ({ req, params, db, requireUser }) => {
    const me = requireUser();
    const { message, channel } = visible(db, id(params.id), me);
    channels.writable(db, channel.id, me);
    if (message.user_id !== me.id) throw new HttpError(403, 'you can only edit your own messages', 'forbidden');
    if (message.deleted_at) throw new HttpError(409, 'that message was deleted');
    if (Date.now() - message.created_at > EDIT_WINDOW_MS) throw new HttpError(409, 'messages can only be edited for 24 hours', 'too_old');
    const body = messages.normalizeBody((await readJson(req)).body);
    if (body === message.body) return { message: messages.presentOne(db, message) };
    const updated = messages.editMessage(db, message, body);
    hooks.emit('messageUpdated', { message: updated, channel, previous: message });
    return { message: messages.presentOne(db, updated) };
  });

  router.delete('/api/messages/:id', ({ params, db, requireUser }) => {
    const me = requireUser();
    const { message, channel } = visible(db, id(params.id), me);
    const mod = channels.canManage(db, channel, me);
    if (message.user_id !== me.id && !mod) throw new HttpError(403, 'you can only delete your own messages', 'forbidden');
    if (message.deleted_at) return;
    const updated = messages.deleteMessage(db, message);
    hooks.emit('messageDeleted', { message: updated, channel });
  });

  const react = (add) => ({ params, db, requireUser }) => {
    const me = requireUser();
    const { message, channel } = visible(db, id(params.id), me);
    channels.writable(db, channel.id, me);
    if (message.deleted_at) throw new HttpError(409, 'that message was deleted');
    const emoji = reactions.checkEmoji(params.emoji);
    const changed = add ? reactions.addReaction(db, message.id, me.id, emoji) : reactions.removeReaction(db, message.id, me.id, emoji);
    const list = reactions.reactionsFor(db, [message.id]).get(message.id);
    if (changed) hooks.emit('reactionsChanged', { channel, messageId: message.id, reactions: list });
    return { reactions: list };
  };
  router.put('/api/messages/:id/reactions/:emoji', react(true));
  router.delete('/api/messages/:id/reactions/:emoji', react(false));
}

function visible(db, messageId, user) {
  const message = messages.messageRow(db, messageId);
  const channel = message && channels.channelRow(db, message.channel_id);
  if (!channel || !channels.canRead(db, channel, user)) throw new HttpError(404, 'no such message');
  return { message, channel };
}
