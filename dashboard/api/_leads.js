// Leads in Postgres.
//
// The local book lived in a Google Sheet behind an Apps Script: a twelve
// second read at eight thousand rows, a 404 under write load that was really a
// rate limit, and the fiddliest step in setting a copy up. Coaches already
// lived here. Now local leads can too, in a table whose ids ARE the old sheet
// row numbers, so every activity, task and deal that points at a lead by row
// keeps pointing at the same lead.
//
// Which store a deployment uses is decided by one fact, per request: whether
// this table has any rows for it. None, and a sheet URL set, means the sheet
// still runs the show. A fresh copy with no sheet at all starts here, empty.
// The switch is one INSERT away in either direction, and truncating the table
// is the whole rollback.
import { isDemo } from "./_demo.js";
import { fetchRows } from "./_rows.js";
import { cleanFields } from "./_edits.js";

export const LEADS_TABLE = () => (isDemo() ? "leads_demo" : "leads");

const FIELDS = ["business", "owner_name", "phone", "email", "why", "website", "facebook", "instagram", "heat", "website_status",
  "category", "rating", "reviews", "address", "city", "region", "postal_code", "country", "google_maps_url", "status", "contacted_on", "notes", "assigned_to", "snooze_until"];
/* Date columns take null, never "": Postgres refuses an empty string for a date,
   and one padded row fails the whole batch (22007). */
const DATE_FIELDS = new Set(["snooze_until"]);

export function store() {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}
export const rest = (db, path, init) => fetch(db.url + "/rest/v1/" + path, { ...init, headers: { ...db.headers, ...(init && init.headers) }, signal: AbortSignal.timeout((init && init.ms) || 8000) });

/* Is this deployment on Postgres for leads? One cheap HEAD-style read. A store
   that cannot be reached answers "no", so an outage falls back to the sheet
   path rather than to an empty CRM. */
let onceCache = { at: 0, value: null };
export async function leadsInPostgres() {
  const db = store();
  if (!db) return false;
  /* No sheet at all: the table is the book from day one, empty or not. */
  if (!(process.env.LEADS_SHEET_URL || "").trim()) return true;
  if (Date.now() - onceCache.at < 15000 && onceCache.value !== null) return onceCache.value;
  try {
    const r = await rest(db, `${LEADS_TABLE()}?select=id&limit=1`, { ms: 4000 });
    const v = r.ok && (await r.json()).length > 0;
    onceCache = { at: Date.now(), value: v };
    return v;
  } catch { return false; }
}

/* A row from the table, dressed as the lead the rest of the app expects.
   Same keys the sheet's script returned, plus `added` for the "Added by you"
   view, which used to come from the edits overlay. */
export function toLead(r) {
  const out = { row: Number(r.id), added: r.source !== "scraper", source: r.source || "scraper",
                /* Changed by a person since it was created. The demo derives
                   statuses on every read and must leave these alone. */
                touched: !!(r.updated_at && r.created_at && r.updated_at !== r.created_at) };
  for (const k of FIELDS) out[k] = r[k] == null ? "" : String(r[k]);
  if (!out.status) out.status = "New";
  return out;
}

export async function readLeads() {
  const db = store();
  if (!db) return [];
  const got = await fetchRows(db, `${LEADS_TABLE()}?deleted=is.false&track=eq.local&select=*&order=id.asc`, { max: 50000, timeout: 20000 });
  return got.rows.map(toLead);
}

