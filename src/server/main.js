import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dbPath = process.env.ROOKERY_DB || 'data/rookery.db';

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);

const log = (level, ...args) => {
  const line = `[${new Date().toISOString()}] ${level}`;
  if (level === 'error') console.error(line, ...args);
  else console.log(line, ...args);
};

const app = createApp({ db, log });
app.server.listen(port, host, () => {
  log('info', `rookery listening on http://${host}:${port} (database ${dbPath})`);
});

function shutdown() {
  app.server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
