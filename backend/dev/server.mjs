// Local dev server: API (in-memory store, Telegram dry-run), dashboard, widget and a demo page.
// Run: node backend/dev/server.mjs   →  http://localhost:8787
// Simulate Telegram: POST /dev/telegram with an Update JSON (no secret needed locally).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { createMemoryStore } from '../src/store-memory.mjs';
import { createTelegram } from '../src/telegram.mjs';

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const WEBHOOK_SECRET = 'dev-webhook-secret';
const BOT = process.env.TELEGRAM_BOT_USERNAME || 'YourSupportBot';

const store = createMemoryStore();
// Real sends only if DEV_TELEGRAM_LIVE=1; otherwise calls are logged.
const telegram = createTelegram(process.env.DEV_TELEGRAM_LIVE === '1' ? process.env.TELEGRAM_BOT_TOKEN : undefined);

// In-process stand-ins for API Gateway WebSockets, SQS and APNs.
const sockets = new Map(); // connectionId -> { socket, pid }
const realtime = {
  async add(pid, id) { const c = sockets.get(id); if (c) c.pid = pid; },
  async remove(id) { sockets.get(id)?.socket.destroy(); sockets.delete(id); },
  async publish(pid, event) {
    for (const c of sockets.values()) if (c.pid === pid) wsSend(c.socket, JSON.stringify(event));
  },
};
let app;
const queue = { enqueue: async (job, delay) => void setTimeout(() => app.runJob(job), delay * 1000) };
const push = { send: async (cfg, device, payload) => (console.log('[apns dev]', device.env, JSON.stringify(payload.aps.alert)), { ok: true, status: 200 }) };

app = createApp({
  store,
  telegram,
  realtime,
  queue,
  push,
  config: { jwtSecret: 'dev-jwt-secret', botUsername: BOT, webhookSecret: WEBHOOK_SECRET, dashboardUrl: ORIGIN, wsUrl: `ws://localhost:${PORT}/ws` },
});

function wsSend(socket, text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([head, data]));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-teledesk-key, x-teledesk-visitor',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const DEMO = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo store</title><style>body{font:16px -apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#222}</style></head>
<body><h1>Acme Demo Store</h1><p>This page embeds the TeleDesk widget. Click the bubble in the corner.</p>
<script src="/widget.js" data-key="__KEY__" async></script></body></html>`;

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

    if (url.pathname.startsWith('/v1/') || url.pathname === '/dev/telegram') {
      const body = await readBody(req);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      let pathName = url.pathname;
      if (pathName === '/dev/telegram') {
        pathName = '/v1/telegram/webhook';
        headers['x-telegram-bot-api-secret-token'] = WEBHOOK_SECRET;
      }
      const out = await app({ method: req.method, path: pathName, query: Object.fromEntries(url.searchParams), headers, body });
      res.writeHead(out.status, { 'content-type': 'application/json', ...CORS });
      return res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    }

    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(`window.TELEDESK_CONFIG = ${JSON.stringify({ apiUrl: ORIGIN, botUsername: BOT, widgetUrl: `${ORIGIN}/widget.js` })};`);
    }
    if (url.pathname === '/widget.js') {
      const js = await fs.readFile(path.join(WEB, 'widget/widget.js'), 'utf8');
      res.writeHead(200, { 'content-type': MIME['.js'], ...CORS });
      return res.end(js.replace('__TELEDESK_API__', ORIGIN));
    }
    if (url.pathname === '/demo.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(DEMO.replace('__KEY__', (url.searchParams.get('key') || '').replace(/[^\w-]/g, '')));
    }

    const file = path.join(WEB, 'dashboard', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(WEB, 'dashboard'))) return res.writeHead(403).end();
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname !== '/ws') return socket.destroy();
  const id = crypto.randomUUID();
  sockets.set(id, { socket, pid: null });
  if (!(await app.wsConnect(id, Object.fromEntries(url.searchParams)))) {
    sockets.delete(id);
    return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 0x8) realtime.remove(id); }); // close frame; pings are ignored
  socket.on('close', () => sockets.delete(id));
  socket.on('error', () => sockets.delete(id));
});

server.listen(PORT, () => console.log(`TeleDesk dev server on ${ORIGIN}  (demo: ${ORIGIN}/demo.html?key=pk_...)`));
