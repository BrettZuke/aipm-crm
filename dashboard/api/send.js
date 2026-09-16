// The outreach autopilot. Vercel calls this once a day on a schedule (vercel.json),
// and the dashboard's "Send now" button calls it on demand. Each run it:
//   1. reads every lead and status from the student's Google Sheet,
//   2. works out who is due (first touch, follow-up, or monthly nurture),
//   3. skips anyone marked Replied or Removed, always,
//   4. sends up to today's warm-up allowance through Resend, and
//   5. writes the new statuses back to the sheet.
// The sheet is the single source of truth, so a lead the reply watcher marked
// Removed can never receive another email.
import {
  loadEmailSet, pickInitial, dueAction, capForDay, warmupCeiling,
  renderText, renderHtml, personalizeVideo,
} from "./_outreach.js";
import { store } from "./_leads.js";
import { trackOf } from "./_track.js";
import { loadProfile } from "./_profile.js";
import { goUrl } from "./_go.js";
import { isAuthed, timingSafeEqual } from "./_auth.js";
import { leadsInPostgres, readLeads, markLeads } from "./_leads.js";
import { loadSendingPipe, sendViaMake, gmailAllowance } from "./_sending.js";

export const config = { maxDuration: 60 };

const SEND_GAP_MS = 600; // Resend allows 2 requests a second; stay under it

/* Simulation mode, for the demo deployment.
   The demo shares its leads sheet and its Resend key with the real CRM, so a
   send from it would email real businesses AND mark them Contacted in the
   shared sheet, which would quietly stop the real CRM ever emailing them. In
   simulate mode the whole run happens exactly as normal except the two steps
   that touch the outside world: no Resend call, and no write-back. Everything
   the caller sees, counts, warm-up, per-lead outcomes, is the real shape, so
   the screen behaves as it always does. */
const SIMULATE = String(process.env.SEND_MODE || "").trim().toLowerCase() === "simulate";
const WINDOW_DAYS = 30;

function parseTime(createdAt) {
  const iso = String(createdAt || "").replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return Date.parse(iso);
}

// Today's sends and the warm-up day number, read from Resend itself, so the
// autopilot never double-spends the daily allowance no matter where sends happen.
async function warmupFromResend(apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  let sentToday = 0;
  let earliest = Infinity;
  let after = "";
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const res = await fetch("https://api.resend.com/emails?" + qs, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error("Resend returned HTTP " + res.status + " while checking today's volume");
    const body = await res.json();
    const batch = body.data || [];
    for (const r of batch) {
      const t = parseTime(r.created_at);
      if (Number.isNaN(t) || t < cutoff) continue;
      if (String(r.created_at || "").slice(0, 10) === today) sentToday++;
      if (t < earliest) earliest = t;
    }
    if (!body.has_more || batch.length === 0) break;
    const oldest = batch[batch.length - 1];
    after = oldest.id;
    if (parseTime(oldest.created_at) < cutoff) break;
  }
  const day = earliest === Infinity ? 1 : Math.floor((Date.now() - earliest) / 86400000) + 1;
  return { day, cap: capForDay(day), sent_today: sentToday, ceiling: warmupCeiling() };
}

function sheetTarget(params) {
  const base = (process.env.LEADS_SHEET_URL || "").trim();
  const token = (process.env.LEADS_SHEET_TOKEN || "").trim();
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params + (token ? "&token=" + encodeURIComponent(token) : "");
}

