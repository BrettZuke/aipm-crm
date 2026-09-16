// The referral programme.
//   GET  -> every referral on the sheet, the directory of people who can be
//           named as a referrer, and the reward config the page renders.
//   POST {action:"create"} -> logs a referral, then emails both people.
//   POST {action:"paid"}   -> marks a reward paid and emails the referrer.
//
// Two rules are enforced here rather than in the page, because the page is just
// a form and anybody can post to this endpoint directly:
//
//   1. The referrer must already exist in the customer directory. That check is
//      what makes one shared keyword safe: the keyword leaks eventually, but it
//      is worthless without the name of a real existing customer.
//   2. Cash to any one person is capped per calendar year (REFERRAL_CASH_CAP,
//      450 by default). Past the cap the reward becomes credit against their
//      own next job instead, so nobody crosses the line where a payment has to
//      be reported to the tax office.
//
// These emails are transactional and must go out the second the desk hits save,
// so they send here directly and never touch the cold-outreach warm-up counter
// in send.js. A referrer who hears about their referral tomorrow afternoon has
// already lost the moment.
import { isAuthed } from "./_auth.js";
import { trackOf, stampTrack } from "./_track.js";
import { loadProfile } from "./_profile.js";
import { isDemo } from "./_demo.js";
import { leadsInPostgres } from "./_leads.js";
import { readCustomersPg, addReferralPg, markReferralPaidPg, updateReferralPg, deleteReferralPg, saveTermsPg } from "./_customers.js";

const DEFAULT_CASH_CAP = 450;

/* One book of business. Only the demo's referrals live in the store: a real
   CRM's are rows on the sheet, which is the local book by definition. */
const only = (path, track) => path + (path.includes("?") ? "&" : "?") + "track=eq." + track;

// Apps Script is slow and its latency is spiky: a warm call answers in about
// three seconds, but a cold one, or one queued behind another execution on the
// same account, regularly takes fifteen or more. Ten seconds was under that,
// so a save could abort on a sheet that was working perfectly well. The
// function itself is allowed sixty seconds (see vercel.json), so each leg gets
// a genuinely generous slice and Resend gets its own so a stall there can never
// hold the whole request open.
const SHEET_TIMEOUT_MS = 30000;
const EMAIL_TIMEOUT_MS = 15000;

// An aborted fetch says "The operation was aborted due to timeout", which tells
// the person at the desk nothing about what to do next. What they need to know
// is whether it is safe to press the button again.
function sheetError(err, advice) {
  const timedOut = err && (err.name === "TimeoutError" || /aborted due to timeout/i.test(String(err.message || "")));
  if (timedOut) return "Google took too long to answer. " + advice;
  return String(err.message || err);
}

function sheetTarget(params) {
  const base = (process.env.LEADS_SHEET_URL || "").trim();
  const token = (process.env.LEADS_SHEET_TOKEN || "").trim();
  const sep = base.includes("?") ? "&" : "?";
  return base + sep + params + (token ? "&token=" + encodeURIComponent(token) : "");
}

