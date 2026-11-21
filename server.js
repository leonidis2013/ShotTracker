// ShotTracker: tracks injectable medications for a household (patients, inventory, schedules, injection log, reminders).
// No npm dependencies: Node built-ins (node:sqlite, crypto, zlib) plus openssl in the image for the self-signed certificate.
// Everything it keeps (database, certificate, encryption key, backups) lives in DATA_DIR, a Docker named volume.
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const S = require('./lib/sched');
const N = require('./lib/notify');
const NDC = require('./lib/ndc');

const VERSION = require('./package.json').version;
const DATA = process.env.DATA_DIR || '/data';
const HTTPS_PORT = +(process.env.HTTPS_PORT ?? 8443);  // 0 turns https off (tests only)
const HTTP_PORT = +(process.env.HTTP_PORT || 0);        // plain http is off unless you set it
const TRUST = (process.env.TRUST_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
const BACKUP_COPY_DIR = process.env.BACKUP_DIR || '';   // optional extra copy of each backup (a mounted folder)
const TICK_MS = +(process.env.TICK_MS || 60e3);
const OPENFDA_URL = process.env.OPENFDA_URL || 'https://api.fda.gov';   // FDA NDC Directory (tests point this at a fake)          // reminder engine interval (tests use a short one)
const PUB = path.join(__dirname, 'public');
const COOKIE = 'st_session';
const IDLE_SHORT = 12 * 3600e3, IDLE_LONG = 30 * 86400e3;
const DB_FILE = path.join(DATA, 'shottracker.db'), BACKUPS = path.join(DATA, 'backups');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });

// ---------- a restore waiting from the last run replaces the database before it opens ----------
if (fs.existsSync(DB_FILE + '.restore')) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(DB_FILE)) fs.renameSync(DB_FILE, path.join(BACKUPS, `before-restore-${stamp}.db`));
  for (const x of ['-wal', '-shm']) fs.rmSync(DB_FILE + x, { force: true });
  fs.renameSync(DB_FILE + '.restore', DB_FILE);
  console.log('Restored the database from a backup');
}

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
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);');
const STAMPS = 'deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL';
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
  // 0.2 - 1.0: medications, inventory, schedules, log, sites, reminders
  `ALTER TABLE users ADD COLUMN patient_id INTEGER;
   ALTER TABLE users ADD COLUMN notify_ha TEXT NOT NULL DEFAULT '';
   ALTER TABLE users ADD COLUMN email_reminders INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN email_digest INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE users ADD COLUMN reminders_on INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE users ADD COLUMN quiet_start TEXT NOT NULL DEFAULT '22:00';
   ALTER TABLE users ADD COLUMN quiet_end TEXT NOT NULL DEFAULT '07:00';
   ALTER TABLE users ADD COLUMN ics_token TEXT;
   CREATE TABLE patient_access(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, patient_id INTEGER NOT NULL, PRIMARY KEY(user_id, patient_id));
   CREATE TABLE weights(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, date TEXT NOT NULL, lb REAL NOT NULL, ${STAMPS});
   CREATE TABLE medications(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, name TEXT NOT NULL, generic TEXT, form TEXT NOT NULL,
     conc REAL, conc_unit TEXT, unit_ml REAL, route TEXT, storage TEXT, opened_days INTEGER, prescriber TEXT, pharmacy TEXT, pharmacy_phone TEXT,
     rx_number TEXT, refills_left INTEGER, next_shipment TEXT, reorder_days INTEGER NOT NULL DEFAULT 21, ndc TEXT, notes TEXT,
     active INTEGER NOT NULL DEFAULT 1, ${STAMPS});
   CREATE TABLE lots(id INTEGER PRIMARY KEY, medication_id INTEGER NOT NULL, lot_number TEXT, ndc TEXT, expires TEXT, qty_received REAL NOT NULL DEFAULT 0,
     qty_left REAL NOT NULL DEFAULT 0, received TEXT, opened TEXT, discard_by TEXT, location TEXT, notes TEXT, ${STAMPS});
   CREATE TABLE supplies(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'item', qty REAL NOT NULL DEFAULT 0, unit TEXT,
     reorder_at REAL, per_shot REAL NOT NULL DEFAULT 0, capacity REAL, ${STAMPS});
   CREATE TABLE schedules(id INTEGER PRIMARY KEY, medication_id INTEGER NOT NULL, kind TEXT NOT NULL, every INTEGER NOT NULL DEFAULT 1, weekdays TEXT,
     time_of_day TEXT NOT NULL DEFAULT '20:00', grace_min INTEGER NOT NULL DEFAULT 120, anchor TEXT NOT NULL DEFAULT 'calendar',
     start_date TEXT NOT NULL, end_date TEXT, paused INTEGER NOT NULL DEFAULT 0, dose_amount REAL, dose_unit TEXT, ${STAMPS});
   CREATE TABLE schedule_steps(id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL, start_date TEXT NOT NULL, dose_amount REAL, dose_unit TEXT, ${STAMPS});
   CREATE TABLE sites(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, name TEXT NOT NULL, view TEXT NOT NULL DEFAULT 'front', x REAL, y REAL,
     rest_days INTEGER NOT NULL DEFAULT 7, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, ${STAMPS});
   CREATE TABLE doses(id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, medication_id INTEGER NOT NULL, schedule_id INTEGER, due_at TEXT, given_at TEXT,
     status TEXT NOT NULL, amount REAL, unit TEXT, volume_ml REAL, lot_id INTEGER, qty_used REAL, site_id INTEGER, given_by INTEGER,
     reason TEXT, reaction TEXT, notes TEXT, source TEXT, ${STAMPS});
   CREATE INDEX doses_sched ON doses(schedule_id, deleted);
   CREATE INDEX doses_patient ON doses(patient_id, deleted);
   CREATE TABLE reminders(id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL, due_at TEXT NOT NULL, user_id INTEGER NOT NULL, step TEXT NOT NULL,
     channel TEXT NOT NULL, sent_at TEXT NOT NULL, result TEXT, UNIQUE(schedule_id, due_at, user_id, step, channel));
   CREATE TABLE snoozes(schedule_id INTEGER NOT NULL, due_at TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(schedule_id, due_at));
   CREATE TABLE alert_log(key TEXT NOT NULL, user_id INTEGER NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(key, user_id));`,
  // 1.1: NFC tags that open the app to a chosen screen
  `CREATE TABLE nfc_tags(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, action TEXT NOT NULL, target_id INTEGER,
     taps INTEGER NOT NULL DEFAULT 0, last_tap TEXT, last_user INTEGER, ${STAMPS});`,
  // 1.2: cached FDA NDC lookups
  `CREATE TABLE ndc_cache(ndc TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);`,
];
{
  const have = +(db.prepare(`SELECT value FROM meta WHERE key='schema'`).get()?.value || 0);
  for (let i = have; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[i]); db.prepare(`INSERT OR REPLACE INTO meta VALUES('schema', ?)`).run(String(i + 1)); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
const stmts = new Map();
const q = sql => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
const now = () => new Date().toISOString();
const today = () => S.ymd(new Date());
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function insert(table, o) {
  const k = Object.keys(o), t = now();
  return Number(q(`INSERT INTO ${table}(${k.join(',')}, created_at, updated_at) VALUES(${k.map(() => '?').join(',')}, ?, ?)`).run(...k.map(x => o[x]), t, t).lastInsertRowid);
}
function update(table, id, o) { const k = Object.keys(o); if (k.length) q(`UPDATE ${table} SET ${k.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...k.map(x => o[x]), now(), id); }
const getRow = (table, id) => q(`SELECT * FROM ${table} WHERE id=? AND deleted=0`).get(id);

function audit(uid, action, tbl, record, before, after) {
  const clean = o => o == null ? null : JSON.stringify(o, (k, v) => ['pw', 'totp', 'recovery', 'ics_token'].includes(k) ? undefined : v);
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
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpErr(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 262144); if (!b.length) return {};
  try { const v = JSON.parse(b.toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch { throw httpErr(400, 'Bad JSON'); }
}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// field checks: each returns the clean value or throws a message
const F = {
  s: (max = 200) => v => str(v, max),
  num: (min = -Infinity, max = Infinity) => v => { if (v === '' || v == null) return null; const n = +v; if (!Number.isFinite(n) || n < min || n > max) throw new Error('must be a number' + (min > -Infinity ? ` ${min} or more` : '')); return n; },
  int: (min = 0, max = 1e9) => v => { if (v === '' || v == null) return null; const n = +v; if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be a whole number from ${min} to ${max}`); return n; },
  date: v => { const s = str(v, 10); if (!s) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('must be a date (YYYY-MM-DD)'); return s; },
  time: v => { const s = str(v, 5); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error('must be a time (HH:MM)'); return s; },
  bool: v => v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0,
  one: list => v => { if (!list.includes(v)) throw new Error('must be one of ' + list.join(', ')); return v; },
};
function clean(spec, b, labels = {}) {
  const o = {};
  for (const [k, f] of Object.entries(spec)) { if (b[k] === undefined) continue; try { o[k] = f(b[k]); } catch (e) { throw httpErr(400, `${labels[k] || k.replace(/_/g, ' ')} ${e.message}`); } }
  return o;
}
const need = (o, ...keys) => { for (const k of keys) if (o[k] == null || o[k] === '') throw httpErr(400, k.replace(/_/g, ' ') + ' is required'); };

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------- settings (secret ones sealed at rest, never sent back) ----------
const SETTINGS = {
  app_url: {}, ha_url: {}, ha_token: { secret: true }, ha_insecure: { def: '0' }, ha_sensors: { def: '1' }, alerts_push: { def: '1' },
  smtp_host: {}, smtp_port: { def: '587' }, smtp_user: {}, smtp_pass: { secret: true }, smtp_from: {},
  remind_day_before: { def: '19:00' }, remind_morning: { def: '08:00' }, repeat_min: { def: '60' }, digest_time: { def: '07:00' },
  backup_pass: { secret: true }, backup_time: { def: '02:30' }, backup_keep: { def: '30' },
  ndc_lookup: { def: '1' }, openfda_key: { secret: true },
};
function setting(k) { const r = q('SELECT value FROM settings WHERE key=?').get(k); const v = r ? r.value : ''; if (!v) return SETTINGS[k]?.def ?? ''; return SETTINGS[k]?.secret ? unseal(v) : v; }
const cfg = () => Object.fromEntries(Object.keys(SETTINGS).map(k => [k, setting(k)]));
function settingsOut() {
  const o = {};
  for (const [k, d] of Object.entries(SETTINGS)) { const r = q('SELECT value FROM settings WHERE key=?').get(k); o[k] = d.secret ? { set: !!(r && r.value) } : (r && r.value ? r.value : d.def ?? ''); }
  o.ha_link = haLink.status();
  return o;
}
const appUrl = () => (setting('app_url') || '').replace(/\/+$/, '');

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
function succeeded(...keys) { for (const k of keys) fails.delete(k); }
setInterval(() => { const n = Date.now(); for (const [k, f] of fails) if (!f.until || f.until < n - LOCK_MS) fails.delete(k); }, 3600e3).unref();

