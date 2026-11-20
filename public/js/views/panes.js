import { api } from '../api.js';
import { avatar, h, icon, replace, toast } from '../dom.js';
import { relativeTime, renderSnippet } from '../lib/format.js';
import { typingLine } from './channel.js';
import { Composer } from './composer.js';
import { formatContext, messageView } from './message.js';

function paneShell(app, title, ...body) {
  return [
    h('header.pane-header', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close panel', onclick: () => app.closePane() }, icon('x'))),
    ...body,
  ];
}

export class ThreadPane {
  constructor(app, rootId) {
    this.app = app;
    this.store = app.store;
    this.kind = 'thread';
    this.rootId = rootId;
    this.list = h('div.thread-messages');
    this.typing = h('div.typing', { 'aria-live': 'polite' });
    this.footer = h('div.thread-footer');
    this.el = h('aside.pane', { 'aria-label': 'Thread' });
    this.unsubs = [this.store.on(`thread:${rootId}`, () => this.render()), this.store.on('users', () => this.render())];
    this.timer = setInterval(() => this.renderTyping(), 2000);
    replace(this.el, ...paneShell(app, 'Thread', this.list, this.typing, this.footer));
    this.load();
  }

  destroy() {
    for (const u of this.unsubs) u();
    clearInterval(this.timer);
  }

  async load() {
    try {
      const { root, replies } = await api.thread(this.rootId);
      this.rootId = root.id;
      this.store.setThread(root, replies);
      this.unsubs.push(this.store.on(`typing:${root.channelId}`, () => this.renderTyping()));
      api.readThread(root.id).catch(() => {});
    } catch (err) {
      replace(this.list, h('p.empty', err.message));
    }
  }

  renderTyping() {
    const th = this.store.threads.get(this.rootId);
    if (th) this.typing.textContent = typingLine(this.store, th.root.channelId, this.rootId);
  }

  render() {
    const th = this.store.threads.get(this.rootId);
    if (!th) return;
    const ctx = formatContext(this.store);
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
    const pending = this.store.pendingFor(th.root.channelId, th.root.id);
    const replies = [...th.replies, ...pending];
    replace(
      this.list,
      messageView(this.app, th.root, { inThread: true, ctx }),
      h('div.reply-count', replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'),
      replies.map((m) => messageView(this.app, m, { inThread: true, ctx })),
    );
    if (atBottom || pending.length) this.list.scrollTop = this.list.scrollHeight;
    const ch = this.store.channels.get(th.root.channelId);
    if (ch?.member && !ch.archived && !th.root.deleted) {
      if (!this.composer) this.composer = new Composer(this.app, { channelId: ch.id, parentId: th.root.id, placeholder: 'Reply…' });
      if (!this.footer.contains(this.composer.el)) {
        replace(this.footer, this.composer.el);
        this.composer.focus();
      }
    } else replace(this.footer);
    if (document.visibilityState === 'visible' && th.replies.length) api.readThread(th.root.id).catch(() => {});
  }
}

export class SearchPane {
  constructor(app, initial = '') {
    this.app = app;
    this.kind = 'search';
    this.offset = 0;
    this.sort = 'relevance';
    this.input = h('input.search-input', { type: 'search', placeholder: 'Search messages', 'aria-label': 'Search messages', value: initial, autocomplete: 'off' });
    this.results = h('div.search-results', { 'aria-live': 'polite' });
    this.sortSelect = h(
      'select',
      { 'aria-label': 'Sort results', onchange: (e) => ((this.sort = e.target.value), this.run()) },
      h('option', { value: 'relevance' }, 'Most relevant'),
      h('option', { value: 'recent' }, 'Newest first'),
    );
    this.el = h(
      'aside.pane',
      { 'aria-label': 'Search' },
      ...paneShell(
        app,
        'Search',
        h('div.search-bar', this.input, this.sortSelect),
        h('p.search-help', 'Try ', h('code', 'from:@name'), ' ', h('code', 'in:#channel'), ' ', h('code', 'after:2026-01-31'), ' ', h('code', '"exact phrase"'), ' ', h('code', '-exclude')),
        this.results,
      ),
    );
    let timer;
    this.input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.run(), 200);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(timer);
        this.run();
      }
    });
    queueMicrotask(() => {
      this.input.focus();
      if (initial) this.run();
    });
  }

  destroy() {}

  async run(append = false) {
    const q = this.input.value.trim();
    if (!append) this.offset = 0;
    if (!q) return replace(this.results);
    const seq = (this.seq = (this.seq || 0) + 1);
    try {
      const data = await api.search(q, { sort: this.sort, offset: this.offset, limit: 20 });
      if (seq !== this.seq) return;
      const items = data.results.map((r) => this.result(r));
      if (!append) {
        replace(this.results, h('p.muted', `${data.total} ${data.total === 1 ? 'result' : 'results'}`), items);
      } else {
        this.results.querySelector('.more')?.remove();
        this.results.append(...items);
      }
      this.offset += data.results.length;
      if (this.offset < data.total) {
        this.results.append(h('button.ghost.more', { type: 'button', onclick: () => this.run(true) }, 'Show more'));
      }
    } catch (err) {
      if (seq === this.seq) replace(this.results, h('p.error', err.message));
    }
  }

  result(r) {
    const { store } = this.app;
    const author = store.user(r.message.userId);
    const where = r.channel.kind === 'dm' ? store.channelTitle(store.channels.get(r.channel.id)) || 'Direct message' : `#${r.channel.name}`;
    return h(
      'button.search-result',
      {
        type: 'button',
        onclick: () => {
          if (r.message.parentId) this.app.openThread(r.message.parentId, { keepSearch: true });
          else this.app.navigate(`/c/${r.channel.id}/m/${r.message.id}`);
        },
      },
      h('div.result-meta', avatar(author, 20), h('strong', author.displayName), h('span.muted', `${where} · ${relativeTime(r.message.createdAt)}`), r.message.parentId ? h('span.badge.muted', 'thread') : null),
      h('div.snippet', { html: renderSnippet(r.snippet) }),
    );
  }
}

