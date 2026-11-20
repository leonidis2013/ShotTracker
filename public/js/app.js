// ShotTracker web app. Pages are built with DOM calls (no innerHTML with data), so names and notes can't inject markup.
import { scanDialog } from './scan.js';
import { bodyMap } from './bodymap.js';

const $ = s => document.querySelector(s);
const main = $('#main'), dlg = $('#dlg');
const COLORS = ['#4c8dff', '#2ec4b6', '#f2c94c', '#ef4c4c', '#3ecf6e', '#b07cff', '#ff8a3d', '#ff6fb5'];
const FORMS = { syringe: 'Prefilled syringe', pen: 'Pen', single_vial: 'Single-dose vial', multi_vial: 'Multi-dose vial' };
const FORM_UNIT = { syringe: 'syringes', pen: 'pens', single_vial: 'vials', multi_vial: 'mL' };
const UNITS = ['mg', 'mcg', 'units', 'mL'];
let state = { user: null, version: '' };

// ---------- tiny DOM helpers ----------
export function h(tag, attrs = {}, ...kids) {
  const el = tag === 'svg' || attrs?.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || k === 'svg') continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string' && !(el instanceof SVGElement)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', { class: 'note' }, hint));
const errBox = () => h('div', { class: 'errbox hide' });
const showErr = (box, e) => { box.textContent = e.message || String(e); box.classList.remove('hide'); box.scrollIntoView({ block: 'nearest' }); };
const sel = (opts, value) => h('select', {}, opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value ?? '') }, t); }));
const num = (value, attrs = {}) => h('input', { type: 'number', inputmode: 'decimal', step: 'any', value: value ?? '', ...attrs });
const txt = (value, attrs = {}) => h('input', { value: value ?? '', ...attrs });
const chk = checked => h('input', { type: 'checkbox', checked: !!checked });
const val = el => el.type === 'checkbox' ? el.checked : el.value;
const card = (title, ...kids) => h('div', { class: 'card' }, title && h('h2', {}, title), ...kids);
const btns = (...b) => h('div', { class: 'row actions' }, h('div', { class: 'grow' }), ...b);
const pill = (cls, t) => h('span', { class: 'chip ' + cls }, t);
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ''));
const SINGULAR = { syringe: 'syringe', pen: 'pen', single_vial: 'vial', multi_vial: 'mL' };
const units = (form, n) => `${+n} ${+n === 1 ? SINGULAR[form] : FORM_UNIT[form]}`;

