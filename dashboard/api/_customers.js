// Customers, referrals and jobs when the leads live in Postgres.
//
// On a sheet these were three tabs the Apps Script summed up on every read.
// Here they are the same facts from three tables: a customer is a lead marked
// Won, somebody who arrived on a referral, or somebody a job was logged
// against; the referral rows say who sent whom and what is owed; a job is an
// activity row of kind "job", the shape the demo already writes. The people
// come out keyed the way the sheet keyed them (email, then phone, then name),
// so the Customers page and the referral directory can never disagree about
// who is who.
import { isDemo } from "./_demo.js";
import { fetchRows } from "./_rows.js";
import { LEADS_TABLE, store, rest } from "./_leads.js";
import { stampTrack } from "./_track.js";

const REFERRALS_TABLE = () => (isDemo() ? "referrals_demo" : "referrals");
const KV_TABLE = () => (isDemo() ? "kv_demo" : "kv");
const ACTIVITIES_TABLE = () => (isDemo() ? "activities_demo" : "activities");
const DEALS_TABLE = () => (isDemo() ? "deals_demo" : "deals");

const need = () => { const db = store(); if (!db) throw new Error("Storage is not configured."); return db; };
const trackOnly = (t) => (t === "coach" ? "coach" : "local");
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 200);
const day = (v) => String(v || "").slice(0, 10);
const norm = (s) => String(s || "").trim().toLowerCase();

export function shapeReferral(r) {
  return {
    row: Number(r.id), date: day(r.date), customer: r.customer || "", customer_email: r.customer_email || "",
    customer_phone: r.customer_phone || "", job: r.job || "", referrer: r.referrer || "", referrer_email: r.referrer_email || "",
    reward: Number(r.reward) || 0, reward_type: r.reward_type || "cash", status: r.status || "Pending",
    paid_on: r.paid_on ? day(r.paid_on) : "", payment_ref: r.payment_ref || "",
  };
}

async function readReferralRows(db, track) {
  const got = await fetchRows(db, `${REFERRALS_TABLE()}?track=eq.${track}&select=*&order=id.asc`, { max: 20000, timeout: 12000 });
  return got.rows.map(shapeReferral);
}

export async function readTerms() {
  const db = need();
  const r = await rest(db, `${KV_TABLE()}?key=eq.referral_terms&select=value&limit=1`);
  if (!r.ok) return {};
  const rows = await r.json();
  return rows[0] && rows[0].value && typeof rows[0].value === "object" ? rows[0].value : {};
}

async function readJobs(db, track) {
  const got = await fetchRows(db, `${ACTIVITIES_TABLE()}?track=eq.${track}&kind=eq.job&select=business,lead_email,subject,occurred_at,data&order=occurred_at.desc`, { max: 5000, timeout: 12000 });
  return got.rows.map((a) => ({
    name: a.business || "", email: a.lead_email || "", phone: (a.data && a.data.phone) || "", job: a.subject || "", when: day(a.occurred_at),
  }));
}

/* Coaches live in their own table and never reach Won through this book. */
async function readWon(db, track) {
  if (track !== "local") return [];
  const got = await fetchRows(db, `${LEADS_TABLE()}?track=eq.local&deleted=is.false&status=ilike.won&select=id,business,owner_name,email,phone,contacted_on`, { max: 20000, timeout: 12000 });
  return got.rows;
}

async function readDealPeople(db, track) {
  const got = await fetchRows(db, `${DEALS_TABLE()}?track=eq.${track}&select=business,email,phone,closed_on&order=closed_on.desc`, { max: 5000, timeout: 12000 });
  return got.rows;
}

function customersFrom(won, referrals, jobs) {
  const people = [], byKey = new Map();
  const keyFor = (email, phone, name) => norm(email) || String(phone || "").replace(/[^0-9]/g, "") || norm(name);
  const upsert = (name, email, phone, source, when) => {
    name = str(name, 160); email = norm(email).slice(0, 200); phone = str(phone, 60);
    const key = keyFor(email, phone, name);
    if (!key) return null;
    let p = byKey.get(key);
    if (!p) {
      p = { name, email, phone, source: source || "", since: when || "", row: 0, last_job: "", last_job_date: "", jobs: 0, referred_by: "", sent: 0, owed: 0, earned: 0 };
      byKey.set(key, p);
      people.push(p);
      return p;
    }
    // Fill in blanks from whichever source knows more, never overwrite.
    if (!p.name && name) p.name = name;
    if (!p.email && email) p.email = email;
    if (!p.phone && phone) p.phone = phone;
    if (!p.source && source) p.source = source;
    if (when && (!p.since || String(when) < String(p.since))) p.since = when;
    return p;
  };

  for (const l of won) {
    const p = upsert(l.owner_name || l.business, l.email, l.phone, "Outreach", day(l.contacted_on));
    if (p) p.row = Number(l.id);
  }
  for (const r of referrals) {
    if (!r.customer) continue;
    const cust = upsert(r.customer, r.customer_email, r.customer_phone, "Referral", r.date);
    if (cust) {
      cust.referred_by = r.referrer;
      if (r.job && (!cust.last_job_date || r.date >= cust.last_job_date)) { cust.last_job = r.job; cust.last_job_date = r.date; }
      if (r.job) cust.jobs += 1;
    }
    /* Whoever sent them belongs here too: somebody can send work without
       ever having bought, and leaving them out under-reports what is owed. */
    const sender = upsert(r.referrer, r.referrer_email, "", "Referrer", r.date);
    if (sender) {
      sender.sent += 1;
      const status = norm(r.status);
      if (status === "paid") sender.earned += r.reward;
      else if (status !== "void") sender.owed += r.reward;
    }
  }
  for (const j of jobs) {
    if (!j.name) continue;
    const who = upsert(j.name, j.email, j.phone, "Added", j.when);
    if (!who) continue;
    who.jobs += 1;
    if (!who.last_job_date || j.when >= who.last_job_date) { who.last_job = j.job; who.last_job_date = j.when; }
  }
  return people;
}

