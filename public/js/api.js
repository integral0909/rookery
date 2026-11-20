export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'cannot reach the server', 'offline');
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthenticated();
    throw new ApiError(res.status, data?.error || res.statusText, data?.code);
  }
  return data;
}

const enc = encodeURIComponent;
const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  me: () => request('GET', '/api/me'),
  register: (username, password, displayName) => request('POST', '/api/auth/register', { username, password, displayName }),
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),
  updateMe: (displayName) => request('PATCH', '/api/me', { displayName }),
  changePassword: (currentPassword, newPassword) => request('POST', '/api/me/password', { currentPassword, newPassword }),
  users: (q) => request('GET', `/api/users${qs({ q })}`),

  channels: () => request('GET', '/api/channels'),
  browse: () => request('GET', '/api/channels?browse=1'),
  channel: (id) => request('GET', `/api/channels/${id}`),
  createChannel: (data) => request('POST', '/api/channels', data),
  updateChannel: (id, data) => request('PATCH', `/api/channels/${id}`, data),
  join: (id) => request('POST', `/api/channels/${id}/join`),
  leave: (id) => request('POST', `/api/channels/${id}/leave`),
  members: (id) => request('GET', `/api/channels/${id}/members`),
  invite: (id, userIds) => request('POST', `/api/channels/${id}/members`, { userIds }),
  removeMember: (id, userId) => request('DELETE', `/api/channels/${id}/members/${userId}`),
  mute: (id, muted) => request('PUT', `/api/channels/${id}/mute`, { muted }),
  openDm: (userIds) => request('POST', '/api/dms', { userIds }),
  markRead: (id, messageId) => request('POST', `/api/channels/${id}/read`, { messageId }),

  history: (id, params = {}) => request('GET', `/api/channels/${id}/messages${qs(params)}`),
  send: (channelId, body, parentId, clientId) => request('POST', `/api/channels/${channelId}/messages`, { body, parentId, clientId }),
  message: (id) => request('GET', `/api/messages/${id}`),
  thread: (id) => request('GET', `/api/messages/${id}/thread`),
  readThread: (id) => request('POST', `/api/messages/${id}/thread/read`),
  edit: (id, body) => request('PATCH', `/api/messages/${id}`, { body }),
  remove: (id) => request('DELETE', `/api/messages/${id}`),
  react: (id, emoji) => request('PUT', `/api/messages/${id}/reactions/${enc(emoji)}`),
  unreact: (id, emoji) => request('DELETE', `/api/messages/${id}/reactions/${enc(emoji)}`),

  search: (q, params = {}) => request('GET', `/api/search${qs({ q, ...params })}`),
  notifications: (params = {}) => request('GET', `/api/notifications${qs(params)}`),
  readNotifications: (body) => request('POST', '/api/notifications/read', body),

  adminSettings: () => request('GET', '/api/admin/settings'),
  updateAdminSettings: (data) => request('PATCH', '/api/admin/settings', data),
  updateUser: (id, data) => request('PATCH', `/api/admin/users/${id}`, data),
};