const tickets = new Map();
function newTicket(data) { const t = crypto.randomBytes(24).toString('base64url'); tickets.set(t, { ...data, exp: Date.now() + 5 * 60e3 }); return t; }
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.exp < n) tickets.delete(k); }, 60e3).unref();
function secondStep(u, remember) {
  if (u.totp_on) return { step: 'totp', ticket: newTicket({ uid: u.id, mode: 'totp', remember }) };
  const secret = b32(crypto.randomBytes(20)), label = encodeURIComponent('ShotTracker:' + u.username);
  return { step: 'enroll', ticket: newTicket({ uid: u.id, mode: 'enroll', secret, remember }), secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=ShotTracker&algorithm=SHA1&digits=6&period=30` };
}

// ---------- who can see and do what ----------
const ROLES = ['admin', 'caregiver', 'patient', 'viewer'];
const COLORS = ['#4c8dff', '#2ec4b6', '#f2c94c', '#ef4c4c', '#3ecf6e', '#b07cff', '#ff8a3d', '#ff6fb5'];
function patientIds(u) {
  if (u.role === 'admin') return q('SELECT id FROM patients WHERE deleted=0').all().map(r => r.id);
  if (u.role === 'patient') return u.patient_id && getRow('patients', u.patient_id) ? [u.patient_id] : [];
  return q('SELECT a.patient_id id FROM patient_access a JOIN patients p ON p.id=a.patient_id AND p.deleted=0 WHERE a.user_id=?').all(u.id).map(r => r.id);
}
const canSee = (u, pid) => patientIds(u).includes(+pid);
const canManage = (u, pid) => ['admin', 'caregiver'].includes(u.role) && canSee(u, pid);
const canLog = (u, pid) => canManage(u, pid) || (u.role === 'patient' && +u.patient_id === +pid);
function mustSee(u, pid) { if (!canSee(u, pid)) throw httpErr(404, 'Patient not found'); }
function mustManage(u, pid) { mustSee(u, pid); if (!canManage(u, pid)) throw httpErr(403, 'Not allowed for your role'); }
function mustLog(u, pid) { mustSee(u, pid); if (!canLog(u, pid)) throw httpErr(403, 'Not allowed for your role'); }

const meOut = u => ({ id: u.id, username: u.username, name: u.name, email: u.email || '', role: u.role, patient_id: u.patient_id || null });
const userOut = u => ({ ...meOut(u), disabled: !!u.disabled, totp: !!u.totp_on, created_at: u.created_at,
  patients: u.role === 'patient' ? (u.patient_id ? [u.patient_id] : []) : q('SELECT patient_id FROM patient_access WHERE user_id=?').all(u.id).map(r => r.patient_id) });
const prefsOut = u => ({ notify_ha: u.notify_ha || '', email: u.email || '', email_reminders: !!u.email_reminders, email_digest: !!u.email_digest, reminders_on: !!u.reminders_on,
  quiet_start: u.quiet_start, quiet_end: u.quiet_end, ics_url: u.ics_token ? (appUrl() || '') + '/ics/' + u.ics_token + '.ics' : '' });
const patientOut = p => ({ id: p.id, name: p.name, birth_date: p.birth_date || '', color: p.color || COLORS[0], notes: p.notes || '', updated_at: p.updated_at });

// ---------- medications, lots, doses: the math ----------
const FORMS = ['syringe', 'pen', 'single_vial', 'multi_vial'];
const FORM_UNIT = { syringe: 'syringes', pen: 'pens', single_vial: 'vials', multi_vial: 'mL' };
const SINGULAR = { syringe: 'syringe', pen: 'pen', single_vial: 'vial', multi_vial: 'mL' };
const units = (form, n) => `${n} ${n === 1 ? SINGULAR[form] : FORM_UNIT[form]}`;
const AMOUNT_UNITS = ['mg', 'mcg', 'units', 'mL'];
const round = (n, d = 3) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d;
function volumeFor(med, amount, unit) {
  if (amount == null) return null;
  if (unit === 'mL') return round(amount);
  if (med.conc && unit === med.conc_unit) return round(amount / med.conc);
  return null;
}
function qtyFor(med, vol) {
  if (med.form === 'multi_vial') return vol ?? 0;
  if (vol && med.unit_ml) return Math.max(1, Math.ceil(vol / med.unit_ml - 1e-6));
  return 1;
}
const lotUsable = (l, day = today()) => l.qty_left > 1e-9 && (!l.expires || l.expires >= day) && (!l.discard_by || l.discard_by >= day);
function lotsFor(mid) { return q('SELECT * FROM lots WHERE medication_id=? AND deleted=0 ORDER BY (qty_left<=0), opened IS NULL, expires IS NULL, expires, id').all(mid); }
function pickLot(med, need, day = today()) {
  const ls = lotsFor(med.id).filter(l => lotUsable(l, day));
  return ls.find(l => l.qty_left + 1e-9 >= need) || ls[0] || null;
}
function stockOf(med) { return round(lotsFor(med.id).filter(l => lotUsable(l)).reduce((a, l) => a + l.qty_left, 0), 2); }
const schedulesFor = mid => q('SELECT * FROM schedules WHERE medication_id=? AND deleted=0 ORDER BY id').all(mid);
const stepsFor = sid => q('SELECT * FROM schedule_steps WHERE schedule_id=? AND deleted=0 ORDER BY start_date').all(sid);
const lastDose = sid => q(`SELECT * FROM doses WHERE schedule_id=? AND deleted=0 AND status IN ('given','skipped','missed') ORDER BY COALESCE(due_at, given_at) DESC, id DESC LIMIT 1`).get(sid) || null;
function daysOfSupply(med) {
  let perDay = 0;
  for (const s of schedulesFor(med.id)) {
    if (s.paused || (s.end_date && s.end_date < today())) continue;
    const d = S.doseFor(s, stepsFor(s.id), new Date());
    perDay += qtyFor(med, volumeFor(med, d.amount, d.unit)) / S.intervalDays(s);
  }
  return perDay ? Math.floor(stockOf(med) / perDay) : null;
}
function medOut(m) {
  const stock = stockOf(m);
  return { ...m, active: !!m.active, deleted: undefined, stock, stock_unit: FORM_UNIT[m.form], days_of_supply: daysOfSupply(m) };
}

// sites: least recently used first, skipping ones still resting
function siteUsage(pid) {
  const sites = q('SELECT * FROM sites WHERE patient_id=? AND deleted=0 ORDER BY sort, id').all(pid);
  const last = new Map(q(`SELECT site_id, MAX(given_at) at FROM doses WHERE patient_id=? AND deleted=0 AND status='given' AND site_id IS NOT NULL GROUP BY site_id`).all(pid).map(r => [r.site_id, r.at]));
  const n = new Date();
  return sites.map(s => {
    const at = last.get(s.id) || null, days = at ? S.daysBetween(new Date(at), n) : null;
    return { ...s, enabled: !!s.enabled, deleted: undefined, last_used: at, days_since: days, resting: !!(at && days < s.rest_days) };
  });
}
function suggestSite(pid) {
  const list = siteUsage(pid).filter(s => s.enabled);
  const pick = arr => arr.sort((a, b) => (a.last_used || '').localeCompare(b.last_used || '') || a.sort - b.sort)[0];
  return pick(list.filter(s => !s.resting)) || pick(list) || null;
}
const DEFAULT_SITES = [
  ['Abdomen left', 'front', 56, 46], ['Abdomen right', 'front', 44, 46], ['Thigh left', 'front', 57, 66], ['Thigh right', 'front', 43, 66],
  ['Upper arm left', 'back', 24, 30], ['Upper arm right', 'back', 76, 30], ['Buttock left', 'back', 42, 52], ['Buttock right', 'back', 58, 52],
];
function seedSites(pid) { DEFAULT_SITES.forEach(([name, view, x, y], i) => insert('sites', { patient_id: pid, name, view, x, y, rest_days: 7, enabled: 1, sort: i })); }

// one schedule's state now
function schedInfo(s, n = new Date()) {
  const med = getRow('medications', s.medication_id); if (!med) return null;
  const last = lastDose(s.id), due = s.paused ? null : S.nextDue(s, last);
  const dose = S.doseFor(s, stepsFor(s.id), due || n), vol = volumeFor(med, dose.amount, dose.unit);
  const snz = due ? q('SELECT until FROM snoozes WHERE schedule_id=? AND due_at=?').get(s.id, due.toISOString()) : null;
  return {
    id: s.id, medication_id: med.id, patient_id: med.patient_id, med_name: med.name, form: med.form, storage: med.storage,
    describe: S.describe(s), paused: !!s.paused, due_at: due ? due.toISOString() : null, status: s.paused ? 'paused' : S.status(s, due, n),
    days_until: due ? S.daysBetween(n, due) : null, dose_amount: dose.amount, dose_unit: dose.unit, volume_ml: vol,
    last_given: last && last.status === 'given' ? last.given_at : null, snoozed_until: snz && snz.until > Date.now() ? new Date(snz.until).toISOString() : null,
  };
}
function schedulesOfPatient(pid) {
  return q(`SELECT s.* FROM schedules s JOIN medications m ON m.id=s.medication_id WHERE m.patient_id=? AND s.deleted=0 AND m.deleted=0 AND m.active=1`).all(pid);
}

// apply (sign -1) or undo (sign +1) a given dose's effect on stock and supplies
function applyStock(d, sign) {
  if (d.status !== 'given') return;
  if (d.lot_id && d.qty_used) {
    const l = q('SELECT * FROM lots WHERE id=?').get(d.lot_id);
    if (l && sign < 0 && l.qty_left + 1e-9 < d.qty_used) throw httpErr(400, `Lot ${l.lot_number || '#' + l.id} has ${round(l.qty_left, 2)} left; this dose needs ${d.qty_used}. Pick another lot, or log it as two entries.`);
    if (l) {
      q('UPDATE lots SET qty_left=?, updated_at=? WHERE id=?').run(Math.max(0, round(l.qty_left + sign * d.qty_used, 4)), now(), l.id);
      const med = q('SELECT * FROM medications WHERE id=?').get(l.medication_id);
      if (sign < 0 && med && med.form === 'multi_vial' && !l.opened) {
        const opened = S.ymd(new Date(d.given_at || Date.now()));
        q('UPDATE lots SET opened=?, discard_by=? WHERE id=?').run(opened, med.opened_days ? S.ymd(S.addDays(S.parseYmd(opened), med.opened_days)) : null, l.id);
      }
    }
  }
  for (const s of q('SELECT * FROM supplies WHERE deleted=0').all()) {
    if (s.kind === 'sharps') q('UPDATE supplies SET qty=MAX(0, qty - ?) WHERE id=?').run(sign, s.id);
    else if (s.per_shot) q('UPDATE supplies SET qty=MAX(0, qty + ?) WHERE id=?').run(sign * s.per_shot, s.id);
  }
}

// dose body -> row (validates lot and site belong to this med/patient)
const DOSE_SPEC = { status: F.one(['given', 'skipped', 'missed']), given_at: F.s(40), due_at: F.s(40), amount: F.num(0), unit: F.one(AMOUNT_UNITS), lot_id: F.int(1), site_id: F.int(1), qty_used: F.num(0), reason: F.s(300), reaction: F.s(300), notes: F.s(2000) };
function buildDose(u, b, base = {}) {
  const v = clean(DOSE_SPEC, b);
  const merged = { ...base, ...v };
  const med = getRow('medications', b.medication_id ?? base.medication_id); if (!med) throw httpErr(400, 'Medication not found');
  mustLog(u, med.patient_id);
  let sched = null;
  const sid = b.schedule_id !== undefined ? b.schedule_id : base.schedule_id;
  if (sid) { sched = getRow('schedules', sid); if (!sched || sched.medication_id !== med.id) throw httpErr(400, 'Schedule does not match the medication'); }
  for (const k of ['given_at', 'due_at']) if (merged[k]) { const t = new Date(merged[k]); if (isNaN(t)) throw httpErr(400, k.replace('_', ' ') + ' is not a valid time'); merged[k] = t.toISOString(); } else merged[k] = null;
  merged.status = merged.status || 'given';
  if (merged.status === 'given') {
    if (!merged.given_at) merged.given_at = now();
    if (new Date(merged.given_at) > new Date(Date.now() + 5 * 60e3)) throw httpErr(400, 'Given time is in the future');
  } else merged.given_at = null;
  if (sched && !merged.due_at && !base.id) { const due = S.nextDue(sched, lastDose(sched.id)); merged.due_at = due ? due.toISOString() : null; }
  if (merged.lot_id) { const l = getRow('lots', merged.lot_id); if (!l || l.medication_id !== med.id) throw httpErr(400, 'That lot is not for this medication'); }
  if (merged.site_id) { const s = q('SELECT * FROM sites WHERE id=?').get(merged.site_id); if (!s || s.patient_id !== med.patient_id) throw httpErr(400, 'That site is not for this patient'); }
  if (merged.status === 'given') {
    if (merged.amount == null) { const d = defaultDose(med, sched, new Date(merged.due_at || merged.given_at)); merged.amount = d.amount; merged.unit = d.unit; }
    merged.volume_ml = volumeFor(med, merged.amount, merged.unit);
    if (v.qty_used == null && (v.amount !== undefined || v.lot_id !== undefined || !base.id)) merged.qty_used = qtyFor(med, merged.volume_ml);
  } else { merged.lot_id = null; merged.site_id = null; merged.qty_used = null; merged.volume_ml = null; }
  return {
    row: { patient_id: med.patient_id, medication_id: med.id, schedule_id: sched ? sched.id : null, due_at: merged.due_at, given_at: merged.given_at, status: merged.status,
      amount: merged.amount ?? null, unit: merged.unit ?? null, volume_ml: merged.volume_ml ?? null, lot_id: merged.lot_id ?? null, qty_used: merged.qty_used ?? null,
      site_id: merged.site_id ?? null, reason: merged.reason ?? '', reaction: merged.reaction ?? '', notes: merged.notes ?? '' },
    med, sched,
  };
}
function logDose(u, b, source = 'app') {
  const { row, med } = buildDose(u, b);
  if (row.status === 'given' && !row.lot_id && b.lot_id === undefined) { const l = pickLot(med, row.qty_used || 0, S.ymd(new Date(row.given_at))); if (l && l.qty_left + 1e-9 >= (row.qty_used || 0)) row.lot_id = l.id; }
  if (row.status === 'given' && !row.site_id && b.site_id === undefined) { const s = suggestSite(med.patient_id); if (s) row.site_id = s.id; }
  return tx(() => {
    const id = insert('doses', { ...row, given_by: row.status === 'given' ? u.id : null, source });
    const d = q('SELECT * FROM doses WHERE id=?').get(id);
    applyStock(d, -1);
    if (d.schedule_id && d.due_at) q('DELETE FROM snoozes WHERE schedule_id=?').run(d.schedule_id);
    audit(u.id, 'create', 'doses', id, null, d);
    return d;
  });
}
function doseOut(d) {
  const med = q('SELECT name, form FROM medications WHERE id=?').get(d.medication_id) || {};
  const lot = d.lot_id ? q('SELECT lot_number, expires FROM lots WHERE id=?').get(d.lot_id) : null;
  const site = d.site_id ? q('SELECT name FROM sites WHERE id=?').get(d.site_id) : null;
  const by = d.given_by ? q('SELECT name FROM users WHERE id=?').get(d.given_by) : null;
  const pat = q('SELECT name FROM patients WHERE id=?').get(d.patient_id) || {};
  let timing = null;
  if (d.status === 'given' && d.due_at) {
    const s = q('SELECT grace_min FROM schedules WHERE id=?').get(d.schedule_id) || { grace_min: 120 };
    const graceEnd = new Date(new Date(d.due_at).getTime() + s.grace_min * 60e3);
    timing = S.ymd(new Date(d.given_at)) > S.ymd(graceEnd) ? 'late' : 'on time'; // only the date counts
  }
  return { ...d, deleted: undefined, med_name: med.name, form: med.form, patient_name: pat.name, lot_number: lot ? lot.lot_number : '', site_name: site ? site.name : '', given_by_name: by ? by.name : '', timing };
}

// ---------- alerts: stock, expiry, refills, supplies ----------
function alertsFor(pids) {
  const out = [], day = today(), soon = S.ymd(S.addDays(new Date(), 30));
  for (const pid of pids) {
    const p = getRow('patients', pid); if (!p) continue;
    for (const m of q('SELECT * FROM medications WHERE patient_id=? AND deleted=0 AND active=1').all(pid)) {
      const who = `${p.name}: ${m.name}`, dos = daysOfSupply(m), stock = stockOf(m), hasSched = schedulesFor(m.id).some(s => !s.paused);
      if (hasSched && stock <= 0) out.push({ key: `out:${m.id}`, level: 'bad', patient_id: pid, medication_id: m.id, text: `${who} is out of stock` });
      else if (dos != null && dos <= m.reorder_days) out.push({ key: `low:${m.id}`, level: 'warn', patient_id: pid, medication_id: m.id, text: `${who}: about ${dos} days left (${units(m.form, stock)})` });
      if (m.refills_left === 0 && hasSched) out.push({ key: `refills:${m.id}`, level: 'warn', patient_id: pid, medication_id: m.id, text: `${who}: no refills left; ask ${m.prescriber || 'the prescriber'} for a new prescription` });
      if (m.next_shipment) {
        const arrived = q('SELECT 1 FROM lots WHERE medication_id=? AND deleted=0 AND received>=?').get(m.id, m.next_shipment);
        if (!arrived && m.next_shipment < day) out.push({ key: `ship-late:${m.id}:${m.next_shipment}`, level: 'warn', patient_id: pid, medication_id: m.id, text: `${who}: shipment expected ${m.next_shipment} hasn't been received` });
        else if (!arrived && S.daysBetween(new Date(), S.parseYmd(m.next_shipment)) <= 3) out.push({ key: `ship:${m.id}:${m.next_shipment}`, level: 'info', patient_id: pid, medication_id: m.id, text: `${who}: shipment expected ${m.next_shipment}` });
      }
      for (const l of lotsFor(m.id)) {
        if (l.qty_left <= 1e-9) continue;
        const lot = `lot ${l.lot_number || '#' + l.id}`;
        if (l.expires && l.expires < day) out.push({ key: `expired:${l.id}`, level: 'bad', patient_id: pid, medication_id: m.id, text: `${who} ${lot} expired ${l.expires}; don't use it` });
        else if (l.discard_by && l.discard_by < day) out.push({ key: `discard:${l.id}`, level: 'bad', patient_id: pid, medication_id: m.id, text: `${who} ${lot} was opened ${l.opened}; discard it (good until ${l.discard_by})` });
        else if (l.expires && l.expires <= soon) out.push({ key: `expiring:${l.id}`, level: 'warn', patient_id: pid, medication_id: m.id, text: `${who} ${lot} expires ${l.expires}` });
      }
    }
  }
  for (const s of q('SELECT * FROM supplies WHERE deleted=0').all()) {
    if (s.kind === 'sharps') { if (s.capacity && s.qty >= 0.8 * s.capacity) out.push({ key: `sharps:${s.id}`, level: 'warn', text: `${s.name} is ${Math.round(100 * s.qty / s.capacity)}% full` }); }
    else if (s.reorder_at != null && s.qty <= s.reorder_at) out.push({ key: `supply:${s.id}`, level: 'warn', text: `${s.name}: ${s.qty} ${s.unit || ''} left`.trim() });
  }
  return out;
}

