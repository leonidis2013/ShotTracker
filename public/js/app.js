// ShotTracker web app. Pages are built with DOM calls (no innerHTML with data), so names and notes can't inject markup.
const $ = s => document.querySelector(s);
const main = $('#main'), dlg = $('#dlg');
const COLORS = ['#4c8dff', '#2ec4b6', '#f2c94c', '#ef4c4c', '#3ecf6e', '#b07cff', '#ff8a3d', '#ff6fb5'];
let state = { user: null, version: '' }, page = 'patients';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
const errBox = () => h('div', { class: 'errbox hide' });
const showErr = (box, e) => { box.textContent = e.message || String(e); box.classList.remove('hide'); };

async function api(method, url, body) {
  const r = await fetch('/api' + url, { method, credentials: 'same-origin', headers: { 'x-shottracker': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.user && !url.startsWith('/login')) { state.user = null; render(); }
  if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
  return data;
}

// ---------- theme ----------
$('#themeBtn').onclick = () => {
  const light = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  try { localStorage.setItem('st-theme', light ? 'light' : 'dark'); } catch (e) {}
};

// ---------- sign-in ----------
function setupPage() {
  const err = errBox(), name = h('input', { autocomplete: 'name' }), user = h('input', { autocomplete: 'username', autocapitalize: 'off' }),
    pw = h('input', { type: 'password', autocomplete: 'new-password' }), pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const go = async e => {
    e.preventDefault();
    if (pw.value !== pw2.value) return showErr(err, new Error('The passwords don\'t match'));
    try { codePage(await api('POST', '/setup', { name: name.value, username: user.value, password: pw.value, remember: true })); } catch (x) { showErr(err, x); }
  };
  main.replaceChildren(h('form', { class: 'card login', onsubmit: go },
    h('h2', {}, 'Create the admin account'),
    h('p', { class: 'note' }, 'This is the first visit. The account you make here can add patients and other users. Next you\'ll set up two-factor sign-in.'),
    err, field('Your name', name), field('User name', user), field('Password (12+ characters)', pw), field('Password again', pw2),
    h('button', { class: 'primary', type: 'submit' }, 'Create account')));
  name.focus();
}

function loginPage() {
  const err = errBox(), user = h('input', { autocomplete: 'username', autocapitalize: 'off' }), pw = h('input', { type: 'password', autocomplete: 'current-password' }),
    rem = h('input', { type: 'checkbox', checked: true });
  const go = async e => { e.preventDefault(); try { codePage(await api('POST', '/login', { username: user.value, password: pw.value, remember: rem.checked })); } catch (x) { showErr(err, x); } };
  main.replaceChildren(h('form', { class: 'card login', onsubmit: go },
    h('h2', {}, 'Sign in'), err, field('User name', user), field('Password', pw),
    h('label', { class: 'row note', style: 'margin-bottom:10px' }, rem, 'Keep me signed in on this device for 30 days'),
    h('button', { class: 'primary', type: 'submit' }, 'Next')));
  user.focus();
}

function codePage(r) {
  const err = errBox(), code = h('input', { class: 'code-in', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: r.step === 'totp' ? 12 : 6, placeholder: '000000' });
  const go = async e => {
    e.preventDefault();
    try {
      const out = await api('POST', '/login/code', { ticket: r.ticket, code: code.value });
      state.user = out.user;
      if (out.recovery) recoveryPage(out.recovery, () => render()); else render();
    } catch (x) { showErr(err, x); code.select(); }
  };
  const enroll = r.step === 'enroll' ? [
    h('p', { class: 'note' }, 'Two-factor sign-in is required. Add ShotTracker to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, etc.).'),
    h('a', { href: r.uri }, h('button', { type: 'button', style: 'width:100%;margin-bottom:8px' }, 'Open in authenticator app')),
    h('div', { class: 'note' }, 'Or type this setup key into the app:'),
    h('div', { class: 'secret', style: 'margin:4px 0 12px' }, r.secret.match(/.{1,4}/g).join(' ')),
    h('div', { class: 'note', style: 'margin-bottom:6px' }, 'Then enter the 6-digit code it shows:'),
  ] : [h('p', { class: 'note' }, 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.')];
  main.replaceChildren(h('form', { class: 'card login', onsubmit: go },
    h('h2', {}, r.step === 'enroll' ? 'Set up two-factor sign-in' : 'Two-factor code'), err, ...enroll, code,
    h('button', { class: 'primary', type: 'submit', style: 'width:100%;margin-top:8px' }, 'Sign in'),
    h('button', { type: 'button', style: 'width:100%;margin-top:6px', onclick: () => render() }, 'Start over')));
  code.focus();
}

function recoveryPage(codes, done) {
  main.replaceChildren(h('div', { class: 'card login' },
    h('h2', {}, 'Save your recovery codes'),
    h('p', { class: 'note' }, 'If you lose your phone, each of these codes signs you in once instead of the 6-digit code. Store them somewhere safe, like a password manager. They won\'t be shown again.'),
    h('div', { class: 'codes' }, codes.map(c => h('div', {}, c))),
    h('button', { class: 'primary', style: 'width:100%;margin-top:10px', onclick: done }, 'I saved them')));
}

// ---------- main pages ----------
const PAGES = [
  { id: 'patients', label: 'Patients', show: () => true },
  { id: 'users', label: 'Users', show: u => u.role === 'admin' },
  { id: 'settings', label: 'Settings', show: u => u.role === 'admin' },
  { id: 'activity', label: 'Activity', show: u => u.role === 'admin' },
];
function shell() {
  const nav = $('#nav'); nav.classList.remove('hide');
  nav.replaceChildren(...PAGES.filter(p => p.show(state.user)).map(p => h('button', { class: page === p.id ? 'on' : '', onclick: () => { page = p.id; render(); } }, p.label)));
  const me = $('#meBtn'); me.classList.remove('hide'); me.textContent = state.user.name; me.onclick = accountDialog;
}

const age = bd => { if (!bd) return ''; const b = new Date(bd + 'T00:00:00'), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a >= 0 ? `${a} yr` : ''; };
const canEdit = () => ['admin', 'caregiver'].includes(state.user.role);

async function patientsPage() {
  const list = await api('GET', '/patients');
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Patients'),
      canEdit() && h('button', { class: 'primary sm', onclick: () => patientDialog() }, '+ Add patient')),
    list.length ? list.map(p => h('div', { class: 'li' },
      h('span', { class: 'dot', style: `background:${p.color}` }),
      h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'note' }, [age(p.birth_date), p.notes].filter(Boolean).join(' · '))),
      canEdit() && h('button', { class: 'sm', onclick: () => patientDialog(p) }, 'Edit')))
      : h('div', { class: 'empty' }, 'No patients yet.'),
    h('p', { class: 'note', style: 'margin:10px 0 0' }, 'Medications, inventory, schedules and the shot log arrive in version 0.2.'))));
}

