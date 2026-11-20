import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkOrigin, tokenFromRequest, userForToken } from './auth.js';
import { HttpError, Router, sendJson, serveStatic } from './http.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import users from './routes/users.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export function createApp({ db, publicDir = PUBLIC_DIR, log = () => {}, secureCookies = false }) {
  const router = new Router();
  // Routes emit domain events here (messageCreated, channelUpdated, ...);
  // the realtime hub and notifier subscribe to them.
  const hooks = new EventEmitter();
  const ctx = { db, router, hooks, log };

  router.get('/api/health', () => ({ ok: true }));
  users(router, { secureCookies });
  channelRoutes(router, ctx);
  messageRoutes(router, ctx);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const found = router.match(req.method, url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        if (found.methodNotAllowed) throw new HttpError(405, 'method not allowed');
        if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
        const user = userForToken(db, tokenFromRequest(req));
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
      sendJson(res, status, { error: message, ...(err.code ? { code: err.code } : {}) });
    }
  });

  return { server, router, ctx, hooks };
}
