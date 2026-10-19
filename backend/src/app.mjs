import { hashPassword, verifyPassword, signJwt, verifyJwt, safeEqual } from './auth.mjs';
import { validateApnsKey } from './apns.mjs';
import {
  HttpError,
  randomId,
  now,
  iso,
  msgKey,
  escapeHtml,
  str,
  VISITOR_RE,
  COLOR_RE,
  EMAIL_RE,
} from './util.mjs';

/*
 * Data model (single table, pk/sk):
 *   USER#<uid>             PROFILE                user account
 *   EMAIL#<email>          EMAIL                  email -> uid (uniqueness)
 *   PROJECT#<pid>          META                   project settings (+ gsi1pk OWNER#<uid>)
 *   PROJECT#<pid>          TICKET#<00000042>      ticket
 *   PUBKEY#<publicKey>     KEY                    public key -> pid
 *   LINK#<code>            LINK                   one-time Telegram connect code (ttl)
 *   CHAT#<chatId>          PROJECT#<pid>          projects linked to a Telegram chat
 *   VISITOR#<pid>#<vid>    STATE                  visitor profile, current open ticket, APNs token
 *   CONV#<pid>#<vid>       MSG#<ts>#<rand>        conversation messages
 *   TGMSG#<chat>#<msgId>   MAP                    Telegram message -> ticket (reply mode)
 *   TOPIC#<chat>#<thread>  MAP                    Telegram forum topic -> ticket (topic mode)
 *   WS#<pid> / WSCONN#<id>                        dashboard WebSocket connections (see aws.mjs)
 */

const TICKET_SK = (n) => `TICKET#${String(n).padStart(8, '0')}`;
const LINK_TTL_S = 15 * 60;
const TGMAP_TTL_S = 180 * 24 * 3600;
const CURSOR_LOOKBACK_MS = 5000;
const TOPIC_RECHECK_MS = 60 * 1000; // Telegram sends no update when a group turns Topics on
const TOPIC_HINT_MS = 24 * 3600 * 1000;
const MAX_JOB_ATTEMPTS = 25;
const TOPIC_COLOR = 0x6fb9f0;
const MEDIA_KEYS = ['photo', 'document', 'sticker', 'voice', 'video', 'animation', 'audio', 'video_note', 'location', 'contact'];

const noop = { publish: async () => {}, add: async () => {}, remove: async () => {} };

