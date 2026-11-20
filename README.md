# Rookery

A self-hosted team chat server: accounts, channels, threads, search and
notifications, in a single Node.js process backed by SQLite.

Work in progress.

## Running

Requires Node.js 22.13 or newer.

```sh
npm install
npm start          # http://127.0.0.1:3000
npm test
```

The database is written to `data/rookery.db` (set `ROOKERY_DB` to change it).