function patientDialog(p) {
  const err = errBox(), name = h('input', { value: p?.name || '' }), bd = h('input', { type: 'date', value: p?.birth_date || '' }),
    notes = h('textarea', { value: p?.notes || '' });
  let color = p?.color || COLORS[0];
  const sw = h('div', { class: 'swatches' }, COLORS.map(c => h('button', { type: 'button', class: c === color ? 'on' : '', style: `background:${c}`, 'aria-label': 'Color', onclick: e => { color = c; sw.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } })));
  const save = async e => {
    e.preventDefault();
    try { await api(p ? 'PUT' : 'POST', '/patients' + (p ? '/' + p.id : ''), { name: name.value, birth_date: bd.value, color, notes: notes.value }); dlg.close(); render(); } catch (x) { showErr(err, x); }
  };
  const del = async () => {
    if (!confirm(`Remove ${p.name}? Their history is kept in the activity log.`)) return;
    try { await api('DELETE', '/patients/' + p.id); dlg.close(); render(); } catch (x) { showErr(err, x); }
  };
  dlg.replaceChildren(h('form', { onsubmit: save }, h('h2', {}, p ? 'Edit patient' : 'Add patient'), err,
    field('Name', name), field('Birth date (optional)', bd), h('div', { class: 'field' }, h('span', {}, 'Color'), sw), field('Notes', notes),
    h('div', { class: 'row' }, p && state.user.role === 'admin' && h('button', { type: 'button', class: 'danger', onclick: del }, 'Remove'), h('div', { class: 'grow' }),
      h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  dlg.showModal(); name.focus();
}

async function usersPage() {
  const list = await api('GET', '/users');
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Users'), h('button', { class: 'primary sm', onclick: () => userDialog() }, '+ Add user')),
    list.map(u => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('b', {}, u.name), ' ', h('span', { class: 'note' }, '@' + u.username)),
      h('span', { class: 'chip acc' }, u.role), !u.totp && h('span', { class: 'chip warn' }, '2FA not set up'), u.disabled && h('span', { class: 'chip bad' }, 'Disabled'),
      h('button', { class: 'sm', onclick: () => userDialog(u) }, 'Edit'))),
    h('p', { class: 'note', style: 'margin:10px 0 0' }, 'New users set up two-factor sign-in the first time they sign in. Caregivers can manage patients; viewers can only look.'))));
}

