// Outreach dashboard data source. Runs in the student's own Vercel account.
// Reads their Resend account (RESEND_API_KEY env var), aggregates every send by
// outcome, day, and sending domain, and returns compact JSON for index.html.
// The API key never leaves the server; the browser only ever sees these totals.
import { subjectName, capForDay, warmupCeiling } from "./_outreach.js";
import { isAuthed } from "./_auth.js";
import { isDemo, demoFunnel, demoCustomerMix, DEMO_MAILBOXES, DEMO_DAILY_CEILING } from "./_demo.js";
import { trackOf } from "./_track.js";
import { leadsInPostgres, readLeads } from "./_leads.js";

export const config = { runtime: "edge" };

const WINDOW_DAYS = 30; // the dashboard judges the last 30 days
const MAX_PAGES = 20;   // safety stop: 20 x 100 = 2,000 emails, months of volume

// How each Resend outcome reads on the dashboard.
const GOOD = ["delivered", "opened", "clicked"];
const REACHED = ["delivered", "opened", "clicked", "complained"]; // landed somewhere

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function addressOf(from) {
  const m = /<([^>]+)>/.exec(String(from || ""));
  return (m ? m[1] : String(from || "")).trim().toLowerCase();
}
function domainOf(from) {
  const angle = /<([^>]+)>/.exec(from || "");
  const addr = (angle ? angle[1] : from || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at === -1 ? "unknown" : addr.slice(at + 1);
}

function dayOf(createdAt) {
  return String(createdAt || "").slice(0, 10); // "YYYY-MM-DD"
}

// Resend timestamps look like "2026-07-16 04:42:20.249721+00": a space instead of
// "T" and a bare "+00" zone, both of which JavaScript's date parser rejects.
function parseTime(createdAt) {
  const iso = String(createdAt || "")
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  return Date.parse(iso);
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

// Replies live in the student's leads Google Sheet (Resend cannot see inbound
// email). If LEADS_SHEET_URL is set to their Apps Script web app, read status
// counts and recent replies from it. Never breaks the page: returns
// {connected:false} or {connected:true, error} instead of throwing.
async function fetchSheet() {
  const base = (process.env.LEADS_SHEET_URL || "").trim();
  /* Leads in Postgres: the same figures straight from the table. The demo
     derives its statuses elsewhere and keeps the read it had. */
  if (!isDemo() && await leadsInPostgres()) return fromTable();
  if (!base) return { connected: false };
  const token = (process.env.LEADS_SHEET_TOKEN || "").trim();
  const sep = base.includes("?") ? "&" : "?";
  const target = base + sep + "stats=1" + (token ? "&token=" + encodeURIComponent(token) : "");
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { connected: true, error: "The sheet link did not return data. Make sure the web app is deployed so 'Anyone' can access it." };
    }
    if (!data.ok) return { connected: true, error: String(data.error || "the sheet rejected the request") };
    return figures(data);
  } catch (err) {
    return { connected: true, error: "Could not reach the sheet (" + (err && err.message ? err.message : "network error") + ")" };
  }
}

async function fromTable() {
  let leads;
  try { leads = await readLeads(); }
  catch (err) { return { connected: true, error: "Could not read your leads (" + (err && err.message ? err.message : "database error") + ")" }; }
  const statuses = {};
  const replied = [];
  for (const l of leads) {
    const s = String(l.status || "New").trim();
    statuses[s] = (statuses[s] || 0) + 1;
    if (/^(replied|interested)$/i.test(s)) replied.push({ business: l.business || "", when: l.contacted_on || "" });
  }
  replied.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  return figures({ total: leads.length, statuses, replied: replied.slice(0, 15) });
}

