// GET  /api/log            the last 24 hours of failures, count and latest
// POST /api/log            { place, message, detail }  from the page, or from
//                          Make with the CRM's API key
//
// Same two keys as /api/activity: the one Settings stores and rotates, and the
// ACTIVITY_SECRET environment variable. Either is enough, so a deployment that
// has never opened Settings keeps working on its variable alone.
import { isAuthed } from "./_auth.js";
import { logFailure, recentFailures } from "./_log.js";
import { readApiKey } from "./_profile.js";

export const config = { runtime: "edge" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Constant time: walks the longer of the two whatever their lengths.
function sameSecret(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a.length) return false;
  const n = Math.max(a.length, b.length);
  let d = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export default async function handler(req) {
  const given = req.headers.get("x-activity-secret") || "";
  /* Read only when a caller presented a key, so the page's own failure reports
     do not each pay a read of the profile row. */
  const stored = given ? await readApiKey() : "";
  const envSecret = (process.env.ACTIVITY_SECRET || "").trim();
  /* Both compares run either way: || between them would skip the second as soon
     as the first matched, and the time taken must not say which key was right.
     Each is guarded by its own key being set, because a key nobody configured
     has to authenticate nobody. */
  const byStored = !!stored && sameSecret(given, stored);
  const byEnv = !!envSecret && sameSecret(given, envSecret);
  const bySecret = byStored || byEnv;
  if (!bySecret && !(await isAuthed(req))) return json({ ok: false, login: true }, 401);
  if (req.method === "GET") {
    try { return json({ ok: true, ...(await recentFailures(24)) }); }
    catch (e) { return json({ ok: false, error: e.message }, 502); }
  }
  if (req.method !== "POST") return json({ ok: false, error: "GET or POST." }, 405);
  const body = await req.json().catch(() => null);
  if (!body || !body.message) return json({ ok: false, error: "Say what failed." }, 400);
  const saved = await logFailure(body.place || "page", body.message, body.detail);
  return json({ ok: saved }, saved ? 200 : 502);
}