// ---------- the "today" view ----------
function todayView(u) {
  const n = new Date();
  return patientIds(u).map(pid => {
    const p = getRow('patients', pid);
    const scheds = schedulesOfPatient(pid).map(s => schedInfo(s, n)).filter(Boolean).sort((a, b) => (a.due_at || '9').localeCompare(b.due_at || '9'));
    const recent = q(`SELECT * FROM doses WHERE patient_id=? AND deleted=0 ORDER BY COALESCE(given_at, due_at, created_at) DESC, id DESC LIMIT 5`).all(pid).map(doseOut);
    return { patient: patientOut(p), schedules: scheds, recent, can_log: canLog(u, pid), can_manage: canManage(u, pid) };
  });
}

// dose to pre-fill: the schedule's, else the last shot's, else one full syringe/pen/vial
function defaultDose(med, sched, date) {
  if (sched) { const d = S.doseFor(sched, stepsFor(sched.id), date); if (d.amount != null) return { ...d, source: 'schedule' }; }
  const last = q(`SELECT amount, unit FROM doses WHERE medication_id=? AND deleted=0 AND status='given' AND amount IS NOT NULL ORDER BY given_at DESC, id DESC LIMIT 1`).get(med.id);
  if (last) return { amount: last.amount, unit: last.unit, source: 'last' };
  if (med.form !== 'multi_vial' && med.conc && med.unit_ml) return { amount: round(med.conc * med.unit_ml, 3), unit: med.conc_unit, source: 'unit' };
  return { amount: null, unit: med.conc_unit || 'mg', source: null };
}

// defaults for the log form
function logForm(u, { schedule_id, medication_id }) {
  let sched = schedule_id ? getRow('schedules', schedule_id) : null;
  const med = getRow('medications', sched ? sched.medication_id : medication_id); if (!med) throw httpErr(404, 'Medication not found');
  mustLog(u, med.patient_id);
  if (!sched) sched = schedulesFor(med.id).find(s => !s.paused) || null;
  const info = sched ? schedInfo(sched) : null;
  const dose = defaultDose(med, sched, info && info.due_at ? new Date(info.due_at) : new Date());
  const schedDose = sched ? S.doseFor(sched, stepsFor(sched.id), info.due_at ? new Date(info.due_at) : new Date()) : null;
  const vol = volumeFor(med, dose.amount, dose.unit), qty = qtyFor(med, vol);
  const lots = lotsFor(med.id).map(l => ({ ...l, usable: lotUsable(l) })), lot = pickLot(med, qty);
  const sites = siteUsage(med.patient_id), site = suggestSite(med.patient_id);
  return { medication: medOut(med), schedule: info, dose_amount: dose.amount, dose_unit: dose.unit, dose_source: dose.source,
    schedule_dose: schedDose && schedDose.amount != null ? schedDose : null, volume_ml: vol, qty_used: qty,
    lots, lot_id: lot ? lot.id : null, sites, site_id: site ? site.id : null, patient: patientOut(getRow('patients', med.patient_id)) };
}

