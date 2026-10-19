(function () {
  'use strict';

  var CFG = window.TELEDESK_CONFIG || {};
  var API = (CFG.apiUrl || '').replace(/\/$/, '');
  var root = document.getElementById('root');
  var timers = [];
  var S = { me: null, projects: [], openCounts: {} };

  // ---------- icons (lucide-style paths) ----------
  var ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    chev: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    done: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  };
  var TG_SVG = '<svg viewBox="0 0 24 24"><path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.1l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.5 2.8c.9-.3 1.6.2 1.4 1.5z"/></svg>';
  function ic(name, cls) { return '<svg class="i ' + (cls || '') + '" viewBox="0 0 24 24">' + ICONS[name] + '</svg>'; }

  // ---------- utils ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }
  function initials(s) {
    var p = String(s || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  function hue(s) {
    var h = 0;
    for (var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 55% 52%)';
  }
  function clearTimers() { timers.forEach(clearInterval); timers = []; S.onLive = null; }
  function every(ms, fn) { timers.push(setInterval(fn, ms)); }
  function $(sel) { return root.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  // ---------- live updates (WebSocket) ----------
  var LIVE = { pid: null, ws: null, retry: 0, timer: null, ping: null, on: false };
  function setLiveDot() {
    var d = document.getElementById('live');
    if (d) d.className = 'live' + (LIVE.on ? ' on' : '');
    if (d) d.title = LIVE.on ? 'Live: updates appear instantly' : 'Reconnecting…';
  }
  function liveStart(pid) {
    if (LIVE.pid === pid && LIVE.ws) return setLiveDot();
    liveStop();
    LIVE.pid = pid;
    liveOpen();
  }
  function liveStop() {
    LIVE.pid = null;
    clearTimeout(LIVE.timer);
    clearInterval(LIVE.ping);
    if (LIVE.ws) { LIVE.ws.onclose = null; LIVE.ws.close(); }
    LIVE.ws = null;
    LIVE.on = false;
  }
  function liveOpen() {
    var pid = LIVE.pid;
    api('GET', '/v1/projects/' + pid + '/realtime').then(function (r) {
      if (!r.url || LIVE.pid !== pid) return;
      var ws = new WebSocket(r.url + (r.url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(r.token));
      LIVE.ws = ws;
      ws.onopen = function () {
        LIVE.on = true;
        LIVE.retry = 0;
        setLiveDot();
        clearInterval(LIVE.ping);
        LIVE.ping = setInterval(function () { if (ws.readyState === 1) ws.send('{"action":"ping"}'); }, 4 * 60 * 1000);
      };
      ws.onmessage = function (m) {
        var e;
        try { e = JSON.parse(m.data); } catch (x) { return; }
        if (e.type === 'message' && e.isNew) toast('New ticket #' + e.ticket);
        if (e.type === 'project') {
          api('GET', '/v1/projects/' + pid).then(function (x) { replaceProject(x.project); refreshSidebar(); }).catch(function () {});
        }
        if (S.onLive) S.onLive(e);
      };
      ws.onclose = function () {
        LIVE.on = false;
        LIVE.ws = null;
        clearInterval(LIVE.ping);
        setLiveDot();
        if (LIVE.pid !== pid) return;
        LIVE.timer = setTimeout(liveOpen, Math.min(30000, 1000 * Math.pow(2, LIVE.retry++)));
      };
    }).catch(function () {
      if (LIVE.pid === pid) LIVE.timer = setTimeout(liveOpen, Math.min(30000, 1000 * Math.pow(2, LIVE.retry++)));
    });
  }
  // Coalesce bursts of events into one refresh.
  function onLive(fn) {
    var t;
    S.onLive = function (e) { clearTimeout(t); t = setTimeout(function () { fn(e); }, 250); };
  }

  function api(method, path, body) {
    var headers = { 'content-type': 'application/json' };
    var tok = ls('td_token');
    if (tok) headers.authorization = 'Bearer ' + tok;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401 && path.indexOf('/v1/auth/') !== 0) {
        ls('td_token', null);
        S.me = null;
        location.hash = '#/login';
        throw new Error('Signed out');
      }
      if (r.status === 204) return {};
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
    });
  }

  function copyBtn(text, cls) {
    return '<button type="button" class="btn secondary sm ' + (cls || '') + '" data-copy="' + esc(text) + '">' + ic('copy') + 'Copy</button>';
  }
  function code(text) { return '<div class="code"><pre>' + esc(text) + '</pre>' + copyBtn(text, 'copy') + '</div>'; }
  function bindCopy() {
    $$('[data-copy]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () { toast('Copied to clipboard'); });
      };
    });
  }
  function avatar(name, color) {
    return '<span class="avatar" style="background:' + esc(color || hue(name)) + '">' + esc(initials(name)) + '</span>';
  }
  function statusBadge(s) {
    return '<span class="badge ' + (s === 'open' ? 'open' : 'closed') + '">' + (s === 'open' ? 'Open' : 'Resolved') + '</span>';
  }
  function platformOf(t) {
    var p = (t.meta && t.meta.platform) || '';
    return /ios/i.test(p) ? 'iOS' : /web/i.test(p) ? 'Web' : p || '—';
  }

  // ---------- auth ----------
  function viewAuth(mode) {
    var signup = mode === 'signup';
    var brand = '<div class="brand" style="padding:0"><span class="logo">' + ic('chat') + '</span>TeleDesk</div>';
    root.innerHTML =
      '<div class="auth">' +
      '<div class="auth-side">' + brand +
      '<div><h2>Customer support that lives in your Telegram.</h2>' +
      '<p>Drop a chat into your iOS app or website. Every message becomes a ticket in Telegram — reply right there.</p></div>' +
      '<div class="mock">' +
      '<div class="tgm"><b>🆕 Ticket #128</b> · Acme iOS<br><span style="color:#a7a7b3">👤 Jane · iOS 19.2 · app 2.4</span><br><br>Hi! I was charged twice for Pro this month.</div>' +
      '<div class="tgm reply">Sorry about that — refunded, you’ll see it in 3–5 days 🙏</div>' +
      '<div class="btnrow">✅ Close #128</div></div>' +
      '</div>' +
      '<div class="auth-main"><form class="auth-form" id="f">' + brand +
      '<h1>' + (signup ? 'Create your account' : 'Sign in') + '</h1>' +
      '<p class="sub">' + (signup ? 'Free to start. Set up in under two minutes.' : 'Welcome back. Your inbox is waiting.') + '</p>' +
      (signup ? '<div class="field"><label class="l">Name</label><input class="in" name="name" autocomplete="name" placeholder="Jane Appleseed" /></div>' : '') +
      '<div class="field"><label class="l">Email</label><input class="in" name="email" type="email" required autocomplete="email" placeholder="you@company.com" /></div>' +
      '<div class="field"><label class="l">Password</label><input class="in" name="password" type="password" required minlength="8" autocomplete="' +
      (signup ? 'new-password' : 'current-password') + '" placeholder="' + (signup ? 'At least 8 characters' : '') + '" /></div>' +
      '<div class="error" id="err"></div>' +
      '<button class="btn w100" style="padding:10px">' + (signup ? 'Create account' : 'Sign in') + '</button>' +
      '<p class="muted" style="text-align:center;margin-top:20px">' +
      (signup
        ? 'Already have an account? <a href="#/login" style="color:var(--accent);font-weight:600">Sign in</a>'
        : 'New to TeleDesk? <a href="#/signup" style="color:var(--accent);font-weight:600">Create an account</a>') +
      '</p></form></div></div>';
    $('#f').onsubmit = function (e) {
      e.preventDefault();
      var fd = Object.fromEntries(new FormData(e.target));
      $('#err').textContent = '';
      api('POST', signup ? '/v1/auth/signup' : '/v1/auth/login', fd)
        .then(function (r) { ls('td_token', r.token); S.me = null; location.hash = '#/'; })
        .catch(function (err) { $('#err').textContent = err.message; });
    };
  }

  // ---------- shell ----------
  function project(pid) { return S.projects.filter(function (p) { return p.id === pid; })[0]; }

  function shell(pid, section, html) {
    var p = project(pid);
    var nav = [
      ['overview', 'Overview', 'home'],
      ['tickets', 'Tickets', 'inbox'],
      ['install', 'Install SDK', 'code'],
      ['telegram', 'Telegram', 'send'],
      ['settings', 'Settings', 'gear'],
    ];
    var open = S.openCounts[pid];
    root.innerHTML =
      '<div class="shell" id="shell">' +
      '<aside class="sidebar">' +
      '<div class="brand"><span class="logo">' + ic('chat') + '</span>TeleDesk</div>' +
      '<div class="switcher"><button class="switcher-btn" id="sw">' + (p ? avatar(p.name, p.color) : '') +
      '<div class="grow"><div class="label">Project</div><div class="name">' + esc(p ? p.name : 'Select project') + '</div></div>' + ic('chev') + '</button>' +
      '<div class="menu" id="swm">' +
      S.projects.map(function (x) {
        return '<a href="#/p/' + esc(x.id) + '/overview">' + avatar(x.name, x.color) + '<span class="grow">' + esc(x.name) + '</span>' + (x.id === pid ? ic('check') : '') + '</a>';
      }).join('') +
      '<hr><a href="#/new">' + ic('plus') + 'New project</a></div></div>' +
      (p
        ? '<div class="nav-label">Project</div><nav class="nav">' +
          nav.map(function (n) {
            return '<a href="#/p/' + esc(pid) + '/' + n[0] + '" class="' + (n[0] === section ? 'active' : '') + '">' + ic(n[2]) + n[1] +
              (n[0] === 'tickets' && open ? '<span class="count">' + open + '</span>' : '') +
              (n[0] === 'telegram' && !p.telegram.connected ? '<span class="count" style="background:var(--warn)">!</span>' : '') + '</a>';
          }).join('') + '</nav>' +
          '<div class="live-row"><span id="live" class="live"></span><span class="muted small">Live updates</span></div>'
        : '') +
      '<div class="side-foot">' + avatar(S.me && (S.me.name || S.me.email), '#55555f') +
      '<div class="who"><div style="font-weight:600">' + esc(S.me && S.me.name) + '</div><div class="muted small">' + esc(S.me && S.me.email) + '</div></div>' +
      '<button class="icon-btn" id="logout" title="Sign out">' + ic('logout') + '</button></div>' +
      '</aside>' +
      '<div class="main"><div class="mobile-bar"><button class="icon-btn" id="burger">' + ic('menu') + '</button><span class="logo">' + ic('chat') + '</span>TeleDesk</div>' +
      '<div class="page" id="page">' + html + '</div></div></div>';

    if (p) liveStart(p.id);
    setLiveDot();
    $('#sw').onclick = function (e) { e.stopPropagation(); $('#swm').classList.toggle('open'); };
    document.onclick = function () {
      var m = $('#swm');
      if (m) m.classList.remove('open');
      var sh = $('#shell');
      if (sh) sh.classList.remove('nav-open');
    };
    $('.sidebar').addEventListener('click', function (e) { if (!e.target.closest('a')) e.stopPropagation(); });
    $('#logout').onclick = function () { liveStop(); ls('td_token', null); S.me = null; S.projects = []; location.hash = '#/login'; };
    $('#burger').onclick = function (e) { e.stopPropagation(); $('#shell').classList.toggle('nav-open'); };
  }

  function header(title, sub, actions, crumbs) {
    return '<div class="ph"><div>' + (crumbs ? '<div class="crumbs">' + crumbs + '</div>' : '') + '<h1>' + title + '</h1>' +
      (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (actions ? '<div class="row">' + actions + '</div>' : '') + '</div>';
  }

  function updateOpenCount(pid, tickets) {
    var n = tickets.filter(function (t) { return t.status === 'open'; }).length;
    S.openCounts[pid] = n;
    var link = $('.nav a[href$="/tickets"]');
    if (!link) return;
    var c = link.querySelector('.count');
    if (n && !c) link.insertAdjacentHTML('beforeend', '<span class="count">' + n + '</span>');
    else if (c && n) c.textContent = n;
    else if (c) c.remove();
  }

  // ---------- new project ----------
  function viewNew() {
    var first = !S.projects.length;
    var body =
      '<div style="max-width:520px;margin:' + (first ? '10vh' : '0') + ' auto 0">' +
      header(first ? 'Create your first project' : 'New project', 'A project is one app or website. You get a public key and a Telegram inbox for it.') +
      '<form class="card card-b" id="nf"><div class="field"><label class="l">Project name</label><input class="in" name="pname" required maxlength="80" placeholder="e.g. Acme iOS" /></div>' +
      '<div class="row"><button class="btn">' + ic('plus') + 'Create project</button>' + (first ? '' : '<a class="btn secondary" href="javascript:history.back()">Cancel</a>') + '</div></form></div>';
    if (first) root.innerHTML = '<div class="page">' + body + '</div>';
    else shell(ls('td_project'), '', body);
    $('#nf input').focus();
    $('#nf').onsubmit = function (e) {
      e.preventDefault();
      api('POST', '/v1/projects', { name: $('#nf input').value }).then(function (r) {
        S.projects.unshift(r.project);
        location.hash = '#/p/' + r.project.id + '/overview';
      }).catch(function (err) { toast(err.message); });
    };
  }

  // ---------- overview ----------
  function viewOverview(p) {
    shell(p.id, 'overview',
      header('Overview', 'How support is going for ' + esc(p.name) + '.', '<a class="btn secondary" href="#/p/' + esc(p.id) + '/install">' + ic('code') + 'Install SDK</a>') +
      '<div class="stack"><div id="setup"></div>' +
      '<div class="grid-4" id="metrics">' + [0, 1, 2, 3].map(function () {
        return '<div class="card metric"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%;height:26px;margin-top:12px"></div></div>';
      }).join('') + '</div>' +
      '<div class="card"><div class="card-h"><div><h2>New tickets</h2><p>Last 14 days</p></div></div><div class="card-b" id="chart"></div></div>' +
      '<div class="card"><div class="card-h"><div><h2>Recent tickets</h2></div><a class="btn secondary sm" href="#/p/' + esc(p.id) + '/tickets">View all ' + ic('right') + '</a></div><div id="recent"></div></div>' +
      '</div>');

    function load() {
      api('GET', '/v1/projects/' + p.id + '/tickets').then(function (r) {
        var ts = r.tickets;
        updateOpenCount(p.id, ts);
        drawSetup(p, ts);
        drawMetrics(ts);
        drawChart(ts);
        $('#recent').innerHTML = ticketTable(p, ts.slice(0, 6), true);
        bindRows();
      }).catch(function () {});
    }
    load();
    onLive(load);
    every(60000, load);
  }

  function drawSetup(p, ts) {
    var steps = [
      { done: true, t: 'Create a project', d: 'Your public key is ready.', cta: '' },
      { done: p.telegram.connected, t: 'Connect Telegram', d: 'Choose the chat or group where tickets arrive.', cta: '<a class="btn sm" href="#/p/' + esc(p.id) + '/telegram">Connect</a>' },
      { done: ts.length > 0, t: 'Add the chat to your app or website', d: 'One script tag, or one Swift package.', cta: '<a class="btn secondary sm" href="#/p/' + esc(p.id) + '/install">Get snippet</a>' },
      { done: ts.some(function (t) { return t.lastFrom === 'agent'; }), t: 'Answer your first ticket', d: 'Reply to the bot’s message in Telegram.', cta: '' },
    ];
    var n = steps.filter(function (s) { return s.done; }).length;
    if (n === steps.length) { $('#setup').innerHTML = ''; return; }
    $('#setup').innerHTML =
      '<div class="card"><div class="card-h"><div><h2>Get started</h2><p>' + n + ' of ' + steps.length + ' complete</p></div>' +
      '<div class="progress"><div style="width:' + (n / steps.length) * 100 + '%"></div></div></div>' +
      steps.map(function (s, i) {
        return '<div class="check' + (s.done ? ' done' : '') + '"><span class="tick' + (s.done ? ' done' : '') + '">' + (s.done ? ic('check') : i + 1) + '</span>' +
          '<div class="grow"><div class="t" style="font-weight:600">' + s.t + '</div><div class="muted small">' + s.d + '</div></div>' + (s.done ? '' : s.cta) + '</div>';
      }).join('') + '</div>';
  }

  function drawMetrics(ts) {
    var now = Date.now(), d7 = now - 7 * 864e5, d14 = now - 14 * 864e5, d30 = now - 30 * 864e5;
    var t = function (x) { return new Date(x).getTime(); };
    var open = ts.filter(function (x) { return x.status === 'open'; }).length;
    var new7 = ts.filter(function (x) { return t(x.createdAt) >= d7; }).length;
    var prev7 = ts.filter(function (x) { return t(x.createdAt) >= d14 && t(x.createdAt) < d7; }).length;
    var res7 = ts.filter(function (x) { return x.status === 'closed' && t(x.updatedAt) >= d7; }).length;
    var cust = {};
    ts.forEach(function (x) { if (t(x.updatedAt) >= d30) cust[x.visitorId] = 1; });
    var delta = prev7 ? Math.round(((new7 - prev7) / prev7) * 100) : null;
    var waiting = ts.filter(function (x) { return x.status === 'open' && x.lastFrom === 'visitor'; }).length;
    var cards = [
      ['inbox', 'Open tickets', open, waiting ? '<span class="down">' + waiting + ' waiting for reply</span>' : '<span class="up">All caught up</span>'],
      ['plus', 'New tickets', new7, delta === null ? 'Last 7 days' : '<span class="' + (delta > 0 ? 'down' : 'up') + '">' + (delta > 0 ? '+' : '') + delta + '%</span> vs prior 7 days'],
      ['done', 'Resolved', res7, 'Last 7 days'],
      ['users', 'Customers', Object.keys(cust).length, 'Active in last 30 days'],
    ];
    $('#metrics').innerHTML = cards.map(function (c) {
      return '<div class="card metric"><div class="k">' + ic(c[0]) + c[1] + '</div><div class="v">' + c[2] + '</div><div class="d">' + c[3] + '</div></div>';
    }).join('');
  }

  function drawChart(ts) {
    var days = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({ d: d, n: 0 });
    }
    ts.forEach(function (x) {
      var c = new Date(x.createdAt);
      c.setHours(0, 0, 0, 0);
      days.forEach(function (day) { if (day.d.getTime() === c.getTime()) day.n++; });
    });
    var max = Math.max(4, Math.max.apply(null, days.map(function (x) { return x.n; })));
    var W = 1000, H = 220, pl = 28, pb = 24, cw = (W - pl) / days.length;
    var fmt = function (d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    var g = '';
    [0, 0.5, 1].forEach(function (f) {
      var y = (H - pb) * (1 - f) + 4;
      g += '<line class="grid" x1="' + pl + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/><text x="0" y="' + (y + 4) + '">' + Math.round(max * f) + '</text>';
    });
    days.forEach(function (x, i) {
      var h = ((H - pb - 4) * x.n) / max;
      var bx = pl + i * cw + cw * 0.22;
      g += '<rect class="bar" rx="4" x="' + bx + '" y="' + (H - pb - h) + '" width="' + cw * 0.56 + '" height="' + h + '"><title>' + fmt(x.d) + ': ' + x.n + ' tickets</title></rect>';
      if (i % 2 === 0) g += '<text x="' + (bx + cw * 0.28) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmt(x.d) + '</text>';
    });
    $('#chart').innerHTML = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + g + '</svg>';
  }

  // ---------- tickets ----------
  function ticketTable(p, ts, compact) {
    if (!ts.length) {
      return '<div class="empty"><div class="big">' + ic('inbox') + '</div><div style="font-weight:600;color:var(--text)">No tickets here</div>' +
        '<div>Messages from your customers will appear here and in Telegram.</div></div>';
    }
    return '<div class="table-wrap"><table class="table"><thead><tr><th>Ticket</th><th>Customer</th><th>Last message</th>' +
      (compact ? '' : '<th class="hide-sm">Platform</th>') + '<th class="hide-sm">Updated</th><th>Status</th></tr></thead><tbody>' +
      ts.map(function (t) {
        var who = t.name || t.email || 'Anonymous';
        return '<tr data-href="#/p/' + esc(p.id) + '/tickets/' + t.number + '"><td class="mono">#' + t.number + '</td>' +
          '<td><div class="cust">' + avatar(who) + '<div style="min-width:0"><div class="n">' + esc(who) + '</div>' +
          (t.email && t.name ? '<div class="e">' + esc(t.email) + '</div>' : '') + '</div></div></td>' +
          '<td><div class="clip">' + (t.lastFrom === 'agent' ? '<span class="muted">You: </span>' : '') + esc(t.preview) + '</div></td>' +
          (compact ? '' : '<td class="hide-sm">' + esc(platformOf(t)) + '</td>') +
          '<td class="hide-sm muted">' + ago(t.updatedAt) + '</td><td>' + statusBadge(t.status) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function bindRows() {
    $$('tr[data-href]').forEach(function (tr) { tr.onclick = function () { location.hash = tr.getAttribute('data-href'); }; });
  }

  function viewTickets(p) {
    var filter = ls('td_filter') || 'open';
    var q = '';
    var all = [];
    shell(p.id, 'tickets',
      header('Tickets', 'Every conversation from your app and website.') +
      '<div class="card"><div class="card-h"><div class="seg" id="seg">' +
      [['open', 'Open'], ['closed', 'Resolved'], ['all', 'All']].map(function (f) {
        return '<button data-f="' + f[0] + '" class="' + (f[0] === filter ? 'on' : '') + '">' + f[1] + ' <span class="muted" data-c="' + f[0] + '"></span></button>';
      }).join('') +
      '</div><div class="search">' + ic('search') + '<input class="in" id="q" placeholder="Search customers or messages" /></div></div>' +
      '<div id="tl"><div class="card-b"><div class="skeleton"></div></div></div></div>');

    function draw() {
      var list = all.filter(function (t) { return filter === 'all' || t.status === filter; }).filter(function (t) {
        return !q || [t.name, t.email, t.preview, '#' + t.number].join(' ').toLowerCase().indexOf(q) >= 0;
      });
      ['open', 'closed', 'all'].forEach(function (f) {
        $('[data-c="' + f + '"]').textContent = all.filter(function (t) { return f === 'all' || t.status === f; }).length;
      });
      $('#tl').innerHTML = ticketTable(p, list);
      bindRows();
    }
    $$('#seg button').forEach(function (b) {
      b.onclick = function () {
        filter = b.getAttribute('data-f');
        ls('td_filter', filter);
        $$('#seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        draw();
      };
    });
    $('#q').oninput = function (e) { q = e.target.value.trim().toLowerCase(); draw(); };
    function load() {
      api('GET', '/v1/projects/' + p.id + '/tickets').then(function (r) { all = r.tickets; updateOpenCount(p.id, all); draw(); }).catch(function () {});
    }
    load();
    onLive(load);
    every(60000, load);
  }

  function viewTicket(p, n) {
    shell(p.id, 'tickets', '<div id="tk"><div class="skeleton" style="width:200px;height:24px"></div></div>');
    var lastSig = '';
    function load() {
      api('GET', '/v1/projects/' + p.id + '/tickets/' + n).then(function (r) {
        var t = r.ticket;
        var who = t.name || t.email || 'Anonymous visitor';
        if (!$('#convo')) {
          $('#tk').innerHTML =
            header('Ticket #' + t.number, '', '<span id="sb"></span><span id="tgl"></span><button class="btn secondary" id="st"></button>',
              '<a href="#/p/' + esc(p.id) + '/tickets">Tickets</a>' + ic('right') + '<span>#' + t.number + '</span>') +
            '<div class="grid-2"><div class="card" style="overflow:hidden"><div class="convo" id="convo"></div>' +
            '<form class="composer" id="rf"><textarea class="in grow" name="text" rows="1" placeholder="Reply to ' + esc(who) + '…"></textarea>' +
            '<button class="btn">' + ic('send') + 'Send</button></form></div>' +
            '<div class="stack"><div class="card"><div class="card-b"><div class="cust" style="margin-bottom:16px">' + avatar(who) +
            '<div><div class="n">' + esc(who) + '</div><div class="e">Customer</div></div></div><dl class="kv" id="kv"></dl></div></div>' +
            '<div class="card card-b small muted">' + TG_SVG.replace('<svg', '<svg style="width:14px;height:14px;fill:#2aabee;vertical-align:-2px;margin-right:6px"') +
            'Replies sent here are also posted to your Telegram chat.</div></div></div>';
          var ta = $('#rf textarea');
          ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
          ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#rf').requestSubmit(); });
          $('#rf').onsubmit = function (e) {
            e.preventDefault();
            var text = ta.value.trim();
            if (!text) return;
            api('POST', '/v1/projects/' + p.id + '/tickets/' + n + '/reply', { text: text })
              .then(function () { ta.value = ''; ta.style.height = 'auto'; load(); })
              .catch(function (err) { toast(err.message); });
          };
        }
        $('#sb').innerHTML = statusBadge(t.status);
        $('#tgl').innerHTML = t.telegramUrl
          ? '<a class="btn secondary" target="_blank" rel="noopener" href="' + esc(t.telegramUrl) + '">' + TG_SVG.replace('<svg', '<svg style="width:14px;height:14px;fill:#2aabee"') + 'Open topic</a>'
          : '';
        var st = $('#st');
        st.innerHTML = t.status === 'open' ? ic('check') + 'Mark resolved' : 'Reopen';
        st.onclick = function () {
          api('POST', '/v1/projects/' + p.id + '/tickets/' + n + '/status', { status: t.status === 'open' ? 'closed' : 'open' })
            .then(function () { toast(t.status === 'open' ? 'Ticket resolved' : 'Ticket reopened'); load(); });
        };
        var rows = [['Email', esc(t.email || '—')], ['Opened', esc(new Date(t.createdAt).toLocaleString())], ['Updated', esc(ago(t.updatedAt))]];
        Object.keys(t.meta || {}).forEach(function (k) { rows.push([k.charAt(0).toUpperCase() + k.slice(1), esc(t.meta[k])]); });
        rows.push(['Visitor ID', '<span class="mono">' + esc(t.visitorId.slice(0, 14)) + '…</span>']);
        $('#kv').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('');
        var sig = r.messages.map(function (m) { return m.id; }).join();
        if (sig !== lastSig) {
          lastSig = sig;
          $('#convo').innerHTML = r.messages.map(function (m) {
            if (m.from === 'system') return '<div class="sys">' + esc(m.text) + '</div>';
            return '<div class="msg ' + esc(m.from) + '">' + esc(m.text) + '</div><div class="msg-meta' + (m.from === 'agent' ? ' r' : '') + '">' +
              (m.from === 'agent' ? esc(m.agentName || 'Support') : esc(who)) + ' · ' + ago(m.createdAt) + '</div>';
          }).join('');
          $('#convo').scrollTop = $('#convo').scrollHeight;
        }
      }).catch(function (e) { $('#tk').innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
    }
    load();
    onLive(function (e) { if (e.type !== 'message' || String(e.ticket) === String(n)) load(); });
    every(30000, load);
  }

  // ---------- install ----------
  function viewInstall(p) {
    var platform = ls('td_platform') || 'ios';
    var iosOpt = ls('td_iosopt') || 'floating';
    var widgetUrl = CFG.widgetUrl || location.origin + '/widget.js';
    shell(p.id, 'install',
      header('Install SDK', 'Add the support chat to your product. Takes about a minute.') +
      '<div class="stack"><div class="card"><div class="card-h"><div><h2>Credentials</h2><p>The public key is safe to ship inside your app or page.</p></div></div>' +
      '<div class="card-b grid-2" style="grid-template-columns:1fr 1fr">' +
      '<div><label class="l">Public key</label><div class="copy-field"><span class="mono">' + esc(p.publicKey) + '</span>' + copyBtn(p.publicKey) + '</div></div>' +
      '<div><label class="l">API URL</label><div class="copy-field"><span class="mono">' + esc(API) + '</span>' + copyBtn(API) + '</div></div></div></div>' +
      '<div class="platforms">' +
      '<button class="platform" data-p="ios"><span class="pi">' + ic('phone') + '</span><span><b>iOS</b><span class="muted small">Swift Package · SwiftUI & UIKit</span></span></button>' +
      '<button class="platform" data-p="web"><span class="pi">' + ic('globe') + '</span><span><b>Website</b><span class="muted small">One script tag · any framework</span></span></button>' +
      '</div><div class="card" id="ai"></div><div class="card card-b" id="guide"></div></div>');

    var cfgCode = 'import TeleDesk\n\n// In your App init or application(_:didFinishLaunchingWithOptions:)\nTeleDesk.configure(\n    publicKey: "' + p.publicKey +
      '",\n    apiURL: URL(string: "' + API + '")!\n)\n\n// Optional: who is writing (shown in Telegram)\nTeleDesk.identify(name: user.name, email: user.email, meta: ["plan": "pro"])';
    var opts = {
      floating: ['Floating button', 'Bubble over any screen', '// SwiftUI — attach to your root view\nContentView()\n    .teleDeskFloatingButton()\n\n// UIKit — after the window is visible\nTeleDesk.showFloatingButton()'],
      settings: ['Settings row', 'A row in your Settings screen', 'Form {\n    Section("Help") {\n        TeleDeskSupportRow()   // pushes the chat, shows unread badge\n    }\n}'],
      button: ['Your own button', 'Open it from anywhere', '// SwiftUI\nTeleDeskButton("Contact support")\n    .buttonStyle(.borderedProminent)\n\n// UIKit\n@objc func helpTapped() {\n    TeleDesk.present(from: self)\n}'],
    };

    function aiPrompt() {
      if (platform === 'ios') {
        var entry = {
          floating: 'Add a floating support chat button over the main UI: in SwiftUI attach `.teleDeskFloatingButton()` to the root view; in UIKit call `TeleDesk.showFloatingButton()` once the key window is visible.',
          settings: 'Add a "Contact support" row to the app\'s existing Settings/Profile screen using `TeleDeskSupportRow()` (it pushes the chat inside a NavigationStack; use `TeleDeskSupportRow(presentation: .sheet)` if that screen has no NavigationStack). If the app is UIKit, add a row/cell whose tap calls `TeleDesk.present(from: self)`.',
          button: 'Add a "Contact support" button where it fits best (e.g. help or settings screen) using `TeleDeskButton("Contact support")` in SwiftUI, or `TeleDesk.present(from: self)` from a UIKit button action.',
        }[iosOpt];
        return [
          'Integrate the TeleDesk support chat SDK into this iOS app. Customer messages from the chat are delivered to the developer\'s Telegram as support tickets.',
          '',
          '## 1. Add the Swift package',
          '- Repository: https://github.com/DaniilPak/teledesk',
          '- Version rule: "Up to Next Major" from 0.2.0. Library product: `TeleDesk`. Minimum iOS 16.',
          '- If the app is an Xcode project, add the package dependency to the .xcodeproj (Package Dependencies) and link the `TeleDesk` product to the main app target. If it uses a Package.swift / Tuist / XcodeGen, add it there instead.',
          '',
          '## 2. Configure once at launch',
          'Find the app entry point (the `@main` App struct init, or `application(_:didFinishLaunchingWithOptions:)`) and add:',
          '```swift',
          'import TeleDesk',
          '',
          'TeleDesk.configure(',
          '    publicKey: "' + p.publicKey + '",',
          '    apiURL: URL(string: "' + API + '")!',
          ')',
          '```',
          '',
          '## 3. Identify the signed-in user (if the app has accounts)',
          'Wherever the current user becomes known (after login / session restore), call:',
          '```swift',
          'TeleDesk.identify(name: user.displayName, email: user.email, meta: ["userId": user.id])',
          '```',
          'Use the app\'s real user model fields; skip fields that don\'t exist. On logout call `TeleDesk.reset()`.',
          '',
          '## 4. Show the chat',
          entry,
          '',
          '## 5. Push notifications for support replies',
          'So customers get a notification when support answers, even with the app closed:',
          '- Add the **Push Notifications** capability to the app target (Signing & Capabilities). If the app has no AppDelegate, add one via `@UIApplicationDelegateAdaptor`.',
          '- In `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` call `TeleDesk.setDeviceToken(deviceToken)` (keep any existing push code there).',
          '- Notification delegate: if the app has no `UNUserNotificationCenter` delegate, set `UNUserNotificationCenter.current().delegate = TeleDesk.notificationDelegate` in `didFinishLaunching`. If it already has one, forward to TeleDesk instead: in `willPresent` use `TeleDesk.presentationOptions(for: notification)` when it returns non-nil, and in `didReceive` call `TeleDesk.handleNotificationResponse(response)` first.',
          '- Call `await TeleDesk.requestPushAuthorization()` at a natural moment (for example when the support chat is first opened), not on first launch, unless the app already asks for notifications — then just make sure `registerForRemoteNotifications()` runs.',
          '' + (p.apns.configured ? '- Push is already configured on the server for bundle ID `' + p.apns.bundleId + '` — check that it matches this app.' : '- Remind me to upload an APNs key (.p8) in the TeleDesk dashboard → Settings → iOS push notifications; pushes stay off until then.'),
          '',
          '## Rules',
          '- Use only these public APIs: `TeleDesk.configure`, `TeleDesk.identify`, `TeleDesk.reset`, `TeleDeskChatView`, `.teleDeskFloatingButton()`, `TeleDeskSupportRow`, `TeleDeskButton`, `TeleDesk.present(from:)`, `TeleDesk.showFloatingButton()`, `TeleDesk.makeViewController()`, `TeleDesk.setDeviceToken`, `TeleDesk.requestPushAuthorization`, `TeleDesk.notificationDelegate`, `TeleDesk.presentationOptions(for:)`, `TeleDesk.handleNotificationResponse`.',
          '- The public key is meant to ship in the app; it is not a secret. Do not add other keys or tokens.',
          '- Match the existing code style; keep the change minimal.',
          '- Build the app to confirm it compiles, then tell me where you placed the entry point.',
        ].join('\n');
      }
      return [
        'Integrate the TeleDesk support chat widget into this website. Visitor messages are delivered to the site owner\'s Telegram as support tickets.',
        '',
        '## 1. Load the widget on every page',
        'Add this tag once so it renders on all pages (root layout / base template / `index.html` / `_document` / `app.html` — whatever this project uses), right before `</body>`:',
        '```html',
        '<script src="' + widgetUrl + '" data-key="' + p.publicKey + '" async></script>',
        '```',
        'For Next.js use `next/script` with `strategy="afterInteractive"` and the same `src` and `data-key`. For other frameworks, use their equivalent of a global script in the root layout.',
        '',
        '## 2. Identify the signed-in user (if the site has accounts)',
        'Where the current user is available on the client, run:',
        '```js',
        'window.TeleDesk = window.TeleDesk || function () { (TeleDesk.q = TeleDesk.q || []).push(arguments) };',
        "TeleDesk('identify', { name: user.name, email: user.email, meta: { userId: user.id } });",
        '```',
        'Use the real user fields; skip ones that don\'t exist. This stub is safe to call before the widget loads.',
        '',
        '## 3. Optional: open from existing "Contact" / "Help" links',
        "If the site has a contact or help link, make it call `TeleDesk('open')` (also available: `'close'`, `'toggle'`).",
        '',
        '## Rules',
        '- The `data-key` is a public key meant for the browser; it is not a secret.',
        '- If the site sends a Content-Security-Policy, allow `' + new URL(widgetUrl).origin + '` in script-src and `' + (API ? new URL(API).origin : '') + '` in connect-src.',
        '- Keep the change minimal and match the project\'s conventions. Tell me which files you changed.',
      ].join('\n');
    }

    function drawAi() {
      var text = aiPrompt();
      $('#ai').innerHTML = '<div class="card-h"><div><h2>Install with an AI agent</h2><p>Paste into Claude Code, Cursor, Codex or any coding agent working in your ' +
        (platform === 'ios' ? 'Xcode project' : 'website repo') + '. Your public key is already filled in.</p></div>' +
        '<button type="button" class="btn" data-copy="' + esc(text) + '">' + ic('copy') + 'Copy prompt</button></div>' +
        '<details class="ai-preview"><summary>Show prompt</summary><pre>' + esc(text) + '</pre></details>';
    }

    function draw() {
      $$('.platform').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-p') === platform); });
      drawAi();
      if (platform === 'ios') {
        $('#guide').innerHTML = '<div class="steps">' +
          '<div class="st"><h3>Add the Swift package</h3><p>Xcode → File → Add Package Dependencies…</p>' + code('https://github.com/DaniilPak/teledesk') + '</div>' +
          '<div class="st"><h3>Configure at launch</h3><p>Call once, before showing the chat.</p>' + code(cfgCode) + '</div>' +
          '<div class="st"><h3>Show the chat</h3><p>Pick how customers reach you — you can combine them.</p><div class="options">' +
          Object.keys(opts).map(function (k) {
            return '<button class="opt' + (k === iosOpt ? ' on' : '') + '" data-o="' + k + '"><b>' + opts[k][0] + '</b><span>' + opts[k][1] + '</span></button>';
          }).join('') +
          '</div>' + code(opts[iosOpt][2]) + '</div>' +
          '<div class="st"><h3>Push notifications <span class="muted" style="font-weight:400">— optional</span></h3><p>Customers get a notification when you answer, even with the app closed. Add the Push Notifications capability, ' +
          (p.apns.configured ? 'then:' : 'upload your APNs key in <a href="#/p/' + esc(p.id) + '/settings" style="color:var(--accent)">Settings</a>, then:') + '</p>' +
          code('// AppDelegate (SwiftUI: @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate)\nfunc application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {\n    UNUserNotificationCenter.current().delegate = TeleDesk.notificationDelegate\n    return true\n}\n\nfunc application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {\n    TeleDesk.setDeviceToken(deviceToken)\n}\n\n// When it makes sense, e.g. when the chat opens\nawait TeleDesk.requestPushAuthorization()') + '</div>' +
          '<div class="st"><h3>Send a test message</h3><p>Run the app, open the chat and say hi. It shows up in Telegram and on the <a href="#/p/' + esc(p.id) +
          '/tickets" style="color:var(--accent)">Tickets</a> page.</p></div></div>';
      } else {
        $('#guide').innerHTML = '<div class="steps">' +
          '<div class="st"><h3>Paste the snippet</h3><p>Before <code>&lt;/body&gt;</code> on every page where the chat should appear.</p>' +
          code('<script src="' + widgetUrl + '" data-key="' + p.publicKey + '" async></script>') + '</div>' +
          '<div class="st"><h3>Identify customers <span class="muted" style="font-weight:400">— optional</span></h3><p>Shown with each ticket in Telegram.</p>' +
          code("<script>\n  window.TeleDesk = window.TeleDesk || function () { (TeleDesk.q = TeleDesk.q || []).push(arguments) };\n  TeleDesk('identify', { name: 'Jane', email: 'jane@example.com', meta: { plan: 'pro' } });\n</script>") + '</div>' +
          '<div class="st"><h3>Open from your own button <span class="muted" style="font-weight:400">— optional</span></h3><p>Use <code>open</code>, <code>close</code> or <code>toggle</code>. Add <code>data-position="left"</code> to move the bubble.</p>' +
          code('<button onclick="TeleDesk(\'open\')">Contact support</button>') + '</div>' +
          '<div class="st"><h3>Send a test message</h3><p>Open your site, click the bubble and say hi.</p></div></div>';
      }
      $$('.opt').forEach(function (b) { b.onclick = function () { iosOpt = b.getAttribute('data-o'); ls('td_iosopt', iosOpt); draw(); }; });
      bindCopy();
    }
    $$('.platform').forEach(function (b) { b.onclick = function () { platform = b.getAttribute('data-p'); ls('td_platform', platform); draw(); }; });
    draw();
  }

  // ---------- telegram ----------
  function viewTelegram(p) {
    var c = p.telegram.connected;
    shell(p.id, 'telegram',
      header('Telegram', 'Where new tickets are delivered and where you answer them.') +
      '<div class="stack"><div class="card"><div class="card-b"><div class="tg-hero"><span class="tg-icon">' + TG_SVG + '</span><div class="grow">' +
      (c
        ? '<div class="row"><b style="font-size:15px">' + esc(p.telegram.chatTitle) + '</b><span class="badge ok">Connected</span></div><div class="muted">' +
          (p.telegram.chatType === 'private' ? 'Private chat with @' : 'Group · via @') + esc(CFG.botUsername || 'bot') + '</div>'
        : '<div class="row"><b style="font-size:15px">Not connected</b><span class="badge off">Off</span></div>' +
          '<div class="muted">Tickets are saved, but you won’t be notified until you connect a chat.</div>') +
      '</div><div class="row">' +
      (c
        ? '<button class="btn secondary" id="link">Move to another chat</button><button class="btn danger" id="unlink">Disconnect</button>'
        : '<button class="btn" id="link">' + ic('send') + 'Connect Telegram</button>') +
      '</div></div><div id="linkbox"></div></div></div>' +
      (c ? layoutCard(p) : '') +
      '<div class="grid-2" style="grid-template-columns:1fr 1fr"><div class="card"><div class="card-h"><h2>How answering works</h2></div><div class="card-b"><ul class="list-plain">' +
      (c && p.telegram.topics
        ? '<li><span class="tick">1</span><div>A customer writes → a new topic <b>🟢 #N · Name</b> opens with their details.</div></li>' +
          '<li><span class="tick">2</span><div><b>Write in the topic</b> — no need to reply. Every message there reaches the customer within seconds.</div></li>' +
          '<li><span class="tick">3</span><div>Tap <b>✅ Close</b> or send <span class="kbd">/close</span> when solved — the topic is ' + (p.telegram.topicOnResolve === 'delete' ? 'deleted' : 'renamed ✅ and closed') + '.</div></li>'
        : '<li><span class="tick">1</span><div>A customer writes → the bot posts <b>🆕 Ticket #N</b> with their details.</div></li>' +
          '<li><span class="tick">2</span><div><b>Reply</b> to that message (swipe left on mobile). The customer sees it in the chat within seconds.</div></li>' +
          '<li><span class="tick">3</span><div>Tap <b>✅ Close</b> when solved. Their next message opens a new ticket.</div></li>') +
      '</ul></div></div>' +
      '<div class="card"><div class="card-h"><h2>Bot commands</h2></div><div class="card-b"><ul class="list-plain">' +
      '<li><span class="kbd">/tickets</span><span class="muted">List open tickets</span></li>' +
      '<li><span class="kbd">/close</span><span class="muted">Resolve — in a ticket topic, or as a reply</span></li>' +
      '<li><span class="kbd">/reopen</span><span class="muted">Reopen — in a ticket topic, or as a reply</span></li>' +
      '<li><span class="kbd">/help</span><span class="muted">Show help</span></li></ul></div></div></div></div>');

    $('#link').onclick = function () {
      api('POST', '/v1/projects/' + p.id + '/telegram/link').then(function (r) {
        $('#linkbox').innerHTML = '<div style="border-top:1px solid var(--line);margin-top:20px;padding-top:20px">' +
          '<div class="platforms"><a class="platform" target="_blank" rel="noopener" href="' + esc(r.privateUrl) + '"><span class="pi">' + ic('chat') +
          '</span><span class="grow"><b>Private chat</b><span class="muted small">Just you</span></span>' + ic('ext') + '</a>' +
          '<a class="platform" target="_blank" rel="noopener" href="' + esc(r.groupUrl) + '"><span class="pi">' + ic('users') +
          '</span><span class="grow"><b>Team group</b><span class="muted small">Everyone in the group can answer</span></span>' + ic('ext') + '</a></div>' +
          '<div class="row muted small" style="margin-top:14px"><span class="pulse"></span>Waiting for you to press <b>Start</b> in Telegram… The link expires in 15 minutes.</div></div>';
        var before = JSON.stringify(p.telegram);
        clearTimers();
        every(2500, function () {
          api('GET', '/v1/projects/' + p.id).then(function (x) {
            if (x.project.telegram.connected && JSON.stringify(x.project.telegram) !== before) {
              clearTimers();
              replaceProject(x.project);
              toast('Telegram connected');
              viewTelegram(x.project);
            }
          });
        });
      }).catch(function (e) { toast(e.message); });
    };
    if ($('#unlink')) {
      $('#unlink').onclick = function () {
        if (!confirm('Stop delivering tickets to Telegram?')) return;
        api('DELETE', '/v1/projects/' + p.id + '/telegram').then(function (r) { replaceProject(r.project); viewTelegram(r.project); });
      };
    }
    if ($('#recheck')) {
      $('#recheck').onclick = function () {
        $('#recheck').disabled = true;
        api('POST', '/v1/projects/' + p.id + '/telegram/check').then(function (r) {
          replaceProject(r.project);
          toast(r.project.telegram.topics ? 'Topics are on' : 'Topics still unavailable');
          viewTelegram(r.project);
        }).catch(function (e) { toast(e.message); $('#recheck').disabled = false; });
      };
    }
    $$('[name="resolve"]').forEach(function (r) {
      r.onchange = function () {
        api('PATCH', '/v1/projects/' + p.id, { topicOnResolve: r.value }).then(function (x) { replaceProject(x.project); toast('Saved'); viewTelegram(x.project); });
      };
    });
    onLive(function (e) {
      if (e.type !== 'project' || $('#linkbox').innerHTML) return;
      api('GET', '/v1/projects/' + p.id).then(function (x) { replaceProject(x.project); viewTelegram(x.project); });
    });
  }

  function layoutCard(p) {
    var t = p.telegram;
    if (t.chatType === 'private') {
      return '<div class="card"><div class="card-h"><div><h2>Ticket layout</h2><p>Private chat — tickets arrive as messages, reply to answer.</p></div><span class="badge off">Messages</span></div>' +
        '<div class="card-b muted">Handling many customers or working as a team? Connect a <b>group with Topics</b> instead — every ticket gets its own topic, and resolved ones are closed out of the way. Use <b>Move to another chat → Team group</b>.</div></div>';
    }
    if (t.topics) {
      return '<div class="card"><div class="card-h"><div><h2>Ticket layout</h2><p>One topic per ticket. Open tickets show 🟢, resolved ones ✅.</p></div><span class="badge ok">Topics on</span></div>' +
        '<div class="card-b"><label class="l">When a ticket is resolved</label><div class="seg">' +
        '<label class="segopt"><input type="radio" name="resolve" value="close"' + (t.topicOnResolve !== 'delete' ? ' checked' : '') + '><span>Close topic (keep history)</span></label>' +
        '<label class="segopt"><input type="radio" name="resolve" value="delete"' + (t.topicOnResolve === 'delete' ? ' checked' : '') + '><span>Delete topic</span></label>' +
        '</div><div class="hint">History is always kept on the Tickets page, whichever you choose.</div></div></div>';
    }
    var why = t.topicsReason === 'not_forum'
      ? 'Topics are turned off in this group.'
      : t.topicsReason === 'no_rights'
        ? 'Topics are on, but the bot isn’t an admin with the “Manage topics” right.'
        : 'The bot couldn’t confirm it can manage topics here.';
    return '<div class="card"><div class="card-h"><div><h2>Ticket layout</h2><p>' + why + ' Tickets are posted as messages for now.</p></div><span class="badge open">Messages</span></div>' +
      '<div class="card-b"><ol class="howto">' +
      '<li>In Telegram, open <b>' + esc(t.chatTitle) + '</b> → group info → <b>Edit</b> → turn on <b>Topics</b>.</li>' +
      '<li><b>Administrators</b> → add <b>@' + esc(CFG.botUsername || 'the bot') + '</b> → enable <b>Manage topics</b> → Save.</li>' +
      '<li>Come back here — it switches automatically, or press the button.</li></ol>' +
      '<button class="btn secondary" id="recheck">Check again</button></div></div>';
  }

  // ---------- settings ----------
  function viewSettings(p) {
    shell(p.id, 'settings',
      header('Settings', 'How the chat looks to your customers.') +
      '<div class="stack"><div class="grid-2"><form class="card" id="sf"><div class="card-h"><h2>General</h2></div><div class="card-b">' +
      '<div class="field"><label class="l">Project name</label><input class="in" name="name" value="' + esc(p.name) + '" /></div>' +
      '<div class="field"><label class="l">Greeting</label><input class="in" name="greeting" value="' + esc(p.greeting) + '" /><div class="hint">First message customers see when they open the chat.</div></div>' +
      '<div class="field"><label class="l">Agent name</label><input class="in" name="agentName" value="' + esc(p.agentName) + '" /><div class="hint">Shown above your replies, e.g. “Support” or “Dan from Acme”.</div></div>' +
      '<div class="field"><label class="l">Brand color</label><div class="color-in"><input type="color" name="color" value="' + esc(p.color) + '" /><span class="mono" id="hex">' + esc(p.color) + '</span></div></div>' +
      '<button class="btn">Save changes</button></div></form>' +
      '<div class="card"><div class="card-h"><h2>Preview</h2></div><div class="card-b"><div class="preview" id="pv"></div></div></div></div>' +
      apnsCard(p) +
      '<form class="card" id="df"><div class="card-h"><div><h2 style="color:#d33">Delete project</h2><p>The public key stops working immediately. This can’t be undone.</p></div></div>' +
      '<div class="card-b row"><input class="in grow" name="confirm" autocomplete="off" placeholder="Type “' + esc(p.name) + '” to confirm" /><button class="btn danger">Delete project</button></div></form></div>');

    function preview() {
      var f = Object.fromEntries(new FormData($('#sf')));
      $('#hex').textContent = f.color;
      $('#pv').innerHTML = '<div class="pv-panel"><div class="pv-head">' + esc(f.name) + '<small>● We usually reply in a few minutes</small></div>' +
        '<div class="pv-body"><div class="pv-in">' + esc(f.greeting) + '</div><div class="muted" style="font-size:10px">' + esc(f.agentName) + '</div>' +
        '<div class="pv-out" style="background:' + esc(f.color) + '">Hi! Where is my order?</div></div></div>' +
        '<div class="pv-fab" style="background:' + esc(f.color) + '">' + ic('chat') + '</div>';
    }
    $('#sf').oninput = preview;
    preview();
    $('#sf').onsubmit = function (e) {
      e.preventDefault();
      api('PATCH', '/v1/projects/' + p.id, Object.fromEntries(new FormData(e.target)))
        .then(function (r) { replaceProject(r.project); toast('Saved'); viewSettings(r.project); })
        .catch(function (err) { toast(err.message); });
    };
    if ($('#af')) {
      $('#af input[type=file]').onchange = function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var m = f.name.match(/AuthKey_([A-Z0-9]{10})\.p8$/);
        if (m && !$('#af [name=keyId]').value) $('#af [name=keyId]').value = m[1];
        f.text().then(function (txt) { $('#af [name=keyP8]').value = txt; });
      };
      $('#af').onsubmit = function (e) {
        e.preventDefault();
        var fd = Object.fromEntries(new FormData(e.target));
        delete fd.file;
        api('PUT', '/v1/projects/' + p.id + '/apns', fd)
          .then(function (r) { replaceProject(r.project); toast('Push notifications enabled'); viewSettings(r.project); })
          .catch(function (err) { $('#aerr').textContent = err.message; });
      };
    }
    if ($('#arm')) {
      $('#arm').onclick = function () {
        if (!confirm('Turn off push notifications for this project?')) return;
        api('DELETE', '/v1/projects/' + p.id + '/apns').then(function (r) { replaceProject(r.project); viewSettings(r.project); });
      };
    }
    $('#df').onsubmit = function (e) {
      e.preventDefault();
      if ($('#df input').value !== p.name) return toast('Name doesn’t match');
      api('DELETE', '/v1/projects/' + p.id).then(function () {
        S.projects = S.projects.filter(function (x) { return x.id !== p.id; });
        ls('td_project', null);
        location.hash = '#/';
      });
    };
  }

  function apnsCard(p) {
    var a = p.apns;
    if (a.configured) {
      return '<div class="card"><div class="card-h"><div><h2>iOS push notifications</h2><p>Customers get a notification when you answer, even with the app closed.</p></div><span class="badge ok">On</span></div>' +
        '<div class="card-b row"><dl class="kv grow"><dt>Bundle ID</dt><dd class="mono">' + esc(a.bundleId) + '</dd><dt>Key ID</dt><dd class="mono">' + esc(a.keyId) + '</dd><dt>Team ID</dt><dd class="mono">' + esc(a.teamId) + '</dd></dl>' +
        '<button class="btn danger" id="arm">Turn off</button></div></div>';
    }
    return '<form class="card" id="af"><div class="card-h"><div><h2>iOS push notifications</h2><p>Notify customers when you answer, even with the app closed. Needs an APNs key from your Apple Developer account.</p></div><span class="badge off">Off</span></div>' +
      '<div class="card-b"><ol class="howto"><li>Apple Developer → <b>Certificates, IDs & Profiles → Keys</b> → <b>+</b> → enable <b>Apple Push Notifications service (APNs)</b> → download the <span class="mono">.p8</span> file.</li>' +
      '<li>Upload it below with your Team ID (top-right of the developer portal) and your app’s bundle ID.</li>' +
      '<li>Add the push code from <a href="#/p/' + esc(p.id) + '/install" style="color:var(--accent)">Install SDK</a>.</li></ol>' +
      '<div class="grid-2" style="grid-template-columns:1fr 1fr">' +
      '<div class="field"><label class="l">APNs key (.p8)</label><input class="in" type="file" name="file" accept=".p8" /><input type="hidden" name="keyP8" /></div>' +
      '<div class="field"><label class="l">Key ID</label><input class="in mono" name="keyId" placeholder="ABC123DEFG" maxlength="10" required /></div>' +
      '<div class="field"><label class="l">Team ID</label><input class="in mono" name="teamId" placeholder="A1B2C3D4E5" maxlength="10" required /></div>' +
      '<div class="field"><label class="l">Bundle ID</label><input class="in mono" name="bundleId" placeholder="com.company.app" required /></div></div>' +
      '<div class="error" id="aerr"></div><button class="btn">Enable push notifications</button>' +
      '<div class="hint">The key is stored encrypted at rest and never shown again. Revoking it in Apple’s portal stops pushes immediately.</div></div></form>';
  }

  // Keep the Telegram warning dot in the sidebar in sync without re-rendering the page.
  function refreshSidebar() {
    var p = project(LIVE.pid);
    var link = $('.nav a[href$="/telegram"]');
    if (!p || !link) return;
    var c = link.querySelector('.count');
    if (p.telegram.connected && c) c.remove();
    if (!p.telegram.connected && !c) link.insertAdjacentHTML('beforeend', '<span class="count" style="background:var(--warn)">!</span>');
  }

  function replaceProject(np) {
    S.projects = S.projects.map(function (x) { return x.id === np.id ? np : x; });
  }

  // ---------- router ----------
  function boot() {
    if (S.me) return Promise.resolve();
    return Promise.all([api('GET', '/v1/me'), api('GET', '/v1/projects')]).then(function (r) {
      S.me = r[0];
      S.projects = r[1].projects;
      if (S.me.botUsername && !CFG.botUsername) CFG.botUsername = S.me.botUsername;
    });
  }

  function route() {
    clearTimers();
    var h = location.hash.replace(/^#\/?/, '').split('/');
    if (h[0] === 'login' || h[0] === 'signup') return viewAuth(h[0]);
    if (!ls('td_token')) { location.hash = '#/signup'; return; }
    boot().then(function () {
      if (h[0] === 'new' || !S.projects.length) return viewNew();
      var p = h[0] === 'p' && project(h[1]);
      if (!p) {
        var last = project(ls('td_project')) || S.projects[0];
        location.hash = '#/p/' + last.id + '/overview';
        return;
      }
      ls('td_project', p.id);
      var section = h[2] || 'overview';
      // Render from cache right away, then from fresh data (settings may have changed elsewhere).
      if (section === 'telegram' || section === 'settings' || section === 'install') {
        var current = location.hash;
        api('GET', '/v1/projects/' + p.id).then(function (x) {
          replaceProject(x.project);
          if (location.hash !== current || JSON.stringify(x.project) === JSON.stringify(p)) return;
          if (section === 'telegram') viewTelegram(x.project);
          else if (section === 'settings') viewSettings(x.project);
          else viewInstall(x.project);
        }).catch(function () {});
      }
      if (section === 'tickets' && h[3]) return viewTicket(p, h[3]);
      if (section === 'tickets') return viewTickets(p);
      if (section === 'install') return viewInstall(p);
      if (section === 'telegram') return viewTelegram(p);
      if (section === 'settings') return viewSettings(p);
      viewOverview(p);
    }).catch(function () {});
  }

  window.addEventListener('hashchange', route);
  route();
})();
