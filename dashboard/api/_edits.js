// Edits made inside the CRM to leads that live in the Google Sheet: a corrected
// phone number, a new email, a lead added by hand, a lead removed, a status.
//
// The sheet stays the record, but a sheet is slow to write and slower to read
// back, and the demo must never write to it at all. So every edit is kept here
// first, in lead_edits (lead_edits_demo on the demo), keyed by the sheet row,
// and laid over the leads every time they are served. A real CRM also writes
// the change through to the sheet; if that fails, or the sheet's script is too
// old to understand it, the edit still shows and the response says so.
import { isDemo } from "./_demo.js";
import { fetchRows } from "./_rows.js";

export const EDITABLE = [
  "business", "owner_name", "phone", "email", "website", "facebook", "instagram",
  "category", "address", "city", "region", "postal_code", "country", "notes", "why",
  "rating", "reviews", "website_status", "heat", "status", "contacted_on", "assigned_to", "snooze_until"];
const LONG = new Set(["notes", "why", "address"]);
const TABLE = () => (isDemo() ? "lead_edits_demo" : "lead_edits");

function store() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

export function cleanFields(fields) {
  const out = {};
  for (const k of EDITABLE) {
    if (!fields || fields[k] == null) continue;
    const v = String(fields[k]).trim().slice(0, LONG.has(k) ? 3000 : 300);
    out[k] = k === "email" ? v.toLowerCase() : v;
  }
  return out;
}

export async function readEdits() {
  const db = store();
  if (!db) return [];
  try {
    /* Page by page, so a CRM with more edits than one page still applies all of them. */
    const { rows } = await fetchRows(db, `${TABLE()}?select=key,lead_row,fields,deleted,added&order=key.asc`, { max: 20000 });
    return rows;
  } catch {
    return [];
  }
}

export async function readEdit(row) {
  const db = store();
  if (!db) return null;
  const r = await fetch(`${db.url}/rest/v1/${TABLE()}?key=eq.${encodeURIComponent("row:" + row)}&select=key,lead_row,fields,deleted,added`, {
    headers: db.headers, signal: AbortSignal.timeout(5000),
  });
  return r.ok ? (await r.json())[0] || null : null;
}

// Lay the edits over the leads. Works on raw sheet rows and on shaped leads
// alike, because both carry the same field names. Leads added by hand come in
// through `shape`, so they get the same treatment as a row from the sheet.
export function applyEdits(leads, edits, shape) {
  if (!edits || !edits.length) return leads;
  const byRow = new Map();
  const added = [];
  for (const e of edits) {
    if (e.added) added.push(e);
    else if (e.lead_row) byRow.set(Number(e.lead_row), e);
  }
  const out = [];
  for (const l of leads) {
    const e = byRow.get(Number(l.row));
    if (!e) { out.push(l); continue; }
    if (e.deleted) continue;
    const merged = { ...l, ...cleanFields(e.fields) };
    if ("tel" in l) merged.tel = String(merged.phone || "").replace(/[^\d+]/g, "");
    out.push(merged);
  }
  const present = new Set(out.map((l) => Number(l.row)));
  for (const e of added) {
    if (e.deleted || present.has(Number(e.lead_row))) continue;
    const raw = { row: Number(e.lead_row), status: "New", ...cleanFields(e.fields) };
    const lead = shape ? shape([raw])[0] : raw;
    /* The shaper may decline a row it cannot use, and a stamp on undefined
       took the whole lead read down with it. Stamped after shaping, which
       keeps only the sheet's own columns: the page's "Added by you" view is
       built on this, the leads a person typed in or imported apart from the
       thousands the scraper found. */
    if (!lead) continue;
    lead.added = true;
    out.push(lead);
  }
  return out;
}

