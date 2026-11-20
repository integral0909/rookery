# Rookery API

The web client uses nothing but the API below, so anything it does can be
scripted. Bodies are JSON, and every write needs `Content-Type:
application/json`. Errors look like `{ "error": "message", "code":
"machine_code" }` with a matching HTTP status.

Authentication uses the `rookery_session` cookie set by sign-up and login.
Browser writes must come from the same origin. Requests without an `Origin`
header (curl, scripts) are allowed.

## Accounts

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `username`, `password`, `displayName?` | First account is admin. `403 signup_closed`, `409 username_taken` |
| POST | `/api/auth/login` | `username`, `password` | `401 bad_credentials`, `429` after repeated failures |
| POST | `/api/auth/logout` | | |
| GET | `/api/me` | | `{ user }` |
| PATCH | `/api/me` | `displayName` | |
| POST | `/api/me/password` | `currentPassword`, `newPassword` | Signs out all other sessions |
| GET | `/api/users` | `q?` | Directory; with `q`, up to 20 matches |

A user is `{ id, username, displayName, isAdmin, deactivated }`.

## Channels and DMs

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/channels` | `browse=1?` | Your channels, or public ones you have not joined |
| POST | `/api/channels` | `name`, `topic?`, `private?`, `memberIds?` | Creator becomes owner |
| GET | `/api/channels/:id` | | Public channels are readable by everyone |
| PATCH | `/api/channels/:id` | `topic?`, `name?`, `archived?` | Members set the topic; owners or admins rename and archive |
| POST | `/api/channels/:id/join` | | Public channels only |
| POST | `/api/channels/:id/leave` | | Not `#general` or DMs |
| GET | `/api/channels/:id/members` | | |
| POST | `/api/channels/:id/members` | `userIds` | Any member in public channels; owners in private ones |
| DELETE | `/api/channels/:id/members/:userId` | | Owners, or yourself |
| PUT | `/api/channels/:id/mute` | `muted` | |
| POST | `/api/channels/:id/read` | `messageId?` | Moves your read marker forward (to the latest message if omitted) |
| POST | `/api/dms` | `userIds` | Opens or creates the DM for you plus those people (2–9 in total) |

A channel is `{ id, kind: "public"|"private"|"dm", name, topic, archived,
memberCount, member, role, muted, unreadCount, mentionCount, lastReadId }`.
DMs also include `memberIds`.

## Messages

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/channels/:id/messages` | `limit?`, `before?` / `after?` / `around?` | Top-level messages, oldest first, with `hasMore` (and `hasNewer` for `around`) |
| POST | `/api/channels/:id/messages` | `body`, `parentId?`, `clientId?` | `clientId` comes back on the socket echo |
| GET | `/api/messages/:id` | | |
| GET | `/api/messages/:id/thread` | | `{ root, replies }`, works with the root or any reply |
| POST | `/api/messages/:id/thread/read` | | Clears notifications from that thread |
| PATCH | `/api/messages/:id` | `body` | Author only, within 24 hours |
| DELETE | `/api/messages/:id` | | Author, channel owner or admin. Soft delete |
| PUT / DELETE | `/api/messages/:id/reactions/:emoji` | | Emoji or `:shortcode:`, URL-encoded |

A message is `{ id, channelId, userId, parentId, body, createdAt, editedAt,
deleted, replyCount, lastReplyAt, reactions: [{ emoji, userIds }] }`.
Bodies are plain text with light markup, up to 4000 characters.

## Search and notifications

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/api/search` | `q`, `sort=relevance\|recent`, `limit?`, `offset?` | `{ total, results: [{ message, channel, snippet }] }`. In snippets, matches are wrapped in `\u0002`…`\u0003` |
| GET | `/api/notifications` | `unread=1?`, `before?`, `limit?` | `{ notifications, hasMore, unreadCount }` |
| POST | `/api/notifications/read` | `ids` or `all: true` | |

Search syntax: words (the last one matches as a prefix), `"exact phrase"`,
`-word`, `from:@name` (or `from:me`), `in:#channel`, `before:YYYY-MM-DD`,
`after:YYYY-MM-DD`, `on:YYYY-MM-DD`, `is:thread`, `is:dm`, `has:reaction`,
`has:link`.

Notification kinds: `mention`, `channel` (`@channel`, `@everyone`,
`@here`), `reply`, `dm`.

## Admin

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET / PATCH | `/api/admin/settings` | `openSignup?` | |
| PATCH | `/api/admin/users/:id` | `deactivated?`, `isAdmin?` | Deactivating ends the user's sessions and sockets |

## WebSocket

Connect to `/ws` with the session cookie. The server sends JSON events:

| Event | Fields | Sent to |
| --- | --- | --- |
| `hello` | `userId`, `online` | you, on connect |
| `presence` | `userId`, `online` | everyone |
| `message.created` | `message`, `clientId` | channel members and watchers |
| `message.updated`, `message.deleted` | `message` | channel members and watchers |
| `reactions.updated` | `channelId`, `messageId`, `reactions` | channel members and watchers |
| `typing` | `channelId`, `parentId`, `userId` | other channel members |
| `channel.joined`, `channel.updated` | `channel` | affected members |
| `channel.left` | `channelId` | the person who left or was removed |
| `member.added`, `member.removed` | `channelId`, `userId` | channel members |
| `channel.read` | `channelId`, `unreadCount`, `mentionCount`, `lastReadId` | your other tabs |
| `notification.created` | `notification`, `unreadCount`, `mentionCount` | the person notified |
| `user.updated` | `user` | everyone |

Clients may send:

- `{ "type": "typing", "channelId", "parentId?" }`: rate-limited to one
  every 2 seconds per channel.
- `{ "type": "watch" | "unwatch", "channelId" }`: follow a public channel
  you have not joined.
- `{ "type": "ping", "id?" }`: the server answers with a `pong` carrying
  the same `id`.

Sockets are closed with code `4001` when the account is deactivated. They
are also dropped on the next heartbeat (every 30 seconds) once their
session has ended.