function userDialog(u) {
  const err = errBox(), name = h('input', { value: u?.name || '' }), uname = h('input', { value: u?.username || '', disabled: !!u, autocapitalize: 'off' }),
    email = h('input', { type: 'email', value: u?.email || '' }), pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep' : '' }),
    role = h('select', {}, ['admin', 'caregiver', 'viewer'].map(r => h('option', { value: r, selected: (u?.role || 'caregiver') === r }, r))),
    dis = h('input', { type: 'checkbox', checked: !!u?.disabled }), reset = h('input', { type: 'checkbox' });
  const save = async e => {
    e.preventDefault();
    try {
      if (u) await api('PUT', '/users/' + u.id, { name: name.value, email: email.value, role: role.value, disabled: dis.checked, resetTotp: reset.checked, password: pw.value || undefined });
      else await api('POST', '/users', { name: name.value, username: uname.value, email: email.value, role: role.value, password: pw.value });
      dlg.close(); render();
    } catch (x) { showErr(err, x); }
  };
  dlg.replaceChildren(h('form', { onsubmit: save }, h('h2', {}, u ? 'Edit user' : 'Add user'), err,
    h('div', { class: 'two' }, field('Name', name), field('User name', uname)), h('div', { class: 'two' }, field('Email (optional)', email), field('Role', role)),
    field(u ? 'New password (12+ characters)' : 'Password (12+ characters)', pw),
    u && h('label', { class: 'row note' }, reset, 'Make them set up two-factor again (lost phone)'),
    u && h('label', { class: 'row note', style: 'margin:6px 0 10px' }, dis, 'Disabled (can\'t sign in)'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  dlg.showModal();
}

async function settingsPage() {
  const s = await api('GET', '/settings'), err = errBox(), msg = h('span', { class: 'note' });
  const inputs = {};
  const text = (k, label, type = 'text') => { inputs[k] = h('input', { type, value: s[k] || '', autocapitalize: 'off' }); return field(label, inputs[k]); };
  const secret = (k, label) => { inputs[k] = h('input', { type: 'password', autocomplete: 'off', placeholder: s[k].set ? 'Saved (leave blank to keep)' : '' }); return field(label, inputs[k]); };
  const save = async e => {
    e.preventDefault();
    const body = {}; for (const [k, el] of Object.entries(inputs)) body[k] = el.value;
    try { await api('PUT', '/settings', body); msg.textContent = 'Saved'; setTimeout(() => render(), 800); } catch (x) { showErr(err, x); }
  };
  main.replaceChildren(h('form', { class: 'page', onsubmit: save }, err,
    h('div', { class: 'card' }, h('h2', {}, 'Home Assistant'), h('p', { class: 'note' }, 'Used for push reminders from version 0.3. Tokens are encrypted on disk and never shown again.'),
      text('ha_url', 'Home Assistant URL', 'url'), secret('ha_token', 'Long-lived access token')),
    h('div', { class: 'card' }, h('h2', {}, 'ntfy (backup push)'), h('div', { class: 'two' }, text('ntfy_url', 'Server URL', 'url'), text('ntfy_topic', 'Topic')), secret('ntfy_token', 'Access token (optional)')),
    h('div', { class: 'card' }, h('h2', {}, 'Email'), h('div', { class: 'two' }, text('smtp_host', 'SMTP server'), text('smtp_port', 'Port')),
      h('div', { class: 'two' }, text('smtp_user', 'User name'), secret('smtp_pass', 'Password')), text('smtp_from', 'From address', 'email')),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save settings'), msg)));
}

async function activityPage() {
  const rows = await api('GET', '/audit');
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' }, h('h2', {}, 'Activity (last 200)'),
    h('table', { class: 'audit' }, rows.map(r => h('tr', {}, h('td', { class: 'note' }, new Date(r.at).toLocaleString()), h('td', {}, r.user || '—'), h('td', {}, r.action + (r.tbl ? ' · ' + r.tbl : '') + (r.record ? ' #' + r.record : ''))))))));
}

function accountDialog() {
  const err = errBox(), cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' }),
    code = h('input', { class: 'code-in', inputmode: 'numeric', maxlength: 6, placeholder: '000000' });
  const changePw = async () => { try { await api('POST', '/me/password', { current: cur.value, next: next.value }); dlg.close(); alert('Password changed. Other devices were signed out.'); } catch (x) { showErr(err, x); } };
  const newCodes = async () => { try { const r = await api('POST', '/me/recovery', { code: code.value }); dlg.close(); recoveryPage(r.recovery, () => render()); } catch (x) { showErr(err, x); } };
  const out = async all => { await api('POST', all ? '/logout-all' : '/logout').catch(() => {}); state.user = null; dlg.close(); render(); };
  dlg.replaceChildren(h('div', {}, h('h2', {}, state.user.name + ' (' + state.user.role + ')'), err,
    h('div', { class: 'two' }, field('Current password', cur), field('New password', next)), h('button', { onclick: changePw }, 'Change password'),
    h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:14px 0' }),
    field('New recovery codes: enter a current 6-digit code', code), h('button', { onclick: newCodes }, 'Make new recovery codes'),
    h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:14px 0' }),
    h('div', { class: 'row' }, h('button', { onclick: () => out(false) }, 'Sign out'), h('button', { class: 'danger', onclick: () => out(true) }, 'Sign out everywhere'),
      h('div', { class: 'grow' }), h('button', { onclick: () => dlg.close() }, 'Close'))));
  dlg.showModal();
}

// ---------- start ----------
async function render() {
  try {
    const s = await api('GET', '/state');
    state.version = s.version; state.user = s.user; $('#hVer').textContent = 'v' + s.version;
    if (!s.user) { $('#nav').classList.add('hide'); $('#meBtn').classList.add('hide'); return s.setup ? setupPage() : loginPage(); }
    if (!PAGES.find(p => p.id === page)?.show(s.user)) page = 'patients';
    shell();
    await ({ patients: patientsPage, users: usersPage, settings: settingsPage, activity: activityPage })[page]();
  } catch (e) {
    main.replaceChildren(h('div', { class: 'card login' }, h('div', { class: 'errbox' }, e.message), h('button', { onclick: render }, 'Try again')));
  }
}
render();
