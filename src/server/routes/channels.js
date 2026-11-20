import { HttpError, readJson } from '../http.js';
import * as channels from '../model/channels.js';
import { bool, CHANNEL_NAME, id, text } from '../validate.js';

export const DEFAULT_CHANNEL = 'general';

export default function channelRoutes(router, { db, hooks }) {
  // Everyone lands in #general. It is created with the first account.
  hooks.on('userCreated', (user) => {
    let general = db.prepare('SELECT * FROM channels WHERE name = ?').get(DEFAULT_CHANNEL);
    if (!general) {
      general = channels.createChannel(db, {
        kind: 'public',
        name: DEFAULT_CHANNEL,
        topic: 'Company-wide announcements and chatter',
        createdBy: user.id,
      });
    } else {
      channels.addMember(db, general.id, user.id);
    }
    hooks.emit('memberAdded', { channel: general, userId: user.id });
  });

  router.get('/api/channels', ({ url, db, requireUser }) => {
    const me = requireUser();
    const rows = url.searchParams.get('browse') ? channels.browsePublic(db, me.id) : channels.listForUser(db, me.id);
    return { channels: rows.map((row) => channels.present(db, row, me.id)) };
  });

  router.post('/api/channels', async ({ req, db, requireUser }) => {
    const me = requireUser();
    const body = await readJson(req);
    const name = text(body, 'name', { max: 40, pattern: CHANNEL_NAME, trim: true }).toLowerCase();
    const topic = text(body, 'topic', { min: 0, max: 250, optional: true }) ?? '';
    const isPrivate = bool(body, 'private', { optional: true }) ?? false;
    const members = Array.isArray(body.memberIds) ? body.memberIds.map((v) => id(v, 'memberIds')) : [];
    const row = channels.createChannel(db, {
      kind: isPrivate ? 'private' : 'public',
      name,
      topic,
      createdBy: me.id,
      members: activeUsers(db, members),
    });
    hooks.emit('channelCreated', { channel: row, actorId: me.id });
    return { channel: channels.present(db, row, me.id) };
  });

  router.get('/api/channels/:id', ({ params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    return { channel: channels.present(db, row, me.id) };
  });

  router.patch('/api/channels/:id', async ({ req, params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    const body = await readJson(req);
    if (row.kind === 'dm') throw new HttpError(400, 'direct messages have no name or topic');
    const isMember = !!channels.membership(db, row.id, me.id);
    const manage = channels.canManage(db, row, me);
    const name = text(body, 'name', { max: 40, pattern: CHANNEL_NAME, optional: true })?.toLowerCase();
    const topic = text(body, 'topic', { min: 0, max: 250, optional: true });
    const archived = bool(body, 'archived', { optional: true });

    // Any member may set the topic; renames and archiving need an owner.
    if (topic !== undefined && !isMember && !manage) throw new HttpError(403, 'join the channel first', 'not_member');
    if ((name !== undefined || archived !== undefined) && !manage) {
      throw new HttpError(403, 'only channel owners can do that', 'forbidden');
    }
    if (name !== undefined && name !== row.name) {
      if (row.name === DEFAULT_CHANNEL) throw new HttpError(400, `#${DEFAULT_CHANNEL} cannot be renamed`);
      if (db.prepare('SELECT 1 FROM channels WHERE name = ?').get(name)) {
        throw new HttpError(409, `#${name} already exists`, 'name_taken');
      }
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, row.id);
    }
    if (topic !== undefined) db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, row.id);
    if (archived !== undefined) {
      if (archived && row.name === DEFAULT_CHANNEL) throw new HttpError(400, `#${DEFAULT_CHANNEL} cannot be archived`);
      db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, row.id);
    }
    const updated = channels.channelRow(db, row.id);
    hooks.emit('channelUpdated', { channel: updated, actorId: me.id });
    return { channel: channels.present(db, updated, me.id) };
  });

  router.post('/api/channels/:id/join', ({ params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    if (row.kind !== 'public') throw new HttpError(403, 'you need an invitation to join this channel');
    if (row.archived_at) throw new HttpError(409, 'this channel is archived', 'archived');
    if (channels.addMember(db, row.id, me.id)) hooks.emit('memberAdded', { channel: row, userId: me.id, actorId: me.id });
    return { channel: channels.present(db, row, me.id) };
  });

  router.post('/api/channels/:id/leave', ({ params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    if (row.kind === 'dm') throw new HttpError(400, 'you cannot leave a direct message');
    if (row.name === DEFAULT_CHANNEL) throw new HttpError(400, `everyone stays in #${DEFAULT_CHANNEL}`);
    if (channels.removeMember(db, row.id, me.id)) hooks.emit('memberRemoved', { channel: row, userId: me.id, actorId: me.id });
  });

  router.get('/api/channels/:id/members', ({ params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, m.role, m.joined_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.channel_id = ? ORDER BY m.role = 'owner' DESC, u.username`,
      )
      .all(row.id)
      .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role, joinedAt: r.joined_at }));
    return { members };
  });

  router.post('/api/channels/:id/members', async ({ req, params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.writable(db, id(params.id), me);
    if (row.kind === 'dm') throw new HttpError(400, 'start a new conversation to add people to a direct message');
    if (row.kind === 'private' && !channels.canManage(db, row, me)) {
      throw new HttpError(403, 'only channel owners can invite people here', 'forbidden');
    }
    const body = await readJson(req);
    const ids = activeUsers(db, (Array.isArray(body.userIds) ? body.userIds : [body.userId]).map((v) => id(v, 'userId')));
    const added = ids.filter((userId) => channels.addMember(db, row.id, userId));
    for (const userId of added) hooks.emit('memberAdded', { channel: row, userId, actorId: me.id });
    return { added };
  });

  router.delete('/api/channels/:id/members/:userId', ({ params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    const userId = id(params.userId, 'userId');
    if (row.kind === 'dm' || row.name === DEFAULT_CHANNEL) throw new HttpError(400, 'people cannot be removed from this conversation');
    if (userId !== me.id && !channels.canManage(db, row, me)) throw new HttpError(403, 'only channel owners can remove people', 'forbidden');
    if (channels.removeMember(db, row.id, userId)) hooks.emit('memberRemoved', { channel: row, userId, actorId: me.id });
  });

  router.put('/api/channels/:id/mute', async ({ req, params, db, requireUser }) => {
    const me = requireUser();
    const row = channels.readable(db, id(params.id), me);
    if (!channels.membership(db, row.id, me.id)) throw new HttpError(403, 'join the channel first', 'not_member');
    const muted = bool(await readJson(req), 'muted');
    db.prepare('UPDATE memberships SET muted = ? WHERE channel_id = ? AND user_id = ?').run(muted ? 1 : 0, row.id, me.id);
    return { channel: channels.present(db, row, me.id) };
  });

  router.post('/api/dms', async ({ req, db, requireUser }) => {
    const me = requireUser();
    const body = await readJson(req);
    if (!Array.isArray(body.userIds)) throw new HttpError(400, 'userIds must be a list', 'invalid');
    const { row, created } = channels.openDm(db, [me.id, ...body.userIds.map((v) => id(v, 'userIds'))]);
    if (created) hooks.emit('channelCreated', { channel: row, actorId: me.id });
    return { channel: channels.present(db, row, me.id) };
  });
}

function activeUsers(db, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = db
    .prepare('SELECT id FROM users WHERE deactivated_at IS NULL AND id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(unique))
    .map((r) => r.id);
  if (found.length !== unique.length) throw new HttpError(400, 'unknown or deactivated user in the list', 'invalid');
  return unique;
}
