// The activity log: every touch on a lead, from any channel, in one place.
//
//   POST /api/activity     header x-activity-secret: <the key from Settings>  (Make, Twilio, anything outside)
//   POST /api/activity     signed-in session cookie                        (the page itself: calls, DMs, notes)
//        { email?, lead_row?, business?, channel, kind?, step?, subject?, preview?, provider?, external_id?, occurred_at?, data? }
//   GET  /api/activity?email=..   or ?lead=<row>     -> that lead's activity, newest first
//
// Why this exists. Resend sends were already tracked, joined onto a lead by
// address. Nothing else was: an email sent by a Make scenario's Gmail node,
// a call from the power dialler, a DM on Instagram, a text. "This one got
// email 1, that one got email 2" was only answerable for one channel. Now
// every channel posts here, and the lead's timeline reads it back.
//
// The outside key and the session cookie are both accepted, and either is
// enough. A Make scenario has no cookie; the page has no key. A row that
// carries a provider and external id is written once and ignored on a repeat,
// so a retried webhook cannot double-log.
//
// There are two keys an outside caller may present: the one Settings stores and
// rotates, and the ACTIVITY_SECRET environment variable this endpoint has always
// taken. Either authenticates. A deployment that has never opened Settings keeps
// working on its variable alone, and one that has rotated does not have to go
// back to Vercel to make the new key count.

import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { isDemo } from "./_demo.js";
import { readApiKey } from "./_profile.js";

export const config = { runtime: "edge" };

const CHANNELS = ["email", "call", "dm", "sms", "note", "status", "proposal", "payment", "click"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store",
               "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type, x-activity-secret",
               "access-control-allow-methods": "GET, POST, OPTIONS" },
  });
}

// Walks the longer of the two either way, so the time taken says nothing
// about where the two first differ, or how long the secret is.
function timingSafeEqual(a, b) {
  a = String(a == null ? "" : a); b = String(b == null ? "" : b);
  const n = Math.max(a.length, b.length);
  let d = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function store() {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: json({}).headers });
  const given = req.headers.get("x-activity-secret") || "";
  /* The key Settings rotated, read on every call rather than remembered, so a
     rotation stops the old key on the next request instead of whenever an
     instance happens to recycle. Only worth the round trip when a caller has
     actually presented a key: the page authenticates with its cookie and would
     otherwise pay a read of the profile row for every note it logs. Skipping it
     decides nothing, because an empty header matches neither candidate. */
  const stored = given ? await readApiKey() : "";
  const envSecret = (process.env.ACTIVITY_SECRET || "").trim();
  /* Both compares run whatever the first one answers. Chaining them with ||
     would skip the second as soon as the first matched, and how long this takes
     must not depend on WHICH of the two keys a caller got right. Each is guarded
     by its own key being set, because timingSafeEqual("", "") is a match: a key
     nobody configured has to authenticate nobody. */
  const byStored = !!stored && timingSafeEqual(given, stored);
  const byEnv = !!envSecret && timingSafeEqual(given, envSecret);
  const bySecret = byStored || byEnv;
  const bySession = await isAuthed(req);
  if (!bySecret && !bySession) return json({ ok: false, error: "not allowed", login: !stored && !envSecret }, 401);

  const db = store();
  if (!db) return json({ ok: false, error: "Activity storage is not configured." }, 503);
  const table = isDemo() ? "activities_demo" : "activities";
  const rest = (path, init) => fetch(db.url + "/rest/v1/" + path, { ...init, headers: { ...db.headers, ...(init && init.headers) }, signal: AbortSignal.timeout(8000) });
  const url = new URL(req.url);

  /* Which book of business this belongs to. Both ways in carry it in the URL:
     the page appends it, an outside caller posting with the secret has to as
     well, or its row lands in the local book. */
  const track = trackOf(req);
  const only = (path) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

  if (req.method === "GET") {
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    const lead = parseInt(url.searchParams.get("lead") || "0", 10);
    let q = table + "?order=occurred_at.desc&limit=200&";
    /* ilike treats % and _ as wildcards, so an address of "%" would return
       the whole book rather than one lead's history. They cannot appear in a
       real address, so they come out. */
    if (email) q += "lead_email=ilike." + encodeURIComponent(email.replace(/[%_]/g, ""));
    else if (lead) q += "lead_row=eq." + lead;
    else return json({ ok: false, error: "Which lead? Pass email or lead." }, 400);
    const r = await rest(only(q));
    if (!r.ok) return json({ ok: false, error: "Could not read activity." }, 502);
    return json({ ok: true, activity: await r.json() });
  }

  if (req.method !== "POST") return json({ ok: false, error: "GET or POST." }, 405);
  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request." }, 400);
  const channel = String(body.channel || "").trim().toLowerCase();
  if (!CHANNELS.includes(channel)) return json({ ok: false, error: "channel must be one of " + CHANNELS.join(", ") }, 400);
  const email = String(body.email || body.lead_email || body.to || "").trim().toLowerCase() || null;
  const leadRow = Number.isFinite(+body.lead_row) && +body.lead_row > 0 ? +body.lead_row : null;
  if (!email && !leadRow) return json({ ok: false, error: "Say who: email or lead_row." }, 400);
  const when = body.occurred_at ? new Date(body.occurred_at) : new Date();
  if (isNaN(when.getTime())) return json({ ok: false, error: "occurred_at is not a date." }, 400);

  const row = {
    occurred_at: when.toISOString(),
    lead_row: leadRow, lead_email: email,
    business: String(body.business || "").trim().slice(0, 160) || null,
    channel,
    kind: String(body.kind || "").trim().slice(0, 60) || null,
    step: Number.isFinite(+body.step) ? +body.step : null,
    subject: String(body.subject || "").trim().slice(0, 200) || null,
    preview: String(body.preview || body.body || "").trim().slice(0, 300) || null,
    provider: String(body.provider || (bySecret ? "webhook" : "crm")).trim().slice(0, 40),
    external_id: String(body.external_id || body.id || "").trim().slice(0, 120) || null,
    source: String(body.source || "").trim().slice(0, 80) || null,
    done_by: String(body.done_by || "").trim().slice(0, 80) || null,
    data: body.data && typeof body.data === "object" ? body.data : null,
  };
  /* ignore-duplicates makes a retried webhook a no-op. The columns here must
     be exactly the ones in the unique index, which is (provider, external_id,
     track) since the second book of business arrived: name two of the three
     and Postgres matches no constraint and rejects the insert outright. */
  const r = await rest(table + "?on_conflict=provider,external_id,track", {
    method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" }, body: JSON.stringify([stampTrack(row, track)]),
  });
  if (!r.ok) return json({ ok: false, error: "Could not log that activity (" + r.status + ")." }, 502);
  const saved = await r.json();
  return json({ ok: true, activity: saved[0] || row, duplicate: !saved.length });
}
