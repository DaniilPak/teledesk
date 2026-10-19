import { createApp } from './app.mjs';
import { createDynamoStore } from './store-dynamo.mjs';
import { createTelegram } from './telegram.mjs';
import { createApns } from './apns.mjs';
import { createAwsRealtime, createAwsQueue } from './aws.mjs';

const store = createDynamoStore(process.env.TABLE_NAME);
const token = process.env.TELEGRAM_BOT_TOKEN;

const app = createApp({
  store,
  telegram: createTelegram(token),
  realtime: createAwsRealtime({ store, endpoint: process.env.WS_MANAGEMENT_ENDPOINT }),
  push: createApns(),
  queue: process.env.QUEUE_URL ? createAwsQueue(process.env.QUEUE_URL) : null,
  config: {
    jwtSecret: process.env.JWT_SECRET,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    botId: token?.split(':')[0],
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    dashboardUrl: process.env.DASHBOARD_URL,
    wsUrl: process.env.WS_URL,
  },
});

export async function handler(event) {
  // SQS: delayed Telegram deliveries.
  if (Array.isArray(event.Records)) {
    const failures = [];
    for (const r of event.Records) {
      try {
        await app.runJob(JSON.parse(r.body));
      } catch (e) {
        console.error('job failed', e);
        failures.push({ itemIdentifier: r.messageId });
      }
    }
    return { batchItemFailures: failures };
  }

  // API Gateway WebSocket: dashboard live updates.
  const ctx = event.requestContext ?? {};
  if (ctx.eventType === 'CONNECT') {
    const ok = await app.wsConnect(ctx.connectionId, event.queryStringParameters ?? {}).catch(() => false);
    return { statusCode: ok ? 200 : 401 };
  }
  if (ctx.eventType === 'DISCONNECT') {
    await app.wsDisconnect(ctx.connectionId).catch(() => null);
    return { statusCode: 200 };
  }
  if (ctx.eventType === 'MESSAGE') return { statusCode: 200 }; // client pings keep the connection alive

  // API Gateway HTTP API (payload v2).
  // The $default route also receives CORS preflights; API Gateway adds the CORS headers, we just answer 204.
  if (ctx.http?.method === 'OPTIONS') return { statusCode: 204 };
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  const res = await app({
    method: ctx.http?.method ?? 'GET',
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
