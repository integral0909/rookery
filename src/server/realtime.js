import { WebSocketServer } from 'ws';
import { checkOrigin, tokenFromRequest, userForToken } from './auth.js';
import { canRead, channelRow, memberIds, present as presentChannel, unreadCounts } from './model/channels.js';
import { presentOne } from './model/messages.js';

const HEARTBEAT_MS = 30_000;
const TYPING_MIN_GAP_MS = 2_000;
const MAX_WATCHED = 20;

// Pushes domain events to connected browsers. Each socket belongs to one
// user and hears about the channels that user is a member of, plus public
// channels it is currently viewing without having joined ("watching").
export class Hub {
  constructor({ db, hooks, server, log = () => {} }) {
    this.db = db;
    this.log = log;
    this.sockets = new Map(); // userId -> Set<ws>
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    this.timer = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
    this.#subscribe(hooks);
  }

  online() {
    return [...this.sockets.keys()];
  }

  isOnline(userId) {
    return this.sockets.has(userId);
  }

  close() {
    clearInterval(this.timer);
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    this.wss.close();
  }

  sendToUser(userId, event) {
    const set = this.sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  // Everyone allowed to see the channel who is connected: its members, and
  // for public channels anyone watching it.
  sendToChannel(channel, event, { except = null } = {}) {
    const data = JSON.stringify(event);
    const members = new Set(memberIds(this.db, channel.id));
    for (const [userId, set] of this.sockets) {
      if (userId === except) continue;
      for (const ws of set) {
        if (ws.readyState !== ws.OPEN) continue;
        if (members.has(userId) || (channel.kind === 'public' && ws.watching.has(channel.id))) ws.send(data);
      }
    }
  }

  broadcast(event) {
    const data = JSON.stringify(event);
    for (const set of this.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  #upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const refuse = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return refuse(404, 'Not Found');
    try {
      checkOrigin(req);
    } catch {
      return refuse(403, 'Forbidden');
    }
    const token = tokenFromRequest(req);
    const user = userForToken(this.db, token);
    if (!user) return refuse(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#connected(ws, user, token));
  }

  #connected(ws, user, token) {
    ws.user = user;
    ws.token = token;
    ws.alive = true;
    ws.watching = new Set();
    ws.lastTyping = new Map();
    const first = !this.sockets.has(user.id);
    if (first) this.sockets.set(user.id, new Set());
    this.sockets.get(user.id).add(ws);

    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data) => this.#received(ws, data));
    ws.on('close', () => {
      const set = this.sockets.get(user.id);
      set?.delete(ws);
      if (set && set.size === 0) {
        this.sockets.delete(user.id);
        this.broadcast({ type: 'presence', userId: user.id, online: false });
      }
    });
    ws.on('error', (err) => this.log('warn', 'websocket error', err.message));

    ws.send(JSON.stringify({ type: 'hello', userId: user.id, online: this.online() }));
    if (first) this.broadcast({ type: 'presence', userId: user.id, online: true });
  }

  #received(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const channelId = Number(msg.channelId);
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', id: msg.id ?? null }));
        break;
      case 'watch': {
        const row = channelRow(this.db, channelId);
        if (!row || row.kind !== 'public') return;
        if (ws.watching.size >= MAX_WATCHED) ws.watching.delete(ws.watching.values().next().value);
        ws.watching.add(channelId);
        break;
      }
      case 'unwatch':
        ws.watching.delete(channelId);
        break;
      case 'typing': {
        const row = channelRow(this.db, channelId);
        if (!row || !memberIds(this.db, channelId).includes(ws.user.id)) return;
        const now = Date.now();
        if (now - (ws.lastTyping.get(channelId) || 0) < TYPING_MIN_GAP_MS) return;
        ws.lastTyping.set(channelId, now);
        const parentId = Number.isSafeInteger(msg.parentId) ? msg.parentId : null;
        this.sendToChannel(row, { type: 'typing', channelId, parentId, userId: ws.user.id }, { except: ws.user.id });
        break;
      }
      default:
        break;
    }
  }

  // Also drops sockets whose session has ended (logout, password change,
  // expiry) so a revoked session stops receiving events.
  #heartbeat() {
    for (const set of this.sockets.values()) {
      for (const ws of set) {
        if (!ws.alive || !userForToken(this.db, ws.token)) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }
  }

  #subscribe(hooks) {
    const db = this.db;

    hooks.on('messageCreated', ({ message, channel, clientId }) => {
      this.sendToChannel(channel, { type: 'message.created', message: presentOne(db, message), clientId });
      if (message.parent_id) {
        const root = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.parent_id);
        this.sendToChannel(channel, { type: 'message.updated', message: presentOne(db, root) });
      }
    });
    hooks.on('messageUpdated', ({ message, channel }) => {
      this.sendToChannel(channel, { type: 'message.updated', message: presentOne(db, message) });
    });
    hooks.on('messageDeleted', ({ message, channel }) => {
      this.sendToChannel(channel, { type: 'message.deleted', message: presentOne(db, message) });
    });

    hooks.on('channelCreated', ({ channel }) => {
      for (const userId of memberIds(db, channel.id)) {
        this.sendToUser(userId, { type: 'channel.joined', channel: presentChannel(db, channel, userId) });
      }
    });
    hooks.on('channelUpdated', ({ channel }) => {
      for (const [userId, set] of this.sockets) {
        const user = [...set][0]?.user;
        if (user && canRead(db, channel, user)) {
          this.sendToUser(userId, { type: 'channel.updated', channel: presentChannel(db, channel, userId) });
        }
      }
    });
    hooks.on('memberAdded', ({ channel, userId }) => {
      const row = channelRow(db, channel.id);
      this.sendToUser(userId, { type: 'channel.joined', channel: presentChannel(db, row, userId) });
      this.sendToChannel(row, { type: 'member.added', channelId: row.id, userId }, { except: userId });
    });
    hooks.on('memberRemoved', ({ channel, userId }) => {
      this.sendToUser(userId, { type: 'channel.left', channelId: channel.id });
      for (const ws of this.sockets.get(userId) || []) if (channel.kind !== 'public') ws.watching.delete(channel.id);
      this.sendToChannel(channel, { type: 'member.removed', channelId: channel.id, userId });
    });

    hooks.on('reactionsChanged', ({ channel, messageId, reactions }) => {
      this.sendToChannel(channel, { type: 'reactions.updated', channelId: channel.id, messageId, reactions });
    });

    hooks.on('notificationCreated', ({ userId, notification }) => {
      const channel = channelRow(db, notification.channelId);
      this.sendToUser(userId, { type: 'notification.created', notification, ...unreadCounts(db, channel.id, userId) });
    });
    // Read markers and cleared mentions are synced to the user's other tabs.
    hooks.on('channelRead', ({ userId, channelId, ...counts }) => {
      this.sendToUser(userId, { type: 'channel.read', channelId, ...counts });
    });
    hooks.on('notificationsChanged', ({ userId, channelId }) => {
      this.sendToUser(userId, { type: 'channel.read', channelId, ...unreadCounts(db, channelId, userId) });
    });

    hooks.on('userCreated', (user) => this.broadcast({ type: 'user.updated', user }));
    hooks.on('userUpdated', (user) => this.broadcast({ type: 'user.updated', user }));
    hooks.on('userDeactivated', (user) => {
      for (const ws of this.sockets.get(user.id) || []) ws.close(4001, 'account deactivated');
    });
  }
}
