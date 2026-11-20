import { api } from '../api.js';
import { avatar, h, icon, toast } from '../dom.js';
import { emojiFor, isJumbo, QUICK_REACTIONS, relativeTime, renderBody, timeLabel } from '../lib/format.js';

export function formatContext(store) {
  const users = new Set([...store.users.values()].map((u) => u.username.toLowerCase()));
  const channels = new Map();
  for (const c of store.channels.values()) if (c.name) channels.set(c.name, c.id);
  return { me: store.me?.username.toLowerCase(), users, channels };
}

// One message row. `grouped` hides the avatar and name when it continues a
// run from the same person; `inThread` hides the reply summary.
export function messageView(app, m, { grouped = false, inThread = false, ctx = formatContext(app.store), highlight = false } = {}) {
  const { store } = app;
  const author = store.user(m.userId);
  const mine = m.userId === store.me.id;
  const channel = store.channels.get(m.channelId);
  const canWrite = channel?.member && !channel.archived;
  const canModerate = channel && (channel.role === 'owner' || store.me.isAdmin) && channel.kind !== 'dm';

  const classes = ['message'];
  if (grouped) classes.push('grouped');
  if (m.pending) classes.push('pending');
  if (m.failed) classes.push('failed');
  if (m.deleted) classes.push('deleted');
  if (highlight) classes.push('highlight');

  let body;
  if (m.deleted) body = h('div.body.muted', 'This message was deleted.');
  else {
    body = h('div.body', { html: renderBody(m.body, ctx) });
    if (isJumbo(m.body)) body.classList.add('jumbo');
  }

  const meta = grouped
    ? null
    : h(
        'div.meta',
        h('button.author.linklike', { onclick: () => app.showProfile(author.id), type: 'button' }, author.displayName),
        h('time', { datetime: new Date(m.createdAt).toISOString(), title: new Date(m.createdAt).toLocaleString() }, timeLabel(m.createdAt)),
        m.editedAt && !m.deleted ? h('span.edited', { title: new Date(m.editedAt).toLocaleString() }, '(edited)') : null,
      );

  const el = h(
    'article',
    { class: classes.join(' '), dataset: { id: m.id ?? '', clientId: m.clientId ?? '' }, 'aria-label': `${author.displayName} at ${timeLabel(m.createdAt)}` },
    h('div.gutter', grouped ? h('time.hover-time', timeLabel(m.createdAt)) : avatar(author)),
    h(
      'div.content',
      meta,
      body,
      m.failed
        ? h(
            'div.failed-note',
            `Not sent${m.error ? `: ${m.error}` : ''}. `,
            h('button.linklike', { type: 'button', onclick: () => app.retrySend(m.clientId) }, 'Retry'),
            ' · ',
            h('button.linklike', { type: 'button', onclick: () => store.dropPending(m.clientId) }, 'Discard'),
          )
        : null,
      reactionsView(app, m, canWrite),
      !inThread && m.replyCount > 0
        ? h(
            'button.replies',
            { type: 'button', onclick: () => app.openThread(m.id) },
            icon('thread'),
            `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`,
            m.lastReplyAt ? h('span.muted', ` · last ${relativeTime(m.lastReplyAt)}`) : null,
          )
        : null,
    ),
  );

  if (!m.pending && !m.deleted && m.id) {
    const actions = h('div.actions', { role: 'toolbar', 'aria-label': 'Message actions' });
    if (canWrite) {
      actions.append(
        h('button.icon-btn', { type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction', onclick: (e) => reactionPicker(app, m, e.currentTarget) }, icon('smile')),
      );
      if (!inThread) actions.append(h('button.icon-btn', { type: 'button', title: 'Reply in thread', 'aria-label': 'Reply in thread', onclick: () => app.openThread(m.id) }, icon('thread')));
    }
    if (mine && canWrite) actions.append(h('button.icon-btn', { type: 'button', title: 'Edit', 'aria-label': 'Edit message', onclick: () => startEdit(app, el, m) }, icon('edit')));
    if (mine || canModerate) actions.append(h('button.icon-btn', { type: 'button', title: 'Delete', 'aria-label': 'Delete message', onclick: () => confirmDelete(app, m) }, icon('trash')));
    if (actions.childElementCount) el.append(actions);
  }
  return el;
}

function reactionsView(app, m, canWrite) {
  if (!m.reactions?.length) return null;
  const meId = app.store.me.id;
  return h(
    'div.reactions',
    m.reactions.map((r) => {
      const mineToo = r.userIds.includes(meId);
      const names = r.userIds.map((id) => (id === meId ? 'You' : app.store.user(id).displayName)).join(', ');
      return h(
        'button.reaction',
        {
          type: 'button',
          class: mineToo ? 'mine' : '',
          title: `${names} reacted with ${r.emoji}`,
          'aria-pressed': String(mineToo),
          disabled: !canWrite,
          onclick: () => toggleReaction(app, m, r.emoji, mineToo),
        },
        h('span.emoji', emojiFor(r.emoji)),
        h('span.count', String(r.userIds.length)),
      );
    }),
  );
}

export async function toggleReaction(app, m, emoji, remove) {
  try {
    const { reactions } = remove ? await api.unreact(m.id, emoji) : await api.react(m.id, emoji);
    app.store.setReactions(m.id, m.channelId, reactions);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function reactionPicker(app, m, anchor) {
  document.querySelector('.picker')?.remove();
  const close = () => {
    picker.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => {
    if (!picker.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const picker = h(
    'div.picker',
    { role: 'menu' },
    QUICK_REACTIONS.map((emoji) =>
      h('button', {
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          close();
          const existing = m.reactions?.find((r) => r.emoji === emoji);
          toggleReaction(app, m, emoji, !!existing?.userIds.includes(app.store.me.id));
        },
      }, emoji),
    ),
  );
  document.body.append(picker);
  const rect = anchor.getBoundingClientRect();
  picker.style.top = `${Math.max(8, rect.top - picker.offsetHeight - 6)}px`;
  picker.style.left = `${Math.min(window.innerWidth - picker.offsetWidth - 8, Math.max(8, rect.right - picker.offsetWidth))}px`;
  picker.querySelector('button').focus();
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
}

export function startEdit(app, el, m) {
  const bodyEl = el.querySelector('.body');
  if (!bodyEl || el.classList.contains('editing')) return;
  el.classList.add('editing');
  const input = h('textarea.edit-input', { rows: 2, 'aria-label': 'Edit message' });
  input.value = m.body;
  const done = () => {
    el.classList.remove('editing');
    form.replaceWith(bodyEl);
  };
  const save = async () => {
    const text = input.value.trim();
    if (!text) return confirmDelete(app, m);
    if (text === m.body) return done();
    try {
      const { message } = await api.edit(m.id, text);
      app.store.updateMessage(message);
    } catch (err) {
      toast(err.message, 'error');
      done();
    }
  };
  const form = h(
    'form.edit-form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    input,
    h('div.edit-buttons', h('button.ghost', { type: 'button', onclick: done }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Save')),
    h('div.hint', 'Enter to save · Esc to cancel'),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
  bodyEl.replaceWith(form);
  input.style.height = `${Math.min(300, input.scrollHeight + 2)}px`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function confirmDelete(app, m) {
  if (!(await app.confirm('Delete this message?', 'This cannot be undone.', 'Delete'))) return;
  try {
    await api.remove(m.id);
    app.store.updateMessage({ ...m, deleted: true, body: '', reactions: [] });
  } catch (err) {
    toast(err.message, 'error');
  }
}
