// Customers.
//   GET  -> everyone who has actually bought, merged from the three places that
//           know about them, plus what they are worth in referrals.
//   POST {action:"job"} -> logs a job against one of them.
//
// There is deliberately no "add a customer" here. A customer is a lead that
// reached Won or somebody who arrived on a referral, and both of those already
// have a front door. A third way in would let the same person exist twice with
// two different phone numbers, which is exactly the mess this view exists to
// prevent.
import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { isDemo } from "./_demo.js";
import { upsertEdit, cleanFields, toSheetFields } from "./_edits.js";
import { leadsInPostgres, updateLead, markLeads } from "./_leads.js";
import { readCustomersPg, logJobPg } from "./_customers.js";

const SRC = { email: "Outreach", call: "Phone", dm: "Instagram", referral: "Referral", other: "Other" };
const DEALS_TABLE = () => (isDemo() ? "deals_demo" : "deals");
const today = () => new Date().toISOString().slice(0, 10);

function db() {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}
async function rest(path, init) {
  const d = db();
  if (!d) throw new Error("Storage is not configured.");
  return fetch(d.url + "/rest/v1/" + path, { ...init, headers: { ...d.headers, ...(init && init.headers) }, signal: AbortSignal.timeout(6000) });
}
/* One book of business. The track is passed in rather than read here because
   these readers and writers sit outside the handler. */
const only = (path, track) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;
async function readDeals(track) {
  const r = await rest(only(`${DEALS_TABLE()}?select=id,business,email,phone,amount,mrr,source,closed_on,notes&order=closed_on.desc`, track));
  return r.ok ? await r.json() : [];
}
// The jobs logged on the demo, kept as activity rows rather than on the sheet.
async function demoJobs(track) {
  const r = await rest(only("activities_demo?kind=eq.job&select=business,subject,occurred_at&order=occurred_at.desc&limit=500", track));
  const rows = r.ok ? await r.json() : [];
  const by = new Map();
  for (const a of rows) {
    const k = String(a.business || "").trim().toLowerCase();
    if (!k) continue;
    if (!by.has(k)) by.set(k, { count: 0, last: a.subject, when: String(a.occurred_at || "").slice(0, 10) });
    by.get(k).count++;
  }
  return by;
}

// Edits to a customer. Money lives on their deal (both CRMs); on the demo the
// name, email and notes live there too. On a real CRM the name, email, phone
// and notes belong to the lead row in the sheet, through the same edits layer
// the lead drawer uses.
async function updateCustomer(res, body, track) {
  const ch = body.changes || {};
  const demo = isDemo();
  const out = { ok: true, saved: [], sheet: null, sheet_error: "" };
  const patch = {};
  if (ch.value != null && ch.value !== "") patch.amount = Math.max(0, Number(ch.value) || 0);
  if (ch.monthly != null && ch.monthly !== "") patch.mrr = Math.max(0, Number(ch.monthly) || 0);
  if (demo) {
    if (ch.name) patch.business = String(ch.name).trim().slice(0, 160);
    if (ch.email != null) patch.email = String(ch.email).trim().toLowerCase().slice(0, 200);
    if (ch.notes != null) patch.notes = String(ch.notes).trim().slice(0, 2000);
    if (ch.phone != null) patch.phone = String(ch.phone).trim().slice(0, 60);
  }
  if (Object.keys(patch).length) {
    if (body.deal_id) {
      const r = await rest(only(`${DEALS_TABLE()}?id=eq.${encodeURIComponent(body.deal_id)}`, track), { method: "PATCH", body: JSON.stringify(patch) });
      if (!r.ok) return json(res, { ok: false, error: "Could not update their deal." }, 502);
      out.saved.push("deal");
    } else if (patch.amount || patch.mrr) {
      const row = { business: String(ch.name || body.name || "").trim().slice(0, 160) || "(no name)", amount: patch.amount || 0, mrr: patch.mrr || 0,
        currency: String(body.currency || "GBP"), email: String(ch.email || body.email || "").trim().toLowerCase() || null, closed_on: today(), source: "other", notes: String(ch.notes || "").slice(0, 2000) || null };
      const r = await rest(DEALS_TABLE(), { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([stampTrack(row, track)]) });
      if (!r.ok) return json(res, { ok: false, error: "Could not put that money on the books." }, 502);
      out.deal_id = ((await r.json())[0] || {}).id;
      out.saved.push("deal");
    }
  }
  const leadRow = parseInt(body.row, 10);
  /* The sheet IS the local book. A coach's id and a local sheet row are both
     small integers from the same range, so writing one here would edit an
     unrelated local business on the live sheet. */
  if (!demo && track === "local" && leadRow > 0) {
    const fields = {};
    if (ch.name) fields[body.name_field === "owner_name" ? "owner_name" : "business"] = ch.name;
    if (ch.email != null) fields.email = ch.email;
    if (ch.phone != null) fields.phone = ch.phone;
    if (ch.notes != null) fields.notes = ch.notes;
    const clean = cleanFields(fields);
    if (Object.keys(clean).length && await leadsInPostgres()) {
      /* The lead row is the record itself; there is nothing to keep in step. */
      await updateLead(leadRow, clean);
      out.saved.push("lead");
    } else if (Object.keys(clean).length) {
      await upsertEdit(leadRow, { fields: clean });
      out.saved.push("lead");
      try {
        const r = await writeSheet({ op: "update", row: leadRow, fields: toSheetFields(clean) });
        out.sheet = !!(r && r.ok && r.updated != null);
        if (!out.sheet) out.sheet_error = "The CRM has the change; the sheet does not yet. Paste the latest Code.gs into the sheet to keep them in step.";
      } catch (err) {
        out.sheet = false; out.sheet_error = sheetError(err, "The CRM has the change either way.");
      }
    }
  }
  if (!out.saved.length) out.hint = "Nothing here could be changed: this customer came in on a referral, so edit them on the Referrals page.";
  return json(res, out);
}

