import { api, setUnauthenticatedHandler } from './api.js';
import { h, replace, toast } from './dom.js';
import { Store } from './lib/store.js';
import { Socket } from './socket.js';
import { authView } from './views/auth.js';
import { ChannelView } from './views/channel.js';
import {
  browseDialog,
  channelSettingsDialog,
  confirmDialog,
  createChannelDialog,
  inviteDialog,
  newDmDialog,
  profileDialog,
  settingsDialog,
  textDialog,
} from './views/dialogs.js';
import { MembersPane, NotificationsPane, SearchPane, ThreadPane } from './views/panes.js';
import { Sidebar } from './views/sidebar.js';

const root = document.getElementById('app');

class App {
  constructor(me) {
    this.store = new Store();
    this.store.setMe(me);
    this.socket = new Socket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.connected = false;
    this.currentChannelId = null;
    this.view = null;
    this.pane = null;
    this.readTimers = new Map();

    this.sidebar = new Sidebar(this);
    this.main = h('main.main');
    this.paneSlot = h('div.pane-slot');
    this.scrim = h('div.scrim', { onclick: () => this.toggleSidebar(false) });
    this.el = h('div.app', this.sidebar.el, this.scrim, this.main, this.paneSlot);
    replace(root, this.el);

    this.socket.on((event) => this.onSocket(event));
    this.store.on('notify', (n) => this.onNotify(n));
    this.store.on('channels', () => this.updateTitle());
    window.addEventListener('popstate', () => this.route());
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      this.store.viewing = document.visibilityState === 'visible' ? this.currentChannelId : null;
      if (this.store.viewing) this.markRead(this.store.viewing);
    });
    document.addEventListener('click', (e) => {
      const link = e.target.closest?.('a.channel-link');
      if (link && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.navigate(`/c/${link.dataset.channel}`);
      }
      const mention = e.target.closest?.('.mention[data-user]');
      if (mention) {
        const user = this.store.userByName(mention.dataset.user);
        if (user) this.showProfile(user.id);
      }
    });
  }

  async start() {
    replace(this.main, h('div.loading.center', 'Loading…'));
    try {
      await this.refresh();
    } catch (err) {
      replace(this.main, h('p.error.center', `Could not load: ${err.message}`));
      return;
    }
    this.socket.start();
    this.route();
  }

  async refresh() {
    const [{ users }, { channels }, notes] = await Promise.all([api.users(), api.channels(), api.notifications({ limit: 30 })]);
    this.store.setUsers(users);
    const known = [...this.store.channels.values()].filter((c) => !c.member);
    this.store.setChannels([...known, ...channels]);
    this.store.setNotifications(notes);
  }

  // --- routing -------------------------------------------------------------

  navigate(path, { replaceState = false } = {}) {
    if (location.pathname !== path) history[replaceState ? 'replaceState' : 'pushState'](null, '', path);
    this.route();
    this.toggleSidebar(false);
  }

  async route() {
    const m = /^\/c\/(\d+)(?:\/m\/(\d+))?\/?$/.exec(location.pathname);
    const channelId = m ? Number(m[1]) : null;
    const messageId = m?.[2] ? Number(m[2]) : null;
    if (!channelId) {
      const general = [...this.store.channels.values()].find((c) => c.name === 'general') || this.store.joinedChannels().rooms[0];
      if (!general) return replace(this.main, h('p.empty.center', 'You are not in any channels yet.'));
      return this.navigate(`/c/${general.id}`, { replaceState: true });
    }
    if (!this.store.channels.has(channelId)) {
      try {
        this.store.upsertChannel((await api.channel(channelId)).channel);
      } catch {
        toast('That channel does not exist or is private.', 'error');
        return this.navigate('/', { replaceState: true });
      }
    }
    this.show(channelId, messageId);
  }

  show(channelId, messageId = null) {
    const prev = this.currentChannelId;
    if (prev === channelId && !messageId && this.view) return;
    const prevChannel = this.store.channels.get(prev);
    if (prevChannel && !prevChannel.member) this.socket.unwatch(prev);
    this.view?.destroy();
    this.currentChannelId = channelId;
    this.store.viewing = document.visibilityState === 'visible' ? channelId : null;
    const ch = this.store.channels.get(channelId);
    if (ch && !ch.member) this.socket.watch(channelId);
    this.view = new ChannelView(this, channelId, { focusMessageId: messageId });
    replace(this.main, this.view.el);
    if (this.pane?.kind === 'members') this.openPane('members', channelId);
    if (this.pane?.kind === 'thread') this.closePane();
    this.store.emit('route');
    if (!messageId) queueMicrotask(() => this.view?.composer?.focus());
  }

  // --- panes ---------------------------------------------------------------

  setPane(pane) {
    this.pane?.destroy();
    this.pane = pane;
    this.el.classList.toggle('with-pane', !!pane);
    replace(this.paneSlot, pane ? pane.el : null);
    this.store.emit('route');
  }

  openPane(kind, arg) {
    if (kind === 'notifications') {
      if (this.pane?.kind === 'notifications') return this.closePane();
      this.setPane(new NotificationsPane(this));
    } else if (kind === 'members') this.setPane(new MembersPane(this, arg));
    this.toggleSidebar(false);
  }

  closePane() {
    this.setPane(null);
  }

  openThread(rootId) {
    this.setPane(new ThreadPane(this, rootId));
  }

  openSearch(q = '') {
    if (this.pane?.kind === 'search') return this.pane.input.focus();
    this.setPane(new SearchPane(this, q));
    this.toggleSidebar(false);
  }

  toggleSidebar(open) {
    this.el.classList.toggle('sidebar-open', open);
  }

  // --- sending -------------------------------------------------------------

  async sendMessage(channelId, body, parentId = null, clientId = this.store.addPending({ channelId, parentId, body })) {
    try {
      const { message } = await api.send(channelId, body, parentId, clientId);
      this.store.addMessage(message, clientId);
      if (!parentId && this.view?.channelId === channelId) this.view.scrollToBottom();
    } catch (err) {
      this.store.failPending(clientId, err.message);
    }
  }

  retrySend(clientId) {
    const p = this.store.pending.get(clientId);
    if (!p) return;
    p.failed = false;
    this.store.emit(p.parentId ? `thread:${p.parentId}` : `timeline:${p.channelId}`);
    this.sendMessage(p.channelId, p.body, p.parentId, clientId);
  }

  // Debounced so scrolling through a busy channel sends one request.
  markRead(channelId) {
    const ch = this.store.channels.get(channelId);
    if (!ch?.member || document.visibilityState !== 'visible') return;
    clearTimeout(this.readTimers.get(channelId));
    this.readTimers.set(
      channelId,
      setTimeout(async () => {
        const t = this.store.timeline(channelId);
        const last = t?.messages.filter((m) => m.id).at(-1);
        if (!last || t.hasNewer) return;
        if (last.id <= (ch.lastReadId || 0) && !ch.unreadCount && !ch.mentionCount) return;
        try {
          const counts = await api.markRead(channelId, last.id);
          Object.assign(ch, counts);
          this.store.emit('channels');
        } catch {
          // retried on the next scroll or message
        }
      }, 400),
    );
  }

  // --- channel actions -----------------------------------------------------

  async joinChannel(id) {
    try {
      const { channel } = await api.join(id);
      this.socket.unwatch(id);
      this.store.upsertChannel(channel);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async toggleMute(ch) {
    try {
      const { channel } = await api.mute(ch.id, !ch.muted);
      this.store.upsertChannel(channel);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async editTopic(ch) {
    await textDialog(`Topic for #${ch.name}`, {
      label: 'Topic',
      value: ch.topic,
      placeholder: 'What is this channel about?',
      onSubmit: async (topic) => {
        const { channel } = await api.updateChannel(ch.id, { topic });
        this.store.upsertChannel(channel);
        return true;
      },
    });
  }

  async channelSettings(ch) {
    const result = await channelSettingsDialog(this, ch);
    if (result === 'left' && ch.kind !== 'public') this.navigate('/');
  }

  async browseChannels() {
    const choice = await browseDialog(this);
    if (!choice) return;
    if (choice.create) {
      const channel = await createChannelDialog();
      if (channel) {
        this.store.upsertChannel(channel);
        this.navigate(`/c/${channel.id}`);
      }
    } else if (choice.join) {
      await this.joinChannel(choice.join);
      this.navigate(`/c/${choice.join}`);
    } else if (choice.view) this.navigate(`/c/${choice.view}`);
  }

  async newDm() {
    const channel = await newDmDialog(this);
    if (channel) {
      this.store.upsertChannel(channel);
      this.navigate(`/c/${channel.id}`);
    }
  }

  async invite(ch) {
    const { members } = await api.members(ch.id);
    const res = await inviteDialog(this, ch, members.map((m) => m.id));
    if (res?.added?.length) toast(`Added ${res.added.length} ${res.added.length === 1 ? 'person' : 'people'}.`);
    if (this.pane?.kind === 'members') this.pane.load();
  }

  async showProfile(userId) {
    if ((await profileDialog(this, userId)) === 'message') {
      try {
        const { channel } = await api.openDm([userId]);
        this.store.upsertChannel(channel);
        this.navigate(`/c/${channel.id}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  confirm(title, text, action) {
    return confirmDialog(title, text, action);
  }

  async openSettings() {
    if ((await settingsDialog(this)) === 'logout') {
      await api.logout().catch(() => {});
      this.socket.stop();
      signedOut();
    }
  }

  // --- live updates --------------------------------------------------------

  async onSocket(event) {
    if (event.type === 'open') {
      const wasOffline = this.everConnected && !this.connected;
      this.connected = this.everConnected = true;
      this.store.emit('connection');
      if (wasOffline) await this.resync();
      return;
    }
    if (event.type === 'close') {
      this.connected = false;
      this.store.emit('connection');
      if (event.code === 4001) signedOut('Your account was deactivated.');
      return;
    }
    this.store.apply(event);
    if (event.type === 'channel.left' && event.channelId === this.currentChannelId) {
      const ch = this.store.channels.get(event.channelId);
      if (!ch) {
        toast('You were removed from that conversation.');
        this.navigate('/');
      }
    }
    if (event.type === 'message.created' && event.message.channelId === this.currentChannelId && !event.message.parentId) {
      this.markRead(this.currentChannelId);
    }
  }

  // After a reconnect, fetch what we missed instead of trusting the gap.
  async resync() {
    try {
      await this.refresh();
      if (this.currentChannelId) {
        const t = this.store.timeline(this.currentChannelId);
        const last = t?.messages.filter((m) => m.id).at(-1);
        const page = await api.history(this.currentChannelId, last ? { after: last.id, limit: 100 } : { limit: 50 });
        if (!last || page.hasMore) this.store.setTimeline(this.currentChannelId, await api.history(this.currentChannelId, { limit: 50 }));
        else this.store.setTimeline(this.currentChannelId, page, 'newer');
      }
      if (this.pane?.kind === 'thread') this.pane.load();
    } catch (err) {
      toast(`Could not catch up: ${err.message}`, 'error');
    }
  }

  onNotify(n) {
    if (document.visibilityState === 'visible' && n.channelId === this.currentChannelId) return;
    const ch = this.store.channels.get(n.channelId);
    const where = ch?.kind === 'dm' ? '' : ` in #${n.channelName}`;
    const title = `${n.actorName}${where}`;
    if (document.visibilityState === 'visible') toast(`${title}: ${n.preview}`);
    else if ('Notification' in window && Notification.permission === 'granted') {
      const note = new Notification(title, { body: n.preview, tag: `rookery-${n.id}` });
      note.onclick = () => {
        window.focus();
        if (n.parentId) this.openThread(n.parentId);
        else this.navigate(`/c/${n.channelId}/m/${n.messageId}`);
        note.close();
      };
    }
  }

  updateTitle() {
    const { mentions, unread } = this.store.totalUnread();
    const base = document.title.replace(/^\(\d+\*?\) /, '').replace(/^\* /, '');
    document.title = mentions ? `(${mentions}) ${base}` : unread ? `* ${base}` : base;
  }

  onKey(e) {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      this.openSearch();
    } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.openSearch();
    } else if (e.key === 'Escape' && this.pane && !document.querySelector('dialog[open]')) {
      if (!typing || this.pane.el.contains(e.target)) this.closePane();
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const { rooms, dms } = this.store.joinedChannels();
      const all = [...rooms, ...dms];
      const i = all.findIndex((c) => c.id === this.currentChannelId);
      const next = all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
      if (next) this.navigate(`/c/${next.id}`);
    }
  }
}

let app = null;

function signedOut(message) {
  app?.socket.stop();
  app = null;
  if (message) toast(message, 'error');
  if (location.pathname !== '/') history.replaceState(null, '', '/');
  document.title = 'Rookery';
  authView(root, signedIn);
}

function signedIn(user) {
  app = new App(user);
  window.rookery = app;
  app.start();
}

setUnauthenticatedHandler(() => {
  if (app) signedOut('Your session ended. Please sign in again.');
});

api.me().then(
  ({ user }) => signedIn(user),
  (err) => {
    if (err.status === 401) authView(root, signedIn);
    else replace(root, h('p.error.center', `Cannot reach the server: ${err.message}`));
  },
);
