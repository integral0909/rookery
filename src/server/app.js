import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkOrigin, pruneSessions, tokenFromRequest, userForToken } from './auth.js';
import { HttpError, Router, sendJson, serveStatic } from './http.js';
import { startNotifier } from './notify.js';
import { defaultLimits } from './ratelimit.js';
import { Hub } from './realtime.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import notificationRoutes from './routes/notifications.js';
import searchRoutes from './routes/search.js';
import users from './routes/users.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const HOUR = 3600_000;

// The client never uses inline scripts or styles from markup, so the policy
// can be strict. Styles set through element.style (CSSOM) are not affected.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

export function createApp({ db, publicDir = PUBLIC_DIR, log = () => {}, secureCookies = false, trustProxy = false, limits = defaultLimits() }) {
  const router = new Router();
  // Routes emit domain events here (messageCreated, channelUpdated, ...);
  // the realtime hub and notifier subscribe to them.
  const hooks = new EventEmitter();
  const ctx = { db, router, hooks, log, limits };

  router.get('/api/health', () => ({ ok: true }));
  users(router, { secureCookies });
  channelRoutes(router, ctx);
  messageRoutes(router, ctx);
  notificationRoutes(router, ctx);
  searchRoutes(router);

  const clientAddress = (req) => {
    const forwarded = trustProxy && req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  };

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (secureCookies) res.setHeader('strict-transport-security', 'max-age=31536000');
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log('access', `${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    try {
      if (url.pathname.startsWith('/api/')) {
        const found = router.match(req.method, url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        if (found.methodNotAllowed) throw new HttpError(405, 'method not allowed');
        const writing = req.method !== 'GET' && req.method !== 'HEAD';
        if (writing) checkOrigin(req);
        const user = userForToken(db, tokenFromRequest(req));
        if (writing) limits.write.take(user ? `u${user.id}` : clientAddress(req));
        const requireUser = () => {
          if (!user) throw new HttpError(401, 'sign in first', 'unauthenticated');
          return user;
        };
        const requireAdmin = () => {
          if (!requireUser().isAdmin) throw new HttpError(403, 'admins only', 'forbidden');
          return user;
        };
        const result = await found.handler({
          req,
          res,
          url,
          params: found.params,
          user,
          requireUser,
          requireAdmin,
          address: clientAddress(req),
          ...ctx,
        });
        if (!res.headersSent) sendJson(res, result === undefined ? 204 : 200, result);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (!(await serveStatic(publicDir, url.pathname, res))) throw new HttpError(404, 'not found');
    } catch (err) {
      if (!(err instanceof HttpError)) log('error', err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'internal error';
      const headers = err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {};
      sendJson(res, status, { error: message, ...(err.code ? { code: err.code } : {}) }, headers);
    }
  });

  const hub = new Hub({ db, hooks, server, log });
  ctx.hub = hub;
  startNotifier({ db, hooks, isOnline: () => (userId) => hub.isOnline(userId) });

  const housekeeping = setInterval(() => {
    const removed = pruneSessions(db);
    if (removed) log('info', `pruned ${removed} expired sessions`);
    for (const l of Object.values(limits)) l.sweep();
  }, HOUR);
  housekeeping.unref();

  return {
    server,
    router,
    ctx,
    hooks,
    hub,
    close: () => {
      clearInterval(housekeeping);
      hub.close();
    },
  };
}
