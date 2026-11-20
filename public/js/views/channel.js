import { api } from '../api.js';
import { avatar, h, icon, replace, toast } from '../dom.js';
import { dayLabel, groupsWith, sameDay } from '../lib/format.js';
import { Composer } from './composer.js';
import { formatContext, messageView, startEdit } from './message.js';

const NEAR_BOTTOM = 80;

export function typingLine(store, channelId, parentId = null) {
  const people = store.typers(channelId, parentId).filter((u) => u.id !== store.me.id);
  if (!people.length) return '';
  const names = people.map((u) => u.displayName);
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

// The main column for one channel or DM.
export class ChannelView {
  constructor(app, channelId, { focusMessageId = null } = {}) {
    this.app = app;
    this.store = app.store;
    this.channelId = channelId;
    this.focusMessageId = focusMessageId;
    this.unsubs = [];
    this.loadingOlder = false;
    this.stick = true;
    // Where the "new messages" line goes; fixed when the channel is opened.
    this.newLineAfter = this.store.channels.get(channelId)?.lastReadId ?? 0;

    this.header = h('header.channel-header');
    this.list = h('div.messages', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0' });
    this.scroller = h('div.scroller', this.list);
    this.typing = h('div.typing', { 'aria-live': 'polite' });
    this.jump = h('button.jump-latest', { type: 'button', hidden: true, onclick: () => this.jumpToLatest() }, 'Jump to latest ↓');
    this.footer = h('div.channel-footer');
    this.el = h('section.channel-view', this.header, h('div.scroll-wrap', this.scroller, this.jump), this.typing, this.footer);

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.unsubs.push(
      this.store.on(`timeline:${channelId}`, () => this.renderMessages()),
      this.store.on(`channel:${channelId}`, () => {
        this.renderHeader();
        this.renderFooter();
      }),
      this.store.on('users', () => this.renderMessages()),
      this.store.on('presence', () => this.renderHeader()),
      this.store.on(`typing:${channelId}`, () => this.renderTyping()),
    );
    this.typingTimer = setInterval(() => this.renderTyping(), 2000);

    this.renderHeader();
    this.renderFooter();
    this.renderMessages();
    this.load();
  }

  get channel() {
    return this.store.channels.get(this.channelId);
  }

  destroy() {
    for (const u of this.unsubs) u();
    clearInterval(this.typingTimer);
  }

  async load() {
    try {
      if (this.focusMessageId) {
        const page = await api.history(this.channelId, { around: this.focusMessageId, limit: 60 });
        this.store.setTimeline(this.channelId, page);
        this.stick = false;
        requestAnimationFrame(() => this.scrollToMessage(this.focusMessageId));
      } else {
        const page = await api.history(this.channelId, { limit: 50 });
        this.store.setTimeline(this.channelId, page);
        this.scrollToBottom();
      }
    } catch (err) {
      replace(this.list, h('p.empty', `Could not load messages: ${err.message}`));
    }
  }

  async loadOlder() {
    const t = this.store.timeline(this.channelId);
    if (!t?.hasMore || this.loadingOlder || !t.messages.length) return;
    this.loadingOlder = true;
    try {
      const page = await api.history(this.channelId, { before: t.messages[0].id, limit: 50 });
      this.store.setTimeline(this.channelId, page, 'older');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this.loadingOlder = false;
    }
  }

  async loadNewer() {
    const t = this.store.timeline(this.channelId);
    if (!t?.hasNewer || this.loadingNewer) return;
    this.loadingNewer = true;
    try {
      const last = t.messages[t.messages.length - 1];
      const page = await api.history(this.channelId, { after: last?.id ?? 0, limit: 100 });
      this.store.setTimeline(this.channelId, page, 'newer');
    } finally {
      this.loadingNewer = false;
    }
  }

  async jumpToLatest() {
    const t = this.store.timeline(this.channelId);
    if (t?.hasNewer) {
      const page = await api.history(this.channelId, { limit: 50 });
      this.store.setTimeline(this.channelId, page);
    }
    this.focusMessageId = null;
    this.scrollToBottom();
  }

  onScroll() {
    const s = this.scroller;
    const fromBottom = s.scrollHeight - s.scrollTop - s.clientHeight;
    const t = this.store.timeline(this.channelId);
    this.stick = fromBottom < NEAR_BOTTOM && !t?.hasNewer;
    this.jump.hidden = this.stick;
    if (s.scrollTop < 300) this.loadOlder();
    if (fromBottom < 300 && t?.hasNewer) this.loadNewer();
    if (this.stick) this.app.markRead(this.channelId);
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.stick = true;
      this.jump.hidden = true;
      this.app.markRead(this.channelId);
    });
  }

  scrollToMessage(id) {
    const el = this.list.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
  }

  editLast() {
    const t = this.store.timeline(this.channelId);
    const mine = t?.messages.filter((m) => m.userId === this.store.me.id && !m.deleted).pop();
    const el = mine && this.list.querySelector(`[data-id="${mine.id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      startEdit(this.app, el, mine);
    }
  }

  renderHeader() {
    const ch = this.channel;
    if (!ch) return replace(this.header, h('h1', 'Channel not found'));
    const store = this.store;
    let title;
    if (ch.kind === 'dm') {
      const partner = store.dmPartner(ch);
      title = h(
        'h1.title',
        partner ? avatar(partner, 24) : icon('users'),
        h('span', store.channelTitle(ch)),
        partner ? h('span.presence', { class: store.online.has(partner.id) ? 'online' : '', title: store.online.has(partner.id) ? 'Online' : 'Away' }) : null,
      );
    } else {
      title = h('h1.title', icon(ch.kind === 'private' ? 'lock' : 'hash'), h('span', ch.name), ch.archived ? h('span.badge.muted', 'archived') : null);
    }
    const topic =
      ch.kind === 'dm'
        ? null
        : h(
            'button.topic.linklike',
            {
              type: 'button',
              title: ch.member ? 'Edit topic' : '',
              disabled: !ch.member || ch.archived,
              onclick: () => this.app.editTopic(ch),
            },
            ch.topic || (ch.member ? 'Add a topic' : ''),
          );
    replace(
      this.header,
      h('button.icon-btn.menu-toggle', { type: 'button', 'aria-label': 'Show channels', onclick: () => this.app.toggleSidebar(true) }, icon('menu')),
      h('div.heading', title, topic),
      h(
        'div.header-actions',
        ch.kind !== 'dm'
          ? h('button.ghost.small', { type: 'button', title: 'Members', onclick: () => this.app.openPane('members', ch.id) }, icon('users'), String(ch.memberCount ?? ''))
          : null,
        ch.member
          ? h(
              'button.icon-btn',
              {
                type: 'button',
                title: ch.muted ? 'Unmute' : 'Mute',
                'aria-label': ch.muted ? 'Unmute channel' : 'Mute channel',
                'aria-pressed': String(!!ch.muted),
                onclick: () => this.app.toggleMute(ch),
              },
              icon(ch.muted ? 'bellOff' : 'bell'),
            )
          : null,
        ch.kind !== 'dm' && ch.member
          ? h('button.icon-btn', { type: 'button', title: 'Channel settings', 'aria-label': 'Channel settings', onclick: () => this.app.channelSettings(ch) }, icon('settings'))
          : null,
      ),
    );
    document.title = `${ch.kind === 'dm' ? '' : '#'}${store.channelTitle(ch)} · Rookery`;
  }

  renderFooter() {
    const ch = this.channel;
    if (!ch) return replace(this.footer);
    if (ch.archived) return replace(this.footer, h('div.banner', 'This channel is archived. You can read it, but not post.'));
    if (!ch.member) {
      return replace(
        this.footer,
        h(
          'div.banner',
          h('span', 'You are viewing ', h('strong', `#${ch.name}`), '.'),
          h('button.primary', { type: 'button', onclick: () => this.app.joinChannel(ch.id) }, 'Join channel'),
        ),
      );
    }
    if (!this.composer) {
      const label = ch.kind === 'dm' ? `Message ${this.store.channelTitle(ch)}` : `Message #${ch.name}`;
      this.composer = new Composer(this.app, { channelId: ch.id, placeholder: label, onEditLast: () => this.editLast() });
    }
    if (!this.footer.contains(this.composer.el)) replace(this.footer, this.composer.el);
  }

  renderTyping() {
    this.typing.textContent = typingLine(this.store, this.channelId);
  }

  renderMessages() {
    const t = this.store.timeline(this.channelId);
    if (!t) return replace(this.list, h('div.loading', 'Loading…'));
    const s = this.scroller;
    const fromBottom = s.scrollHeight - s.scrollTop;
    const wasStuck = this.stick;
    const ctx = formatContext(this.store);
    const nodes = [];
    const ch = this.channel;

    if (t.hasMore) nodes.push(h('div.loading-older', this.loadingOlder ? 'Loading…' : ''));
    else nodes.push(this.intro(ch));

    let prev = null;
    let newShown = false;
    const all = [...t.messages, ...(t.hasNewer ? [] : this.store.pendingFor(this.channelId))];
    for (const m of all) {
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) nodes.push(h('div.day-divider', { role: 'separator' }, h('span', dayLabel(m.createdAt))));
      if (!newShown && m.id && m.id > this.newLineAfter && prev && this.newLineAfter && m.userId !== this.store.me.id) {
        nodes.push(h('div.new-divider', { role: 'separator' }, h('span', 'New')));
        newShown = true;
      }
      const grouped = groupsWith(prev, m) && !(newShown && nodes[nodes.length - 1].classList?.contains('new-divider'));
      nodes.push(messageView(this.app, m, { grouped, ctx, highlight: m.id === this.focusMessageId }));
      prev = m;
    }
    if (!all.length) nodes.push(h('p.empty', 'No messages yet. Say hello!'));
    if (t.hasNewer) nodes.push(h('div.loading-newer', 'Loading newer messages…'));
    replace(this.list, nodes);

    if (wasStuck) s.scrollTop = s.scrollHeight;
    else s.scrollTop = s.scrollHeight - fromBottom;
    if (wasStuck) this.app.markRead(this.channelId);
  }

  intro(ch) {
    if (!ch) return null;
    if (ch.kind === 'dm') {
      return h('div.intro', h('h2', this.store.channelTitle(ch)), h('p', 'This is the start of your direct message history.'));
    }
    return h(
      'div.intro',
      h('h2', `${ch.kind === 'private' ? '🔒 ' : '#'}${ch.name}`),
      h('p', `This is the very beginning of ${ch.kind === 'private' ? 'the private channel' : 'the channel'} #${ch.name}.`, ch.topic ? ` Topic: ${ch.topic}` : ''),
    );
  }
}