// Off the customer list. On the demo their deals go; on a real CRM the lead is
// set to Lost and their deals go, which is what the confirm on the page says.
async function removeCustomer(res, body, track) {
  const name = String(body.name || "").trim();
  const demo = isDemo();
  if (name) {
    const r = await rest(only(`${DEALS_TABLE()}?business=ilike.${encodeURIComponent(name.replace(/[%_,]/g, ""))}`, track), { method: "DELETE" });
    if (!r.ok) return json(res, { ok: false, error: "Could not remove their deals." }, 502);
  }
  const leadRow = parseInt(body.row, 10);
  let sheet = null;
  // Local only, for the same reason as the edit above.
  if (!demo && track === "local" && leadRow > 0 && await leadsInPostgres()) {
    const r = await markLeads([{ row: leadRow, status: "Lost", contacted_on: today() }]);
    if (!r.updated) return json(res, { ok: false, error: "Their deals are gone, but the lead could not be marked Lost." }, 502);
  } else if (!demo && track === "local" && leadRow > 0) {
    await upsertEdit(leadRow, { fields: { status: "Lost", contacted_on: today() } });
    try {
      const r = await writeSheet({ op: "mark", updates: [{ row: leadRow, status: "Lost", contacted_on: today() }] });
      sheet = !!(r && r.ok);
    } catch { sheet = false; }
  }
  return json(res, { ok: true, removed: true, sheet });
}

const SHEET_TIMEOUT_MS = 30000;

function sheetTarget(params) {
  const base = (process.env.LEADS_SHEET_URL || "").trim();
  const token = (process.env.LEADS_SHEET_TOKEN || "").trim();
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params + (token ? "&token=" + encodeURIComponent(token) : "");
}

function sheetError(err, advice) {
  const timedOut = err && (err.name === "TimeoutError" || /aborted due to timeout/i.test(String(err.message || "")));
  if (timedOut) return "Google took too long to answer. " + advice;
  return String(err.message || err);
}

async function readSheet(track) {
  /* The Google Sheet is the local book and has no track column, so reading it
     on the coach side put local customers, their emails and the whole referral
     directory onto a coach screen. Money never crossed, because the deals
     overlay is track-filtered, but names did. The coach book's customers are
     built from its own deals instead. */
  if (track === "coach") return { ok: true, customers: [], referrals: [], directory: [] };
  const res = await fetch(sheetTarget("customers=1"), { signal: AbortSignal.timeout(SHEET_TIMEOUT_MS) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The sheet link did not return data. Re-paste the latest Code.gs and redeploy the web app.");
  }
  if (!data.ok) throw new Error(String(data.error || "the sheet rejected the request"));
  return data;
}

async function writeSheet(payload) {
  const res = await fetch((process.env.LEADS_SHEET_URL || "").trim(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: (process.env.LEADS_SHEET_TOKEN || "").trim() }),
    signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The sheet did not accept the write. Re-paste the latest Code.gs.");
  }
  if (!data.ok) throw new Error(String(data.error || "the sheet rejected the update"));
  return data;
}