function figures(data) {
  const statuses = data.statuses || {};
  const get = (k) => statuses[k] || 0;
  const inSequence = get("Contacted") + get("Follow-up 1") + get("Follow-up 2") + get("Follow-up 3") + get("Follow-up 4") + get("Follow-up 5");
  const repliedCount = get("Replied") + get("Interested");
  const wonCount = get("Won") + get("Proposal sent");
  const emailed = inSequence + get("Nurturing") + repliedCount + wonCount + get("Removed") + get("Lost");

  /* Phone activity, read from the outcomes the power dialler writes. The six
     below are the only statuses a call button can set (see OUTCOMES in
     crm.js), so summing them is the number of calls that got an outcome.
     CAVEAT, and the panel says so: "Interested" and "Not a fit" can also be
     set by hand off an email reply, so `answered` is a ceiling, not a
     precise count. Log calls as their own events if that ever needs to be
     exact. */
  const answered = get("Interested") + get("Not a fit") + get("Callback");
  const unanswered = get("Voicemail") + get("No answer") + get("Bad number");
  const calls = {
    logged: answered + unanswered,
    answered,
    unanswered,
    interested: get("Interested"),
    not_a_fit: get("Not a fit"),
    callback: get("Callback"),
    voicemail: get("Voicemail"),
    no_answer: get("No answer"),
    bad_number: get("Bad number"),
    connect_rate: pct(answered, answered + unanswered),
    answered_is_ceiling: true,
  };

  return {
    connected: true,
    total: data.total || 0,
    calls,
    proposals_sent: get("Proposal sent"),
    won_deals: get("Won"),
    lost: get("Lost"),
    conversations: repliedCount + get("Proposal sent"),
    new_leads: get("New"),
    in_sequence: inSequence,
    nurturing: get("Nurturing"),
    replied: repliedCount,
    removed: get("Removed"),
    won: wonCount,
    emailed,
    reply_rate: pct(repliedCount + wonCount, emailed),
    recent_replies: (data.replied || []).slice(0, 6),
  };
}

// The plain-English read: healthy, throttle down, or stop and fix.
function verdict(t, warmup, sheet) {
  const notes = [];
  const extras = [];
  if (sheet && sheet.connected && !sheet.error) {
    if (sheet.replied > 0) extras.push(`${sheet.replied} lead(s) have replied. Answer them today; speed wins these deals.`);
    if (sheet.emailed >= 100 && sheet.replied + sheet.won === 0) extras.push(`No replies yet after ${sheet.emailed} leads emailed. Deliverability looks fine, so sharpen the video demo or pick better-fit leads.`);
  }
  if (warmup && t.total > 0 && warmup.sent_today === 0 && warmup.remaining > 0) {
    extras.push("Nothing has gone out yet today. Run the send once (or check your daily schedule) so the follow-ups stay on time.");
  }
  if (t.total < 10) {
    return {
      level: "neutral",
      title: "Too early to judge",
      notes: ["Fewer than 10 emails sent so far. Keep going; the numbers mean something after a week or two."].concat(extras),
    };
  }
  if (t.openTrackingOff) {
    notes.push("Opens look like zero, which usually means open tracking is switched off. In Resend go to your domain settings and turn on open and click tracking.");
  }
  if (t.bounceRate > 5 || t.spamRate > 0.3) {
    if (t.bounceRate > 5) notes.push(`Bounce rate is ${t.bounceRate}% (should be under 2%). The list has bad addresses; scrape fresh leads and let the tool drop dead domains.`);
    if (t.spamRate > 0.3) notes.push(`${t.spamRate}% of recipients marked you as spam (should be under 0.1%). Stop sending on this domain for a few days, soften the copy, and consider starting a fresh domain.`);
    return { level: "critical", title: "Pause and fix before sending more", notes: notes.concat(extras) };
  }
  if (t.bounceRate > 2 || t.spamRate > 0.1) {
    if (t.bounceRate > 2) notes.push(`Bounce rate is ${t.bounceRate}%, a little high (aim under 2%). Watch it for a few days.`);
    if (t.spamRate > 0.1) notes.push(`Spam complaints at ${t.spamRate}% (aim under 0.1%). Do not raise your daily limit yet.`);
    return { level: "warning", title: "Throttle down and watch for a few days", notes: notes.concat(extras) };
  }
  if (!t.openTrackingOff && t.reached >= 50 && t.openRate < 15) {
    notes.push(`Only ${t.openRate}% of delivered emails are being opened (aim for 20%+). Subject lines may need work, or the domain is still building trust. Hold your current pace.`);
    return { level: "warning", title: "Deliverable, but opens are low", notes: notes.concat(extras) };
  }
  notes.push("Bounces and spam complaints are inside safe limits.");
  if (t.atCeiling) {
    notes.push("You are at your daily limit and the numbers are healthy. Raise the limit by about five a day, checking back here each time.");
  } else {
    notes.push("Let the warm-up keep running. Once you are steady at your limit with numbers like these, raise it a little at a time.");
  }
  return { level: "good", title: "Healthy. Keep sending", notes: notes.concat(extras) };
}

