// Sending through your own Gmail, with Make as the pipe.
//
// This runs ALONGSIDE Resend, not instead of it. That is the point. A Resend
// domain in its first fortnight is allowed five emails a day, then seven, then
// nine, and a Gmail account you have had for years is not on that curve. With
// both switched on, a day's allowance is Gmail's cap plus Resend's, and the
// autopilot fills from Gmail first and then spends whatever Resend will still
// take. Switch Gmail off and everything goes through Resend exactly as before.
//
// Each sender keeps its own counter, so neither can spend the other's
// allowance: Resend's comes from Resend's own record of what it sent, Gmail's
// from the activity rows the Make scenario writes back. Nothing else moves,
// who is due, which email they get, the activity log and the stats all stay
// here.
//
// Why a webhook and not a Gmail API call from this server. Sending as somebody
// else's Gmail needs that person's OAuth token, which means a Google Cloud
// project, a consent screen, a refresh token per student and somewhere safe to
// keep it. Make already solves all of that: the student signs in to Google once
// inside Make, and this CRM only ever holds a URL. A leaked webhook URL can
// send mail from their Gmail, which is why the call carries the CRM's own API
// key and the scenario refuses anything else.
//
// The settings live in the kv table, not in a new profile column, so no schema
// change and no redeploy: the toggle takes effect on the next send.

import { isDemo } from "./_demo.js";
import { store, rest } from "./_leads.js";
import { resolvedApiKey } from "./_profile.js";
import { capForDay } from "./_outreach.js";

const KV_TABLE = () => (isDemo() ? "kv_demo" : "kv");
const KEY = "sending_pipe";

/* Make's own hook hosts, and nothing else. Without this the toggle would be a
   way for anyone who can sign in to make this server POST the text of every
   outreach email at a URL of their choosing. */
const HOOK_HOST = /^hook(?:\.[a-z0-9-]+)?\.(?:make\.com|integromat\.com)$/i;

/** "" when the URL is one Make could have given you, otherwise why it is not. */
export function checkWebhook(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); } catch { return "That is not a web address. Copy the whole line Make shows, starting https://"; }
  if (parsed.protocol !== "https:") return "The webhook has to start with https://";
  if (!HOOK_HOST.test(parsed.hostname)) return "That is not a Make webhook. It looks like https://hook.eu2.make.com/ and then a long code.";
  if (parsed.pathname.replace(/\/+$/, "").length < 8) return "That address is missing the long code Make puts on the end.";
  return "";
}

const shape = (v) => {
  const raw = v && typeof v === "object" ? v : {};
  const webhook = String(raw.webhook || "").trim().slice(0, 500);
  const cap = Math.round(Number(raw.daily_cap));
  return {
    /* On only when there is somewhere to send to. A row that says on with no
       webhook would stop every send dead at the first lead, so it reads as off
       and the screen says why. */
    on: !!raw.on && !!webhook && !checkWebhook(webhook),
    webhook,
    /* What the student called the Gmail, so Settings can say which account is
       sending without asking Make. Free text: nothing is checked against it. */
    account: String(raw.account || "").trim().slice(0, 120),
    /* How many a day this Gmail may send. Zero means "use the same warm-up
       curve Resend gets", which is the right default: a brand new inbox that
       sends two hundred cold emails on its first day stops being an inbox.
       Capped at 400 whatever is typed, under Gmail's own 500 a day for a
       personal account, because the number that gets you blocked is not the
       one the CRM should let you type. */
    daily_cap: Number.isFinite(cap) && cap > 0 ? Math.min(cap, 400) : 0,
  };
};

/** The saved settings. A store that cannot be read reads as off, so an outage
 *  falls back to Resend rather than dropping every email on the floor. */
export async function loadSendingPipe() {
  const db = store();
  if (!db) return shape(null);
  try {
    const r = await rest(db, `${KV_TABLE()}?key=eq.${KEY}&select=value&limit=1`, { ms: 6000 });
    if (!r.ok) return shape(null);
    const rows = await r.json();
    return shape((rows[0] || {}).value);
  } catch { return shape(null); }
}

/** Save them. Returns "" once stored, otherwise why it is not. */
export async function saveSendingPipe(next) {
  const db = store();
  if (!db) return "Storage is not connected, so this cannot be saved.";
  const value = shape(next);
  /* Shaped before the write and refused after, rather than silently storing a
     toggle that reads back off: a student who pressed Save and saw "saved"
     while nothing changed has no way to work out why. */
  if (next && next.on && !value.on) {
    return checkWebhook(String((next || {}).webhook || "")) ||
           "Paste the webhook URL from your Make scenario first.";
  }
  try {
    const r = await rest(db, `${KV_TABLE()}?on_conflict=key`, {
      method: "POST", ms: 8000,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ key: KEY, value, updated_at: new Date().toISOString() }]),
    });
    return r.ok ? "" : "Could not save that (" + r.status + ").";
  } catch { return "Could not reach storage to save that."; }
}

/* The scenario's last step builds its JSON by dropping these values straight
   into a template, the way every Make blueprint does, so a value carrying a
   quote, a backslash or a newline makes the whole body invalid JSON and the
   activity is quietly lost: the CRM answers 400 and the step is set not to stop
   on an HTTP error. Rather than teach a student's scenario to escape, the three
   values it logs are sent already safe. Only the log line is flattened; the
   subject and body Gmail actually sends go over untouched. */