// Merge a change into the lead's edit row. Fields given replace the same
// fields kept before; fields not given are left as they were.
export async function upsertEdit(row, patch) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const key = "row:" + row;
  const existing = await readEdit(row);
  const data = {
    key,
    lead_row: row,
    fields: { ...((existing && existing.fields) || {}), ...cleanFields(patch.fields || {}) },
    deleted: patch.deleted != null ? !!patch.deleted : !!(existing && existing.deleted),
    added: patch.added != null ? !!patch.added : !!(existing && existing.added),
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(`${db.url}/rest/v1/${TABLE()}?on_conflict=key`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([data]),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("Could not save that edit (" + r.status + ").");
  return (await r.json())[0] || data;
}

// Once the sheet shows the same value the CRM wrote, the CRM's copy of that
// field has done its job: dropping it lets a later change made by hand in the
// sheet show through. A removed lead whose row is now blank is forgotten the
// same way. Only ever called from a fresh read of a real sheet.
export async function pruneEdits(rawLeads, edits) {
  const db = store();
  if (!db || !edits || !edits.length) return 0;
  const byRow = new Map();
  for (const l of rawLeads || []) byRow.set(Number(l.row), l);
  let changed = 0;
  for (const e of edits) {
    if (e.added) continue;
    const lead = byRow.get(Number(e.lead_row));
    let action = null;
    if (e.deleted) {
      if (!lead) action = { del: true };
    } else {
      const fields = cleanFields(e.fields);
      const keep = {};
      for (const k of Object.keys(fields)) {
        const sheet = lead ? String(lead[k] == null ? "" : lead[k]).trim() : null;
        if (sheet === null || sheet !== fields[k]) keep[k] = fields[k];
      }
      if (Object.keys(keep).length !== Object.keys(fields).length) {
        action = Object.keys(keep).length ? { fields: keep } : { del: true };
      }
    }
    if (!action) continue;
    try {
      const target = `${db.url}/rest/v1/${TABLE()}?key=eq.${encodeURIComponent(e.key)}`;
      const r = await fetch(target, action.del
        ? { method: "DELETE", headers: db.headers, signal: AbortSignal.timeout(5000) }
        : { method: "PATCH", headers: db.headers, body: JSON.stringify({ fields: action.fields, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(5000) });
      if (r.ok) changed++;
    } catch {
      // Left for the next fresh read; nothing is lost by waiting.
    }
  }
  return changed;
}

// A row number for a lead that exists only here: far above any sheet row, and
// different every time.
/* A batch of new leads in one write, deduplicated the way the sheet does it.

   The single-lead path reads the row back and then upserts it, two round
   trips per lead, which is fine for one and hopeless for a CSV: two hundred
   leads was four hundred calls inside a twenty-five second function. This
   reads what is already there once, drops anything with the same name and
   town (the sheet's own rule, and the promise the import dialog makes), and
   inserts the rest in a single request. */
export async function addLeadsBatch(leads) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const keyOf = (f) => (String(f.business || "").trim().toLowerCase() + "|" + String(f.city || "").trim().toLowerCase());
  const seen = new Set();
  let skipped = 0;
  try {
    const { rows } = await fetchRows(db, `${TABLE()}?added=is.true&deleted=is.false&select=fields`, { max: 20000, timeout: 8000 });
    rows.forEach((r) => { const k = keyOf((r && r.fields) || {}); if (k !== "|") seen.add(k); });
  } catch { /* an unreadable store dedupes within the batch only; nothing is lost */ }
  const base = newLeadRow(), now = new Date().toISOString(), out = [];
  (Array.isArray(leads) ? leads : []).forEach((l) => {
    const fields = cleanFields(l);
    if (!fields.business && !fields.phone && !fields.email) return;
    const k = keyOf(fields);
    if (k !== "|" && seen.has(k)) { skipped++; return; }
    if (k !== "|") seen.add(k);
    const row = base + out.length;
    out.push({ key: "row:" + row, lead_row: row, fields, deleted: false, added: true, updated_at: now });
  });
  if (!out.length) return { added: 0, skipped };
  const r = await fetch(`${db.url}/rest/v1/${TABLE()}?on_conflict=key`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(out),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("Could not save those leads (" + r.status + ").");
  return { added: out.length, skipped };
}

export function newLeadRow() {
  return 100000 + (Date.now() % 100000000);
}

// The sheet's own column keys for the fields the CRM names differently.
export function toSheetFields(fields) {
  const map = { business: "business_name", why: "why_reach_out", heat: "lead_heat" };
  const out = {};
  for (const k of Object.keys(fields)) out[map[k] || k] = fields[k];
  return out;
}
