import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HttpError, Router, sendJson, serveStatic } from './http.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export function createApp({ db, publicDir = PUBLIC_DIR, log = () => {} }) {
  const router = new Router();
  const ctx = { db, router };

  router.get('/api/health', () => ({ ok: true }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const found = router.match(req.method, url.pathname);
        if (!found) throw new HttpError(404, 'not found');
        if (found.methodNotAllowed) throw new HttpError(405, 'method not allowed');
        const result = await found.handler({ req, res, url, params: found.params, ...ctx });
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

  return { server, router, ctx };
}
