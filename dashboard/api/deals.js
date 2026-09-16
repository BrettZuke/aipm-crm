// Deals: the money the CRM was missing.
//
//   GET    /api/deals            every deal, plus the totals the results panel shows
//   POST   /api/deals            { business, amount, currency, closed_on, source, email, lead_row, notes }
//   PATCH  /api/deals            { id, ...fields }
//   DELETE /api/deals?id=12      remove one
//
// Why its own table and not a column on the leads sheet: a deal has its own
// close date (the sheet only tracks last-touch), one lead can close more than
// once, and the sheet is slow from cold. The leads sheet keeps owning "where is
// this lead up to"; this owns "what did we actually collect".
//
// Every figure the results panel prints comes from rows in here. Nothing is
// estimated, seeded or assumed: an empty table reads as zero, which is the
// honest answer until deals are logged.

import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { demoFunnel } from "./_demo.js";

export const config = { runtime: "edge" };

/* Which table this deployment's deals live in.
   The demo CRM and the real one run the same code against the same database,
   so the ONLY thing keeping seeded demo figures out of real revenue is this
   name. It is an allow list rather than free text: an env var that reached the
   URL unchecked would be an injection hole, and a typo would silently create a
   third set of books nobody is reading. */
const DEAL_TABLES = { deals: "deals", deals_demo: "deals_demo" };
const DEALS_TABLE = DEAL_TABLES[(process.env.DEALS_TABLE || "").trim()] || "deals";
const IS_DEMO = DEALS_TABLE === "deals_demo";

const SOURCES = ["email", "call", "dm", "referral", "other"];
const CURRENCIES = ["GBP", "USD", "EUR"];
const DAY = 86400000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function store() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

function isDay(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}

/** Money in, grouped every way the panel needs it. All from real rows. */
export function summarise(deals) {
  const now = Date.now();
  const dayAgo = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const last7 = dayAgo(7);
  const last30 = dayAgo(30);

  const byCurrency = {};
  const bySource = {};
  const weeks = {};
  let count = 0;
  let mrr = 0;

  for (const d of deals) {
    const cur = CURRENCIES.includes(d.currency) ? d.currency : "GBP";
    const amt = Number(d.amount) || 0;
    const day = String(d.closed_on || "").slice(0, 10);
    count += 1;

    mrr += Number(d.mrr) || 0;

    const c = (byCurrency[cur] ||= { currency: cur, total: 0, last7: 0, last30: 0, count: 0 });
    c.total += amt;
    c.count += 1;
    if (day >= last7) c.last7 += amt;
    if (day >= last30) c.last30 += amt;

    const src = SOURCES.includes(d.source) ? d.source : "other";
    const s = (bySource[src] ||= { source: src, total: 0, count: 0 });
    s.total += amt;
    s.count += 1;

    // Bucket by the Monday of the deal's week, so "per week" is a real week.
    if (isDay(day)) {
      const dt = new Date(day + "T00:00:00Z");
      const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
      const monday = new Date(dt.getTime() - dow * DAY).toISOString().slice(0, 10);
      const w = (weeks[monday] ||= { week: monday, total: 0, count: 0 });
      w.total += amt;
      w.count += 1;
    }
  }

  const currencies = Object.values(byCurrency).sort((a, b) => b.total - a.total);
  const main = currencies[0] || null;

  return {
    count,
    currencies,
    // The headline: whichever currency most money came in, so the panel never
    // adds two currencies together and prints a number that means nothing.
    headline: main
      ? {
          currency: main.currency,
          total: Math.round(main.total * 100) / 100,
          last7: Math.round(main.last7 * 100) / 100,
          last30: Math.round(main.last30 * 100) / 100,
          average: main.count ? Math.round((main.total / main.count) * 100) / 100 : 0,
          count: main.count,
        }
      : { currency: "GBP", total: 0, last7: 0, last30: 0, average: 0, count: 0 },
    mixed_currency: currencies.length > 1,
    mrr: Math.round(mrr * 100) / 100,
    by_source: Object.values(bySource).sort((a, b) => b.total - a.total),
    weeks: Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)).slice(-12),
  };
}

/* Roll a demo's dates forward so it always reads as the current week.
   The seeded closing dates are fixed, so "collected this week" slid down every
   day that passed. A demo is opened whenever somebody is shown it, not on the
   day it was built, so the whole set is shifted by the gap between its newest
   deal and today. Nothing is written back; only the returned copy moves. */