// The terms come from the sheet's "Referral Terms" tab first, so the owner can
// change what they pay from inside the CRM without a redeploy and every client's
// copy carries its own numbers. Environment variables are only the fallback for
// a sheet that has not had its terms filled in yet.
function config(terms = {}) {
  const prof = arguments.length > 1 ? arguments[1] : null;
  const pick = (sheetVal, envVal) => {
    const s = String(sheetVal == null ? "" : sheetVal).trim();
    return s || String(envVal == null ? "" : envVal).trim();
  };
  const reward = Number(pick(terms.reward, process.env.REFERRAL_REWARD).replace(/[^0-9.]/g, "")) || 0;
  const cap = Number(pick(terms.cash_cap, process.env.REFERRAL_CASH_CAP).replace(/[^0-9.]/g, ""));
  /* The label follows the profile's currency, so the terms line, the tiles
     and the emails all say the same money. */
  const symbol = { GBP: "\u00a3", USD: "$", EUR: "\u20ac" }[(prof && prof.currency) || ""] || "$";
  return {
    reward,
    reward_label: reward ? symbol + reward : "",
    symbol,
    discount: pick(terms.discount, process.env.REFERRAL_DISCOUNT),
    keyword: pick(terms.keyword, process.env.REFERRAL_KEYWORD),
    /* The page new customers are sent to: set in the CRM, or the old variable. */
    page: pick(terms.page, process.env.THANKYOU_URL),
    cash_cap: cap || DEFAULT_CASH_CAP,
    business: pick(terms.business, (prof && (prof.business || prof.name)) || process.env.REFERRAL_BUSINESS || process.env.OUTREACH_SENDER_NAME),
    phone: (prof && prof.phone) || (process.env.REFERRAL_PHONE || process.env.OUTREACH_SENDER_PHONE || "").trim(),
    from: (prof && prof.from) || (process.env.RESEND_FROM || "").trim(),
    reply_to: (prof && prof.reply_to) || (process.env.RESEND_REPLY_TO || "").trim() || (process.env.RESEND_FROM || "").trim(),
    key: (process.env.RESEND_API_KEY || "").trim(),
    /* The day a referral is stamped with, in the business's own time. */
    tz: (process.env.REFERRAL_TZ || (prof && prof.timezone) || "Europe/London").trim(),
  };
}

function dayIn(tz) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

async function readSheet(track) {
  /* Same reason as customers.js: the sheet is the local book and carries no
     track, so serving it on the coach side leaked local names, emails and the
     referral directory. Referrals are a local-business motion end to end, so
     the coach book gets an empty one rather than a half-working page. */
  if (track === "coach") return { ok: true, referrals: [], customers: [], directory: [], config: {} };
  const res = await fetch(sheetTarget("referrals=1"), { signal: AbortSignal.timeout(SHEET_TIMEOUT_MS) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The sheet link did not return data. Re-paste the latest Code.gs and redeploy the web app.");
  }
  if (!data.ok) throw new Error(String(data.error || "the sheet rejected the request"));
  return data;
}

async function writeSheet(payload) {
  const res = await fetch((process.env.LEADS_SHEET_URL || "").trim(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, token: (process.env.LEADS_SHEET_TOKEN || "").trim() }),
    signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The sheet did not accept the write. Re-paste the latest Code.gs.");
  }
  if (!data.ok) throw new Error(String(data.error || "the sheet rejected the update"));
  return data;
}

async function sendOne(cfg, to, subject, html, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: [to], reply_to: cfg.reply_to, subject, html, text }),
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Resend HTTP " + res.status + ": " + body.slice(0, 200));
  return JSON.parse(body).id || "";
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// One plain, readable shell. No images and no external CSS, so it renders the
// same in Gmail, Outlook and every phone client, and never trips a spam filter
// for being a bare tracking pixel in a table.
function wrap(bodyHtml, cfg) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;max-width:520px">
${bodyHtml}
<p style="margin:22px 0 0;color:#666;font-size:14px">${esc(cfg.business)}${cfg.phone ? " &middot; " + esc(cfg.phone) : ""}</p>
</div>`;
}

const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "there";

// To the new customer. The discount is a thank you for their business, full
// stop. It is never offered in exchange for a review, and no review is asked
// for in this email, because tying the two together breaks Google's rules and
// gets the client's reviews stripped.
export function welcomeEmail(cfg, r) {
  const subject = `Welcome to ${cfg.business}`;
  const lines = [
    `<p>Hi ${esc(firstName(r.customer))},</p>`,
    `<p>Thanks for coming to us, and thanks to ${esc(firstName(r.referrer))} for the introduction.</p>`,
  ];
  if (cfg.discount) {
    lines.push(`<p><strong>${esc(cfg.discount)}</strong> is on your first job with us. It is already applied, so there is nothing for you to do.</p>`);
  }
  lines.push(`<p>Anything you need in the meantime, just reply to this and it comes straight to us.</p>`);
  const html = wrap(lines.join("\n"), cfg);
  const text = `Hi ${firstName(r.customer)},

