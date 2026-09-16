// Templates, saved views and scripts: the small stores that stop you retyping.
//
//   GET    /api/library                 { templates, views, scripts }
//   POST   /api/library?kind=template   { id?, name, subject, body }
//   POST   /api/library?kind=view       { id?, name, filters }
//   POST   /api/library?kind=script     { id?, channel, key?, title, situation, subject, body, sort }
//   DELETE /api/library?kind=view&id=3
//   DELETE /api/library?kind=script&id=3
//
// A script is a piece of writing you reuse: an email template, what to say on
// a cold call, a DM, the shape of a sales call. The built-in ones live in the
// page; a row here with a key overrides the built-in with that key, a row
// without one is the operator's own.
//
// Both are tiny and read on nearly every page load, so they share one endpoint
// rather than costing two round trips.

import { EMAILS } from "./_emails.js";
import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { demoPath } from "./_rows.js";

export const config = { runtime: "edge" };

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
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

const TABLE = { template: "templates", view: "saved_views", script: "scripts" };
const CHANNELS = ["email", "call", "dm", "sales"];
/* What a DM script is for: the run picks by this. Empty means "just a script". */
const USES = ["", "open", "pivot", "bump", "chase", "no", "any", "nosite", "hassite", "facebook", "dated", "follow", "nurture"];

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed. This used to read "if a secret is configured, check it", so
   clearing or mistyping AUTH_SECRET would silently open the endpoint to
   anyone instead of raising an error. */
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  const db = store();
  if (!db) return json({ ok: false, error: "Storage is not configured." }, 503);
  const rest = (path, init) => fetch(db.url + "/rest/v1/" + demoPath(path), {
    ...init, headers: { ...db.headers, ...(init && init.headers) },
    signal: AbortSignal.timeout(8000),
  });

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const table = TABLE[kind];

  /* Which book of business this request belongs to. Reads are narrowed to it,
     and so are saves and deletes by id: all three of these tables are split
     between the two books, so a coach-side request must never reach a local
     row by guessing its number. */
  const track = trackOf(req);
  const only = (path) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

  try {
    if (req.method === "GET") {
      const [t, v, sc] = await Promise.all([
        rest(only("templates?select=*&order=id.asc")),
        rest(only("saved_views?select=*&order=id.asc")),
        rest(only("scripts?select=*&order=sort.asc,id.asc")),
      ]);
      return json({
        ok: true,
        templates: t.ok ? await t.json() : [],
        views: v.ok ? await v.json() : [],
        scripts: sc.ok ? await sc.json() : [],
        /* The built-in emails, so the page shows exactly what the sender sends. */
        builtin_emails: EMAILS,
      });
    }

    if (!table) return json({ ok: false, error: "Unknown kind." }, 400);

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Which one?" }, 400);
      const res = await rest(only(`${table}?id=eq.${encodeURIComponent(id)}`), { method: "DELETE" });
      if (!res.ok) return json({ ok: false, error: "Could not delete." }, 502);
      return json({ ok: true });
    }

    if (req.method !== "POST") return json({ ok: false, error: "GET, POST or DELETE." }, 405);
    const body = await req.json().catch(() => ({}));

    if (kind === "script") {
      const channel = CHANNELS.includes(body.channel) ? body.channel : "";
      const title = String(body.title || "").trim().slice(0, 120);
      const text = String(body.body || "").trim().slice(0, 8000);
      const key = String(body.key || "").trim().slice(0, 60) || null;
      if (!channel) return json({ ok: false, error: "Which channel is this script for?" }, 400);
      if (!title) return json({ ok: false, error: "A script needs a title." }, 400);
      /* A built-in script's row may carry only a favourite or a use, with no
         words of its own: the page then keeps the built-in wording. */
      if (!text && !key) return json({ ok: false, error: "A script needs some words in it." }, 400);
      const row = {
        channel,
        key,
        title,
        situation: String(body.situation || "").trim().slice(0, 200),
        subject: String(body.subject || "").trim().slice(0, 200),
        body: text,
        sort: Number.isFinite(+body.sort) ? +body.sort : 100,
        use: USES.includes(body.use) ? body.use : "",
        favourite: !!body.favourite,
        updated_at: new Date().toISOString(),
      };
      if (body.id) {
        const res = await rest(only(`scripts?id=eq.${parseInt(body.id, 10)}`), {
          method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row),
        });
        if (!res.ok) return json({ ok: false, error: "Could not save that script." }, 502);
        return json({ ok: true, saved: (await res.json())[0] });
      }
      const res = await rest("scripts", {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([stampTrack(row, track)]),
      });
      if (!res.ok) return json({ ok: false, error: "Could not save that script." }, 502);
      return json({ ok: true, saved: (await res.json())[0] });
    }

    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return json({ ok: false, error: "It needs a name." }, 400);

    const row = kind === "template"
      ? {
          name,
          subject: String(body.subject || "").trim().slice(0, 200),
          body: String(body.body || "").trim().slice(0, 5000),
        }
      : { name, filters: body.filters && typeof body.filters === "object" ? body.filters : {} };

    if (kind === "template" && (!row.subject || !row.body)) {
      return json({ ok: false, error: "A template needs a subject and a body." }, 400);
    }

    if (body.id) {
      const res = await rest(only(`${table}?id=eq.${parseInt(body.id, 10)}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (!res.ok) return json({ ok: false, error: "Could not save." }, 502);
      return json({ ok: true, saved: (await res.json())[0] });
    }
    const res = await rest(table, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([stampTrack(row, track)]),
    });
    if (!res.ok) return json({ ok: false, error: "Could not save." }, 502);
    return json({ ok: true, saved: (await res.json())[0] });
  } catch (err) {
    return json({ ok: false, error: "Storage did not answer." }, 502);
  }
}
