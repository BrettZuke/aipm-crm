// The mini CRM's data source. Runs in the student's own Vercel account.
//   GET  -> every lead from their Google Sheet (phone or not), each joined with
//           its email history from Resend (sends, opens, clicks), ranked by who
//           needs attention first. The sheet is the single source of truth.
//   POST -> saves a change back to the sheet: a call outcome, a status change,
//           or a note. One endpoint, three shapes:
//             {row, outcome: "voicemail"}   a call result (stamps date + note)
//             {row, status: "Interested"}   a direct status change
//             {row, note: "spoke to Sam"}   a dated note, prepended to Notes
// Calling itself is free: the page dials with tel: links from the student's own
// phone. This endpoint only reads Resend and reads/writes the sheet.
import { isAuthed, timingSafeEqual } from "./_auth.js";
import { readApiKey } from "./_profile.js";
import { loadProfile } from "./_profile.js";
import { readEdits, applyEdits, upsertEdit, addLeadsBatch, cleanFields, newLeadRow, toSheetFields, readEdit, pruneEdits } from "./_edits.js";
import { isDemo, demoFunnel, demoCustomerMix, applyDemoStatuses, demoEmailsFor, demoSalesFor, coverageOf } from "./_demo.js";
import { fetchRows } from "./_rows.js";
import { logFailure } from "./_log.js";
import { trackOf } from "./_track.js";
import { readCoachLeads, coachWrite, db as coachDb } from "./_coach.js";
import { readTerms } from "./_customers.js";
import { thankYouConfig, findThankYouTarget, deliverThankYou } from "./_thankyou.js";
import { leadsInPostgres, readLeads, addLeads, updateLead, setDeleted, markLeads, findLead } from "./_leads.js";

export const config = { runtime: "edge" };

const WINDOW_DAYS = 30;
const MAX_PAGES = 20; // 20 x 100 emails, months of volume

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------ last good copy

   Apps Script is slow from cold and sometimes does not answer at all, and the
   CRM was showing "Could not load your leads" when that happened: the tool
   looked broken when nothing was actually wrong with it. Every successful read
   is kept, and a failed one falls back to it rather than to an error screen.

   The store is reached with the service role key, which never leaves the
   server, and the table has row level security on, so the browser's anon key
   cannot read it. */

/* One cache row per deployment, not one shared between them.
   The demo and the real CRM run the same code against the same Supabase, so a
   single key meant whichever refreshed last decided what BOTH of them showed.
   With the demo now rewriting lead statuses on the way out, a shared key would
   have put invented history into the real CRM. */
const CACHE_KEY = isDemo() ? "crm-leads-demo" : "crm-leads";

