// Front and back body outlines with the patient's injection sites as tappable dots.
// Sites are placed in percent (0-100) of each figure. Front view: the person's left is on your right.
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v); kids.forEach(k => el.append(k)); return el; };

function figure() {
  return s('g', { class: 'fig' },
    s('circle', { cx: 50, cy: 9, r: 6.5 }),
    s('path', { d: 'M46 15h8v4h-8z' }),
    s('path', { d: 'M33 19Q50 16.5 67 19L70 54Q50 59 30 54Z' }),
    s('path', { d: 'M33 19.5L25 21.5L18.5 52L23.5 53L28.5 31Z' }),
    s('path', { d: 'M67 19.5L75 21.5L81.5 52L76.5 53L71.5 31Z' }),
    s('path', { d: 'M31 54.5Q40 57.5 49 57L47 97H39Z' }),
    s('path', { d: 'M69 54.5Q60 57.5 51 57L53 97H61Z' }));
}

export function bodyMap(sites, { selected = null, editable = false, onPick, onPlace } = {}) {
  let list = sites, sel = selected;
  const views = ['front', 'back'].map(view => {
    const svg = s('svg', { viewBox: '0 0 100 100', class: 'bodymap' + (editable ? ' editable' : ''), role: 'img', 'aria-label': view + ' view' }, figure(), s('g', { class: 'dots' }));
    svg.addEventListener('click', ev => {
      const dot = ev.target.closest('[data-id]');
      if (dot) { const id = dot.dataset.id; onPick && onPick(/^\d+$/.test(id) ? +id : id); return; }
      if (!editable || !onPlace) return;
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      onPlace(view, Math.round(Math.max(0, Math.min(100, p.x))), Math.round(Math.max(0, Math.min(100, p.y))));
    });
    return { view, svg };
  });
  const el = document.createElement('div'); el.className = 'bodymaps';
  for (const v of views) { const w = document.createElement('div'); w.className = 'bm'; const cap = document.createElement('small'); cap.textContent = v.view === 'front' ? 'Front' : 'Back'; w.append(v.svg, cap); el.append(w); }
  const draw = () => {
    for (const v of views) {
      const g = v.svg.querySelector('.dots'); g.replaceChildren();
      for (const x of list.filter(x => (x.view || 'front') === v.view)) {
        const cls = ['site'], on = String(x.id) === String(sel);
        if (on) cls.push('on'); if (x.resting) cls.push('resting'); if (x.enabled === false) cls.push('off');
        const c = s('g', { 'data-id': x.id, class: cls.join(' ') }, s('circle', { cx: x.x ?? 50, cy: x.y ?? 50, r: on ? 4.2 : 3.3 }));
        const t = s('title'); t.textContent = x.name; c.append(t);
        g.append(c);
      }
    }
  };
  draw();
  return { el, select(id) { sel = id; draw(); }, update(l) { list = l; draw(); } };
}
