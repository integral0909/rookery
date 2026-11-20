import { HttpError } from './http.js';

// Field checks for request bodies. Each throws a 400 naming the field, so
// clients can point at the input that needs fixing.

export function text(body, field, { min = 1, max = 200, pattern, optional = false, trim = true } = {}) {
  let value = body[field];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new HttpError(400, `${field} is required`, 'invalid');
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`, 'invalid');
  if (trim) value = value.trim();
  if (value.length < min) {
    throw new HttpError(400, min === 1 ? `${field} must not be empty` : `${field} must be at least ${min} characters`, 'invalid');
  }
  if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`, 'invalid');
  if (pattern && !pattern.test(value)) throw new HttpError(400, `${field} has invalid characters`, 'invalid');
  return value;
}

export function bool(body, field, { optional = false } = {}) {
  const value = body[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`, 'invalid');
  return value;
}

export function id(value, name = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`, 'invalid');
  return n;
}

export function int(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`, 'invalid');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`, 'invalid');
  }
  return n;
}

export const USERNAME = /^[a-z0-9][a-z0-9._-]*$/i;
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
