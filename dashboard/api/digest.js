// The weekly report as an email: what went out, what came back, what it made,
// this week against last, across both books. Sent on the schedule the owner
// picked in Settings, Sending. Three daily schedules exist in vercel.json
// (8am UK, New York, Los Angeles); the one matching the setting sends, every
// day, on Mondays, or on the 1st. The page can also post the report it just
// drew, so "Email me this report" sends exactly what was on screen.
//   GET  ?slot=uk|ny|la   from the schedule, "Authorization: Bearer CRON_SECRET"
//   GET  ?preview=1       signed in: the server's own copy of the email, nothing sent
//   GET  ?send=1          signed in: send the server's copy now (the demo only previews)
//   POST {subject, html, text}   signed in: send this, as is
export const config = { runtime: "edge" };

import { isAuthed, timingSafeEqual } from "./_auth.js";
import { isDemo } from "./_demo.js";
import { loadProfile, readAllowedEmails, saveDigest, DIGEST_SLOTS } from "./_profile.js";
import { leadsInPostgres, readLeads, store } from "./_leads.js";
import { readCoachLeads, db as coachDb } from "./_coach.js";
import { fetchRows } from "./_rows.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (v) => String(v || "").slice(0, 10);
const HOT = /^(answered|replied|interested|proposal sent|loom\/vsl sent|got on call|call booked|callback)$/i;

function dayIn(tz, at) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at || new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function weekdayIn(tz) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date()); }
  catch { return new Date().toUTCString().slice(0, 3); }
}
/* Monday to today, and last week to the same weekday, as YYYY-MM-DD bounds. */
function weekBounds(today) {
  const t = new Date(today + "T00:00:00Z"), dow = (t.getUTCDay() + 6) % 7;
  const shift = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  return { from: shift(t, -dow), to: today, prevFrom: shift(t, -dow - 7), prevTo: shift(t, -7) };
}
const within = (d, a, b) => d && d >= a && d <= b;

/* Resend's sent list back to a date. The autopilot's emails are not activity
   rows, so this is where "emails sent" comes from on a real copy. */
async function resendSent(key, since) {
  if (!key) return [];
  const out = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const r = await fetch("https://api.resend.com/emails?" + qs, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) break;
    const body = await r.json();
    const batch = body.data || [];
    for (const e of batch) out.push(day(e.created_at));
    const oldest = batch[batch.length - 1];
    if (!body.has_more || !oldest || day(oldest.created_at) < since) break;
    after = oldest.id;
  }
  return out.filter((d) => d >= since);
}