/* The Email health page reads this endpoint straight off Resend. On the demo
   that put the real 70 sends beside a Results tab claiming 1,160, so the demo
   answers from the same derived funnel as everything else, in the identical
   shape. Nothing here is read from Resend or the sheet. */
async function demoStats() {
  const fn = demoFunnel(await demoCustomerMix());
  /* The Email health page reports the last thirty days, so it gets the last
     thirty days of sends, not the whole history. Handing it the lifetime total
     put seven weeks of sending into a one-month chart. */
  const lifetime = fn.email;
  const share = lifetime.sent ? (lifetime.sent_30d || lifetime.sent) / lifetime.sent : 1;
  const e = { ...lifetime, sent: lifetime.sent_30d || lifetime.sent,
              reached: Math.round(lifetime.reached * share), opened: Math.round(lifetime.opened * share),
              clicked: Math.round(lifetime.clicked * share), bounced: Math.round(lifetime.bounced * share) };
  const DAY = 86400000;

  /* Thirty days of sends that add up to exactly e.sent. Weekdays carry the
     volume, weekends carry a trickle, the way a scheduled sender behaves. */
  const days = [];
  let weights = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const dow = d.getUTCDay();
    weights.push(dow === 0 || dow === 6 ? 0.25 : 1);
    days.push({ day: d.toISOString().slice(0, 10), sent: 0 });
  }
  const wsum = weights.reduce((a, b) => a + b, 0);
  let placed = 0;
  days.forEach((row, i) => { row.sent = Math.floor((weights[i] / wsum) * e.sent); placed += row.sent; });
  for (let i = days.length - 1; placed < e.sent; i--) { days[i].sent += 1; placed += 1; }   // remainder onto the latest days
  const maxDay = Math.max(1, ...days.map((d) => d.sent));
  const sentToday = days[days.length - 1].sent;

  /* The demo owner's own mailboxes, the same five api/outreach-settings lists
     with the same split, so the accounts table, the domain table and the
     sidebar meter all agree. Nothing here names the real operator's domain.
     Two addresses on one domain used to stand in for all of it, which is both
     a contradiction of the sender screen and how you get a whole desk's
     sending filed under one reputation. */
  const demoFrom = DEMO_MAILBOXES.map((b) => [b.from, b.share]);
  const senders = demoFrom.map(([f, share], i) => {
    const domain = domainOf(f);
    const sd = {}; let sent = 0;
    /* Whole emails, with the last mailbox carrying the rounding so the
       addresses add up to the day exactly. */
    days.forEach((d) => {
      const before = demoFrom.slice(0, i).reduce((a, [, sh]) => a + Math.round(d.sent * sh), 0);
      const n = i === demoFrom.length - 1 ? Math.max(0, d.sent - before) : Math.round(d.sent * share);
      sd[d.day] = n; sent += n;
    });
    /* Each address's outcomes come off its own sends at the funnel's rates, so
       an address can never report more delivered than it sent. */
    const bounced = Math.round(sent * (e.bounce_rate || 0) / 100), reached = sent - bounced;
    const opened = Math.round(reached * (e.open_rate || 0) / 100), clicked = e.opened ? Math.round(opened * (e.clicked / e.opened)) : 0;
    return { from: f, address: addressOf(f), domain, sent, reached, opened, clicked, bounced, spam: i === 0 ? 1 : 0, first_day: days[0].day, last_day: days[days.length - 1].day, days: sd };
  });

  /* Recent sends, named after businesses that appear elsewhere in the demo so
     the pages agree with each other rather than each inventing their own list. */
  let recent = [];
  try {
    const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const r = await fetch(url + "/rest/v1/deals_demo?select=business,closed_on&order=closed_on.desc&limit=20",
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    const rows = r.ok ? await r.json() : [];
    const subj = ["Quick question about {b}", "{b} - had a look at your website", "Made you something, {b}", "Following up on your new site"];
    const ev = ["opened", "delivered", "clicked", "opened", "delivered"];
    recent = rows.map((row, i) => ({
      to: row.business.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") + "@example.com",
      subject: subj[i % subj.length].replace("{b}", row.business),
      last_event: ev[i % ev.length],
      created_at: String(row.closed_on) + " 09:" + String(10 + (i % 45)).padStart(2, "0"),
    }));
  } catch { recent = []; }

  const totals = {
    total: e.sent, reached: e.reached, openRate: e.open_rate, clickRate: Math.round((e.clicked / e.reached) * 1000) / 10,
    bounceRate: e.bounce_rate, spamRate: 0.1, openTrackingOff: false, atCeiling: true,
  };
  /* Against what the five mailboxes allow between them, not what one allows. */
  const warmup = { day: 31, cap_today: DEMO_DAILY_CEILING, ceiling: DEMO_DAILY_CEILING,
                   sent_today: Math.min(sentToday, DEMO_DAILY_CEILING),
                   remaining: Math.max(0, DEMO_DAILY_CEILING - sentToday), complete: true };
  /* This panel is the EMAIL pipeline, so every figure in it is the email
     channel's own. It used to take the customer count from every channel, so
     a screen reporting 638 businesses emailed also claimed all 17 customers
     came out of them, and subtracted those 17 from the email replies, which
     turned an 8% reply rate into 5.3% two lines below where it says 8%. The
     five segments add up to every business with an address. */
  const em = fn.channels.email;
  const nurturing = Math.round(em.in_sequence * 0.15);   // the Nurturing share of the sequence spread
  const sheet = {
    connected: true, total: 0, calls: fn.calls, proposals_sent: Math.round(em.replied * 0.25), won_deals: em.customers,
    lost: Math.max(0, em.replied - em.customers), conversations: em.replied,
    new_leads: em.queued, in_sequence: Math.max(0, em.in_sequence - nurturing), nurturing,
    replied: em.replied, removed: 0, won: em.customers, emailed: em.emailed, reply_rate: em.reply_rate,
    recent_replies: recent.slice(0, 6).map((r) => ({ business: r.subject.split(" - ")[0].replace(/^Quick question about |^Made you something, |^Following up on your new site$/, "") || "Business", when: r.created_at })),
  };

  return {
    generated_at: new Date().toISOString(), window_days: WINDOW_DAYS, partial: "", demo: true,
    total: e.sent,
    counts: { delivered: e.reached - e.opened, opened: e.opened - e.clicked, clicked: e.clicked, bounced: e.bounced, complained: 1 },
    stats: { sent: e.sent, reached: e.reached, opened: e.opened, clicked: e.clicked, bounced: e.bounced, spam: 1, failed: 0,
             open_rate: e.open_rate, click_rate: totals.clickRate, bounce_rate: e.bounce_rate, spam_rate: 0.1, max_day: maxDay, open_tracking_off: false },
    days, warmup, sheet,
    domains: Object.values(senders.reduce((acc, sn) => {
      const d = (acc[sn.domain] ||= { domain: sn.domain, sent: 0, reached: 0, opened: 0, bounced: 0, spam: 0 });
      d.sent += sn.sent; d.reached += sn.reached; d.opened += sn.opened; d.bounced += sn.bounced; d.spam += sn.spam;
      return acc;
    }, {})).sort((a, b) => b.sent - a.sent),
    senders,
    templates: [
      { template: "First touch", subject: "Quick question about {business}", sent: Math.round(e.sent * 0.46), opened: Math.round(e.sent * 0.46 * 0.36), clicked: Math.round(e.sent * 0.46 * 0.09) },
      { template: "Follow-up 1", subject: "{business} - had a look at your website", sent: Math.round(e.sent * 0.30), opened: Math.round(e.sent * 0.30 * 0.33), clicked: Math.round(e.sent * 0.30 * 0.08) },
      { template: "Follow-up 2", subject: "Made you something, {business}", sent: Math.round(e.sent * 0.24), opened: Math.round(e.sent * 0.24 * 0.31), clicked: Math.round(e.sent * 0.24 * 0.07) },
    ],
    recent,
    verdict: verdict(totals, warmup, sheet),
  };
}

