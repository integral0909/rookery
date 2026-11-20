// Client-side state. Holds what the server has told us and applies live
// events to it; views subscribe to topics and re-render. No DOM access, so
// it runs under Node in the tests.

const TYPING_MS = 6000;
const MAX_TIMELINE = 400;

export class Store {
  constructor() {
    this.me = null;
    this.users = new Map();
    this.online = new Set();
    this.channels = new Map();
    this.timelines = new Map(); // channelId -> { messages, hasMore, hasNewer }
    this.threads = new Map(); // rootId -> { root, replies }
    this.pending = new Map(); // clientId -> pending message
    this.typing = new Map(); // channelId -> Map(userId -> { until, parentId })
    this.notifications = { list: [], unread: 0, loaded: false, hasMore: false };
    this.viewing = null; // channel on screen while the tab is visible
    this.listeners = new Map();
    this.seq = 0;
  }

  on(topic, fn) {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic).add(fn);
    return () => this.listeners.get(topic)?.delete(fn);
  }

  emit(topic, detail) {
    for (const fn of this.listeners.get(topic) || []) fn(detail);
    for (const fn of this.listeners.get('*') || []) fn(topic, detail);
  }

  // --- users ---------------------------------------------------------------

  setMe(user) {
    this.me = user;
    this.users.set(user.id, user);
    this.emit('me');
  }

  setUsers(list) {
    for (const u of list) this.users.set(u.id, u);
    if (this.me && this.users.has(this.me.id)) this.me = this.users.get(this.me.id);
    this.emit('users');
  }

  user(id) {
    return this.users.get(id) || { id, username: `user${id}`, displayName: 'Unknown user' };
  }

  userByName(name) {
    const lower = String(name).toLowerCase();
    for (const u of this.users.values()) if (u.username.toLowerCase() === lower) return u;
    return null;
  }

  // --- channels ------------------------------------------------------------

  setChannels(list) {
    this.channels = new Map(list.map((c) => [c.id, c]));
    this.emit('channels');
  }

  upsertChannel(channel) {
    const prev = this.channels.get(channel.id);
    this.channels.set(channel.id, { ...prev, ...channel });
    this.emit('channels');
    this.emit(`channel:${channel.id}`);
  }

  removeChannel(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    // Public channels stay readable after leaving; others disappear.
    if (ch.kind === 'public') this.channels.set(id, { ...ch, member: false, role: null, unreadCount: 0, mentionCount: 0 });
    else {
      this.channels.delete(id);
      this.timelines.delete(id);
    }
    this.emit('channels');
    this.emit(`channel:${id}`);
  }

  joinedChannels() {
    const list = [...this.channels.values()].filter((c) => c.member);
    const rooms = list.filter((c) => c.kind !== 'dm' && !c.archived).sort((a, b) => a.name.localeCompare(b.name));
    const dms = list.filter((c) => c.kind === 'dm').sort((a, b) => (b.lastActivity || b.createdAt) - (a.lastActivity || a.createdAt));
    return { rooms, dms };
  }

  channelTitle(channel) {
    if (!channel) return '';
    if (channel.kind !== 'dm') return channel.name;
    const others = (channel.memberIds || []).filter((id) => id !== this.me?.id);
    if (!others.length) return `${this.me?.displayName ?? 'You'} (you)`;
    return others.map((id) => this.user(id).displayName).join(', ');
  }

  dmPartner(channel) {
    if (channel?.kind !== 'dm') return null;
    const others = (channel.memberIds || []).filter((id) => id !== this.me?.id);
    return others.length === 1 ? this.user(others[0]) : null;
  }

  totalUnread() {
    let mentions = 0;
    let unread = 0;
    for (const c of this.channels.values()) {
      if (!c.member) continue;
      mentions += c.mentionCount || 0;
      if (!c.muted) unread += c.unreadCount || 0;
    }
    return { mentions, unread };
  }

  // --- messages ------------------------------------------------------------

  timeline(channelId) {
    return this.timelines.get(channelId);
  }

  // mode: 'replace' for a fresh load, 'older' / 'newer' for paging.
  setTimeline(channelId, page, mode = 'replace') {
    const prev = this.timelines.get(channelId);
    let t;
    if (mode === 'replace' || !prev) {
      t = { messages: page.messages, hasMore: page.hasMore, hasNewer: !!page.hasNewer };
    } else if (mode === 'older') {
      t = { ...prev, messages: dedupe([...page.messages, ...prev.messages]), hasMore: page.hasMore };
    } else {
      const merged = dedupe([...prev.messages, ...page.messages]);
      t = { ...prev, messages: merged, hasNewer: page.hasMore };
    }
    if (t.messages.length > MAX_TIMELINE && mode !== 'older') {
      t.messages = t.messages.slice(-MAX_TIMELINE);
      t.hasMore = true;
    }
    this.timelines.set(channelId, t);
    this.emit(`timeline:${channelId}`);
  }

  setThread(root, replies) {
    this.threads.set(root.id, { root, replies });
    this.#patchMessage(root);
    this.emit(`thread:${root.id}`);
  }

  // Optimistic send: shows the message right away, replaced by the real one
  // when the server echoes the same clientId.
  addPending({ channelId, parentId = null, body }) {
    const clientId = `c${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    this.pending.set(clientId, { clientId, channelId, parentId, body, userId: this.me.id, createdAt: Date.now(), failed: false, pending: true });
    this.#emitMessages(channelId, parentId);
    return clientId;
  }

  failPending(clientId, error) {
    const p = this.pending.get(clientId);
    if (!p) return;
    p.failed = true;
    p.error = error;
    this.#emitMessages(p.channelId, p.parentId);
  }

  dropPending(clientId) {
    const p = this.pending.get(clientId);
    if (!p) return;
    this.pending.delete(clientId);
    this.#emitMessages(p.channelId, p.parentId);
  }

  pendingFor(channelId, parentId = null) {
    return [...this.pending.values()].filter((p) => p.channelId === channelId && p.parentId === parentId);
  }

  // A message arrived over the socket or as the reply to our POST.
  addMessage(message, clientId = null) {
    if (clientId) this.pending.delete(clientId);
    const channel = this.channels.get(message.channelId);
    if (message.parentId) {
      const th = this.threads.get(message.parentId);
      if (th && !th.replies.some((m) => m.id === message.id)) th.replies.push(message);
      this.emit(`thread:${message.parentId}`);
    } else {
      const t = this.timelines.get(message.channelId);
      if (t && !t.hasNewer && !t.messages.some((m) => m.id === message.id)) {
        t.messages.push(message);
        if (t.messages.length > MAX_TIMELINE) {
          t.messages.shift();
          t.hasMore = true;
        }
      }
      if (channel) {
        channel.lastActivity = message.createdAt;
        const mine = message.userId === this.me?.id;
        if (mine) channel.lastReadId = Math.max(channel.lastReadId || 0, message.id);
        else if (channel.member && this.viewing !== channel.id && message.id > (channel.lastReadId || 0)) {
          channel.unreadCount = (channel.unreadCount || 0) + 1;
        }
        this.emit('channels');
      }
      this.emit(`timeline:${message.channelId}`);
    }
    this.clearTyping(message.channelId, message.userId);
  }

  updateMessage(message) {
    this.#patchMessage(message);
  }

  setReactions(messageId, channelId, reactions) {
    this.#patchMessage({ id: messageId, channelId, reactions }, true);
  }

  // Finds a message in the loaded timeline or threads.
  findMessage(id) {
    for (const t of this.timelines.values()) {
      const m = t.messages.find((x) => x.id === id);
      if (m) return m;
    }
    for (const th of this.threads.values()) {
      if (th.root.id === id) return th.root;
      const m = th.replies.find((x) => x.id === id);
      if (m) return m;
    }
    return null;
  }

  #patchMessage(message, partial = false) {
    const touch = (list) => {
      const i = list.findIndex((m) => m.id === message.id);
      if (i < 0) return false;
      list[i] = partial ? { ...list[i], ...message } : { ...list[i], ...message };
      return true;
    };
    const t = this.timelines.get(message.channelId);
    if (t && touch(t.messages)) this.emit(`timeline:${message.channelId}`);
    for (const [rootId, th] of this.threads) {
      let hit = false;
      if (th.root.id === message.id) {
        th.root = { ...th.root, ...message };
        hit = true;
      }
      if (touch(th.replies)) hit = true;
      if (hit) this.emit(`thread:${rootId}`);
    }
  }

  #emitMessages(channelId, parentId) {
    if (parentId) this.emit(`thread:${parentId}`);
    else this.emit(`timeline:${channelId}`);
  }

  // --- typing --------------------------------------------------------------

  setTyping(channelId, userId, parentId = null, now = Date.now()) {
    if (!this.typing.has(channelId)) this.typing.set(channelId, new Map());
    this.typing.get(channelId).set(userId, { until: now + TYPING_MS, parentId });
    this.emit(`typing:${channelId}`);
  }

  clearTyping(channelId, userId) {
    if (this.typing.get(channelId)?.delete(userId)) this.emit(`typing:${channelId}`);
  }

  typers(channelId, parentId = null, now = Date.now()) {
    const map = this.typing.get(channelId);
    if (!map) return [];
    const out = [];
    for (const [userId, t] of map) {
      if (t.until < now) map.delete(userId);
      else if ((t.parentId ?? null) === parentId) out.push(this.user(userId));
    }
    return out;
  }

  // --- notifications -------------------------------------------------------

  setNotifications(page, append = false) {
    this.notifications = {
      list: append ? [...this.notifications.list, ...page.notifications] : page.notifications,
      unread: page.unreadCount,
      loaded: true,
      hasMore: page.hasMore,
    };
    this.emit('notifications');
  }

  markNotificationsRead(ids = null) {
    let changed = 0;
    for (const n of this.notifications.list) {
      if (!n.read && (!ids || ids.includes(n.id))) {
        n.read = true;
        changed++;
      }
    }
    this.notifications.unread = ids ? Math.max(0, this.notifications.unread - changed) : 0;
    this.emit('notifications');
  }

  // --- server events -------------------------------------------------------

  apply(event) {
    switch (event.type) {
      case 'hello':
        this.online = new Set(event.online);
        this.emit('presence');
        break;
      case 'presence':
        if (event.online) this.online.add(event.userId);
        else this.online.delete(event.userId);
        this.emit('presence');
        break;
      case 'user.updated':
        this.users.set(event.user.id, event.user);
        if (event.user.id === this.me?.id) this.setMe(event.user);
        this.emit('users');
        break;
      case 'message.created':
        this.addMessage(event.message, event.clientId);
        break;
      case 'message.updated':
      case 'message.deleted':
        this.updateMessage(event.message);
        break;
      case 'reactions.updated':
        this.setReactions(event.messageId, event.channelId, event.reactions);
        break;
      case 'typing':
        this.setTyping(event.channelId, event.userId, event.parentId);
        break;
      case 'channel.joined':
      case 'channel.updated':
        this.upsertChannel(event.channel);
        break;
      case 'channel.left':
        this.removeChannel(event.channelId);
        break;
      case 'member.added':
      case 'member.removed': {
        const ch = this.channels.get(event.channelId);
        if (ch) {
          ch.memberCount = Math.max(0, (ch.memberCount || 0) + (event.type === 'member.added' ? 1 : -1));
          if (ch.kind === 'dm' && ch.memberIds && event.type === 'member.added') ch.memberIds.push(event.userId);
          this.emit(`channel:${ch.id}`);
          this.emit(`members:${ch.id}`);
        }
        break;
      }
      case 'channel.read': {
        const ch = this.channels.get(event.channelId);
        if (ch) {
          Object.assign(ch, { unreadCount: event.unreadCount, mentionCount: event.mentionCount, lastReadId: event.lastReadId });
          this.emit('channels');
        }
        break;
      }
      case 'notification.created': {
        const ch = this.channels.get(event.notification.channelId);
        if (ch) {
          ch.mentionCount = event.mentionCount;
          this.emit('channels');
        }
        if (this.notifications.loaded) this.notifications.list.unshift(event.notification);
        this.notifications.unread++;
        this.emit('notifications');
        this.emit('notify', event.notification);
        break;
      }
      default:
        break;
    }
  }
}

function dedupe(messages) {
  const seen = new Set();
  return messages.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).sort((a, b) => a.id - b.id);
}
