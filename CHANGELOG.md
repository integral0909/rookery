# Changelog

## 0.1.0 (unreleased)

First working version.

- Accounts with scrypt passwords, cookie sessions, login throttling and
  admin controls (closing sign-up, deactivating people, promoting admins).
- Public and private channels, direct and group messages, one-level threads,
  edits, deletions and reactions.
- Real-time delivery over WebSocket: messages, edits, reactions, typing,
  presence and membership changes.
- Read markers, unread and mention counts, and notifications for mentions,
  `@channel`/`@here`, DMs and thread replies, with per-channel muting.
- Full-text search with filters, backed by SQLite FTS5.
- Web client with no build step, working down to phone width, in light and
  dark themes.
- Strict CSP, rate limits, an admin CLI with online backups, and demo data.
