// Local dev server: API (in-memory store, Telegram dry-run), dashboard, widget and a demo page.
// Run: node backend/dev/server.mjs   →  http://localhost:8787
// Simulate Telegram: POST /dev/telegram with an Update JSON (no secret needed locally).
import http from 'node:http';
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
const app = createApp({
  store,
  telegram,
  config: { jwtSecret: 'dev-jwt-secret', botUsername: BOT, webhookSecret: WEBHOOK_SECRET, dashboardUrl: ORIGIN },
});

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

http
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
  .listen(PORT, () => console.log(`TeleDesk dev server on ${ORIGIN}  (demo: ${ORIGIN}/demo.html?key=pk_...)`));
