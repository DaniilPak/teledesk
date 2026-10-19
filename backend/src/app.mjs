import { hashPassword, verifyPassword, signJwt, verifyJwt, safeEqual } from './auth.mjs';
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
 *   USER#<uid>            PROFILE                user account
 *   EMAIL#<email>         EMAIL                  email -> uid (uniqueness)
 *   PROJECT#<pid>         META                   project settings (+ gsi1pk OWNER#<uid>)
 *   PROJECT#<pid>         TICKET#<00000042>      ticket
 *   PUBKEY#<publicKey>    KEY                    public key -> pid
 *   LINK#<code>           LINK                   one-time Telegram connect code (ttl)
 *   CHAT#<chatId>         PROJECT#<pid>          projects linked to a Telegram chat
 *   VISITOR#<pid>#<vid>   STATE                  visitor profile + current open ticket
 *   CONV#<pid>#<vid>      MSG#<ts>#<rand>        conversation messages
 *   TGMSG#<chat>#<msgId>  MAP                    Telegram message -> ticket (for replies)
 */

const TICKET_SK = (n) => `TICKET#${String(n).padStart(8, '0')}`;
const LINK_TTL_S = 15 * 60;
const TGMAP_TTL_S = 180 * 24 * 3600;
const CURSOR_LOOKBACK_MS = 5000;