function json(res, body, status = 200) {
  res.status(status).setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

const norm = (s) => String(s || "").trim().toLowerCase();

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  /* Read before the demo block below shadows `url` with the store's own. */
  const track = trackOf(req);
  const lock = (process.env.DASH_KEY || "").trim();
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed: with neither AUTH_SECRET nor DASH_KEY set nobody is let in. */
  const signedIn = authSecret ? await isAuthed(req) : false;
  const keyed = lock ? url.searchParams.get("k") === lock : false;
  if (!signedIn && !keyed) return json(res, { ok: false, error: "Not signed in.", login: true }, 401);

  /* The demo's customers are the businesses in its Deals table, so this page
     agrees with the Results tab instead of showing the real sheet's two Won
     rows beside a demo claiming 29. Dates roll forward the same way the deals
     do, so "since" matches what the Deals list shows. Read-only. */
  if (isDemo() && req.method === "GET") {
    try {
      const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
      const r = await fetch(url + "/rest/v1/" + only("deals_demo?select=id,business,closed_on,source,amount,mrr,notes,email,phone&order=closed_on.desc", track),
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error("deal store returned HTTP " + r.status);
      const rows = await r.json();
      const jobsBy = await demoJobs(track);
      const DAY = 86400000;
      const newest = rows.reduce((m, d) => Math.max(m, Date.parse(d.closed_on + "T00:00:00Z") || 0), 0);
      const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      const shift = newest ? Math.max(0, Math.round((today - newest) / DAY)) : 0;
      const src = { email: "Outreach", call: "Phone", dm: "Instagram", referral: "Referral", other: "Other" };
      /* Who has sent you work. This used to be "anybody paying a retainer",
         which is a different fact entirely: the Customers tab claimed 28
         advocates while the Referrals tab was empty and the funnel showed two
         referral wins. One referral win means one customer referred somebody,
         so there are exactly as many referrers as there are referral deals. */
      const referralWins = rows.filter((d) => String(d.source || "").toLowerCase() === "referral").length;
      const referrerIds = new Set(
        rows.filter((d) => String(d.source || "").toLowerCase() !== "referral")
            .sort((a, b) => String(a.closed_on || "").localeCompare(String(b.closed_on || "")))
            .slice(0, referralWins).map((d) => d.id)
      );
      const customers = rows.map((d, i) => {
        const since = new Date((Date.parse(d.closed_on + "T00:00:00Z") || today) + shift * DAY);
        const slug = String(d.business).toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
        const j = jobsBy.get(String(d.business || "").trim().toLowerCase());
        return {
          row: 0, deal_id: d.id, name: d.business, email: d.email || (track === "coach" ? "" : slug + "@example.com"), phone: d.phone || "",
          source: src[d.source] || "Outreach",
          since: since.toDateString().slice(0, 10),
          jobs: 1 + (j ? j.count : 0), owed: 0, sent: referrerIds.has(d.id) ? 1 : 0,
          /* The tile above this list counts one job per customer, because
             every customer here bought a build. Saying "nothing logged yet" on
             all 29 rows under a tile reading "29 jobs logged" is the same fact
             answered two ways, so name the build as the job it was. */
          last_job: j ? j.last : (track === "coach" ? "Content system" : "Website build"),
          last_job_date: j ? j.when : since.toISOString().slice(0, 10),
          value: Number(d.amount) || 0, monthly: Number(d.mrr) || 0, town: d.notes || "", notes: d.notes || "",
        };
      });
      const advocates = customers.filter((c) => c.sent > 0).length;
      return json(res, { ok: true, demo: true, customers,
        summary: { total: customers.length, jobs: customers.length, owed: 0, advocates } });
    } catch (err) {
      return json(res, { ok: false, error: "Could not read the demo customers (" + (err && err.message ? err.message : "error") + ")." }, 502);
    }
  }

  const onPg = await leadsInPostgres();
  if (!onPg && !(process.env.LEADS_SHEET_URL || "").trim()) {
    return json(res, { ok: false, error: "No database connected yet. In Vercel add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy." }, 503);
  }

  if (req.method === "GET") {
    try {
      const data = onPg ? await readCustomersPg(track) : await readSheet(track);
      const customers = (data.customers || []).slice().sort((a, b) => {
        // Most recent thing first, whether that was a job or the day they came in.
        const ax = a.last_job_date || a.since || "";
        const bx = b.last_job_date || b.since || "";
        if (ax !== bx) return ax < bx ? 1 : -1;
        return String(a.name).localeCompare(String(b.name));
      });
      /* Money comes from the deals board. A customer with deals shows what
         they paid; a deal whose business has no sheet row is a customer too,
         because a deal is exactly what makes somebody one. */
      let deals = [];
      try { deals = await readDeals(track); } catch { deals = []; }
      const byBiz = new Map();
      for (const d of deals) { const k = norm(d.business); if (!byBiz.has(k)) byBiz.set(k, []); byBiz.get(k).push(d); }
      for (const c of customers) {
        const ds = byBiz.get(norm(c.name)) || (c.email ? deals.filter((d) => d.email && norm(d.email) === norm(c.email)) : []);
        if (!ds.length) continue;
        c.deal_id = ds[0].id;
        if (!c.phone && ds[0].phone) c.phone = ds[0].phone;
        c.value = ds.reduce((n, d) => n + (Number(d.amount) || 0), 0);
        c.monthly = Number(ds[0].mrr) || 0;
        c.notes = ds[0].notes || "";
        byBiz.delete(norm(c.name));
      }
      for (const ds of byBiz.values()) {
        const d = ds[0];
        customers.push({ name: d.business, email: d.email || "", phone: d.phone || "", source: SRC[d.source] || "Outreach", since: d.closed_on || "", row: 0,
          last_job: "", last_job_date: "", jobs: 0, referred_by: "", sent: 0, owed: 0, earned: 0,
          deal_id: d.id, value: ds.reduce((n, x) => n + (Number(x.amount) || 0), 0), monthly: Number(d.mrr) || 0, notes: d.notes || "" });
      }
      const jobs = customers.reduce((n, c) => n + (Number(c.jobs) || 0), 0);
      const owed = customers.reduce((n, c) => n + (Number(c.owed) || 0), 0);
      const advocates = customers.filter((c) => Number(c.sent) > 0).length;
      return json(res, {
        ok: true,
        customers,
        summary: { total: customers.length, jobs, owed, advocates },
      });
    } catch (err) {
      return json(res, { ok: false, error: sheetError(err, "Nothing has changed. Reload the page.") }, 502);
    }
  }

  if (req.method !== "POST") return json(res, { ok: false, error: "POST or GET only" }, 405);

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (body.action === "update") {
    try { return await updateCustomer(res, body, track); }
    catch (err) { return json(res, { ok: false, error: err && err.message ? err.message : "Could not save that." }, 502); }
  }
  if (body.action === "remove") {
    try { return await removeCustomer(res, body, track); }
    catch (err) { return json(res, { ok: false, error: err && err.message ? err.message : "Could not remove them." }, 502); }
  }
  if (body.action !== "job") return json(res, { ok: false, error: "Unknown action." }, 400);

  /* A job logged on the demo is kept as an activity row, so it shows on the
     customer and on the Jobs tile after a reload, and the sheet is untouched. */
  if (isDemo()) {
    const who = String(body.customer || "").trim(), what = String(body.job || "").trim();
    if (!who || !what) return json(res, { ok: false, error: "Say who and what the job was." }, 400);
    try {
      const r = await rest("activities_demo", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([stampTrack({
        occurred_at: new Date().toISOString(), business: who.slice(0, 160), lead_email: String(body.customer_email || "").trim().toLowerCase() || null,
        channel: "note", kind: "job", subject: what.slice(0, 200), provider: "crm", external_id: "job:" + Date.now() }, track)]) });
      if (!r.ok) return json(res, { ok: false, error: "Could not log that job." }, 502);
      return json(res, { ok: true, demo: true });
    } catch (err) { return json(res, { ok: false, error: "Could not log that job." }, 502); }
  }

  const customer = String(body.customer || "").trim();
  const job = String(body.job || "").trim();
  if (!customer) return json(res, { ok: false, error: "Which customer? No name given." }, 400);
  if (!job) return json(res, { ok: false, error: "Say what the job was." }, 400);

  // The job has to belong to somebody already on the books, for the same reason
  // there is no add-a-customer button: a typo here would otherwise invent a new
  // person who nobody can ever match up again.
  let sheet;
  try {
    sheet = onPg ? await readCustomersPg(track) : await readSheet(track);
  } catch (err) {
    return json(res, { ok: false, error: sheetError(err, "Nothing was saved, so try again.") }, 502);
  }
  const email = String(body.customer_email || "").trim();
  const match = (sheet.customers || []).find((c) =>
    email ? norm(c.email) === norm(email) : norm(c.name) === norm(customer)
  );
  if (!match) {
    return json(res, {
      ok: false,
      error: `${customer} is not one of your customers yet. Mark their lead as Won first, or log the referral that brought them in.`,
    }, 400);
  }

  const jobRow = {
    customer: match.name || customer,
    customer_email: match.email || email,
    customer_phone: match.phone || String(body.customer_phone || "").trim(),
    job,
    notes: String(body.notes || "").trim(),
  };
  if (onPg) {
    try {
      const written = await logJobPg(jobRow, track);
      return json(res, { ok: true, row: written.row, customer: jobRow.customer, job });
    } catch (err) {
      return json(res, { ok: false, error: err && err.message ? err.message : "Could not log that job." }, 502);
    }
  }
  try {
    const written = await writeSheet({ op: "job", job: jobRow });
    return json(res, { ok: true, row: written.row, customer: match.name || customer, job });
  } catch (err) {
    return json(res, {
      ok: false,
      error: sheetError(err, "It may still have gone through. Reload the page and check before you log it again."),
    }, 502);
  }
}
