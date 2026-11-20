// Smoke test: start the server on a temp folder and exercise the API end to end
// (setup, two-factor enrollment and sign-in, recovery codes, CSRF guard, roles, patients, settings, lockout, headers).
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const root = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), port = 19000 + Math.floor(Math.random() * 900);
const base = 'http://127.0.0.1:' + port;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// TOTP the same way an authenticator app does it
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function unb32(s) { let bits = 0, val = 0; const out = []; for (const c of s.toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = ((val << 5) | i) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, ctr) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr)); const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); }
const totp = (secret, d = 0) => hotp(unb32(secret), Math.floor(Date.now() / 30000) + d);

function client() {
  let cookie = '';
  return async (m, u, b, extra = {}) => {
    const r = await fetch(base + u, { method: m, headers: { 'x-shottracker': '1', ...(cookie ? { Cookie: cookie } : {}), ...(b ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
}

(async () => {
  for (const f of ['server.js']) assert.strictEqual(spawnSync(process.execPath, ['--check', path.join(root, f)]).status, 0, f + ' has a syntax error');
  for (const f of fs.readdirSync(path.join(root, 'public/js'))) { const t = path.join(data, f.replace('.js', '.mjs')); fs.writeFileSync(t, fs.readFileSync(path.join(root, 'public/js', f))); assert.strictEqual(spawnSync(process.execPath, ['--check', t]).status, 0, f + ' has a syntax error'); }

  // RFC 6238 test vector (SHA-1, T=59s): 94287082 -> last 6 digits 287082
  { const b = Buffer.alloc(8); b.writeBigUInt64BE(1n); const h = crypto.createHmac('sha1', Buffer.from('12345678901234567890')).update(b).digest(), o = h[19] & 15; assert.strictEqual((h.readUInt32BE(o) & 0x7fffffff) % 1e8, 94287082); }

  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.js')], { env: { ...process.env, DATA_DIR: path.join(data, 'd'), HTTP_PORT: port, HTTPS_PORT: '0' }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(100); }
    const A = client(), V = client(), X = client();

    let r = await A('GET', '/api/state');
    assert.strictEqual(r.body.setup, true); assert.strictEqual(r.body.user, null);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');

    // CSRF: no custom header, or a foreign Origin, is refused
    r = await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403);
    r = await A('POST', '/api/setup', { username: 'admin', password: 'x'.repeat(12) }, { Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);

    // setup: short password refused, then admin made and two-factor enrolled
    r = await A('POST', '/api/setup', { username: 'admin', password: 'short' }); assert.strictEqual(r.status, 400);
    r = await A('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct horse battery' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.step, 'enroll'); assert.match(r.body.uri, /^otpauth:\/\/totp\//);
    const secret = r.body.secret;
    assert.strictEqual((await A('POST', '/api/setup', { username: 'other', password: 'correct horse battery' })).status, 409, 'setup only once');
    assert.strictEqual((await A('POST', '/api/login/code', { ticket: r.body.ticket, code: '000000' === totp(secret) ? '111111' : '000000' })).status, 401);
    r = await A('POST', '/api/login/code', { ticket: r.body.ticket, code: totp(secret) });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.recovery.length, 8);
    const recovery = r.body.recovery;
    r = await A('GET', '/api/state'); assert.strictEqual(r.body.user.role, 'admin');

    // patients
    r = await A('POST', '/api/patients', { name: '' }); assert.strictEqual(r.status, 400);
    r = await A('POST', '/api/patients', { name: 'Kid', birth_date: '2018-10-02', color: '#2ec4b6', notes: 'Weekly' });
    assert.strictEqual(r.status, 200); const pid = r.body.id;
    r = await A('PUT', '/api/patients/' + pid, { name: 'Kid A', birth_date: '2018-10-02', color: '#2ec4b6' }); assert.strictEqual(r.body.name, 'Kid A');
    r = await A('GET', '/api/patients'); assert.strictEqual(r.body.length, 1);

    // a viewer can look but not change
    r = await A('POST', '/api/users', { username: 'grandma', name: 'Grandma', role: 'viewer', password: 'another long password' }); assert.strictEqual(r.status, 200);
    r = await V('POST', '/api/login', { username: 'grandma', password: 'another long password' }); assert.strictEqual(r.body.step, 'enroll');
    r = await V('POST', '/api/login/code', { ticket: r.body.ticket, code: totp(r.body.secret) }); assert.strictEqual(r.status, 200);
    assert.strictEqual((await V('GET', '/api/patients')).body.length, 1);
    assert.strictEqual((await V('POST', '/api/patients', { name: 'Nope' })).status, 403);
    assert.strictEqual((await V('GET', '/api/users')).status, 403);
    assert.strictEqual((await V('GET', '/api/settings')).status, 403);

    // the last admin can't be demoted
    const me = (await A('GET', '/api/state')).body.user;
    assert.strictEqual((await A('PUT', '/api/users/' + me.id, { role: 'viewer' })).status, 400);

    // secret settings are sealed on disk and never sent back
    r = await A('PUT', '/api/settings', { ha_url: 'http://ha.local:8123', ha_token: 'super-secret-token' });
    assert.strictEqual(r.body.ha_url, 'http://ha.local:8123'); assert.deepStrictEqual(r.body.ha_token, { set: true });
    r = await A('PUT', '/api/settings', { ha_token: '' }); assert.deepStrictEqual(r.body.ha_token, { set: true }, 'blank keeps the secret');
    const dbBytes = fs.readFileSync(path.join(data, 'd', 'shottracker.db')).toString('latin1') + (fs.existsSync(path.join(data, 'd', 'shottracker.db-wal')) ? fs.readFileSync(path.join(data, 'd', 'shottracker.db-wal')).toString('latin1') : '');
    assert.ok(!dbBytes.includes('super-secret-token'), 'token stored in plain text'); assert.ok(!dbBytes.includes(secret), 'TOTP secret stored in plain text');

    // sign in again: password, then a recovery code (used once only)
    await A('POST', '/api/logout');
    assert.strictEqual((await A('GET', '/api/patients')).status, 401);
    r = await A('POST', '/api/login', { username: 'ADMIN', password: 'correct horse battery' }); assert.strictEqual(r.body.step, 'totp');
    r = await A('POST', '/api/login/code', { ticket: r.body.ticket, code: recovery[0] }); assert.strictEqual(r.status, 200);
    await A('POST', '/api/logout');
    r = await A('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
    assert.strictEqual((await A('POST', '/api/login/code', { ticket: r.body.ticket, code: recovery[0] })).status, 401, 'recovery code reused');

    // lockout after 5 wrong passwords
    for (let i = 0; i < 5; i++) assert.strictEqual((await X('POST', '/api/login', { username: 'grandma', password: 'wrong wrong wrong' })).status, 401);
    assert.strictEqual((await X('POST', '/api/login', { username: 'grandma', password: 'another long password' })).status, 429);

    // audit log has the story
    r = await A('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
    r = await A('POST', '/api/login/code', { ticket: r.body.ticket, code: recovery[1] }); assert.strictEqual(r.status, 200);
    const acts = (await A('GET', '/api/audit')).body.map(x => x.action);
    for (const a of ['setup', 'totp-enrolled', 'create', 'update', 'login', 'login-failed', 'recovery-code-used']) assert.ok(acts.includes(a), 'audit missing ' + a);
    assert.ok(!JSON.stringify((await A('GET', '/api/audit')).body).includes('super-secret-token'));

    // static files and path traversal
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/js/app.js')).status, 200);
    assert.strictEqual((await fetch(base + '/%2e%2e/server.js')).status, 404);

    console.log('All tests passed');
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
