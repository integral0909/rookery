import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, groupsWith, isJumbo, mentionAt, renderBody, renderSnippet } from '../public/js/lib/format.js';

const ctx = { me: 'ada', users: new Set(['ada', 'grace']), channels: new Map([['ops', 7]]) };

test('HTML in messages is always escaped', () => {
  assert.equal(renderBody('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(renderBody('`<b>`'), '<code>&lt;b&gt;</code>');
  assert.equal(renderBody('```\n<script>\n```'), '<pre><code>&lt;script&gt;</code></pre>');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('inline formatting', () => {
  assert.equal(renderBody('**bold** _it_ *also* ~~gone~~'), '<strong>bold</strong> <em>it</em> <em>also</em> <del>gone</del>');
  assert.equal(renderBody('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
  assert.equal(renderBody('line one\nline two'), 'line one<br>line two');
  assert.equal(renderBody('`**not bold**`'), '<code>**not bold**</code>');
});

test('links are safe and do not swallow punctuation', () => {
  assert.equal(
    renderBody('see https://example.com/a_b_c?x=1&y=2.'),
    'see <a href="https://example.com/a_b_c?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a_b_c?x=1&amp;y=2</a>.',
  );
  assert.equal(renderBody('javascript:alert(1)'), 'javascript:alert(1)');
  assert.ok(!renderBody('https://x.io/"onmouseover="a').includes('"onmouseover'));
});

test('mentions, channels and shortcodes', () => {
  assert.equal(renderBody('hi @Grace and @ada', ctx), 'hi <span class="mention" data-user="grace">@Grace</span> and <span class="mention me" data-user="ada">@ada</span>');
  assert.equal(renderBody('@nobody', ctx), '@nobody');
  assert.equal(renderBody('@here', ctx), '<span class="mention me" data-user="here">@here</span>');
  assert.equal(renderBody('mail ada@example.com', ctx), 'mail ada@example.com');
  assert.equal(renderBody('see #ops and #nope', ctx), 'see <a class="channel-link" href="/c/7" data-channel="7">#ops</a> and #nope');
  assert.equal(renderBody('ship it :rocket: :unknown:'), 'ship it 🚀 :unknown:');
});

test('quotes and code blocks', () => {
  assert.equal(renderBody('> quoted\n> more\nreply'), '<blockquote>quoted<br>more</blockquote>reply');
  assert.equal(renderBody('```js\nconst a = 1;\n```'), '<pre><code>const a = 1;</code></pre>');
  assert.equal(renderBody('```open'), '```open');
});

test('jumbo emoji', () => {
  assert.equal(isJumbo('🎉'), true);
  assert.equal(isJumbo(':tada: :rocket:'), true);
  assert.equal(isJumbo('🎉 yay'), false);
  assert.equal(isJumbo('123'), false);
});

test('search snippets only allow our own <mark>', () => {
  assert.equal(renderSnippet('a \u0002<b>\u0003 c'), 'a <mark>&lt;b&gt;</mark> c');
});

test('grouping and autocomplete helpers', () => {
  const a = { userId: 1, createdAt: Date.UTC(2026, 0, 1, 10), deleted: false };
  assert.equal(groupsWith(a, { userId: 1, createdAt: a.createdAt + 60_000 }), true);
  assert.equal(groupsWith(a, { userId: 2, createdAt: a.createdAt + 60_000 }), false);
  assert.equal(groupsWith(a, { userId: 1, createdAt: a.createdAt + 10 * 60_000 }), false);
  assert.deepEqual(mentionAt('hello @gr', 9), { trigger: '@', query: 'gr', start: 6, end: 9 });
  assert.deepEqual(mentionAt('go to #o', 8), { trigger: '#', query: 'o', start: 6, end: 8 });
  assert.equal(mentionAt('email@x', 7), null);
});