export async function gather(prof, tz) {
  const db = store();
  const today = dayIn(tz), B = weekBounds(today);
  let local = [], coach = [];
  if (await leadsInPostgres()) { try { local = await readLeads(); } catch { local = []; } }
  const cdb = coachDb();
  if (cdb) { try { coach = await readCoachLeads(cdb); } catch { coach = []; } }
  let acts = [], deals = [];
  if (db) {
    const q = async (path, max) => { try { return (await fetchRows(db, path, { max, timeout: 9000 })).rows; } catch { return []; } };
    [acts, deals] = await Promise.all([
      q(`activities?occurred_at=gte.${B.prevFrom}T00:00:00Z&select=occurred_at,lead_row,business,channel,kind,data,track&order=occurred_at.desc`, 8000),
      q(`deals?closed_on=gte.${B.prevFrom}&select=business,amount,mrr,currency,closed_on,track`, 2000),
    ]);
  }
  const sent = isDemo() ? [] : await resendSent((process.env.RESEND_API_KEY || "").trim(), B.prevFrom);
  const book = (track, leads) => {
    const mine = (r) => (r.track || "local") === track;
    const count = (a, b) => {
      const inb = (r) => within(day(r.occurred_at), a, b);
      const emails = acts.filter((r) => mine(r) && r.channel === "email" && r.kind === "sent" && inb(r)).length
        + (track === "local" ? sent.filter((d) => within(d, a, b)).length : 0);
      const dms = acts.filter((r) => mine(r) && r.channel === "dm" && r.kind !== "replied" && inb(r)).length;
      const calls = acts.filter((r) => mine(r) && r.channel === "call" && !/^sales_/.test(r.kind || "") && inb(r)).length;
      const replies = acts.filter((r) => mine(r) && inb(r) && (r.kind === "replied" || (r.channel === "call" && /^(interested|callback)$/.test(r.kind || "")))).length;
      const held = acts.filter((r) => mine(r) && /^sales_(won|followup|lost)$/.test(r.kind || "") && within(day((r.data || {}).scheduled_at || r.occurred_at), a, b)).length;
      const won = deals.filter((d) => mine(d) && within(day(d.closed_on), a, b));
      return { emails, dms, calls, sent: emails + dms + calls, replies, held, customers: won.length, cash: won.reduce((n, d) => n + (Number(d.amount) || 0), 0) };
    };
    const hot = leads.filter((l) => HOT.test(l.status || "")).slice(0, 8);
    return { track, leads: leads.length, now: count(B.from, B.to), prev: count(B.prevFrom, B.prevTo), hot };
  };
  const books = [book("local", local), book("coach", coach)].filter((b) => b.leads || b.now.sent || b.prev.sent);
  const tot = (k) => books.reduce((n, b) => n + b[k], 0);
  const sum = (k, w) => books.reduce((n, b) => n + b[w][k], 0);
  return { today, B, books, now: Object.fromEntries(["emails", "dms", "calls", "sent", "replies", "held", "customers", "cash"].map((k) => [k, sum(k, "now")])),
           prev: Object.fromEntries(["emails", "dms", "calls", "sent", "replies", "held", "customers", "cash"].map((k) => [k, sum(k, "prev")])), leadsTotal: tot("leads") };
}

function money(cur, n) {
  const sym = { GBP: "£", USD: "$", EUR: "€", CAD: "$", AUD: "$" }[cur] || "";
  return sym + Math.round(n).toLocaleString("en-GB");
}
function delta(cur, prev) {
  if (!prev && !cur) return "";
  if (!prev) return "new";
  const pct = Math.round(((cur - prev) / prev) * 100);
  return (pct > 0 ? "up " : pct < 0 ? "down " : "level, ") + (pct ? Math.abs(pct) + "%" : "0%");
}
function verdict(g, cur) {
  const n = g.now, p = g.prev;
  if (!n.sent) return "Nothing has gone out yet this week. The list is right there: pick ten and start.";
  const d = p.sent ? Math.round(((n.sent - p.sent) / p.sent) * 100) : null;
  let line = `You sent ${n.sent} ${n.sent === 1 ? "message" : "messages"}`;
  if (d === null) line += " with nothing to compare against yet.";
  else if (d >= 10) line += `, up ${d}% on last week to this point. Keep that pace and the month takes care of itself.`;
  else if (d <= -10) line += `, down ${Math.abs(d)}% on last week to this point. Consistency is the whole game: get back to last week's pace today.`;
  else line += `, level with last week to this point. Steady is good.`;
  if (n.replies) line += ` ${n.replies} ${n.replies === 1 ? "person" : "people"} came back to you.`;
  if (n.cash) line += ` ${money(cur, n.cash)} collected.`;
  return line;
}

