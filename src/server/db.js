import { DatabaseSync } from 'node:sqlite';

// Schema changes are append-only: each entry runs once, in order, and the
// index of the last one applied is kept in PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  `,
  `
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN deactivated_at INTEGER;

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE channels (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
    name        TEXT,
    topic       TEXT NOT NULL DEFAULT '',
    dm_key      TEXT UNIQUE,
    created_by  INTEGER REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    archived_at INTEGER,
    CHECK ((kind = 'dm') = (name IS NULL)),
    CHECK ((kind = 'dm') = (dm_key IS NOT NULL))
  );
  CREATE UNIQUE INDEX channels_name ON channels(name) WHERE name IS NOT NULL;

  CREATE TABLE memberships (
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at    INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    muted        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX memberships_user ON memberships(user_id);

  CREATE TABLE messages (
    id            INTEGER PRIMARY KEY,
    channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    parent_id     INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    body          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    edited_at     INTEGER,
    deleted_at    INTEGER,
    reply_count   INTEGER NOT NULL DEFAULT 0,
    last_reply_at INTEGER
  );
  CREATE INDEX messages_channel ON messages(channel_id, parent_id, id);
  CREATE INDEX messages_parent ON messages(parent_id, id) WHERE parent_id IS NOT NULL;
  `,
  `
  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id)
  );

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('mention', 'channel', 'reply', 'dm')),
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    actor_id   INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    read_at    INTEGER,
    UNIQUE (user_id, message_id)
  );
  CREATE INDEX notifications_user ON notifications(user_id, id);
  CREATE INDEX notifications_unread ON notifications(user_id, channel_id) WHERE read_at IS NULL;
  `,
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    body,
    content = 'messages',
    content_rowid = 'id',
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
  INSERT INTO messages_fts (rowid, body) SELECT id, body FROM messages WHERE deleted_at IS NULL;

  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
  END;
  `,
];

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${i + 1} failed: ${err.message}`, { cause: err });
    }
  }
  return MIGRATIONS.length;
}

// Runs fn inside a transaction, rolling back if it throws.
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