async function sendOne(cfg, to, subject, html, text, lead, via) {
  if (SIMULATE) {
    // Shaped like a Resend id so anything downstream reads it the same way.
    return "sim_" + Math.random().toString(36).slice(2, 12);
  }
  /* Which sender this particular email was allotted upstairs, where the day's
     allowance was divided between the two. Checked after SIMULATE and not
     before, so the demo's guarantee survives the new path: a simulated
     deployment sends nothing whichever senders are on. A scenario that refuses
     throws, and the catch below counts it exactly as a refused Resend send, so
     the lead is not moved on and comes round again tomorrow. */
  if (via === "gmail") {
    return sendViaMake(cfg.pipe, {
      to, subject, html, text, reply_to: cfg.reply_to,
      business: (lead && lead.business) || "", lead_row: (lead && lead.row) || null,
    });
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from, to: [to], reply_to: cfg.reply_to, subject, html, text,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Resend HTTP " + res.status + ": " + body.slice(0, 200));
  return (JSON.parse(body).id || "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  // The gate: a login cookie (AUTH_SECRET), the legacy page key (?k=, DASH_KEY),
  // or Vercel's cron secret each open it on their own. Fail closed: with none of
  // them set nobody is let in. The cron path must keep working even when the
  // dashboard is locked, or the daily autopilot dies.
  const lock = (process.env.DASH_KEY || "").trim();
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const auth = String(req.headers["authorization"] || "");
  const keyOk = !!lock && timingSafeEqual(url.searchParams.get("k") || "", lock);
  const cookieOk = !!authSecret && (await isAuthed(req));
  const cronOk = !!cronSecret && timingSafeEqual(auth, "Bearer " + cronSecret);
  if (!keyOk && !cookieOk && !cronOk) {
    const out = authSecret || !lock
      ? { ok: false, login: true }
      : { error: "Locked. Open with ?k=your-key (or set CRON_SECRET for the schedule)." };
    return res.status(401).json(out);
  }

  /* Identity comes from the profile the Settings page edits; the environment
     is only a fallback inside loadProfile(). The key stays in the environment
     because it is a secret, not an identity. */
  const prof = await loadProfile();
  const pipe = await loadSendingPipe();
  const cfg = {
    key: (process.env.RESEND_API_KEY || "").trim(),
    from: prof.from,
    reply_to: prof.reply_to,
    video: prof.video,
    name: prof.name,
    phone: prof.phone,
    pipe,
  };
  const missing = [];
  /* Resend's key is only needed by the copy that sends through Resend. With
     Gmail switched on the scenario holds the Google sign-in and this server
     holds no sending credential at all, so asking for one would stop a
     correctly set up student before the first email. */
  if (!cfg.key && !pipe.on) missing.push("RESEND_API_KEY");
  if (!cfg.from) missing.push("RESEND_FROM");
  if (!cfg.video) missing.push("OUTREACH_VIDEO_LINK");
  if (!cfg.name) missing.push("OUTREACH_SENDER_NAME");
  /* A sheet is only required on a copy that still reads from one. */
  const onPg = await leadsInPostgres();
  if (!onPg && !(process.env.LEADS_SHEET_URL || "").trim()) missing.push(store() ? "LEADS_SHEET_URL" : "SUPABASE_URL");
  // ?check=1: report whether the autopilot could send, without sending anything.
  // The CRM's setup panel uses this; the daily schedule never passes it.
  if (url.searchParams.get("check") === "1") {
    /* simulated is reported here so a deployment can be checked for demo mode
       without POSTing, which on a live deployment would actually send mail. */
    return res.status(200).json({ ok: true, configured: missing.length === 0, missing, simulated: SIMULATE, senders: { gmail: pipe.on, resend: !!cfg.key } });
  }
  if (missing.length) {
    return res.status(500).json({
      simulated: SIMULATE,
      configured: false,
      missing,   // the setup check on Today reads this list; the sentence below is for a person reading the raw response
      error: "Autopilot is not configured yet. Add these in Vercel (Settings, Environment Variables) and redeploy: " + missing.join(", ") + ". See dashboard/README.md.",
    });
  }

  // 1. Who exists, and who already replied or asked out (they are skipped).
  let sheet;
  if (onPg) {
    try { sheet = { ok: true, leads: await readLeads() }; }
    catch (err) { return res.status(502).json({ error: "Could not read your leads (" + (err && err.message ? err.message : "database error") + ")." }); }
  } else try {
    const r = await fetch(sheetTarget("leads=1"), { signal: AbortSignal.timeout(10000) });
    sheet = JSON.parse(await r.text());
  } catch (err) {
    return res.status(502).json({ error: "Could not read the leads sheet (" + (err && err.message ? err.message : "network error") + "). Check LEADS_SHEET_URL." });
  }
  if (!sheet.ok) return res.status(502).json({ error: "The leads sheet said: " + String(sheet.error || "unknown error") });
  const leads = sheet.leads || [];

  // 2. What is due today.
  const todayUtc = Date.now();
  const plan = [];
  let stopped = 0;
  const emailSet = await loadEmailSet(store(), trackOf(req));
  for (const lead of leads) {
    const action = dueAction(lead, todayUtc);
    if (!action) {
      const low = String(lead.status || "").trim().toLowerCase();
      if (low === "replied" || low === "removed" || low === "unsubscribed" || low === "not interested") stopped++;
      continue;
    }
    let tpl;
    if (action.kind === "initial") tpl = pickInitial(lead, emailSet);
    else if (action.kind === "nurture") tpl = emailSet.nurtures[new Date().getUTCMonth() % emailSet.nurtures.length];
    else tpl = emailSet.followups[action.index];
    if (!tpl) continue;
    plan.push({ lead, key: tpl.key, subject: tpl.subject, body: tpl.body, next: action.next });
  }

  // 3. Today's allowance, counted per sender and then added together.
  /* Each sender has its own record of what it sent today and they are not
     interchangeable. Resend knows its own volume. A Gmail send never reaches
     Resend, so asking Resend about it would report nought every morning and
     Gmail's cap would never bite; that count comes from the activity rows the
     Make scenario writes back. Adding the two is the reason both are on: a
     Resend domain on day three is allowed nine emails, and a Gmail that has
     existed for years is not on that curve. */
  const gmail = await gmailAllowance(pipe);
  let warmup = { day: 0, cap: 0, sent_today: 0, ceiling: warmupCeiling() };
  let resendRoom = 0;
  if (cfg.key) {
    try {
      warmup = await warmupFromResend(cfg.key);
      resendRoom = Math.max(0, warmup.cap - warmup.sent_today);
    } catch (err) {
      /* With Gmail carrying the day, a Resend outage is not a reason to send
         nothing. It is still a reason to say so. */
      if (!gmail.room) return res.status(502).json({ error: String(err.message || err) });
      warmup.error = String(err.message || err);
    }
  }
  /* ?limit=N caps the whole run, not one sender, and it can only ever lower
     what the caps already allow. It used to be able to raise the ceiling to a
     hundred, which is a hand-typed way to burn a new domain. */
  const override = parseInt(url.searchParams.get("limit") || "", 10);
  const total = Number.isNaN(override)
    ? gmail.room + resendRoom
    : Math.max(0, Math.min(override, gmail.room + resendRoom));
  /* Gmail first, then whatever Resend will still take. Filling the warm-up
     domain last means a short day comes off the sender that is not trying to
     build a reputation. */
  const viaGmail = Math.min(gmail.room, total);
  const toSend = plan.slice(0, total).map((item, i) => ({ ...item, via: i < viaGmail ? "gmail" : "resend" }));

  // 4. Send, spaced out, and remember every advance for the write-back.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const updates = [];
  const details = [];
  let sent = 0, failed = 0;
  const sentBy = { gmail: 0, resend: 0 };
  for (let i = 0; i < toSend.length; i++) {
    const { lead, key, subject, body, next, via } = toSend[i];
    try {
      /* The tracked link when this deployment knows its own host (it always
         does on Vercel), the plain personalised video link otherwise. */
      const leadCfg = { ...cfg, video: goUrl(req.headers.host, lead) || personalizeVideo(cfg.video, lead),
                        business: lead.business || "", town: lead.city || lead.town || "", leadPhone: lead.phone || "", trade: lead.category || lead.trade || "" };
      const subj = renderText(subject, leadCfg), text = renderText(body, leadCfg);
      const id = await sendOne(cfg, lead.email, subj, renderHtml(body, leadCfg), text, lead, via);
      updates.push({ row: lead.row, status: next, contacted_on: stamp });
      details.push({ business: lead.business, email: lead.email, moved_to: next, id, script: key, subject: subj, via, text: SIMULATE ? text : undefined });
      sent++;
      sentBy[via]++;
    } catch (err) {
      failed++;
      details.push({ business: lead.business, email: lead.email, via, error: String(err.message || err).slice(0, 160) });
    }
    if (i < toSend.length - 1) await sleep(SEND_GAP_MS);
  }

  // 5. Write the new statuses back to the sheet (the source of truth).
  let writeback = { ok: true, updated: 0 };
  if (SIMULATE) {
    writeback = { ok: true, updated: 0, simulated: true };
  } else if (updates.length && onPg) {
    try { writeback = await markLeads(updates); } catch (err) { writeback = { ok: false, error: String(err && err.message ? err.message : err) }; }
  } else if (updates.length) {
    try {
      const r = await fetch((process.env.LEADS_SHEET_URL || "").trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "mark", token: (process.env.LEADS_SHEET_TOKEN || "").trim(), updates }),
        signal: AbortSignal.timeout(15000),
      });
      writeback = JSON.parse(await r.text());
    } catch (err) {
      writeback = { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  return res.status(200).json({
    ok: true,
    simulated: SIMULATE,
    /* What each sender did, and what each had left. One number for the run
       would hide the thing the operator needs to see: which of the two is
       the bottleneck today. */
    sent_by: sentBy,
    due: plan.length,
    sent,
    failed,
    held_for_tomorrow: Math.max(0, plan.length - toSend.length),
    skipped_replied_or_removed: stopped,
    warmup: { day: warmup.day, cap_today: warmup.cap, already_sent_today: warmup.sent_today, ceiling: warmup.ceiling, error: warmup.error },
    gmail: gmail.on ? { day: gmail.day, cap_today: gmail.cap, already_sent_today: gmail.sent_today, room: gmail.room, error: gmail.error } : null,
    allowance_today: gmail.room + resendRoom,
    writeback,
    details: details.slice(0, 12),
  });
}
