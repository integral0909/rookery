import { avatar, h, icon, replace } from '../dom.js';

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.el = h('nav.sidebar', { 'aria-label': 'Channels and conversations' });
    for (const topic of ['channels', 'presence', 'users', 'notifications', 'me', 'route', 'connection']) {
      this.store.on(topic, () => this.render());
    }
    this.render();
  }

  item(ch) {
    const { store, app } = this;
    const active = app.currentChannelId === ch.id;
    const unread = !ch.muted && ch.unreadCount > 0;
    let lead;
    if (ch.kind === 'dm') {
      const partner = store.dmPartner(ch);
      lead = partner
        ? h('span.dm-lead', avatar(partner, 20), h('span.presence', { class: store.online.has(partner.id) ? 'online' : '' }))
        : h('span.dm-lead.group', String((ch.memberIds?.length ?? 1) - 1));
    } else {
      lead = icon(ch.kind === 'private' ? 'lock' : 'hash');
    }
    return h(
      'li',
      h(
        'a.channel-item',
        {
          href: `/c/${ch.id}`,
          class: [active ? 'active' : '', unread ? 'unread' : '', ch.muted ? 'muted' : ''].join(' '),
          'aria-current': active ? 'page' : null,
          onclick: (e) => {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            app.navigate(`/c/${ch.id}`);
          },
        },
        lead,
        h('span.name', store.channelTitle(ch)),
        ch.mentionCount > 0 ? h('span.badge', { 'aria-label': `${ch.mentionCount} mentions` }, String(ch.mentionCount)) : null,
      ),
    );
  }

  render() {
    const { store, app } = this;
    if (!store.me) return;
    const { rooms, dms } = store.joinedChannels();
    const notes = store.notifications.unread;
    replace(
      this.el,
      h(
        'div.workspace',
        h('span.logo', { 'aria-hidden': 'true' }, '🐦'),
        h('span.workspace-name', 'Rookery'),
        app.connected ? null : h('span.offline', { title: 'Reconnecting to the server…' }, 'offline'),
        h('button.icon-btn.close-sidebar', { type: 'button', 'aria-label': 'Hide channels', onclick: () => app.toggleSidebar(false) }, icon('x')),
      ),
      h(
        'div.quick',
        h('button.quick-item', { type: 'button', onclick: () => app.openSearch() }, icon('search'), h('span', 'Search'), h('kbd', '/')),
        h(
          'button.quick-item',
          { type: 'button', class: app.pane?.kind === 'notifications' ? 'active' : '', onclick: () => app.openPane('notifications') },
          icon('at'),
          h('span', 'Mentions & replies'),
          notes > 0 ? h('span.badge', String(notes)) : null,
        ),
      ),
      h(
        'div.section',
        h(
          'div.section-head',
          h('span', 'Channels'),
          h('button.icon-btn.small', { type: 'button', title: 'Browse or create channels', 'aria-label': 'Add channel', onclick: () => app.browseChannels() }, icon('plus')),
        ),
        h('ul.channel-list', rooms.map((c) => this.item(c))),
      ),
      h(
        'div.section',
        h(
          'div.section-head',
          h('span', 'Direct messages'),
          h('button.icon-btn.small', { type: 'button', title: 'New message', 'aria-label': 'New direct message', onclick: () => app.newDm() }, icon('plus')),
        ),
        h('ul.channel-list', dms.map((c) => this.item(c))),
        dms.length ? null : h('p.muted.small-pad', 'No conversations yet.'),
      ),
      h(
        'div.me',
        h('button.me-button', { type: 'button', onclick: () => app.openSettings() }, avatar(store.me, 28), h('span.me-name', store.me.displayName), h('span.presence.online')),
      ),
    );
  }
}