/* Who can be named as a referrer: the customers, plus anyone with a deal. */
function directoryFrom(people, dealPeople) {
  const out = [], seen = new Set(), names = new Set();
  const push = (name, email, phone, note) => {
    name = str(name, 160); email = norm(email).slice(0, 200); phone = str(phone, 60);
    if (!name && !email) return;
    const key = email || phone || name.toLowerCase();
    /* A deal with no email must not add a second "Dave" beside the customer. */
    if (seen.has(key) || (!email && !phone && names.has(name.toLowerCase()))) return;
    seen.add(key);
    if (name) names.add(name.toLowerCase());
    out.push({ name, email, phone, note: str(note) });
  };
  for (const p of people) push(p.name, p.email, p.phone, p.source === "Referral" ? "referred " + p.since : p.since);
  for (const d of dealPeople) push(d.business, d.email, d.phone, day(d.closed_on));
  return out;
}

/* Everything the Customers and Referrals pages read, in the shape the sheet
   answered with, so the pages did not have to change. */
export async function readCustomersPg(track) {
  const db = need();
  const t = trackOnly(track);
  const [won, referrals, jobs, deals, terms] = await Promise.all([
    readWon(db, t), readReferralRows(db, t), readJobs(db, t), readDealPeople(db, t), readTerms(),
  ]);
  const customers = customersFrom(won, referrals, jobs);
  return { ok: true, customers, referrals, directory: directoryFrom(customers, deals), terms };
}

export async function addReferralPg(record, track, date) {
  const db = need();
  const row = stampTrack({
    date, customer: str(record.customer, 160), customer_email: norm(record.customer_email).slice(0, 200), customer_phone: str(record.customer_phone, 60),
    job: str(record.job), referrer: str(record.referrer, 160), referrer_email: norm(record.referrer_email).slice(0, 200),
    reward: Number(record.reward) || 0, reward_type: record.reward_type === "credit" ? "credit" : "cash", status: "Pending",
  }, track);
  const r = await rest(db, REFERRALS_TABLE(), { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([row]) });
  if (!r.ok) throw new Error("Could not log that referral (" + r.status + ").");
  const saved = (await r.json())[0];
  return { ok: true, row: Number(saved.id) };
}

export async function markReferralPaidPg(id, track, paymentRef, paidOn) {
  const db = need();
  const r = await rest(db, `${REFERRALS_TABLE()}?id=eq.${Number(id)}&track=eq.${trackOnly(track)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "Paid", paid_on: paidOn, payment_ref: str(paymentRef) }) });
  if (!r.ok) throw new Error("Could not mark that paid (" + r.status + ").");
  return { ok: true, updated: (await r.json()).length };
}

export async function updateReferralPg(id, track, fields) {
  const db = need();
  const allowed = ["customer", "customer_email", "customer_phone", "job", "referrer", "referrer_email", "reward", "reward_type", "status", "payment_ref"];
  const patch = {};
  for (const k of allowed) if (fields && fields[k] != null) patch[k] = k === "reward" ? (Number(fields[k]) || 0) : str(fields[k]);
  if (!Object.keys(patch).length) return { ok: true, updated: 0 };
  const r = await rest(db, `${REFERRALS_TABLE()}?id=eq.${Number(id)}&track=eq.${trackOnly(track)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("Could not save that (" + r.status + ").");
  return { ok: true, updated: (await r.json()).length };
}

export async function deleteReferralPg(id, track) {
  const db = need();
  const r = await rest(db, `${REFERRALS_TABLE()}?id=eq.${Number(id)}&track=eq.${trackOnly(track)}`, {
    method: "DELETE", headers: { Prefer: "return=representation" } });
  if (!r.ok) throw new Error("Could not remove that (" + r.status + ").");
  return { ok: true, deleted: (await r.json()).length };
}

/* The key is the primary key, so this upsert has a real conflict target. */
export async function saveTermsPg(terms) {
  const db = need();
  const r = await rest(db, `${KV_TABLE()}?on_conflict=key`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ key: "referral_terms", value: terms, updated_at: new Date().toISOString() }]) });
  if (!r.ok) throw new Error("Could not save the terms (" + r.status + ").");
  return { ok: true, terms };
}

export async function logJobPg(job, track) {
  const db = need();
  const row = stampTrack({
    occurred_at: new Date().toISOString(), business: str(job.customer, 160), lead_email: norm(job.customer_email).slice(0, 200) || null,
    channel: "note", kind: "job", subject: str(job.job), preview: str(job.notes, 500) || null,
    provider: "crm", external_id: "job:" + Date.now(), data: { phone: str(job.customer_phone, 60) },
  }, track);
  const r = await rest(db, ACTIVITIES_TABLE(), { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([row]) });
  if (!r.ok) throw new Error("Could not log that job (" + r.status + ").");
  const saved = (await r.json())[0];
  return { ok: true, row: Number(saved.id) };
}
