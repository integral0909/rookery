// Message formatting for the browser. Pure functions with no DOM access, so
// they are unit-tested in Node as well.
//
// Supported: ```code blocks```, `inline code`, **bold**, _italic_ or *italic*,
// ~~strike~~, > quotes, http(s) links, @mentions, #channels and :shortcodes:.
// Everything is HTML-escaped first; markup is only ever added by us.

export const SHORTCODES = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', smile: '😄', grin: '😁', joy: '😂', wink: '😉',
  heart: '❤️', tada: '🎉', fire: '🔥', eyes: '👀', rocket: '🚀', thinking: '🤔', pray: '🙏', clap: '👏',
  ok_hand: '👌', wave: '👋', white_check_mark: '✅', x: '❌', warning: '⚠️', bug: '🐛', coffee: '☕',
  sparkles: '✨', party: '🥳', sob: '😭', sweat_smile: '😅', muscle: '💪', bulb: '💡', hourglass: '⏳',
  100: '💯', ship: '🚢', zap: '⚡', star: '⭐', sunglasses: '😎', shrug: '🤷', raised_hands: '🙌',
};

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🚀'];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function emojiFor(code) {
  const m = /^:([a-z0-9_+-]+):$/.exec(code);
  return m ? SHORTCODES[m[1]] ?? code : code;
}

// Inline formatting on already-escaped text without code spans.
function inline(text, ctx) {
  // Links first, swapped out for placeholders so later rules leave URLs alone.
  const links = [];
  text = text.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"&]/g, (url) => {
    links.push(url);
    return `\u0000${links.length - 1}\u0000`;
  });
  text = text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_(?=\S)(.+?)(?<=\S)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])\*(?=\S)(.+?)(?<=\S)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w@./-])@([a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9])/gi, (all, pre, name) => {
      const lower = name.toLowerCase();
      const special = lower === 'channel' || lower === 'everyone' || lower === 'here';
      const known = special || ctx.users?.has(lower);
      if (!known) return all;
      const me = lower === ctx.me || special;
      return `${pre}<span class="mention${me ? ' me' : ''}" data-user="${escapeHtml(lower)}">@${name}</span>`;
    })
    .replace(/(^|[^\w&#/])#([a-z0-9][a-z0-9_-]*)/g, (all, pre, name) => {
      const id = ctx.channels?.get(name);
      return id ? `${pre}<a class="channel-link" href="/c/${id}" data-channel="${id}">#${name}</a>` : all;
    })
    .replace(/:([a-z0-9_+-]+):/g, (all, code) => SHORTCODES[code] ?? all);
  // eslint-disable-next-line no-control-regex -- NUL brackets the link placeholders
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const url = links[Number(i)];
    return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
  });
}

// Renders a message body to HTML. ctx: { me, users: Set<lowercase name>,
// channels: Map<name, id> }.
export function renderBody(body, ctx = {}) {
  const out = [];
  const parts = String(body).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      const code = part.replace(/^[a-z0-9_+-]*\n/i, '').replace(/\n$/, '');
      out.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
      return;
    }
    if (i % 2 === 1) part = '```' + part; // unterminated fence: show as text
    const lines = part.split('\n');
    const html = [];
    let quote = [];
    const flush = () => {
      if (quote.length) html.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = [];
    };
    for (const line of lines) {
      const m = /^>\s?(.*)$/.exec(line);
      const rendered = renderLine(m ? m[1] : line, ctx);
      if (m) quote.push(rendered);
      else {
        flush();
        html.push(rendered);
      }
    }
    flush();
    out.push(html.join('<br>').replace(/(<br>)?(<blockquote>)/g, '$2').replace(/(<\/blockquote>)<br>/g, '$1'));
  });
  return out.join('').replace(/^(<br>)+|(<br>)+$/g, '');
}

function renderLine(line, ctx) {
  // Inline code spans are escaped but otherwise untouched.
  return line
    .split(/(`[^`]+`)/)
    .map((seg) => (seg.length > 2 && seg.startsWith('`') && seg.endsWith('`') ? `<code>${escapeHtml(seg.slice(1, -1))}</code>` : inline(escapeHtml(seg), ctx)))
    .join('');
}

// True when a message is nothing but one to three emoji, shown larger.
export function isJumbo(body) {
  const s = String(body).trim().replace(/:([a-z0-9_+-]+):/g, (all, c) => SHORTCODES[c] ?? all);
  return s.length > 0 && s.length <= 24 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(s) && !/^[\d#*\s]+$/.test(s);
}

// Turns server snippets (with \u0002...\u0003 markers) into safe HTML.
export function renderSnippet(snippet) {
  return escapeHtml(snippet).replaceAll('\u0002', '<mark>').replaceAll('\u0003', '</mark>');
}

const DAY = 86400_000;

export function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function dayLabel(ts, now = Date.now()) {
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now - DAY)) return 'Yesterday';
  const d = new Date(ts);
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

export function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(ts, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

// Messages from the same person within five minutes are shown as one group.
export function groupsWith(prev, msg) {
  return !!prev && !prev.deleted && prev.userId === msg.userId && msg.createdAt - prev.createdAt < 5 * 60_000 && sameDay(prev.createdAt, msg.createdAt);
}

// Finds the @word being typed at the caret, for autocomplete.
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])([@#:])([a-z0-9._+-]*)$/i.exec(before);
  if (!m) return null;
  return { trigger: m[2], query: m[3].toLowerCase(), start: caret - m[3].length - 1, end: caret };
}
