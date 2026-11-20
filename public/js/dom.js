// h('button.primary', { onclick }, 'Save') builds elements. Strings become
// text nodes, so nothing passed as a child is ever parsed as HTML; the only
// way to set HTML is the explicit `html` attribute, used for our own
// escaped message rendering.
export function h(spec, attrs = {}, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'html') el.innerHTML = value;
    else if (key === 'class') el.classList.add(...String(value).split(/\s+/).filter(Boolean));
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function icon(name) {
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || '';
  return span;
}

const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  hash: svg('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bellOff: svg('<path d="M8.7 3A6 6 0 0 1 18 8c0 2.7.6 4.6 1.3 6M17 17H3s3-2 3-9c0-.8.1-1.5.4-2.2M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  thread: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  smile: svg('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  send: svg('<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'),
  menu: svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  at: svg('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
};

// Initials avatar with a colour derived from the user id.
export function avatar(user, size = 36) {
  const name = user?.displayName || user?.username || '?';
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const hue = ((user?.id || 0) * 137) % 360;
  return h('span.avatar', { style: { width: `${size}px`, height: `${size}px`, background: `hsl(${hue} 55% 45%)`, fontSize: `${Math.round(size * 0.4)}px` }, 'aria-hidden': 'true' }, initials);
}

export function toast(text, kind = 'info') {
  let root = document.getElementById('toasts');
  if (!root) {
    root = document.body.appendChild(h('div', { 'aria-live': 'polite' }));
    root.id = 'toasts';
  }
  const el = h('div.toast', { class: kind, role: 'status' }, text);
  root.append(el);
  setTimeout(() => el.classList.add('leaving'), 3500);
  setTimeout(() => el.remove(), 4000);
}
