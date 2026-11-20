// Drug lookup by NDC in the FDA's NDC Directory (openFDA, free, updated daily).
// Only the NDC number is sent. Results are reference information, not medical advice.
'use strict';

const digits = s => String(s || '').replace(/\D/g, '');

// A 10-digit NDC can be split 4-4-2, 5-3-2 or 5-4-1; the barcode doesn't say which.
// An 11-digit NDC (5-4-2, padded with a zero) maps back to one of those.
function candidates(input) {
  const raw = String(input || '').trim();
  if (/^\d{4,5}-\d{3,4}(-\d{1,2})?$/.test(raw)) return [raw];
  const d = digits(raw), out = [];
  if (d.length === 10) out.push(`${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`, `${d.slice(0, 5)}-${d.slice(5, 8)}-${d.slice(8)}`, `${d.slice(0, 5)}-${d.slice(5, 9)}-${d.slice(9)}`);
  else if (d.length === 11) {
    if (d[0] === '0') out.push(`${d.slice(1, 5)}-${d.slice(5, 9)}-${d.slice(9)}`);
    if (d[5] === '0') out.push(`${d.slice(0, 5)}-${d.slice(6, 9)}-${d.slice(9)}`);
    if (d[9] === '0') out.push(`${d.slice(0, 5)}-${d.slice(5, 9)}-${d.slice(10)}`);
  } else if (d.length === 8 || d.length === 9) {
    // a product NDC without the package part
    if (d.length === 8) out.push(`${d.slice(0, 4)}-${d.slice(4)}`);
    else out.push(`${d.slice(0, 5)}-${d.slice(5)}`, `${d.slice(0, 4)}-${d.slice(4)}`);
  }
  return out;
}

const UNIT = u => { u = String(u || '').toLowerCase().replace(/[\[\]]/g, ''); return u === 'mg' ? 'mg' : ['ug', 'mcg', 'µg'].includes(u) ? 'mcg' : ['iu', 'u', 'units', 'unit'].includes(u) ? 'units' : null; };

// "150 mg/mL", "300 mg/2mL", "100 [iU]/mL" -> amount per mL
function parseStrength(s) {
  const m = /([\d.]+)\s*([a-zA-Z\[\]µ]+)\s*\/\s*([\d.]*)\s*mL/i.exec(String(s || ''));
  if (!m) return null;
  const unit = UNIT(m[2]); if (!unit) return null;
  const per = m[3] ? +m[3] : 1;
  return { conc: Math.round(+m[1] / per * 1e6) / 1e6, conc_unit: unit };
}

// "1 SYRINGE in 1 CARTON (0024-5918-01) > 2 mL in 1 SYRINGE" -> syringe, 2 mL
function parsePackage(desc, dosageForm) {
  const t = String(desc || '').toUpperCase(), f = String(dosageForm || '').toUpperCase();
  let form = null;
  if (/MULTI-DOSE|MULTIPLE-DOSE|MULTI DOSE/.test(t)) form = 'multi_vial';
  else if (/PEN|AUTO-?INJECTOR|INJECTOR|CARTRIDGE/.test(t) || /PEN|AUTO-?INJECTOR/.test(f)) form = 'pen';
  else if (/SYRINGE/.test(t) || /SYRINGE/.test(f)) form = 'syringe';
  else if (/VIAL/.test(t)) form = /SINGLE-DOSE|SINGLE DOSE/.test(t) || !/MULTI/.test(t) ? 'single_vial' : 'multi_vial';
  const ml = /([\d.]+)\s*mL\s+in\s+1\s+(SYRINGE|PEN|VIAL|INJECTOR|AUTO-INJECTOR|CARTRIDGE|AMPULE|KIT)/i.exec(String(desc || ''));
  const count = /^(\d+)\s+(SYRINGE|PEN|VIAL|INJECTOR|AUTO-INJECTOR|CARTRIDGE)S?\s+in\s+1\s+(CARTON|BOX|PACKAGE|KIT)/i.exec(String(desc || '').trim());
  return { form, unit_ml: ml ? +ml[1] : null, per_carton: count ? +count[1] : null };
}

const ROUTE = r => { r = String(r || '').toUpperCase(); return r.includes('SUBCUTANEOUS') ? 'SubQ' : r.includes('INTRAMUSCULAR') ? 'IM' : r.includes('INTRAVENOUS') ? 'IV' : r.includes('INTRADERMAL') ? 'ID' : r ? 'other' : null; };
const title = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

function shape(rec, wanted) {
  const pkg = (rec.packaging || []).find(p => wanted.includes(p.package_ndc)) || (rec.packaging || [])[0] || {};
  const ings = (rec.active_ingredients || []).map(a => ({ name: title(a.name), strength: a.strength }));
  const str = ings.length === 1 ? parseStrength(ings[0].strength) : null;
  const pk = parsePackage(pkg.description, rec.dosage_form);
  return {
    found: true, package_ndc: pkg.package_ndc || null, product_ndc: rec.product_ndc, brand_name: title(rec.brand_name), generic_name: title(rec.generic_name),
    labeler: rec.labeler_name, dosage_form: title(rec.dosage_form), route: (rec.route || []).map(title).join(', '), ingredients: ings,
    package_description: pkg.description || '', marketing_end_date: rec.marketing_end_date || null,
    // suggestions for the medication form
    suggest: { name: title(rec.brand_name) || title(rec.generic_name), generic: title(rec.generic_name), form: pk.form, unit_ml: pk.unit_ml, per_carton: pk.per_carton,
      conc: str ? str.conc : null, conc_unit: str ? str.conc_unit : null, route: ROUTE((rec.route || [])[0]), ndc: pkg.package_ndc || rec.product_ndc },
  };
}

async function lookup(input, { base = 'https://api.fda.gov', apiKey = '', timeoutMs = 10000 } = {}) {
  const c = candidates(input);
  if (!c.length) { const e = new Error('That doesn\'t look like an NDC (10 or 11 digits)'); e.code = 400; throw e; }
  const get = async search => {
    const url = `${base.replace(/\/+$/, '')}/drug/ndc.json?search=${search}&limit=5` + (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '');
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (r.status === 404) return [];
    if (!r.ok) { const e = new Error(`FDA lookup failed (${r.status}${r.status === 429 ? ': too many lookups today' : ''})`); e.code = 502; throw e; }
    return (await r.json()).results || [];
  };
  const q = (field, vals) => vals.map(v => `${field}:%22${encodeURIComponent(v)}%22`).join('+');
  const pkgs = c.filter(x => x.split('-').length === 3);
  let res = pkgs.length ? await get(q('packaging.package_ndc', pkgs)) : [];
  if (!res.length) { const prods = [...new Set(c.map(x => x.split('-').slice(0, 2).join('-')))]; res = await get(q('product_ndc', prods)); }
  if (!res.length) return { found: false, tried: c };
  return shape(res[0], pkgs);
}

module.exports = { lookup, candidates, parseStrength, parsePackage, digits };