Thanks for coming to us, and thanks to ${firstName(r.referrer)} for the introduction.
${cfg.discount ? `\n${cfg.discount} is on your first job with us. It is already applied, so there is nothing for you to do.\n` : ""}
Anything you need in the meantime, just reply to this and it comes straight to us.

${cfg.business}${cfg.phone ? " · " + cfg.phone : ""}`;
  return { subject, html, text };
}

// To the referrer, the moment it is logged. Pending, not paid, because the job
// has not been done yet.
export function pendingEmail(cfg, r) {
  const amount = r.reward_type === "credit" ? esc(r.reward_label) + " of credit" : esc(r.reward_label);
  const subject = `${firstName(r.customer)} said you sent them`;
  const lines = [
    `<p>Hi ${esc(firstName(r.referrer))},</p>`,
    `<p>${esc(r.customer)} came to us today and said you sent them. Thank you, genuinely.</p>`,
    `<p>Once their job is done and paid for, <strong>${amount}</strong> is yours.${r.reward_type === "credit" ? " That one comes off your own next job with us." : " We will send it over."}</p>`,
    `<p>We will let you know the moment it lands.</p>`,
  ];
  const html = wrap(lines.join("\n"), cfg);
  const text = `Hi ${firstName(r.referrer)},

${r.customer} came to us today and said you sent them. Thank you, genuinely.

Once their job is done and paid for, ${r.reward_type === "credit" ? r.reward_label + " of credit is yours, off your own next job with us." : r.reward_label + " is yours and we will send it over."}

We will let you know the moment it lands.

${cfg.business}${cfg.phone ? " · " + cfg.phone : ""}`;
  return { subject, html, text };
}

// To the referrer when the owner marks it paid. This is the email the whole
// programme lives or dies on: send somebody a friend, hear nothing back, never
// bother again.
export function paidEmail(cfg, r) {
  const credit = r.reward_type === "credit";
  const subject = credit ? `Your ${r.reward_label} credit is on your account` : `Your ${r.reward_label} is on its way`;
  const lines = [
    `<p>Hi ${esc(firstName(r.referrer))},</p>`,
    `<p>${esc(r.customer)}'s job is done, so that is <strong>${esc(r.reward_label)}</strong> to you.</p>`,
    credit
      ? `<p>It is sitting on your account as credit. Just mention it next time you book and we will take it off.</p>`
      : `<p>It is on its way to you now.</p>`,
    `<p>Send anybody else our way and we will do the same again. Thanks again.</p>`,
  ];
  const html = wrap(lines.join("\n"), cfg);
  const text = `Hi ${firstName(r.referrer)},

${r.customer}'s job is done, so that is ${r.reward_label} to you.

${credit ? "It is sitting on your account as credit. Just mention it next time you book and we will take it off." : "It is on its way to you now."}

Send anybody else our way and we will do the same again. Thanks again.

${cfg.business}${cfg.phone ? " · " + cfg.phone : ""}`;
  return { subject, html, text };
}

const norm = (s) => String(s || "").trim().toLowerCase();

// Cash already paid or promised to this person inside the current calendar year.
// Calendar year, not a rolling window, because that is how reporting thresholds
// are measured, and it resets somewhere the client can understand.
function cashThisYear(referrals, email, name) {
  const year = new Date().getFullYear();
  let total = 0;
  for (const r of referrals) {
    if (String(r.status).toLowerCase() === "void") continue;
    if (String(r.reward_type).toLowerCase() !== "cash") continue;
    const sameEmail = email && norm(r.referrer_email) === norm(email);
    const sameName = !email && norm(r.referrer) === norm(name);
    if (!sameEmail && !sameName) continue;
    const rowYear = Number(String(r.date).slice(0, 4));
    if (rowYear && rowYear !== year) continue;
    total += Number(r.reward) || 0;
  }
  return total;
}

