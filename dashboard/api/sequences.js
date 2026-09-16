// Sequences: a follow-up that runs itself.
//
// One email is a coin toss. The businesses that reply usually reply to the
// third or fourth touch, and nobody remembers to send those by hand. A
// sequence is a list of steps with a day offset:
//
//   [ { day: 0, kind: "email",  template: 12 },
//     { day: 3, kind: "task",   title: "Ring them, did they open it" },
//     { day: 7, kind: "email",  template: 13 },
//     { day: 12, kind: "task",  title: "Last try, then park it" } ]
//
// Enrolling a lead creates a run. A tick advances every run whose next step is
// due: an email step sends, a task step lands in the Tasks tab. The tick is
// idempotent per day, so running it twice cannot double-send.
//
//   GET    /api/sequences                 sequences + how many are enrolled
//   GET    /api/sequences?runs=1          every run, for the dashboard
//   GET    /api/sequences?lead=214        that lead's runs
//   POST   /api/sequences  {name, steps}  create or update a sequence
//   POST   /api/sequences?enroll=1        {sequence_id, leads:[{row,business,email,phone,slug}]}
//   POST   /api/sequences?stop=1          {run_id, reason}
//   POST   /api/sequences?tick=1          advance everything due (cron + on load)
//
// A run stops the moment a lead replies or is marked Won or Lost. Chasing
// somebody who already answered is the fastest way to lose them.

import { isAuthed, timingSafeEqual } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { loadProfile } from "./_profile.js";
import { isDemo, demoFunnel, demoCustomerMix } from "./_demo.js";
import { demoPath } from "./_rows.js";
import { loadSendingPipe, sendViaMake, textToHtml, gmailAllowance } from "./_sending.js";

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

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Steps are user input, so they are checked rather than trusted. */
function cleanSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({
      day: Math.max(0, Math.min(120, parseInt(s.day, 10) || 0)),
      kind: s.kind === "email" ? "email" : "task",
      title: String(s.title || "").trim().slice(0, 200),
      subject: String(s.subject || "").trim().slice(0, 200),
      body: String(s.body || "").trim().slice(0, 5000),
    }))
    .filter((s) => (s.kind === "email" ? s.subject && s.body : s.title))
    .sort((a, b) => a.day - b.day)
    .slice(0, 12);
}

/** {{business}} and {{town}} filled in, anything unknown removed rather than left raw.
 *  The same fields the Scripts library and the cold email pack use, so a
 *  template dropped into a step sends the way it reads. */
