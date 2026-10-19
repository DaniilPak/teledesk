import { createApp } from './app.mjs';
import { createDynamoStore } from './store-dynamo.mjs';
import { createTelegram } from './telegram.mjs';

const handle = createApp({
  store: createDynamoStore(process.env.TABLE_NAME),
  telegram: createTelegram(process.env.TELEGRAM_BOT_TOKEN),
  config: {
    jwtSecret: process.env.JWT_SECRET,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    dashboardUrl: process.env.DASHBOARD_URL,
  },
});

// API Gateway HTTP API (payload v2) adapter.
export async function handler(event) {
  // The $default route also receives CORS preflights; API Gateway adds the CORS headers, we just answer 204.
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204 };
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  const res = await handle({
    method: event.requestContext?.http?.method ?? 'GET',
    path: event.rawPath ?? '/',
    query: event.queryStringParameters ?? {},
    headers,
    body,
  });
  return {
    statusCode: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: res.body === undefined ? '' : JSON.stringify(res.body),
  };
}