async function saveLastGood(payload) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/sheet_cache`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{ key: CACHE_KEY, payload, saved_at: new Date().toISOString() }]),
      signal: AbortSignal.timeout(3500),
    });
  } catch {
    // Serving the leads matters more than keeping the copy up to date.
  }
}

async function readLastGood() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/sheet_cache?key=eq.${CACHE_KEY}&select=payload,saved_at&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

/** "4 minutes ago", for telling someone how old the copy they are reading is. */
function agoInWords(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return "moments ago";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return mins + " minutes ago";
  const hours = Math.round(mins / 60);
  return hours === 1 ? "an hour ago" : hours + " hours ago";
}

function sheetTarget(params) {
  const base = (process.env.LEADS_SHEET_URL || "").trim();
  const token = (process.env.LEADS_SHEET_TOKEN || "").trim();
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params + (token ? "&token=" + encodeURIComponent(token) : "");
}

// Call outcomes: what each button writes to the sheet. Keep keys in sync with
// crm.html. `retire` outcomes leave the power-dial queue for good.
export const OUTCOMES = {
  interested: { status: "Interested", note: "interested", retire: true },
  not_interested: { status: "Not a fit", note: "not interested", retire: true },
  voicemail: { status: "Voicemail", note: "left a voicemail", retire: false },
  no_answer: { status: "No answer", note: "no answer", retire: false },
  callback: { status: "Callback", note: "wants a callback", retire: false },
  bad_number: { status: "Bad number", note: "bad number", retire: true },
};

// The statuses the sheet dropdown knows. Direct status changes are held to this
// list so the sheet never collects junk values.
export const STATUSES = [
  "New", "Contacted", "Follow-up 1", "Follow-up 2", "Follow-up 3", "Follow-up 4",
  "Follow-up 5", "Nurturing", "Replied", "Removed", "Interested", "Proposal sent",
  "Won", "Lost", "Not a fit", "Voicemail", "No answer", "Callback", "Bad number",
];

// Done-with entirely (never dial, sits at the bottom of the table).
const RETIRED = new Set(["won", "lost", "removed", "bad number", "not a fit"]);
// Answer-these-first (a human responded).
const REPLIED = new Set(["replied", "interested", "proposal sent"]);
// Called before, call again later.
const RETRY = new Set(["voicemail", "no answer", "callback"]);

function heatRank(h) {
  const v = String(h || "").toUpperCase();
  return v === "HOT" ? 0 : v === "WARM" ? 1 : v === "COOL" ? 2 : 3;
}
// Who needs attention first: replies, then never-touched, then in-motion, then done.
function attentionRank(status) {
  const low = String(status || "").trim().toLowerCase();
  if (REPLIED.has(low)) return 0;
  if (!low || low === "new") return 1;
  if (RETIRED.has(low)) return 3;
  return 2;
}

// Resend timestamps: "2026-07-16 04:42:20.249721+00" (space + bare zone).
function parseTime(createdAt) {
  const iso = String(createdAt || "").replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return Date.parse(iso);
}

// One write to the sheet's script, answered as JSON. The script answers an op
// it does not know by appending nothing and saying ok, so callers look for the
// field the new op returns (updated, removed, deleted) before trusting it.
async function sheetWrite(base, payload, ms) {
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, token: (process.env.LEADS_SHEET_TOKEN || "").trim() }),
      signal: AbortSignal.timeout(ms || 20000),
      redirect: "follow",
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: "The sheet did not answer with data." }; }
  } catch (err) {
    return { ok: false, error: err && err.name === "TimeoutError" ? "The sheet took too long to answer." : "Could not reach the sheet." };
  }
}

const OLD_SCRIPT = "Your sheet's script is out of date, so the sheet was not changed. The CRM keeps the change either way. Paste the latest Code.gs into the sheet to keep the two in step.";

// Edit, add or remove a lead. The CRM's own copy is written first and always;
// the sheet second, on a real CRM, with the answer saying whether it took.
async function leadEditOp(base, body) {
  const demo = isDemo();
  /* Leads in Postgres: the write goes to the table and that is the end of it.
     No edits overlay, no sheet, no "the CRM keeps the change either way". */
  if (await leadsInPostgres()) {
    if (body.op === "add_lead") {
      const fields = cleanFields(body.fields || {});
      if (!fields.business && !fields.phone && !fields.email) return json({ ok: false, error: "A lead needs at least a name, a phone or an email." }, 400);
      const got = await addLeads([fields], "added");
      if (!got.added) return json({ ok: false, error: "You already have a lead with that name in that town." }, 409);
      return json({ ok: true, sheet: false, added: 1, lead: shapeLeads([got.leads[0]])[0] });
    }
    const id = parseInt(body.row, 10) || 0;
    if (!id) return json({ ok: false, error: "Which lead?" }, 400);
    if (body.op === "restore_lead") { await setDeleted(id, false); return json({ ok: true, row: id, sheet: false }); }
    if (body.op === "remove_lead") { await setDeleted(id, true); return json({ ok: true, row: id, sheet: false }); }
    if (body.op === "update_lead") {
      const fields = cleanFields(body.fields || {});
      if (!Object.keys(fields).length) return json({ ok: false, error: "Nothing to change." }, 400);
      await updateLead(id, fields);
      return json({ ok: true, row: id, fields, sheet: false });
    }
    return json({ ok: false, error: "Unknown op." }, 400);
  }
  if (body.op === "add_lead") {
    const fields = cleanFields(body.fields || {});
    if (!fields.business && !fields.phone && !fields.email) {
      return json({ ok: false, error: "A lead needs at least a name, a phone or an email." }, 400);
    }
    if (demo) {
      const row = newLeadRow();
      await upsertEdit(row, { fields, added: true });
      return json({ ok: true, demo: true, sheet: false, lead: shapeLeads([{ row, status: "New", ...fields }])[0] });
    }
    const r = await sheetWrite(base, { op: "add_leads", leads: [{ ...fields, heat: fields.heat || "WARM" }] }, 22000);
    if (!r.ok) return json({ ok: false, error: r.error || "The sheet did not take that lead." }, 502);
    if (!r.added) return json({ ok: false, error: "The sheet already has a lead with that name in that town." }, 409);
    return json({ ok: true, sheet: true, added: r.added });
  }
  const row = parseInt(body.row, 10);
  if (!row) return json({ ok: false, error: "Which lead?" }, 400);
  /* Undo of a removal. The CRM's copy comes back at once; a real sheet, whose
     row was cleared, gets the lead written again as a fresh row. */
  if (body.op === "restore_lead") {
    await upsertEdit(row, { deleted: false });
    let sheet = false, sheetError = "";
    if (!demo && row < 100000) {
      const fields = cleanFields(body.fields || {});
      const r = await sheetWrite(base, { op: "add_leads", leads: [{ ...fields, heat: fields.heat || "WARM" }] }, 22000);
      sheet = !!(r.ok && r.added);
      if (!sheet) { sheetError = r.error || "The sheet did not take the lead back. Add it again by hand."; await logFailure("sheet.restore", sheetError, { row }); }
    }
    return json({ ok: true, row, sheet, sheet_error: sheetError });
  }
  if (body.op === "remove_lead") {
    await upsertEdit(row, { deleted: true });
    let sheet = false, sheetError = "";
    if (!demo && row < 100000) {
      const r = await sheetWrite(base, { op: "remove", row }, 20000);
      sheet = !!(r.ok && r.removed != null);
      if (!sheet) { sheetError = r.ok ? OLD_SCRIPT : (r.error || OLD_SCRIPT); await logFailure("sheet.remove", sheetError, { row }); }
    }
    return json({ ok: true, row, sheet, sheet_error: sheetError });
  }
  if (body.op === "update_lead") {
    const fields = cleanFields(body.fields || {});
    if (!Object.keys(fields).length) return json({ ok: false, error: "Nothing to change." }, 400);
    await upsertEdit(row, { fields });
    let sheet = false, sheetError = "";
    if (!demo && row < 100000) {
      const r = await sheetWrite(base, { op: "update", row, fields: toSheetFields(fields) }, 20000);
      sheet = !!(r.ok && r.updated != null);
      if (!sheet) { sheetError = r.ok ? OLD_SCRIPT : (r.error || OLD_SCRIPT); await logFailure("sheet.update", sheetError, { row, fields: Object.keys(fields) }); }
    }
    return json({ ok: true, row, fields, sheet, sheet_error: sheetError });
  }
  return json({ ok: false, error: "Unknown op." }, 400);
}

// The notes a demo lead will have after a new note is put on top: what the
// demo kept for it before, else what the saved copy shows.
async function demoNotesAfter(row, note) {
  const kept = await readEdit(row);
  let prev = kept && kept.fields && typeof kept.fields.notes === "string" ? kept.fields.notes : null;
  if (prev == null) {
    const saved = await readLastGood();
    const lead = ((saved && saved.payload && saved.payload.leads) || []).find((l) => Number(l.row) === row);
    prev = lead ? String(lead.notes || "") : "";
  }
  return prev ? note + "\n" + prev : note;
}

export function shapeLeads(rawLeads) {
  const out = [];
  for (const l of rawLeads || []) {
    const phone = String(l.phone || "").trim();
    const email = String(l.email || "").trim().toLowerCase();
    if (!String(l.business || "").trim() && !phone && !email) continue; // blank row
    const low = String(l.status || "").trim().toLowerCase();
    out.push({
      row: l.row,
      /* Set by applyEdits on a lead a person typed in or imported. The fresh
         read shapes after it stamps, so the shape has to carry it or the
         "Added by you" view is empty on exactly the load that follows an
         import. */
      added: !!l.added,
      /* Postgres only: a row a person has changed since it was created. */
      touched: !!l.touched,
      assigned_to: l.assigned_to || "",
      /* Hidden from the list and the runs until this day. */
      snooze_until: String(l.snooze_until || "").slice(0, 10),
      business: l.business || "",
      owner_name: l.owner_name || "",
      phone,
      tel: phone.replace(/[^\d+]/g, ""),
      email,
      why: l.why || "",
      website: l.website || "",
      facebook: l.facebook || "",
      instagram: l.instagram || "",
      heat: String(l.heat || "").toUpperCase(),
      website_status: l.website_status || "",
      category: l.category || "",
      rating: l.rating || "",
      reviews: l.reviews || "",
      address: l.address || "",
      city: l.city || "",
      region: l.region || "",
      postal_code: l.postal_code || "",
      country: l.country || "",
      google_maps_url: l.google_maps_url || "",
      status: l.status || "",
      contacted_on: l.contacted_on || "",
      notes: l.notes || "",
      attention: attentionRank(l.status),
      callable: !!phone && !RETIRED.has(low) && !REPLIED.has(low),
      called_before: RETRY.has(low),
      emails: [],
    });
  }
  /* Inside a heat tier, the leads you can email come first, matching the order
     the sheet is written in. Anyone looking at the top of the list should see a
     column of real email addresses, not a run of blanks. */
  out.sort((a, b) =>
    a.attention - b.attention ||
    heatRank(a.heat) - heatRank(b.heat) ||
    (a.email ? 0 : 1) - (b.email ? 0 : 1) ||
    (parseInt(b.reviews, 10) || 0) - (parseInt(a.reviews, 10) || 0) ||
    a.business.localeCompare(b.business)
  );
  return out;
}

// Attach each lead's Resend history: [{when, subject, event}], newest first.
/* Every touch from every channel, attached to its lead. Matched by address,
   then by sheet row for leads that have no email. One query for the whole
   list rather than one per lead, capped at the most recent two thousand rows
   so a busy month cannot make the leads call slow. */
/* The activity rows for one book, newest first, page by page up to ten
   thousand. Started on its own so it can run while the leads are read. */
export function fetchActivityRows(track) {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return Promise.resolve({ rows: [], truncated: false });
  const only = "&track=eq." + (track === "coach" ? "coach" : "local");
  return fetchRows({ url, headers: { apikey: key, Authorization: `Bearer ${key}` } },
      "activities?select=id,occurred_at,lead_row,lead_email,channel,kind,step,subject,preview,provider,source,data&order=occurred_at.desc" + only, { max: 10000 });
}

export async function joinActivities(leads, track, pre) {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return leads;
  /* Narrowed to one book of business. A coach lead is keyed by its own id and
     a local lead by its sheet row, and those two number series overlap, so
     without this filter coach number five would inherit sheet row five's
     entire history. */
  const only = "&track=eq." + (track === "coach" ? "coach" : "local");
  let rows = [];
  let cutoff = "";
  try {
    /* Newest first, page by page, up to ten thousand rows. Past that the
       oldest are left out and the payload says since when, so the page can
       say so instead of quietly showing a lead as never touched. */
    const got = pre ? await pre : await fetchActivityRows(track);
    rows = got.rows;
    if (got.truncated && rows.length) cutoff = rows[rows.length - 1].occurred_at;
  } catch { rows = []; }
  joinActivities.cutoff = cutoff;
  /* The demo's booked sales calls are worked out from each lead's stage, so
     they exist on the cached copy as well as a fresh one, and a lead's call
     is the same call on every load. Real CRMs log theirs through api/activity. */
  /* The coach book carries its own seeded history now; the made-up calls
     were only ever for the local book's derived story. */
  if (isDemo() && track !== "coach") for (const lead of leads) lead.activity = demoSalesFor(lead);
  if (!rows.length) return leads;
  /* The demo's seeded history is dated once. Slide it so its newest entry sits
     a few hours ago on whatever day the demo is watched, spacing kept, the way
     the deals already roll; a real open of a tracked link keeps its real time. */
  if (isDemo()) {
    const seeded = rows.filter((a) => a.provider !== "go");
    const newest = Math.max(...seeded.map((a) => Date.parse(a.occurred_at) || 0));
    const shift = newest ? Date.now() - 3 * 3600 * 1000 - newest : 0;
    if (shift > 0) for (const a of seeded) a.occurred_at = new Date(Date.parse(a.occurred_at) + shift).toISOString();
    rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  }
  const byEmail = new Map(), byRow = new Map();
  for (const a of rows) {
    const e = (a.lead_email || "").toLowerCase();
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(a); }
    if (a.lead_row) { if (!byRow.has(a.lead_row)) byRow.set(a.lead_row, []); byRow.get(a.lead_row).push(a); }
  }
  for (const lead of leads) {
    const hits = (lead.email && byEmail.get(lead.email)) || byRow.get(lead.row) || [];
    lead.activity = (lead.activity || []).concat(hits.slice(0, 50));
  }
  return leads;
}

export function joinEmails(leads, resendRows) {
  const byRecipient = new Map();
  for (const r of resendRows || []) {
    const to = (Array.isArray(r.to) ? r.to[0] : r.to || "").trim().toLowerCase();
    if (!to) continue;
    if (!byRecipient.has(to)) byRecipient.set(to, []);
    byRecipient.get(to).push({
      when: String(r.created_at || "").slice(0, 16),
      subject: r.subject || "",
      event: r.last_event || "sent",
    });
  }
  for (const lead of leads) {
    if (!lead.email) continue;
    const hits = byRecipient.get(lead.email) || [];
    lead.emails = hits.slice(0, 20);
  }
  return leads;
}

async function fetchResend(apiKey) {
  const rows = [];
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  let after = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const res = await fetch("https://api.resend.com/emails?" + qs, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error("Resend returned HTTP " + res.status);
    const body = await res.json();
    const batch = body.data || [];
    rows.push(...batch);
    if (!body.has_more || batch.length === 0) break;
    const oldest = batch[batch.length - 1];
    after = oldest.id;
    if (parseTime(oldest.created_at) < cutoff) break;
  }
  return rows.filter((r) => {
    const t = parseTime(r.created_at);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

const SCRIPT_KEYS = ["no_website", "old_site", "voicemail"];

// The CRM's script editor: saves the three call scripts into the sheet's
// Scripts tab (the sheet is storage only; editing happens in the CRM).
async function saveScripts(base, body) {
  const incoming = body.scripts && typeof body.scripts === "object" ? body.scripts : null;
  if (!incoming) return json({ ok: false, error: "Nothing to save." }, 400);
  const scripts = {};
  for (const k of SCRIPT_KEYS) {
    if (typeof incoming[k] === "string") scripts[k] = incoming[k].slice(0, 5000);
  }
  if (!Object.keys(scripts).length) return json({ ok: false, error: "Nothing to save." }, 400);
  /* The dialler's sheet copy only exists when there is a sheet; the scripts
     library already holds the edit. */
  if (!base) return json({ ok: true, saved: 0, sheet: false, scripts });
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "scripts", token: (process.env.LEADS_SHEET_TOKEN || "").trim(), scripts }),
      signal: AbortSignal.timeout(15000),
    });
    const data = JSON.parse(await res.text());
    if (!data.ok) return json({ ok: false, error: String(data.error || "the sheet rejected the update") }, 502);
    return json({ ok: true, saved: data.saved || 0, scripts });
  } catch (err) {
    return json({ ok: false, error: "Could not save (" + (err && err.message ? err.message : "network error") + "). Try again." }, 502);
  }
}

async function saveChange(base, body) {
  const row = parseInt(body.row, 10);
  /* Sheet rows start at 3 (two header rows); table ids start at 1. */
  if (!row || row < 1 || (row < 3 && !(await leadsInPostgres()))) return json({ ok: false, error: "Unknown lead row." }, 400);
  const when = new Date().toISOString().slice(0, 10);
  const update = { row };
  let retire = false;

  if (body.outcome != null) {
    const rule = OUTCOMES[String(body.outcome)];
    if (!rule) return json({ ok: false, error: "Unknown call outcome." }, 400);
    update.status = rule.status;
    update.contacted_on = when;
    update.note = "Called " + when + ": " + rule.note;
    retire = rule.retire;
  } else {
    if (body.status != null) {
      const status = String(body.status).trim();
      if (!STATUSES.includes(status)) return json({ ok: false, error: "Unknown status." }, 400);
      update.status = status;
      // Moving a lead into an email-sequence stage restarts its follow-up clock.
      // Without a date the autopilot would treat it as never contacted and skip
      // its follow-ups forever, so a board drag or status toggle stamps today.
      if (/^(contacted|follow-up [1-5]|nurturing)$/i.test(status)) update.contacted_on = when;

      /* Undo has to put the date back as well as the status.
         Moving a lead to Contacted stamps today. Undoing that used to restore
         only the status, leaving a contact date for a conversation that never
         happened, which then made the lead look recently worked when it had
         never been touched at all. An explicit contacted_on wins over the
         stamp above, and an empty string clears it. */
      if (typeof body.contacted_on === "string") {
        const want = body.contacted_on.trim().slice(0, 10);
        /* The sheet skips empty values, so sending "" leaves the old date in
           place. A formula that evaluates to nothing is the one thing it will
           accept that reads back as blank. */
        update.contacted_on = want || '=""';
      }
    }
    if (body.note != null) {
      const note = String(body.note).trim().slice(0, 500);
      if (note) update.note = when + ": " + note;
    }
    if (!update.status && !update.note) return json({ ok: false, error: "Nothing to save." }, 400);
  }

  // Winning a lead is the one status change that reaches the customer: it sends
  // them the thank-you video page. Who to email has to be worked out before the
  // write, because afterwards the sheet says Won and there is no way left to
  // tell a fresh customer from one who was already marked months ago.
  const tyCfg = thankYouConfig(await readTerms().catch(() => ({})));
  const winning = String(update.status || "").trim().toLowerCase() === "won";
  const onPg = await leadsInPostgres();
  const target = winning && tyCfg.ready
    ? await findThankYouTarget((process.env.LEADS_SHEET_URL || "").trim(), (process.env.LEADS_SHEET_TOKEN || "").trim(), row, tyCfg, onPg ? await findLead(row) : null)
    : { skip: "not a win" };

  if (onPg) {
    const r = await markLeads([update]);
    if (!r.updated) return json({ ok: false, error: "Could not save that status." }, 502);
    let welcomed = "";
    if (target.lead) {
      const out = await deliverThankYou(tyCfg, target.lead);
      welcomed = out.sent ? "Thank-you video sent to " + target.lead.email : "Could not send the thank-you email: " + out.reason;
    }
    return json({ ok: true, row, status: update.status || "", note: update.note || "", contacted_on: update.contacted_on || "", retire, welcomed });
  }

  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "mark",
        token: (process.env.LEADS_SHEET_TOKEN || "").trim(),
        updates: [update],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = JSON.parse(await res.text());
    if (!data.ok) return json({ ok: false, error: String(data.error || "the sheet rejected the update") }, 502);

    // Only now that the save is safely on the sheet.
    let welcomed = "";
    if (target.lead) {
      const out = await deliverThankYou(tyCfg, target.lead);
      welcomed = out.sent ? "Thank-you video sent to " + target.lead.email : "Could not send the thank-you email: " + out.reason;
    }

    return json({ ok: true, row, status: update.status || "", note: update.note || "", contacted_on: update.contacted_on || "", retire, welcomed });
  } catch (err) {
    return json({
      ok: false,
      error: "Could not save to the sheet (" + (err && err.message ? err.message : "network error") + "). Nothing was logged, so try again.",
    }, 502);
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  // The gate: a login cookie (AUTH_SECRET) or the legacy ?k= key (DASH_KEY).
  // Fail closed: with neither set nobody is let in, never everybody.
  const lock = (process.env.DASH_KEY || "").trim();
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* The API key from Settings opens one door here and no other: adding
     leads. That is what a website form, a Make scenario or a scraper needs,
     and it is all a leaked key should be able to do. Same two candidates and
     the same constant-time compare as /api/activity, each guarded by its own
     key being set, because timingSafeEqual("", "") is a match. */
  let keyedAdd = false;
  const given = req.method === "POST" ? (req.headers.get("x-activity-secret") || "") : "";
  if (given) {
    const stored = await readApiKey(), envKey = (process.env.ACTIVITY_SECRET || "").trim();
    const byStored = !!stored && timingSafeEqual(given, stored);
    const byEnv = !!envKey && timingSafeEqual(given, envKey);
    keyedAdd = byStored || byEnv;
  }
  const keyOk = !!lock && url.searchParams.get("k") === lock;
  const cookieOk = !!authSecret && (await isAuthed(req));
  let sessionOk = !!(keyOk || cookieOk);
  if (!sessionOk && !keyedAdd) {
    const out = { ok: false };
    if (authSecret || !lock) out.login = true; // tells the page to show the login screen
    else out.error = "This page is locked. Open it with ?k=your-key added to the address.";
    return json(out, 401);
  }
  const ADD_OPS = new Set(["add_lead", "add_leads"]);
  const keyOnly = (body) => !sessionOk && keyedAdd && !ADD_OPS.has(body && body.op);
  /* The coach book, served before the sheet is even looked at.

     Coaches live in Supabase, not the Google Sheet, so this branch works on a
     deployment that has no sheet connected at all. That matters: somebody
     selling only to online coaches should never have to set up Apps Script. */
  if (trackOf(req) === "coach") {
    const cdb = coachDb();
    if (!cdb) {
      return json({
        ok: false,
        connected: false,
        error: "No database connected yet. In Vercel add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy. See dashboard/README.md.",
      });
    }
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
      if (keyOnly(body)) return json({ ok: false, error: "That key can only add leads." }, 403);
      try {
        const out = await coachWrite(cdb, body);
        return json(out, out.ok ? 200 : 400);
      } catch (err) {
        return json({ ok: false, error: err && err.message ? err.message : "Could not save that." }, 502);
      }
    }
    let leads = [];
    const actP = fetchActivityRows("coach"); actP.catch(() => {});
    try { leads = await readCoachLeads(cdb); }
    catch { return json({ ok: false, connected: true, error: "Could not read your coaches right now." }, 502); }
    await joinActivities(leads, "coach", actP);
    const cprof = await loadProfile();
    return json({
      ok: true,
      connected: true,
      track: "coach",
      count: leads.length,
      demo: isDemo(),
      activity_since: joinActivities.cutoff || "",
      agent: cprof.name,
      video: cprof.video,
      scripts: {},
      emails_joined: false,
      partial: "",
      leads,
    });
  }

  const base = (process.env.LEADS_SHEET_URL || "").trim();
  /* No sheet is fine: the leads live in the database then. Neither is not. */
  if (!base && !(await leadsInPostgres())) {
    return json({
      ok: false,
      connected: false,
      error: "No database connected yet. In Vercel add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy. See dashboard/README.md.",
    });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Bad request." }, 400);
    }
    if (keyOnly(body)) return json({ ok: false, error: "That key can only add leads." }, 403);
    /* Nothing the demo does may reach the real sheet. The demo shares its
       leads sheet with the real CRM, so a call outcome clicked in the demo, a
       status change in the drawer, or a batch of scraped leads filed by Find
       and build would have landed in the real pipeline. Each write is answered
       in the exact shape the page expects, so the row updates on screen, and
       then dropped. Nothing is stored anywhere. */
    if (body.op === "update_lead" || body.op === "remove_lead" || body.op === "add_lead" || body.op === "restore_lead") {
      try { return await leadEditOp(base, body); }
      catch (err) { return json({ ok: false, error: err && err.message ? err.message : "Could not save that." }, 502); }
    }
    /* The demo never writes to the sheet, but what is done on it now sticks:
       a status, a note, a batch of found leads all go to the demo's own edits
       layer and are laid over the leads on the next read. */
    if (isDemo()) {
      const today = new Date().toISOString().slice(0, 10);
      if (body.scripts != null) {
        return json({ ok: true, demo: true, saved: Object.keys(body.scripts || {}).length, scripts: body.scripts });
      }
      if (body.op === "add_leads") {
        const leads = Array.isArray(body.leads) ? body.leads.slice(0, 200) : [];
        if (await leadsInPostgres()) {
          try { const got = await addLeads(leads, "import"); return json({ ok: true, demo: true, added: got.added, skipped: got.skipped, rows: got.added, count: got.added }); }
          catch (err) { return json({ ok: false, error: err && err.message ? err.message : "Could not save those leads." }, 502); }
        }
        try {
          const got = await addLeadsBatch(leads);
          return json({ ok: true, demo: true, added: got.added, skipped: got.skipped, rows: got.added, count: got.added });
        } catch (err) {
          return json({ ok: false, error: err && err.message ? err.message : "Could not save those leads." }, 502);
        }
      }
      const row = parseInt(body.row, 10) || 0;
      const rule = body.outcome ? OUTCOMES[String(body.outcome)] : null;
      const status = rule ? rule.status : String(body.status || "");
      const note = rule ? rule.note : String(body.note || "");
      if (row) {
        const fields = {};
        if (status) { fields.status = status; fields.contacted_on = today; }
        if (await leadsInPostgres()) {
          /* The edit is the row itself; the read has no overlay to lay over it. */
          if (note) { const cur = await findLead(row); const prev = cur ? String(cur.notes || "") : ""; fields.notes = prev ? note + "\n" + prev : note; fields.contacted_on = today; }
          if (Object.keys(fields).length) {
            const r = await markLeads([{ row, ...fields }]);
            if (!r.updated) return json({ ok: false, error: "Could not save that status." }, 502);
          }
        } else {
          if (note) { fields.notes = await demoNotesAfter(row, note); fields.contacted_on = today; }
          if (Object.keys(fields).length) { try { await upsertEdit(row, { fields }); } catch { /* answered as before; the screen still updates */ } }
        }
      }
      return json({ ok: true, demo: true, row, status, note, contacted_on: today, retire: !!(rule && rule.retire), welcomed: false });
    }

    if (body.scripts != null) return saveScripts(base, body);
    // Find and build sends the businesses it scraped, so they land in the sheet
    // beside every other lead. The dashboard holds no sheet credentials, so it
    // goes through here like every other write.
    if (body.op === "add_leads") {
      if (await leadsInPostgres()) {
        try { const got = await addLeads(Array.isArray(body.leads) ? body.leads.slice(0, 200) : [], "import"); return json({ ok: true, added: got.added, skipped: got.skipped, rows: got.added, count: got.added }); }
        catch (err) { return json({ ok: false, error: err && err.message ? err.message : "Could not save those leads." }, 502); }
      }
      /* Apps Script is slow from cold, and writing a batch of leads is the
         slowest thing it does. Fifteen seconds was not enough: the run would
         finish, the sites would all be built, and then the last thing on
         screen said the leads had not been filed. Two attempts, the second
         after a pause to let a cold script finish waking up.

         Worth being clear about what is at stake: every lead is already saved
         to our own store by the builder, so nothing is lost when this fails.
         The sheet is the copy the student can see, which is exactly why it
         should not quietly stop being written to. */
      const payload = JSON.stringify({
        op: "add_leads",
        token: (process.env.LEADS_SHEET_TOKEN || "").trim(),
        leads: body.leads || [],
      });

      /* One attempt, and it has to fit inside the platform's own ceiling for an
         edge function, which is twenty five seconds. Two attempts of eighteen
         and twelve added up to thirty, so the platform killed the function
         mid-write and answered with an HTML error page instead of JSON: the
         retry meant to make this reliable was the thing breaking it. A cold
         Apps Script needs the better part of twenty seconds, so it gets one
         run at it with a few seconds of headroom. */
      let lastError = "";
      for (const budget of [21000]) {
        try {
          const res = await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            signal: AbortSignal.timeout(budget),
          });
          const text = await res.text();
          try {
            return json(JSON.parse(text));
          } catch {
            lastError = "the sheet did not return data";
          }
        } catch (error) {
          lastError = (error && error.message) || "network error";
        }
      }
      return json({
        ok: false,
        error: "Your sheet did not answer, so these are not in it yet. They are saved here and on the Find and build tab.",
        detail: lastError.slice(0, 80),
      });
    }
    return saveChange(base, body);
  }

  // GET: the sheet and the Resend history, in parallel.
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const resendPromise = apiKey ? fetchResend(apiKey).catch(() => null) : Promise.resolve([]);

  // Apps Script is slow when it has been idle: the first request in a while
  // often blows a ten second budget, and one timeout was showing the whole CRM
  // as broken. Try twice, with a longer second attempt, before giving up.
  async function fetchSheet() {
    // Both attempts together must finish inside the platform's own ceiling for
    // this function. Twelve plus twenty exceeded it, and the platform then
    // returned an HTML error page, which the browser could not parse as JSON:
    // the retry meant to fix slow loading was breaking the page outright.
    /* One long attempt, then a short retry for the case where the first was
       simply unlucky. Thirteen seconds was enough for seventeen hundred rows
       and is not enough for nearly eight thousand: the read was timing out on
       every single load, so the CRM fell back to its saved copy every time and
       quietly served whatever that copy last held. The function's own ceiling
       is sixty seconds, so thirty leaves room for the work that follows. */
    const budgets = [30000, 8000];
    let lastError;
    for (const budget of budgets) {
      try {
        return await fetch(sheetTarget("crm=1"), { signal: AbortSignal.timeout(budget) });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /* Apps Script needs the better part of twenty seconds when it has been idle,
     and every visitor was paying it. A copy from the last few minutes is worth
     far more than numbers that are twenty seconds fresher, so a recent one is
     served straight away. The refresh button asks for a live read, and any
     copy older than the window below forces one anyway. */
  /* Six hours, not fifteen minutes. The window used to be short so the data
     could not drift far, but that meant whoever arrived after it lapsed paid
     the full twenty second wait, and on a live demo that person is the one
     standing in front of an audience. The page now refreshes itself in the
     background straight after it paints, so a longer window costs nothing:
     the screen fills instantly and the live numbers land a moment later. */
  /* Six hours is right for a real CRM, where a stale copy beats a slow page and
     the sheet is the thing that changed. It is wrong for the demo, whose lead
     data is derived rather than fetched: there the only thing a long cache can
     do is serve a version from before the last change, which is exactly what it
     did. Fifteen minutes keeps the demo quick to open without it ever showing
     yesterday's shape. */
  /* Sixty, not fifteen. A live read of this sheet is half a minute now, and on
     the demo that is half a minute of somebody standing in front of an
     audience. The demo's leads are derived rather than fetched, so the only
     thing that changes them is a deploy, and a deploy is always followed by a
     ?fresh=1 read that refills this copy. */
  const FAST_COPY_MINUTES = isDemo() ? 60 : 360;
  const wantsFresh = url.searchParams.get("fresh") === "1";
  /* Postgres needs no saved copy: a read is a fraction of a second, and a
     copy would only ever be a way to show something older than the table. */
  const fromPg = await leadsInPostgres();
  if (!fromPg && !wantsFresh) {
    const saved = await readLastGood();
    const ageMinutes = saved && saved.saved_at
      ? (Date.now() - Date.parse(saved.saved_at)) / 60000
      : Infinity;
    /* A saved copy is ALWAYS served if there is one. It used to be served
       only while younger than FAST_COPY_MINUTES, and past that the request
       blocked on a live sheet read, which at 7,805 rows is half a minute.
       So once an hour on the demo, whoever opened the CRM next sat on
       "Loading your leads" for thirty seconds: that was the "tabs take
       forever" complaint, verbatim. Now the copy goes out at once and the
       page is told to refill it behind the screen (`refresh`), so the live
       read still happens, just never with somebody waiting on it. Only a
       deployment with no copy at all, or an explicit ?fresh=1, reads inline. */
    if (saved && saved.payload) {
      const old = ageMinutes >= FAST_COPY_MINUTES;
      /* The copy is minutes or hours old, but what was changed or logged since
         (an edit, a dialler call, a Make send, a link opened) is one cheap read
         away. Lay it over now so a lead never shows older than the page. */
      saved.payload.leads = applyEdits(saved.payload.leads || [], await readEdits(), shapeLeads);
      saved.payload.count = saved.payload.leads.length;
      await joinActivities(saved.payload.leads);
      /* The "showing a saved copy" line is honest housekeeping on a real CRM
         and a tell on a demo, where it reads as though the screen cannot be
         trusted. The demo serves the same cached payload without narrating it. */
      if (isDemo()) return json({ ...saved.payload, demo: isDemo(), stale: false, refresh: old });
      return json({
        ...saved.payload,
        stale: true,
        refresh: old,
        saved_ago: agoInWords(saved.saved_at),
        partial: saved.payload.partial ||
          "Showing the copy saved " + agoInWords(saved.saved_at) + ". Hit refresh for the very latest.",
      });
    }
  }

  let data, actP = null;
  if (fromPg) {
    actP = fetchActivityRows("local"); actP.catch(() => {});
    try { data = { ok: true, leads: await readLeads() }; }
    catch (err) { return json({ ok: false, connected: true, error: "Could not read your leads (" + (err && err.message ? err.message : "database error") + ")." }); }
  } else try {
    const res = await fetchSheet();
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      return json({
        ok: false,
        connected: true,
        error: "The sheet link did not return data. Make sure the web app is deployed so 'Anyone' can access it, and that you pasted the latest Code.gs.",
      });
    }
  } catch (err) {
    /* The sheet did not answer. Serving the copy from the last successful read
       keeps the CRM usable, and says plainly how old it is so nobody acts on
       stale numbers without knowing. */
    const saved = await readLastGood();
    if (saved && saved.payload) {
      saved.payload.leads = applyEdits(saved.payload.leads || [], await readEdits(), shapeLeads);
      saved.payload.count = saved.payload.leads.length;
      await joinActivities(saved.payload.leads);
      return json({
        ...saved.payload,
        stale: true,
        partial: "Your sheet did not answer just now, so this is the copy saved " +
                 agoInWords(saved.saved_at) + ". Changes you make will still be written to the sheet.",
      });
    }
    return json({
      ok: false,
      connected: true,
      error: "Could not reach the sheet (" + (err && err.message ? err.message : "network error") + ").",
    });
  }
  if (!data.ok) {
    let msg = String(data.error || "the sheet rejected the request");
    if (/phone|crm/i.test(msg)) msg += " Re-paste the latest Code.gs into your sheet.";
    return json({ ok: false, connected: true, error: msg });
  }

  /* On the demo, give the scraped leads the history the rest of the demo
     claims. The Results tab said 1,160 emailed and 29 customers while this list
     showed 1,725 of 1,733 still New, so clicking one tab across contradicted
     the other. Both now come from the same place: the rows in deals_demo.
     Read-only, so the sheet itself is never touched. */
  let rawLeads = data.leads || [];
  if (isDemo()) {
    /* Who paid and through which channel, and who on the list can be reached
       which way: the two facts every demo figure is worked back from. */
    const funnel = demoFunnel(await demoCustomerMix(), coverageOf(rawLeads));
    /* On the sheet the hand-made edits were laid over the derived story
       afterwards, so a status changed in the drawer stuck. On Postgres the
       edit IS the row, and the derivation would wipe it on the next read.
       Rows a person has touched keep what they were given. */
    const kept = fromPg ? new Map(rawLeads.filter((l) => l.touched).map((l) => [l.row, l])) : null;
    rawLeads = applyDemoStatuses(rawLeads, funnel);
    if (kept && kept.size) rawLeads = rawLeads.map((l) => {
      const k = kept.get(l.row);
      return k ? { ...l, status: k.status, contacted_on: k.contacted_on, notes: k.notes } : l;
    });
  }
  /* What was edited, added or removed inside the CRM, over the sheet's rows.
     On a real sheet, first let go of every edit the sheet now agrees with. */
  /* On Postgres every edit is already in the row; there is no overlay. */
  const edits = fromPg ? [] : await readEdits();
  if (!isDemo() && edits.length) await pruneEdits(rawLeads, edits);
  rawLeads = applyEdits(rawLeads, edits);
  const leads = shapeLeads(rawLeads);
  const scripts = data.scripts && typeof data.scripts === "object" ? data.scripts : {};
  const resendRows = await resendPromise; // null means Resend failed
  if (isDemo()) {
    // Generated from each lead's stage, so the Sent emails tab adds up to the
    // same 1,160 the Results tab claims instead of showing the real 70.
    for (const lead of leads) lead.emails = demoEmailsFor(lead);
  } else if (resendRows) {
    joinEmails(leads, resendRows);
  }
  await joinActivities(leads, "local", actP || undefined);

  const prof = await loadProfile();
  const payload = {
    ok: true,
    connected: true,
    count: leads.length,
    demo: isDemo(),
    store: fromPg ? "postgres" : "sheet", // the Leads bar says which
    activity_since: joinActivities.cutoff || "",
    agent: prof.name,
    video: prof.video, // prefills the follow-up email
    scripts, // custom call scripts from the sheet's Scripts tab, when present
    emails_joined: !!resendRows && !!apiKey,
    partial: resendRows === null ? "Email history is unavailable right now (Resend did not respond); calls and statuses still work." : "",
    leads,
  };
  if (!fromPg) await saveLastGood(payload);
  return json(payload);
}