function fill(text, run, me) {
  me = me || {};
  return String(text || "")
    .replace(/\{\{\s*business(?:_name)?\s*\}\}/gi, run.business || "there")
    .replace(/\{\{\s*first_name\s*\}\}/gi, "there")
    .replace(/\{\{\s*(?:town|city)\s*\}\}/gi, run.town || "your area")
    .replace(/\{\{\s*trade\s*\}\}/gi, run.trade || "business")
    .replace(/\{\{\s*phone\s*\}\}/gi, run.phone || "your number")
    .replace(/\{\{\s*your_name\s*\}\}/gi, me.name || "")
    .replace(/\{\{\s*your_phone\s*\}\}/gi, me.phone || "")
    .replace(/\{\{\s*link\s*\}\}/gi, run.slug && process.env.INSTANT_PROPOSAL_URL ? process.env.INSTANT_PROPOSAL_URL + "/proposal.html?site=" + run.slug : "")
    /* The follow-up is worthless without the thing being followed up on, so a
       template can drop in the site we built them and the proposal page. Both
       come from the slug recorded when the lead was enrolled. A lead with no
       site built gets the sentence removed rather than a dead link. */
    .replace(/\{\{\s*site\s*\}\}/gi, run.slug && process.env.INSTANT_SITE_URL ? process.env.INSTANT_SITE_URL + "/?site=" + encodeURIComponent(run.slug) : "")
    .replace(/\{\{\s*proposal\s*\}\}/gi, run.slug && process.env.INSTANT_PROPOSAL_URL ? process.env.INSTANT_PROPOSAL_URL + "/proposal.html?site=" + run.slug : "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  const url = new URL(req.url);
  const isTick = url.searchParams.get("tick") === "1";

  /* The tick also runs from the daily cron, which carries a secret rather than
     a session. Everything else needs a signed-in human. */
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  /* Vercel sends its schedules "Authorization: Bearer <CRON_SECRET>" and
     nothing else. This used to look only for an x-cron-secret header and a
     ?key= parameter, neither of which Vercel sends, so the nightly tick was
     rejected every night and follow-ups never went out. The ?key= form is gone
     as well: a secret in a URL ends up in request logs. */
  const cronOk = isTick && cronSecret &&
    timingSafeEqual(req.headers.get("authorization") || "", "Bearer " + cronSecret);
  if (!cronOk && (!authSecret || !(await isAuthed(req)))) {
    return json({ ok: false, login: true }, 401);
  }

  const db = store();
  if (!db) return json({ ok: false, error: "Storage is not configured." }, 503);
  const rest = (path, init) => fetch(db.url + "/rest/v1/" + demoPath(path), {
    ...init, headers: { ...db.headers, ...(init && init.headers) },
    signal: AbortSignal.timeout(9000),
  });

  /* Which book of business this request belongs to. Reads are narrowed to it,
     and so are edits and deletes by id: without that, a coach-side request
     could reach a local sequence or run by guessing its number. The tick
     carries it too, so a run only ever meets steps from its own book. */
  const track = trackOf(req);
  const only = (path) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

  try {
    /* The nightly tick, before any method branching. Vercel's scheduler sends a
       GET, but this used to sit inside the POST branch, so even once the cron
       was authenticating it fell through to the plain listing and no follow-up
       ever advanced. Safe to run twice: each step is keyed to the day it is
       due. */
    if (isTick) return await tick(rest, track, only);

    /* ---------------------------------------------------------------- read */
    if (req.method === "GET") {
      const lead = url.searchParams.get("lead");
      if (lead) {
        const res = await rest(only(`sequence_runs?lead_row=eq.${encodeURIComponent(lead)}&select=*&order=id.desc`));
        return json({ ok: true, runs: res.ok ? await res.json() : [] });
      }
      if (url.searchParams.get("runs") === "1") {
        const res = await rest(only("sequence_runs?select=*&order=id.desc&limit=500"));
        return json({ ok: true, runs: res.ok ? await res.json() : [] });
      }
      const [seqRes, runRes] = await Promise.all([
        rest(only("sequences?select=*&order=id.asc")),
        rest(only("sequence_runs?select=sequence_id,status")),
      ]);
      const sequences = seqRes.ok ? await seqRes.json() : [];
      const runs = runRes.ok ? await runRes.json() : [];
      sequences.forEach((s) => {
        const mine = runs.filter((r) => r.sequence_id === s.id);
        s.enrolled = mine.filter((r) => r.status === "active").length;
        s.finished = mine.filter((r) => r.status !== "active").length;
      });
      /* On the demo the enrolment counts come from the same funnel as the lead
         list, so the Sequences tab does not say "0 active" beside a list with
         1,044 leads in sequence. The sequence definitions themselves are real
         product content and are left exactly as they are. */
      /* The enrolment story belongs to the local book. */
      if (isDemo() && track !== "coach" && sequences.length) {
        const fn = demoFunnel(await demoCustomerMix());
        const inSeq = Math.max(0, fn.emailed - fn.replied);
        const share = [0.62, 0.26, 0.12];
        let placed = 0;
        sequences.forEach((s, i) => {
          const n = i === sequences.length - 1 ? inSeq - placed : Math.round(inSeq * (share[i] || 0));
          s.enrolled = Math.max(0, n); placed += s.enrolled;
          s.finished = Math.round(fn.replied * (share[i] || 0.1));
        });
      }
      return json({ ok: true, sequences });
    }

    /* ------------------------------------------------------------- delete */
    if (req.method === "DELETE") {
      const id = parseInt(url.searchParams.get("id"), 10);
      if (!id) return json({ ok: false, error: "Which sequence?" }, 400);
      await rest(only(`sequence_runs?sequence_id=eq.${id}`), { method: "DELETE" });
      const res = await rest(only(`sequences?id=eq.${id}`), { method: "DELETE" });
      if (!res.ok) return json({ ok: false, error: "Could not delete that sequence." }, 502);
      return json({ ok: true });
    }

    if (req.method !== "POST") return json({ ok: false, error: "GET, POST or DELETE." }, 405);
    const body = await req.json().catch(() => ({}));

    /* -------------------------------------------------------------- enroll */
    if (url.searchParams.get("enroll") === "1") {
      const seqId = parseInt(body.sequence_id, 10);
      const leads = Array.isArray(body.leads) ? body.leads.slice(0, 200) : [];
      if (!seqId || !leads.length) return json({ ok: false, error: "Pick a sequence and at least one lead." }, 400);

      const seqRes = await rest(only(`sequences?id=eq.${seqId}&select=*`));
      const seq = seqRes.ok ? (await seqRes.json())[0] : null;
      if (!seq) return json({ ok: false, error: "That sequence is gone." }, 404);
      const steps = cleanSteps(seq.steps);
      if (!steps.length) return json({ ok: false, error: "That sequence has no steps yet." }, 400);

      const rows = leads.map((l) => ({
        sequence_id: seqId,
        lead_row: Number.isFinite(+l.row) ? +l.row : null,
        business: String(l.business || "").slice(0, 160) || "(no business)",
        email: l.email || null,
        phone: l.phone || null,
        slug: l.slug || null,
        town: l.town || null,
        trade: String(l.trade || "").slice(0, 80) || null,
        step_index: 0,
        next_due: addDays(today(), steps[0].day),
        status: "active",
      }));
      /* Enrolling somebody twice must be a no-op, not an error, and above all
         must not take the rest of the batch down with it. The upsert this used
         to lean on could never work: the constraint that stops a double
         enrolment is a PARTIAL unique index (sequence_id, lead_row) where
         lead_row is not null, and Postgres will not accept a partial index as
         an ON CONFLICT target through PostgREST. So the whole insert failed
         the moment one selected lead was already in the sequence, and none of
         the others went in either. The already-enrolled are dropped here
         instead, before the insert. */
      const wanted = rows.map((r) => r.lead_row).filter((n) => Number.isFinite(n));
      let already = new Set();
      if (wanted.length) {
        const have = await rest(only(`sequence_runs?sequence_id=eq.${seqId}&lead_row=in.(${wanted.join(",")})&select=lead_row`));
        if (have.ok) already = new Set((await have.json()).map((r) => r.lead_row));
      }
      const fresh = rows.filter((r) => !(Number.isFinite(r.lead_row) && already.has(r.lead_row)));
      if (!fresh.length) return json({ ok: true, enrolled: 0, already: already.size });
      const res = await rest("sequence_runs", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(stampTrack(fresh, track)),
      });
      if (!res.ok) return json({ ok: false, error: "Could not enrol those leads." }, 502);
      const saved = await res.json();
      return json({ ok: true, enrolled: saved.length, already: already.size });
    }

    /* ---------------------------------------------------------------- stop */
    if (url.searchParams.get("stop") === "1") {
      const id = parseInt(body.run_id, 10);
      if (!id) return json({ ok: false, error: "Which run?" }, 400);
      const res = await rest(only(`sequence_runs?id=eq.${id}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "stopped",
          stopped_reason: String(body.reason || "stopped by hand").slice(0, 120),
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) return json({ ok: false, error: "Could not stop that." }, 502);
      return json({ ok: true });
    }

    /* Just the on-off switch. Kept separate from a full save so the toggle on
       the list does not have to send the whole sequence back, and so switching
       one off can never be refused for a reason about its steps. */
    if (body.id && body.active !== undefined && body.steps === undefined) {
      const res = await rest(only(`sequences?id=eq.${parseInt(body.id, 10)}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ active: !!body.active }),
      });
      if (!res.ok) return json({ ok: false, error: "Could not change that." }, 502);
      return json({ ok: true, sequence: (await res.json())[0] });
    }

    /* ------------------------------------------------- create or update one */
    const name = String(body.name || "").trim().slice(0, 120);
    const steps = cleanSteps(body.steps);
    if (!name) return json({ ok: false, error: "A sequence needs a name." }, 400);
    if (!steps.length) return json({ ok: false, error: "Add at least one step." }, 400);

    if (body.id) {
      const res = await rest(only(`sequences?id=eq.${parseInt(body.id, 10)}`), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body.active === undefined ? { name, steps } : { name, steps, active: !!body.active }),
      });
      if (!res.ok) return json({ ok: false, error: "Could not save." }, 502);
      return json({ ok: true, sequence: (await res.json())[0] });
    }
    const res = await rest("sequences", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([stampTrack({ name, steps }, track)]),
    });
    if (!res.ok) return json({ ok: false, error: "Could not save." }, 502);
    return json({ ok: true, sequence: (await res.json())[0] });
  } catch (err) {
    return json({ ok: false, error: "Storage did not answer." }, 502);
  }
}

