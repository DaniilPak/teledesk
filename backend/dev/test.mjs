// End-to-end flow tests against the in-memory store with fake Telegram / APNs / realtime / queue.
// Run: node backend/dev/test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { createMemoryStore } from '../src/store-memory.mjs';

function setup() {
  const calls = [];
  let nextId = 500;
  const tgState = { forums: new Set(), admins: new Set(), throttle: 0 };
  const telegram = {
    async call(method, params) {
      if (tgState.throttle > 0 && ['sendMessage', 'createForumTopic'].includes(method)) {
        tgState.throttle--;
        const e = new Error('Too Many Requests');
        e.retryAfter = 30;
        e.description = 'Too Many Requests: retry after 30';
        throw e;
      }
      calls.push({ method, params });
      if (method === 'getChat') return { id: params.chat_id, is_forum: tgState.forums.has(params.chat_id) };
      if (method === 'getChatMember')
        return tgState.admins.has(params.chat_id) ? { status: 'administrator', can_manage_topics: true } : { status: 'member' };
      if (method === 'createForumTopic') return { message_thread_id: ++nextId, name: params.name };
      return { message_id: ++nextId };
    },
  };
  const events = [];
  const realtime = { publish: async (pid, e) => events.push({ pid, ...e }), add: async () => {}, remove: async () => {} };
  const pushes = [];
  const push = { send: async (cfg, device, payload) => (pushes.push({ cfg, device, payload }), { ok: true, status: 200 }) };
  const jobs = [];
  const queue = { enqueue: async (job, delay) => jobs.push({ job, delay }) };
  const app = createApp({
    store: createMemoryStore(),
    telegram,
    realtime,
    push,
    queue,
    config: { jwtSecret: 'test-secret', botUsername: 'TestBot', botId: '42424242', webhookSecret: 'hook', dashboardUrl: 'http://x', wsUrl: 'ws://x' },
  });
  const call = (method, path, body, headers = {}) => {
    const [p, qs] = path.split('?');
    return app({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), headers, body: body && JSON.stringify(body) });
  };
  const tg = (update) => call('POST', '/v1/telegram/webhook', update, { 'x-telegram-bot-api-secret-token': 'hook' });
  const sent = () => calls.filter((c) => c.method === 'sendMessage');
  return { app, call, tg, calls, sent, tgState, events, pushes, jobs, nextId: () => nextId };
}

async function ownerWithProject(t, chat) {
  let r = await t.call('POST', '/v1/auth/signup', { email: `o${Math.random()}@x.com`, password: 'password123', name: 'Owner' });
  const auth = { authorization: `Bearer ${r.body.token}` };
  r = await t.call('POST', '/v1/projects', { name: 'My App' }, auth);
  const { id: pid, publicKey } = r.body.project;
  if (chat) {
    r = await t.call('POST', `/v1/projects/${pid}/telegram/link`, null, auth);
    await t.tg({ message: { message_id: 1, chat, text: `/start ${r.body.code}` } });
  }
  return { auth, pid, publicKey };
}

const vid = (c) => 'v_' + c.repeat(36);

