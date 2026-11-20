// End-to-end test: starts the server on a temp folder with a fake Home Assistant and a fake email server, then
// exercises sign-in, roles, medications, inventory, schedules, logging, sites, reminders, alerts, sensors,
// email, the calendar feed, reports, CSV, backups and restore.
'use strict';
process.env.TZ = 'America/Chicago'; // same zone as the server under test (CI runners are UTC)
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto'), http = require('http'), net = require('net'), tls = require('tls');
const root = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), port = 19000 + Math.floor(Math.random() * 900);
const base = 'http://127.0.0.1:' + port;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = require('../lib/sched');
const { parseGS1 } = (() => { const src = fs.readFileSync(path.join(root, 'public/js/scan.js'), 'utf8').replace(/export function/g, 'function') + '\nmodule.exports = { parseGS1 };'; const m = { exports: {} }; new Function('module', 'window', 'document', src)(m, {}, {}); return m.exports; })();

// TOTP the way an authenticator app does it
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function unb32(s) { let bits = 0, val = 0; const out = []; for (const c of s.toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, ctr) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr)); const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }
const totp = (secret, d = 0) => hotp(unb32(secret), Math.floor(Date.now() / 30000) + d);

function client() {
  let cookie = '';
  return async (m, u, b, extra = {}) => {
    const raw = Buffer.isBuffer(b);
    const r = await fetch(base + u, { method: m, headers: { 'x-shottracker': '1', ...(cookie ? { Cookie: cookie } : {}), ...(b && !raw ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: b ? (raw ? b : JSON.stringify(b)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : ct.includes('octet') ? Buffer.from(await r.arrayBuffer()) : await r.text();
    return { status: r.status, body, headers: r.headers };
  };
}
async function signIn(C, username, password, secret) {
  let r = await C('POST', '/api/login', { username, password });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  if (r.body.step === 'enroll') secret = r.body.secret;
  await sleep(10);
  r = await C('POST', '/api/login/code', { ticket: r.body.ticket, code: totp(secret) });
  if (r.status === 401) { await sleep(31000 - (Date.now() % 30000)); return signIn(C, username, password, secret); } // code already used this 30 s
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return secret;
}

// ---------- fake Home Assistant ----------
const ha = { pushes: [], states: {} };
const haSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer ha-test-token') { res.writeHead(401); return res.end(); }
    if (req.url === '/api/services' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify([{ domain: 'notify', services: { mobile_app_dads_phone: {}, persistent_notification: {} } }])); }
    if (req.url.startsWith('/api/services/notify/')) { ha.pushes.push({ service: req.url.split('/').pop(), ...JSON.parse(b) }); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[]'); }
    if (req.url.startsWith('/api/states/')) { ha.states[req.url.slice(12)] = JSON.parse(b); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(404); res.end();
  });
});

// ---------- fake FDA NDC Directory ----------
const fdaHits = [];
const fdaSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), search = u.searchParams.get('search') || '';
  fdaHits.push(search);
  if (u.pathname === '/drug/ndc.json' && search.includes('"0024-5918-01"')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ results: [{ product_ndc: '0024-5918', brand_name: 'DUPIXENT', generic_name: 'DUPILUMAB', labeler_name: 'sanofi-aventis U.S. LLC', dosage_form: 'INJECTION, SOLUTION', route: ['SUBCUTANEOUS'],
      active_ingredients: [{ name: 'DUPILUMAB', strength: '300 mg/2mL' }], packaging: [{ package_ndc: '0024-5918-01', description: '2 SYRINGE in 1 CARTON (0024-5918-01) > 2 mL in 1 SYRINGE' }] }] }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"NOT_FOUND"}}');
});

