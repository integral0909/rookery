import { createApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';

// Starts an app on a random port with an in-memory database. Returns a small
// client that keeps the session cookie between requests, like a browser.
export async function startApp(t) {
  const db = openDatabase(':memory:');
  const app = createApp({ db });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.close?.();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
  });
  return { app, db, base, client: () => new Client(base) };
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(method, path, body) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }
  patch(path, body = {}) { return this.request('PATCH', path, body); }
  put(path, body = {}) { return this.request('PUT', path, body); }
  delete(path) { return this.request('DELETE', path); }
}