// ---------------------------------------------------------------- reply mode (private chat)
{
  const t = setup();
  let r = await t.call('POST', '/v1/auth/signup', { email: 'Owner@x.com', password: 'password123', name: 'Owner' });
  assert.equal(r.status, 201);
  const auth = { authorization: `Bearer ${r.body.token}` };
  assert.equal((await t.call('POST', '/v1/auth/signup', { email: 'owner@x.com', password: 'password123' })).status, 409);
  assert.equal((await t.call('POST', '/v1/auth/login', { email: 'owner@x.com', password: 'nope' })).status, 401);
  assert.equal((await t.call('GET', '/v1/projects')).status, 401);

  r = await t.call('POST', '/v1/projects', { name: 'My App' }, auth);
  const { id: pid, publicKey } = r.body.project;

  r = await t.call('POST', `/v1/projects/${pid}/telegram/link`, null, auth);
  assert.match(r.body.privateUrl, /^https:\/\/t\.me\/TestBot\?start=/);
  assert.match(r.body.groupUrl, /startgroup=.+&admin=manage_topics/);
  await t.tg({ message: { message_id: 1, chat: { id: 42, type: 'private', first_name: 'Dan' }, text: `/start ${r.body.code}` } });
  assert.match(t.sent().at(-1).params.text, /is connected/);
  r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.connected, true);
  assert.equal(r.body.project.telegram.topics, false);
  assert.ok(t.events.some((e) => e.type === 'project'));
  assert.equal((await t.call('POST', '/v1/telegram/webhook', {}, { 'x-telegram-bot-api-secret-token': 'bad' })).status, 401);

  const v = vid('a');
  r = await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: v, text: 'Hello <b>help</b>', email: 'c@x.com' });
  assert.equal(r.body.ticket, 1);
  const header = t.sent().at(-1);
  assert.match(header.params.text, /Ticket #1/);
  assert.match(header.params.text, /&lt;b&gt;help/);
  assert.ok(t.events.some((e) => e.type === 'message' && e.ticket === 1 && e.isNew));
  const headerId = t.nextId();

  // owner replies -> visitor sees it, push goes out (APNs configured below first)
  const keyP8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal((await t.call('PUT', `/v1/projects/${pid}/apns`, { keyP8: 'nope', keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.acme.app' }, auth)).status, 400);
  r = await t.call('PUT', `/v1/projects/${pid}/apns`, { keyP8, keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.acme.app' }, auth);
  assert.deepEqual(r.body.project.apns, { configured: true, keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.acme.app' });
  assert.ok(!JSON.stringify(r.body).includes('PRIVATE KEY'), 'key never returned');
  r = await t.call('POST', '/v1/client/device', { key: publicKey, visitorId: v, token: 'ab'.repeat(32), env: 'sandbox' });
  assert.equal(r.body.pushEnabled, true);

  await t.tg({ message: { message_id: 10, chat: { id: 42, type: 'private' }, from: { first_name: 'Dan' }, text: 'We are on it', reply_to_message: { message_id: headerId } } });
  r = await t.call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${v}`);
  assert.deepEqual(r.body.messages.map((m) => m.from), ['visitor', 'agent']);
  assert.equal(t.pushes.length, 1);
  assert.equal(t.pushes[0].device.env, 'sandbox');
  assert.equal(t.pushes[0].payload.aps.alert.body, 'We are on it');
  assert.equal(t.pushes[0].payload.teledesk.ticket, 1);

  // unregistered device -> no more pushes
  assert.equal((await t.call('DELETE', `/v1/client/device?key=${publicKey}&visitorId=${v}`)).status, 204);
  await t.tg({ message: { message_id: 11, chat: { id: 42, type: 'private' }, text: 'Follow-up', reply_to_message: { message_id: 10 } } });
  assert.equal(t.pushes.length, 1);

  // other chat can't hijack
  await t.tg({ message: { message_id: 12, chat: { id: 99, type: 'private' }, text: 'evil', reply_to_message: { message_id: headerId } } });
  r = await t.call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${v}`);
  assert.ok(!r.body.messages.some((m) => m.text === 'evil'));

  // close via button -> next message opens #2
  await t.tg({ callback_query: { id: 'cb', data: `close:${pid}:1`, message: { message_id: headerId, chat: { id: 42 } } } });
  r = await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: v, text: 'New issue' });
  assert.equal(r.body.ticket, 2);

  // dashboard reply is mirrored
  r = await t.call('POST', `/v1/projects/${pid}/tickets/2/reply`, { text: 'From dashboard' }, auth);
  assert.equal(r.status, 201);
  assert.match(t.sent().at(-1).params.text, /answered from dashboard/);

  // ws tokens can't be used as API tokens
  r = await t.call('GET', `/v1/projects/${pid}/realtime`, null, auth);
  assert.equal(r.body.url, 'ws://x');
  assert.equal((await t.call('GET', '/v1/projects', null, { authorization: `Bearer ${r.body.token}` })).status, 401);
  assert.equal(await t.app.wsConnect('c1', { token: r.body.token }), true);
  assert.equal(await t.app.wsConnect('c2', { token: 'garbage' }), false);

  let other = await t.call('POST', '/v1/auth/signup', { email: 'other@x.com', password: 'password123' });
  assert.equal((await t.call('GET', `/v1/projects/${pid}`, null, { authorization: `Bearer ${other.body.token}` })).status, 404);
  console.log('✅ reply mode, push, realtime');
}

// ---------------------------------------------------------------- topic mode (forum supergroup)
{
  const t = setup();
  const chat = { id: -1001234567, type: 'supergroup', title: 'Acme Support', is_forum: true };
  t.tgState.forums.add(chat.id);
  t.tgState.admins.add(chat.id);
  const { auth, pid, publicKey } = await ownerWithProject(t, chat);
  let r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.topics, true);
  assert.match(t.sent().at(-1).params.text, /own <b>topic<\/b>/);

  const v = vid('b');
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: v, text: 'App crashes', name: 'Jane' });
  const created = t.calls.find((c) => c.method === 'createForumTopic');
  assert.equal(created.params.name, '🟢 #1 · Jane');
  const thread = t.nextId() - 1; // topic id, then header message id
  const head = t.sent().at(-1);
  assert.equal(head.params.message_thread_id, thread);
  assert.match(head.params.text, /Write in this topic/);

  // follow-up goes into the same topic, no new topic
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: v, text: 'Still crashing' });
  assert.equal(t.calls.filter((c) => c.method === 'createForumTopic').length, 1);
  assert.equal(t.sent().at(-1).params.message_thread_id, thread);
  assert.equal(t.sent().at(-1).params.text, 'Still crashing');

  // owner writes in the topic (no reply) -> customer gets it
  await t.tg({ message: { message_id: 900, chat, message_thread_id: thread, is_topic_message: true, from: { first_name: 'Dan' }, text: 'Fixed in 2.4.1' } });
  r = await t.call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${v}`);
  assert.equal(r.body.messages.at(-1).text, 'Fixed in 2.4.1');
  // service message in topic is ignored
  await t.tg({ message: { message_id: 901, chat, message_thread_id: thread, is_topic_message: true, from: { first_name: 'Dan' }, forum_topic_edited: { name: 'x' } } });
  r = await t.call('GET', `/v1/client/messages?key=${publicKey}&visitorId=${v}`);
  assert.equal(r.body.messages.length, 3);

  r = await t.call('GET', `/v1/projects/${pid}/tickets`, null, auth);
  assert.equal(r.body.tickets[0].telegramUrl, `https://t.me/c/1234567/${thread}`);

  // /close inside topic -> renamed + closed
  await t.tg({ message: { message_id: 902, chat, message_thread_id: thread, is_topic_message: true, from: { first_name: 'Dan' }, text: '/close' } });
  assert.ok(t.calls.some((c) => c.method === 'editForumTopic' && c.params.name === '✅ #1 · Jane'));
  assert.ok(t.calls.some((c) => c.method === 'closeForumTopic' && c.params.message_thread_id === thread));
  r = await t.call('GET', `/v1/projects/${pid}/tickets`, null, auth);
  assert.equal(r.body.tickets[0].status, 'closed');

  // reopen from dashboard -> topic reopened
  await t.call('POST', `/v1/projects/${pid}/tickets/1/status`, { status: 'open' }, auth);
  assert.ok(t.calls.some((c) => c.method === 'reopenForumTopic'));

  // delete-on-resolve setting
  await t.call('PATCH', `/v1/projects/${pid}`, { topicOnResolve: 'delete' }, auth);
  await t.call('POST', `/v1/projects/${pid}/tickets/1/status`, { status: 'closed' }, auth);
  assert.ok(t.calls.some((c) => c.method === 'deleteForumTopic' && c.params.message_thread_id === thread));

  // topic deleted manually by the owner -> recreated on next message
  const v2 = vid('c');
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: v2, text: 'Hi', name: 'Bob' });
  const bobThread = t.calls.filter((c) => c.method === 'createForumTopic').length;
  assert.equal(bobThread, 2);
  console.log('✅ topic mode');
}