export async function api(method, url, body, raw) {
  const r = await fetch('/api' + url, { method, credentials: 'same-origin', headers: { 'x-shottracker': '1', ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw || {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.user && !url.startsWith('/login')) { state.user = null; render(); }
  if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
  return data;
}

// ---------- formatting ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInput = d => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = d => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDateY = s => s ? new Date(s.length === 10 ? s + 'T00:00' : s).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso), n = new Date(), days = Math.round((new Date(ymd(d) + 'T00:00') - new Date(ymd(n) + 'T00:00')) / 864e5);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : fmtDate(d);
  return `${day} ${fmtTime(d)}` + (days > 1 ? ` (in ${days} days)` : '');
}
const doseText = (a, u) => a == null ? '' : `${+a} ${u || ''}`.trim();
const age = bd => { if (!bd) return ''; const b = new Date(bd + 'T00:00'), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a >= 0 ? `${a} yr` : ''; };
const STATUS = { overdue: ['bad', 'Overdue'], due: ['warn', 'Due now'], today: ['acc', 'Today'], upcoming: ['', 'Upcoming'], paused: ['', 'Paused'], none: ['', 'No date'] };
const statusPill = s => { const [c, t] = STATUS[s] || ['', s]; return pill(c, t); };
const isManager = () => ['admin', 'caregiver'].includes(state.user.role);

// ---------- theme ----------
$('#themeBtn').onclick = () => {
  const light = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  try { localStorage.setItem('st-theme', light ? 'light' : 'dark'); } catch (e) {}
};

// ---------- sign-in ----------
function setupPage() {
  const err = errBox(), name = txt('', { autocomplete: 'name' }), user = txt('', { autocomplete: 'username', autocapitalize: 'off' }),
    pw = h('input', { type: 'password', autocomplete: 'new-password' }), pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const go = async e => {
    e.preventDefault();
    if (pw.value !== pw2.value) return showErr(err, new Error('The passwords don\'t match'));
    try { codePage(await api('POST', '/setup', { name: name.value, username: user.value, password: pw.value, remember: true })); } catch (x) { showErr(err, x); }
  };
  fill(main, h('form', { class: 'card login', onsubmit: go },
    h('h2', {}, 'Create the admin account'),
    h('p', { class: 'note' }, 'This is the first visit. The account you make here can add patients and other users. Next you\'ll set up two-factor sign-in.'),
    err, field('Your name', name), field('User name', user), field('Password (12+ characters)', pw), field('Password again', pw2),
    h('button', { class: 'primary', type: 'submit' }, 'Create account')));
  name.focus();
}
function loginPage() {
  const err = errBox(), user = txt('', { autocomplete: 'username', autocapitalize: 'off' }), pw = h('input', { type: 'password', autocomplete: 'current-password' }), rem = chk(true);
  const go = async e => { e.preventDefault(); try { codePage(await api('POST', '/login', { username: user.value, password: pw.value, remember: rem.checked })); } catch (x) { showErr(err, x); } };
  fill(main, h('form', { class: 'card login', onsubmit: go },
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
    h('a', { href: r.uri, class: 'btnlink' }, 'Open in authenticator app'),
    h('div', { class: 'note' }, 'Or type this setup key into the app:'),
    h('div', { class: 'secret', style: 'margin:4px 0 12px' }, r.secret.match(/.{1,4}/g).join(' ')),
    h('div', { class: 'note', style: 'margin-bottom:6px' }, 'Then enter the 6-digit code it shows:'),
  ] : [h('p', { class: 'note' }, 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.')];
  fill(main, h('form', { class: 'card login', onsubmit: go },
    h('h2', {}, r.step === 'enroll' ? 'Set up two-factor sign-in' : 'Two-factor code'), err, ...enroll, code,
    h('button', { class: 'primary', type: 'submit', style: 'width:100%;margin-top:8px' }, 'Sign in'),
    h('button', { type: 'button', style: 'width:100%;margin-top:6px', onclick: () => render() }, 'Start over')));
  code.focus();
}
function recoveryPage(codes, done) {
  fill(main, h('div', { class: 'card login' },
    h('h2', {}, 'Save your recovery codes'),
    h('p', { class: 'note' }, 'If you lose your phone, each of these codes signs you in once instead of the 6-digit code. Store them somewhere safe, like a password manager. They won\'t be shown again.'),
    h('div', { class: 'codes' }, codes.map(c => h('div', {}, c))),
    h('button', { class: 'primary', style: 'width:100%;margin-top:10px', onclick: done }, 'I saved them')));
}

// ---------- navigation ----------
const PAGES = [
  { id: 'today', label: 'Today', show: () => true },
  { id: 'patients', label: 'Patients', show: () => true },
  { id: 'inventory', label: 'Inventory', show: u => u.role !== 'patient' },
  { id: 'reports', label: 'Reports', show: () => true },
  { id: 'settings', label: 'Settings', show: u => ['admin', 'caregiver'].includes(u.role) },
];
const route = () => { const [p, ...rest] = (location.hash.slice(1) || 'today').split('/'); return { page: p, args: rest }; };
const go = hash => { if (location.hash === '#' + hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => render());
function shell(page) {
  const nav = $('#nav'); nav.classList.remove('hide');
  const cur = page === 'patient' ? 'patients' : page;
  fill(nav, ...PAGES.filter(p => p.show(state.user)).map(p => h('button', { class: cur === p.id ? 'on' : '', onclick: () => go(p.id) }, p.label)));
  const me = $('#meBtn'); me.classList.remove('hide'); me.textContent = state.user.name; me.onclick = () => go('account');
}

// ---------- Today ----------
async function todayPage() {
  const t = await api('GET', '/today');
  const alerts = t.alerts.length ? card('Heads-up', t.alerts.map(a => h('div', { class: 'alert ' + a.level }, a.text))) : null;
  const pats = t.patients.map(v => card(null,
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'dot', style: `background:${v.patient.color}` }), h('b', { class: 'grow big' }, v.patient.name),
      h('button', { class: 'sm', onclick: () => go('patient/' + v.patient.id) }, 'Details')),
    v.schedules.length ? v.schedules.map(s => h('div', { class: 'shot ' + s.status },
      h('div', { class: 'grow' },
        h('div', { class: 'row' }, h('b', {}, s.med_name), doseText(s.dose_amount, s.dose_unit) && h('span', { class: 'note' }, doseText(s.dose_amount, s.dose_unit) + (s.volume_ml != null && s.dose_unit !== 'mL' ? ` · ${s.volume_ml} mL` : '')), statusPill(s.status)),
        h('div', { class: 'note' }, s.paused ? 'Paused' : fmtWhen(s.due_at), s.snoozed_until ? ` · snoozed until ${fmtTime(new Date(s.snoozed_until))}` : '', ' · ', s.describe),
        s.last_given && h('div', { class: 'note faint' }, 'Last given ' + fmtWhen(s.last_given))),
      v.can_log && !s.paused && h('div', { class: 'col-btns' },
        h('button', { class: s.status === 'upcoming' ? '' : 'primary', onclick: () => logDialog({ schedule_id: s.id }) }, 'Log shot'),
        ['overdue', 'due', 'today'].includes(s.status) && h('button', { class: 'sm', onclick: async () => { await api('POST', `/schedules/${s.id}/snooze`, { minutes: 60 }); render(); } }, 'Snooze 1 hr'))))
      : h('div', { class: 'empty' }, 'No schedules yet. ', v.can_manage && h('a', { href: '#patient/' + v.patient.id }, 'Add a medication')),
    v.recent.length > 0 && h('details', { class: 'recent' }, h('summary', { class: 'note' }, 'Recent'), v.recent.map(d => doseLine(d)))));
  fill(main, h('div', { class: 'page' }, alerts, ...pats,
    !t.patients.length && card('Welcome', h('p', {}, isManager() ? 'Start by adding a patient.' : 'No patients are shared with you yet.'), isManager() && h('button', { class: 'primary', onclick: () => patientDialog() }, '+ Add patient'))));
}
function doseLine(d, onEdit) {
  const st = d.status === 'given' ? [d.timing === 'late' ? 'warn' : 'ok', d.timing === 'late' ? 'Late' : 'Given'] : d.status === 'skipped' ? ['', 'Skipped'] : ['bad', 'Missed'];
  return h('div', { class: 'li dose' },
    h('div', { class: 'grow' },
      h('div', {}, h('b', {}, d.med_name), ' ', d.patient_name && h('span', { class: 'note' }, d.patient_name), ' ', pill(st[0], st[1])),
      h('div', { class: 'note' }, [d.given_at ? fmtWhen(d.given_at) : d.due_at ? 'Due ' + fmtWhen(d.due_at) : fmtWhen(d.created_at), doseText(d.amount, d.unit), d.site_name, d.lot_number && 'lot ' + d.lot_number, d.given_by_name && 'by ' + d.given_by_name].filter(Boolean).join(' · ')),
      (d.reaction || d.notes || d.reason) && h('div', { class: 'note faint' }, [d.reason, d.reaction && 'Reaction: ' + d.reaction, d.notes].filter(Boolean).join(' · '))),
    onEdit && h('button', { class: 'sm', onclick: () => onEdit(d) }, 'Edit'));
}

// ---------- Log a shot ----------
async function logDialog(q, existing) {
  const f = await api('GET', '/log-form?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v != null)));
  const med = f.medication, err = errBox(), e = existing || {};
  const status = sel([['given', 'Given'], ['skipped', 'Skipped'], ['missed', 'Missed']], e.status || 'given');
  const when = h('input', { type: 'datetime-local', value: localInput(new Date(e.given_at || Date.now())), max: localInput(new Date(Date.now() + 5 * 60e3)) });
  const amount = num(e.amount ?? f.dose_amount), unit = sel(UNITS, e.unit || f.dose_unit || med.conc_unit || 'mg');
  const volInfo = h('div', { class: 'draw' }), warn = h('div', { class: 'warn-line hide' });
  const lotSel = sel([['', '— none —'], ...f.lots.filter(l => l.usable || l.id === e.lot_id).map(l => [l.id, `Lot ${l.lot_number || '#' + l.id} · ${units(med.form, l.qty_left)} left` + (l.expires ? ` · exp ${fmtDateY(l.expires)}` : '') + (l.discard_by ? ` · discard ${fmtDateY(l.discard_by)}` : '')])], e.lot_id !== undefined ? e.lot_id : f.lot_id);
  let siteId = e.site_id !== undefined ? e.site_id : f.site_id;
  const siteName = h('b'), siteList = h('div', { class: 'sites' });
  const map = bodyMap(f.sites, { selected: siteId, onPick: id => { siteId = id; drawSites(); } });
  const drawSites = () => {
    map.select(siteId);
    const s = f.sites.find(x => x.id === siteId); siteName.textContent = s ? s.name : 'none';
    fill(siteList, ...f.sites.filter(x => x.enabled).map(x => h('button', { type: 'button', class: 'sm site' + (x.id === siteId ? ' on' : '') + (x.resting ? ' resting' : ''), onclick: () => { siteId = x.id; drawSites(); } },
      x.name, h('small', {}, x.last_used ? (x.days_since === 0 ? 'today' : x.days_since + 'd ago') : 'never'))));
  };
  const reaction = txt(e.reaction, { placeholder: 'Redness, pain, none…' }), notes = h('textarea', { value: e.notes || '', rows: 2 }), reason = txt(e.reason, { placeholder: 'Why it was skipped or missed' });
  const givenBox = h('div'), otherBox = h('div', {}, field('Reason', reason));
  const calc = () => {
    const a = parseFloat(amount.value), u = unit.value;
    let vol = null; if (!isNaN(a)) vol = u === 'mL' ? a : (med.conc && u === med.conc_unit ? Math.round(a / med.conc * 1000) / 1000 : null);
    fill(volInfo, vol != null ? h('span', {}, 'Draw / inject ', h('b', {}, vol + ' mL')) : h('span', { class: 'note' }, med.conc ? '' : 'Add the concentration to the medication to see the volume.'));
    const w = [];
    if (f.schedule && f.dose_amount != null && (a !== +f.dose_amount || u !== f.dose_unit)) w.push(`Scheduled dose is ${doseText(f.dose_amount, f.dose_unit)}.`);
    if (vol != null && med.unit_ml && med.form !== 'multi_vial' && vol > med.unit_ml + 1e-6) w.push(`That's more than one ${FORMS[med.form].toLowerCase()} (${med.unit_ml} mL each).`);
    warn.textContent = w.join(' '); warn.classList.toggle('hide', !w.length);
  };
  const toggle = () => { givenBox.classList.toggle('hide', status.value !== 'given'); otherBox.classList.toggle('hide', status.value === 'given'); };
  amount.oninput = calc; unit.onchange = calc; status.onchange = toggle;
  givenBox.append(
    field('Given at', when), h('div', { class: 'pair' }, field('Dose', amount), field('Unit', unit)), volInfo, warn,
    field('Lot', lotSel, f.lots.filter(l => l.usable).length ? null : 'No usable stock recorded. Add a shipment under Inventory.'),
    h('div', { class: 'field' }, h('span', {}, 'Site: ', siteName), map.el, siteList),
    field('Reaction (optional)', reaction));
  const save = async ev => {
    ev.preventDefault();
    const body = { medication_id: med.id, schedule_id: f.schedule ? f.schedule.id : null, status: status.value, notes: notes.value, reason: reason.value, reaction: reaction.value };
    if (status.value === 'given') Object.assign(body, { given_at: new Date(when.value).toISOString(), amount: amount.value, unit: unit.value, lot_id: lotSel.value ? +lotSel.value : null, site_id: siteId || null });
    if (existing) delete body.schedule_id;
    try { await api(existing ? 'PUT' : 'POST', '/doses' + (existing ? '/' + existing.id : ''), body); dlg.close(); if (location.hash.startsWith('#log')) go('today'); else render(); } catch (x) { showErr(err, x); }
  };
  const del = existing && (async () => { if (!confirm('Delete this entry? Stock it used is put back.')) return; try { await api('DELETE', '/doses/' + existing.id); dlg.close(); render(); } catch (x) { showErr(err, x); } });
  fill(dlg, h('form', { onsubmit: save },
    h('h2', {}, existing ? 'Edit entry' : 'Log shot'),
    h('div', { class: 'loghead' }, h('span', { class: 'dot', style: `background:${f.patient.color}` }), h('b', {}, f.patient.name), ' · ', h('b', {}, med.name),
      f.schedule && f.schedule.due_at && !existing && h('div', { class: 'note' }, 'Due ' + fmtWhen(f.schedule.due_at), ' ', statusPill(f.schedule.status))),
    err, field('What happened', status), givenBox, otherBox, field('Notes', notes),
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete'), h('button', { type: 'button', onclick: () => { dlg.close(); if (location.hash.startsWith('#log')) go('today'); } }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  calc(); toggle(); drawSites(); dlg.showModal();
}

// ---------- Patients ----------
async function patientsPage() {
  const list = await api('GET', '/patients');
  fill(main, h('div', { class: 'page' }, card(null,
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Patients'), isManager() && h('button', { class: 'primary sm', onclick: () => patientDialog() }, '+ Add patient')),
    list.length ? list.map(p => h('div', { class: 'li click', onclick: () => go('patient/' + p.id) },
      h('span', { class: 'dot', style: `background:${p.color}` }), h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'note' }, [age(p.birth_date), p.notes].filter(Boolean).join(' · '))), h('span', { class: 'note' }, '›')))
      : h('div', { class: 'empty' }, 'No patients yet.'))));
}
function patientDialog(p) {
  const err = errBox(), name = txt(p?.name), bd = h('input', { type: 'date', value: p?.birth_date || '' }), notes = h('textarea', { value: p?.notes || '' });
  let color = p?.color || COLORS[0];
  const sw = h('div', { class: 'swatches' }, COLORS.map(c => h('button', { type: 'button', class: c === color ? 'on' : '', style: `background:${c}`, 'aria-label': 'Color', onclick: ev => { color = c; sw.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === ev.currentTarget)); } })));
  const save = async ev => { ev.preventDefault(); try { const r = await api(p ? 'PUT' : 'POST', '/patients' + (p ? '/' + p.id : ''), { name: name.value, birth_date: bd.value, color, notes: notes.value }); dlg.close(); p ? render() : go('patient/' + r.id); } catch (x) { showErr(err, x); } };
  const del = async () => { if (!confirm(`Remove ${p.name}? Their history stays in the database and the activity log.`)) return; try { await api('DELETE', '/patients/' + p.id); dlg.close(); go('patients'); } catch (x) { showErr(err, x); } };
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, p ? 'Edit patient' : 'Add patient'), err,
    field('Name', name), field('Birth date (optional)', bd), h('div', { class: 'field' }, h('span', {}, 'Color'), sw), field('Notes', notes),
    !p && h('p', { class: 'note' }, 'Common injection sites (abdomen, thighs, upper arms, buttocks) are added; you can change them on the patient\'s Sites tab.'),
    btns(p && state.user.role === 'admin' && h('button', { type: 'button', class: 'danger', onclick: del }, 'Remove'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  dlg.showModal(); name.focus();
}

let patientTab = 'meds';
async function patientPage(id) {
  const [d, history] = await Promise.all([api('GET', '/patients/' + id), api('GET', '/doses?limit=100&patient_id=' + id)]);
  const p = d.patient, man = d.can_manage;
  const tabs = [['meds', 'Medications'], ['history', 'History'], ['sites', 'Sites'], ['weight', 'Weight']];
  const body = h('div', { class: 'col' });
  const drawTab = () => {
    tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === patientTab));
    if (patientTab === 'meds') fill(body, 
      ...d.medications.map(m => medCard(m, d)),
      !d.medications.length && h('div', { class: 'card empty' }, 'No medications yet.'),
      man && h('button', { class: 'primary', onclick: () => medDialog({ patient_id: p.id }) }, '+ Add medication'));
    if (patientTab === 'history') fill(body, card('History (latest 100)',
      d.can_log && d.medications.some(m => m.active) && h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Log a shot outside the schedule:'),
        ...d.medications.filter(m => m.active).map(m => h('button', { class: 'sm', onclick: () => logDialog({ medication_id: m.id }) }, m.name))),
      history.length ? history.map(x => doseLine(x, d.can_log ? ex => logDialog({ medication_id: ex.medication_id, schedule_id: ex.schedule_id }, ex) : null)) : h('div', { class: 'empty' }, 'Nothing logged yet.')));
    if (patientTab === 'sites') fill(body, sitesEditor(p, d.sites, man));
    if (patientTab === 'weight') fill(body, weightCard(p, d.weights, d.can_log, man));
  };
  const tabBar = h('div', { class: 'seg' }, tabs.map(([t, l]) => h('button', { 'data-t': t, onclick: () => { patientTab = t; drawTab(); } }, l)));
  fill(main, h('div', { class: 'page' },
    h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => go('patients') }, '‹ Patients'), h('div', { class: 'grow' })),
    h('div', { class: 'row' }, h('span', { class: 'dot lg', style: `background:${p.color}` }), h('h1', { class: 'title grow' }, p.name), h('span', { class: 'note' }, age(p.birth_date)),
      man && h('button', { class: 'sm', onclick: () => patientDialog(p) }, 'Edit')),
    tabBar, body));
  drawTab();
}
function medCard(m, d) {
  const man = d.can_manage;
  const strength = m.conc ? (m.form === 'multi_vial' ? `${+m.conc} ${m.conc_unit}/mL · ${m.unit_ml || '?'} mL vial` : `${Math.round(m.conc * (m.unit_ml || 1) * 1000) / 1000} ${m.conc_unit} in ${m.unit_ml} mL`) : '';
  return card(null,
    h('div', { class: 'row' }, h('b', { class: 'big grow' }, m.name, !m.active && ' (inactive)'), man && h('button', { class: 'sm', onclick: () => medDialog(m) }, 'Edit')),
    h('div', { class: 'note' }, [FORMS[m.form], strength, m.route, m.storage === 'fridge' ? 'Refrigerated' : m.storage === 'freezer' ? 'Frozen' : 'Room temp'].filter(Boolean).join(' · ')),
    h('div', { class: 'stats' },
      h('div', {}, h('small', {}, 'In stock'), h('b', {}, units(m.form, m.stock))),
      h('div', {}, h('small', {}, 'Days of supply'), h('b', { class: m.days_of_supply != null && m.days_of_supply <= m.reorder_days ? 'warn' : '' }, m.days_of_supply ?? '—')),
      h('div', {}, h('small', {}, 'Refills left'), h('b', {}, m.refills_left ?? '—')),
      h('div', {}, h('small', {}, 'Next shipment'), h('b', {}, m.next_shipment ? fmtDateY(m.next_shipment) : '—'))),
    h('div', { class: 'sub-h' }, 'Schedule'),
    m.schedules.map(s => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('div', {}, s.info.describe, ' · ', doseText(s.info.dose_amount, s.info.dose_unit), ' ', statusPill(s.info.status)),
        h('div', { class: 'note' }, s.paused ? 'Paused' : 'Next: ' + fmtWhen(s.info.due_at), s.anchor === 'last' ? ' · counted from the last shot' : '', s.steps.length ? ` · ${s.steps.length} dose change(s)` : '')),
      man && h('button', { class: 'sm', onclick: () => scheduleDialog(m, s) }, 'Edit'))),
    !m.schedules.length && h('div', { class: 'note' }, 'No schedule.'),
    man && h('button', { class: 'sm', style: 'margin-top:6px', onclick: () => scheduleDialog(m) }, '+ Add schedule'),
    (m.prescriber || m.pharmacy || m.rx_number) && h('div', { class: 'note', style: 'margin-top:8px' }, [m.prescriber && 'Prescriber: ' + m.prescriber, m.pharmacy && 'Pharmacy: ' + m.pharmacy + (m.pharmacy_phone ? ' ' + m.pharmacy_phone : ''), m.rx_number && 'Rx ' + m.rx_number].filter(Boolean).join(' · ')),
    m.notes && h('div', { class: 'note' }, m.notes));
}
function medDialog(m) {
  const isNew = !m.id, err = errBox();
  const name = txt(m.name), generic = txt(m.generic), form = sel(Object.entries(FORMS), m.form || 'syringe');
  const amt = num(m.conc && m.unit_ml && m.form !== 'multi_vial' ? Math.round(m.conc * m.unit_ml * 1000) / 1000 : m.conc), cunit = sel(['mg', 'mcg', 'units'], m.conc_unit || 'mg'), ml = num(m.unit_ml);
  const route = sel(['SubQ', 'IM', 'IV', 'ID', 'other'], m.route || 'SubQ'), storage = sel([['fridge', 'Refrigerated'], ['room', 'Room temperature'], ['freezer', 'Frozen']], m.storage || 'fridge');
  const opened = num(m.opened_days, { step: 1 }), prescriber = txt(m.prescriber), pharmacy = txt(m.pharmacy), phone = txt(m.pharmacy_phone, { type: 'tel' }), rx = txt(m.rx_number);
  const refills = num(m.refills_left, { step: 1 }), ship = h('input', { type: 'date', value: m.next_shipment || '' }), reorder = num(m.reorder_days ?? 21, { step: 1 }), ndc = txt(m.ndc), notes = h('textarea', { value: m.notes || '', rows: 2 }), active = chk(m.active ?? true);
  const strengthBox = h('div');
  const drawStrength = () => {
    const vial = form.value === 'multi_vial';
    fill(strengthBox, vial
      ? h('div', { class: 'three' }, field('Concentration', amt), field('Unit per mL', cunit), field('Vial size (mL)', ml))
      : h('div', { class: 'three' }, field(`Each ${FORMS[form.value].toLowerCase()} holds`, amt), field('Unit', cunit), field('In (mL)', ml)),
      vial && field('Good for (days after opening)', opened, 'Sets the "discard by" date when a vial is first used.'));
  };
  form.onchange = drawStrength;
  const save = async ev => {
    ev.preventDefault();
    const a = parseFloat(amt.value), v = parseFloat(ml.value);
    const conc = isNaN(a) ? null : form.value === 'multi_vial' ? a : (v ? Math.round(a / v * 1e6) / 1e6 : null);
    const body = { name: name.value, generic: generic.value, form: form.value, conc, conc_unit: cunit.value, unit_ml: isNaN(v) ? null : v, route: route.value, storage: storage.value, opened_days: opened.value,
      prescriber: prescriber.value, pharmacy: pharmacy.value, pharmacy_phone: phone.value, rx_number: rx.value, refills_left: refills.value, next_shipment: ship.value, reorder_days: reorder.value, ndc: ndc.value, notes: notes.value, active: active.checked };
    if (isNew) body.patient_id = m.patient_id;
    try { await api(isNew ? 'POST' : 'PUT', '/meds' + (isNew ? '' : '/' + m.id), body); dlg.close(); render(); } catch (x) { showErr(err, x); }
  };
  const del = !isNew && (async () => { if (!confirm(`Remove ${m.name}? Its history stays.`)) return; try { await api('DELETE', '/meds/' + m.id); dlg.close(); render(); } catch (x) { showErr(err, x); } });
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, isNew ? 'Add medication' : 'Edit medication'), err,
    h('div', { class: 'two' }, field('Name', name), field('Generic name (optional)', generic)),
    h('div', { class: 'three' }, field('Form', form), field('Route', route), field('Storage', storage)), strengthBox,
    h('div', { class: 'sub-h' }, 'Prescription and refills'),
    h('div', { class: 'two' }, field('Prescriber', prescriber), field('Rx number', rx)),
    h('div', { class: 'two' }, field('Pharmacy', pharmacy), field('Pharmacy phone', phone)),
    h('div', { class: 'three' }, field('Refills left', refills), field('Next shipment', ship), field('Warn at days of supply', reorder)),
    field('NDC (optional, matches scanned cartons)', ndc), field('Notes', notes),
    !isNew && h('label', { class: 'row note' }, active, 'Active (uncheck to stop tracking without deleting)'),
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Remove'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  drawStrength(); dlg.showModal(); if (isNew) name.focus();
}
function scheduleDialog(m, s = {}) {
  const isNew = !s.id, err = errBox();
  const kind = sel([['weeks', 'Every X weeks'], ['days', 'Every X days'], ['months', 'Every X months'], ['weekdays', 'On certain weekdays']], s.kind || 'weeks');
  const every = num(s.every ?? (isNew ? 2 : 1), { step: 1, min: 1 }), time = h('input', { type: 'time', value: s.time_of_day || '20:00' });
  const wd = (s.weekdays || '').split(','), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => h('label', { class: 'wd' }, chk(wd.includes(String(i))), n));
  const grace = sel([[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [720, '12 hours'], [1440, '1 day']], s.grace_min ?? 120);
  const anchor = sel([['calendar', 'Fixed calendar (stays on its dates)'], ['last', 'Counted from the last shot']], s.anchor || 'calendar');
  const start = h('input', { type: 'date', value: s.start_date || ymd(new Date()) }), end = h('input', { type: 'date', value: s.end_date || '' });
  const amount = num(s.dose_amount), unit = sel(UNITS, s.dose_unit || m.conc_unit || 'mg'), paused = chk(s.paused);
  const steps = (s.steps || []).map(x => ({ ...x }));
  const stepBox = h('div');
  const drawSteps = () => fill(stepBox, ...steps.map((st, i) => h('div', { class: 'row step' },
    h('input', { type: 'date', value: st.start_date || '', onchange: e => st.start_date = e.target.value }),
    num(st.dose_amount, { style: 'width:90px', oninput: e => st.dose_amount = e.target.value }),
    (() => { const u = sel(UNITS, st.dose_unit || unit.value); u.onchange = () => st.dose_unit = u.value; st.dose_unit = u.value; return u; })(),
    h('button', { type: 'button', class: 'sm danger', onclick: () => { steps.splice(i, 1); drawSteps(); } }, '×'))),
    h('button', { type: 'button', class: 'sm', onclick: () => { steps.push({ start_date: ymd(new Date()), dose_amount: '', dose_unit: unit.value }); drawSteps(); } }, '+ Dose change'));
  const kindBox = h('div');
  const drawKind = () => fill(kindBox, kind.value === 'weekdays' ? h('div', { class: 'field' }, h('span', {}, 'Days'), h('div', { class: 'row' }, days)) : field('Every', every));
  kind.onchange = drawKind;
  const save = async ev => {
    ev.preventDefault();
    const body = { kind: kind.value, every: kind.value === 'weekdays' ? 1 : every.value, weekdays: days.map((d, i) => d.firstChild.checked ? i : null).filter(x => x != null).join(','), time_of_day: time.value,
      grace_min: grace.value, anchor: anchor.value, start_date: start.value, end_date: end.value, dose_amount: amount.value, dose_unit: unit.value, paused: paused.checked, steps };
    if (isNew) body.medication_id = m.id;
    try { await api(isNew ? 'POST' : 'PUT', '/schedules' + (isNew ? '' : '/' + s.id), body); dlg.close(); render(); } catch (x) { showErr(err, x); }
  };
  const del = !isNew && (async () => { if (!confirm('Delete this schedule? Logged shots stay.')) return; try { await api('DELETE', '/schedules/' + s.id); dlg.close(); render(); } catch (x) { showErr(err, x); } });
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, (isNew ? 'Add schedule: ' : 'Edit schedule: ') + m.name), err,
    h('div', { class: 'two' }, field('Repeats', kind), kindBox),
    h('div', { class: 'two' }, field('Time of day', time), field('Late after', grace)),
    h('div', { class: 'two' }, field('First dose date', start, 'For a fixed calendar, the dates repeat from here.'), field('End date (optional)', end)),
    field('Next date is', anchor),
    h('div', { class: 'two' }, field('Dose', amount), field('Unit', unit)),
    h('div', { class: 'field' }, h('span', {}, 'Dose changes over time (titration or taper)'), stepBox),
    h('label', { class: 'row note' }, paused, 'Paused (doctor hold, illness)'),
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  drawKind(); drawSteps(); dlg.showModal();
}
function sitesEditor(p, sites, man) {
  const list = sites.map(s => ({ ...s }));
  let picked = list[0]?.id ?? null;
  const err = errBox(), rows = h('div');
  const map = bodyMap(list, { selected: picked, editable: man, onPick: id => { picked = id; draw(); }, onPlace: (view, x, y) => { const s = list.find(z => z.id === picked); if (s) { Object.assign(s, { view, x, y }); draw(); } } });
  const draw = () => {
    map.update(list); map.select(picked);
    fill(rows, ...list.map((s, i) => h('div', { class: 'li site-row' + (s.id === picked ? ' on' : ''), onclick: () => { picked = s.id; draw(); } },
      man ? txt(s.name, { class: 'grow', oninput: e => s.name = e.target.value }) : h('b', { class: 'grow' }, s.name),
      h('span', { class: 'note' }, s.last_used ? `used ${s.days_since === 0 ? 'today' : s.days_since + 'd ago'}` : 'never used'),
      man ? h('label', { class: 'note row' }, 'rest', num(s.rest_days, { step: 1, style: 'width:56px', oninput: e => s.rest_days = e.target.value }), 'd') : h('span', { class: 'note' }, `rest ${s.rest_days}d`),
      man && h('label', { class: 'note row' }, (() => { const c = chk(s.enabled); c.onchange = () => s.enabled = c.checked; return c; })(), 'on'),
      man && h('button', { type: 'button', class: 'sm danger', onclick: ev => { ev.stopPropagation(); list.splice(i, 1); draw(); } }, '×'))));
  };
  const add = () => { const id = 'n' + Date.now(); list.push({ id, name: 'New site', view: 'front', x: 50, y: 50, rest_days: 7, enabled: true }); picked = id; draw(); };
  const save = async () => { try { await api('PUT', `/patients/${p.id}/sites`, { sites: list.map(s => ({ ...s, id: typeof s.id === 'number' ? s.id : undefined })) }); render(); } catch (x) { showErr(err, x); } };
  draw();
  return card('Injection sites', err, map.el,
    man && h('p', { class: 'note' }, 'Pick a site in the list, then tap the body map to move it. "Rest" is how many days before it\'s suggested again.'),
    rows, man && btns(h('button', { onclick: add }, '+ Add site'), h('button', { class: 'primary', onclick: save }, 'Save sites')));
}
function weightCard(p, weights, canLog, man) {
  const err = errBox(), date = h('input', { type: 'date', value: ymd(new Date()) }), lb = num('', { placeholder: 'lb' });
  const add = async () => { try { await api('POST', `/patients/${p.id}/weights`, { date: date.value, lb: lb.value }); render(); } catch (x) { showErr(err, x); } };
  return card('Weight', err,
    canLog && h('div', { class: 'row' }, date, lb, h('button', { class: 'primary', onclick: add }, 'Add')),
    weights.length ? weights.map(w => h('div', { class: 'li' }, h('span', { class: 'grow' }, fmtDateY(w.date)), h('b', {}, w.lb + ' lb'),
      man && h('button', { class: 'sm danger', onclick: async () => { await api('DELETE', `/patients/${p.id}/weights/${w.id}`); render(); } }, '×'))) : h('div', { class: 'empty' }, 'No weights recorded.'));
}

