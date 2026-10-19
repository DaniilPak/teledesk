import crypto from 'node:crypto';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), key.length);
  return crypto.timingSafeEqual(key, test);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signJwt(payload, secret, ttlSeconds = 60 * 60 * 24 * 14) {
  const nowS = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: nowS, exp: nowS + ttlSeconds })}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
