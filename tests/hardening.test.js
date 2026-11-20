import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/server/ratelimit.js';
import { relaxedLimits, startApp } from './helpers.js';

test('token bucket allows bursts, refills over time and forgets idle keys', () => {
  let now = 0;
  const l = new RateLimiter({ capacity: 3, perSecond: 1, now: () => now });
  l.take('a');
  l.take('a');
  l.take('a');
  assert.throws(() => l.take('a'), (err) => err.status === 429 && err.retryAfter === 1);
  l.take('b');
  now = 2000;
  l.take('a');
  l.take('a');
  assert.throws(() => l.take('a'));
  now = 60_000;
  l.sweep();
  assert.equal(l.buckets.size, 0);
});

test('sending too fast is refused with Retry-After', async (t) => {
  const limits = { ...relaxedLimits(), message: new RateLimiter({ capacity: 3, perSecond: 0.01 }) };
  const { client } = await startApp(t, { limits });
  const c = client();
  await c.post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  const general = (await c.get('/api/channels')).body.channels[0];
  for (let i = 0; i < 3; i++) assert.equal((await c.post(`/api/channels/${general.id}/messages`, { body: `m${i}` })).status, 200);
  const res = await c.post(`/api/channels/${general.id}/messages`, { body: 'one more' });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('sign-ups are limited per address', async (t) => {
  const limits = { ...relaxedLimits(), signup: new RateLimiter({ capacity: 2, perSecond: 0.001 }) };
  const { client } = await startApp(t, { limits });
  assert.equal((await client().post('/api/auth/register', { username: 'a1', password: 'longenough' })).status, 200);
  assert.equal((await client().post('/api/auth/register', { username: 'a2', password: 'longenough' })).status, 200);
  assert.equal((await client().post('/api/auth/register', { username: 'a3', password: 'longenough' })).status, 429);
});

test('responses carry security headers and a strict CSP', async (t) => {
  const { base } = await startApp(t);
  for (const path of ['/', '/api/health', '/api/missing']) {
    const res = await fetch(base + path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('HSTS only when cookies are marked secure', async (t) => {
  const plain = await startApp(t);
  assert.equal((await fetch(`${plain.base}/api/health`)).headers.get('strict-transport-security'), null);
  const secure = await startApp(t, { secureCookies: true });
  assert.match((await fetch(`${secure.base}/api/health`)).headers.get('strict-transport-security'), /max-age/);
  const res = await secure.client().post('/api/auth/register', { username: 'ada', password: 'lovelace!' });
  assert.match(res.headers.get('set-cookie'), /Secure/);
});