// ---------- Inventory ----------
async function inventoryPage(openMid) {
  const pats = await api('GET', '/patients');
  const details = await Promise.all(pats.map(p => api('GET', '/patients/' + p.id)));
  const supplies = await api('GET', '/supplies');
  const search = txt('', { placeholder: 'Lot number', autocapitalize: 'characters' }), found = h('div');
  const lookup = async () => {
    const r = search.value.trim() ? await api('GET', '/lots/search?q=' + encodeURIComponent(search.value.trim())) : [];
    fill(found, ...(r.length ? r.map(l => h('div', { class: 'li col' }, h('div', {}, h('b', {}, 'Lot ' + l.lot_number), ' · ', l.patient_name, ': ', l.med_name, l.expires ? ' · exp ' + fmtDateY(l.expires) : ''),
      l.doses.length ? l.doses.map(x => doseLine(x)) : h('div', { class: 'note' }, 'No shots from this lot.'))) : search.value.trim() ? [h('div', { class: 'note' }, 'No lot matches.')] : []));
  };
  search.onkeydown = e => { if (e.key === 'Enter') lookup(); };
  const medsBlock = details.flatMap(d => d.medications.filter(m => m.active).map(m => card(null,
    h('div', { class: 'row' }, h('span', { class: 'dot', style: `background:${d.patient.color}` }), h('b', { class: 'big grow' }, d.patient.name, ': ', m.name),
      d.can_manage && h('button', { class: 'primary sm', onclick: () => lotDialog(m) }, '+ Receive')),
    h('div', { class: 'note' }, `${units(m.form, m.stock)} usable`, m.days_of_supply != null ? ` · about ${m.days_of_supply} days` : '', m.refills_left != null ? ` · ${m.refills_left} refills left` : '', m.next_shipment ? ` · next shipment ${fmtDateY(m.next_shipment)}` : ''),
    m.lots.length ? h('table', { class: 'tbl' }, h('tr', {}, ['Lot', 'Expires', 'Left', 'Where', ''].map(t => h('th', {}, t))),
      m.lots.map(l => h('tr', { class: l.usable ? '' : 'dim' },
        h('td', {}, l.lot_number || '—', l.discard_by && h('div', { class: 'note' }, 'discard ' + fmtDateY(l.discard_by))),
        h('td', { class: l.expires && l.expires < ymd(new Date()) ? 'bad' : '' }, fmtDateY(l.expires) || '—'),
        h('td', {}, `${+l.qty_left}/${+l.qty_received}`), h('td', {}, l.location || ''),
        h('td', {}, d.can_manage && h('button', { class: 'sm', onclick: () => lotDialog(m, l) }, 'Edit')))))
      : h('div', { class: 'note' }, 'No stock recorded.'))));
  fill(main, h('div', { class: 'page' },
    ...medsBlock, !medsBlock.length && card('Medications', h('div', { class: 'empty' }, 'Add medications on a patient\'s page first.')),
    suppliesCard(supplies),
    card('Lot lookup', h('p', { class: 'note' }, 'Find every shot given from a lot, for example after a recall notice.'), h('div', { class: 'row' }, search, h('button', { onclick: lookup }, 'Search')), found)));
  if (openMid) { const m = details.flatMap(d => d.medications).find(x => x.id === openMid); if (m) lotDialog(m); }
}
function lotDialog(m, l) {
  const isNew = !l, err = errBox(), e = l || {};
  const lot = txt(e.lot_number, { autocapitalize: 'characters' }), exp = h('input', { type: 'date', value: e.expires || '' }), ndc = txt(e.ndc || m.ndc);
  const qty = num(e.qty_received ?? (m.form === 'multi_vial' ? m.unit_ml : 1)), left = num(e.qty_left), rec = h('input', { type: 'date', value: e.received || ymd(new Date()) });
  const opened = h('input', { type: 'date', value: e.opened || '' }), discard = h('input', { type: 'date', value: e.discard_by || '' });
  const loc = txt(e.location ?? (m.storage === 'fridge' ? 'Fridge' : '')), notes = txt(e.notes), refill = chk(isNew && m.refills_left > 0), ship = h('input', { type: 'date', value: '' });
  const scanMsg = h('div', { class: 'note' });
  const scan = () => scanDialog(r => {
    if (r.lot) lot.value = r.lot; if (r.expires) exp.value = r.expires; if (r.ndc) ndc.value = r.ndc;
    scanMsg.textContent = r.ndc && m.ndc && r.ndc.replace(/-/g, '') !== m.ndc.replace(/-/g, '') ? `Heads-up: scanned NDC ${r.ndc} doesn't match this medication's NDC ${m.ndc}.` : 'Filled in from the carton barcode. Check it before saving.';
  });
  const save = async ev => {
    ev.preventDefault();
    const body = { lot_number: lot.value, expires: exp.value, ndc: ndc.value, qty_received: qty.value, received: rec.value, location: loc.value, notes: notes.value };
    if (isNew) { body.medication_id = m.id; body.used_refill = refill.checked; if (ship.value) body.next_shipment = ship.value; }
    else Object.assign(body, { qty_left: left.value, opened: opened.value, discard_by: discard.value });
    try { await api(isNew ? 'POST' : 'PUT', '/lots' + (isNew ? '' : '/' + l.id), body); dlg.close(); leave(); } catch (x) { showErr(err, x); }
  };
  const leave = () => location.hash.startsWith('#receive') ? go('inventory') : render();
  const del = !isNew && (async () => { if (!confirm('Delete this lot?')) return; try { await api('DELETE', '/lots/' + l.id); dlg.close(); render(); } catch (x) { showErr(err, x); } });
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, (isNew ? 'Receive shipment: ' : 'Edit lot: ') + m.name), err,
    h('button', { type: 'button', class: 'scanbtn', onclick: scan }, 'Scan carton barcode'), scanMsg,
    h('div', { class: 'two' }, field('Lot number', lot), field('Expires', exp)),
    h('div', { class: 'two' }, field(`Quantity received (${FORM_UNIT[m.form]})`, qty), isNew ? field('Received', rec) : field(`Left (${FORM_UNIT[m.form]})`, left)),
    !isNew && m.form === 'multi_vial' && h('div', { class: 'two' }, field('Opened', opened), field('Discard by', discard)),
    h('div', { class: 'two' }, field('Where it\'s kept', loc), field('NDC', ndc)), field('Notes', notes),
    isNew && h('label', { class: 'row note' }, refill, `This used a refill (${m.refills_left ?? 0} left)`),
    isNew && field('Next shipment expected (optional)', ship),
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete'), h('button', { type: 'button', onclick: () => { dlg.close(); if (location.hash.startsWith('#receive')) go('inventory'); } }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  dlg.showModal();
}
function suppliesCard(list) {
  const man = isManager();
  return card('Supplies',
    list.length ? list.map(s => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('b', {}, s.name), h('div', { class: 'note' }, s.kind === 'sharps' ? `${+s.qty}${s.capacity ? ' of ' + s.capacity : ''} used` + (s.capacity ? ` (${Math.round(100 * s.qty / s.capacity)}% full)` : '') : `${+s.qty} ${s.unit || ''} left` + (s.per_shot ? ` · ${s.per_shot} used per shot` : '') + (s.reorder_at != null ? ` · reorder at ${s.reorder_at}` : ''))),
      man && s.kind === 'sharps' && h('button', { class: 'sm', onclick: async () => { if (confirm('Mark the sharps container as emptied/replaced?')) { await api('POST', `/supplies/${s.id}/empty`); render(); } } }, 'Replaced'),
      man && s.kind !== 'sharps' && h('button', { class: 'sm', onclick: async () => { const n = prompt(`Add how many ${s.unit || ''} of ${s.name}?`, '100'); if (n && !isNaN(+n)) { await api('PUT', '/supplies/' + s.id, { qty: +s.qty + +n }); render(); } } }, '+ Add'),
      man && h('button', { class: 'sm', onclick: () => supplyDialog(s) }, 'Edit')))
      : h('div', { class: 'empty' }, 'No supplies tracked. Add needles, alcohol swabs or a sharps container if you want reminders to reorder.'),
    man && h('button', { class: 'sm', style: 'margin-top:6px', onclick: () => supplyDialog() }, '+ Add supply'));
}
function supplyDialog(s = {}) {
  const isNew = !s.id, err = errBox(), name = txt(s.name), kind = sel([['item', 'Item (needles, swabs…)'], ['sharps', 'Sharps container']], s.kind || 'item');
  const qty = num(s.qty ?? 0), unit = txt(s.unit ?? 'pcs'), reorder = num(s.reorder_at), per = num(s.per_shot ?? 0), cap = num(s.capacity);
  const box = h('div'); const draw = () => fill(box, kind.value === 'sharps'
    ? h('div', { class: 'two' }, field('Shots it holds (about)', cap), field('Used so far', qty))
    : h('div', {}, h('div', { class: 'three' }, field('On hand', qty), field('Unit', unit), field('Reorder at', reorder)), field('Used per shot', per, 'Counts down automatically each time a shot is logged. 0 = don\'t count.')));
  kind.onchange = draw;
  const save = async ev => { ev.preventDefault(); try { await api(isNew ? 'POST' : 'PUT', '/supplies' + (isNew ? '' : '/' + s.id), { name: name.value, kind: kind.value, qty: qty.value, unit: unit.value, reorder_at: reorder.value, per_shot: kind.value === 'sharps' ? 0 : per.value, capacity: cap.value }); dlg.close(); render(); } catch (x) { showErr(err, x); } };
  const del = !isNew && (async () => { await api('DELETE', '/supplies/' + s.id); dlg.close(); render(); });
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, isNew ? 'Add supply' : 'Edit supply'), err, h('div', { class: 'two' }, field('Name', name), field('Kind', kind)), box,
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  draw(); dlg.showModal();
}