function oneLine(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\\"]/g, "'")
    .replace(/[\r\n\t]+/g, " ")
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/* Gmail's Make module takes HTML, not plain text: its "text" body type arrives
   as one run-on paragraph with every line break lost. So a caller that only has
   plain text hands it through here first. Escaped before the line breaks go in,
   or an apostrophe-free subject line containing < would eat the rest of the
   email. */
export function textToHtml(text) {
  const esc = String(text == null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
            .replace(/\r?\n/g, "<br>");
}

/* Make answers 200 with the word "Accepted" whenever the scenario's own filter
   stops the run, which is exactly what happens when the secret does not match.
   A send that never left Gmail must not be counted as sent, so a reply only
   counts when the scenario says so in as many words. */
function idFrom(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return ""; }
  if (!parsed || parsed.ok !== true) return "";
  return String(parsed.id || "").trim() || "gmail_sent";
}

/**
 * Hand one rendered email to the student's Make scenario.
 * Returns the Gmail message id. Anything else throws, and the caller counts it
 * exactly as it counts a refused Resend send: the lead is not moved on, and it
 * comes round again tomorrow.
 */
export async function sendViaMake(pipe, mail) {
  const secret = await resolvedApiKey();
  if (!secret) throw new Error("No API key. Settings, Developer, press Rotate, then run the installer again.");
  let res, body;
  try {
    res = await fetch(pipe.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        reply_to: mail.reply_to || "",
        business: mail.business || "",
        lead_row: mail.lead_row || null,
        step: mail.step || null,
        /* For the scenario's log step only. See oneLine above. */
        log_business: oneLine(mail.business, 160),
        log_subject: oneLine(mail.subject, 200),
        log_preview: oneLine(mail.text || mail.html, 280),
      }),
      /* Longer than the Resend call because there is a Gmail send inside it.
         Make's own answer arrives in about a second; this is the ceiling, not
         the expectation. */
      signal: AbortSignal.timeout(25000),
    });
    body = await res.text();
  } catch (err) {
    throw new Error("Could not reach your Make scenario (" + String((err && err.message) || err) + ").");
  }
  if (!res.ok) throw new Error("Your Make scenario answered HTTP " + res.status + ": " + body.slice(0, 160));
  const id = idFrom(body);
  if (!id) {
    throw new Error("Your Make scenario did not send it. Check it is switched on, that Gmail is " +
                    "connected, and that the key in its last step matches the one in Settings, Developer. " +
                    "It said: " + body.slice(0, 120));
  }
  return id;
}

/* Today's Gmail volume.
   The Resend count cannot answer it: a Gmail send never touches Resend, so the
   warm-up would read zero every morning and the cap would never bite. The
   activity log can, because the scenario posts every send back to /api/activity.
   Narrowed to provider=make-gmail so the two senders count separately, and read
   across both books on purpose: the cap protects one Gmail account, and that
   account does not care which book a lead came from. */
const WINDOW_DAYS = 30;
export async function warmupFromActivity() {
  const db = store();
  if (!db) throw new Error("Storage is not connected, so today's sending count cannot be read.");
  const table = isDemo() ? "activities_demo" : "activities";
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const r = await rest(db, `${table}?channel=eq.email&kind=eq.sent&provider=eq.make-gmail` +
                           `&occurred_at=gte.${since}` +
                           `&select=occurred_at&order=occurred_at.asc&limit=5000`, { ms: 8000 });
  if (!r.ok) throw new Error("Could not read today's sending count (" + r.status + ").");
  const rows = await r.json();
  let sentToday = 0;
  for (const row of rows) if (String(row.occurred_at || "").slice(0, 10) === today) sentToday++;
  const earliest = rows.length ? Date.parse(rows[0].occurred_at) : NaN;
  const day = Number.isNaN(earliest) ? 1 : Math.floor((Date.now() - earliest) / 86400000) + 1;
  return { day, sent_today: sentToday };
}

/**
 * What this Gmail may still send today.
 *
 * The two senders run side by side rather than one instead of the other, which
 * is the whole point: a Resend domain in its first fortnight is allowed five a
 * day, then seven, then nine, and an established Gmail is not. Adding the two
 * allowances together is what gets a day's outreach out while the new domain is
 * still warming. Each keeps its own counter, so neither can spend the other's.
 *
 * A storage failure answers no room rather than throwing. The autopilot then
 * sends what Resend allows and says Gmail was unavailable, instead of the whole
 * run dying on a read.
 */
export async function gmailAllowance(pipe) {
  if (!pipe || !pipe.on) return { on: false, day: 0, cap: 0, sent_today: 0, room: 0 };
  try {
    const seen = await warmupFromActivity();
    const cap = pipe.daily_cap || capForDay(seen.day);
    return { on: true, day: seen.day, cap, sent_today: seen.sent_today,
             room: Math.max(0, cap - seen.sent_today) };
  } catch (err) {
    return { on: true, day: 0, cap: 0, sent_today: 0, room: 0,
             error: String((err && err.message) || err) };
  }
}
