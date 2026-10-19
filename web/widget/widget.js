/*!
 * TeleDesk chat widget — drop-in support chat that delivers messages to your Telegram.
 * <script src="https://YOUR-CDN/widget.js" data-key="pk_..." async></script>
 * Optional: TeleDesk('identify', { name, email, meta: { plan: 'pro' } }); TeleDesk('open');
 */
(function () {
  if (window.__teledeskLoaded) return;
  window.__teledeskLoaded = true;

  var script =
    document.currentScript || document.querySelector('script[data-key][src*="widget"]');
  var KEY = script && script.getAttribute('data-key');
  var API = ((script && script.getAttribute('data-api')) || '__TELEDESK_API__').replace(/\/$/, '');
  var POSITION = (script && script.getAttribute('data-position')) || 'right';
  if (!KEY) return console.warn('[TeleDesk] missing data-key on the script tag');

  // ---------- state ----------
  var store = {
    get: function (k) {
      try { return localStorage.getItem('teledesk:' + KEY + ':' + k); } catch (e) { return null; }
    },
    set: function (k, v) {
      try { localStorage.setItem('teledesk:' + KEY + ':' + k, v); } catch (e) {}
    },
  };
  var visitorId = store.get('vid');
  if (!visitorId) {
    var bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    visitorId = 'v_' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store.set('vid', visitorId);
  }
  var identity = {};
  try { identity = JSON.parse(store.get('identity') || '{}'); } catch (e) {}
  var config = { name: 'Support', color: '#111111', greeting: 'Hi! How can we help?', online: false };
  var messages = [];
  var seen = {};
  var cursor = null;
  var isOpen = false;
  var unread = 0;
  var lastRead = store.get('lastRead') || '';
  var pollTimer = null;

  // ---------- api ----------
  function api(method, path, body) {
    var url = API + path;
    if (method === 'GET') {
      url += (path.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(KEY) + '&visitorId=' + visitorId;
    }
    return fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
    });
  }

  // ---------- ui ----------
  var host = document.createElement('div');
  host.id = 'teledesk-widget';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif}' +
    '.launcher{position:fixed;bottom:20px;' + POSITION + ':20px;width:56px;height:56px;border-radius:28px;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;transition:transform .15s;z-index:2147483646}' +
    '.launcher:hover{transform:scale(1.05)}' +
    '.launcher svg{width:24px;height:24px}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ff3b30;color:#fff;font-size:11px;font-weight:600;display:none;align-items:center;justify-content:center}' +
    '.panel{position:fixed;bottom:88px;' + POSITION + ':20px;width:360px;height:520px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px);pointer-events:none;transition:opacity .18s,transform .18s;z-index:2147483647;color:#111}' +
    '.panel.open{opacity:1;transform:none;pointer-events:auto}' +
    '@media (max-width:480px){.panel{inset:0;width:100%;height:100%;max-height:none;border-radius:0;bottom:0}}' +
    '.head{padding:16px 18px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:10px}' +
    '.title{font-size:15px;font-weight:600;flex:1}' +
    '.status{font-size:12px;color:#888;display:flex;align-items:center;gap:6px;font-weight:400;margin-top:2px}' +
    '.dot{width:7px;height:7px;border-radius:4px;background:#c7c7cc}.dot.on{background:#34c759}' +
    '.close{border:0;background:none;cursor:pointer;color:#888;font-size:22px;line-height:1;padding:4px}' +
    '.list{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px;background:#fafafa}' +
    '.msg{max-width:80%;padding:9px 13px;border-radius:16px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.msg.visitor{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}' +
    '.msg.agent{align-self:flex-start;background:#fff;border:1px solid #eee;border-bottom-left-radius:4px}' +
    '.msg.pending{opacity:.55}' +
    '.sys{align-self:center;font-size:12px;color:#999;padding:6px 0}' +
    '.who{font-size:11px;color:#999;margin:6px 4px 0}' +
    '.form{display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #e5e5e5;border-radius:12px;padding:10px 12px;font-size:14px;outline:none;max-height:120px;min-height:40px;line-height:1.4;color:#111;background:#fff}' +
    'textarea:focus{border-color:var(--c)}' +
    '.send{width:40px;height:40px;border-radius:20px;border:0;background:var(--c);color:#fff;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}' +
    '.send:disabled{opacity:.4;cursor:default}' +
    '.brand{text-align:center;font-size:10px;color:#bbb;padding:0 0 8px;background:#fff}' +
    '</style>' +
    '<button class="launcher" aria-label="Open chat">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '<span class="badge"></span></button>' +
    '<div class="panel" role="dialog" aria-label="Support chat">' +
    '<div class="head"><div class="title"><span class="name"></span><div class="status"><span class="dot"></span><span class="stext"></span></div></div>' +
    '<button class="close" aria-label="Close">×</button></div>' +
    '<div class="list"></div>' +
    '<form class="form"><textarea rows="1" placeholder="Write a message…"></textarea>' +
    '<button class="send" type="submit" aria-label="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form>' +
    '<div class="brand">Powered by TeleDesk</div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var launcher = $('.launcher'), panel = $('.panel'), list = $('.list'), input = $('textarea'), sendBtn = $('.send'), badge = $('.badge');

  function applyConfig() {
    host.style.setProperty('--c', config.color);
    $('.name').textContent = config.name;
    $('.dot').className = 'dot' + (config.online ? ' on' : '');
    $('.stext').textContent = config.online ? 'We usually reply in a few minutes' : 'Leave a message';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.textContent = '';
    if (config.greeting) list.appendChild(el('div', 'msg agent', config.greeting));
    var prevFrom = null;
    messages.forEach(function (m) {
      if (m.from === 'system') { list.appendChild(el('div', 'sys', m.text)); prevFrom = null; return; }
      if (m.from === 'agent' && prevFrom !== 'agent' && m.agentName) list.appendChild(el('div', 'who', m.agentName));
      list.appendChild(el('div', 'msg ' + m.from + (m.pending ? ' pending' : ''), m.text));
      prevFrom = m.from;
    });
    if (atBottom || isOpen) list.scrollTop = list.scrollHeight;
  }

  function updateBadge() {
    badge.style.display = unread > 0 && !isOpen ? 'flex' : 'none';
    badge.textContent = unread > 9 ? '9+' : String(unread);
  }

  function ingest(newMsgs) {
    var added = false;
    newMsgs.forEach(function (m) {
      if (seen[m.id]) return;
      seen[m.id] = true;
      messages = messages.filter(function (x) { return !(x.pending && x.from === m.from && x.text === m.text); });
      messages.push(m);
      cursor = m.id;
      added = true;
      if (m.from !== 'visitor' && m.id > lastRead && !isOpen) unread++;
    });
    if (added) { render(); updateBadge(); }
  }

  function poll() {
    return api('GET', '/v1/client/messages' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''))
      .then(function (r) { ingest(r.messages); })
      .catch(function () {});
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { poll().then(schedule); }, isOpen && !document.hidden ? 3000 : 15000);
  }

  function markRead() {
    unread = 0;
    if (cursor) { lastRead = cursor; store.set('lastRead', cursor); }
    updateBadge();
  }

  function setOpen(v) {
    isOpen = v;
    panel.classList.toggle('open', v);
    if (v) { markRead(); render(); setTimeout(function () { input.focus(); }, 50); poll(); }
    schedule();
  }

  function send(text) {
    var pending = { id: 'pending-' + Date.now(), from: 'visitor', text: text, pending: true };
    messages.push(pending);
    render();
    return api('POST', '/v1/client/messages', {
      key: KEY,
      visitorId: visitorId,
      text: text,
      name: identity.name,
      email: identity.email,
      meta: Object.assign({ page: location.pathname, platform: 'web' }, identity.meta || {}),
    })
      .then(function (r) { ingest([r.message]); })
      .catch(function (e) {
        messages = messages.filter(function (m) { return m !== pending; });
        messages.push({ id: 'err-' + Date.now(), from: 'system', text: 'Message not sent: ' + e.message });
        render();
      });
  }

  launcher.addEventListener('click', function () { setOpen(!isOpen); });
  $('.close').addEventListener('click', function () { setOpen(false); });
  input.addEventListener('input', function () {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('.form').requestSubmit(); }
  });
  $('.form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    send(text);
  });
  document.addEventListener('visibilitychange', schedule);

  // ---------- public API ----------
  function command(name, arg) {
    if (name === 'open') setOpen(true);
    else if (name === 'close') setOpen(false);
    else if (name === 'toggle') setOpen(!isOpen);
    else if (name === 'identify' && arg) {
      identity = Object.assign({}, identity, arg);
      store.set('identity', JSON.stringify(identity));
    }
  }
  var queued = (window.TeleDesk && window.TeleDesk.q) || [];
  window.TeleDesk = function (name, arg) { command(name, arg); };
  queued.forEach(function (c) { command(c[0], c[1]); });

  // ---------- boot ----------
  function mount() {
    document.body.appendChild(host);
    applyConfig();
    api('GET', '/v1/client/config')
      .then(function (c) { config = c; applyConfig(); render(); })
      .catch(function (e) { console.warn('[TeleDesk]', e.message); });
    poll().then(schedule);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
