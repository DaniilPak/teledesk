import http2 from 'node:http2';
import crypto from 'node:crypto';

// Apple Push Notification service client (token-based auth, HTTP/2), no dependencies.
const providerTokens = new Map(); // `${teamId}:${keyId}` -> { jwt, at }

function providerToken({ keyP8, keyId, teamId }) {
  const cacheKey = `${teamId}:${keyId}`;
  const cached = providerTokens.get(cacheKey);
  if (cached && Date.now() - cached.at < 50 * 60 * 1000) return cached.jwt;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keyP8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const jwt = `${data}.${sig}`;
  providerTokens.set(cacheKey, { jwt, at: Date.now() });
  return jwt;
}

export function validateApnsKey(keyP8) {
  try {
    const key = crypto.createPrivateKey(keyP8);
    return key.asymmetricKeyType === 'ec';
  } catch {
    return false;
  }
}

export function createApns() {
  return {
    // cfg: { keyP8, keyId, teamId, bundleId }, device: { token, env: 'sandbox' | 'production' }
    send(cfg, device, payload) {
      const host = device.env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          client.close();
          resolve(r);
        };
        const client = http2.connect(host);
        const timer = setTimeout(() => finish({ ok: false, status: 0, reason: 'Timeout' }), 8000);
        client.on('error', (e) => finish({ ok: false, status: 0, reason: e.message }));
        let jwt;
        try {
          jwt = providerToken(cfg);
        } catch (e) {
          return finish({ ok: false, status: 0, reason: 'InvalidProviderKey' });
        }
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${device.token}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        });
        let status = 0;
        let data = '';
        req.on('response', (h) => (status = h[':status']));
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          let reason;
          try {
            reason = JSON.parse(data).reason;
          } catch {}
          finish({ ok: status === 200, status, reason });
        });
        req.on('error', (e) => finish({ ok: false, status: 0, reason: e.message }));
        req.end(JSON.stringify(payload));
      });
    },
  };
}