// ---------- reports ----------
function reportRows(u, { patient_id, from, to }) {
  const pids = patient_id ? [+patient_id] : patientIds(u);
  for (const p of pids) mustSee(u, p);
  if (!pids.length) return [];
  const f = from || '0000', t = to ? to + 'T23:59:59.999Z' : '9999';
  return q(`SELECT * FROM doses WHERE deleted=0 AND patient_id IN (${pids.map(() => '?').join(',')}) AND COALESCE(given_at, due_at, created_at) BETWEEN ? AND ? ORDER BY COALESCE(given_at, due_at, created_at) DESC, id DESC`)
    .all(...pids, from ? new Date(S.parseYmd(from)).toISOString() : f, to ? new Date(S.at(S.parseYmd(to), '23:59')).toISOString() : t).map(doseOut);
}
function adherence(rows) {
  const a = { scheduled: 0, on_time: 0, late: 0, skipped: 0, missed: 0, extra: 0 };
  for (const d of rows) {
    if (!d.schedule_id || !d.due_at) { if (d.status === 'given') a.extra++; continue; }
    a.scheduled++;
    if (d.status === 'given') a[d.timing === 'late' ? 'late' : 'on_time']++; else a[d.status]++;
  }
  a.rate = a.scheduled ? Math.round(100 * (a.on_time + a.late) / a.scheduled) : null;
  return a;
}
const csvCell = v => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ---------- calendar feed ----------
function icsFor(u) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShotTracker//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:ShotTracker', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const until = S.addDays(new Date(), 180), url = appUrl();
  for (const pid of patientIds(u)) {
    const p = getRow('patients', pid);
    for (const s of schedulesOfPatient(pid)) {
      if (s.paused) continue;
      const med = getRow('medications', s.medication_id);
      for (const d of S.upcoming(s, lastDose(s.id), until)) {
        const dose = S.doseFor(s, stepsFor(s.id), d);
        lines.push('BEGIN:VEVENT', `UID:st-${s.id}-${d.getTime()}@shottracker`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(d)}`, `DTEND:${stamp(new Date(d.getTime() + 15 * 60e3))}`,
          `SUMMARY:${esc(`${p.name}: ${med.name}` + (dose.amount != null ? ` ${dose.amount} ${dose.unit}` : ''))}`,
          `DESCRIPTION:${esc((med.storage === 'fridge' ? 'Take it out of the fridge about 30 minutes before.\n' : '') + (url ? url + '/#log/' + s.id : ''))}`, 'END:VEVENT');
      }
    }
    for (const d of q(`SELECT * FROM doses WHERE patient_id=? AND deleted=0 AND status='given' AND given_at>=? ORDER BY given_at`).all(pid, S.addDays(new Date(), -90).toISOString())) {
      const med = getRow('medications', d.medication_id) || { name: 'Shot' }, t = new Date(d.given_at);
      const day = S.ymd(t).replace(/-/g, ''), next = S.ymd(S.addDays(t, 1)).replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:st-dose-${d.id}@shottracker`, `DTSTAMP:${stamp(new Date())}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${esc(`✓ ${p.name}: ${med.name} given`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(l => { const out = []; let s = l; while (Buffer.byteLength(s) > 74) { let i = 74; while (Buffer.byteLength(s.slice(0, i)) > 74) i--; out.push(s.slice(0, i)); s = ' ' + s.slice(i); } out.push(s); return out.join('\r\n'); }).join('\r\n') + '\r\n';
}

// ---------- reminders ----------
const actionSig = s => crypto.createHmac('sha256', KEY).update(s).digest('hex').slice(0, 12);
const inQuiet = (u, d = new Date()) => {
  const m = d.getHours() * 60 + d.getMinutes(), [a, b] = [u.quiet_start, u.quiet_end].map(t => { const [h, mm] = String(t || '00:00').split(':').map(Number); return h * 60 + mm; });
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
};
const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDay = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
function recipients(pid) {
  return q('SELECT * FROM users WHERE disabled=0 AND reminders_on=1').all().filter(u => canLog(u, pid) && (u.notify_ha || (u.email_reminders && u.email)));
}
const delivery = new Map(); // last delivery results for the settings page
async function deliver(u, channelMsg) {
  const c = cfg(), results = [];
  if (u.notify_ha && c.ha_url && c.ha_token) {
    try { await N.haPush(c, u.notify_ha, channelMsg); results.push(['ha', 'ok']); } catch (e) { results.push(['ha', e.message]); }
  }
  if (channelMsg.email !== false && u.email && (channelMsg.forceEmail || u.email_reminders) && c.smtp_host) {
    try { await N.smtpSend(c, u.email, channelMsg.title, channelMsg.message + (channelMsg.url ? '\n\n' + channelMsg.url : '')); results.push(['email', 'ok']); } catch (e) { results.push(['email', e.message]); }
  }
  delivery.set(u.id, { at: now(), results });
  return results;
}
function reminderText(step, p, med, due, dose) {
  const what = `${p.name}: ${med.name}` + (dose.amount != null ? ` ${dose.amount} ${dose.unit}` : '');
  const fridge = med.storage === 'fridge' ? ' Take it out of the fridge about 30 minutes before.' : '';
  if (step === 'day_before') return { title: 'Shot tomorrow', message: `${what} is due tomorrow at ${fmtTime(due)}.${fridge}` };
  if (step === 'morning') return { title: 'Shot today', message: `${what} is due today at ${fmtTime(due)}.${fridge}` };
  if (step === 'due') return { title: 'Shot due now', message: `${what} is due now.` };
  return { title: 'Shot not logged yet', message: `${what} was due ${fmtDay(due)} at ${fmtTime(due)} and hasn't been logged.` };
}
// mark calendar/weekday doses missed once the following one has come due
function autoMiss(s, n) {
  if (s.anchor === 'last' && s.kind !== 'weekdays') return;
  for (let i = 0; i < 50; i++) {
    const last = lastDose(s.id), due = S.nextDue(s, last); if (!due) return;
    const following = S.nextDue(s, { due_at: due.toISOString(), given_at: due.toISOString(), status: 'missed' });
    if (!following || n < following) return;
    const med = getRow('medications', s.medication_id), id = insert('doses', { patient_id: med.patient_id, medication_id: med.id, schedule_id: s.id, due_at: due.toISOString(), status: 'missed', reason: 'Not logged before the next one was due', source: 'auto' });
    audit(null, 'auto-missed', 'doses', id);
  }
}
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const n = new Date(), c = cfg();
    const dayBefore = c.remind_day_before, morning = c.remind_morning, repeatMs = Math.max(15, +c.repeat_min || 60) * 60e3;
    for (const s of q('SELECT s.* FROM schedules s JOIN medications m ON m.id=s.medication_id JOIN patients p ON p.id=m.patient_id WHERE s.deleted=0 AND s.paused=0 AND m.deleted=0 AND m.active=1 AND p.deleted=0').all()) {
      autoMiss(s, n);
      const due = S.nextDue(s, lastDose(s.id)); if (!due) continue;
      const med = getRow('medications', s.medication_id), p = getRow('patients', med.patient_id), dose = S.doseFor(s, stepsFor(s.id), due);
      const graceEnd = due.getTime() + s.grace_min * 60e3, dueIso = due.toISOString();
      const snz = q('SELECT until FROM snoozes WHERE schedule_id=? AND due_at=?').get(s.id, dueIso);
      // the reminder steps for this dose, oldest first
      const steps = [];
      const db1 = S.at(S.addDays(due, -1), dayBefore); if (due - db1 > 3600e3) steps.push(['day_before', db1]);
      const mo = S.at(due, morning); if (mo < due && mo > db1) steps.push(['morning', mo]);
      steps.push(['due', due]);
      if (n.getTime() >= graceEnd) { const k = Math.floor((n.getTime() - graceEnd) / repeatMs) + 1; steps.push(['repeat:' + k, new Date(graceEnd + (k - 1) * repeatMs)]); }
      if (snz) { if (snz.until > n.getTime()) continue; steps.push(['snooze:' + snz.until, new Date(snz.until)]); steps.sort((a, b) => a[1] - b[1]); }
      const current = steps.filter(([, t]) => t <= n).pop(); if (!current) continue;
      const [step, t] = current;
      if (n - t > 6 * 3600e3 && !step.startsWith('repeat')) continue; // don't send stale ones after downtime
      for (const u of recipients(p.id)) {
        if (step !== 'due' && inQuiet(u, n)) continue; // held until quiet hours end
        const ch = 'all';
        if (q('SELECT 1 FROM reminders WHERE schedule_id=? AND due_at=? AND user_id=? AND step=? AND channel=?').get(s.id, dueIso, u.id, step, ch)) continue;
        q('INSERT INTO reminders(schedule_id, due_at, user_id, step, channel, sent_at, result) VALUES(?,?,?,?,?,?,?)').run(s.id, dueIso, u.id, step, ch, now(), 'sending');
        const text = reminderText(step.split(':')[0], p, med, due, dose), url = appUrl() ? `${appUrl()}/#log/${s.id}` : undefined;
        const base = `${s.id}_${due.getTime()}_${u.id}`, actions = [];
        if (url) actions.push({ action: 'URI', title: 'Open', uri: url });
        if (step !== 'day_before') actions.push({ action: `ST_GIVEN_${base}_${actionSig('GIVEN_' + base)}`, title: 'Given now', destructive: false });
        actions.push({ action: `ST_SNOOZE_${base}_${actionSig('SNOOZE_' + base)}`, title: 'Snooze 1 hour' });
        const r = await deliver(u, { ...text, url, tag: `shottracker-${s.id}`, actions });
        q('UPDATE reminders SET result=? WHERE schedule_id=? AND due_at=? AND user_id=? AND step=? AND channel=?').run(r.map(x => x.join(': ')).join('; ') || 'no channel', s.id, dueIso, u.id, step, ch);
      }
    }
    await alertTick(n, c);
    await digestTick(n, c);
    await sensorsTick(n, c);
    await backupTick(n, c);
  } catch (e) { console.error('reminder engine:', e); }
  finally { ticking = false; }
}
async function alertTick(n, c) {
  if (c.alerts_push !== '1') return;
  for (const u of q(`SELECT * FROM users WHERE disabled=0 AND reminders_on=1 AND role IN ('admin','caregiver') AND notify_ha<>''`).all()) {
    if (inQuiet(u, n)) continue;
    for (const a of alertsFor(patientIds(u)).filter(a => a.level !== 'info')) {
      const prev = q('SELECT sent_at FROM alert_log WHERE key=? AND user_id=?').get(a.key, u.id);
      if (prev && n.getTime() - prev.sent_at < 3 * 86400e3) continue;
      q('INSERT OR REPLACE INTO alert_log VALUES(?,?,?)').run(a.key, u.id, n.getTime());
      await deliver(u, { title: 'ShotTracker', message: a.text, url: appUrl() ? appUrl() + '/#inventory' : undefined, tag: 'shottracker-' + a.key, email: false });
    }
  }
}
function digestText(u, n) {
  const lines = [], tom = S.ymd(S.addDays(n, 1));
  for (const v of todayView(u)) for (const s of v.schedules) {
    if (!s.due_at) continue;
    const d = new Date(s.due_at), day = S.ymd(d);
    if (s.status === 'overdue') lines.push(`OVERDUE  ${v.patient.name}: ${s.med_name} (was due ${fmtDay(d)} ${fmtTime(d)})`);
    else if (day === S.ymd(n)) lines.push(`Today    ${v.patient.name}: ${s.med_name} at ${fmtTime(d)}`);
    else if (day === tom) lines.push(`Tomorrow ${v.patient.name}: ${s.med_name} at ${fmtTime(d)}` + (s.storage === 'fridge' ? ' (fridge)' : ''));
  }
  const al = alertsFor(patientIds(u));
  if (!lines.length && !al.length) return null;
  return (lines.length ? 'Shots\n' + lines.join('\n') + '\n\n' : '') + (al.length ? 'Heads-up\n' + al.map(a => '- ' + a.text).join('\n') + '\n' : '') + (appUrl() ? '\n' + appUrl() + '\n' : '');
}
async function digestTick(n, c) {
  if (!c.smtp_host) return;
  const [h, m] = c.digest_time.split(':').map(Number); if (n.getHours() * 60 + n.getMinutes() < h * 60 + m) return;
  for (const u of q(`SELECT * FROM users WHERE disabled=0 AND email_digest=1 AND email<>''`).all()) {
    const key = 'digest:' + S.ymd(n);
    if (q('SELECT 1 FROM alert_log WHERE key=? AND user_id=?').get(key, u.id)) continue;
    q('INSERT INTO alert_log VALUES(?,?,?)').run(key, u.id, n.getTime());
    const text = digestText(u, n); if (!text) continue;
    try { await N.smtpSend(c, u.email, `ShotTracker: ${fmtDay(n)}`, text); } catch (e) { console.error('digest email:', e.message); }
  }
}
let lastSensors = 0;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x';
async function sensorsTick(n, c, force = false) {
  if (c.ha_sensors !== '1' || !c.ha_url || !c.ha_token) return;
  if (!force && n.getTime() - lastSensors < 5 * 60e3) return;
  lastSensors = n.getTime();
  let overdue = 0;
  try {
    for (const p of q('SELECT * FROM patients WHERE deleted=0').all()) for (const s of schedulesOfPatient(p.id)) {
      const i = schedInfo(s, n); if (!i) continue; if (i.status === 'overdue') overdue++;
      const med = getRow('medications', s.medication_id);
      await N.haState(c, `sensor.shottracker_${slug(p.name)}_${slug(med.name)}`, i.due_at || 'unknown', {
        friendly_name: `${p.name} ${med.name} next shot`, device_class: 'timestamp', icon: 'mdi:needle', status: i.status,
        dose: i.dose_amount != null ? `${i.dose_amount} ${i.dose_unit}` : null, days_of_supply: daysOfSupply(med), stock: stockOf(med), last_given: i.last_given,
      });
    }
    await N.haState(c, 'sensor.shottracker_overdue', overdue, { friendly_name: 'ShotTracker overdue shots', icon: 'mdi:needle-off', state_class: 'measurement' });
  } catch (e) { console.error('HA sensors:', e.message); }
}
// notification buttons pressed in the Home Assistant app
function onHaAction(action) {
  const m = /^ST_(GIVEN|SNOOZE)_(\d+)_(\d+)_(\d+)_([0-9a-f]{12})$/.exec(action); if (!m) return;
  const [, kind, sid, dueTs, uid, sig] = m;
  if (!safeEq(sig, actionSig(`${kind}_${sid}_${dueTs}_${uid}`))) return;
  const u = q('SELECT * FROM users WHERE id=? AND disabled=0').get(+uid), s = getRow('schedules', +sid); if (!u || !s) return;
  const due = new Date(+dueTs).toISOString();
  const cur = S.nextDue(s, lastDose(s.id)); if (!cur || cur.toISOString() !== due) return; // already handled
  if (kind === 'SNOOZE') { q('INSERT OR REPLACE INTO snoozes VALUES(?,?,?)').run(s.id, due, Date.now() + 3600e3); audit(u.id, 'snooze', 'schedules', s.id, null, { due_at: due }); }
  else { try { logDose(u, { medication_id: s.medication_id, schedule_id: s.id, status: 'given', due_at: due, notes: 'Logged from a notification' }, 'notification'); } catch (e) { console.error('notification log:', e.message); } }
}
const haLink = N.haListen(() => { const c = cfg(); return { ha_url: c.ha_url, ha_token: c.ha_token }; }, onHaAction);

