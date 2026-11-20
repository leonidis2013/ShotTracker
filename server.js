// ShotTracker: tracks injectable medications for a household (patients, inventory, schedules, injection log).
// No npm dependencies: Node built-ins (node:sqlite, crypto) plus openssl in the image for the self-signed certificate.
// Everything it keeps (database, certificate, encryption key) lives in DATA_DIR, a Docker named volume.
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const VERSION = require('./package.json').version;
const DATA = process.env.DATA_DIR || '/data';
const HTTPS_PORT = +(process.env.HTTPS_PORT ?? 8443);  // 0 turns https off (tests only)
const HTTP_PORT = +(process.env.HTTP_PORT || 0);        // plain http is off unless you set it
const TRUST = (process.env.TRUST_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
const PUB = path.join(__dirname, 'public');
const COOKIE = 'st_session';
const IDLE_SHORT = 12 * 3600e3, IDLE_LONG = 30 * 86400e3;
fs.mkdirSync(DATA, { recursive: true });

// ---------- encryption key: seals TOTP secrets and secret settings at rest ----------
const keyFile = path.join(DATA, 'keys', 'app.key');
if (!fs.existsSync(keyFile)) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
}
const KEY = fs.readFileSync(keyFile);
function seal(s) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const e = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
}
function unseal(s) {
  const b = Buffer.from(String(s).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA, 'shottracker.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);');
const MIGRATIONS = [
  `CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, email TEXT,
     role TEXT NOT NULL, pw TEXT NOT NULL, totp TEXT, totp_on INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0,
     recovery TEXT NOT NULL DEFAULT '[]', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL, seen_at INTEGER NOT NULL, idle_ms INTEGER NOT NULL, ip TEXT, agent TEXT);
   CREATE TABLE patients(id INTEGER PRIMARY KEY, name TEXT NOT NULL, birth_date TEXT, color TEXT, notes TEXT,
     deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE audit_log(id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, tbl TEXT, record INTEGER, old TEXT, new TEXT);`,
];
{
  const have = +(db.prepare(`SELECT value FROM meta WHERE key='schema'`).get()?.value || 0);
  for (let i = have; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[i]); db.prepare(`INSERT OR REPLACE INTO meta VALUES('schema', ?)`).run(String(i + 1)); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
const q = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();

function audit(uid, action, tbl, record, before, after) {
  const clean = o => o == null ? null : JSON.stringify(o, (k, v) => ['pw', 'totp', 'recovery'].includes(k) ? undefined : v);
  q('INSERT INTO audit_log(at, user_id, action, tbl, record, old, new) VALUES(?,?,?,?,?,?,?)')
    .run(now(), uid ?? null, action, tbl ?? null, record ?? null, clean(before), clean(after));
}

// ---------- passwords, TOTP, recovery codes ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function checkPw(pw, stored) { const [salt, h] = String(stored).split(':'); return safeEq(crypto.scryptSync(String(pw), salt, 64).toString('hex'), h); }
const DUMMY_PW = hashPw(crypto.randomBytes(8).toString('hex')); // keeps unknown-user logins as slow as real ones

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function unb32(s) { let bits = 0, val = 0; const out = []; for (const c of String(s).toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// returns the time step that matched (so it can't be used twice), or 0
function totpStep(secretB32, code, last = 0) {
  const key = unb32(secretB32), t = Math.floor(Date.now() / 30000), c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  for (const d of [0, -1, 1]) { const s = t + d; if (s > last && safeEq(hotp(key, s), c)) return s; }
  return 0;
}
function newRecovery() {
  const codes = Array.from({ length: 8 }, () => { const r = b32(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return r.slice(0, 5) + '-' + r.slice(5); });
  return { codes, hashes: codes.map(c => sha(c.replace(/-/g, ''))) };
}

// ---------- request helpers ----------
function ipInCidr(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [base, bits] = cidr.split('/'), n = s => s.split('.').reduce((a, x) => (a << 8) + (+x), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const mask = +bits === 0 ? 0 : (~0 << (32 - +bits)) >>> 0;
  return (n(ip) & mask) === (n(base) & mask);
}
const remote = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const trusted = req => TRUST.some(c => ipInCidr(remote(req), c));
function clientIp(req) {
  if (trusted(req) && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
  return remote(req);
}
const isSecure = req => !!req.socket.encrypted || (trusted(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 65536) { reject(httpErr(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(httpErr(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const ROLES = ['admin', 'caregiver', 'viewer'];
const COLORS = ['#4c8dff', '#2ec4b6', '#f2c94c', '#ef4c4c', '#3ecf6e', '#b07cff', '#ff8a3d', '#ff6fb5'];

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------- sessions ----------
function userFrom(req) {
  const t = cookies(req)[COOKIE]; if (!t) return null;
  const s = q('SELECT * FROM sessions WHERE token=?').get(sha(t)); if (!s) return null;
  const n = Date.now();
  if (n - s.seen_at > s.idle_ms) { q('DELETE FROM sessions WHERE token=?').run(s.token); return null; }
  const u = q('SELECT * FROM users WHERE id=? AND disabled=0').get(s.user_id); if (!u) return null;
  if (n - s.seen_at > 60e3) q('UPDATE sessions SET seen_at=? WHERE token=?').run(n, s.token);
  u.sessionToken = s.token;
  return u;
}
function startSession(req, res, u, remember) {
  const t = crypto.randomBytes(32).toString('base64url'), idle = remember ? IDLE_LONG : IDLE_SHORT;
  q('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run(sha(t), u.id, now(), Date.now(), idle, clientIp(req), str(req.headers['user-agent'], 200));
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/` + (remember ? `; Max-Age=${IDLE_LONG / 1000}` : '') + (isSecure(req) ? '; Secure' : ''));
}
const clearCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` + (isSecure(req) ? '; Secure' : ''));
setInterval(() => q('DELETE FROM sessions WHERE ? - seen_at > idle_ms').run(Date.now()), 3600e3).unref();

// ---------- login throttling: 5 failures locks that user name, 20 locks that address, for 15 minutes ----------
// (the address limit is higher because a household behind one proxy or router shares an address)
const fails = new Map();
const LOCK_MS = 15 * 60e3, limitFor = k => k.startsWith('ip:') ? 20 : 5;
function locked(...keys) { const n = Date.now(); return keys.some(k => { const f = fails.get(k); return f && f.until > n; }); }
function failed(...keys) { const n = Date.now(); for (const k of keys) { const f = fails.get(k) || { count: 0, until: 0 }; if (f.until && f.until <= n) { f.count = 0; f.until = 0; } f.count++; if (f.count >= limitFor(k)) f.until = n + LOCK_MS; fails.set(k, f); } }
setInterval(() => { const n = Date.now(); for (const [k, f] of fails) if (!f.until || f.until < n - LOCK_MS) fails.delete(k); }, 3600e3).unref();
function succeeded(...keys) { for (const k of keys) fails.delete(k); }

// pending second steps after a correct password (5 minutes)
const tickets = new Map();
function newTicket(data) { const t = crypto.randomBytes(24).toString('base64url'); tickets.set(t, { ...data, exp: Date.now() + 5 * 60e3 }); return t; }
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.exp < n) tickets.delete(k); }, 60e3).unref();

function enrollInfo(u, secret) {
  const label = encodeURIComponent('ShotTracker:' + u.username);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=ShotTracker&algorithm=SHA1&digits=6&period=30` };
}
function secondStep(u, remember) {
  if (u.totp_on) return { step: 'totp', ticket: newTicket({ uid: u.id, mode: 'totp', remember }) };
  const secret = b32(crypto.randomBytes(20));
  return { step: 'enroll', ticket: newTicket({ uid: u.id, mode: 'enroll', secret, remember }), ...enrollInfo(u, secret) };
}

const meOut = u => ({ id: u.id, username: u.username, name: u.name, email: u.email || '', role: u.role });
const userOut = u => ({ ...meOut(u), disabled: !!u.disabled, totp: !!u.totp_on, created_at: u.created_at });
const patientOut = p => ({ id: p.id, name: p.name, birth_date: p.birth_date || '', color: p.color || COLORS[0], notes: p.notes || '', updated_at: p.updated_at });

// ---------- settings (secret ones sealed at rest, never sent back) ----------
const SETTINGS = {
  ha_url: {}, ha_token: { secret: true },
  ntfy_url: {}, ntfy_topic: {}, ntfy_token: { secret: true },
  smtp_host: {}, smtp_port: {}, smtp_user: {}, smtp_pass: { secret: true }, smtp_from: {},
};
function settingsOut() {
  const o = {};
  for (const [k, d] of Object.entries(SETTINGS)) {
    const r = q('SELECT value FROM settings WHERE key=?').get(k);
    o[k] = d.secret ? { set: !!(r && r.value) } : (r ? r.value : '');
  }
  return o;
}

// ---------- API ----------
const needUser = req => { if (!req.user) throw httpErr(401, 'Please sign in'); return req.user; };
const needRole = (req, ...roles) => { const u = needUser(req); if (!roles.includes(u.role)) throw httpErr(403, 'Not allowed for your role'); return u; };
const adminCount = () => q(`SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0`).get().n;
function checkNewPassword(pw) { if (String(pw || '').length < 12) throw httpErr(400, 'Passwords need at least 12 characters'); if (String(pw).length > 200) throw httpErr(400, 'Password too long'); }
function validUsername(s) { const v = str(s, 40); if (!/^[a-zA-Z0-9._-]{3,40}$/.test(v)) throw httpErr(400, 'User names are 3-40 letters, numbers, dots, dashes or underscores'); return v; }

async function api(req, res, seg) {
  const m = req.method, ip = clientIp(req);
  const route = m + ' /' + seg.join('/');
  req.user = userFrom(req);

  if (route === 'GET /health') return send(res, 200, { ok: true, version: VERSION });
  if (route === 'GET /state') {
    const users = q('SELECT COUNT(*) n FROM users').get().n;
    return send(res, 200, { version: VERSION, setup: users === 0, user: req.user ? meOut(req.user) : null });
  }

  // first visit: create the admin account
  if (route === 'POST /setup') {
    const b = await readJson(req);
    if (q('SELECT COUNT(*) n FROM users').get().n) throw httpErr(409, 'Setup is already done');
    const username = validUsername(b.username); checkNewPassword(b.password);
    const name = str(b.name, 80) || username, t = now();
    const r = q('INSERT INTO users(username, name, email, role, pw, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(username, name, str(b.email, 120), 'admin', hashPw(b.password), t, t);
    const u = q('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    audit(u.id, 'setup', 'users', u.id, null, userOut(u));
    return send(res, 200, secondStep(u, !!b.remember));
  }

  if (route === 'POST /login') {
    const b = await readJson(req), name = str(b.username, 40).toLowerCase();
    if (locked('ip:' + ip, 'user:' + name)) throw httpErr(429, 'Too many tries. Wait 15 minutes and try again.');
    const u = q('SELECT * FROM users WHERE username=?').get(name);
    const ok = checkPw(String(b.password || ''), u ? u.pw : DUMMY_PW) && u && !u.disabled;
    if (!ok) { failed('ip:' + ip, 'user:' + name); audit(u ? u.id : null, 'login-failed', 'users', u ? u.id : null, null, { ip }); throw httpErr(401, 'Wrong user name or password'); }
    return send(res, 200, secondStep(u, !!b.remember));
  }

  if (route === 'POST /login/code') {
    const b = await readJson(req), tk = tickets.get(String(b.ticket || ''));
    if (!tk || tk.exp < Date.now()) throw httpErr(401, 'That sign-in expired. Start again.');
    const u = q('SELECT * FROM users WHERE id=? AND disabled=0').get(tk.uid); if (!u) throw httpErr(401, 'That sign-in expired. Start again.');
    if (locked('ip:' + ip, 'user:' + u.username.toLowerCase())) throw httpErr(429, 'Too many tries. Wait 15 minutes and try again.');
    const code = String(b.code || '').trim();
    let recovery = null;
    if (tk.mode === 'enroll') {
      const step = totpStep(tk.secret, code);
      if (!step) { failed('ip:' + ip, 'user:' + u.username.toLowerCase()); throw httpErr(401, 'That code didn\'t match. Check the time on your phone and try the newest code.'); }
      const rc = newRecovery(); recovery = rc.codes;
      q('UPDATE users SET totp=?, totp_on=1, totp_last=?, recovery=?, updated_at=? WHERE id=?').run(seal(tk.secret), step, JSON.stringify(rc.hashes), now(), u.id);
      audit(u.id, 'totp-enrolled', 'users', u.id);
    } else {
      const step = totpStep(unseal(u.totp), code, u.totp_last);
      if (step) q('UPDATE users SET totp_last=? WHERE id=?').run(step, u.id);
      else {
        const hashes = JSON.parse(u.recovery || '[]'), h = sha(code.toLowerCase().replace(/[^a-z0-9]/g, '')), i = hashes.indexOf(h);
        if (i < 0) { failed('ip:' + ip, 'user:' + u.username.toLowerCase()); throw httpErr(401, 'That code didn\'t match'); }
        hashes.splice(i, 1); q('UPDATE users SET recovery=? WHERE id=?').run(JSON.stringify(hashes), u.id);
        audit(u.id, 'recovery-code-used', 'users', u.id, null, { left: hashes.length });
      }
    }
    tickets.delete(String(b.ticket));
    succeeded('ip:' + ip, 'user:' + u.username.toLowerCase());
    startSession(req, res, u, tk.remember);
    audit(u.id, 'login', 'users', u.id, null, { ip });
    return send(res, 200, { user: meOut(u), recovery });
  }

  if (route === 'POST /logout') { if (req.user) q('DELETE FROM sessions WHERE token=?').run(req.user.sessionToken); clearCookie(req, res); return send(res, 200, { ok: true }); }
  if (route === 'POST /logout-all') { const u = needUser(req); q('DELETE FROM sessions WHERE user_id=?').run(u.id); clearCookie(req, res); audit(u.id, 'logout-all', 'users', u.id); return send(res, 200, { ok: true }); }

  if (route === 'POST /me/password') {
    const u = needUser(req), b = await readJson(req);
    if (!checkPw(String(b.current || ''), u.pw)) throw httpErr(400, 'Current password is wrong');
    checkNewPassword(b.next);
    q('UPDATE users SET pw=?, updated_at=? WHERE id=?').run(hashPw(b.next), now(), u.id);
    q('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, u.sessionToken);
    audit(u.id, 'password-changed', 'users', u.id);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /me/recovery') {
    const u = needUser(req), b = await readJson(req);
    const step = totpStep(unseal(u.totp), b.code, u.totp_last); if (!step) throw httpErr(400, 'That code didn\'t match');
    const rc = newRecovery();
    q('UPDATE users SET recovery=?, totp_last=?, updated_at=? WHERE id=?').run(JSON.stringify(rc.hashes), step, now(), u.id);
    audit(u.id, 'recovery-codes-renewed', 'users', u.id);
    return send(res, 200, { recovery: rc.codes });
  }

  // ----- patients -----
  if (seg[0] === 'patients') {
    const id = seg[1] ? +seg[1] : null;
    if (m === 'GET' && !id) { needUser(req); return send(res, 200, q('SELECT * FROM patients WHERE deleted=0 ORDER BY name COLLATE NOCASE').all().map(patientOut)); }
    const u = needRole(req, 'admin', 'caregiver');
    const clean = b => {
      const name = str(b.name, 80); if (!name) throw httpErr(400, 'Name is required');
      const bd = str(b.birth_date, 10); if (bd && !/^\d{4}-\d{2}-\d{2}$/.test(bd)) throw httpErr(400, 'Birth date must be YYYY-MM-DD');
      const color = COLORS.includes(b.color) ? b.color : COLORS[0];
      return { name, birth_date: bd, color, notes: str(b.notes, 2000) };
    };
    if (m === 'POST' && !id) {
      const v = clean(await readJson(req)), t = now();
      const r = q('INSERT INTO patients(name, birth_date, color, notes, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(v.name, v.birth_date, v.color, v.notes, t, t);
      const p = q('SELECT * FROM patients WHERE id=?').get(r.lastInsertRowid);
      audit(u.id, 'create', 'patients', p.id, null, patientOut(p));
      return send(res, 200, patientOut(p));
    }
    const before = id && q('SELECT * FROM patients WHERE id=? AND deleted=0').get(id);
    if (!before) throw httpErr(404, 'Patient not found');
    if (m === 'PUT') {
      const v = clean(await readJson(req));
      q('UPDATE patients SET name=?, birth_date=?, color=?, notes=?, updated_at=? WHERE id=?').run(v.name, v.birth_date, v.color, v.notes, now(), id);
      const p = q('SELECT * FROM patients WHERE id=?').get(id);
      audit(u.id, 'update', 'patients', id, patientOut(before), patientOut(p));
      return send(res, 200, patientOut(p));
    }
    if (m === 'DELETE') {
      needRole(req, 'admin');
      q('UPDATE patients SET deleted=1, updated_at=? WHERE id=?').run(now(), id);
      audit(u.id, 'delete', 'patients', id, patientOut(before), null);
      return send(res, 200, { ok: true });
    }
  }

  // ----- users (admin) -----
  if (seg[0] === 'users') {
    const a = needRole(req, 'admin'), id = seg[1] ? +seg[1] : null;
    if (m === 'GET' && !id) return send(res, 200, q('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(userOut));
    if (m === 'POST' && !id) {
      const b = await readJson(req), username = validUsername(b.username); checkNewPassword(b.password);
      if (!ROLES.includes(b.role)) throw httpErr(400, 'Unknown role');
      if (q('SELECT id FROM users WHERE username=?').get(username)) throw httpErr(409, 'That user name is taken');
      const t = now();
      const r = q('INSERT INTO users(username, name, email, role, pw, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(username, str(b.name, 80) || username, str(b.email, 120), b.role, hashPw(b.password), t, t);
      const nu = q('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
      audit(a.id, 'create', 'users', nu.id, null, userOut(nu));
      return send(res, 200, userOut(nu));
    }
    const before = id && q('SELECT * FROM users WHERE id=?').get(id);
    if (!before) throw httpErr(404, 'User not found');
    if (m === 'PUT') {
      const b = await readJson(req);
      const role = b.role === undefined ? before.role : b.role; if (!ROLES.includes(role)) throw httpErr(400, 'Unknown role');
      const disabled = b.disabled === undefined ? !!before.disabled : !!b.disabled;
      if (before.role === 'admin' && !before.disabled && (role !== 'admin' || disabled) && adminCount() <= 1) throw httpErr(400, 'Keep at least one active admin');
      if (b.password) checkNewPassword(b.password);
      q('UPDATE users SET name=?, email=?, role=?, disabled=?, updated_at=? WHERE id=?').run(str(b.name ?? before.name, 80) || before.username, str(b.email ?? before.email, 120), role, disabled ? 1 : 0, now(), id);
      if (b.password) q('UPDATE users SET pw=? WHERE id=?').run(hashPw(b.password), id);
      if (b.resetTotp) q(`UPDATE users SET totp=NULL, totp_on=0, totp_last=0, recovery='[]' WHERE id=?`).run(id);
      if (b.password || b.resetTotp || disabled) q('DELETE FROM sessions WHERE user_id=?').run(id);
      const after = q('SELECT * FROM users WHERE id=?').get(id);
      audit(a.id, 'update', 'users', id, userOut(before), { ...userOut(after), passwordReset: !!b.password, totpReset: !!b.resetTotp });
      return send(res, 200, userOut(after));
    }
  }

  // ----- settings (admin) -----
  if (seg[0] === 'settings' && seg.length === 1) {
    const a = needRole(req, 'admin');
    if (m === 'GET') return send(res, 200, settingsOut());
    if (m === 'PUT') {
      const b = await readJson(req), changed = [];
      for (const [k, d] of Object.entries(SETTINGS)) {
        if (b[k] === undefined) continue;          // secret fields left blank keep their value
        const v = str(b[k], 500);
        if (d.secret && v === '' && !b['clear_' + k]) continue;
        q('INSERT OR REPLACE INTO settings VALUES(?, ?)').run(k, v === '' ? '' : (d.secret ? seal(v) : v));
        changed.push(k);
      }
      if (changed.length) audit(a.id, 'update', 'settings', null, null, { changed });
      return send(res, 200, settingsOut());
    }
  }

  // ----- audit log (admin, read-only) -----
  if (route === 'GET /audit') { needRole(req, 'admin'); return send(res, 200, q('SELECT a.*, u.name user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all()); }

  throw httpErr(404, 'Not found');
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p === '/' || !path.extname(p)) p = '/index.html';
  const f = path.resolve(PUB, '.' + p);
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'max-age=300' });
  fs.createReadStream(f).pipe(res);
}

// Changes need our own header (a cross-site form or image can't send it) and, when the browser says where it came from, the same host.
function csrfOk(req) {
  if (req.headers['x-shottracker'] !== '1') return false;
  const origin = req.headers.origin; if (!origin) return true;
  const host = (trusted(req) && req.headers['x-forwarded-host']) || req.headers.host;
  try { return new URL(origin).host === String(host).split(',')[0].trim(); } catch { return false; }
}

async function listener(req, res) {
  securityHeaders(req, res);
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req)) throw httpErr(403, 'Blocked: request did not come from the ShotTracker page');
      return await api(req, res, url.pathname.slice(5).split('/').filter(Boolean));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpErr(405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(e);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Something went wrong' });
  }
}

// ---------- start ----------
if (HTTP_PORT) http.createServer(listener).listen(HTTP_PORT, () => console.log(`ShotTracker ${VERSION}: http on ${HTTP_PORT}`));
if (HTTPS_PORT) {
  const useOwn = process.env.TLS_CERT && process.env.TLS_KEY;
  const dir = path.join(DATA, 'tls'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!useOwn && !(fs.existsSync(key) && fs.existsSync(cert))) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=shottracker',
      '-addext', 'subjectAltName=DNS:shottracker,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
  }
  https.createServer({ key: fs.readFileSync(useOwn ? process.env.TLS_KEY : key), cert: fs.readFileSync(useOwn ? process.env.TLS_CERT : cert), minVersion: 'TLSv1.2' }, listener)
    .listen(HTTPS_PORT, () => console.log(`ShotTracker ${VERSION}: https on ${HTTPS_PORT}` + (TRUST.length ? `, trusting proxy ${TRUST.join(', ')}` : '')));
}
module.exports = { b32, unb32, hotp };
