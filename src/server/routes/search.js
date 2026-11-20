import { HttpError } from '../http.js';
import { search } from '../search.js';
import { int } from '../validate.js';

export default function searchRoutes(router) {
  router.get('/api/search', ({ url, db, requireUser, limits }) => {
    const me = requireUser();
    limits.search.take(me.id);
    const q = url.searchParams;
    const query = (q.get('q') || '').trim();
    if (query.length > 500) throw new HttpError(400, 'that search is too long', 'invalid');
    const sort = q.get('sort') === 'recent' ? 'recent' : 'relevance';
    return search(db, me, query, {
      limit: int(q.get('limit'), 'limit', { min: 1, max: 100, fallback: 20 }),
      offset: int(q.get('offset'), 'offset', { min: 0, max: 10_000, fallback: 0 }),
      sort,
    });
  });
}