// ---------- backups (encrypted with a passphrase, so they can be restored on a new install) ----------
const BK_MAGIC = Buffer.from('STBK1');
function makeBackup(pass, label = 'auto') {
  const tmp = path.join(BACKUPS, '.tmp-' + process.pid + '.db'); fs.rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const raw = zlib.gzipSync(fs.readFileSync(tmp)); fs.rmSync(tmp, { force: true });
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(pass, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv), enc = Buffer.concat([c.update(raw), c.final()]);
  const name = `shottracker-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${label}.stbk`;
  const file = path.join(BACKUPS, name);
  fs.writeFileSync(file, Buffer.concat([BK_MAGIC, salt, iv, c.getAuthTag(), enc]), { mode: 0o600 });
  if (BACKUP_COPY_DIR) try { fs.copyFileSync(file, path.join(BACKUP_COPY_DIR, name)); } catch (e) { console.error('backup copy:', e.message); }
  const keep = Math.max(1, +setting('backup_keep') || 30);
  listBackups().filter(b => b.name.endsWith('.stbk')).slice(keep).forEach(b => fs.rmSync(path.join(BACKUPS, b.name), { force: true }));
  return name;
}
function openBackup(buf, pass) {
  if (buf.length < 50 || !buf.subarray(0, 5).equals(BK_MAGIC)) throw httpErr(400, 'That is not a ShotTracker backup file');
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49), key = crypto.scryptSync(String(pass || ''), salt, 32);
  let raw; try { const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); raw = Buffer.concat([d.update(buf.subarray(49)), d.final()]); } catch { throw httpErr(400, 'Wrong backup passphrase, or the file is damaged'); }
  const dbuf = zlib.gunzipSync(raw);
  if (!dbuf.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'))) throw httpErr(400, 'The backup does not contain a database');
  return dbuf;
}
const listBackups = () => fs.readdirSync(BACKUPS).filter(f => /\.(stbk|db)$/.test(f)).map(f => { const st = fs.statSync(path.join(BACKUPS, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; }).sort((a, b) => b.at.localeCompare(a.at));
async function backupTick(n, c) {
  if (!c.backup_pass) return;
  const [h, m] = c.backup_time.split(':').map(Number); if (n.getHours() * 60 + n.getMinutes() < h * 60 + m) return;
  const key = 'backup:' + S.ymd(n);
  if (q('SELECT 1 FROM alert_log WHERE key=? AND user_id=0').get(key)) return;
  q('INSERT INTO alert_log VALUES(?,0,?)').run(key, n.getTime());
  try { makeBackup(c.backup_pass, 'auto'); } catch (e) { console.error('backup:', e.message); }
}

// ---------- NFC tags ----------
// A tag holds only a short link (/t/<code>). The code isn't a password: opening it still needs a signed-in user,
// and what it opens is checked against that user's access. Changing a tag here never needs the tag rewritten.
const TAG_ACTIONS = ['today', 'log_schedule', 'log_med', 'patient', 'receive'];
function tagTarget(t) {
  if (t.action === 'today') return { pid: null, label: 'Open Today', hash: 'today' };
  if (t.action === 'log_schedule') { const sc = getRow('schedules', t.target_id), m = sc && getRow('medications', sc.medication_id), p = m && getRow('patients', m.patient_id); return p && { pid: p.id, label: `Log shot: ${p.name} · ${m.name} (${S.describe(sc).toLowerCase()})`, hash: 'log/' + sc.id }; }
  const m = ['log_med', 'receive'].includes(t.action) && getRow('medications', t.target_id), mp = m && getRow('patients', m.patient_id);
  if (t.action === 'log_med') return mp && { pid: mp.id, label: `Log shot: ${mp.name} · ${m.name}`, hash: 'logmed/' + m.id };
  if (t.action === 'receive') return mp && { pid: mp.id, label: `Receive shipment: ${mp.name} · ${m.name}`, hash: 'receive/' + m.id };
  if (t.action === 'patient') { const p = getRow('patients', t.target_id); return p && { pid: p.id, label: `Open ${p.name}`, hash: 'patient/' + p.id }; }
  return null;
}
const tagUrl = (req, code) => (appUrl() || `${isSecure(req) ? 'https' : 'http'}://${(trusted(req) && req.headers['x-forwarded-host']) || req.headers.host}`) + '/t/' + code;
function tagOut(req, t) {
  const tg = tagTarget(t), by = t.last_user ? q('SELECT name FROM users WHERE id=?').get(t.last_user) : null;
  return { id: t.id, code: t.code, name: t.name, action: t.action, target_id: t.target_id, label: tg ? tg.label : 'Target was removed', broken: !tg, url: tagUrl(req, t.code), taps: t.taps, last_tap: t.last_tap, last_user: by ? by.name : null };
}
function tagChoices(u) {
  const pids = patientIds(u).filter(pid => canManage(u, pid)), out = { patients: [], meds: [], schedules: [] };
  for (const pid of pids) {
    const p = getRow('patients', pid); out.patients.push({ id: p.id, label: p.name });
    for (const m of q('SELECT * FROM medications WHERE patient_id=? AND deleted=0 AND active=1 ORDER BY name').all(pid)) {
      out.meds.push({ id: m.id, label: `${p.name} · ${m.name}` });
      for (const sc of schedulesFor(m.id)) out.schedules.push({ id: sc.id, label: `${p.name} · ${m.name} (${S.describe(sc).toLowerCase()})` });
    }
  }
  return out;
}
const TAG_SPEC = { name: F.s(60), action: F.one(TAG_ACTIONS), target_id: F.int(1) };

// ---------- API ----------
const needUser = req => { if (!req.user) throw httpErr(401, 'Please sign in'); return req.user; };
const needRole = (req, ...roles) => { const u = needUser(req); if (!roles.includes(u.role)) throw httpErr(403, 'Not allowed for your role'); return u; };
const adminCount = () => q(`SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0`).get().n;
function checkNewPassword(pw) { if (String(pw || '').length < 12) throw httpErr(400, 'Passwords need at least 12 characters'); if (String(pw).length > 200) throw httpErr(400, 'Password too long'); }
function validUsername(s) { const v = str(s, 40); if (!/^[a-zA-Z0-9._-]{3,40}$/.test(v)) throw httpErr(400, 'User names are 3-40 letters, numbers, dots, dashes or underscores'); return v; }
const idOf = v => { const n = +v; if (!Number.isInteger(n) || n < 1) throw httpErr(404, 'Not found'); return n; };

const PATIENT_SPEC = { name: F.s(80), birth_date: F.date, color: v => COLORS.includes(v) ? v : COLORS[0], notes: F.s(2000) };
const MED_SPEC = { name: F.s(80), generic: F.s(80), form: F.one(FORMS), conc: F.num(0), conc_unit: F.one(['mg', 'mcg', 'units']), unit_ml: F.num(0), route: F.one(['SubQ', 'IM', 'IV', 'ID', 'other']),
  storage: F.one(['fridge', 'room', 'freezer']), opened_days: F.int(0, 3650), prescriber: F.s(80), pharmacy: F.s(80), pharmacy_phone: F.s(40), rx_number: F.s(40),
  refills_left: F.int(0, 99), next_shipment: F.date, reorder_days: F.int(0, 365), ndc: F.s(20), notes: F.s(2000), active: F.bool };
const LOT_SPEC = { lot_number: F.s(40), ndc: F.s(20), expires: F.date, qty_received: F.num(0), qty_left: F.num(0), received: F.date, opened: F.date, discard_by: F.date, location: F.s(60), notes: F.s(500) };
const SCHED_SPEC = { kind: F.one(['days', 'weeks', 'months', 'weekdays']), every: F.int(1, 365), weekdays: v => String(v || '').split(',').filter(x => /^[0-6]$/.test(x)).join(','),
  time_of_day: F.time, grace_min: F.int(0, 2880), anchor: F.one(['calendar', 'last']), start_date: F.date, end_date: F.date, paused: F.bool, dose_amount: F.num(0), dose_unit: F.one(AMOUNT_UNITS) };
const SUPPLY_SPEC = { name: F.s(80), kind: F.one(['item', 'sharps']), qty: F.num(0), unit: F.s(20), reorder_at: F.num(0), per_shot: F.num(0, 100), capacity: F.num(0) };
const SITE_SPEC = { name: F.s(40), view: F.one(['front', 'back']), x: F.num(0, 100), y: F.num(0, 100), rest_days: F.int(0, 90), enabled: F.bool, sort: F.int(0, 1000) };

async function api(req, res, seg, url) {
  const m = req.method, ip = clientIp(req), qs = Object.fromEntries(url.searchParams);
  const route = m + ' /' + seg.join('/');
  req.user = userFrom(req);

  if (route === 'GET /health') return send(res, 200, { ok: true, version: VERSION });
  if (route === 'GET /state') {
    const users = q('SELECT COUNT(*) n FROM users').get().n;
    return send(res, 200, { version: VERSION, setup: users === 0, user: req.user ? meOut(req.user) : null });
  }

  // ----- sign-in -----
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
    const lk = 'user:' + u.username.toLowerCase();
    if (locked('ip:' + ip, lk)) throw httpErr(429, 'Too many tries. Wait 15 minutes and try again.');
    const code = String(b.code || '').trim();
    let recovery = null;
    if (tk.mode === 'enroll') {
      const step = totpStep(tk.secret, code);
      if (!step) { failed('ip:' + ip, lk); throw httpErr(401, 'That code didn\'t match. Check the time on your phone and try the newest code.'); }
      const rc = newRecovery(); recovery = rc.codes;
      q('UPDATE users SET totp=?, totp_on=1, totp_last=?, recovery=?, updated_at=? WHERE id=?').run(seal(tk.secret), step, JSON.stringify(rc.hashes), now(), u.id);
      audit(u.id, 'totp-enrolled', 'users', u.id);
    } else {
      const step = totpStep(unseal(u.totp), code, u.totp_last);
      if (step) q('UPDATE users SET totp_last=? WHERE id=?').run(step, u.id);
      else {
        const hashes = JSON.parse(u.recovery || '[]'), h = sha(code.toLowerCase().replace(/[^a-z0-9]/g, '')), i = hashes.indexOf(h);
        if (i < 0) { failed('ip:' + ip, lk); throw httpErr(401, 'That code didn\'t match'); }
        hashes.splice(i, 1); q('UPDATE users SET recovery=? WHERE id=?').run(JSON.stringify(hashes), u.id);
        audit(u.id, 'recovery-code-used', 'users', u.id, null, { left: hashes.length });
      }
    }
    tickets.delete(String(b.ticket));
    succeeded('ip:' + ip, lk);
    startSession(req, res, u, tk.remember);
    audit(u.id, 'login', 'users', u.id, null, { ip });
    return send(res, 200, { user: meOut(u), recovery });
  }
  if (route === 'POST /logout') { if (req.user) q('DELETE FROM sessions WHERE token=?').run(req.user.sessionToken); clearCookie(req, res); return send(res, 200, { ok: true }); }
  if (route === 'POST /logout-all') { const u = needUser(req); q('DELETE FROM sessions WHERE user_id=?').run(u.id); clearCookie(req, res); audit(u.id, 'logout-all', 'users', u.id); return send(res, 200, { ok: true }); }

  // ----- my account -----
  if (route === 'GET /me') { const u = needUser(req); return send(res, 200, { ...meOut(u), prefs: prefsOut(u), last_delivery: delivery.get(u.id) || null, recovery_left: JSON.parse(u.recovery || '[]').length }); }
  if (route === 'PUT /me/prefs') {
    const u = needUser(req), b = await readJson(req);
    const v = clean({ notify_ha: F.s(100), email: F.s(120), email_reminders: F.bool, email_digest: F.bool, reminders_on: F.bool, quiet_start: F.time, quiet_end: F.time }, b);
    if (v.notify_ha && !/^[a-z0-9_]+$/.test(v.notify_ha)) throw httpErr(400, 'Notification name looks wrong');
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) throw httpErr(400, 'Email address looks wrong');
    update('users', u.id, v); audit(u.id, 'update-prefs', 'users', u.id, prefsOut(u), v);
    return send(res, 200, prefsOut(q('SELECT * FROM users WHERE id=?').get(u.id)));
  }
  if (route === 'POST /me/ics') {
    const u = needUser(req); update('users', u.id, { ics_token: crypto.randomBytes(24).toString('base64url') }); audit(u.id, 'new-calendar-link', 'users', u.id);
    return send(res, 200, prefsOut(q('SELECT * FROM users WHERE id=?').get(u.id)));
  }
  if (route === 'POST /me/test') {
    const u = needUser(req);
    const r = await deliver(u, { title: 'ShotTracker test', message: 'Notifications from ShotTracker reach this device.', url: appUrl() || undefined, tag: 'shottracker-test', forceEmail: true });
    return send(res, 200, { results: r });
  }
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
  // ----- drug lookup by NDC (FDA NDC Directory); only the number leaves the server -----
  if (seg[0] === 'ndc' && seg[1] && m === 'GET') {
    needRole(req, 'admin', 'caregiver');
    if (setting('ndc_lookup') !== '1') return send(res, 200, { found: false, disabled: true });
    const key = NDC.digits(seg[1]).slice(0, 11) + (seg[1].includes('-') ? ':' + str(seg[1], 14) : '');
    const hit = q('SELECT * FROM ndc_cache WHERE ndc=?').get(key);
    if (hit) { const d = JSON.parse(hit.data); if (Date.now() - hit.fetched_at < (d.found ? 30 : 1) * 86400e3) return send(res, 200, { ...d, cached: true }); }
    let d;
    try { d = await NDC.lookup(decodeURIComponent(seg[1]), { base: OPENFDA_URL, apiKey: setting('openfda_key') }); }
    catch (e) { if (e.code === 400) throw httpErr(400, e.message); throw httpErr(502, e.name === 'TimeoutError' || /fetch failed/.test(e.message) ? 'Couldn\'t reach the FDA lookup (api.fda.gov). Check the app\'s internet access.' : e.message); }
    q('INSERT OR REPLACE INTO ndc_cache VALUES(?,?,?)').run(key, JSON.stringify(d), Date.now());
    return send(res, 200, d);
  }
  if (route === 'GET /ha/services') { needUser(req); const c = cfg(); if (!c.ha_url || !c.ha_token) return send(res, 200, []); try { return send(res, 200, await N.haNotifyServices(cfg())); } catch (e) { throw httpErr(502, e.message); } }

  // ----- today, alerts -----
  if (route === 'GET /today') { const u = needUser(req); return send(res, 200, { patients: todayView(u), alerts: alertsFor(patientIds(u)), now: now() }); }
  if (route === 'GET /alerts') { const u = needUser(req); return send(res, 200, alertsFor(patientIds(u))); }

  // ----- patients -----
  if (seg[0] === 'patients') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    if (m === 'GET' && !id) return send(res, 200, patientIds(u).map(i => patientOut(getRow('patients', i))).sort((a, b) => a.name.localeCompare(b.name)));
    if (m === 'POST' && !id) {
      if (!['admin', 'caregiver'].includes(u.role)) throw httpErr(403, 'Not allowed for your role');
      const v = clean(PATIENT_SPEC, await readJson(req)); need(v, 'name');
      const pid = tx(() => { const pid = insert('patients', { color: COLORS[0], ...v }); seedSites(pid); if (u.role === 'caregiver') q('INSERT OR IGNORE INTO patient_access VALUES(?,?)').run(u.id, pid); return pid; });
      audit(u.id, 'create', 'patients', pid, null, v);
      return send(res, 200, patientOut(getRow('patients', pid)));
    }
    mustSee(u, id);
    const before = getRow('patients', id);
    if (m === 'GET' && seg.length === 2) {
      const meds = q('SELECT * FROM medications WHERE patient_id=? AND deleted=0 ORDER BY active DESC, name').all(id).map(med => ({
        ...medOut(med), lots: lotsFor(med.id).map(l => ({ ...l, usable: lotUsable(l) })),
        schedules: schedulesFor(med.id).map(s => ({ ...s, paused: !!s.paused, deleted: undefined, steps: stepsFor(s.id), info: schedInfo(s) })),
      }));
      const weights = q('SELECT id, date, lb FROM weights WHERE patient_id=? AND deleted=0 ORDER BY date DESC').all(id);
      return send(res, 200, { patient: patientOut(before), medications: meds, sites: siteUsage(id), weights, can_manage: canManage(u, id), can_log: canLog(u, id) });
    }
    if (m === 'PUT' && seg.length === 2) {
      mustManage(u, id);
      const v = clean(PATIENT_SPEC, await readJson(req)); need({ ...before, ...v }, 'name');
      update('patients', id, v); audit(u.id, 'update', 'patients', id, patientOut(before), v);
      return send(res, 200, patientOut(getRow('patients', id)));
    }
    if (m === 'DELETE' && seg.length === 2) {
      if (u.role !== 'admin') throw httpErr(403, 'Only an admin can remove a patient');
      update('patients', id, { deleted: 1 }); audit(u.id, 'delete', 'patients', id, patientOut(before), null);
      return send(res, 200, { ok: true });
    }
    if (seg[2] === 'sites' && m === 'PUT') {
      mustManage(u, id);
      const b = await readJson(req); if (!Array.isArray(b.sites)) throw httpErr(400, 'sites must be a list');
      tx(() => {
        const keep = new Set();
        b.sites.slice(0, 40).forEach((raw, i) => {
          const v = clean(SITE_SPEC, { ...raw, sort: i }); need(v, 'name');
          const ex = raw.id ? q('SELECT * FROM sites WHERE id=? AND patient_id=? AND deleted=0').get(raw.id, id) : null;
          if (ex) { update('sites', ex.id, v); keep.add(ex.id); } else keep.add(insert('sites', { patient_id: id, x: 50, y: 50, ...v }));
        });
        for (const s of q('SELECT id FROM sites WHERE patient_id=? AND deleted=0').all(id)) if (!keep.has(s.id)) update('sites', s.id, { deleted: 1 });
      });
      audit(u.id, 'update', 'sites', id, null, { count: b.sites.length });
      return send(res, 200, siteUsage(id));
    }
    if (seg[2] === 'weights') {
      if (m === 'POST' && seg.length === 3) {
        mustLog(u, id); const v = clean({ date: F.date, lb: F.num(1, 1000) }, await readJson(req)); need(v, 'date', 'lb');
        const wid = insert('weights', { patient_id: id, ...v }); audit(u.id, 'create', 'weights', wid, null, v);
        return send(res, 200, { id: wid, ...v });
      }
      if (m === 'DELETE' && seg[3]) { mustManage(u, id); const wid = idOf(seg[3]); q('UPDATE weights SET deleted=1 WHERE id=? AND patient_id=?').run(wid, id); audit(u.id, 'delete', 'weights', wid); return send(res, 200, { ok: true }); }
    }
  }

  // ----- medications -----
  if (seg[0] === 'meds') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    if (m === 'POST' && !id) {
      const b = await readJson(req), pid = idOf(b.patient_id); mustManage(u, pid);
      const v = clean(MED_SPEC, b); need(v, 'name', 'form');
      const mid = insert('medications', { patient_id: pid, storage: 'fridge', route: 'SubQ', active: 1, ...v }); audit(u.id, 'create', 'medications', mid, null, v);
      return send(res, 200, medOut(getRow('medications', mid)));
    }
    const before = getRow('medications', id); if (!before) throw httpErr(404, 'Medication not found');
    mustManage(u, before.patient_id);
    if (m === 'PUT') { const v = clean(MED_SPEC, await readJson(req)); update('medications', id, v); audit(u.id, 'update', 'medications', id, before, v); return send(res, 200, medOut(getRow('medications', id))); }
    if (m === 'DELETE') { update('medications', id, { deleted: 1 }); audit(u.id, 'delete', 'medications', id, before, null); return send(res, 200, { ok: true }); }
  }

  // ----- lots -----
  if (route === 'GET /lots/search') {
    const u = needUser(req), term = '%' + str(qs.q, 40) + '%';
    const pids = patientIds(u); if (!pids.length || !str(qs.q)) return send(res, 200, []);
    const lots = q(`SELECT l.*, m.name med_name, m.patient_id FROM lots l JOIN medications m ON m.id=l.medication_id WHERE l.deleted=0 AND l.lot_number LIKE ? AND m.patient_id IN (${pids.map(() => '?').join(',')})`).all(term, ...pids);
    return send(res, 200, lots.map(l => ({ ...l, patient_name: getRow('patients', l.patient_id)?.name, doses: q('SELECT * FROM doses WHERE lot_id=? AND deleted=0 ORDER BY given_at DESC').all(l.id).map(doseOut) })));
  }
  if (seg[0] === 'lots') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    if (m === 'POST' && !id) {
      const b = await readJson(req), med = getRow('medications', b.medication_id); if (!med) throw httpErr(400, 'Medication not found'); mustManage(u, med.patient_id);
      const v = clean(LOT_SPEC, b); need(v, 'qty_received');
      const ship = clean({ next_shipment: F.date }, b, { next_shipment: 'Next shipment' });
      const lid = tx(() => {
        const lid = insert('lots', { medication_id: med.id, received: today(), location: med.storage === 'fridge' ? 'Fridge' : '', qty_left: v.qty_received, ...v });
        if (b.used_refill && med.refills_left > 0) update('medications', med.id, { refills_left: med.refills_left - 1 });
        if (ship.next_shipment !== undefined) update('medications', med.id, ship);
        return lid;
      });
      audit(u.id, 'create', 'lots', lid, null, v);
      return send(res, 200, getRow('lots', lid));
    }
    const before = getRow('lots', id); if (!before) throw httpErr(404, 'Lot not found');
    const med = getRow('medications', before.medication_id); mustManage(u, med.patient_id);
    if (m === 'PUT') { const v = clean(LOT_SPEC, await readJson(req)); update('lots', id, v); audit(u.id, 'update', 'lots', id, before, v); return send(res, 200, getRow('lots', id)); }
    if (m === 'DELETE') { update('lots', id, { deleted: 1 }); audit(u.id, 'delete', 'lots', id, before, null); return send(res, 200, { ok: true }); }
  }

  // ----- schedules (with dose steps) -----
  if (seg[0] === 'schedules') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    const saveSteps = (sid, steps) => {
      if (!Array.isArray(steps)) return;
      q('UPDATE schedule_steps SET deleted=1 WHERE schedule_id=?').run(sid);
      for (const st of steps.slice(0, 30)) { const v = clean({ start_date: F.date, dose_amount: F.num(0), dose_unit: F.one(AMOUNT_UNITS) }, st); need(v, 'start_date', 'dose_amount', 'dose_unit'); insert('schedule_steps', { schedule_id: sid, ...v }); }
    };
    const check = v => { if (v.kind === 'weekdays' && !v.weekdays) throw httpErr(400, 'Pick at least one weekday'); if (v.end_date && v.start_date && v.end_date < v.start_date) throw httpErr(400, 'End date is before the start date'); };
    if (m === 'POST' && !id) {
      const b = await readJson(req), med = getRow('medications', b.medication_id); if (!med) throw httpErr(400, 'Medication not found'); mustManage(u, med.patient_id);
      const v = { kind: 'weeks', every: 1, time_of_day: '20:00', grace_min: 120, anchor: 'calendar', start_date: today(), ...clean(SCHED_SPEC, b) }; check(v);
      const sid = tx(() => { const sid = insert('schedules', { medication_id: med.id, ...v }); saveSteps(sid, b.steps); return sid; });
      audit(u.id, 'create', 'schedules', sid, null, v);
      return send(res, 200, schedInfo(getRow('schedules', sid)));
    }
    const before = getRow('schedules', id); if (!before) throw httpErr(404, 'Schedule not found');
    const med = getRow('medications', before.medication_id); mustManage(u, med.patient_id);
    if (m === 'PUT') {
      const b = await readJson(req), v = clean(SCHED_SPEC, b); check({ ...before, ...v });
      tx(() => { update('schedules', id, v); saveSteps(id, b.steps); });
      audit(u.id, 'update', 'schedules', id, before, v);
      return send(res, 200, schedInfo(getRow('schedules', id)));
    }
    if (m === 'DELETE') { update('schedules', id, { deleted: 1 }); audit(u.id, 'delete', 'schedules', id, before, null); return send(res, 200, { ok: true }); }
    if (m === 'POST' && seg[2] === 'snooze') {
      mustLog(u, med.patient_id); const b = await readJson(req), mins = Math.min(1440, Math.max(5, +b.minutes || 60));
      const due = S.nextDue(before, lastDose(id)); if (!due) throw httpErr(400, 'Nothing is due');
      q('INSERT OR REPLACE INTO snoozes VALUES(?,?,?)').run(id, due.toISOString(), Date.now() + mins * 60e3); audit(u.id, 'snooze', 'schedules', id, null, { minutes: mins });
      return send(res, 200, schedInfo(getRow('schedules', id)));
    }
  }

  // ----- the shot log -----
  if (route === 'GET /log-form') { const u = needUser(req); return send(res, 200, logForm(u, { schedule_id: qs.schedule_id ? +qs.schedule_id : null, medication_id: qs.medication_id ? +qs.medication_id : null })); }
  if (seg[0] === 'doses') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    if (m === 'GET' && !id) return send(res, 200, reportRows(u, { patient_id: qs.patient_id, from: qs.from, to: qs.to }).slice(0, Math.min(1000, +qs.limit || 200)));
    if (m === 'POST' && !id) { const d = logDose(u, await readJson(req)); return send(res, 200, doseOut(d)); }
    const before = getRow('doses', id); if (!before) throw httpErr(404, 'Entry not found');
    mustLog(u, before.patient_id);
    if (m === 'PUT') {
      const b = await readJson(req);
      const { row } = buildDose(u, { ...b, medication_id: before.medication_id, schedule_id: before.schedule_id }, before);
      const d = tx(() => { applyStock(before, +1); update('doses', id, { ...row, given_by: row.status === 'given' ? (before.given_by || u.id) : null }); const d = getRow('doses', id); applyStock(d, -1); return d; });
      audit(u.id, 'update', 'doses', id, before, d);
      return send(res, 200, doseOut(d));
    }
    if (m === 'DELETE') { tx(() => { applyStock(before, +1); update('doses', id, { deleted: 1 }); }); audit(u.id, 'delete', 'doses', id, before, null); return send(res, 200, { ok: true }); }
  }

  // ----- NFC tags -----
  if (seg[0] === 'tags' && seg[1] === 'open' && seg[2] && m === 'GET') {
    const u = needUser(req), t = q('SELECT * FROM nfc_tags WHERE code=? AND deleted=0').get(str(seg[2], 40));
    const tg = t && tagTarget(t);
    if (!tg || (tg.pid && !canSee(u, tg.pid))) throw httpErr(404, 'This tag isn\'t set up, or it opens something you don\'t have access to.');
    q('UPDATE nfc_tags SET taps=taps+1, last_tap=?, last_user=? WHERE id=?').run(now(), u.id, t.id);
    return send(res, 200, { name: t.name, hash: tg.hash });
  }
  if (seg[0] === 'tags') {
    const u = needRole(req, 'admin'); // only the admin sets up tags; anyone signed in can tap one
    const id = seg[1] ? idOf(seg[1]) : null;
    const visible = t => { const tg = tagTarget(t); return !tg || !tg.pid || canManage(u, tg.pid) || u.role === 'admin'; };
    const check = v => {
      if (v.action === 'today') { v.target_id = null; return; }
      if (!v.target_id) throw httpErr(400, 'Pick what the tag opens');
      const tg = tagTarget(v); if (!tg) throw httpErr(400, 'That item was not found');
      mustManage(u, tg.pid);
    };
    if (m === 'GET' && !id) return send(res, 200, { tags: q('SELECT * FROM nfc_tags WHERE deleted=0 ORDER BY name COLLATE NOCASE').all().filter(visible).map(t => tagOut(req, t)), choices: tagChoices(u) });
    if (m === 'POST' && !id) {
      const v = clean(TAG_SPEC, await readJson(req)); need(v, 'name', 'action'); check(v);
      const tid = insert('nfc_tags', { code: crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x'), target_id: null, ...v });
      audit(u.id, 'create', 'nfc_tags', tid, null, v);
      return send(res, 200, tagOut(req, getRow('nfc_tags', tid)));
    }
    const before = getRow('nfc_tags', id); if (!before || !visible(before)) throw httpErr(404, 'Tag not found');
    if (m === 'PUT') {
      const v = { ...clean(TAG_SPEC, await readJson(req)) }; const merged = { ...before, ...v }; need(merged, 'name'); check(merged);
      update('nfc_tags', id, { name: merged.name, action: merged.action, target_id: merged.target_id ?? null }); audit(u.id, 'update', 'nfc_tags', id, before, v);
      return send(res, 200, tagOut(req, getRow('nfc_tags', id)));
    }
    if (m === 'DELETE') { update('nfc_tags', id, { deleted: 1 }); audit(u.id, 'delete', 'nfc_tags', id, before, null); return send(res, 200, { ok: true }); }
  }

  // ----- supplies -----
  if (seg[0] === 'supplies') {
    const u = needUser(req), id = seg[1] ? idOf(seg[1]) : null;
    if (m === 'GET' && !id) return send(res, 200, q('SELECT * FROM supplies WHERE deleted=0 ORDER BY kind, name').all());
    if (!['admin', 'caregiver'].includes(u.role)) throw httpErr(403, 'Not allowed for your role');
    if (m === 'POST' && !id) { const v = clean(SUPPLY_SPEC, await readJson(req)); need(v, 'name'); const sid = insert('supplies', v); audit(u.id, 'create', 'supplies', sid, null, v); return send(res, 200, getRow('supplies', sid)); }
    const before = getRow('supplies', id); if (!before) throw httpErr(404, 'Supply not found');
    if (m === 'PUT') { const v = clean(SUPPLY_SPEC, await readJson(req)); update('supplies', id, v); audit(u.id, 'update', 'supplies', id, before, v); return send(res, 200, getRow('supplies', id)); }
    if (m === 'DELETE') { update('supplies', id, { deleted: 1 }); audit(u.id, 'delete', 'supplies', id, before, null); return send(res, 200, { ok: true }); }
    if (m === 'POST' && seg[2] === 'empty') { update('supplies', id, { qty: 0 }); audit(u.id, 'emptied', 'supplies', id); return send(res, 200, getRow('supplies', id)); }
  }

  // ----- reports -----
  if (route === 'GET /report') {
    const u = needUser(req), rows = reportRows(u, qs);
    const byMed = {}; for (const d of rows) (byMed[d.medication_id] ||= { med_name: d.med_name, patient_name: d.patient_name, rows: [] }).rows.push(d);
    return send(res, 200, { rows, adherence: adherence(rows), by_med: Object.values(byMed).map(x => ({ med_name: x.med_name, patient_name: x.patient_name, adherence: adherence(x.rows) })) });
  }
  if (route === 'GET /export/doses.csv') {
    const u = needUser(req), rows = reportRows(u, qs);
    const cols = ['patient_name', 'med_name', 'status', 'due_at', 'given_at', 'created_at', 'timing', 'amount', 'unit', 'volume_ml', 'lot_number', 'site_name', 'given_by_name', 'reason', 'reaction', 'notes'];
    const body = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
    audit(u.id, 'export', 'doses', null, null, { rows: rows.length });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="shottracker-${today()}.csv"`, 'Cache-Control': 'no-store' });
    return res.end('\ufeff' + body);
  }

  // ----- users (admin) -----
  if (seg[0] === 'users') {
    const a = needRole(req, 'admin'), id = seg[1] ? idOf(seg[1]) : null;
    const setAccess = (uid, role, b) => {
      if (role === 'patient') {
        const pid = b.patient_id ? idOf(b.patient_id) : (Array.isArray(b.patients) && b.patients[0]) || null;
        if (!pid || !getRow('patients', pid)) throw httpErr(400, 'Pick which patient this login is for');
        q('UPDATE users SET patient_id=? WHERE id=?').run(+pid, uid); q('DELETE FROM patient_access WHERE user_id=?').run(uid);
      } else if (Array.isArray(b.patients)) {
        q('UPDATE users SET patient_id=NULL WHERE id=?').run(uid); q('DELETE FROM patient_access WHERE user_id=?').run(uid);
        for (const pid of b.patients) if (getRow('patients', +pid)) q('INSERT OR IGNORE INTO patient_access VALUES(?,?)').run(uid, +pid);
      }
    };
    if (m === 'GET' && !id) return send(res, 200, q('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(userOut));
    if (m === 'POST' && !id) {
      const b = await readJson(req), username = validUsername(b.username); checkNewPassword(b.password);
      if (!ROLES.includes(b.role)) throw httpErr(400, 'Unknown role');
      if (q('SELECT id FROM users WHERE username=?').get(username)) throw httpErr(409, 'That user name is taken');
      const uid = tx(() => {
        const t = now(), r = q('INSERT INTO users(username, name, email, role, pw, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(username, str(b.name, 80) || username, str(b.email, 120), b.role, hashPw(b.password), t, t);
        const uid = Number(r.lastInsertRowid); setAccess(uid, b.role, b); return uid;
      });
      const nu = q('SELECT * FROM users WHERE id=?').get(uid);
      audit(a.id, 'create', 'users', nu.id, null, userOut(nu));
      return send(res, 200, userOut(nu));
    }
    const before = q('SELECT * FROM users WHERE id=?').get(id);
    if (!before) throw httpErr(404, 'User not found');
    if (m === 'PUT') {
      const b = await readJson(req);
      const role = b.role === undefined ? before.role : b.role; if (!ROLES.includes(role)) throw httpErr(400, 'Unknown role');
      const disabled = b.disabled === undefined ? !!before.disabled : !!b.disabled;
      if (before.role === 'admin' && !before.disabled && (role !== 'admin' || disabled) && adminCount() <= 1) throw httpErr(400, 'Keep at least one active admin');
      if (b.password) checkNewPassword(b.password);
      tx(() => {
        q('UPDATE users SET name=?, email=?, role=?, disabled=?, updated_at=? WHERE id=?').run(str(b.name ?? before.name, 80) || before.username, str(b.email ?? before.email, 120), role, disabled ? 1 : 0, now(), id);
        if (b.patients !== undefined || b.patient_id !== undefined || role !== before.role) setAccess(id, role, { patients: [], ...b });
        if (b.password) q('UPDATE users SET pw=? WHERE id=?').run(hashPw(b.password), id);
        if (b.resetTotp) q(`UPDATE users SET totp=NULL, totp_on=0, totp_last=0, recovery='[]' WHERE id=?`).run(id);
        if (b.password || b.resetTotp || disabled) q('DELETE FROM sessions WHERE user_id=?').run(id);
      });
      const after = q('SELECT * FROM users WHERE id=?').get(id);
      audit(a.id, 'update', 'users', id, userOut(before), { ...userOut(after), passwordReset: !!b.password, totpReset: !!b.resetTotp });
      return send(res, 200, userOut(after));
    }
  }

  // ----- settings (admin) -----
  if (seg[0] === 'settings') {
    const a = needRole(req, 'admin');
    if (m === 'GET' && seg.length === 1) return send(res, 200, settingsOut());
    if (m === 'PUT' && seg.length === 1) {
      const b = await readJson(req), changed = [];
      for (const [k, d] of Object.entries(SETTINGS)) {
        if (b[k] === undefined) continue;
        let v = str(b[k], 500);
        if (d.secret && v === '' && !b['clear_' + k]) continue; // blank secret keeps the saved one
        if (['remind_day_before', 'remind_morning', 'digest_time', 'backup_time'].includes(k)) v = F.time(v);
        if (['repeat_min', 'backup_keep', 'smtp_port'].includes(k) && v && !/^\d{1,5}$/.test(v)) throw httpErr(400, k.replace(/_/g, ' ') + ' must be a number');
        if (['app_url', 'ha_url'].includes(k) && v && !/^https?:\/\/[^\s]+$/.test(v)) throw httpErr(400, k.replace(/_/g, ' ') + ' must start with http:// or https://');
        if (k === 'backup_pass' && v && v.length < 12) throw httpErr(400, 'Backup passphrase needs at least 12 characters');
        q('INSERT OR REPLACE INTO settings VALUES(?, ?)').run(k, v === '' ? '' : (d.secret ? seal(v) : v));
        changed.push(k);
      }
      if (changed.length) audit(a.id, 'update', 'settings', null, null, { changed });
      if (changed.some(k => k.startsWith('ha_'))) { haLink.restart(); lastSensors = 0; }
      return send(res, 200, settingsOut());
    }
    if (m === 'POST' && seg[1] === 'test-ha') { try { const list = await N.haNotifyServices(cfg()); return send(res, 200, { ok: true, services: list.length }); } catch (e) { throw httpErr(502, e.message); } }
    if (m === 'POST' && seg[1] === 'test-email') {
      if (!a.email) throw httpErr(400, 'Add your email address under your account first');
      try { await N.smtpSend(cfg(), a.email, 'ShotTracker test', 'Email from ShotTracker works.'); return send(res, 200, { ok: true }); } catch (e) { throw httpErr(502, e.message); }
    }
  }

  // ----- backups (admin) -----
  if (seg[0] === 'backups') {
    const a = needRole(req, 'admin');
    if (m === 'GET' && seg.length === 1) return send(res, 200, listBackups());
    if (m === 'POST' && seg.length === 1) {
      const pass = setting('backup_pass'); if (!pass) throw httpErr(400, 'Set a backup passphrase first');
      const name = makeBackup(pass, 'manual'); audit(a.id, 'backup', null, null, null, { name });
      return send(res, 200, listBackups());
    }
    if (m === 'POST' && seg[1] === 'restore') {
      const buf = await readBody(req, 300 * 1024 * 1024), dbuf = openBackup(buf, req.headers['x-backup-pass'] || setting('backup_pass'));
      makeBackup(setting('backup_pass') || crypto.randomBytes(16).toString('hex'), 'before-restore');
      fs.writeFileSync(DB_FILE + '.restore', dbuf, { mode: 0o600 });
      audit(a.id, 'restore', null, null, null, { size: dbuf.length });
      send(res, 200, { ok: true, restarting: true });
      setTimeout(() => process.exit(0), 500); // Docker's restart policy starts it again with the restored database
      return;
    }
    if (m === 'GET' && seg[1]) {
      const name = path.basename(decodeURIComponent(seg[1])), f = path.join(BACKUPS, name);
      if (!/\.(stbk|db)$/.test(name) || !fs.existsSync(f)) throw httpErr(404, 'Backup not found');
      audit(a.id, 'download-backup', null, null, null, { name });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
  }

  // ----- activity log (admin) -----
  if (route === 'GET /audit') {
    needRole(req, 'admin');
    return send(res, 200, q('SELECT a.id, a.at, a.action, a.tbl, a.record, a.old, a.new, u.name user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?').all(Math.min(1000, +qs.limit || 300)));
  }

  throw httpErr(404, 'Not found');
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.wasm': 'application/wasm' };
function serveStatic(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch { p = '/'; }
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const f = path.resolve(PUB, '.' + p);
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  // The browser may keep a copy but must check it's current on every load (a quick 304 if it is), so a new
  // version of ShotTracker takes effect on the next reload instead of after a cache timeout.
  const st = fs.statSync(f), etag = `"${VERSION}-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const head = { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
  res.writeHead(200, head);
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
    // private calendar feed: the long random token in the link is the credential
    const ics = /^\/ics\/([A-Za-z0-9_-]{20,64})\.ics$/.exec(url.pathname);
    if (ics && req.method === 'GET') {
      const u = q('SELECT * FROM users WHERE ics_token=? AND disabled=0').get(ics[1]);
      if (!u) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(icsFor(u));
    }
    // NFC tag link: hand off to the app, which signs in if needed and then opens the tag's screen
    const tag = /^\/t\/([A-Za-z0-9]{6,40})\/?$/.exec(url.pathname);
    if (tag && req.method === 'GET') { res.writeHead(302, { Location: '/#tag/' + tag[1], 'Cache-Control': 'no-store' }); return res.end(); }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !csrfOk(req)) throw httpErr(403, 'Blocked: request did not come from the ShotTracker page');
      return await api(req, res, url.pathname.slice(5).split('/').filter(Boolean), url);
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
setInterval(tick, TICK_MS).unref(); setTimeout(tick, 3000).unref();
process.on('SIGTERM', () => { haLink.stop(); try { db.close(); } catch {} process.exit(0); });