function rollDemoDates(deals, tzOffsetMin) {
  if (!deals.length) return deals;
  const DAY = 86400000;
  const newest = deals.reduce((max, d) => {
    const t = Date.parse(String(d.closed_on || "") + "T00:00:00Z");
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, 0);
  if (!newest) return deals;
  /* "Today" is the viewer's date. Rolling to the server's UTC date put
     tomorrow's date on the newest deal for anyone west of Greenwich in the
     evening, and the browser then counted a ten-deal week against a nine-deal
     month. The page sends its timezone offset; the roll lands on that day. */
  const shiftMs = (Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0) * 60000;
  const today = Date.parse(new Date(Date.now() - shiftMs).toISOString().slice(0, 10) + "T00:00:00Z");
  const shift = Math.round((today - newest) / DAY);
  if (shift <= 0) return deals;
  return deals.map((d) => {
    const t = Date.parse(String(d.closed_on || "") + "T00:00:00Z");
    if (Number.isNaN(t)) return d;
    return { ...d, closed_on: new Date(t + shift * DAY).toISOString().slice(0, 10) };
  });
}

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  // Fail closed: a cleared or mistyped AUTH_SECRET must lock the endpoint, not open it.
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  const db = store();
  if (!db) return json({ ok: false, error: "Deal storage is not configured." }, 503);

  const url = new URL(req.url);
  const rest = (path, init) =>
    fetch(db.url + "/rest/v1/" + path, {
      ...init,
      headers: { ...db.headers, ...(init && init.headers) },
      signal: AbortSignal.timeout(8000),
    });

  /* Which book of business this request belongs to. Reads are narrowed to it,
     and so are edits and deletes by id: without that, a coach-side request
     could reach a local deal by guessing its number, which is exactly the
     leak the two books exist to prevent. */
  const track = trackOf(req);
  const only = (path) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

  try {
    if (req.method === "GET") {
      const res = await rest(only(`${DEALS_TABLE}?order=closed_on.desc,id.desc&limit=1000`));
      if (!res.ok) return json({ ok: false, error: "Could not read deals." }, 502);
      let deals = await res.json();
      /* The demo story (rolled dates, the funnel behind the money) belongs
         to the local book. A coach deal is a real row somebody logged, so
         its date must not be rolled, and the local funnel must not be
         stapled to a coach screen: that is how Results read "1,648 emails,
         8% reply" against zero coaches. */
      const demoStory = IS_DEMO && track !== "coach";
      if (demoStory) deals = rollDemoDates(deals, parseInt(url.searchParams.get("tz") || "0", 10));
      const summary = summarise(deals);
      const body = { ok: true, demo: IS_DEMO, deals, summary };
      if (demoStory) {
        const by = { email: 0, call: 0, dm: 0, referral: 0 };
        for (const d of deals) { const s = String(d.source || "email").toLowerCase(); by[s in by ? s : "email"] += 1; }
        body.funnel = demoFunnel({ count: summary.headline.count, by_source: by });
      }
      return json(body);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return json({ ok: false, error: "Bad request." }, 400);

      const business = String(body.business || "").trim().slice(0, 160);
      const amount = Number(body.amount);
      if (!business) return json({ ok: false, error: "A deal needs a business name." }, 400);
      if (!Number.isFinite(amount) || amount < 0) {
        return json({ ok: false, error: "A deal needs an amount." }, 400);
      }
      const closed = isDay(body.closed_on) ? body.closed_on : new Date().toISOString().slice(0, 10);

      const row = {
        business,
        amount: Math.round(amount * 100) / 100,
        currency: CURRENCIES.includes(body.currency) ? body.currency : "GBP",
        closed_on: closed,
        source: SOURCES.includes(body.source) ? body.source : "email",
        email: String(body.email || "").trim().slice(0, 200) || null,
        lead_row: Number.isFinite(+body.lead_row) ? +body.lead_row : null,
        notes: String(body.notes || "").trim().slice(0, 500) || null,
        phone: String(body.phone || "").trim().slice(0, 60) || null,
        mrr: Number.isFinite(+body.mrr) && +body.mrr >= 0 ? Math.round(+body.mrr * 100) / 100 : 0,
      };
      const res = await rest(DEALS_TABLE, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([stampTrack(row, track)]),
      });
      if (!res.ok) return json({ ok: false, error: "Could not save that deal." }, 502);
      const saved = await res.json();
      return json({ ok: true, deal: saved[0] });
    }

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => null);
      if (!body || !body.id) return json({ ok: false, error: "Which deal?" }, 400);

      const patch = {};
      if (body.business !== undefined) {
        const b = String(body.business).trim().slice(0, 160);
        if (!b) return json({ ok: false, error: "A deal needs a business name." }, 400);
        patch.business = b;
      }
      if (body.amount !== undefined) {
        const a = Number(body.amount);
        if (!Number.isFinite(a) || a < 0) return json({ ok: false, error: "That is not an amount." }, 400);
        patch.amount = Math.round(a * 100) / 100;
      }
      if (body.closed_on !== undefined) {
        if (!isDay(body.closed_on)) return json({ ok: false, error: "That is not a day." }, 400);
        patch.closed_on = body.closed_on;
      }
      if (body.mrr !== undefined) {
        const m = Number(body.mrr);
        if (!Number.isFinite(m) || m < 0) return json({ ok: false, error: "Monthly has to be a number." }, 400);
        patch.mrr = Math.round(m * 100) / 100;
      }
      if (body.currency !== undefined && CURRENCIES.includes(body.currency)) patch.currency = body.currency;
      if (body.source !== undefined && SOURCES.includes(body.source)) patch.source = body.source;
      if (body.notes !== undefined) patch.notes = String(body.notes).trim().slice(0, 500) || null;
      if (body.phone !== undefined) patch.phone = String(body.phone).trim().slice(0, 60) || null;
      if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to change." }, 400);

      const res = await rest(only(`${DEALS_TABLE}?id=eq.${encodeURIComponent(body.id)}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return json({ ok: false, error: "Could not update that deal." }, 502);
      const saved = await res.json();
      return json({ ok: true, deal: saved[0] });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Which deal?" }, 400);
      const res = await rest(only(`${DEALS_TABLE}?id=eq.${encodeURIComponent(id)}`), { method: "DELETE" });
      if (!res.ok) return json({ ok: false, error: "Could not delete that deal." }, 502);
      return json({ ok: true });
    }

    return json({ ok: false, error: "GET, POST, PATCH or DELETE." }, 405);
  } catch (err) {
    return json({ ok: false, error: "Deal storage did not answer." }, 502);
  }
}
