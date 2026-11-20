import WebSocket from 'ws';

// Opens a socket as the given client and collects events, so tests can wait
// for a specific one or check that nothing arrived.
export function connect(client, { origin } = {}) {
  const url = client.base.replace(/^http/, 'ws') + '/ws';
  const headers = { cookie: client.cookie };
  if (origin) headers.origin = origin;
  const ws = new WebSocket(url, { headers });
  const events = [];
  const waiters = [];
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    for (const w of [...waiters]) {
      if (w.match(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });

  const api = {
    ws,
    events,
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    // Resolves with the first event (already received or future) matching.
    next(type, pred = () => true, timeout = 2000) {
      const match = (e) => e.type === type && pred(e);
      const seen = events.find(match);
      if (seen) {
        events.splice(events.indexOf(seen), 1);
        return Promise.resolve(seen);
      }
      return new Promise((resolve, reject) => {
        const w = {
          match,
          resolve: (e) => {
            clearTimeout(timer);
            events.splice(events.indexOf(e), 1);
            resolve(e);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${type}`));
        }, timeout);
        waiters.push(w);
      });
    },
    // Round-trips a ping so every event sent before it has arrived.
    async settle() {
      const id = Math.random();
      api.send({ type: 'ping', id });
      await api.next('pong', (e) => e.id === id);
    },
    close: () => ws.close(),
  };
  return api;
}
