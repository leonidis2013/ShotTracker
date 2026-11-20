// Due-date math for schedules. Times are local to the container (TZ); the database stores ISO (UTC) strings.
'use strict';
const DAY = 86400e3;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const at = (date, hhmm) => { const [h, m] = String(hhmm || '20:00').split(':').map(Number); const d = new Date(date); d.setHours(h || 0, m || 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function addMonths(d, n) {
  const x = new Date(d), day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  return x;
}
const weekdaysOf = s => String(s.weekdays || '').split(',').filter(x => x !== '').map(Number).filter(n => n >= 0 && n <= 6);

// one interval later (or n intervals)
function stepFrom(s, d, n = 1) {
  if (s.kind === 'days') return addDays(d, s.every * n);
  if (s.kind === 'weeks') return addDays(d, 7 * s.every * n);
  if (s.kind === 'months') return addMonths(d, s.every * n);
  return addDays(d, n);
}

// approximate days between doses (for supply math)
function intervalDays(s) {
  if (s.kind === 'days') return s.every;
  if (s.kind === 'weeks') return 7 * s.every;
  if (s.kind === 'months') return 30.44 * s.every;
  if (s.kind === 'weekdays') return 7 / Math.max(1, weekdaysOf(s).length);
  return 1;
}

// first weekday-schedule date on or after `from`
function nextWeekday(s, from) {
  const days = weekdaysOf(s); if (!days.length) return null;
  for (let i = 0; i < 8; i++) { const c = addDays(startOfDay(from), i); if (days.includes(c.getDay())) return at(c, s.time_of_day); }
  return null;
}

// The next due time after `last` (the newest given/skipped/missed dose of this schedule), or the first one.
function nextDue(s, last) {
  const first = at(parseYmd(s.start_date), s.time_of_day);
  let d;
  if (s.kind === 'weekdays') {
    let from = startOfDay(first);
    if (last) { const ref = new Date(last.due_at || last.given_at); const n = addDays(startOfDay(ref), 1); if (n > from) from = n; }
    d = nextWeekday(s, from);
  } else if (!last) d = first;
  else if (s.anchor === 'last') {
    const base = new Date(last.status === 'given' && last.given_at ? last.given_at : (last.due_at || last.given_at));
    d = at(stepFrom(s, startOfDay(base)), s.time_of_day);
  } else {
    // fixed calendar: first occurrence (counted from the start date) after the last handled one
    const ref = new Date(last.due_at || last.given_at);
    let k = 0; d = first;
    while (d <= ref && k < 20000) { k++; d = at(stepFrom(s, startOfDay(first), k), s.time_of_day); }
  }
  if (!d) return null;
  if (s.end_date && d > at(parseYmd(s.end_date), '23:59')) return null;
  return d;
}

// upcoming occurrences from the next due, for the calendar feed
function upcoming(s, last, untilDate, max = 60) {
  const out = []; let l = last, d = nextDue(s, l);
  while (d && d <= untilDate && out.length < max) {
    out.push(d);
    l = { due_at: d.toISOString(), given_at: d.toISOString(), status: 'given' };
    d = nextDue(s, l);
  }
  return out;
}

// overdue | due | today | upcoming
function status(s, due, now = new Date()) {
  if (!due) return 'none';
  if (now > new Date(due.getTime() + (s.grace_min || 0) * 60e3)) return 'overdue';
  if (now >= due) return 'due';
  if (ymd(now) === ymd(due)) return 'today';
  return 'upcoming';
}

// dose for a given date: the newest step that has started, else the schedule's own dose
function doseFor(s, steps, date) {
  let amount = s.dose_amount, unit = s.dose_unit;
  for (const st of [...steps].sort((a, b) => a.start_date.localeCompare(b.start_date))) if (parseYmd(st.start_date) <= date) { amount = st.dose_amount; unit = st.dose_unit; }
  return { amount, unit };
}

const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
function describe(s) {
  const t = s.time_of_day || '';
  if (s.kind === 'weekdays') return 'Every ' + weekdaysOf(s).map(i => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]).join(', ') + (t ? ' at ' + t : '');
  const u = { days: 'day', weeks: 'week', months: 'month' }[s.kind];
  return (s.every === 1 ? 'Every ' + u : `Every ${s.every} ${u}s`) + (t ? ' at ' + t : '');
}

module.exports = { DAY, ymd, parseYmd, startOfDay, at, addDays, addMonths, stepFrom, intervalDays, nextDue, upcoming, status, doseFor, daysBetween, describe, weekdaysOf };