export async function findLead(id) {
  const db = store();
  if (!db) return null;
  const r = await rest(db, `${LEADS_TABLE()}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] ? toLead(rows[0]) : null;
}

/* One lead by email address, for matching a reply to whoever sent it. Only
   an address plain enough to sit in a filter is looked up at all. */
export async function findLeadByEmail(email) {
  const db = store();
  const addr = String(email || "").trim().toLowerCase();
  if (!db || !addr || !/^[a-z0-9@._+\-]+$/.test(addr)) return null;
  const r = await rest(db, `${LEADS_TABLE()}?email=ilike.${encodeURIComponent(addr)}&deleted=is.false&track=eq.local&select=*&order=updated_at.desc&limit=1`);
  if (!r.ok) throw new Error("Could not read your leads to match that reply (" + r.status + ").");
  const rows = await r.json();
  return rows[0] ? toLead(rows[0]) : null;
}

/* Add many. Dedupe is the sheet's own rule, name plus town, done in JS against
   what is there and within the batch: the name-and-town index is partial, and
   Postgres will not take a partial index as an ON CONFLICT target. A lead with
   nothing to reach it by (no name, no phone, no email) is not a lead. */
export async function addLeads(leads, source) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const keyOf = (f) => (String(f.business || "").trim().toLowerCase() + "|" + String(f.city || "").trim().toLowerCase());
  const seen = new Set();
  let skipped = 0;
  try {
    const have = await fetchRows(db, `${LEADS_TABLE()}?deleted=is.false&track=eq.local&select=business,city`, { max: 50000, timeout: 12000 });
    have.rows.forEach((r) => { const k = keyOf(r); if (k !== "|") seen.add(k); });
  } catch { /* dedupe within the batch only; nothing is lost */ }
  const out = [];
  (Array.isArray(leads) ? leads : []).forEach((l) => {
    const f = cleanFields(l);
    if (!f.business && !f.phone && !f.email) return;
    const k = keyOf(f);
    if (k !== "|" && seen.has(k)) { skipped++; return; }
    if (k !== "|") seen.add(k);
    /* One key set for every row: PostgREST refuses a batch whose objects
       differ in shape (PGRST102), and a CSV rarely fills the same columns
       on every line. */
    const full = {};
    for (const c of FIELDS) full[c] = DATE_FIELDS.has(c) ? (f[c] || null) : (f[c] == null ? "" : f[c]);
    out.push({ ...full, track: "local", source: source || "added", heat: f.heat || "WARM", status: f.status || "New" });
  });
  if (!out.length) return { added: 0, skipped, leads: [] };
  const r = await rest(db, LEADS_TABLE(), { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(out), ms: 15000 });
  if (!r.ok) throw new Error("Could not save those leads (" + r.status + ").");
  const rows = await r.json();
  onceCache = { at: 0, value: null };
  return { added: rows.length, skipped, leads: rows.map(toLead) };
}

export async function updateLead(id, fields) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const f = cleanFields(fields || {});
  /* A date column: a real day or nothing, never an empty string. */
  if ("snooze_until" in f) f.snooze_until = /^\d{4}-\d{2}-\d{2}$/.test(f.snooze_until) ? f.snooze_until : null;
  if (!Object.keys(f).length) return null;
  const r = await rest(db, `${LEADS_TABLE()}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...f, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("Could not save that (" + r.status + ").");
  const rows = await r.json();
  return rows[0] ? toLead(rows[0]) : null;
}

export async function setDeleted(id, deleted) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const r = await rest(db, `${LEADS_TABLE()}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ deleted: !!deleted, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("Could not change that lead (" + r.status + ").");
  return true;
}

/* The autopilot's write-back and a status change from the page: status and
   the day it happened, per lead. One PATCH each; a batch is a few dozen. */
export async function markLeads(updates) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  let updated = 0;
  for (const u of Array.isArray(updates) ? updates : []) {
    const id = Number(u.row); if (!Number.isFinite(id)) continue;
    const patch = { updated_at: new Date().toISOString() };
    if (u.status != null) patch.status = String(u.status).trim().slice(0, 60);
    if (u.contacted_on != null) patch.contacted_on = String(u.contacted_on).trim().slice(0, 20);
    if (u.notes != null) patch.notes = String(u.notes).slice(0, 3000);
    const r = await rest(db, `${LEADS_TABLE()}?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (r.ok) updated++;
  }
  return { ok: true, updated };
}