function render(g, prof, base) {
  const cur = prof.currency || "GBP";
  const row = (label, k, isMoney) => {
    const a = g.now[k], p = g.prev[k];
    return `<tr><td style="padding:6px 0;color:#333">${label}</td><td style="padding:6px 8px;text-align:right;font-weight:600">${isMoney ? money(cur, a) : a}</td><td style="padding:6px 8px;text-align:right;color:#666">${isMoney ? money(cur, p) : p}</td><td style="padding:6px 0 6px 8px;color:#666;font-size:13px">${esc(delta(a, p))}</td></tr>`;
  };
  const bookRows = (b) => {
    const r = (label, k, isMoney) => `<tr><td style="padding:4px 0;color:#333">${label}</td><td style="padding:4px 8px;text-align:right;font-weight:600">${isMoney ? money(cur, b.now[k]) : b.now[k]}</td><td style="padding:4px 8px;text-align:right;color:#666">${isMoney ? money(cur, b.prev[k]) : b.prev[k]}</td></tr>`;
    return (b.track === "coach" ? "" : r("Cold calls", "calls")) + r("Emails sent", "emails") + r("DMs sent", "dms") + r("Responses", "replies") + r("Sales calls had", "held") + r("Customers won", "customers") + r("Money collected", "cash", true);
  };
  const hotList = (b) => b.hot.length
    ? `<p style="margin:6px 0 0;color:#555;font-size:14px">${esc(b.hot.map((l) => (l.business || l.name || "") + " (" + (l.status || "") + ")").join(", "))}${b.leads > 8 && b.hot.length === 8 ? " and more" : ""}</p>`
    : `<p style="margin:6px 0 0;color:#888;font-size:14px">Nobody waiting on you here.</p>`;
  const subject = `Your week in the CRM: ${g.now.sent} sent, ${g.now.replies} responses, ${money(cur, g.now.cash)} collected`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;max-width:600px">
<p style="margin:0 0 4px;font-size:13px;color:#666">Week of ${esc(g.B.from)}, to ${esc(g.today)}. Against last week to the same point.</p>
<h2 style="margin:0 0 14px;font-size:20px">Your week</h2>
<p style="margin:0 0 18px;padding:12px 14px;background:#F4F6FA;border-radius:8px">${esc(verdict(g, cur))}</p>
<table style="border-collapse:collapse;width:100%;font-size:15px"><thead><tr><th style="text-align:left;padding:0 0 6px;color:#888;font-weight:500;font-size:12px">EVERYTHING</th><th style="text-align:right;padding:0 8px 6px;color:#888;font-weight:500;font-size:12px">THIS WEEK</th><th style="text-align:right;padding:0 8px 6px;color:#888;font-weight:500;font-size:12px">LAST WEEK</th><th></th></tr></thead><tbody>
${row("Everything sent", "sent")}${row("Emails", "emails")}${row("DMs", "dms")}${row("Cold calls", "calls")}${row("Responses", "replies")}${row("Sales calls had", "held")}${row("Customers won", "customers")}${row("Money collected", "cash", true)}
</tbody></table>
${g.books.map((b) => `<h3 style="margin:22px 0 6px;font-size:15px;color:#333">${b.track === "coach" ? "Online coaches" : "Local businesses"} <span style="font-weight:400;color:#888">(${b.leads} on the list)</span></h3>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tbody>${bookRows(b)}</tbody></table>
<p style="margin:10px 0 0;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.04em">To follow up</p>${hotList(b)}`).join("")}
<p style="margin:26px 0 0"><a href="${esc(base)}#week" style="display:inline-block;padding:10px 16px;background:#2B6CF0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open the report</a></p>
<p style="margin:22px 0 0;color:#888;font-size:13px">Change how often this arrives in Settings, Sending.</p>
</div>`;
  const text = [subject, "", verdict(g, cur), "",
    `Everything sent: ${g.now.sent} (last week ${g.prev.sent})`, `Emails: ${g.now.emails} (${g.prev.emails})`, `DMs: ${g.now.dms} (${g.prev.dms})`, `Cold calls: ${g.now.calls} (${g.prev.calls})`,
    `Responses: ${g.now.replies} (${g.prev.replies})`, `Sales calls had: ${g.now.held} (${g.prev.held})`, `Customers won: ${g.now.customers} (${g.prev.customers})`, `Money collected: ${money(cur, g.now.cash)} (${money(cur, g.prev.cash)})`, "",
  ].concat(g.books.map((b) => `${b.track === "coach" ? "Online coaches" : "Local businesses"}: follow up ${b.hot.map((l) => l.business || l.name).join(", ") || "nobody waiting"}`)).concat(["", base + "#week"]).join("\n");
  return { subject, html, text };
}

async function sendMail(key, from, to, subject, html, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text }), signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Resend said " + res.status + ": " + body.slice(0, 160));
  return (JSON.parse(body) || {}).id || "";
}

async function sendOut(prof, mail, slot) {
  const d = prof.digest;
  const key = (process.env.RESEND_API_KEY || "").trim();
  const to = (d.to || (await readAllowedEmails())[0] || "").split(/[\s,;]+/).filter(Boolean);
  if (isDemo()) return json({ ok: true, simulated: true, subject: mail.subject, html: mail.html, to });
  if (!key) return json({ ok: false, error: "RESEND_API_KEY is not set, so the report cannot be emailed." }, 503);
  if (!prof.from) return json({ ok: false, error: "Add your sending address in Settings, You, first." }, 503);
  if (!to.length) return json({ ok: false, error: "Say where the report should go, in Settings, Sending." }, 400);
  try {
    const id = await sendMail(key, prof.from, to, mail.subject, mail.html, mail.text);
    if (slot) await saveDigest({ ...d, last_sent: dayIn(DIGEST_SLOTS[slot]) });
    return json({ ok: true, sent: to, subject: mail.subject, id });
  } catch (err) {
    return json({ ok: false, error: "Could not send the report: " + (err && err.message ? err.message : "error") }, 502);
  }
}

export default async function handler(req) {
  const url = new URL(req.url);
  if (req.method === "POST") {
    if (!(await isAuthed(req))) return json({ ok: false, login: true }, 401);
    const body = await req.json().catch(() => null);
    const html = String((body && body.html) || "").slice(0, 300000);
    if (!html) return json({ ok: false, error: "Nothing to send." }, 400);
    const mail = { subject: String((body && body.subject) || "Your week in the CRM").slice(0, 200), html, text: String((body && body.text) || "").slice(0, 60000) };
    return sendOut(await loadProfile(), mail, "");
  }
  if (req.method !== "GET") return json({ ok: false, error: "GET or POST" }, 405);
  const slot = url.searchParams.get("slot") || "";
  const preview = url.searchParams.get("preview") === "1";
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const cronOk = !!slot && !!cronSecret && timingSafeEqual(req.headers.get("authorization") || "", "Bearer " + cronSecret);
  if (!cronOk && !(await isAuthed(req))) return json({ ok: false, login: true }, 401);
  if (slot && !DIGEST_SLOTS[slot]) return json({ ok: false, error: "Unknown slot." }, 400);

  const prof = await loadProfile();
  const d = prof.digest;
  if (slot) {
    /* Three schedules a day; only the chosen morning sends, once, on the days
       the frequency asks for. */
    if (d.freq === "off") return json({ ok: true, skipped: "digest is off" });
    if (d.slot !== slot) return json({ ok: true, skipped: "not this slot" });
    const tz = DIGEST_SLOTS[slot], today = dayIn(tz);
    if (d.last_sent === today) return json({ ok: true, skipped: "already sent today" });
    if (d.freq === "weekly" && weekdayIn(tz) !== "Mon") return json({ ok: true, skipped: "not Monday" });
    if (d.freq === "monthly" && today.slice(8, 10) !== "01") return json({ ok: true, skipped: "not the 1st" });
  }
  const base = (process.env.CRM_URL || "").trim() || (url.origin + "/");
  const tz = DIGEST_SLOTS[slot || d.slot] || "Europe/London";
  const mail = render(await gather(prof, tz), prof, base);
  if (preview) return json({ ok: true, subject: mail.subject, html: mail.html, text: mail.text, to: d.to });
  return sendOut(prof, mail, slot);
}