// ---------------------------------------------------------------- rate limits + fallback + migration
{
  const t = setup();
  const chat = { id: -1009999, type: 'supergroup', title: 'Busy' };
  const { auth, pid, publicKey } = await ownerWithProject(t, chat);
  let r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.topicsReason, 'not_forum');

  // Telegram says 429 -> job parked in the queue, later jobs line up behind it
  t.tgState.throttle = 1;
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid('d'), text: 'first' });
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid('e'), text: 'second' });
  assert.equal(t.jobs.length, 2);
  assert.ok(t.jobs[0].delay >= 29 && t.jobs[1].delay > t.jobs[0].delay, 'spaced out in order');
  for (const { job } of t.jobs) await t.app.runJob(job);
  const texts = t.sent().map((c) => c.params.text);
  assert.ok(texts.some((x) => x.includes('first')) && texts.some((x) => x.includes('second')));

  // bot promoted + topics enabled -> my_chat_member flips to topic mode
  t.tgState.forums.add(chat.id);
  t.tgState.admins.add(chat.id);
  await t.tg({ my_chat_member: { chat, new_chat_member: { status: 'administrator', can_manage_topics: true } } });
  r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.topics, true);
  assert.match(t.sent().at(-1).params.text, /Topics are on/);

  // basic group upgraded to supergroup -> chat id migrates
  await t.tg({ message: { message_id: 5, chat, migrate_to_chat_id: -1008888 } });
  r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.chatType, 'supergroup');
  await t.call('POST', '/v1/client/messages', { key: publicKey, visitorId: vid('f'), text: 'after migrate' });
  // still inside the earlier rate-limit window, so it waits in the queue
  assert.equal(t.jobs.at(-1).job.text, 'after migrate');
  await t.app.runJob(t.jobs.at(-1).job);
  assert.equal(t.sent().at(-1).params.chat_id, -1008888);

  // bot removed from the group -> project disconnected
  await t.tg({ my_chat_member: { chat: { id: -1008888, type: 'supergroup' }, new_chat_member: { status: 'kicked' } } });
  r = await t.call('GET', `/v1/projects/${pid}`, null, auth);
  assert.equal(r.body.project.telegram.connected, false);
  console.log('✅ rate limits, topic detection, migration');
}

console.log('✅ all backend flow tests passed');
