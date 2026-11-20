import { HttpError } from './http.js';

// Token bucket per key: `capacity` requests at once, refilled at `perSecond`.
export class RateLimiter {
  constructor({ capacity, perSecond, now = Date.now, message = 'slow down a little' }) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.message = message;
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const t = this.now();
    const b = this.buckets.get(key) || { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      const wait = Math.ceil((cost - b.tokens) / this.perSecond);
      throw Object.assign(new HttpError(429, `${this.message} (try again in ${wait}s)`, 'rate_limited'), { retryAfter: wait });
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
  }

  // Forget buckets that have refilled completely, so idle keys do not pile up.
  sweep() {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.perSecond >= this.capacity) this.buckets.delete(key);
    }
  }
}

export function defaultLimits() {
  return {
    message: new RateLimiter({ capacity: 20, perSecond: 1, message: 'you are sending messages too quickly' }),
    write: new RateLimiter({ capacity: 30, perSecond: 2 }),
    search: new RateLimiter({ capacity: 15, perSecond: 3, message: 'too many searches' }),
    signup: new RateLimiter({ capacity: 5, perSecond: 1 / 60, message: 'too many new accounts from here' }),
  };
}
