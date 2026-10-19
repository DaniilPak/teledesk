// End-to-end flow test against the in-memory store with a fake Telegram. Run: node backend/dev/test.mjs
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { createMemoryStore } from '../src/store-memory.mjs';

const sent = [];
let nextId = 500;
const telegram = {
  sendMessage: async (chatId, text, extra) => (sent.push({ chatId, text, extra }), { message_id: ++nextId }),
  react: async () => null,
  answerCallback: async () => null,
  editKeyboard: async () => null,
};
const app = createApp({
  store: createMemoryStore(),
  telegram,
  config: { jwtSecret: 'test-secret', botUsername: 'TestBot', webhookSecret: 'hook', dashboardUrl: 'http://x' },
});

const call = (method, path, body, headers = {}) => {
  const [p, qs] = path.split('?');
  return app({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), headers, body: body && JSON.stringify(body) });
};
const tg = (update) => call('POST', '/v1/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': 'hook' });

// signup + project
let r = await call('POST', '/v1/auth/signup', { email: 'Owner@x.com', password: 'password123', name: 'Owner' });
assert.equal(r.status, 201);
const auth = { authorization: `Bearer ${r.body.token}` };
assert.equal((await call('POST', '/v1/auth/signup', { email: 'owner@x.com', password: 'password123' })).status, 409);
assert.equal((await call('POST', '/v1/auth/login', { email: 'owner@x.com', password: 'nope' })).status, 401);
assert.equal((await call('POST', '/v1/auth/login', { email: 'owner@x.com', password: 'password123' })).status, 200);
assert.equal((await call('GET', '/v1/projects')).status, 401);

r = await call('POST', '/v1/projects', { name: 'My App' }, auth);
const { id: pid, publicKey } = r.body.project;
r = await call('GET', '/v1/projects', null, auth);
assert.equal(r.body.projects.length, 1);

// connect telegram via deep link
r = await call('POST', `/v1/projects/${pid}/telegram/link`, null, auth);
assert.match(r.body.privateUrl, /^https:\/\/t\.me\/TestBot\?start=/);
assert.equal((await tg({ message: { message_id: 1, chat: { id: 42, type: 'private', first_name: 'Dan' }, text: `/start ${r.body.code}` } })).status, 200);
assert.match(sent.at(-1).text, /is connected/);
r = await call('GET', `/v1/projects/${pid}`, null, auth);
assert.deepEqual(r.body.project.telegram, { connected: true, chatTitle: 'Dan', chatType: 'private' });
assert.equal((await tg({ message: { message_id: 2, chat: { id: 42, type: 'private' }, text: '/start used' } })).status, 200);
assert.match(sent.at(-1).text, /expired/);
assert.equal((await call('POST', '/v1/telegram/webhook', {}, { 'x-telegram-bot-api-secret-token': 'bad' })).status, 401);

// customer writes from widget
const vid = 'v_' + 'a'.repeat(36);
r = await call('GET', `/v1/client/config?key=${publicKey}`);
assert.equal(r.body.online, true);
assert.equal((await call('GET', '/v1/client/config?key=pk_bad')).status, 401);
r = await call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid, text: 'Hello <b>help</b>', email: 'c@x.com', meta: { platform: 'web' } });
assert.equal(r.status, 201);
assert.equal(r.body.ticket, 1);
const ticketMsg = sent.at(-1);
assert.equal(ticketMsg.chatId, 42);
assert.match(ticketMsg.text, /Ticket #1/);
assert.match(ticketMsg.text, /&lt;b&gt;help/); // escaped
const ticketTgId = nextId;
r = await call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid, text: 'Second' });
assert.equal(r.body.ticket, 1);
assert.match(sent.at(-1).text, /#1/);

// owner replies in Telegram
await tg({ message: { message_id: 10, chat: { id: 42, type: 'private' }, from: { first_name: 'Dan' }, text: 'We are on it', reply_to_message: { message_id: ticketTgId } } });
r = await call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${vid}`);
assert.deepEqual(r.body.messages.map((m) => m.from), ['visitor', 'visitor', 'agent']);
assert.equal(r.body.messages[2].text, 'We are on it');
const cursor = r.body.messages[2].id;
const seen = new Set(r.body.messages.map((m) => m.id));
const fresh = (list) => list.filter((m) => !seen.has(m.id)); // clients de-duplicate by id
r = await call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${vid}&after=${encodeURIComponent(cursor)}`);
assert.equal(fresh(r.body.messages).length, 0);
assert.ok(!r.body.messages.some((m) => m.id === cursor));

// reply to the owner's own reply also routes to the ticket
await tg({ message: { message_id: 11, chat: { id: 42, type: 'private' }, text: 'Follow-up', reply_to_message: { message_id: 10 } } });
// another chat can't hijack the ticket
await tg({ message: { message_id: 12, chat: { id: 99, type: 'private' }, text: 'evil', reply_to_message: { message_id: ticketTgId } } });
r = await call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${vid}&after=${encodeURIComponent(cursor)}`);
assert.deepEqual(fresh(r.body.messages).map((m) => m.text), ['Follow-up']);

// close via inline button -> next message opens ticket #2
await tg({ callback_query: { id: 'cb', data: `close:${pid}:1`, message: { message_id: ticketTgId, chat: { id: 42 } } } });
r = await call('GET', `/v1/projects/${pid}/tickets`, null, auth);
assert.equal(r.body.tickets[0].status, 'closed');
r = await call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid, text: 'New issue' });
assert.equal(r.body.ticket, 2);

// dashboard: ticket detail, reply, status
r = await call('GET', `/v1/projects/${pid}/tickets/1`, null, auth);
assert.equal(r.body.messages.filter((m) => m.from !== 'system').length, 4);
r = await call('POST', `/v1/projects/${pid}/tickets/2/reply`, { text: 'From dashboard' }, auth);
assert.equal(r.status, 201);
assert.match(sent.at(-1).text, /answered from dashboard/);
r = await call('POST', `/v1/projects/${pid}/tickets/2/status`, { status: 'closed' }, auth);
assert.equal(r.body.ticket.status, 'closed');

// /tickets command
await tg({ message: { message_id: 20, chat: { id: 42, type: 'private' }, text: '/tickets' } });
assert.match(sent.at(-1).text, /My App<\/b> — 0 open/);

// validation + isolation
assert.equal((await call('POST', '/v1/client/messages', { key: publicKey, visitorId: 'short', text: 'x' })).status, 400);
assert.equal((await call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid, text: '' })).status, 400);
let other = await call('POST', '/v1/auth/signup', { email: 'other@x.com', password: 'password123' });
assert.equal((await call('GET', `/v1/projects/${pid}`, null, { authorization: `Bearer ${other.body.token}` })).status, 404);

// disconnect
r = await call('DELETE', `/v1/projects/${pid}/telegram`, null, auth);
assert.equal(r.body.project.telegram.connected, false);

console.log('✅ all backend flow tests passed');