/**
 * Advance every run whose next step is due.
 *
 * Safe to call as often as you like: a step is only ever acted on when its due
 * date has arrived, and acting on it moves the run forward, so the same step
 * cannot fire twice.
 *
 * One book of business per call. The nightly cron carries no track, so it
 * advances the local book; a coach tick asks for it by name.
 */
async function tick(rest, track, only) {
  const now = today();
  const res = await rest(only(`sequence_runs?status=eq.active&next_due=lte.${now}&select=*&limit=200`));
  if (!res.ok) return json({ ok: false, error: "Could not read runs." }, 502);
  const due = await res.json();
  if (!due.length) return json({ ok: true, advanced: 0, sent: 0, tasks: 0 });

  const seqRes = await rest(only("sequences?select=*"));
  const sequences = seqRes.ok ? await seqRes.json() : [];
  const byId = {}, paused = {};
  sequences.forEach((s) => { byId[s.id] = cleanSteps(s.steps); if (s.active === false) paused[s.id] = true; });

  let sent = 0, tasks = 0, advanced = 0, stopped = 0;

  /* Both senders, worked out once for the whole tick rather than per email.
     Per email would be wrong as well as wasteful: Gmail's count comes from the
     activity rows the Make scenario writes back, and those land a second or two
     after the send, so asking again between two steps would read the same
     number twice and let the tick spend the cap several times over. This budget
     is spent down in memory instead, and the real count catches up by the next
     run. */
  const pipe = await loadSendingPipe();
  const budget = { gmail: (await gmailAllowance(pipe)).room, pipe };

  for (const run of due) {
    /* A sequence switched off holds its runs where they are: nothing sends,
       nothing advances, and switching it back on picks up from the same step
       rather than firing everything that came due while it was off. */
    if (paused[run.sequence_id]) continue;
    const steps = byId[run.sequence_id] || [];
    const step = steps[run.step_index];
    if (!step) {
      await rest(only(`sequence_runs?id=eq.${run.id}`), {
        method: "PATCH",
        body: JSON.stringify({ status: "finished", updated_at: new Date().toISOString() }),
      });
      stopped++;
      continue;
    }

    if (step.kind === "email") {
      /* No address means the email step cannot run. It becomes a task instead,
         so the follow-up still happens, by phone, rather than silently not. */
      if (run.email) {
        const ok = await sendStep(run, step, budget);
        if (ok) sent++;
      } else {
        await makeTask(rest, run, "Ring " + run.business + " (no email for step " + (run.step_index + 1) + ")", "call", track);
        tasks++;
      }
    } else {
      await makeTask(rest, run, fill(step.title, run), "follow_up", track);
      tasks++;
    }

    const nextIndex = run.step_index + 1;
    const nextStep = steps[nextIndex];
    const patch = nextStep
      ? {
          step_index: nextIndex,
          // Offsets are from the start, so the gap is the difference.
          next_due: addDays(now, Math.max(0, nextStep.day - step.day)),
          updated_at: new Date().toISOString(),
        }
      : { status: "finished", updated_at: new Date().toISOString() };
    await rest(only(`sequence_runs?id=eq.${run.id}`), { method: "PATCH", body: JSON.stringify(patch) });
    advanced++;
  }

  return json({ ok: true, advanced, sent, tasks, finished: stopped });
}