export default async function handler(req) {
  const url = new URL(req.url);
  // The gate: a login cookie (AUTH_SECRET) or the legacy ?k= key (DASH_KEY).
  // Fail closed: with neither set nobody is let in, never everybody.
  const lock = (process.env.DASH_KEY || "").trim();
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  const keyOk = !!lock && url.searchParams.get("k") === lock;
  const cookieOk = !!authSecret && (await isAuthed(req));
  if (!keyOk && !cookieOk) {
    const out = { ok: false };
    if (authSecret || !lock) out.login = true; // tells the page to show the login screen
    else out.error = "This dashboard is locked. Open it with ?k=your-key added to the address.";
    return json(out, 401);
  }
  /* The coach book has no email story of its own yet. Resend is one account
     shared by both books, so its figures cannot be split, and the demo's
     generated story belongs to the local book. Either one on a coach screen
     read as coach sending: "1,648 emails, 8% reply" against zero coaches.
     So the coach side runs the real computation below over an empty window,
     which yields the honest shape with honest zeros, and needs no Resend
     key to do it. */
  const track = trackOf(req);
  const coach = track === "coach";
  if (isDemo() && !coach) return json(await demoStats());

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey && !coach) {
    return json({ error: "RESEND_API_KEY is not set. In Vercel: Settings, Environment Variables, add RESEND_API_KEY, then redeploy." }, 500);
  }

  // Replies come from the student's sheet, which is the local book.
  const sheetPromise = coach ? Promise.resolve({ connected: true, replied: 0, emailed: 0, won: 0, reply_rate: 0 }) : fetchSheet();

  // Pull the send history, newest first, until we are past the window.
  const rows = [];
  let after = "";
  let failure = "";
  const cutoff = Date.now() - WINDOW_DAYS * 86400000;
  for (let page = 0; !coach && page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    let res;
    try {
      res = await fetch("https://api.resend.com/emails?" + qs, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      failure = "Could not reach Resend (" + (err && err.message ? err.message : "network error") + ")";
      break;
    }
    if (res.status === 401) return json({ error: "Resend rejected the API key (401). Check RESEND_API_KEY in Vercel." }, 502);
    if (!res.ok) { failure = "Resend returned HTTP " + res.status; break; }
    const body = await res.json();
    const batch = body.data || [];
    rows.push(...batch);
    if (!body.has_more || batch.length === 0) break;
    const oldest = batch[batch.length - 1];
    after = oldest.id;
    if (parseTime(oldest.created_at) < cutoff) break;
  }
  if (failure && rows.length === 0) return json({ error: failure }, 502);

  // Keep only the window, newest first as Resend returns them.
  const windowRows = rows.filter((r) => {
    const t = parseTime(r.created_at);
    return !Number.isNaN(t) && t >= cutoff;
  });

  // Aggregate: outcomes, per-day volume, per-domain health, per-template wins.
  const counts = {};
  const byDay = {};
  const byDomain = {};
  const byTemplate = {};
  /* Per sending address as well as per domain: the cap is set per address,
     and one address going bad is the thing to catch before it takes the
     domain with it. */
  const bySender = {};
  for (const r of windowRows) {
    const ev = r.last_event || "unknown";
    counts[ev] = (counts[ev] || 0) + 1;
    const day = dayOf(r.created_at);
    byDay[day] = (byDay[day] || 0) + 1;
    const dom = domainOf(r.from);
    const d = (byDomain[dom] ||= { domain: dom, sent: 0, reached: 0, opened: 0, bounced: 0, spam: 0 });
    d.sent += 1;
    if (REACHED.includes(ev)) d.reached += 1;
    if (ev === "opened" || ev === "clicked") d.opened += 1;
    if (ev === "bounced") d.bounced += 1;
    if (ev === "complained") d.spam += 1;
    const fromKey = String(r.from || "").trim() || "unknown";
    const sn = (bySender[fromKey] ||= { from: fromKey, address: addressOf(fromKey), domain: dom, sent: 0, reached: 0, opened: 0, clicked: 0, bounced: 0, spam: 0, first_day: day, last_day: day, days: {} });
    sn.sent += 1;
    if (REACHED.includes(ev)) sn.reached += 1;
    if (ev === "opened" || ev === "clicked") sn.opened += 1;
    if (ev === "clicked") sn.clicked += 1;
    if (ev === "bounced") sn.bounced += 1;
    if (ev === "complained") sn.spam += 1;
    sn.days[day] = (sn.days[day] || 0) + 1;
    if (day < sn.first_day) sn.first_day = day;
    if (day > sn.last_day) sn.last_day = day;
    const name = subjectName(r.subject);
    if (name) {
      const t = (byTemplate[name] ||= { template: name, subject: (r.subject || "").trim(), sent: 0, opened: 0, clicked: 0 });
      t.sent += 1;
      if (ev === "opened" || ev === "clicked") t.opened += 1;
      if (ev === "clicked") t.clicked += 1;
    }
  }

  const total = windowRows.length;
  const reached = REACHED.reduce((n, ev) => n + (counts[ev] || 0), 0);
  const openedPlus = (counts.opened || 0) + (counts.clicked || 0);
  const bounced = counts.bounced || 0;
  const complained = counts.complained || 0;
  const failed = counts.failed || 0;

  // A continuous last-30-days series, zero-filled, oldest to newest.
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d, sent: byDay[d] || 0 });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.sent));

  const totals = {
    total,
    reached,
    openRate: pct(openedPlus, reached),
    clickRate: pct(counts.clicked || 0, reached),
    bounceRate: pct(bounced, total),
    spamRate: pct(complained, total),
    openTrackingOff: openedPlus === 0 && reached >= 10,
    atCeiling: days.slice(-7).filter((d) => d.sent >= warmupCeiling() - 5).length >= 3,
  };

  // Warm-up: day number counts from the earliest send we can see (good enough,
  // since past day 19 the ramp is complete anyway). "Today" is the last UTC bucket.
  let earliest = Infinity;
  for (const r of windowRows) {
    const t = parseTime(r.created_at);
    if (!Number.isNaN(t) && t < earliest) earliest = t;
  }
  const dayNumber = earliest === Infinity ? 1 : Math.floor((Date.now() - earliest) / 86400000) + 1;
  const capToday = capForDay(dayNumber);
  const sentToday = days.length ? days[days.length - 1].sent : 0;
  const warmup = {
    day: dayNumber,
    cap_today: capToday,
    ceiling: warmupCeiling(),
    sent_today: sentToday,
    remaining: Math.max(0, capToday - sentToday),
    complete: capToday >= warmupCeiling(),
  };

  const sheet = await sheetPromise;

  return json({
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    partial: failure || "",
    total,
    counts,
    stats: {
      sent: total,
      reached,
      opened: openedPlus,
      clicked: counts.clicked || 0,
      bounced,
      spam: complained,
      failed,
      open_rate: totals.openRate,
      click_rate: totals.clickRate,
      bounce_rate: totals.bounceRate,
      spam_rate: totals.spamRate,
      max_day: maxDay,
      open_tracking_off: totals.openTrackingOff,
    },
    days,
    warmup,
    sheet,
    domains: Object.values(byDomain).sort((a, b) => b.sent - a.sent),
    senders: Object.values(bySender).sort((a, b) => b.sent - a.sent),
    templates: Object.values(byTemplate).sort((a, b) => b.sent - a.sent),
    recent: windowRows.slice(0, 20).map((r) => ({
      to: Array.isArray(r.to) ? r.to[0] : r.to,
      subject: r.subject,
      last_event: r.last_event,
      created_at: String(r.created_at || "").slice(0, 16),
    })),
    verdict: verdict(totals, warmup, sheet),
  });
}