export class NotificationsPane {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.kind = 'notifications';
    this.list = h('div.notification-list');
    this.el = h(
      'aside.pane',
      { 'aria-label': 'Mentions and replies' },
      ...paneShell(app, 'Mentions & replies', h('div.pane-tools', h('button.ghost.small', { type: 'button', onclick: () => this.readAll() }, 'Mark all read')), this.list),
    );
    this.unsub = this.store.on('notifications', () => this.render());
    this.load();
  }

  destroy() {
    this.unsub();
  }

  async load(more = false) {
    try {
      const last = this.store.notifications.list.at(-1);
      const page = await api.notifications(more && last ? { before: last.id } : {});
      this.store.setNotifications(page, more);
    } catch (err) {
      replace(this.list, h('p.error', err.message));
    }
  }

  async readAll() {
    await api.readNotifications({ all: true });
    this.store.markNotificationsRead();
  }

  render() {
    const { list, hasMore } = this.store.notifications;
    const labels = { mention: 'mentioned you', channel: 'notified the channel', reply: 'replied in a thread', dm: 'sent you a message' };
    replace(
      this.list,
      list.length ? null : h('p.empty', 'Nothing here yet. Mentions, replies and direct messages show up here.'),
      list.map((n) =>
        h(
          'button.notification',
          {
            type: 'button',
            class: n.read ? '' : 'unread',
            onclick: async () => {
              if (!n.read) {
                api.readNotifications({ ids: [n.id] }).catch(() => {});
                this.store.markNotificationsRead([n.id]);
              }
              if (n.parentId) this.app.openThread(n.parentId);
              else this.app.navigate(`/c/${n.channelId}/m/${n.messageId}`);
            },
          },
          avatar(this.store.user(n.actorId), 28),
          h(
            'div',
            h('div', h('strong', n.actorName), ` ${labels[n.kind]} `, n.channelName ? h('span.muted', `in #${n.channelName}`) : null),
            h('div.preview', n.preview || '(message deleted)'),
            h('div.muted.small', relativeTime(n.createdAt)),
          ),
        ),
      ),
      hasMore ? h('button.ghost.more', { type: 'button', onclick: () => this.load(true) }, 'Older') : null,
    );
  }
}

export class MembersPane {
  constructor(app, channelId) {
    this.app = app;
    this.store = app.store;
    this.kind = 'members';
    this.channelId = channelId;
    this.list = h('ul.member-list');
    this.el = h('aside.pane', { 'aria-label': 'Members' }, ...paneShell(app, 'Members', this.list));
    this.unsubs = [this.store.on(`members:${channelId}`, () => this.load()), this.store.on('presence', () => this.render())];
    this.load();
  }

  destroy() {
    for (const u of this.unsubs) u();
  }

  async load() {
    try {
      this.members = (await api.members(this.channelId)).members;
      this.render();
    } catch (err) {
      replace(this.list, h('li.error', err.message));
    }
  }

  render() {
    if (!this.members) return;
    const ch = this.store.channels.get(this.channelId);
    const manage = ch && ch.kind !== 'dm' && (ch.role === 'owner' || this.store.me.isAdmin);
    const canInvite = ch?.member && !ch.archived && (ch.kind === 'public' || manage);
    const sorted = [...this.members].sort((a, b) => Number(this.store.online.has(b.id)) - Number(this.store.online.has(a.id)));
    replace(
      this.list,
      canInvite ? h('li', h('button.ghost.small', { type: 'button', onclick: () => this.app.invite(ch) }, icon('plus'), 'Add people')) : null,
      sorted.map((m) =>
        h(
          'li.member',
          h('button.linklike.member-name', { type: 'button', onclick: () => this.app.showProfile(m.id) }, avatar(m, 28), h('span.presence', { class: this.store.online.has(m.id) ? 'online' : '' }), h('span', m.displayName), h('span.muted', `@${m.username}`)),
          m.role === 'owner' ? h('span.badge.muted', 'owner') : null,
          manage && m.id !== this.store.me.id && ch.name !== 'general'
            ? h(
                'button.icon-btn.small',
                {
                  type: 'button',
                  title: 'Remove from channel',
                  'aria-label': `Remove ${m.displayName}`,
                  onclick: async () => {
                    if (!(await this.app.confirm(`Remove ${m.displayName} from #${ch.name}?`, '', 'Remove'))) return;
                    try {
                      await api.removeMember(ch.id, m.id);
                      this.load();
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                icon('x'),
              )
            : null,
        ),
      ),
    );
  }
}
