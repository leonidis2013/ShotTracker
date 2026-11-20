// Delivery: Home Assistant (REST + websocket for notification buttons) and email (a small SMTP client).
// Node built-ins only.
'use strict';
const http = require('http'), https = require('https'), net = require('net'), tls = require('tls'), crypto = require('crypto');

// ---------- Home Assistant REST ----------
function haRequest(cfg, method, path, body) {
  return new Promise((resolve, reject) => {
    if (!cfg.ha_url || !cfg.ha_token) return reject(new Error('Home Assistant URL and token are not set'));
    let u; try { u = new URL(path, cfg.ha_url.replace(/\/+$/, '') + '/'); } catch { return reject(new Error('Home Assistant URL is not valid')); }
    const lib = u.protocol === 'https:' ? https : http, data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(u, {
      method, timeout: 15000, rejectUnauthorized: cfg.ha_insecure !== '1',
      headers: { Authorization: 'Bearer ' + cfg.ha_token, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json ?? text);
        else reject(new Error(`Home Assistant answered ${res.statusCode}` + (res.statusCode === 401 ? ' (check the token)' : res.statusCode === 400 ? ': ' + text.slice(0, 200) : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Home Assistant did not answer')));
    req.on('error', e => reject(new Error('Could not reach Home Assistant: ' + e.message)));
    if (data) req.write(data);
    req.end();
  });
}

async function haNotifyServices(cfg) {
  const list = await haRequest(cfg, 'GET', 'api/services');
  const n = (Array.isArray(list) ? list : []).find(d => d.domain === 'notify');
  return n ? Object.keys(n.services).filter(s => !['send_message', 'persistent_notification'].includes(s)).sort() : [];
}

function haPush(cfg, service, { title, message, url, tag, actions }) {
  const data = { tag, group: 'shottracker', url, clickAction: url, push: { 'interruption-level': 'time-sensitive' } };
  if (actions && actions.length) data.actions = actions;
  return haRequest(cfg, 'POST', 'api/services/notify/' + encodeURIComponent(service), { title, message, data });
}

const haState = (cfg, entity, state, attributes) => haRequest(cfg, 'POST', 'api/states/' + entity, { state: String(state), attributes });

// ---------- Home Assistant websocket: notification button presses ----------
// Calls onAction(actionString) for every mobile_app_notification_action event. Reconnects on its own.
function haListen(getCfg, onAction, log = console) {
  let ws = null, timer = null, stopped = false, key = '', status = 'off', lastError = '';
  const connect = () => {
    clearTimeout(timer);
    const cfg = getCfg();
    if (stopped) return;
    if (!cfg.ha_url || !cfg.ha_token || typeof WebSocket !== 'function') { status = 'off'; timer = setTimeout(connect, 60e3); return; }
    key = cfg.ha_url + '|' + cfg.ha_token;
    let url; try { url = new URL('api/websocket', cfg.ha_url.replace(/\/+$/, '') + '/'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; } catch { status = 'error'; lastError = 'bad URL'; timer = setTimeout(connect, 60e3); return; }
    status = 'connecting';
    try { ws = new WebSocket(url.href); } catch (e) { status = 'error'; lastError = e.message; timer = setTimeout(connect, 30e3); return; }
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: cfg.ha_token }));
      else if (m.type === 'auth_ok') { status = 'connected'; lastError = ''; ws.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'mobile_app_notification_action' })); }
      else if (m.type === 'auth_invalid') { status = 'error'; lastError = 'token rejected'; ws.close(); }
      else if (m.type === 'event' && m.event && m.event.data && typeof m.event.data.action === 'string') {
        try { onAction(m.event.data.action); } catch (e) { log.error('notification action', e.message); }
      }
    };
    ws.onclose = () => { if (status === 'connected') status = 'reconnecting'; ws = null; if (!stopped) timer = setTimeout(connect, 15e3); };
    ws.onerror = e => { lastError = (e && e.message) || 'connection failed'; if (status !== 'error') status = 'error'; };
  };
  connect();
  return {
    status: () => ({ status, error: lastError }),
    restart() { const c = getCfg(); if (c.ha_url + '|' + c.ha_token === key && ws) return; if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch {} } connect(); },
    stop() { stopped = true; clearTimeout(timer); if (ws) try { ws.close(); } catch {} },
  };
}

// ---------- email (SMTP: implicit TLS on 465, STARTTLS otherwise) ----------
function smtpSend(cfg, to, subject, text) {
  return new Promise((resolve, reject) => {
    const host = cfg.smtp_host, port = +cfg.smtp_port || 587;
    if (!host || !cfg.smtp_from) return reject(new Error('Email server and From address are not set'));
    let sock, buf = '', waiter = null, done = false;
    const fail = e => { if (done) return; done = true; try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const attach = s => { s.setEncoding('utf8'); s.on('data', c => { buf += c; if (waiter) { const w = waiter; waiter = null; w(); } }); s.on('error', e => fail(new Error('Email server: ' + e.message))); s.setTimeout(20000, () => fail(new Error('Email server did not answer'))); };
    const read = () => new Promise(res => {
      const check = () => {
        const lines = buf.split('\r\n');
        for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}(?: |$)/.test(lines[i])) { const out = lines.slice(0, i + 1); buf = lines.slice(i + 1).join('\r\n'); return res({ code: +lines[i].slice(0, 3), lines: out }); }
        waiter = check;
      };
      check();
    });
    const cmd = async (line, ok) => { if (line != null) sock.write(line + '\r\n'); const r = await read(); if (!String(r.code).startsWith(String(ok))) throw new Error(`Email server refused "${String(line || 'greeting').split(' ')[0]}": ${r.lines.join(' ').slice(0, 200)}`); return r; };
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const enc = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
    (async () => {
      sock = port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      attach(sock);
      await cmd(null, 2);
      let ehlo = await cmd('EHLO shottracker', 2);
      if (port !== 465) {
        if (!ehlo.lines.some(l => /STARTTLS/i.test(l))) throw new Error('Email server does not offer STARTTLS; refusing to send in the clear');
        await cmd('STARTTLS', 2);
        sock.removeAllListeners('data'); sock.removeAllListeners('error');
        sock = tls.connect({ socket: sock, servername: host }); attach(sock);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = await cmd('EHLO shottracker', 2);
      }
      if (cfg.smtp_user) await cmd('AUTH PLAIN ' + b64('\0' + cfg.smtp_user + '\0' + (cfg.smtp_pass || '')), 2);
      const from = cfg.smtp_from.replace(/.*<|>.*/g, '');
      await cmd(`MAIL FROM:<${from}>`, 2);
      for (const t of [].concat(to)) await cmd(`RCPT TO:<${t}>`, 2);
      await cmd('DATA', 3);
      const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
      const msg = [
        `From: ShotTracker <${from}>`, `To: ${[].concat(to).join(', ')}`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@shottracker>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
      ].join('\r\n');
      sock.write(msg + '\r\n.\r\n');
      await cmd(null, 2);
      sock.write('QUIT\r\n'); done = true; sock.end(); resolve(true);
    })().catch(fail);
  });
}

module.exports = { haRequest, haNotifyServices, haPush, haState, haListen, smtpSend };
