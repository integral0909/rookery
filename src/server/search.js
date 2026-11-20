import { HttpError } from './http.js';
import { presentAll } from './model/messages.js';

// Highlight markers around matched terms in snippets. Control characters
// never appear in stored messages, so the client can split on them after
// escaping the text.
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

const FILTERS = new Set(['from', 'in', 'before', 'after', 'on', 'is', 'has']);

// Splits a query like  deploy "blue green" from:@ada in:#ops after:2026-01-01
// into free-text terms and filters. Unknown key:value pairs are searched as
// plain text.
export function parseQuery(input) {
  const out = { terms: [], phrases: [], from: [], in: [], before: null, after: null, on: null, is: new Set(), has: new Set() };
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"?|(\S+))/g;
  for (const m of String(input).matchAll(re)) {
    const [, neg, key, quoted, bare] = m;
    const value = quoted ?? bare ?? '';
    if (key && FILTERS.has(key.toLowerCase()) && value) {
      const k = key.toLowerCase();
      if (k === 'from') out.from.push(value.replace(/^@/, '').toLowerCase());
      else if (k === 'in') out.in.push(value.replace(/^#/, '').toLowerCase());
      else if (k === 'is' || k === 'has') out[k].add(value.toLowerCase());
      else out[k] = parseDate(value, k);
      continue;
    }
    const text = key ? `${key}:${value}` : value;
    if (quoted !== undefined) {
      if (text.trim()) out.phrases.push({ text, neg: !!neg });
    } else if (text) {
      out.terms.push({ text, neg: !!neg });
    }
  }
  return out;
}

function parseDate(value, key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const t = m && Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || Number.isNaN(t) || new Date(t).getUTCDate() !== Number(m[3])) {
    throw new HttpError(400, `${key}: expects a date like 2026-03-31`, 'invalid');
  }
  return t;
}

// Turns parsed terms into an FTS5 MATCH expression. Every term is quoted so
// user input can never inject FTS syntax; the last bare word is a prefix so
// results appear while typing.
export function ftsExpression(parsed) {
  const quote = (s) => `"${s.replace(/"/g, '""')}"`;
  const positive = [];
  const negative = [];
  const words = parsed.terms.map((t) => ({ ...t, text: t.text.replace(/[^\p{L}\p{N}_'-]+/gu, ' ').trim() })).filter((t) => t.text);
  words.forEach((t, i) => {
    const parts = t.text.split(/\s+/);
    const isLast = i === words.length - 1 && !t.neg;
    const expr = parts.map((p, j) => quote(p) + (isLast && j === parts.length - 1 && p.length >= 2 ? '*' : '')).join(' ');
    (t.neg ? negative : positive).push(parts.length > 1 ? `(${expr})` : expr);
  });
  for (const p of parsed.phrases) (p.neg ? negative : positive).push(quote(p.text));
  if (!positive.length) return null;
  let expr = positive.join(' AND ');
  for (const n of negative) expr = `(${expr}) NOT ${n}`;
  return expr;
}

export function search(db, user, query, { limit = 20, offset = 0, sort = 'relevance' } = {}) {
  const parsed = parseQuery(query);
  const match = ftsExpression(parsed);
  const hasFilter = parsed.from.length || parsed.in.length || parsed.before || parsed.after || parsed.on || parsed.is.size || parsed.has.size;
  if (!match && !hasFilter) return { results: [], total: 0 };

  const where = [
    'm.deleted_at IS NULL',
    `(c.kind = 'public' OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.channel_id = c.id AND mm.user_id = ?))`,
  ];
  const args = [user.id];
  if (match) {
    where.push('messages_fts MATCH ?');
    args.push(match);
  }
  if (parsed.from.length) {
    where.push(`m.user_id IN (SELECT id FROM users WHERE lower(username) IN (SELECT value FROM json_each(?)))`);
    args.push(JSON.stringify(parsed.from.map((f) => (f === 'me' ? user.username.toLowerCase() : f))));
  }
  if (parsed.in.length) {
    where.push('c.name IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(parsed.in));
  }
  if (parsed.after !== null) {
    where.push('m.created_at >= ?');
    args.push(parsed.after + 86400_000);
  }
  if (parsed.before !== null) {
    where.push('m.created_at < ?');
    args.push(parsed.before);
  }
  if (parsed.on !== null) {
    where.push('m.created_at >= ? AND m.created_at < ?');
    args.push(parsed.on, parsed.on + 86400_000);
  }
  if (parsed.is.has('thread')) where.push('(m.parent_id IS NOT NULL OR m.reply_count > 0)');
  if (parsed.is.has('dm')) where.push(`c.kind = 'dm'`);
  if (parsed.has.has('reaction')) where.push('EXISTS (SELECT 1 FROM reactions r WHERE r.message_id = m.id)');
  if (parsed.has.has('link')) where.push(`(m.body LIKE '%http://%' OR m.body LIKE '%https://%')`);

  const from = match
    ? 'messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN channels c ON c.id = m.channel_id'
    : 'messages m JOIN channels c ON c.id = m.channel_id';
  const order = match && sort !== 'recent' ? 'bm25(messages_fts), m.id DESC' : 'm.id DESC';
  const snippet = match ? `snippet(messages_fts, 0, '${MARK_START}', '${MARK_END}', '…', 24)` : 'substr(m.body, 1, 200)';

  let rows;
  let total;
  try {
    total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where.join(' AND ')}`).get(...args).n;
    rows = db
      .prepare(
        `SELECT m.*, c.name AS c_name, c.kind AS c_kind, ${snippet} AS snippet
           FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
  } catch (err) {
    if (/fts5|syntax/i.test(err.message)) throw new HttpError(400, 'could not understand that search', 'invalid');
    throw err;
  }
  const messages = presentAll(db, rows);
  return {
    total,
    results: rows.map((r, i) => ({
      message: messages[i],
      channel: { id: r.channel_id, name: r.c_name, kind: r.c_kind },
      snippet: r.snippet,
    })),
  };
}