// ---------- NFC tags ----------
const TAG_ACTIONS = [['log_schedule', 'Log a shot (pick the schedule)'], ['log_med', 'Log a shot (pick the medication)'], ['today', 'Open Today'], ['patient', 'Open a patient'], ['receive', 'Receive a shipment']];
const canWriteNfc = () => 'NDEFReader' in window;
async function writeNfc(url, msg) {
  if (!canWriteNfc()) { msg.textContent = 'This browser can\'t write tags. Use an app like NFC Tools: write a URL record with the link above.'; return; }
  try {
    const ndef = new NDEFReader(), ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    msg.textContent = 'Hold the tag to the back of your phone…';
    await ndef.write({ records: [{ recordType: 'url', data: url }] }, { signal: ctl.signal, overwrite: true }); clearTimeout(t);
    msg.textContent = 'Tag written. Tap it to try it.';
  } catch (e) { msg.textContent = e.name === 'AbortError' ? 'No tag found. Try again.' : e.name === 'NotAllowedError' ? 'NFC permission was refused.' : 'Couldn\'t write the tag: ' + e.message; }
}
async function tagsCard() {
  const r = await api('GET', '/tags');
  return card('NFC tags',
    h('p', { class: 'note' }, 'Stick a tag on the fridge door or the sharps box. Tapping it with your phone opens ShotTracker right where you need it. You can change what a tag opens here at any time without rewriting it.'),
    r.tags.length ? r.tags.map(t => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('b', {}, t.name), ' ', t.broken && pill('bad', 'Target removed'),
        h('div', { class: 'note' }, t.label), h('div', { class: 'note faint' }, t.taps ? `Tapped ${t.taps}× · last ${fmtWhen(t.last_tap)}${t.last_user ? ' by ' + t.last_user : ''}` : 'Not tapped yet')),
      h('button', { class: 'sm', onclick: () => tagDialog(r.choices, t) }, 'Edit')))
      : h('div', { class: 'empty' }, 'No tags yet.'),
    h('button', { class: 'sm', style: 'margin-top:6px', onclick: () => tagDialog(r.choices) }, '+ Add tag'));
}
function tagDialog(choices, t) {
  const isNew = !t, err = errBox(), msg = h('div', { class: 'note' });
  const name = txt(t?.name, { placeholder: 'Fridge door, Son\'s shot, Sharps box…' }), action = sel(TAG_ACTIONS, t?.action || 'log_schedule');
  let target = null; const targetBox = h('div');
  const opts = { log_schedule: choices.schedules, log_med: choices.meds, patient: choices.patients, receive: choices.meds };
  const drawTarget = () => {
    const list = opts[action.value];
    if (!list) { target = null; return fill(targetBox); }
    target = sel(list.length ? list.map(x => [x.id, x.label]) : [['', 'Nothing to pick yet']], t && t.action === action.value ? t.target_id : list[0]?.id);
    fill(targetBox, field({ log_schedule: 'Schedule', log_med: 'Medication', patient: 'Patient', receive: 'Medication' }[action.value], target));
  };
  action.onchange = drawTarget;
  const linkBox = t && h('div', { class: 'field' }, h('span', {}, 'Tag link'), h('div', { class: 'secret small' }, t.url),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('button', { type: 'button', class: canWriteNfc() ? 'primary' : '', onclick: () => writeNfc(t.url, msg) }, 'Write to tag'),
      h('button', { type: 'button', onclick: () => navigator.clipboard?.writeText(t.url).then(() => { msg.textContent = 'Link copied'; }) }, 'Copy link')), msg,
    !canWriteNfc() && h('p', { class: 'note' }, 'iPhone: install NFC Tools, choose Write → Add a record → URL, paste the link, then Write and hold the tag to the top of the phone. Android Chrome can write it straight from here.'));
  const save = async ev => {
    ev.preventDefault();
    try {
      const out = await api(isNew ? 'POST' : 'PUT', '/tags' + (isNew ? '' : '/' + t.id), { name: name.value, action: action.value, target_id: target && target.value ? +target.value : null });
      if (isNew) { const fresh = await api('GET', '/tags'); return tagDialog(fresh.choices, out); }
      dlg.close(); render();
    } catch (x) { showErr(err, x); }
  };
  const del = t && (async () => { if (!confirm(`Delete the "${t.name}" tag? Tapping it will do nothing until you set up a new one.`)) return; try { await api('DELETE', '/tags/' + t.id); dlg.close(); render(); } catch (x) { showErr(err, x); } });
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, isNew ? 'Add NFC tag' : 'NFC tag'), err,
    field('Name', name), field('When tapped', action), targetBox, linkBox,
    btns(del && h('button', { type: 'button', class: 'danger', onclick: del }, 'Delete'), h('button', { type: 'button', onclick: () => { dlg.close(); render(); } }, 'Close'), h('button', { class: 'primary', type: 'submit' }, isNew ? 'Next' : 'Save'))));
  drawTarget(); if (!dlg.open) dlg.showModal();
}
async function openTag(code) {
  try { const r = await api('GET', '/tags/open/' + encodeURIComponent(code)); location.replace('#' + r.hash); }
  catch (e) { location.replace('#today'); setTimeout(() => alert(e.message), 300); }
}

