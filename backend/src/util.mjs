import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const randomId = (prefix = '', bytes = 12) =>
  prefix + crypto.randomBytes(bytes).toString('base64url');

export const now = () => Date.now();
export const iso = (ms = Date.now()) => new Date(ms).toISOString();

// Sortable message key: zero-padded epoch ms + random suffix. Strictly increasing within a process,
// so messages written back-to-back keep their order.
let lastMs = 0;
export function msgKey(ms = Date.now()) {
  lastMs = Math.max(ms, lastMs + 1);
  return `MSG#${String(lastMs).padStart(15, '0')}#${crypto.randomBytes(4).toString('hex')}`;
}

export const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function str(v, { min = 0, max = 200, field = 'value', required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (t.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return t;
}

export const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
