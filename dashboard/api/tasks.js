// Tasks: the thing that stops a lead being forgotten.
//
//   GET    /api/tasks              every open task, plus what was done today
//   GET    /api/tasks?lead=214     just that lead's tasks
//   POST   /api/tasks              { lead_row, business, title, kind, due_on, note }
//   PATCH  /api/tasks              { id, done } or { id, due_on, title, note, kind }
//   DELETE /api/tasks?id=12        remove one
//
// Tasks live in our own store rather than the Google Sheet. The sheet is slow
// from cold and this is the surface you open first thing every morning: it has
// to answer instantly or you stop trusting it. Nothing here touches the sheet,
// so a task can never be lost to an Apps Script timeout.
//
// Dates are plain dates, not timestamps. "Ring them back Thursday" does not
// mean 09:00 Thursday, and storing a time would make the list wrong for anyone
// in another timezone.
//
// The demo keeps its own table, tasks_demo, so a task added in the demo is still
// there after a reload, and a handful of derived tasks (ids from 900000) give
// the day some shape before anything has been added. Those derived ones can be
// ticked or moved on screen but are not stored.

import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { isDemo } from "./_demo.js";
import { fetchRows } from "./_rows.js";

export const config = { runtime: "edge" };

const KINDS = ["call", "email", "follow_up", "build", "other"];
const DERIVED_FROM = 900000;

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

/** Today where the person using this is, not where the server happens to run. */
function todayISO(offsetMinutes) {
  const shift = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  const now = new Date(Date.now() - shift * 60000);
  return now.toISOString().slice(0, 10);
}

function counts(tasks, today) {
  const open = tasks.filter((t) => !t.done);
  return {
    overdue: open.filter((t) => t.due_on < today).length,
    today: open.filter((t) => t.due_on === today).length,
    upcoming: open.filter((t) => t.due_on > today).length,
  };
}

/* The demo's derived tasks used to be built here, by taking the day's shape
   and stapling it onto whatever businesses came back from deals_demo. Those
   are the WON deals, so the board said "send the proposal they asked for"
   against a business that had already paid, and the Today tab contradicted the
   customer list. They are derived on the page now, off each lead's real stage,
   where the lead list is already in memory and cannot disagree with itself.
   See demoTasksFromLeads() in crm-close.html. */

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed. This used to read "if a secret is configured, check it", so
   clearing or mistyping AUTH_SECRET would silently open the endpoint to
   anyone instead of raising an error. */
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  const db = store();
  if (!db) return json({ ok: false, error: "Task storage is not configured." }, 503);

  const demo = isDemo();
  const table = demo ? "tasks_demo" : "tasks";
  const url = new URL(req.url);
  const rest = (path, init) => fetch(db.url + "/rest/v1/" + path, {
    ...init,
    headers: { ...db.headers, ...(init && init.headers) },
    signal: AbortSignal.timeout(8000),
  });

  /* Which book of business this request belongs to. Reads are narrowed to it,
     and so are edits and deletes by id: without that, a coach-side request
     could reach a local task by guessing its number. */
  const track = trackOf(req);
  const only = (path) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

  try {
    /* ------------------------------------------------------------- read */
    if (req.method === "GET") {
      const lead = url.searchParams.get("lead");
      if (lead) {
        const res = await rest(only(`${table}?lead_row=eq.${encodeURIComponent(lead)}&order=done.asc,due_on.asc`));
        if (!res.ok) return json({ ok: false, error: "Could not read tasks." }, 502);
        return json({ ok: true, tasks: await res.json() });
      }

      /* Everything still open, plus the last two weeks of finished ones, so
         ticking one off does not make it vanish before you have registered
         that it happened and the Done view has a fortnight to look back on. */
      const offset = parseInt(url.searchParams.get("tz") || "0", 10);
      const today = todayISO(offset);
      const since = new Date(Date.parse(today + "T00:00:00Z") - 14 * 86400000).toISOString().slice(0, 10);
      const got = await fetchRows(db, only(
        `${table}?or=(done.is.false,and(done.is.true,done_at.gte.${since}T00:00:00Z))` +
        `&order=due_on.asc,id.asc`), { max: 5000, timeout: 8000 });
      let tasks = got.rows;


      /* Grouped here rather than in the browser so every surface that asks
         gets the same answer to "what is overdue". */
      return json({ ok: true, today, demo, tasks, counts: counts(tasks, today) });
    }

    /* ------------------------------------------------------------ create */
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return json({ ok: false, error: "Bad request." }, 400);

      const title = String(body.title || "").trim().slice(0, 200);
      const due = String(body.due_on || "").trim();
      if (!title) return json({ ok: false, error: "A task needs a title." }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        return json({ ok: false, error: "A task needs a day." }, 400);
      }

      const row = {
        lead_row: Number.isFinite(+body.lead_row) ? +body.lead_row : null,
        business: String(body.business || "").trim().slice(0, 160) || "(no business)",
        title,
        kind: KINDS.includes(body.kind) ? body.kind : "follow_up",
        due_on: due,
        note: String(body.note || "").trim().slice(0, 500) || null,
      };
      const res = await rest(table, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([stampTrack(row, track)]),
      });
      if (!res.ok) {
        return json({ ok: false, error: "Could not save that task." }, 502);
      }
      const saved = await res.json();
      return json({ ok: true, task: saved[0] });
    }

    /* ------------------------------------------- complete, move or reword */
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => null);
      if (!body || !body.id) return json({ ok: false, error: "Which task?" }, 400);

      const patch = {};
      if (typeof body.done === "boolean") {
        patch.done = body.done;
        patch.done_at = body.done ? new Date().toISOString() : null;
      }
      if (body.due_on) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.due_on))) {
          return json({ ok: false, error: "That is not a day." }, 400);
        }
        patch.due_on = body.due_on;
      }
      if (typeof body.title === "string" && body.title.trim()) {
        patch.title = body.title.trim().slice(0, 200);
      }
      if (typeof body.note === "string") patch.note = body.note.trim().slice(0, 500) || null;
      if (KINDS.includes(body.kind)) patch.kind = body.kind;
      if (!Object.keys(patch).length) return json({ ok: false, error: "Nothing to change." }, 400);

      /* A derived demo task is not stored, so the change is answered, not kept. */
      if (demo && Number(body.id) >= DERIVED_FROM) {
        return json({ ok: true, demo: true, task: { id: Number(body.id), ...patch } });
      }
      const res = await rest(only(`${table}?id=eq.${encodeURIComponent(body.id)}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return json({ ok: false, error: "Could not update that task." }, 502);
      const saved = await res.json();
      return json({ ok: true, task: saved[0] });
    }

    /* ------------------------------------------------------------ delete */
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ ok: false, error: "Which task?" }, 400);
      if (demo && Number(id) >= DERIVED_FROM) return json({ ok: true, demo: true });
      const res = await rest(only(`${table}?id=eq.${encodeURIComponent(id)}`), { method: "DELETE" });
      if (!res.ok) return json({ ok: false, error: "Could not delete that task." }, 502);
      return json({ ok: true });
    }

    return json({ ok: false, error: "GET, POST, PATCH or DELETE." }, 405);
  } catch (err) {
    return json({ ok: false, error: "Task storage did not answer." }, 502);
  }
}