// ---------- Reports ----------
async function reportsPage() {
  const pats = await api('GET', '/patients');
  const pSel = sel([['', 'All patients'], ...pats.map(p => [p.id, p.name])], pats.length === 1 ? pats[0].id : '');
  const from = h('input', { type: 'date', value: ymd(new Date(Date.now() - 180 * 864e5)) }), to = h('input', { type: 'date', value: ymd(new Date()) });
  const out = h('div', { class: 'col' });
  const qs = () => new URLSearchParams({ ...(pSel.value ? { patient_id: pSel.value } : {}), from: from.value, to: to.value });
  const run = async () => {
    const r = await api('GET', '/report?' + qs());
    const a = r.adherence, who = pSel.value ? pats.find(p => String(p.id) === pSel.value).name : 'All patients';
    fill(out, 
      h('div', { class: 'print-only' }, h('h1', { class: 'title' }, `ShotTracker report: ${who}`), h('div', { class: 'note' }, `${fmtDateY(from.value)} to ${fmtDateY(to.value)} · printed ${fmtDateY(ymd(new Date()))}`)),
      card('Adherence', h('div', { class: 'stats' },
        h('div', {}, h('small', {}, 'Scheduled'), h('b', {}, a.scheduled)), h('div', {}, h('small', {}, 'On time'), h('b', { class: 'ok' }, a.on_time)),
        h('div', {}, h('small', {}, 'Late'), h('b', { class: 'warn' }, a.late)), h('div', {}, h('small', {}, 'Skipped'), h('b', {}, a.skipped)),
        h('div', {}, h('small', {}, 'Missed'), h('b', { class: 'bad' }, a.missed)), h('div', {}, h('small', {}, 'Taken'), h('b', {}, a.rate != null ? a.rate + '%' : '—'))),
        r.by_med.length > 1 && h('table', { class: 'tbl', style: 'margin-top:8px' }, h('tr', {}, ['Medication', 'On time', 'Late', 'Skipped', 'Missed', 'Taken'].map(t => h('th', {}, t))),
          r.by_med.map(x => h('tr', {}, h('td', {}, `${x.patient_name}: ${x.med_name}`), h('td', {}, x.adherence.on_time), h('td', {}, x.adherence.late), h('td', {}, x.adherence.skipped), h('td', {}, x.adherence.missed), h('td', {}, x.adherence.rate != null ? x.adherence.rate + '%' : '—'))))),
      card(`Shots (${r.rows.length})`, r.rows.length ? h('table', { class: 'tbl' }, h('tr', {}, ['Date', 'Patient', 'Medication', 'Status', 'Dose', 'Site', 'Lot', 'Notes'].map(t => h('th', {}, t))),
        r.rows.map(d => h('tr', {}, h('td', {}, fmtDateY(d.given_at || d.due_at || d.created_at), d.given_at && h('div', { class: 'note' }, fmtTime(new Date(d.given_at)))), h('td', {}, d.patient_name), h('td', {}, d.med_name),
          h('td', {}, d.status === 'given' ? (d.timing === 'late' ? 'Late' : 'Given') : d.status[0].toUpperCase() + d.status.slice(1)), h('td', {}, doseText(d.amount, d.unit)), h('td', {}, d.site_name), h('td', {}, d.lot_number),
          h('td', {}, [d.reason, d.reaction && 'Reaction: ' + d.reaction, d.notes].filter(Boolean).join(' · ')))))
        : h('div', { class: 'empty' }, 'Nothing in this range.')));
  };
  [pSel, from, to].forEach(el => el.onchange = run);
  fill(main, h('div', { class: 'page' },
    h('div', { class: 'card no-print' }, h('h2', {}, 'Report'), h('div', { class: 'three' }, field('Patient', pSel), field('From', from), field('To', to)),
      h('div', { class: 'row' }, h('button', { onclick: () => window.print() }, 'Print / Save as PDF'), h('button', { onclick: () => { location.href = '/api/export/doses.csv?' + qs(); } }, 'Download CSV'))),
    out));
  run();
}