async function makeTask(rest, run, title, kind, track) {
  await rest("tasks", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([stampTrack({
      lead_row: run.lead_row,
      business: run.business,
      title: title.slice(0, 200),
      kind,
      due_on: today(),
      note: "From a sequence",
    }, track)]),
  }).catch(() => {});
}

/** Sends through the same Resend account and warm-up rules as everything else. */
async function sendStep(run, step, budget) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  /* No default sender. This used to fall back to the original operator's
     address, so a student who had not set RESEND_FROM would have sent, or tried
     to send, sequence emails as somebody else. A missing sender is a setup
     problem and is reported as one by the setup check on Today. */
  const me = await loadProfile();
  const from = me.from;
  /* Gmail while it has room left today, Resend after that, which is the split
     the autopilot makes. Gmail goes first for the same reason: a warming Resend
     domain should be the one that runs out, not the established inbox. */
  const pipe = (budget && budget.pipe) || (await loadSendingPipe());
  const gmailRoom = budget ? budget.gmail > 0 : pipe.on;
  if (pipe.on && gmailRoom) {
    /* The demo never sends, whichever senders are on. */
    if (String(process.env.SEND_MODE || "").trim().toLowerCase() === "simulate") return true;
    const body = fill(step.body, run, me);
    try {
      await sendViaMake(pipe, {
        to: run.email,
        subject: fill(step.subject, run, me),
        html: textToHtml(body),
        text: body,
        reply_to: me.reply_to,
        business: run.business || "",
        lead_row: run.lead_row || null,
        step: (run.step_index || 0) + 1,
      });
      if (budget) budget.gmail--;
      return true;
    } catch {
      return false;
    }
  }
  if (!key) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [run.email],
        subject: fill(step.subject, run, me),
        text: fill(step.body, run, me),
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
