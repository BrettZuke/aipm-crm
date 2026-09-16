// Two things every store reader needs.
//
// demoPath: the demo keeps its own copy of every table it can write to, named
// <table>_demo, so nothing done in the demo can touch the real CRM's data. A
// reader passes its normal PostgREST path through here and gets the demo's
// table on the demo, the real one otherwise.
//
// fetchRows: the API answers at most a page of rows however large the limit
// asked for (Supabase's default page is a thousand), so a reader that asked
// for five thousand and got a thousand had no way to know rows were missing.
// This reads page after page until a short one, and says whether it stopped
// early, so the caller can show that rather than silently lose history.
import { isDemo } from "./_demo.js";

const ISOLATED = ["sequences", "sequence_runs", "tasks", "templates", "saved_views", "found_leads", "sites", "emails", "email_events", "activities", "deals", "profile", "lead_edits", "referrals", "scripts", "coach_leads", "failures"];

export function demoPath(path) {
  if (!isDemo()) return path;
  const m = /^([a-z_]+)(?=[?/]|$)/.exec(path);
  if (!m || !ISOLATED.includes(m[1]) || m[1].endsWith("_demo")) return path;
  return m[1] + "_demo" + path.slice(m[1].length);
}

export async function fetchRows(db, path, opts = {}) {
  const pageSize = opts.pageSize || 1000;
  const max = opts.max || 20000;
  const timeout = opts.timeout || 6000;
  const url = db.url + "/rest/v1/" + demoPath(path);
  const page = async (from, to, count) => {
    const r = await fetch(url, {
      headers: { ...db.headers, Range: `${from}-${to}`, "Range-Unit": "items", ...(count ? { Prefer: "count=exact" } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok && r.status !== 416) throw new Error("Could not read " + path.split("?")[0] + " (" + r.status + ").");
    const rows = r.status === 416 ? [] : await r.json();
    const total = count ? parseInt(String(r.headers.get("content-range") || "").split("/")[1], 10) : NaN;
    return { rows, total };
  };
  /* The first page asks how many rows there are in all, so the rest can be
     read side by side instead of one after another: eight thousand leads
     used to be eight round trips in a row, and that was most of the wait. */
  const firstTo = Math.min(pageSize, max) - 1;
  const first = await page(0, firstTo, true);
  const rows = first.rows.slice();
  if (first.rows.length < firstTo + 1) return { rows, truncated: false };
  if (Number.isFinite(first.total)) {
    const want = Math.min(first.total, max);
    const starts = [];
    for (let from = pageSize; from < want; from += pageSize) starts.push(from);
    const rest = await Promise.all(starts.map((from) => page(from, Math.min(from + pageSize, max) - 1, false)));
    for (const p of rest) for (const row of p.rows) rows.push(row);
    return { rows, truncated: first.total > max };
  }
  /* No count came back: read on page by page until a short one. */
  for (let from = pageSize; from < max; from += pageSize) {
    const to = Math.min(from + pageSize, max) - 1;
    const p = await page(from, to, false);
    for (const row of p.rows) rows.push(row);
    if (p.rows.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