// ---------- Users ----------
async function usersPage(host = main) {
  const [list, pats] = await Promise.all([api('GET', '/users'), api('GET', '/patients')]);
  const pname = id => pats.find(p => p.id === id)?.name || '?';
  fill(host, h('div', { class: 'page' }, card(null,
    h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Users'), h('button', { class: 'primary sm', onclick: () => userDialog(null, pats) }, '+ Add user')),
    list.map(u => h('div', { class: 'li' },
      h('div', { class: 'grow' }, h('b', {}, u.name), ' ', h('span', { class: 'note' }, '@' + u.username),
        h('div', { class: 'note' }, u.role === 'admin' ? 'All patients' : u.patients.length ? u.patients.map(pname).join(', ') : 'No patients yet')),
      pill('acc', u.role), !u.totp && pill('warn', '2FA not set up'), u.disabled && pill('bad', 'Disabled'),
      h('button', { class: 'sm', onclick: () => userDialog(u, pats) }, 'Edit'))),
    h('p', { class: 'note', style: 'margin:10px 0 0' }, 'Caregivers manage and log for the patients you tick. A patient login sees and logs only their own shots. Viewers can only look. New users set up two-factor sign-in the first time they sign in.'))));
}
function userDialog(u, pats) {
  const err = errBox(), name = txt(u?.name), uname = txt(u?.username, { disabled: !!u, autocapitalize: 'off' }), email = txt(u?.email, { type: 'email' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep' : '' });
  const role = sel([['admin', 'Admin'], ['caregiver', 'Caregiver'], ['patient', 'Patient'], ['viewer', 'Viewer']], u?.role || 'caregiver');
  const boxes = pats.map(p => ({ p, c: chk(u ? u.patients.includes(p.id) : true) })), one = sel(pats.map(p => [p.id, p.name]), u?.patient_id);
  const dis = chk(u?.disabled), reset = chk(false), access = h('div');
  const drawAccess = () => fill(access, role.value === 'admin' ? h('p', { class: 'note' }, 'Admins see every patient.')
    : role.value === 'patient' ? field('This login is for', one)
      : h('div', { class: 'field' }, h('span', {}, 'Patients'), h('div', { class: 'row' }, boxes.map(({ p, c }) => h('label', { class: 'row note' }, c, p.name)))));
  role.onchange = drawAccess;
  const save = async ev => {
    ev.preventDefault();
    const acc = role.value === 'patient' ? { patient_id: +one.value } : { patients: boxes.filter(b => b.c.checked).map(b => b.p.id) };
    try {
      if (u) await api('PUT', '/users/' + u.id, { name: name.value, email: email.value, role: role.value, disabled: dis.checked, resetTotp: reset.checked, password: pw.value || undefined, ...acc });
      else await api('POST', '/users', { name: name.value, username: uname.value, email: email.value, role: role.value, password: pw.value, ...acc });
      dlg.close(); render();
    } catch (x) { showErr(err, x); }
  };
  fill(dlg, h('form', { onsubmit: save }, h('h2', {}, u ? 'Edit user' : 'Add user'), err,
    h('div', { class: 'two' }, field('Name', name), field('User name', uname)), h('div', { class: 'two' }, field('Email (optional)', email), field('Role', role)),
    access, field(u ? 'New password (12+ characters)' : 'Password (12+ characters)', pw),
    u && h('label', { class: 'row note' }, reset, 'Make them set up two-factor again (lost phone)'),
    u && h('label', { class: 'row note', style: 'margin:6px 0 10px' }, dis, 'Disabled (can\'t sign in)'),
    btns(h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save'))));
  drawAccess(); dlg.showModal();
}

// ---------- Settings ----------
async function settingsPage(host = main) {
  const s = await api('GET', '/settings'), err = errBox(), msg = h('span', { class: 'note' });
  const inputs = {};
  const text = (k, label, type = 'text', hint) => { inputs[k] = txt(s[k], { type, autocapitalize: 'off' }); return field(label, inputs[k], hint); };
  const time = (k, label, hint) => { inputs[k] = h('input', { type: 'time', value: s[k] }); return field(label, inputs[k], hint); };
  const secret = (k, label, hint) => { inputs[k] = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s[k].set ? 'Saved (leave blank to keep)' : '' }); return field(label, inputs[k], hint); };
  const toggle = (k, label) => { inputs[k] = chk(s[k] === '1'); return h('label', { class: 'row note' }, inputs[k], label); };
  const link = s.ha_link || {};
  const test = (url, label) => h('button', { type: 'button', onclick: async ev => { const b = ev.currentTarget; b.disabled = true; try { const r = await api('POST', url); b.textContent = r.services != null ? `Connected (${r.services} notify targets)` : 'Sent'; } catch (x) { showErr(err, x); b.textContent = label; } b.disabled = false; } }, label);
  const save = async ev => {
    ev.preventDefault();
    const body = {}; for (const [k, el] of Object.entries(inputs)) body[k] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    try { await api('PUT', '/settings', body); msg.textContent = 'Saved'; setTimeout(() => render(), 700); } catch (x) { showErr(err, x); }
  };
  const backups = await api('GET', '/backups').catch(() => []);
  const restoreFile = h('input', { type: 'file', accept: '.stbk' }), restorePass = h('input', { type: 'password', placeholder: 'Passphrase it was made with (blank = current)' });
  const restore = async () => {
    const f = restoreFile.files[0]; if (!f) return showErr(err, new Error('Pick a backup file'));
    if (!confirm('Replace ALL current data with this backup? A copy of the current data is saved first. ShotTracker restarts.')) return;
    try { await api('POST', '/backups/restore', await f.arrayBuffer(), { 'Content-Type': 'application/octet-stream', ...(restorePass.value ? { 'x-backup-pass': restorePass.value } : {}) }); alert('Restored. ShotTracker is restarting; sign in again in a few seconds.'); setTimeout(() => location.reload(), 4000); } catch (x) { showErr(err, x); }
  };
  fill(host, h('form', { class: 'page', onsubmit: save }, err,
    card('This app', text('app_url', 'Address people use to open ShotTracker', 'url', 'For example https://shots.yourdomain.lan. Used for links in notifications, email and the calendar feed.')),
    card('Home Assistant',
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Notification buttons link: '), pill(link.status === 'connected' ? 'ok' : link.status === 'error' ? 'bad' : '', link.status || 'off'), link.error && h('span', { class: 'note' }, link.error)),
      text('ha_url', 'Home Assistant URL', 'url', 'For example http://192.168.1.20:8123'), secret('ha_token', 'Long-lived access token', 'Home Assistant → your profile → Security → Long-lived access tokens.'),
      toggle('ha_insecure', 'Home Assistant uses a self-signed certificate'), toggle('ha_sensors', 'Publish "next shot" sensors to Home Assistant'), toggle('alerts_push', 'Push stock, expiry and refill alerts'),
      h('div', { class: 'row' }, test('/settings/test-ha', 'Test connection'))),
    card('Reminders', h('p', { class: 'note' }, 'Every shot gets a heads-up the day before and the morning of, a reminder when it\'s due, then repeats until it\'s logged. Each person picks their phone and quiet hours under their account.'),
      h('div', { class: 'two' }, time('remind_day_before', 'Day-before reminder at'), time('remind_morning', 'Morning-of reminder at')),
      h('div', { class: 'two' }, text('repeat_min', 'Repeat every (minutes) until logged', 'number'), time('digest_time', 'Daily email digest at'))),
    card('Email', h('div', { class: 'two' }, text('smtp_host', 'SMTP server'), text('smtp_port', 'Port', 'number', '587 (STARTTLS) or 465 (TLS)')),
      h('div', { class: 'two' }, text('smtp_user', 'User name'), secret('smtp_pass', 'Password')), text('smtp_from', 'From address', 'email'),
      h('div', { class: 'row' }, test('/settings/test-email', 'Send me a test email'))),
    card('Backups', h('p', { class: 'note' }, 'A nightly encrypted copy of everything, kept in the app\'s volume. You need the passphrase to restore, including on a new install. Keep it in your password manager.'),
      secret('backup_pass', 'Backup passphrase (12+ characters)'), h('div', { class: 'two' }, time('backup_time', 'Nightly at'), text('backup_keep', 'Keep this many', 'number')),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => { try { await api('POST', '/backups'); render(); } catch (x) { showErr(err, x); } } }, 'Back up now')),
      backups.length ? h('table', { class: 'tbl', style: 'margin-top:8px' }, backups.slice(0, 10).map(b => h('tr', {}, h('td', {}, fmtWhen(b.at)), h('td', { class: 'note' }, Math.ceil(b.size / 1024) + ' KB'), h('td', {}, h('a', { href: '/api/backups/' + encodeURIComponent(b.name) }, 'Download')))))
        : h('div', { class: 'note' }, 'No backups yet.'),
      h('div', { class: 'sub-h' }, 'Restore'), h('div', { class: 'two' }, restoreFile, restorePass), h('button', { type: 'button', class: 'danger', onclick: restore }, 'Restore from file')),
    h('div', { class: 'row savebar' }, h('button', { class: 'primary', type: 'submit' }, 'Save settings'), msg)));
}

