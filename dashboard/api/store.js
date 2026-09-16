// The CRM's reads of our own store, done server side.
//
//   GET /api/store?q=found_codes    business, city and lead code for every lead
//   GET /api/store?q=found_recent   the last 100 found-and-built leads, in full
//   GET /api/store?q=emails         the last 200 sent emails
//   GET /api/store?q=email_events   delivery, open and click events
//   GET /api/store?q=site_slugs     slug and business for every built site
//
// These used to run straight from the browser using the project's anon key,
// which meant the key sat in the page source of a page anyone can load. That
// key could read every lead's phone and email, and the full text of every email
// we had sent. Moving the reads here lets the store refuse the public key
// outright: the service role key stays on the server and never ships to a
// browser.
//
// The query is picked from a fixed list rather than passed in. Accepting a
// table name or a filter from the caller would hand back the same open door
// through a different opening.

import { isAuthed } from "./_auth.js";
import { trackOf, rowPath } from "./_track.js";

export const config = { runtime: "edge" };

const QUERIES = {
  found_codes:  "found_leads?select=business,city,lead_code&limit=1000",
  found_recent: "found_leads?select=*&order=found_at.desc&limit=100",
  emails:       "emails?select=*&order=sent_at.desc&limit=200",
  email_events: "email_events?select=provider_id,event,sending_domain,occurred_at&limit=5000",
  site_slugs:   "sites?select=slug,business&limit=2000",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed. This used to read "if a secret is configured, check it", so
   clearing or mistyping AUTH_SECRET would silently open the endpoint to
   anyone instead of raising an error. */
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  if (req.method !== "GET") return json({ ok: false, error: "GET only." }, 405);

  const path = QUERIES[new URL(req.url).searchParams.get("q") || ""];
  if (!path) return json({ ok: false, error: "Unknown query." }, 400);

  /* rowPath narrows the emails, events and sites reads to one book of
     business. found_leads is the local builder's own store and is not split,
     so it passes through untouched. */
  const track = trackOf(req);

  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return json({ ok: false, error: "Storage is not configured." }, 503);

  try {
    const res = await fetch(url + "/rest/v1/" + rowPath(path, track), {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return json({ ok: false, error: "The store did not answer." }, 502);
    /* Callers replaced a direct database call that returned a bare array, so
       this returns one too and they keep their existing shape. */
    return new Response(JSON.stringify(await res.json()), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    return json({ ok: false, error: "The store did not answer." }, 502);
  }
}
