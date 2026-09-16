// The failure log: one row for anything that went wrong that a person would
// want to know about (a sheet write that did not take, a send that failed, a
// request the page could not complete). Today shows the last day of them, so
// a quiet failure is seen the same morning instead of months later.
import { demoPath } from "./_rows.js";

function store() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

// Never throws and never waits long: logging a failure must not add one.
export async function logFailure(place, message, detail) {
  const db = store();
  if (!db) return false;
  try {
    const r = await fetch(db.url + "/rest/v1/" + demoPath("failures"), {
      method: "POST",
      headers: { ...db.headers, Prefer: "return=minimal" },
      body: JSON.stringify([{ place: String(place || "unknown").slice(0, 80), message: String(message || "").slice(0, 500), detail: detail && typeof detail === "object" ? detail : null }]),
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function recentFailures(hours) {
  const db = store();
  if (!db) return { count: 0, items: [] };
  const since = new Date(Date.now() - (hours || 24) * 3600 * 1000).toISOString();
  const r = await fetch(db.url + "/rest/v1/" + demoPath(`failures?occurred_at=gte.${encodeURIComponent(since)}&order=occurred_at.desc&select=id,occurred_at,place,message`), {
    headers: { ...db.headers, Prefer: "count=exact", Range: "0-49", "Range-Unit": "items" },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok && r.status !== 416) throw new Error("Could not read the failure log.");
  const items = r.status === 416 ? [] : await r.json();
  const range = r.headers.get("content-range") || "";
  const total = parseInt(range.split("/")[1], 10);
  return { count: Number.isFinite(total) ? total : items.length, items };
}