// ---------- fake email server (STARTTLS) ----------
const mails = [];
const tlsDir = path.join(data, 'smtp'); fs.mkdirSync(tlsDir);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tlsDir, 'k.pem'), '-out', path.join(tlsDir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const smtpSrv = net.createServer(sock => {
  let s = sock, buf = '', inData = false, msg = { rcpt: [] };
  const w = l => s.write(l + '\r\n');
  const onLine = line => {
    if (inData) { if (line === '.') { inData = false; mails.push(msg); msg = { rcpt: [] }; w('250 queued'); } else msg.data = (msg.data || '') + line + '\n'; return; }
    const cmd = line.split(' ')[0].toUpperCase();
    if (cmd === 'EHLO') { s.write('250-test\r\n' + (s.encrypted ? '' : '250-STARTTLS\r\n') + '250 AUTH PLAIN\r\n'); }
    else if (cmd === 'STARTTLS') { w('220 go'); s.removeAllListeners('data'); s = new tls.TLSSocket(s, { isServer: true, key: fs.readFileSync(path.join(tlsDir, 'k.pem')), cert: fs.readFileSync(path.join(tlsDir, 'c.pem')) }); s.on('data', feed); }
    else if (cmd === 'AUTH') { msg.auth = Buffer.from(line.split(' ')[2], 'base64').toString(); w('235 ok'); }
    else if (cmd === 'MAIL') { msg.from = line; w('250 ok'); }
    else if (cmd === 'RCPT') { msg.rcpt.push(line); w('250 ok'); }
    else if (cmd === 'DATA') { inData = true; w('354 go'); }
    else if (cmd === 'QUIT') { w('221 bye'); s.end(); }
    else w('250 ok');
  };
  const feed = c => { buf += c.toString(); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } };
  s.on('data', feed); s.on('error', () => {});
  w('220 fake smtp');
});

function start() {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.js')], {
    env: { ...process.env, DATA_DIR: path.join(data, 'd'), HTTP_PORT: port, HTTPS_PORT: '0', TICK_MS: '400', TZ: 'America/Chicago', OPENFDA_URL: `http://127.0.0.1:${fdaSrv.address().port}`, NODE_EXTRA_CA_CERTS: path.join(tlsDir, 'c.pem') }, stdio: ['ignore', 'inherit', 'inherit'] });
}
async function ready() { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} await sleep(100); } throw new Error('server did not start'); }
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error('timed out waiting'); };

