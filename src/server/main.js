import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';

const env = process.env;
const flag = (name) => ['1', 'true', 'yes'].includes(String(env[name] || '').toLowerCase());

const port = Number(env.PORT || 3000);
const host = env.HOST || '127.0.0.1';
const dbPath = env.ROOKERY_DB || 'data/rookery.db';
const accessLog = flag('ROOKERY_ACCESS_LOG');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);

const log = (level, ...args) => {
  if (level === 'access' && !accessLog) return;
  const line = `[${new Date().toISOString()}] ${level}`;
  if (level === 'error') console.error(line, ...args);
  else console.log(line, ...args);
};

const app = createApp({
  db,
  log,
  // Behind HTTPS (directly or via a proxy) cookies get the Secure flag and
  // responses send HSTS.
  secureCookies: flag('ROOKERY_SECURE_COOKIES'),
  // Use X-Forwarded-For for rate limits when a reverse proxy sets it.
  trustProxy: flag('ROOKERY_TRUST_PROXY'),
});

app.server.listen(port, host, () => {
  log('info', `rookery listening on http://${host}:${port} (database ${dbPath})`);
});

function shutdown() {
  app.close();
  app.server.close(() => {
    db.close();
    process.exit(0);
  });
  app.server.closeIdleConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