// ---------- Settings hub: General, Users, NFC tags, Activity ----------
const SETTINGS_TABS = [
  { id: 'general', label: 'General', show: u => u.role === 'admin', view: host => settingsPage(host) },
  { id: 'users', label: 'Users', show: u => u.role === 'admin', view: host => usersPage(host) },
  { id: 'nfc', label: 'NFC tags', show: u => ['admin', 'caregiver'].includes(u.role), view: async host => fill(host, h('div', { class: 'page' }, await tagsCard())) },
  { id: 'activity', label: 'Activity', show: u => u.role === 'admin', view: host => activityPage(host) },
];
async function settingsHub(tab) {
  const tabs = SETTINGS_TABS.filter(t => t.show(state.user));
  const cur = tabs.find(t => t.id === tab) || tabs[0];
  const body = h('div');
  fill(main, h('div', { class: 'page' },
    h('div', { class: 'seg settings-tabs' }, tabs.map(t => h('button', { class: t.id === cur.id ? 'on' : '', onclick: () => go('settings/' + t.id) }, t.label))), body));
  await cur.view(body);
}

// ---------- My account ----------
async function accountPage() {
  const me = await api('GET', '/me'), p = me.prefs, err = errBox(), msg = h('span', { class: 'note' });
  let services = []; let haMsg = '';
  try { services = await api('GET', '/ha/services'); } catch (x) { haMsg = x.message; }
  const notify = sel([['', '— no phone —'], ...services.map(s => [s, s.replace(/^mobile_app_/, '').replace(/_/g, ' ')]), ...(p.notify_ha && !services.includes(p.notify_ha) ? [[p.notify_ha, p.notify_ha]] : [])], p.notify_ha);
  const email = txt(p.email, { type: 'email' }), er = chk(p.email_reminders), ed = chk(p.email_digest), on = chk(p.reminders_on);
  const qs = h('input', { type: 'time', value: p.quiet_start }), qe = h('input', { type: 'time', value: p.quiet_end });
  const savePrefs = async () => { try { await api('PUT', '/me/prefs', { notify_ha: notify.value, email: email.value, email_reminders: er.checked, email_digest: ed.checked, reminders_on: on.checked, quiet_start: qs.value, quiet_end: qe.value }); msg.textContent = 'Saved'; } catch (x) { showErr(err, x); } };
  const testNow = async () => { await savePrefs(); try { const r = await api('POST', '/me/test'); msg.textContent = r.results.length ? r.results.map(x => `${x[0] === 'ha' ? 'Phone' : 'Email'}: ${x[1]}`).join(' · ') : 'No channel is set up (pick a phone or add an email address).'; } catch (x) { showErr(err, x); } };
  const icsBox = h('div');
  const drawIcs = url => {
    if (!url) return fill(icsBox, h('button', { onclick: newIcs }, 'Make a calendar link'));
    const full = url.startsWith('/') ? location.origin + url : url;
    fill(icsBox, 
      h('div', { class: 'secret small' }, full),
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { onclick: () => navigator.clipboard?.writeText(full).then(() => { msg.textContent = 'Link copied'; }) }, 'Copy link'),
        h('a', { class: 'btnlink sm', href: full.replace(/^https?:/, 'webcal:') }, 'Subscribe'),
        h('button', { class: 'danger sm', onclick: newIcs }, 'Make a new link')),
      h('p', { class: 'note' }, 'Anyone with this link can see shot dates, so keep it private. Making a new link turns the old one off.'));
  };
  const newIcs = async () => { const r = await api('POST', '/me/ics'); drawIcs(r.ics_url); };
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' });
  const code = h('input', { class: 'code-in', inputmode: 'numeric', maxlength: 6, placeholder: '000000' });
  const out = async all => { await api('POST', all ? '/logout-all' : '/logout').catch(() => {}); state.user = null; go('today'); };
  fill(main, h('div', { class: 'page' }, err,
    card('Notifications',
      field('Phone (Home Assistant app)', notify, haMsg ? 'Couldn\'t list phones: ' + haMsg : services.length ? 'Pick the device that should get shot reminders.' : 'No phones listed yet. An admin connects Home Assistant under Settings.'),
      field('Email', email), h('label', { class: 'row note' }, er, 'Also send reminders by email'), h('label', { class: 'row note' }, ed, 'Daily email digest (today, tomorrow, stock and refills)'),
      h('label', { class: 'row note' }, on, 'Send me reminders'),
      h('div', { class: 'two' }, field('Quiet hours from', qs), field('to', qe)), h('p', { class: 'note' }, 'During quiet hours only the "due now" reminder comes through; the rest wait until morning.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: savePrefs }, 'Save'), h('button', { onclick: testNow }, 'Send a test'), msg)),
    card('Calendar', h('p', { class: 'note' }, 'Upcoming shots for the next 6 months in your phone\'s calendar (iPhone: Settings → Calendar → Accounts → Add Subscribed Calendar).'), icsBox),
    card('Password', h('div', { class: 'two' }, field('Current password', cur), field('New password', next)),
      h('button', { onclick: async () => { try { await api('POST', '/me/password', { current: cur.value, next: next.value }); msg.textContent = 'Password changed. Other devices were signed out.'; cur.value = next.value = ''; } catch (x) { showErr(err, x); } } }, 'Change password')),
    card('Recovery codes', h('p', { class: 'note' }, `${me.recovery_left} unused. Enter a current 6-digit code to make a new set (the old ones stop working).`), h('div', { class: 'row' }, code,
      h('button', { onclick: async () => { try { const r = await api('POST', '/me/recovery', { code: code.value }); recoveryPage(r.recovery, () => render()); } catch (x) { showErr(err, x); } } }, 'Make new codes'))),
    card('Sign out', h('div', { class: 'row' }, h('button', { onclick: () => out(false) }, 'Sign out'), h('button', { class: 'danger', onclick: () => out(true) }, 'Sign out everywhere')))));
  drawIcs(p.ics_url);
}

// ---------- Activity ----------
async function activityPage(host = main) {
  const rows = await api('GET', '/audit');
  const summary = r => { try { const n = r.new ? JSON.parse(r.new) : null; return n ? Object.entries(n).filter(([k, v]) => v != null && v !== '' && !['id', 'created_at', 'updated_at', 'deleted'].includes(k)).slice(0, 6).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : ''; } catch { return ''; } };
  fill(host, h('div', { class: 'page' }, card('Activity (latest 300)',
    h('table', { class: 'tbl' }, rows.map(r => h('tr', {}, h('td', { class: 'note' }, new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('td', {}, r.user || 'system'),
      h('td', {}, r.action + (r.tbl ? ' · ' + r.tbl : '') + (r.record ? ' #' + r.record : ''), h('div', { class: 'note faint' }, summary(r)))))))));
}

// ---------- start ----------
async function render() {
  try {
    const s = await api('GET', '/state');
    state.version = s.version; state.user = s.user; $('#hVer').textContent = 'v' + s.version;
    if (!s.user) { $('#nav').classList.add('hide'); $('#meBtn').classList.add('hide'); if (dlg.open) dlg.close(); return s.setup ? setupPage() : loginPage(); }
    let { page, args } = route();
    if (page === 'users' || page === 'activity') return location.replace('#settings/' + page); // old links
    if (page === 'tag') return openTag(args[0] || '');
    if (page === 'log') { shell('today'); await todayPage(); return logDialog({ schedule_id: +args[0] }); }
    if (page === 'logmed') { shell('today'); await todayPage(); return logDialog({ medication_id: +args[0] }); }
    if (page === 'receive' && isManager()) { shell('inventory'); return inventoryPage(+args[0]); }
    const def = PAGES.find(p => p.id === page);
    if (page !== 'patient' && page !== 'account' && (!def || !def.show(s.user))) page = 'today';
    shell(page);
    await ({ today: todayPage, patients: patientsPage, patient: () => patientPage(+args[0]), inventory: inventoryPage, reports: reportsPage, settings: () => settingsHub(args[0]), account: accountPage })[page]();
  } catch (e) {
    fill(main, h('div', { class: 'card login' }, h('div', { class: 'errbox' }, e.message), h('button', { onclick: () => render() }, 'Try again')));
  }
}
render();