function json(res, body, status = 200) {
  res.status(status).setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const track = trackOf(req);
  const lock = (process.env.DASH_KEY || "").trim();
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed: with neither AUTH_SECRET nor DASH_KEY set nobody is let in. */
  const signedIn = authSecret ? await isAuthed(req) : false;
  const keyed = lock ? url.searchParams.get("k") === lock : false;
  if (!signedIn && !keyed) return json(res, { ok: false, error: "Not signed in.", login: true }, 401);

  /* The demo never touches the sheet: its referrals, and its terms, live in
     tables of their own, so what is logged in the demo is still there tomorrow. */
  if (isDemo()) {
    try { return await demoReferrals(req, res); }
    catch (err) { return json(res, { ok: false, error: "The demo's referral store did not answer." }, 502); }
  }

  const onPg = await leadsInPostgres();
  if (!onPg && !(process.env.LEADS_SHEET_URL || "").trim()) {
    return json(res, {
      ok: false,
      error: "No database connected yet. In Vercel add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then redeploy.",
    }, 503);
  }
  /* Same shape from either store, so nothing below cares which it is. */
  const readStore = (t) => (onPg ? readCustomersPg(t) : readSheet(t));

  if (req.method === "GET") {
    try {
      const data = await readStore(track);
      const cfg = config(data.terms, await loadProfile());
      /* The directory is the customer list, and on the demo the real one was
         being served: real practices and vets with real phone numbers, beside
         a Customers page showing the demo's 29. The demo's directory is its own
         customers, read from deals_demo, the same source the Customers page
         uses, so the two agree. Referral rows are left empty on the demo
         rather than invented, and the sending identity is the demo's. */
      let directory = data.directory || [], referrals = data.referrals || [], from = cfg.from;
      if (isDemo()) {
        try {
          const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
          const r = await fetch(url + "/rest/v1/" + only("deals_demo?select=business,closed_on,notes&order=closed_on.desc", track),
            { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
          const rows = r.ok ? await r.json() : [];
          directory = rows.map((d) => ({
            name: d.business,
            email: String(d.business).toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") + "@example.com",
            phone: "", note: d.notes || "",
          }));
        } catch { directory = []; }
        referrals = [];
        from = "";
      }
      return json(res, {
        ok: true,
        demo: isDemo(),
        referrals,
        directory,
        config: {
          reward: cfg.reward,
          reward_label: cfg.reward_label,
          discount: cfg.discount,
          keyword: cfg.keyword,
          cash_cap: cfg.cash_cap,
          business: cfg.business,
          email_ready: Boolean(cfg.key && cfg.from),
          from,
          // Where the customer-facing thank-you page is pointed, so the desk can
          // see at a glance whether new customers are actually being sent there
          // or whether it is still just the template sitting on the shelf.
          page: (typeof cfg !== "undefined" && cfg && cfg.page) || "",
        thankyou_url: (typeof cfg !== "undefined" && cfg && cfg.page) || (process.env.THANKYOU_URL || "").trim(),
        },
      });
    } catch (err) {
      return json(res, { ok: false, error: sheetError(err, "Nothing has changed. Reload the page.") }, 502);
    }
  }

  if (req.method !== "POST") return json(res, { ok: false, error: "POST or GET only" }, 405);

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // ---- save the terms ------------------------------------------------------
  /* Edit or remove a referral the desk logged. Both go straight to the
     sheet's Referrals tab through the script's newer ops. */
  if (body.action === "update" || body.action === "delete") {
    const row = Number(body.row);
    if (!row) return json(res, { ok: false, error: "Which referral?" }, 400);
    /* Referrals live on the sheet, which is the local book. The coach side has
       no referrals page; this stops a coach-stamped call reaching the sheet
       anyway and changing somebody else's row. */
    if (track !== "local") return json(res, { ok: false, error: "Referrals belong to the local book." }, 400);
    const allowed = ["customer", "customer_email", "customer_phone", "job", "referrer", "referrer_email", "reward", "reward_type", "status", "payment_ref"];
    const fields = {};
    for (const k of allowed) if (body.fields && body.fields[k] != null) fields[k] = body.fields[k];
    let r;
    try {
      r = onPg
        ? (body.action === "update" ? await updateReferralPg(row, track, fields) : await deleteReferralPg(row, track))
        : await writeSheet(body.action === "update" ? { op: "referral_update", row, fields } : { op: "referral_delete", row });
    } catch (err) {
      return json(res, { ok: false, error: sheetError(err, "Nothing was changed, so try again.") }, 502);
    }
    const took = r && r.ok && (r.updated != null || r.deleted != null);
    if (!took) return json(res, { ok: false, error: (r && r.error) || "That referral was not changed. Check the database connection and try again." }, 502);
    return json(res, { ok: true, row });
  }

  if (body.action === "terms") {
    const t = body.terms || {};
    const reward = Number(String(t.reward || "").replace(/[^0-9.]/g, ""));
    if (!reward) {
      return json(res, { ok: false, error: "Put in what a referral pays, as a number. For example 150." }, 400);
    }
    const cap = Number(String(t.cash_cap || "").replace(/[^0-9.]/g, "")) || DEFAULT_CASH_CAP;
    if (cap > 500) {
      return json(res, {
        ok: false,
        error: "Keep the yearly cash cap at 500 or under. Past that most tax rules make you report the payment, which is the whole reason the cap is here.",
      }, 400);
    }
    try {
      const page = String(t.page || "").trim().slice(0, 500);
      if (page && !/^https?:\/\//i.test(page)) return json(res, { ok: false, error: "The customer page link needs to start with http:// or https://" }, 400);
      const terms = {
        reward: String(reward),
        discount: String(t.discount || "").trim(),
        keyword: String(t.keyword || "").trim(),
        business: String(t.business || "").trim(),
        cash_cap: String(cap),
        page,
      };
      const saved = onPg ? await saveTermsPg(terms) : await writeSheet({ op: "referral_terms", terms });
      return json(res, { ok: true, terms: saved.terms || {} });
    } catch (err) {
      return json(res, { ok: false, error: sheetError(err, "Reload the page to see whether the terms saved.") }, 502);
    }
  }

  // ---- mark an existing referral paid -------------------------------------
  if (body.action === "paid") {
    const row = Number(body.row);
    if (!row) return json(res, { ok: false, error: "Which referral? No row given." }, 400);
    let existing;
    let cfg;
    try {
      const data = await readStore(track);
      cfg = config(data.terms, await loadProfile());
      existing = (data.referrals || []).find((r) => r.row === row);
    } catch (err) {
      return json(res, { ok: false, error: sheetError(err, "Nothing was marked paid, so try again.") }, 502);
    }
    if (!existing) return json(res, { ok: false, error: "That referral is not on the sheet." }, 404);
    if (String(existing.status).toLowerCase() === "paid") {
      return json(res, { ok: false, error: "That one is already marked paid." }, 409);
    }

    try {
      if (onPg) await markReferralPaidPg(row, track, String(body.payment_ref || "").trim(), dayIn(cfg.tz));
      else await writeSheet({ op: "referral_paid", row, payment_ref: String(body.payment_ref || "").trim() });
    } catch (err) {
      return json(res, {
        ok: false,
        error: sheetError(err, "It may still have gone through. Reload the page and check before you send the money twice."),
      }, 502);
    }

    let emailed = false;
    let emailError = "";
    if (cfg.key && cfg.from && existing.referrer_email) {
      try {
        const label = existing.reward ? cfg.symbol + existing.reward : cfg.reward_label;
        const mail = paidEmail(cfg, { ...existing, reward_label: label });
        await sendOne(cfg, existing.referrer_email, mail.subject, mail.html, mail.text);
        emailed = true;
      } catch (err) {
        emailError = String(err.message || err);
      }
    }
    // The payout is recorded either way. A failed email is worth telling the
    // desk about, but it must never roll back a row that is already on the sheet.
    return json(res, { ok: true, row, emailed, email_error: emailError });
  }

  // ---- log a new referral --------------------------------------------------
  const customer = String(body.customer || "").trim();
  const customerEmail = String(body.customer_email || "").trim();
  const customerPhone = String(body.customer_phone || "").trim();
  // The page sends the referrer as first name, last name and email, so the desk
  // can tell two Joes apart. Older callers can still send a single full name.
  const referrerFirst = String(body.referrer_first || "").trim();
  const referrerLast = String(body.referrer_last || "").trim();
  const referrerName = [referrerFirst, referrerLast].filter(Boolean).join(" ")
    || String(body.referrer || "").trim();
  const referrerEmail = String(body.referrer_email || "").trim();
  const keyword = String(body.keyword || "").trim();

  if (!customer) return json(res, { ok: false, error: "The new customer needs a name." }, 400);
  if (!customerEmail && !customerPhone) {
    return json(res, { ok: false, error: "The new customer needs an email or a phone number." }, 400);
  }
  if (!referrerName && !referrerEmail) {
    return json(res, { ok: false, error: "Who referred them? Pick the customer who sent them." }, 400);
  }

  let sheet;
  try {
    sheet = await readStore(track);
  } catch (err) {
    return json(res, { ok: false, error: sheetError(err, "Nothing was saved, so press save again.") }, 502);
  }
  const cfg = config(sheet.terms, await loadProfile());

  if (cfg.keyword && norm(keyword) !== norm(cfg.keyword)) {
    return json(res, { ok: false, error: `They need to give the keyword. Ask them what ${referrerName || "their friend"} told them to say.` }, 400);
  }
  if (customerEmail && referrerEmail && norm(customerEmail) === norm(referrerEmail)) {
    return json(res, { ok: false, error: "That is the same person on both sides. Nobody can refer themselves." }, 400);
  }

  // The referrer has to be somebody already on the books. This is the check that
  // makes a single shared keyword safe to hand out.
  // Email is the identity when it is there, because two people can share a name
  // but not an inbox. Falling back to the full name covers customers who only
  // ever gave a phone number.
  const directory = sheet.directory || [];
  const match = directory.find((p) =>
    referrerEmail ? norm(p.email) === norm(referrerEmail) : norm(p.name) === norm(referrerName)
  );
  if (!match) {
    return json(res, {
      ok: false,
      error: `${referrerName || referrerEmail} is not in your customer list, so there is nobody to pay. Search for them above and apply the match.`,
    }, 400);
  }

  if (!cfg.reward) {
    return json(res, {
      ok: false,
      error: "No reward set yet. Open Referral terms above and put in what a referral pays.",
    }, 503);
  }

  // If a save times out on the write leg, the row may well have landed anyway,
  // and the natural reaction is to press the button again. Twice on the sheet
  // is twice paid out, so the same person referred by the same person on the
  // same day is refused rather than silently logged again.
  // Two days, not one. The sheet stamps its dates in the spreadsheet's own
  // timezone and this runs in UTC, so an evening save in Canada is already
  // tomorrow here. A window wide enough to survive that is still far too narrow
  // to catch a genuine second referral of the same person by the same person.
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const dupe = (sheet.referrals || []).find((r) => {
    if (String(r.date).slice(0, 10) < cutoff) return false;
    const sameCustomer = customerEmail
      ? norm(r.customer_email) === norm(customerEmail)
      : norm(r.customer) === norm(customer);
    const sameReferrer = norm(r.referrer_email) === norm(match.email || referrerEmail)
      || norm(r.referrer) === norm(match.name || referrerName);
    return sameCustomer && sameReferrer;
  });
  if (dupe) {
    return json(res, {
      ok: false,
      error: `${customer} is already logged as referred by ${dupe.referrer} on ${dupe.date}. It is in the list below, so there is nothing to redo.`,
    }, 409);
  }

  // The date the sheet is about to stamp, worked out in the business's own
  // timezone rather than the server's, so the row shown straight after saving
  // matches the row on the sheet.
  const today = dayIn(cfg.tz);

  // Cap: past the line this person's reward becomes credit instead of cash.
  const already = cashThisYear(sheet.referrals || [], match.email, match.name);
  const rewardType = already + cfg.reward > cfg.cash_cap ? "credit" : "cash";

  const record = {
    customer,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    job: String(body.job || "").trim(),
    referrer: match.name || referrerName,
    referrer_email: match.email || referrerEmail,
    reward: cfg.reward,
    reward_type: rewardType,
  };

  let written;
  try {
    written = onPg ? await addReferralPg(record, track, today) : await writeSheet({ op: "referral", referral: record });
  } catch (err) {
    return json(res, {
      ok: false,
      error: sheetError(err, "It may still have gone through. Reload the page and check the list before you save it again."),
    }, 502);
  }

  // Sheet first, email second, always. If Resend is down the referral is still
  // recorded and the desk can chase the email; the other way round loses money.
  // Both go at once: they are unrelated, and sending them one after the other
  // only made the person at the desk wait longer for the same result.
  const emails = [];
  const errors = [];
  if (cfg.key && cfg.from) {
    const withLabel = { ...record, reward_label: cfg.reward_label };
    const jobs = [];
    if (customerEmail) jobs.push({ who: "customer", label: "the new customer", to: customerEmail, mail: welcomeEmail(cfg, withLabel) });
    if (record.referrer_email) jobs.push({ who: "referrer", label: "the referrer", to: record.referrer_email, mail: pendingEmail(cfg, withLabel) });

    const settled = await Promise.allSettled(
      jobs.map((j) => sendOne(cfg, j.to, j.mail.subject, j.mail.html, j.mail.text))
    );
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") emails.push(jobs[i].who);
      else errors.push(jobs[i].label + " (" + String(outcome.reason && outcome.reason.message || outcome.reason) + ")");
    });
  } else {
    errors.push("no Resend keys set, so nothing was emailed");
  }

  return json(res, {
    ok: true,
    row: written.row,
    date: today,
    referral: { ...record, row: written.row, date: today, status: "Pending", paid_on: "", payment_ref: "" },
    reward: cfg.reward,
    reward_type: rewardType,
    capped: rewardType === "credit",
    year_to_date: already + cfg.reward,
    emailed: emails,
    email_error: errors.join("; "),
  });
}


// ---------------------------------------------------------------- the demo
// Its own referrals table and its own terms, its directory from its own deals.
const slugMail = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") + "@example.com";

async function demoReferrals(req, res) {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const rest = (path, init) => fetch(url + "/rest/v1/" + path, { ...init, headers: { ...headers, ...(init && init.headers) }, signal: AbortSignal.timeout(6000) });
  const track = trackOf(req);
  const mine = (path) => only(path, track);
  const prof = await loadProfile();
  const kvr = await rest("kv_demo?key=eq.referral_terms&select=value");
  const kvRows = kvr.ok ? await kvr.json() : [];
  const terms = (kvRows[0] && kvRows[0].value) || {};
  const cfg = config(terms, prof);
  const shape = (r) => ({
    row: r.id, date: String(r.date || ""), customer: r.customer, customer_email: r.customer_email || "", customer_phone: r.customer_phone || "",
    job: r.job || "", referrer: r.referrer, referrer_email: r.referrer_email || "", reward: Number(r.reward) || 0,
    reward_type: r.reward_type || "cash", status: r.status || "Pending", paid_on: r.paid_on || "", payment_ref: r.payment_ref || "",
  });
  const today = () => new Date().toISOString().slice(0, 10);

  if (req.method === "GET") {
    const [dr, rr] = await Promise.all([
      rest(mine("deals_demo?select=business,closed_on,notes,email&order=closed_on.desc")),
      rest(mine("referrals_demo?select=*&order=id.asc")),
    ]);
    const deals = dr.ok ? await dr.json() : [];
    const referrals = rr.ok ? (await rr.json()).map(shape) : [];
    const directory = deals.map((d) => ({ name: d.business, email: d.email || slugMail(d.business), phone: "", note: d.notes || "" }));
    for (const r of referrals) {
      if (r.customer && !directory.some((p) => norm(p.name) === norm(r.customer))) {
        directory.push({ name: r.customer, email: r.customer_email, phone: r.customer_phone, note: "referred " + r.date });
      }
    }
    return json(res, {
      ok: true, demo: true, referrals, directory,
      config: {
        reward: cfg.reward, reward_label: cfg.reward_label, discount: cfg.discount, keyword: cfg.keyword, cash_cap: cfg.cash_cap,
        business: cfg.business, email_ready: true, from: prof.from || "",
        page: (typeof cfg !== "undefined" && cfg && cfg.page) || "",
        thankyou_url: (typeof cfg !== "undefined" && cfg && cfg.page) || (process.env.THANKYOU_URL || "").trim(),
      },
    });
  }
  if (req.method !== "POST") return json(res, { ok: false, error: "POST or GET only" }, 405);
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  if (body.action === "terms") {
    const t = body.terms || {};
    const page = String(t.page || "").trim().slice(0, 500);
    if (page && !/^https?:\/\//i.test(page)) return json(res, { ok: false, error: "The customer page link needs to start with http:// or https://" }, 400);
    const value = { reward: String(t.reward || "").trim(), discount: String(t.discount || "").trim(), keyword: String(t.keyword || "").trim(),
      cash_cap: String(t.cash_cap || "").trim(), business: String(t.business || "").trim(), page };
    const r = await rest("kv_demo?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ key: "referral_terms", value, updated_at: new Date().toISOString() }]) });
    if (!r.ok) return json(res, { ok: false, error: "Could not save the terms." }, 502);
    return json(res, { ok: true, demo: true });
  }
  if (body.action === "create") {
    const customer = String(body.customer || "").trim().slice(0, 160);
    const referrer = [body.referrer_first, body.referrer_last].map((x) => String(x || "").trim()).filter(Boolean).join(" ").slice(0, 160);
    if (!customer) return json(res, { ok: false, error: "The new customer needs a name." }, 400);
    if (!referrer) return json(res, { ok: false, error: "Who referred them? Pick one of your customers." }, 400);
    const row = {
      customer, customer_email: String(body.customer_email || "").trim().toLowerCase().slice(0, 200), customer_phone: String(body.customer_phone || "").trim().slice(0, 60),
      job: String(body.job || "").trim().slice(0, 200), referrer, referrer_email: String(body.referrer_email || "").trim().toLowerCase().slice(0, 200),
      reward: Number(cfg.reward) || 0, reward_type: "cash", status: "Pending", date: today(),
    };
    const r = await rest("referrals_demo", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([stampTrack(row, track)]) });
    if (!r.ok) return json(res, { ok: false, error: "Could not log that referral." }, 502);
    const saved = (await r.json())[0];
    return json(res, { ok: true, demo: true, referral: shape(saved), reward: row.reward, capped: false });
  }
  const id = Number(body.row);
  if (!id) return json(res, { ok: false, error: "Which referral?" }, 400);
  if (body.action === "paid") {
    const r = await rest(mine(`referrals_demo?id=eq.${id}`), { method: "PATCH", body: JSON.stringify({ status: "Paid", paid_on: today(), payment_ref: String(body.payment_ref || "").slice(0, 200) }) });
    if (!r.ok) return json(res, { ok: false, error: "Could not mark that paid." }, 502);
    return json(res, { ok: true, demo: true });
  }
  if (body.action === "update") {
    const allowed = ["customer", "customer_email", "customer_phone", "job", "referrer", "referrer_email", "reward", "reward_type", "status", "payment_ref"];
    const patch = {};
    for (const k of allowed) if (body.fields && body.fields[k] != null) patch[k] = k === "reward" ? (Number(body.fields[k]) || 0) : String(body.fields[k]).trim().slice(0, 200);
    if (!Object.keys(patch).length) return json(res, { ok: false, error: "Nothing to change." }, 400);
    const r = await rest(mine(`referrals_demo?id=eq.${id}`), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
    if (!r.ok) return json(res, { ok: false, error: "Could not save that." }, 502);
    return json(res, { ok: true, demo: true, referral: shape((await r.json())[0] || {}) });
  }
  if (body.action === "delete") {
    const r = await rest(mine(`referrals_demo?id=eq.${id}`), { method: "DELETE" });
    if (!r.ok) return json(res, { ok: false, error: "Could not remove that." }, 502);
    return json(res, { ok: true, demo: true });
  }
  return json(res, { ok: false, error: "Unknown action." }, 400);
}
