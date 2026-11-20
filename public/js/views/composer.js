import { h, icon } from '../dom.js';
import { mentionAt, SHORTCODES } from '../lib/format.js';

const DRAFTS_KEY = 'rookery.drafts';

function loadDrafts() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveDraft(key, text) {
  try {
    const drafts = loadDrafts();
    if (text) drafts[key] = text;
    else delete drafts[key];
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // storage unavailable: drafts just are not kept
  }
}

// Message input with autosize, Enter-to-send, @ # : autocomplete, typing
// pings and per-conversation drafts.
export class Composer {
  constructor(app, { channelId, parentId = null, placeholder, onEditLast }) {
    this.app = app;
    this.channelId = channelId;
    this.parentId = parentId;
    this.onEditLast = onEditLast;
    this.draftKey = `${channelId}:${parentId ?? ''}`;
    this.suggest = null;

    this.input = h('textarea.composer-input', { rows: 1, placeholder, 'aria-label': placeholder, maxlength: 4000 });
    this.input.value = loadDrafts()[this.draftKey] || '';
    this.list = h('ul.suggest', { role: 'listbox', hidden: true });
    this.sendBtn = h('button.send', { type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send' }, icon('send'));
    this.el = h(
      'form.composer',
      {
        onsubmit: (e) => {
          e.preventDefault();
          this.submit();
        },
      },
      this.list,
      h('div.composer-box', this.input, this.sendBtn),
      h('div.hint', h('kbd', 'Enter'), ' to send · ', h('kbd', 'Shift + Enter'), ' for a new line · ', h('code', '**bold**'), ' ', h('code', '_italic_'), ' ', h('code', '`code`')),
    );

    this.input.addEventListener('input', () => {
      this.resize();
      saveDraft(this.draftKey, this.input.value);
      if (this.input.value.trim()) app.socket.send({ type: 'typing', channelId, parentId });
      this.updateSuggestions();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(), 150));
    queueMicrotask(() => this.resize());
  }

  focus() {
    this.input.focus();
  }

  setDisabled(disabled, reason = '') {
    this.input.disabled = disabled;
    this.sendBtn.disabled = disabled;
    if (reason) this.input.placeholder = reason;
  }

  resize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(240, this.input.scrollHeight)}px`;
  }

  submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.app.sendMessage(this.channelId, text, this.parentId);
    this.input.value = '';
    saveDraft(this.draftKey, '');
    this.resize();
    this.hideSuggestions();
  }

  insert(text) {
    const { selectionStart: s, selectionEnd: e, value } = this.input;
    this.input.value = value.slice(0, s) + text + value.slice(e);
    this.input.selectionStart = this.input.selectionEnd = s + text.length;
    this.input.dispatchEvent(new Event('input'));
    this.focus();
  }

  onKey(e) {
    if (this.suggest && !this.list.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.suggest.items.length;
        this.suggest.index = (this.suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.renderSuggestions();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.pick(this.suggest.items[this.suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideSuggestions();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'ArrowUp' && !this.input.value && this.onEditLast) {
      e.preventDefault();
      this.onEditLast();
    }
  }

  updateSuggestions() {
    const at = mentionAt(this.input.value, this.input.selectionStart);
    if (!at || (at.trigger === ':' && at.query.length < 2)) return this.hideSuggestions();
    const { store } = this.app;
    let items = [];
    if (at.trigger === '@') {
      const q = at.query;
      items = [...store.users.values()]
        .filter((u) => !u.deactivated && u.id !== store.me.id && (u.username.toLowerCase().startsWith(q) || u.displayName.toLowerCase().includes(q)))
        .sort((a, b) => Number(store.online.has(b.id)) - Number(store.online.has(a.id)) || a.username.localeCompare(b.username))
        .slice(0, 7)
        .map((u) => ({ label: u.displayName, detail: `@${u.username}`, insert: `@${u.username} ` }));
      const channel = store.channels.get(this.channelId);
      if (channel?.kind !== 'dm') {
        for (const word of ['here', 'channel']) {
          if (word.startsWith(q)) items.push({ label: `@${word}`, detail: word === 'here' ? 'Notify everyone online' : 'Notify every member', insert: `@${word} ` });
        }
      }
    } else if (at.trigger === '#') {
      items = [...store.channels.values()]
        .filter((c) => c.name && c.name.startsWith(at.query))
        .slice(0, 7)
        .map((c) => ({ label: `#${c.name}`, detail: c.topic || '', insert: `#${c.name} ` }));
    } else {
      items = Object.entries(SHORTCODES)
        .filter(([code]) => code.startsWith(at.query))
        .slice(0, 8)
        .map(([code, emoji]) => ({ label: `${emoji}  :${code}:`, detail: '', insert: `${emoji} ` }));
    }
    if (!items.length) return this.hideSuggestions();
    this.suggest = { at, items, index: 0 };
    this.renderSuggestions();
  }

  renderSuggestions() {
    this.list.replaceChildren(
      ...this.suggest.items.map((item, i) =>
        h(
          'li',
          {
            role: 'option',
            class: i === this.suggest.index ? 'active' : '',
            'aria-selected': String(i === this.suggest.index),
            onmousedown: (e) => {
              e.preventDefault();
              this.pick(item);
            },
          },
          h('span.label', item.label),
          item.detail ? h('span.detail', item.detail) : null,
        ),
      ),
    );
    this.list.hidden = false;
  }

  pick(item) {
    const { start, end } = this.suggest.at;
    const v = this.input.value;
    this.input.value = v.slice(0, start) + item.insert + v.slice(end);
    const caret = start + item.insert.length;
    this.input.setSelectionRange(caret, caret);
    this.hideSuggestions();
    saveDraft(this.draftKey, this.input.value);
    this.resize();
  }

  hideSuggestions() {
    this.list.hidden = true;
    this.suggest = null;
  }
}
