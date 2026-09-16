// The email that goes out the moment a lead is marked Won, pointing at the
// thank-you video page (thanks.html). That page is where the customer sees the
// owner's video, their discount, the review ask and the referral offer, so this
// email is the only thing standing between a new customer and all of it.
//
// It stays completely switched off until THANKYOU_URL is set. Nothing here fires
// on a half-configured project, because the failure mode is emailing a real
// customer a link to a page with no video on it.
//
// Runs on the edge alongside crm.js, so: fetch and TextEncoder only, no node
// built-ins.

/* The page link, the discount and the business name come from Referral terms
   in the CRM first, the old environment variables second. */
export function thankYouConfig(terms) {
  const t = terms && typeof terms === "object" ? terms : {};
  const url = String(t.page || process.env.THANKYOU_URL || "").trim();
  const key = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.RESEND_FROM || "").trim();
  return {
    url,
    key,
    from,
    reply_to: (process.env.RESEND_REPLY_TO || "").trim() || from,
    business: String(t.business || process.env.REFERRAL_BUSINESS || process.env.OUTREACH_SENDER_NAME || "").trim(),
    owner: (process.env.THANKYOU_OWNER || "").trim(),
    discount: String(t.discount || process.env.REFERRAL_DISCOUNT || "").trim(),
    phone: (process.env.REFERRAL_PHONE || process.env.OUTREACH_SENDER_PHONE || "").trim(),
    ready: Boolean(url && key && from),
  };
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "";

// The customer's first name rides along on the link so the page can greet them
// by name without a lookup or a login.
export function pageLink(cfg, name) {
  const first = firstName(name);
  if (!first) return cfg.url;
  return cfg.url + (cfg.url.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(first);
}

// Short on purpose. The email is a doorway, not the message: everything worth
// saying is on the page, said by the owner, on video.
export function thankYouEmail(cfg, lead) {
  const first = firstName(lead.owner_name || lead.business);
  const hi = first ? "Hi " + first + "," : "Hi,";
  const biz = cfg.business || "us";
  const link = pageLink(cfg, lead.owner_name || lead.business);
  const from = cfg.owner ? cfg.owner + " at " + biz : biz;

  const subject = "Thanks from " + biz;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1a1a1a;max-width:520px">
<p>${esc(hi)}</p>
<p>Thanks for your business. I recorded you a short video rather than typing it all out.</p>
<p>It is under a minute, and there is ${cfg.discount ? "<strong>" + esc(cfg.discount) + " off your next visit</strong> waiting on that page" : "something on that page for you"} too.</p>
<p style="margin:26px 0">
  <a href="${esc(link)}" style="background:#EAB308;color:#1a1400;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px;display:inline-block">Watch it here</a>
</p>
<p>Anything at all you need, just reply to this and it comes straight to me.</p>
<p style="margin-top:22px;color:#666;font-size:14px">${esc(from)}${cfg.phone ? " &middot; " + esc(cfg.phone) : ""}</p>
</div>`;

  const text = `${hi}

Thanks for your business. I recorded you a short video rather than typing it all out.

It is under a minute, and there is ${cfg.discount ? cfg.discount + " off your next visit waiting on that page" : "something on that page for you"} too.

${link}

Anything at all you need, just reply to this and it comes straight to me.

${from}${cfg.phone ? " · " + cfg.phone : ""}`;

  return { subject, html, text };
}

// Two halves on purpose, so the caller can run them either side of the status
// write: decide who to email BEFORE the sheet changes (afterwards every lead
// looks like it was always Won), then actually send AFTER the save has
// succeeded. Marking a lead Won is the important thing on that click and must
// never be rolled back, or blocked, by a mail problem.
export async function findThankYouTarget(sheetUrl, token, row, cfg, known) {
  if (!cfg.ready) return { skip: "not configured" };

  let lead = known || null;
  /* The caller already has the lead when leads live in Postgres; the sheet
     read below is for the sheet-backed CRM only. */
  if (!lead) try {
    const sep = sheetUrl.includes("?") ? "&" : "?";
    const target = sheetUrl + sep + "crm=1" + (token ? "&token=" + encodeURIComponent(token) : "");
    const res = await fetch(target, { signal: AbortSignal.timeout(15000) });
    const data = JSON.parse(await res.text());
    if (!data.ok) return { skip: "could not read the sheet" };
    lead = (data.leads || []).find((l) => Number(l.row) === Number(row));
  } catch {
    return { skip: "could not read the sheet" };
  }

  if (!lead) return { skip: "lead not found" };
  if (!lead.email) return { skip: "no email address on this lead" };

  // Already Won means this has been through here before. Flipping a lead that is
  // already a customer back to Won must not send them a second thank you.
  if (String(lead.status || "").trim().toLowerCase() === "won") {
    return { skip: "already a customer" };
  }
  return { lead };
}

export async function deliverThankYou(cfg, lead) {
  if (!cfg.ready || !lead || !lead.email) return { sent: false, reason: "not configured" };
  const mail = thankYouEmail(cfg, lead);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.from,
        to: [lead.email],
        reply_to: cfg.reply_to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { sent: false, reason: "Resend HTTP " + res.status + ": " + body.slice(0, 140) };
    }
    return { sent: true, to: lead.email };
  } catch (err) {
    return { sent: false, reason: String((err && err.message) || err) };
  }
}