(async () => {
  // ----- syntax and pure functions -----
  for (const f of ['server.js', 'lib/sched.js', 'lib/notify.js']) assert.strictEqual(spawnSync(process.execPath, ['--check', path.join(root, f)]).status, 0, f + ' has a syntax error');
  for (const f of fs.readdirSync(path.join(root, 'public/js'))) { const t = path.join(data, f.replace('.js', '.mjs')); fs.writeFileSync(t, fs.readFileSync(path.join(root, 'public/js', f))); assert.strictEqual(spawnSync(process.execPath, ['--check', t]).status, 0, f + ' has a syntax error'); }
  { const b = Buffer.alloc(8); b.writeBigUInt64BE(1n); const h = crypto.createHmac('sha1', Buffer.from('12345678901234567890')).update(b).digest(), o = h[19] & 15; assert.strictEqual((h.readUInt32BE(o) & 0x7fffffff) % 1e8, 94287082, 'RFC 6238 vector'); }

  // schedules
  const two = { kind: 'weeks', every: 2, time_of_day: '20:00', anchor: 'calendar', start_date: '2026-01-05', grace_min: 120 };
  assert.strictEqual(S.ymd(S.nextDue(two, null)), '2026-01-05');
  assert.strictEqual(S.ymd(S.nextDue(two, { due_at: S.at(S.parseYmd('2026-01-05'), '20:00').toISOString(), status: 'given', given_at: S.at(S.parseYmd('2026-01-07'), '09:00').toISOString() })), '2026-01-19', 'calendar stays on its dates');
  assert.strictEqual(S.ymd(S.nextDue({ ...two, anchor: 'last' }, { due_at: S.at(S.parseYmd('2026-01-05'), '20:00').toISOString(), status: 'given', given_at: S.at(S.parseYmd('2026-01-07'), '09:00').toISOString() })), '2026-01-21', 'counted from the last shot');
  const monthly = { kind: 'months', every: 1, time_of_day: '18:00', anchor: 'calendar', start_date: '2026-01-31' };
  assert.deepStrictEqual(S.upcoming(monthly, null, S.parseYmd('2026-05-01')).map(S.ymd), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], 'month ends clamp without drifting');
  assert.strictEqual(S.ymd(S.nextDue({ kind: 'weekdays', weekdays: '1,4', every: 1, time_of_day: '08:00', start_date: '2026-01-01' }, null)), '2026-01-01', 'Thu Jan 1');
  assert.strictEqual(S.doseFor({ dose_amount: 40, dose_unit: 'mg' }, [{ start_date: '2026-02-01', dose_amount: 80, dose_unit: 'mg' }], S.parseYmd('2026-03-01')).amount, 80, 'titration step');
  // barcode text
  const g = parseGS1(']d2' + '0100312345678906' + '17270531' + '10AB12C' + '\x1d' + '21SER999');
  assert.deepStrictEqual([g.ndc, g.expires, g.lot, g.serial], ['1234567890', '2027-05-31', 'AB12C', 'SER999']);
  assert.strictEqual(parseGS1('(01)00312345678906(17)271200(10)LOT9').expires, '2027-12-31', 'day 00 = end of month');

  // NDC parsing
  const NDC = require('../lib/ndc');
  assert.deepStrictEqual(NDC.candidates('0024591801'), ['0024-5918-01', '00245-918-01', '00245-9180-1']);
  assert.deepStrictEqual(NDC.candidates('00024591801'), ['0024-5918-01', '00024-5918-1']);
  assert.deepStrictEqual(NDC.parseStrength('300 mg/2mL'), { conc: 150, conc_unit: 'mg' });
  assert.deepStrictEqual(NDC.parseStrength('100 [iU]/mL'), { conc: 100, conc_unit: 'units' });
  assert.deepStrictEqual(NDC.parsePackage('2 SYRINGE in 1 CARTON (0024-5918-01) > 2 mL in 1 SYRINGE'), { form: 'syringe', unit_ml: 2, per_carton: 2 });
  assert.strictEqual(NDC.parsePackage('1 VIAL, MULTI-DOSE in 1 CARTON > 10 mL in 1 VIAL, MULTI-DOSE').form, 'multi_vial');
  assert.strictEqual(NDC.parsePackage('1 PEN in 1 CARTON > 1 mL in 1 PEN').form, 'pen');

  await new Promise(r => haSrv.listen(0, '127.0.0.1', r)); await new Promise(r => fdaSrv.listen(0, '127.0.0.1', r)); await new Promise(r => smtpSrv.listen(0, '127.0.0.1', r));
  let srv = start();
  try {
    await ready();
    const A = client(), V = client(), X = client(), P = client(), CG = client();

    // ----- setup, two-factor, CSRF, headers -----
    let r = await A('GET', '/api/state');
    assert.strictEqual(r.body.setup, true); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.strictEqual((await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'no header');
    assert.strictEqual((await A('POST', '/api/setup', { username: 'admin', password: 'x'.repeat(12) }, { Origin: 'https://evil.example' })).status, 403, 'foreign origin');
    assert.strictEqual((await A('POST', '/api/setup', { username: 'admin', password: 'short' })).status, 400);
    r = await A('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct horse battery', remember: true });
    assert.strictEqual(r.body.step, 'enroll'); const secret = r.body.secret;
    assert.strictEqual((await A('POST', '/api/setup', { username: 'other', password: 'correct horse battery' })).status, 409);
    r = await A('POST', '/api/login/code', { ticket: r.body.ticket, code: totp(secret) });
    assert.strictEqual(r.status, 200); const recovery = r.body.recovery; assert.strictEqual(recovery.length, 8);

    // ----- settings: HA + email -----
    const haUrl = `http://127.0.0.1:${haSrv.address().port}`;
    r = await A('PUT', '/api/settings', { app_url: 'https://shots.home.lan', ha_url: haUrl, ha_token: 'ha-test-token', smtp_host: 'localhost', smtp_port: String(smtpSrv.address().port), smtp_user: 'u', smtp_pass: 'p', smtp_from: 'shots@home.lan', repeat_min: '60' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(r.body.ha_token, { set: true });
    assert.strictEqual((await A('POST', '/api/settings/test-ha')).body.services, 1);
    assert.deepStrictEqual((await A('GET', '/api/ha/services')).body, ['mobile_app_dads_phone']);
    assert.strictEqual((await A('PUT', '/api/me/prefs', { notify_ha: 'mobile_app_dads_phone', email: 'dad@home.lan', email_reminders: false, email_digest: false, quiet_start: '00:00', quiet_end: '00:00' })).status, 200);
    r = await A('POST', '/api/settings/test-email'); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(mails.length, 1); assert.match(mails[0].auth, /\0u\0p/); assert.match(Buffer.from(mails[0].data.split('\n\n')[1].replace(/\s/g, ''), 'base64').toString(), /works/);

    // ----- patients, meds, lots -----
    r = await A('POST', '/api/patients', { name: 'Dad' }); const dad = r.body.id;
    r = await A('POST', '/api/patients', { name: 'Kid', birth_date: '2015-04-10' }); const kid = r.body.id;
    r = await A('GET', '/api/patients/' + dad); assert.strictEqual(r.body.sites.length, 8, 'default sites');
    // a prefilled syringe: 40 mg in 0.4 mL
    r = await A('POST', '/api/meds', { patient_id: dad, name: 'Humira', form: 'syringe', conc: 100, conc_unit: 'mg', unit_ml: 0.4, storage: 'fridge', refills_left: 2, reorder_days: 30 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const hum = r.body.id;
    r = await A('POST', '/api/lots', { medication_id: hum, lot_number: 'OLD1', expires: '2099-01-31', qty_received: 1, used_refill: true });
    r = await A('POST', '/api/lots', { medication_id: hum, lot_number: 'NEW2', expires: '2099-12-31', qty_received: 2 });
    r = await A('POST', '/api/lots', { medication_id: hum, lot_number: 'GONE', expires: '2020-01-01', qty_received: 5 });
    r = await A('GET', '/api/patients/' + dad); let med = r.body.medications[0];
    assert.strictEqual(med.stock, 3, 'expired lot not counted'); assert.strictEqual(med.refills_left, 1, 'refill used');
    // every 2 weeks, starting today at 23:59 so it's "today"
    const todayStr = S.ymd(new Date());
    r = await A('POST', '/api/schedules', { medication_id: hum, kind: 'weeks', every: 2, time_of_day: '23:59', start_date: todayStr, dose_amount: 40, dose_unit: 'mg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const hs = r.body.id; assert.strictEqual(r.body.volume_ml, 0.4);
    r = await A('GET', '/api/patients/' + dad); assert.ok(r.body.medications[0].days_of_supply >= 40 && r.body.medications[0].days_of_supply <= 42, 'about 3 shots × 14 days');

    // ----- log form defaults: soonest-expiring usable lot, least-used site -----
    r = await A('GET', '/api/log-form?schedule_id=' + hs);
    assert.strictEqual(r.body.lots.find(l => l.id === r.body.lot_id).lot_number, 'OLD1'); assert.strictEqual(r.body.volume_ml, 0.4); assert.strictEqual(r.body.qty_used, 1);
    const firstSite = r.body.site_id;
    r = await A('POST', '/api/doses', { medication_id: hum, schedule_id: hs, status: 'given' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const d1 = r.body;
    assert.strictEqual(d1.lot_number, 'OLD1'); assert.strictEqual(d1.site_id, firstSite); assert.strictEqual(d1.timing, 'on time');
    r = await A('GET', '/api/today'); let s = r.body.patients.find(p => p.patient.id === dad).schedules[0];
    assert.strictEqual(S.ymd(new Date(s.due_at)), S.ymd(S.addDays(new Date(), 14)), 'next one in 2 weeks');
    r = await A('GET', '/api/log-form?schedule_id=' + hs);
    assert.notStrictEqual(r.body.site_id, firstSite, 'rotates to another site'); assert.strictEqual(r.body.lots.find(l => l.id === r.body.lot_id).lot_number, 'NEW2', 'empty lot skipped');
    // edit the entry to another lot: stock moves with it; delete puts it back
    const newLot = r.body.lot_id;
    r = await A('PUT', '/api/doses/' + d1.id, { lot_id: newLot }); assert.strictEqual(r.body.lot_number, 'NEW2');
    let lots = (await A('GET', '/api/patients/' + dad)).body.medications[0].lots;
    assert.strictEqual(lots.find(l => l.lot_number === 'OLD1').qty_left, 1); assert.strictEqual(lots.find(l => l.lot_number === 'NEW2').qty_left, 1);
    assert.strictEqual((await A('POST', '/api/doses', { medication_id: hum, status: 'given', given_at: new Date(Date.now() + 3600e3).toISOString() })).status, 400, 'future time refused');
    // a dose needing two syringes from a lot with one left is refused; delete puts stock back
    const old1 = lots.find(l => l.lot_number === 'OLD1').id;
    r = await A('POST', '/api/doses', { medication_id: hum, status: 'given', amount: 80, unit: 'mg', lot_id: old1 });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /has 1 left; this dose needs 2/);
    r = await A('POST', '/api/doses', { medication_id: hum, status: 'given', amount: 40, unit: 'mg', lot_id: old1 }); assert.strictEqual(r.body.qty_used, 1);
    lots = (await A('GET', '/api/patients/' + dad)).body.medications[0].lots; assert.strictEqual(lots.find(l => l.id === old1).qty_left, 0);
    await A('DELETE', '/api/doses/' + r.body.id);
    lots = (await A('GET', '/api/patients/' + dad)).body.medications[0].lots; assert.strictEqual(lots.find(l => l.id === old1).qty_left, 1, 'delete restores stock');

    // ----- multi-dose vial: opened date + discard-by -----
    r = await A('POST', '/api/meds', { patient_id: kid, name: 'Vialmed', form: 'multi_vial', conc: 50, conc_unit: 'mg', unit_ml: 2, opened_days: 28, storage: 'fridge' }); const vm = r.body.id;
    await A('POST', '/api/lots', { medication_id: vm, lot_number: 'V1', expires: '2099-01-01', qty_received: 2 });
    r = await A('POST', '/api/doses', { medication_id: vm, status: 'given', amount: 25, unit: 'mg' }); assert.strictEqual(r.body.volume_ml, 0.5); assert.strictEqual(r.body.qty_used, 0.5);
    lots = (await A('GET', '/api/patients/' + kid)).body.medications[0].lots;
    assert.strictEqual(lots[0].qty_left, 1.5); assert.strictEqual(lots[0].opened, todayStr); assert.strictEqual(lots[0].discard_by, S.ymd(S.addDays(new Date(), 28)));

    // ----- supplies -----
    r = await A('POST', '/api/supplies', { name: 'Alcohol swabs', qty: 3, unit: 'pcs', per_shot: 1, reorder_at: 2 }); const swab = r.body.id;
    r = await A('POST', '/api/supplies', { name: 'Sharps container', kind: 'sharps', capacity: 1 }); const sharps = r.body.id;
    r = await A('POST', '/api/doses', { medication_id: vm, status: 'given', amount: 25, unit: 'mg' });
    let sup = (await A('GET', '/api/supplies')).body; assert.strictEqual(sup.find(x => x.id === swab).qty, 2); assert.strictEqual(sup.find(x => x.id === sharps).qty, 1);
    let alerts = (await A('GET', '/api/alerts')).body.map(a => a.key);
    assert.ok(alerts.includes('supply:' + swab)); assert.ok(alerts.includes('sharps:' + sharps)); assert.ok(alerts.some(k => k.startsWith('low:' + hum)), 'low stock warning');
    await A('POST', `/api/supplies/${sharps}/empty`); assert.strictEqual((await A('GET', '/api/supplies')).body.find(x => x.id === sharps).qty, 0);

    // ----- roles -----
    await A('POST', '/api/users', { username: 'grandma', name: 'Grandma', role: 'viewer', password: 'another long password', patients: [kid] });
    await signIn(V, 'grandma', 'another long password');
    assert.deepStrictEqual((await V('GET', '/api/patients')).body.map(p => p.name), ['Kid'], 'viewer sees only assigned');
    assert.strictEqual((await V('GET', '/api/patients/' + dad)).status, 404);
    assert.strictEqual((await V('POST', '/api/doses', { medication_id: vm, status: 'given' })).status, 403);
    assert.strictEqual((await V('GET', '/api/users')).status, 403);
    await A('POST', '/api/users', { username: 'kiddo', name: 'Kid', role: 'patient', password: 'kid long password!', patient_id: kid });
    await signIn(P, 'kiddo', 'kid long password!');
    assert.strictEqual((await P('POST', '/api/doses', { medication_id: vm, status: 'given', amount: 25, unit: 'mg' })).status, 200, 'patient logs own');
    assert.strictEqual((await P('POST', '/api/meds', { patient_id: kid, name: 'X', form: 'pen' })).status, 403, 'patient cannot manage');
    assert.strictEqual((await P('POST', '/api/doses', { medication_id: hum, status: 'given' })).status, 404, 'not another patient');
    await A('POST', '/api/users', { username: 'mom', name: 'Mom', role: 'caregiver', password: 'mom long password', patients: [dad, kid] });
    await signIn(CG, 'mom', 'mom long password');
    assert.strictEqual((await CG('POST', '/api/lots', { medication_id: hum, lot_number: 'M1', qty_received: 1, expires: '2099-06-01' })).status, 200);
    assert.strictEqual((await CG('DELETE', '/api/patients/' + kid)).status, 403, 'only admin removes patients');
    const me = (await A('GET', '/api/state')).body.user;
    assert.strictEqual((await A('PUT', '/api/users/' + me.id, { role: 'viewer' })).status, 400, 'keep one admin');

    // ----- reminders: an overdue shot reaches the phone with buttons; repeats aren't re-sent -----
    const past = S.ymd(S.addDays(new Date(), -1));
    r = await A('POST', '/api/meds', { patient_id: kid, name: 'Monthly', form: 'syringe', conc: 150, conc_unit: 'mg', unit_ml: 1, storage: 'fridge' }); const mon = r.body.id;
    await A('POST', '/api/lots', { medication_id: mon, lot_number: 'MO1', qty_received: 3, expires: '2099-01-01' });
    r = await A('POST', '/api/schedules', { medication_id: mon, kind: 'months', every: 1, time_of_day: '08:00', start_date: past, dose_amount: 150, dose_unit: 'mg', grace_min: 60 }); const ms = r.body.id;
    assert.strictEqual(r.body.status, 'overdue');
    const push = await until(() => ha.pushes.find(p => p.data.tag === 'shottracker-' + ms));
    assert.strictEqual(push.service, 'mobile_app_dads_phone'); assert.match(push.message, /Kid: Monthly 150 mg/); assert.strictEqual(push.data.url, `https://shots.home.lan/#log/${ms}`);
    assert.deepStrictEqual(push.data.actions.map(a => a.title), ['Open', 'Given now', 'Snooze 1 hour']);
    await sleep(1500); assert.strictEqual(ha.pushes.filter(p => p.data.tag === 'shottracker-' + ms).length, 1, 'not repeated within the hour');
    // stock/expiry alerts are pushed too
    await until(() => ha.pushes.find(p => /days left|full/.test(p.message)));
    // snooze holds it; logging clears it
    r = await A('POST', `/api/schedules/${ms}/snooze`, { minutes: 30 }); assert.ok(r.body.snoozed_until);
    r = await A('POST', '/api/doses', { medication_id: mon, schedule_id: ms, status: 'given' }); assert.strictEqual(r.body.timing, 'late');
    r = await A('GET', '/api/today'); s = r.body.patients.find(p => p.patient.id === kid).schedules.find(x => x.id === ms);
    assert.strictEqual(s.status, 'upcoming'); assert.strictEqual(new Date(s.due_at).getDate(), S.addMonths(S.parseYmd(past), 1).getDate());

    // ----- auto-missed: a weekly schedule with old unlogged shots -----
    r = await A('POST', '/api/meds', { patient_id: dad, name: 'Weekly', form: 'pen', storage: 'room' }); const wk = r.body.id;
    r = await A('POST', '/api/schedules', { medication_id: wk, kind: 'weeks', every: 1, time_of_day: '09:00', start_date: S.ymd(S.addDays(new Date(), -20)), dose_amount: 1, dose_unit: 'mL' }); const ws = r.body.id;
    const missed = await until(async () => { const x = (await A('GET', '/api/doses?patient_id=' + dad)).body.filter(d => d.schedule_id === ws && d.status === 'missed'); return x.length >= 2 && x; });
    assert.ok(missed.every(d => d.source === 'auto'));

    // ----- Home Assistant sensors -----
    await A('PUT', '/api/settings', { ha_sensors: '1' });
    await until(() => ha.states['sensor.shottracker_dad_humira']);
    assert.strictEqual(ha.states['sensor.shottracker_dad_humira'].attributes.device_class, 'timestamp');
    assert.ok('sensor.shottracker_overdue' in ha.states);

    // ----- calendar feed -----
    r = await A('POST', '/api/me/ics'); const ics = r.body.ics_url; assert.match(ics, /^https:\/\/shots\.home\.lan\/ics\/[\w-]+\.ics$/);
    r = await fetch(base + new URL(ics).pathname); const cal = await r.text();
    assert.strictEqual(r.status, 200); assert.match(cal, /BEGIN:VCALENDAR/); assert.match(cal, /SUMMARY:Dad: Humira 40 mg/); assert.match(cal, /✓ Dad: Humira given/);
    assert.ok(cal.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'folded lines');
    assert.strictEqual((await fetch(base + '/ics/' + 'x'.repeat(32) + '.ics')).status, 404);

    // ----- NFC tags -----
    r = await A('POST', '/api/tags', { name: 'Fridge', action: 'log_schedule', target_id: ms }); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const tg = r.body; assert.match(tg.url, /^https:\/\/shots\.home\.lan\/t\/[A-Za-z0-9]{12}$/); assert.match(tg.label, /Kid · Monthly/);
    r = await fetch(base + '/t/' + tg.code, { redirect: 'manual' }); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/#tag/' + tg.code);
    assert.strictEqual((await fetch(base + '/api/tags/open/' + tg.code)).status, 401, 'signed-in users only');
    r = await A('GET', '/api/tags/open/' + tg.code); assert.deepStrictEqual(r.body, { name: 'Fridge', hash: 'log/' + ms });
    r = await A('GET', '/api/tags'); assert.strictEqual(r.body.tags[0].taps, 1); assert.strictEqual(r.body.tags[0].last_user, 'Admin'); assert.ok(r.body.choices.schedules.length >= 3);
    r = await A('PUT', '/api/tags/' + tg.id, { action: 'receive', target_id: hum }); assert.strictEqual(r.body.label, 'Receive shipment: Dad · Humira');
    assert.strictEqual((await A('GET', '/api/tags/open/' + tg.code)).body.hash, 'receive/' + hum, 'retarget without rewriting');
    assert.strictEqual((await V('GET', '/api/tags/open/' + tg.code)).status, 404, 'viewer cannot open Dad');
    assert.strictEqual((await V('GET', '/api/tags')).status, 403);
    assert.strictEqual((await A('POST', '/api/tags', { name: 'Bad', action: 'patient', target_id: 99999 })).status, 400);
    r = await A('POST', '/api/tags', { name: 'Kitchen', action: 'today' }); assert.strictEqual((await P('GET', '/api/tags/open/' + r.body.code)).body.hash, 'today', 'patient can open Today tag');
    assert.strictEqual((await A('GET', '/api/tags/open/nosuchtag1')).status, 404);


    await A('PUT', '/api/me/prefs', { email_digest: true }); await A('PUT', '/api/settings', { digest_time: '00:00' });
    await until(() => mails.find(m => /Subject: ShotTracker: /.test(m.data)));

    // ----- reports and CSV -----
    await A('POST', '/api/doses', { medication_id: hum, status: 'skipped', reason: '=HYPERLINK("x")' });
    r = await A('GET', '/api/report?patient_id=' + dad); assert.ok(r.body.adherence.missed >= 2); assert.ok(r.body.rows.length >= 3);
    r = await A('GET', '/api/export/doses.csv?patient_id=' + dad); assert.match(r.body, /^\ufeff?patient_name,med_name/); assert.match(r.body, /"'=HYPERLINK/, 'formula injection neutralized');
    r = await A('GET', '/api/lots/search?q=NEW'); assert.strictEqual(r.body[0].doses.length, 1);

    // ----- secrets never stored or sent in plain text -----
    const dbFile = path.join(data, 'd', 'shottracker.db'), raw = () => fs.readFileSync(dbFile).toString('latin1') + (fs.existsSync(dbFile + '-wal') ? fs.readFileSync(dbFile + '-wal').toString('latin1') : '');
    assert.ok(!raw().includes('ha-test-token')); assert.ok(!raw().includes(secret));
    assert.ok(!JSON.stringify((await A('GET', '/api/audit')).body).includes('ha-test-token'));

    // ----- backups and restore -----
    assert.strictEqual((await A('POST', '/api/backups')).status, 400, 'needs a passphrase');
    await A('PUT', '/api/settings', { backup_pass: 'backup passphrase 123' });
    r = await A('POST', '/api/backups'); assert.strictEqual(r.status, 200); const bk = r.body[0].name;
    r = await A('GET', '/api/backups/' + bk); const file = r.body; assert.ok(Buffer.isBuffer(file) && file.subarray(0, 5).toString() === 'STBK1');
    assert.ok(!file.toString('latin1').includes('Humira'), 'backup is encrypted');
    await A('POST', '/api/patients', { name: 'Added after backup' });
    assert.strictEqual((await A('POST', '/api/backups/restore', file, { 'Content-Type': 'application/octet-stream', 'x-backup-pass': 'wrong passphrase!!' })).status, 400);
    r = await A('POST', '/api/backups/restore', file, { 'Content-Type': 'application/octet-stream', 'x-backup-pass': 'backup passphrase 123' }); assert.strictEqual(r.body.restarting, true);
    await new Promise(res => srv.once('exit', res));
    srv = start(); await ready();
    await signIn(A, 'admin', 'correct horse battery', secret);
    const names = (await A('GET', '/api/patients')).body.map(p => p.name);
    assert.ok(names.includes('Dad') && !names.includes('Added after backup'), 'restored');

    // ----- recovery code, lockout, static files -----
    await A('POST', '/api/logout');
    r = await A('POST', '/api/login', { username: 'ADMIN', password: 'correct horse battery' }); assert.strictEqual(r.body.step, 'totp');
    assert.strictEqual((await A('POST', '/api/login/code', { ticket: r.body.ticket, code: recovery[0] })).status, 200);
    for (let i = 0; i < 5; i++) assert.strictEqual((await X('POST', '/api/login', { username: 'grandma', password: 'wrong wrong wrong' })).status, 401);
    assert.strictEqual((await X('POST', '/api/login', { username: 'grandma', password: 'another long password' })).status, 429);
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/js/bodymap.js')).status, 200);
    assert.strictEqual((await fetch(base + '/%2e%2e/server.js')).status, 404);

    console.log('All tests passed');
  } finally { srv.kill(); haSrv.close(); fdaSrv.close(); smtpSrv.close(); await sleep(200); fs.rmSync(data, { recursive: true, force: true }); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