export function createApp({ store, telegram, config }) {
  const { jwtSecret, botUsername = 'YourSupportBot', webhookSecret, dashboardUrl = '' } = config;

  // ---------- helpers ----------

  const publicProject = (p) => ({
    id: p.pid,
    name: p.name,
    publicKey: p.publicKey,
    color: p.color,
    greeting: p.greeting,
    agentName: p.agentName,
    ticketCount: p.ticketSeq ?? 0,
    telegram: p.telegramChatId
      ? { connected: true, chatTitle: p.telegramChatTitle, chatType: p.telegramChatType }
      : { connected: false },
    createdAt: p.createdAt,
  });

  const publicTicket = (t) => ({
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
  });

  const publicMessage = (m) => ({
    id: m.sk,
    from: m.from,
    text: m.text,
    ticket: m.ticket,
    agentName: m.agentName,
    createdAt: m.createdAt,
  });

  async function ownedProject(user, pid) {
    const p = await store.get(`PROJECT#${pid}`, 'META');
    if (!p || p.ownerId !== user.uid) throw new HttpError(404, 'Project not found');
    return p;
  }

  async function projectByKey(key) {
    if (!key || typeof key !== 'string') throw new HttpError(401, 'Missing public key');
    const ref = await store.get(`PUBKEY#${key}`, 'KEY');
    if (!ref) throw new HttpError(401, 'Invalid public key');
    const p = await store.get(`PROJECT#${ref.pid}`, 'META');
    if (!p) throw new HttpError(401, 'Invalid public key');
    return p;
  }

  function visitorId(v) {
    if (!VISITOR_RE.test(String(v || ''))) throw new HttpError(400, 'Invalid visitorId');
    return v;
  }

  async function addMessage(pid, vid, { from, text, ticket, agentName }) {
    const ms = now();
    const m = {
      pk: `CONV#${pid}#${vid}`,
      sk: msgKey(ms),
      from,
      text,
      ticket,
      agentName,
      createdAt: iso(ms),
    };
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

  function describeMeta(meta) {
    if (!meta || typeof meta !== 'object') return '';
    return Object.entries(meta)
      .slice(0, 8)
      .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v).slice(0, 80))}`)
      .join(' · ');
  }

  async function notifyOwner(project, ticket, text, isNew) {
    if (!project.telegramChatId) return;
    const who = [ticket.name, ticket.email].filter(Boolean).map(escapeHtml).join(' · ') || 'Anonymous visitor';
    const header = isNew
      ? `🆕 <b>Ticket #${ticket.number}</b> · ${escapeHtml(project.name)}\n👤 ${who}` +
        (ticket.meta ? `\n📱 ${describeMeta(ticket.meta)}` : '')
      : `💬 <b>#${ticket.number}</b> · ${who}`;
    const body = `${header}\n\n${escapeHtml(text)}` + (isNew ? `\n\n<i>↩️ Reply to this message to answer.</i>` : '');
    try {
      const sent = await telegram.sendMessage(project.telegramChatId, body, {
        reply_markup: { inline_keyboard: ticketKeyboard(project.pid, ticket.number, 'open') },
      });
      await mapTelegram(project.telegramChatId, sent.message_id, project.pid, ticket.visitorId, ticket.number);
    } catch (e) {
      console.error('notifyOwner failed', e);
    }
  }

  async function setTicketStatus(pid, n, status) {
    const t = await store.get(`PROJECT#${pid}`, TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    if (t.status === status) return t;
    const updated = await store.update(`PROJECT#${pid}`, TICKET_SK(n), {
      set: { status, updatedAt: iso() },
    });
    const vKey = [`VISITOR#${pid}#${t.visitorId}`, 'STATE'];
    const v = await store.get(...vKey);
    if (status === 'closed') {
      if (v?.currentTicket === n) await store.update(...vKey, { remove: ['currentTicket'] });
      await addMessage(pid, t.visitorId, { from: 'system', text: 'This conversation was marked as resolved.', ticket: n });
    } else {
      // Reopening: if the visitor already has another open ticket, close it into this one.
      if (v?.currentTicket && v.currentTicket !== n) {
        await store.update(`PROJECT#${pid}`, TICKET_SK(v.currentTicket), { set: { status: 'closed', updatedAt: iso() } });
      }
      await store.update(...vKey, { set: { currentTicket: n } });
    }
    return updated;
  }

  async function agentReply(project, vid, n, text, agentName) {
    const t = await store.get(`PROJECT#${project.pid}`, TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    if (t.status === 'closed') await setTicketStatus(project.pid, n, 'open');
    const m = await addMessage(project.pid, vid, {
      from: 'agent',
      text,
      ticket: n,
      agentName: agentName || project.agentName || 'Support',
    });
    await store.update(`PROJECT#${project.pid}`, TICKET_SK(n), {
      set: { updatedAt: m.createdAt, lastFrom: 'agent', preview: text.slice(0, 140) },
    });
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
      pk: `PROJECT#${pid}`,
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
    const p = await store.update(`PROJECT#${params.id}`, 'META', {
      set: {
        name: str(body.name, { field: 'name', min: 1, max: 80 }),
        greeting: str(body.greeting, { field: 'greeting', max: 300 }),
        agentName: str(body.agentName, { field: 'agentName', max: 60 }),
        color,
      },
    });
    return { body: { project: publicProject(p) } };
  }

  async function deleteProject({ user, params }) {
    const p = await ownedProject(user, params.id);
    if (p.telegramChatId) await store.del(`CHAT#${p.telegramChatId}`, `PROJECT#${p.pid}`);
    await store.del(`PUBKEY#${p.publicKey}`, 'KEY');
    await store.del(`PROJECT#${p.pid}`, 'META');
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
        groupUrl: `https://t.me/${botUsername}?startgroup=${code}`,
      },
    };
  }

  async function disconnectTelegram({ user, params }) {
    const p = await ownedProject(user, params.id);
    if (p.telegramChatId) {
      await store.del(`CHAT#${p.telegramChatId}`, `PROJECT#${p.pid}`);
      await telegram
        .sendMessage(p.telegramChatId, `🔌 <b>${escapeHtml(p.name)}</b> was disconnected from this chat.`)
        .catch(() => null);
    }
    const updated = await store.update(`PROJECT#${p.pid}`, 'META', {
      remove: ['telegramChatId', 'telegramChatTitle', 'telegramChatType'],
    });
    return { body: { project: publicProject(updated) } };
  }

  // ---------- tickets (dashboard) ----------

  async function listTickets({ user, params, query }) {
    await ownedProject(user, params.id);
    let items = await store.query(`PROJECT#${params.id}`, { prefix: 'TICKET#', desc: true, limit: 200 });
    if (query.status) items = items.filter((t) => t.status === query.status);
    return { body: { tickets: items.map(publicTicket) } };
  }

  async function getTicket({ user, params }) {
    await ownedProject(user, params.id);
    const n = Number(params.number);
    const t = await store.get(`PROJECT#${params.id}`, TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    const msgs = await store.query(`CONV#${params.id}#${t.visitorId}`, { prefix: 'MSG#', limit: 500 });
    return { body: { ticket: publicTicket(t), messages: msgs.filter((m) => m.ticket === n).map(publicMessage) } };
  }

  async function replyTicket({ user, params, body }) {
    const p = await ownedProject(user, params.id);
    const n = Number(params.number);
    const text = str(body.text, { field: 'text', required: true, min: 1, max: 4000 });
    const t = await store.get(`PROJECT#${p.pid}`, TICKET_SK(n));
    if (!t) throw new HttpError(404, 'Ticket not found');
    const m = await agentReply(p, t.visitorId, n, text, user.name);
    if (p.telegramChatId) {
      await telegram
        .sendMessage(p.telegramChatId, `📤 <b>#${n}</b> answered from dashboard by ${escapeHtml(user.name)}:\n\n${escapeHtml(text)}`)
        .then((sent) => mapTelegram(p.telegramChatId, sent.message_id, p.pid, t.visitorId, n))
        .catch(() => null);
    }
    return { status: 201, body: { message: publicMessage(m) } };
  }

  async function updateTicketStatus({ user, params, body }) {
    await ownedProject(user, params.id);
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'status must be open or closed');
    const t = await setTicketStatus(params.id, Number(params.number), body.status);
    return { body: { ticket: publicTicket(t) } };
  }

  // ---------- client SDK (widget / iOS) ----------

  async function clientConfig({ query, headers }) {
    const p = await projectByKey(query.key || headers['x-teledesk-key']);
    return {
      body: {
        name: p.name,
        color: p.color,
        greeting: p.greeting,
        agentName: p.agentName,
        online: Boolean(p.telegramChatId),
      },
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
    if (visitor.currentTicket) ticket = await store.get(`PROJECT#${p.pid}`, TICKET_SK(visitor.currentTicket));
    if (!ticket || ticket.status !== 'open') {
      const updated = await store.update(`PROJECT#${p.pid}`, 'META', { add: { ticketSeq: 1 } });
      const n = updated.ticketSeq;
      ticket = {
        pk: `PROJECT#${p.pid}`,
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
      ticket = await store.update(`PROJECT#${p.pid}`, ticket.sk, {
        set: { ...profile, preview: text.slice(0, 140), lastFrom: 'visitor', updatedAt: iso() },
      });
    }

    await store.update(...vKey, { set: { ...profile, currentTicket: ticket.number, lastSeenAt: iso() } });
    const m = await addMessage(p.pid, vid, { from: 'visitor', text, ticket: ticket.number });
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

  // ---------- Telegram webhook ----------

  async function telegramWebhook({ headers, body }) {
    if (!safeEqual(headers['x-telegram-bot-api-secret-token'], webhookSecret)) throw new HttpError(401, 'Bad secret');
    try {
      if (body.message) await onTelegramMessage(body.message);
      else if (body.callback_query) await onTelegramCallback(body.callback_query);
    } catch (e) {
      // Always 200 so Telegram doesn't retry forever; log for CloudWatch.
      console.error('telegram update failed', e);
    }
    return { body: { ok: true } };
  }

  async function onTelegramMessage(msg) {
    const chat = msg.chat;
    const text = msg.text ?? '';
    const isPrivate = chat.type === 'private';
    const cmd = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]+))?$/);
    if (cmd && cmd[2] && cmd[2].toLowerCase() !== botUsername.toLowerCase()) return; // command for another bot

    if (cmd?.[1] === 'start') {
      const code = cmd[3]?.trim();
      if (!code) {
        return telegram.sendMessage(
          chat.id,
          `👋 <b>Welcome!</b>\n\nI forward messages from your app and website customers here.\n\n` +
            `1. Sign up at ${escapeHtml(dashboardUrl || 'the dashboard')}\n2. Create a project\n3. Press <b>Connect Telegram</b>`,
        );
      }
      return linkChat(chat, code);
    }
    if (cmd?.[1] === 'help') {
      return telegram.sendMessage(
        chat.id,
        `<b>How it works</b>\n• New customer messages arrive here as tickets.\n• <b>Reply</b> to a ticket message to answer the customer.\n• /tickets — list open tickets\n• /close — reply to a ticket message with /close to resolve it`,
      );
    }
    if (cmd?.[1] === 'tickets') return listOpenTickets(chat);

    const reply = msg.reply_to_message;
    if (!reply) {
      if (isPrivate)
        await telegram.sendMessage(chat.id, 'ℹ️ To answer a customer, <b>reply</b> to their ticket message.');
      return;
    }
    const map = await store.get(`TGMSG#${chat.id}#${reply.message_id}`, 'MAP');
    if (!map) return;
    const project = await store.get(`PROJECT#${map.pid}`, 'META');
    if (!project || String(project.telegramChatId) !== String(chat.id)) return;

    if (cmd?.[1] === 'close' || cmd?.[1] === 'reopen') {
      const status = cmd[1] === 'close' ? 'closed' : 'open';
      await setTicketStatus(project.pid, map.ticket, status);
      return telegram.sendMessage(chat.id, `${status === 'closed' ? '✅' : '🔄'} Ticket #${map.ticket} ${status === 'closed' ? 'closed' : 'reopened'}.`, {
        reply_parameters: { message_id: msg.message_id },
      });
    }
    if (!text.trim()) {
      return telegram.sendMessage(chat.id, '⚠️ Only text replies are supported for now.', {
        reply_parameters: { message_id: msg.message_id },
      });
    }
    const agentName = project.agentName || [msg.from?.first_name].filter(Boolean).join(' ') || 'Support';
    await agentReply(project, map.vid, map.ticket, text.slice(0, 4000), agentName);
    await mapTelegram(chat.id, msg.message_id, project.pid, map.vid, map.ticket);
    await telegram.react(chat.id, msg.message_id, '👍');
  }

  async function linkChat(chat, code) {
    const link = await store.get(`LINK#${code}`, 'LINK');
    if (!link || link.ttl < now() / 1000) {
      return telegram.sendMessage(chat.id, '⚠️ This connect link has expired. Generate a new one in the dashboard.');
    }
    const project = await store.get(`PROJECT#${link.pid}`, 'META');
    if (!project) return;
    if (project.telegramChatId && String(project.telegramChatId) !== String(chat.id)) {
      await store.del(`CHAT#${project.telegramChatId}`, `PROJECT#${project.pid}`);
    }
    await store.update(`PROJECT#${project.pid}`, 'META', {
      set: {
        telegramChatId: chat.id,
        telegramChatTitle: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram',
        telegramChatType: chat.type,
      },
    });
    await store.put({ pk: `CHAT#${chat.id}`, sk: `PROJECT#${project.pid}`, pid: project.pid });
    await store.del(`LINK#${code}`, 'LINK');
    await telegram.sendMessage(
      chat.id,
      `✅ <b>${escapeHtml(project.name)}</b> is connected!\n\nCustomer messages will appear here as tickets. <b>Reply</b> to any of them to answer.\n\n/help — all commands`,
    );
  }

  async function listOpenTickets(chat) {
    const links = await store.query(`CHAT#${chat.id}`, { prefix: 'PROJECT#' });
    const lines = [];
    for (const l of links) {
      const project = await store.get(`PROJECT#${l.pid}`, 'META');
      if (!project) continue;
      const open = (await store.query(`PROJECT#${l.pid}`, { prefix: 'TICKET#', desc: true, limit: 200 })).filter(
        (t) => t.status === 'open',
      );
      lines.push(`<b>${escapeHtml(project.name)}</b> — ${open.length} open`);
      for (const t of open.slice(0, 15)) {
        lines.push(`  #${t.number} ${escapeHtml(t.name || t.email || 'Anonymous')}: ${escapeHtml((t.preview || '').slice(0, 60))}`);
      }
    }
    await telegram.sendMessage(chat.id, lines.length ? lines.join('\n') : 'No projects are connected to this chat yet.');
  }

  async function onTelegramCallback(cb) {
    const [action, pid, nStr] = String(cb.data || '').split(':');
    const n = Number(nStr);
    const chatId = cb.message?.chat?.id;
    const project = await store.get(`PROJECT#${pid}`, 'META');
    if (!project || String(project.telegramChatId) !== String(chatId) || !Number.isInteger(n)) {
      return telegram.answerCallback(cb.id, 'Not available');
    }
    const status = action === 'close' ? 'closed' : 'open';
    await setTicketStatus(pid, n, status);
    await telegram.editKeyboard(chatId, cb.message.message_id, ticketKeyboard(pid, n, status));
    await telegram.answerCallback(cb.id, status === 'closed' ? `Ticket #${n} closed` : `Ticket #${n} reopened`);
  }

  // ---------- router ----------

  const authed = (fn) => async (req) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = verifyJwt(token, jwtSecret);
    if (!payload) throw new HttpError(401, 'Not signed in');
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
    ['POST', '/v1/projects/:id/telegram/link', authed(createTelegramLink)],
    ['DELETE', '/v1/projects/:id/telegram', authed(disconnectTelegram)],
    ['GET', '/v1/projects/:id/tickets', authed(listTickets)],
    ['GET', '/v1/projects/:id/tickets/:number', authed(getTicket)],
    ['POST', '/v1/projects/:id/tickets/:number/reply', authed(replyTicket)],
    ['POST', '/v1/projects/:id/tickets/:number/status', authed(updateTicketStatus)],
    ['GET', '/v1/client/config', clientConfig],
    ['POST', '/v1/client/messages', clientSend],
    ['GET', '/v1/client/messages', clientMessages],
    ['POST', '/v1/telegram/webhook', telegramWebhook],
  ].map(([method, pattern, fn]) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    return { method, re, keys, fn };
  });

  // req: { method, path, query, headers (lower-case), body (string|object) }
  return async function handle(req) {
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
    }
  };
}