export function createApp({ store, telegram, config, realtime = noop, push = null, queue = null }) {
  const { jwtSecret, botUsername = 'YourSupportBot', webhookSecret, dashboardUrl = '', wsUrl = '' } = config;
  const botId = Number(config.botId || 0);

  // ---------- helpers ----------

  const P = (pid) => `PROJECT#${pid}`;
  const tg = (method, params) => telegram.call(method, params);
  const send = (chatId, text, extra = {}) =>
    tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

  const topicUrl = (chatId, topicId) =>
    topicId && String(chatId).startsWith('-100') ? `https://t.me/c/${String(chatId).slice(4)}/${topicId}` : undefined;

  const publicProject = (p) => ({
    id: p.pid,
    name: p.name,
    publicKey: p.publicKey,
    color: p.color,
    greeting: p.greeting,
    agentName: p.agentName,
    ticketCount: p.ticketSeq ?? 0,
    telegram: p.telegramChatId
      ? {
          connected: true,
          chatTitle: p.telegramChatTitle,
          chatType: p.telegramChatType,
          topics: Boolean(p.telegramTopics),
          topicsReason: p.telegramTopics ? null : p.telegramTopicsReason || (p.telegramChatType === 'private' ? 'private' : 'unknown'),
          topicOnResolve: p.telegramTopicOnResolve || 'close',
        }
      : { connected: false },
    apns: p.apns
      ? { configured: true, keyId: p.apns.keyId, teamId: p.apns.teamId, bundleId: p.apns.bundleId }
      : { configured: false },
    createdAt: p.createdAt,
  });

  const publicTicket = (t, project) => ({
    number: t.number,
    status: t.status,
    visitorId: t.visitorId,
    name: t.name,
    email: t.email,
    meta: t.meta,
    preview: t.preview,
    lastFrom: t.lastFrom,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    telegramUrl: project ? topicUrl(project.telegramChatId, t.topicId) : undefined,
  });

  const publicMessage = (m) => ({
    id: m.sk,
    from: m.from,
    text: m.text,
    ticket: m.ticket,
    agentName: m.agentName,
    createdAt: m.createdAt,
  });

  // Live events are fire-and-forget for the caller, but must finish before the request returns:
  // Lambda freezes the process as soon as the handler resolves.
  const pending = new Set();
  const emit = (pid, event) => {
    const p = realtime.publish(pid, event).catch((e) => console.error('realtime publish', e));
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  const flush = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  async function ownedProject(user, pid) {
    const p = await store.get(P(pid), 'META');
    if (!p || p.ownerId !== user.uid) throw new HttpError(404, 'Project not found');
    return p;
  }

  async function projectByKey(key) {
    if (!key || typeof key !== 'string') throw new HttpError(401, 'Missing public key');
    const ref = await store.get(`PUBKEY#${key}`, 'KEY');
    if (!ref) throw new HttpError(401, 'Invalid public key');
    const p = await store.get(P(ref.pid), 'META');
    if (!p) throw new HttpError(401, 'Invalid public key');
    return p;
  }

  function visitorId(v) {
    if (!VISITOR_RE.test(String(v || ''))) throw new HttpError(400, 'Invalid visitorId');
    return v;
  }

  async function addMessage(pid, vid, { from, text, ticket, agentName }) {
    const ms = now();
    const m = { pk: `CONV#${pid}#${vid}`, sk: msgKey(ms), from, text, ticket, agentName, createdAt: iso(ms) };
    await store.put(m);
    return m;
  }

  async function mapTelegram(chatId, messageId, pid, vid, ticket) {
    await store.put({
      pk: `TGMSG#${chatId}#${messageId}`,
      sk: 'MAP',
      pid,
      vid,
      ticket,
      ttl: Math.floor(now() / 1000) + TGMAP_TTL_S,
    });
  }

  const ticketKeyboard = (pid, n, status) => [
    [
      status === 'closed'
        ? { text: `🔄 Reopen #${n}`, callback_data: `reopen:${pid}:${n}` }
        : { text: `✅ Close #${n}`, callback_data: `close:${pid}:${n}` },
    ],
  ];

  const whoOf = (t) => [t.name, t.email].filter(Boolean).join(' · ') || 'Anonymous visitor';

  const topicName = (t, status) =>
    `${status === 'closed' ? '✅' : '🟢'} #${t.number} · ${t.name || t.email || 'Visitor'}`.slice(0, 128);

  function describeMeta(meta) {
    if (!meta || typeof meta !== 'object') return '';
    return Object.entries(meta)
      .slice(0, 8)
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v).slice(0, 80))}`)
      .join(' · ');
  }

  const ticketHeader = (project, t) =>
    `🆕 <b>Ticket #${t.number}</b> · ${escapeHtml(project.name)}\n👤 ${escapeHtml(whoOf(t))}` +
    (t.meta ? `\n📱 ${describeMeta(t.meta)}` : '');

  // ---------- Telegram topic capability ----------

  async function checkTopics(chatId, chatType) {
    if (chatType === 'private') return { topics: false, reason: 'private' };
    try {
      const chat = await tg('getChat', { chat_id: chatId });
      if (!chat.is_forum) return { topics: false, reason: 'not_forum' };
      if (!botId) return { topics: false, reason: 'no_rights' };
      const me = await tg('getChatMember', { chat_id: chatId, user_id: botId });
      const ok = me.status === 'creator' || (me.status === 'administrator' && me.can_manage_topics === true);
      return { topics: ok, reason: ok ? null : 'no_rights' };
    } catch (e) {
      if (e.retryAfter) throw e;
      return { topics: false, reason: 'error' };
    }
  }

  async function refreshTopics(project) {
    const r = await checkTopics(project.telegramChatId, project.telegramChatType);
    return store.update(P(project.pid), 'META', {
      set: { telegramTopics: r.topics, telegramTopicsReason: r.reason ?? 'ok', telegramTopicsCheckedAt: now() },
    });
  }

  const topicHelp =
    'For one topic per ticket: open the group settings → turn on <b>Topics</b>, then make me an admin with the <b>Manage topics</b> right.';

  // ---------- owner notifications (Telegram) ----------

  async function notifyOwner(project, ticket, text, isNew) {
    if (!project.telegramChatId) return;
    await runJob({ type: 'notify', pid: project.pid, n: ticket.number, text, isNew });
  }

  async function runJob(job) {
    if (job.type === 'notify') return deliverNotify(job);
    if (job.type === 'mirror') return deliverMirror(job);
    console.warn('unknown job', job.type);
  }

  // Telegram allows ~20 messages/minute per group. On 429 we park the job in the queue and
  // space retries out so a burst of tickets is delivered in order instead of being dropped.
  async function defer(project, job, retryAfter) {
    const attempt = (job.attempt || 0) + 1;
    if (!queue || attempt > MAX_JOB_ATTEMPTS) {
      console.error('dropping telegram job after retries', job.type, job.pid, job.n);
      return;
    }
    const nowMs = now();
    const fresh = await store.get(P(project.pid), 'META');
    const slot = Math.max(nowMs + retryAfter * 1000, fresh?.tgNextSlot || 0);
    await store.update(P(project.pid), 'META', { set: { tgNextSlot: slot + 3000 } });
    await queue.enqueue({ ...job, attempt }, (slot - nowMs) / 1000);
  }

  async function deliverNotify(job) {
    let project = await store.get(P(job.pid), 'META');
    if (!project?.telegramChatId) return;
    const ticket = await store.get(P(job.pid), TICKET_SK(job.n));
    if (!ticket) return;

    // While we're throttled, queue behind the earlier jobs to keep order.
    if (!job.attempt && queue && (project.tgNextSlot || 0) > now()) return defer(project, job, 0);

    try {
      if (
        job.isNew &&
        !project.telegramTopics &&
        project.telegramChatType !== 'private' &&
        now() - (project.telegramTopicsCheckedAt || 0) > TOPIC_RECHECK_MS
      ) {
        const before = project.telegramTopicsReason;
        project = await refreshTopics(project);
        if (project.telegramTopics || project.telegramTopicsReason !== before) emit(project.pid, { type: 'project' });
        await maybeHintTopics(project);
      }
      if (project.telegramTopics) {
        try {
          await deliverToTopic(project, ticket, job);
          return;
        } catch (e) {
          if (e.retryAfter) throw e;
          console.error('topic delivery failed, falling back', e.description || e);
          project = await store.update(P(project.pid), 'META', {
            set: { telegramTopics: false, telegramTopicsReason: 'error', telegramTopicsCheckedAt: now() },
          });
          emit(project.pid, { type: 'project' });
          await send(
            project.telegramChatId,
            `⚠️ I couldn’t create a topic for ticket #${ticket.number} (${escapeHtml(e.description || 'error')}), so I’m posting here instead.\n\n${topicHelp}`,
          ).catch(() => null);
          job = { ...job, isNew: job.isNew || !ticket.topicHeaderSent };
        }
      }
      await deliverToChat(project, ticket, job);
    } catch (e) {
      if (e.retryAfter) return defer(project, job, e.retryAfter);
      console.error('notifyOwner failed', e);
    }
  }

  // Tell the group what's missing for topic mode (at most once a day).
  async function maybeHintTopics(project) {
    if (project.telegramTopics || !['no_rights', 'not_forum'].includes(project.telegramTopicsReason)) return;
    if (now() - (project.telegramTopicsHintAt || 0) < TOPIC_HINT_MS) return;
    await store.update(P(project.pid), 'META', { set: { telegramTopicsHintAt: now() } });
    const text =
      project.telegramTopicsReason === 'no_rights'
        ? '💡 Topics are on, but I can’t create topics yet. Group settings → <b>Administrators</b> → me → turn on <b>Manage topics</b>. I’ll switch to one topic per ticket right away.'
        : `💡 ${topicHelp}`;
    await send(project.telegramChatId, text);
  }

  async function deliverToTopic(project, ticket, job, recreated = false) {
    const chat = project.telegramChatId;
    let topicId = ticket.topicId;
    if (!topicId) {
      const topic = await tg('createForumTopic', { chat_id: chat, name: topicName(ticket, 'open'), icon_color: TOPIC_COLOR });
      topicId = topic.message_thread_id;
      ticket = await store.update(P(project.pid), ticket.sk, { set: { topicId }, remove: ['topicHeaderSent'] });
      await store.put({ pk: `TOPIC#${chat}#${topicId}`, sk: 'MAP', pid: project.pid, vid: ticket.visitorId, ticket: ticket.number });
      emit(project.pid, { type: 'ticket', ticket: ticket.number });
    }
    try {
      if (!ticket.topicHeaderSent) {
        const sent = await send(
          chat,
          `${ticketHeader(project, ticket)}\n\n${escapeHtml(job.text)}\n\n<i>✍️ Write in this topic to answer — no need to reply.</i>`,
          { message_thread_id: topicId, reply_markup: { inline_keyboard: ticketKeyboard(project.pid, ticket.number, 'open') } },
        );
        await store.update(P(project.pid), ticket.sk, { set: { topicHeaderSent: true } });
        await mapTelegram(chat, sent.message_id, project.pid, ticket.visitorId, ticket.number);
      } else {
        await send(chat, escapeHtml(job.text), { message_thread_id: topicId });
      }
    } catch (e) {
      if (e.retryAfter || recreated) throw e;
      if (/TOPIC_CLOSED/i.test(e.description)) {
        await tg('reopenForumTopic', { chat_id: chat, message_thread_id: topicId });
        return deliverToTopic(project, ticket, job, true);
      }
      if (/thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.description)) {
        await store.del(`TOPIC#${chat}#${topicId}`, 'MAP');
        const t = await store.update(P(project.pid), ticket.sk, { remove: ['topicId', 'topicHeaderSent'] });
        return deliverToTopic(project, t, job, true);
      }
      throw e;
    }
  }

  async function deliverToChat(project, ticket, job) {
    const body = job.isNew
      ? `${ticketHeader(project, ticket)}\n\n${escapeHtml(job.text)}\n\n<i>↩️ Reply to this message to answer.</i>`
      : `💬 <b>#${ticket.number}</b> · ${escapeHtml(whoOf(ticket))}\n\n${escapeHtml(job.text)}`;
    const sent = await send(project.telegramChatId, body, {
      reply_markup: { inline_keyboard: ticketKeyboard(project.pid, ticket.number, 'open') },
    });
    await mapTelegram(project.telegramChatId, sent.message_id, project.pid, ticket.visitorId, ticket.number);
  }

  // Replies written in the dashboard are mirrored to Telegram so the team sees the whole thread.
  async function deliverMirror(job) {
    const project = await store.get(P(job.pid), 'META');
    if (!project?.telegramChatId) return;
    const ticket = await store.get(P(job.pid), TICKET_SK(job.n));
    if (!ticket) return;
    try {
      const inTopic = project.telegramTopics && ticket.topicId;
      const sent = await send(
        project.telegramChatId,
        inTopic
          ? `📤 <b>${escapeHtml(job.author)}</b> (dashboard):\n${escapeHtml(job.text)}`
          : `📤 <b>#${job.n}</b> answered from dashboard by ${escapeHtml(job.author)}:\n\n${escapeHtml(job.text)}`,
        inTopic ? { message_thread_id: ticket.topicId } : {},
      );
      await mapTelegram(project.telegramChatId, sent.message_id, project.pid, ticket.visitorId, job.n);
    } catch (e) {
      if (e.retryAfter) return defer(project, job, e.retryAfter);
      console.error('mirror failed', e.description || e);
    }
  }

  async function syncTopicStatus(project, ticket, status) {
    if (!project?.telegramChatId || !ticket.topicId) return;
    const chat = project.telegramChatId;
    const thread = { chat_id: chat, message_thread_id: ticket.topicId };
    try {
      if (status === 'closed' && project.telegramTopicOnResolve === 'delete') {
        await tg('deleteForumTopic', thread);
        await store.del(`TOPIC#${chat}#${ticket.topicId}`, 'MAP');
        await store.update(P(project.pid), ticket.sk, { remove: ['topicId', 'topicHeaderSent'] });
      } else if (status === 'closed') {
        await tg('editForumTopic', { ...thread, name: topicName(ticket, 'closed') }).catch(() => null);
        await tg('closeForumTopic', thread);
      } else {
        await tg('reopenForumTopic', thread).catch(() => null);
        await tg('editForumTopic', { ...thread, name: topicName(ticket, 'open') }).catch(() => null);
      }
    } catch (e) {
      console.error('topic status sync failed', e.description || e);
    }
  }

  // ---------- customer notifications (APNs) ----------

  async function pushVisitor(project, vid, n, text, agentName) {
    if (!push || !project.apns) return;
    const vKey = [`VISITOR#${project.pid}#${vid}`, 'STATE'];
    const v = await store.get(...vKey);
    if (!v?.apns?.token) return;
    const r = await push.send(project.apns, v.apns, {
      aps: {
        alert: { title: agentName || project.agentName || project.name, subtitle: project.name, body: text.slice(0, 240) },
        sound: 'default',
        'thread-id': `teledesk-${project.pid}`,
      },
      teledesk: { project: project.pid, ticket: n },
    });
    if (r.ok) return;
    if (r.status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(r.reason)) {
      await store.update(...vKey, { remove: ['apns'] });
    }
    console.error('apns push failed', r.status, r.reason);
  }

  // ---------- tickets ----------

  async function setTicketStatus(pid, n, status) {
    const t = await store.get(P(pid), TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    if (t.status === status) return t;
    const updated = await store.update(P(pid), TICKET_SK(n), { set: { status, updatedAt: iso() } });
    const vKey = [`VISITOR#${pid}#${t.visitorId}`, 'STATE'];
    const v = await store.get(...vKey);
    if (status === 'closed') {
      if (v?.currentTicket === n) await store.update(...vKey, { remove: ['currentTicket'] });
      await addMessage(pid, t.visitorId, { from: 'system', text: 'This conversation was marked as resolved.', ticket: n });
    } else {
      // Reopening: if the visitor already has another open ticket, close it into this one.
      if (v?.currentTicket && v.currentTicket !== n) {
        const other = await store.update(P(pid), TICKET_SK(v.currentTicket), { set: { status: 'closed', updatedAt: iso() } });
        await syncTopicStatus(await store.get(P(pid), 'META'), other, 'closed');
      }
      await store.update(...vKey, { set: { currentTicket: n } });
    }
    await syncTopicStatus(await store.get(P(pid), 'META'), updated, status);
    emit(pid, { type: 'ticket', ticket: n });
    return updated;
  }

  async function agentReply(project, vid, n, text, agentName) {
    const t = await store.get(P(project.pid), TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    if (t.status === 'closed') await setTicketStatus(project.pid, n, 'open');
    const name = agentName || project.agentName || 'Support';
    const m = await addMessage(project.pid, vid, { from: 'agent', text, ticket: n, agentName: name });
    await store.update(P(project.pid), TICKET_SK(n), {
      set: { updatedAt: m.createdAt, lastFrom: 'agent', preview: text.slice(0, 140) },
    });
    emit(project.pid, { type: 'message', ticket: n });
    await pushVisitor(project, vid, n, text, name).catch((e) => console.error('push', e));
    return m;
  }

  // ---------- auth ----------

  async function signup({ body }) {
    const email = str(body.email, { field: 'email', required: true, max: 200 })?.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Invalid email');
    const password = body.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 200)
      throw new HttpError(400, 'Password must be at least 8 characters');
    const name = str(body.name, { field: 'name', max: 100 }) ?? email.split('@')[0];
    const uid = randomId('usr_', 9);
    const ok = await store.put({ pk: `EMAIL#${email}`, sk: 'EMAIL', uid }, { ifNotExists: true });
    if (!ok) throw new HttpError(409, 'An account with this email already exists');
    await store.put({ pk: `USER#${uid}`, sk: 'PROFILE', uid, email, name, hash: hashPassword(password), createdAt: iso() });
    return { status: 201, body: { token: signJwt({ uid }, jwtSecret), user: { id: uid, email, name } } };
  }

  async function login({ body }) {
    const email = String(body.email || '').trim().toLowerCase();
    const ref = await store.get(`EMAIL#${email}`, 'EMAIL');
    const user = ref && (await store.get(`USER#${ref.uid}`, 'PROFILE'));
    if (!user || !verifyPassword(String(body.password || ''), user.hash))
      throw new HttpError(401, 'Wrong email or password');
    return { body: { token: signJwt({ uid: user.uid }, jwtSecret), user: { id: user.uid, email, name: user.name } } };
  }

  async function me({ user }) {
    return { body: { id: user.uid, email: user.email, name: user.name, botUsername } };
  }

  // ---------- projects ----------

  async function listProjects({ user }) {
    const items = await store.queryIndex(`OWNER#${user.uid}`);
    return { body: { projects: items.map(publicProject) } };
  }

  async function createProject({ user, body }) {
    const name = str(body.name, { field: 'name', required: true, min: 1, max: 80 });
    const pid = randomId('prj_', 9);
    const publicKey = randomId('pk_', 18);
    const p = {
      pk: P(pid),
      sk: 'META',
      gsi1pk: `OWNER#${user.uid}`,
      gsi1sk: iso(),
      pid,
      ownerId: user.uid,
      name,
      publicKey,
      color: '#111111',
      greeting: 'Hi! How can we help you today?',
      agentName: 'Support',
      ticketSeq: 0,
      createdAt: iso(),
    };
    await store.put(p);
    await store.put({ pk: `PUBKEY#${publicKey}`, sk: 'KEY', pid });
    return { status: 201, body: { project: publicProject(p) } };
  }

  async function getProject({ user, params }) {
    const p = await ownedProject(user, params.id);
    return { body: { project: publicProject(p) } };
  }

  async function updateProject({ user, params, body }) {
    await ownedProject(user, params.id);
    const color = str(body.color, { field: 'color', max: 7 });
    if (color && !COLOR_RE.test(color)) throw new HttpError(400, 'color must look like #112233');
    if (body.topicOnResolve !== undefined && !['close', 'delete'].includes(body.topicOnResolve))
      throw new HttpError(400, 'topicOnResolve must be close or delete');
    const p = await store.update(P(params.id), 'META', {
      set: {
        name: str(body.name, { field: 'name', min: 1, max: 80 }),
        greeting: str(body.greeting, { field: 'greeting', max: 300 }),
        agentName: str(body.agentName, { field: 'agentName', max: 60 }),
        color,
        telegramTopicOnResolve: body.topicOnResolve,
      },
    });
    emit(p.pid, { type: 'project' });
    return { body: { project: publicProject(p) } };
  }

  async function deleteProject({ user, params }) {
    const p = await ownedProject(user, params.id);
    if (p.telegramChatId) await store.del(`CHAT#${p.telegramChatId}`, `PROJECT#${p.pid}`);
    await store.del(`PUBKEY#${p.publicKey}`, 'KEY');
    await store.del(P(p.pid), 'META');
    return { status: 204 };
  }

  async function createTelegramLink({ user, params }) {
    const p = await ownedProject(user, params.id);
    const code = randomId('', 12);
    await store.put({ pk: `LINK#${code}`, sk: 'LINK', pid: p.pid, ttl: Math.floor(now() / 1000) + LINK_TTL_S });
    return {
      status: 201,
      body: {
        code,
        expiresIn: LINK_TTL_S,
        privateUrl: `https://t.me/${botUsername}?start=${code}`,
        // Ask for topic-management admin rights up front when adding the bot to a group.
        groupUrl: `https://t.me/${botUsername}?startgroup=${code}&admin=manage_topics+delete_messages`,
      },
    };
  }

  async function checkTelegram({ user, params }) {
    const p = await ownedProject(user, params.id);
    if (!p.telegramChatId) throw new HttpError(400, 'Telegram is not connected');
    const updated = await refreshTopics(p);
    emit(p.pid, { type: 'project' });
    return { body: { project: publicProject(updated) } };
  }

  async function disconnectTelegram({ user, params }) {
    const p = await ownedProject(user, params.id);
    if (p.telegramChatId) {
      await store.del(`CHAT#${p.telegramChatId}`, `PROJECT#${p.pid}`);
      await send(p.telegramChatId, `🔌 <b>${escapeHtml(p.name)}</b> was disconnected from this chat.`).catch(() => null);
    }
    const updated = await store.update(P(p.pid), 'META', {
      remove: ['telegramChatId', 'telegramChatTitle', 'telegramChatType', 'telegramTopics', 'telegramTopicsReason', 'telegramTopicsCheckedAt'],
    });
    emit(p.pid, { type: 'project' });
    return { body: { project: publicProject(updated) } };
  }

  async function setApns({ user, params, body }) {
    await ownedProject(user, params.id);
    const keyP8 = String(body.keyP8 || '').trim();
    const keyId = str(body.keyId, { field: 'Key ID', required: true, max: 20 });
    const teamId = str(body.teamId, { field: 'Team ID', required: true, max: 20 });
    const bundleId = str(body.bundleId, { field: 'Bundle ID', required: true, max: 200 });
    if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new HttpError(400, 'Key ID is the 10-character ID of the key');
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new HttpError(400, 'Team ID is the 10-character ID of your Apple team');
    if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new HttpError(400, 'Invalid bundle ID');
    if (!keyP8.includes('BEGIN PRIVATE KEY') || !validateApnsKey(keyP8))
      throw new HttpError(400, 'That doesn’t look like an APNs .p8 key');
    const p = await store.update(P(params.id), 'META', { set: { apns: { keyP8, keyId, teamId, bundleId } } });
    emit(p.pid, { type: 'project' });
    return { body: { project: publicProject(p) } };
  }

  async function deleteApns({ user, params }) {
    await ownedProject(user, params.id);
    const p = await store.update(P(params.id), 'META', { remove: ['apns'] });
    emit(p.pid, { type: 'project' });
    return { body: { project: publicProject(p) } };
  }

  async function realtimeToken({ user, params }) {
    await ownedProject(user, params.id);
    return { body: { url: wsUrl, token: signJwt({ uid: user.uid, pid: params.id, typ: 'ws' }, jwtSecret, 120) } };
  }

  // ---------- tickets (dashboard) ----------

  async function listTickets({ user, params, query }) {
    const p = await ownedProject(user, params.id);
    let items = await store.query(P(params.id), { prefix: 'TICKET#', desc: true, limit: 200 });
    if (query.status) items = items.filter((t) => t.status === query.status);
    return { body: { tickets: items.map((t) => publicTicket(t, p)) } };
  }

  async function getTicket({ user, params }) {
    const p = await ownedProject(user, params.id);
    const n = Number(params.number);
    const t = await store.get(P(params.id), TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    const msgs = await store.query(`CONV#${params.id}#${t.visitorId}`, { prefix: 'MSG#', limit: 500 });
    return { body: { ticket: publicTicket(t, p), messages: msgs.filter((m) => m.ticket === n).map(publicMessage) } };
  }

  async function replyTicket({ user, params, body }) {
    const p = await ownedProject(user, params.id);
    const n = Number(params.number);
    const text = str(body.text, { field: 'text', required: true, min: 1, max: 4000 });
    const t = await store.get(P(p.pid), TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    const m = await agentReply(p, t.visitorId, n, text, user.name);
    if (p.telegramChatId) await runJob({ type: 'mirror', pid: p.pid, n, text, author: user.name });
    return { status: 201, body: { message: publicMessage(m) } };
  }

  async function updateTicketStatus({ user, params, body }) {
    const p = await ownedProject(user, params.id);
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'status must be open or closed');
    const t = await setTicketStatus(params.id, Number(params.number), body.status);
    return { body: { ticket: publicTicket(t, p) } };
  }

  // ---------- client SDK (widget / iOS) ----------

  async function clientConfig({ query, headers }) {
    const p = await projectByKey(query.key || headers['x-teledesk-key']);
    return {
      body: { name: p.name, color: p.color, greeting: p.greeting, agentName: p.agentName, online: Boolean(p.telegramChatId) },
    };
  }

  async function clientSend({ body, headers }) {
    const p = await projectByKey(body.key || headers['x-teledesk-key']);
    const vid = visitorId(body.visitorId || headers['x-teledesk-visitor']);
    const text = str(body.text, { field: 'text', required: true, min: 1, max: 4000 });
    const name = str(body.name, { field: 'name', max: 100 });
    const email = str(body.email, { field: 'email', max: 200 });
    let meta;
    if (body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) {
      meta = Object.fromEntries(
        Object.entries(body.meta)
          .slice(0, 12)
          .map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 200)]),
      );
    }

    const vKey = [`VISITOR#${p.pid}#${vid}`, 'STATE'];
    const visitor = (await store.get(...vKey)) ?? {};
    const profile = { name: name ?? visitor.name, email: email ?? visitor.email, meta: meta ?? visitor.meta };

    let ticket;
    let isNew = false;
    if (visitor.currentTicket) ticket = await store.get(P(p.pid), TICKET_SK(visitor.currentTicket));
    if (!ticket || ticket.status !== 'open') {
      const updated = await store.update(P(p.pid), 'META', { add: { ticketSeq: 1 } });
      const n = updated.ticketSeq;
      ticket = {
        pk: P(p.pid),
        sk: TICKET_SK(n),
        number: n,
        status: 'open',
        visitorId: vid,
        ...profile,
        preview: text.slice(0, 140),
        lastFrom: 'visitor',
        createdAt: iso(),
        updatedAt: iso(),
      };
      await store.put(ticket);
      isNew = true;
    } else {
      ticket = await store.update(P(p.pid), ticket.sk, {
        set: { ...profile, preview: text.slice(0, 140), lastFrom: 'visitor', updatedAt: iso() },
      });
    }

    await store.update(...vKey, { set: { ...profile, currentTicket: ticket.number, lastSeenAt: iso() } });
    const m = await addMessage(p.pid, vid, { from: 'visitor', text, ticket: ticket.number });
    emit(p.pid, { type: 'message', ticket: ticket.number, isNew });
    await notifyOwner(p, ticket, text, isNew);
    return { status: 201, body: { message: publicMessage(m), ticket: ticket.number } };
  }

  async function clientMessages({ query, headers }) {
    const p = await projectByKey(query.key || headers['x-teledesk-key']);
    const vid = visitorId(query.visitorId || headers['x-teledesk-visitor']);
    const pk = `CONV#${p.pid}#${vid}`;
    let items;
    if (query.after) {
      const m = String(query.after).match(/^MSG#(\d{15})#[0-9a-f]{8}$/);
      if (!m) throw new HttpError(400, 'Invalid cursor');
      // Look back a few seconds so same-millisecond writes and clock skew between Lambdas are never
      // skipped; clients de-duplicate by id.
      const from = `MSG#${String(Math.max(0, Number(m[1]) - CURSOR_LOOKBACK_MS)).padStart(15, '0')}`;
      items = (await store.query(pk, { after: from, limit: 100 })).filter((x) => x.sk !== query.after);
    } else {
      items = (await store.query(pk, { prefix: 'MSG#', desc: true, limit: 50 })).reverse();
    }
    return { body: { messages: items.map(publicMessage) } };
  }

  async function clientRegisterDevice({ body, headers }) {
    const p = await projectByKey(body.key || headers['x-teledesk-key']);
    const vid = visitorId(body.visitorId || headers['x-teledesk-visitor']);
    const token = String(body.token || '');
    if (!/^[0-9a-fA-F]{64,200}$/.test(token)) throw new HttpError(400, 'Invalid device token');
    const env = body.env === 'sandbox' ? 'sandbox' : 'production';
    await store.update(`VISITOR#${p.pid}#${vid}`, 'STATE', { set: { apns: { token: token.toLowerCase(), env } } });
    return { body: { ok: true, pushEnabled: Boolean(p.apns) } };
  }

  async function clientUnregisterDevice({ query, headers }) {
    const p = await projectByKey(query.key || headers['x-teledesk-key']);
    const vid = visitorId(query.visitorId || headers['x-teledesk-visitor']);
    await store.update(`VISITOR#${p.pid}#${vid}`, 'STATE', { remove: ['apns'] });
    return { status: 204 };
  }

  // ---------- Telegram webhook ----------

  async function telegramWebhook({ headers, body }) {
    if (!safeEqual(headers['x-telegram-bot-api-secret-token'], webhookSecret)) throw new HttpError(401, 'Bad secret');
    try {
      if (body.message) await onTelegramMessage(body.message);
      else if (body.callback_query) await onTelegramCallback(body.callback_query);
      else if (body.my_chat_member) await onMyChatMember(body.my_chat_member);
    } catch (e) {
      // Always 200 so Telegram doesn't retry forever; log for CloudWatch.
      console.error('telegram update failed', e);
    }
    return { body: { ok: true } };
  }

  async function projectsForChat(chatId) {
    const links = await store.query(`CHAT#${chatId}`, { prefix: 'PROJECT#' });
    const projects = await Promise.all(links.map((l) => store.get(P(l.pid), 'META')));
    return projects.filter((p) => p && String(p.telegramChatId) === String(chatId));
  }

  async function onTelegramMessage(msg) {
    const chat = msg.chat;
    if (msg.migrate_to_chat_id) return migrateChat(chat.id, msg.migrate_to_chat_id);
    if (msg.from?.is_bot) return;
    const text = msg.text ?? '';
    const isPrivate = chat.type === 'private';
    const cmd = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]+))?$/);
    if (cmd && cmd[2] && cmd[2].toLowerCase() !== botUsername.toLowerCase()) return; // command for another bot

    if (cmd?.[1] === 'start') {
      const code = cmd[3]?.trim();
      if (!code) {
        return send(
          chat.id,
          `👋 <b>Welcome!</b>\n\nI forward messages from your app and website customers here.\n\n` +
            `1. Sign up at ${escapeHtml(dashboardUrl || 'the dashboard')}\n2. Create a project\n3. Press <b>Connect Telegram</b>`,
        );
      }
      return linkChat(chat, code);
    }
    if (cmd?.[1] === 'help') {
      return send(
        chat.id,
        `<b>How it works</b>\n• New customer messages arrive as tickets.\n` +
          `• In a group with Topics, each ticket gets its own topic — just write in it to answer.\n` +
          `• Otherwise, <b>reply</b> to a ticket message to answer.\n• /tickets — list open tickets\n` +
          `• /close, /reopen — in a ticket topic, or as a reply to a ticket message`,
        msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {},
      );
    }
    if (cmd?.[1] === 'tickets') return listOpenTickets(chat, msg.message_thread_id);

    // Resolve which ticket this message belongs to: its topic, or the message it replies to.
    let map = null;
    if (msg.is_topic_message && msg.message_thread_id) {
      map = await store.get(`TOPIC#${chat.id}#${msg.message_thread_id}`, 'MAP');
    }
    const reply = msg.reply_to_message;
    if (!map && reply && !reply.forum_topic_created) {
      map = await store.get(`TGMSG#${chat.id}#${reply.message_id}`, 'MAP');
    }
    if (!map) {
      if (isPrivate && !cmd) await send(chat.id, 'ℹ️ To answer a customer, <b>reply</b> to their ticket message.');
      return;
    }
    const project = await store.get(P(map.pid), 'META');
    if (!project || String(project.telegramChatId) !== String(chat.id)) return;
    const where = msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};

    if (cmd?.[1] === 'close' || cmd?.[1] === 'reopen') {
      const status = cmd[1] === 'close' ? 'closed' : 'open';
      // Confirm first: once a topic is closed only admins can post in it.
      await send(chat.id, `${status === 'closed' ? '✅' : '🔄'} Ticket #${map.ticket} ${status === 'closed' ? 'resolved' : 'reopened'}.`, {
        ...where,
        reply_parameters: { message_id: msg.message_id },
      }).catch(() => null);
      await setTicketStatus(project.pid, map.ticket, status);
      return;
    }
    if (cmd) return;
    if (!text.trim()) {
      if (MEDIA_KEYS.some((k) => msg[k])) {
        await send(chat.id, '⚠️ Only text replies reach the customer for now.', {
          ...where,
          reply_parameters: { message_id: msg.message_id },
        });
      }
      return; // service messages (topic created/closed, pins, joins…)
    }
    const agentName = project.agentName || msg.from?.first_name || 'Support';
    await agentReply(project, map.vid, map.ticket, text.slice(0, 4000), agentName);
    await mapTelegram(chat.id, msg.message_id, project.pid, map.vid, map.ticket);
    await tg('setMessageReaction', {
      chat_id: chat.id,
      message_id: msg.message_id,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    }).catch(() => null);
  }

  async function linkChat(chat, code) {
    const link = await store.get(`LINK#${code}`, 'LINK');
    if (!link || link.ttl < now() / 1000) {
      return send(chat.id, '⚠️ This connect link has expired. Generate a new one in the dashboard.');
    }
    let project = await store.get(P(link.pid), 'META');
    if (!project) return;
    if (project.telegramChatId && String(project.telegramChatId) !== String(chat.id)) {
      await store.del(`CHAT#${project.telegramChatId}`, `PROJECT#${project.pid}`);
    }
    const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram';
    project = await store.update(P(project.pid), 'META', {
      set: { telegramChatId: chat.id, telegramChatTitle: title, telegramChatType: chat.type },
    });
    await store.put({ pk: `CHAT#${chat.id}`, sk: `PROJECT#${project.pid}`, pid: project.pid });
    await store.del(`LINK#${code}`, 'LINK');
    project = await refreshTopics(project);
    emit(project.pid, { type: 'project' });

    let mode;
    if (chat.type === 'private') mode = 'Customer messages will appear here as tickets. <b>Reply</b> to any of them to answer.';
    else if (project.telegramTopics) mode = 'Each new ticket opens its own <b>topic</b> here. Write in a topic to answer; it closes when resolved.';
    else mode = `Customer messages will appear here as tickets. <b>Reply</b> to any of them to answer.\n\n💡 ${topicHelp}`;
    await send(chat.id, `✅ <b>${escapeHtml(project.name)}</b> is connected!\n\n${mode}\n\n/help — all commands`);
  }

  // The bot's rights changed (e.g. promoted to admin) — re-check topic support right away.
  async function onMyChatMember(update) {
    const chatId = update.chat.id;
    const projects = await projectsForChat(chatId);
    if (!projects.length) return;
    const status = update.new_chat_member?.status;
    if (status === 'left' || status === 'kicked') {
      for (const p of projects) {
        await store.del(`CHAT#${chatId}`, `PROJECT#${p.pid}`);
        await store.update(P(p.pid), 'META', {
          remove: ['telegramChatId', 'telegramChatTitle', 'telegramChatType', 'telegramTopics', 'telegramTopicsReason'],
        });
        emit(p.pid, { type: 'project' });
      }
      return;
    }
    for (const p of projects) {
      const before = Boolean(p.telegramTopics);
      const updated = await refreshTopics(p);
      emit(p.pid, { type: 'project' });
      if (!before && updated.telegramTopics) {
        await send(chatId, `🗂 Topics are on for <b>${escapeHtml(p.name)}</b> — each new ticket will get its own topic.`).catch(() => null);
      } else if (before && !updated.telegramTopics) {
        await send(chatId, `⚠️ I can no longer manage topics, so new tickets for <b>${escapeHtml(p.name)}</b> will be posted here.\n\n${topicHelp}`).catch(() => null);
      }
    }
  }

  // Enabling topics converts a basic group into a supergroup with a new id.
  async function migrateChat(oldId, newId) {
    const projects = await projectsForChat(oldId);
    for (const p of projects) {
      await store.del(`CHAT#${oldId}`, `PROJECT#${p.pid}`);
      await store.put({ pk: `CHAT#${newId}`, sk: `PROJECT#${p.pid}`, pid: p.pid });
      const updated = await store.update(P(p.pid), 'META', { set: { telegramChatId: newId, telegramChatType: 'supergroup' } });
      await refreshTopics(updated);
      emit(p.pid, { type: 'project' });
    }
  }

  async function listOpenTickets(chat, threadId) {
    const projects = await projectsForChat(chat.id);
    const lines = [];
    for (const project of projects) {
      const open = (await store.query(P(project.pid), { prefix: 'TICKET#', desc: true, limit: 200 })).filter((t) => t.status === 'open');
      lines.push(`<b>${escapeHtml(project.name)}</b> — ${open.length} open`);
      for (const t of open.slice(0, 15)) {
        const url = topicUrl(chat.id, t.topicId);
        const label = `#${t.number}`;
        lines.push(
          `  ${url ? `<a href="${url}">${label}</a>` : label} ${escapeHtml(t.name || t.email || 'Anonymous')}: ${escapeHtml((t.preview || '').slice(0, 60))}`,
        );
      }
    }
    await send(chat.id, lines.length ? lines.join('\n') : 'No projects are connected to this chat yet.', threadId ? { message_thread_id: threadId } : {});
  }

  async function onTelegramCallback(cb) {
    const [action, pid, nStr] = String(cb.data || '').split(':');
    const n = Number(nStr);
    const chatId = cb.message?.chat?.id;
    const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => null);
    const project = await store.get(P(pid), 'META');
    if (!project || String(project.telegramChatId) !== String(chatId) || !Number.isInteger(n)) return answer('Not available');
    const status = action === 'close' ? 'closed' : 'open';
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: ticketKeyboard(pid, n, status) },
    }).catch(() => null);
    await answer(status === 'closed' ? `Ticket #${n} resolved` : `Ticket #${n} reopened`);
    await setTicketStatus(pid, n, status);
  }

  // ---------- WebSocket (dashboard live updates) ----------

  async function wsConnect(connectionId, query = {}) {
    const payload = verifyJwt(query.token, jwtSecret);
    if (!payload || payload.typ !== 'ws' || !payload.pid) return false;
    const p = await store.get(P(payload.pid), 'META');
    if (!p || p.ownerId !== payload.uid) return false;
    await realtime.add(payload.pid, connectionId);
    return true;
  }

  const wsDisconnect = (connectionId) => realtime.remove(connectionId);

  // ---------- router ----------

  const authed = (fn) => async (req) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = verifyJwt(token, jwtSecret);
    if (!payload || payload.typ) throw new HttpError(401, 'Not signed in');
    const user = await store.get(`USER#${payload.uid}`, 'PROFILE');
    if (!user) throw new HttpError(401, 'Not signed in');
    return fn({ ...req, user });
  };

  const routes = [
    ['POST', '/v1/auth/signup', signup],
    ['POST', '/v1/auth/login', login],
    ['GET', '/v1/me', authed(me)],
    ['GET', '/v1/projects', authed(listProjects)],
    ['POST', '/v1/projects', authed(createProject)],
    ['GET', '/v1/projects/:id', authed(getProject)],
    ['PATCH', '/v1/projects/:id', authed(updateProject)],
    ['DELETE', '/v1/projects/:id', authed(deleteProject)],
    ['GET', '/v1/projects/:id/realtime', authed(realtimeToken)],
    ['POST', '/v1/projects/:id/telegram/link', authed(createTelegramLink)],
    ['POST', '/v1/projects/:id/telegram/check', authed(checkTelegram)],
    ['DELETE', '/v1/projects/:id/telegram', authed(disconnectTelegram)],
    ['PUT', '/v1/projects/:id/apns', authed(setApns)],
    ['DELETE', '/v1/projects/:id/apns', authed(deleteApns)],
    ['GET', '/v1/projects/:id/tickets', authed(listTickets)],
    ['GET', '/v1/projects/:id/tickets/:number', authed(getTicket)],
    ['POST', '/v1/projects/:id/tickets/:number/reply', authed(replyTicket)],
    ['POST', '/v1/projects/:id/tickets/:number/status', authed(updateTicketStatus)],
    ['GET', '/v1/client/config', clientConfig],
    ['POST', '/v1/client/messages', clientSend],
    ['GET', '/v1/client/messages', clientMessages],
    ['POST', '/v1/client/device', clientRegisterDevice],
    ['DELETE', '/v1/client/device', clientUnregisterDevice],
    ['POST', '/v1/telegram/webhook', telegramWebhook],
  ].map(([method, pattern, fn]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    return { method, re, keys, fn };
  });

  // req: { method, path, query, headers (lower-case), body (string|object) }
  async function handle(req) {
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(req.path));
      if (!route) throw new HttpError(404, 'Not found');
      const m = req.path.match(route.re);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = req.body ?? {};
      if (typeof body === 'string') {
        try {
          body = body ? JSON.parse(body) : {};
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
      }
      if (typeof body !== 'object' || body === null) body = {};
      const res = await route.fn({ ...req, params, body, query: req.query ?? {} });
      return { status: res.status ?? 200, body: res.body };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: 'Internal error' } };
    } finally {
      await flush();
    }
  }

  handle.runJob = (job) => runJob(job).finally(flush);
  handle.wsConnect = wsConnect;
  handle.wsDisconnect = wsDisconnect;
  return handle;
}
