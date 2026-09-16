// Authenticated proxy to the instant site builder.
//
// The builder spends free LLM quota and can send email, so it must never be
// callable by anyone who happens to know its URL. Its shared secret therefore
// cannot live in crm.html: that file is served to anyone who loads the page and
// is copied verbatim by every student who clones this repo.
//
// So the page posts here instead. This endpoint checks the same session cookie
// the rest of the CRM uses, then forwards the lead to the builder with the
// secret read from the environment. The secret stays on the server.
//
// A NODE function, not an Edge one. Edge is capped at 25 seconds on this plan,
// and a full build (read their site, write the copy, check it, rewrite anything
// thin) runs past that. The proxy was timing out at exactly 25s and reporting
// "could not reach the builder" while the builder was still working. Node lets
// it wait as long as the builder is allowed to take.
//
// Environment:
//   INSTANT_BUILD_URL     the builder endpoint (defaults to the shared one)
//   INSTANT_BUILD_SECRET  the shared secret; without it this endpoint is off
import { isAuthed } from "./_auth.js";
import { loadProfile } from "./_profile.js";

export const config = { maxDuration: 60 };

const DEFAULT_URL = "";
const SCRAPE_URL = "";

function send(res, status, body) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.status(status).send(typeof body === "string" ? body : JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return send(res, 405, { error: "POST or GET" });
  }

  if (!(await isAuthed(req))) {
    // Same shape the other endpoints use, so the page shows its sign-in card.
    return send(res, 401, { error: "sign in first", login: true });
  }

  const secret = process.env.INSTANT_BUILD_SECRET;
  if (!secret) return send(res, 503, { error: "the builder is not configured yet: set INSTANT_BUILD_SECRET in Vercel (the shared builder's key; ask for it if you have not been given one)" });

  const url = new URL(req.url, "http://localhost");
  const headers = { "content-type": "application/json", "x-build-secret": secret };

  // ?find starts or polls a Google Maps scrape; anything else builds a site.
  if (url.searchParams.has("find")) {
    const target = process.env.INSTANT_SCRAPE_URL || SCRAPE_URL;
    if (!target) return send(res, 503, { error: "the builder is not configured yet: set INSTANT_SCRAPE_URL and INSTANT_BUILD_URL in Vercel" });
    let hit = target;
    const options = { method: req.method, headers };

    if (req.method === "POST") {
      options.body = JSON.stringify(req.body || {});
    } else {
      const runId = url.searchParams.get("runId") || "";
      const t = url.searchParams.get("t") || "0";
      hit = `${target}?runId=${encodeURIComponent(runId)}&t=${encodeURIComponent(t)}`;
    }

    let up;
    try { up = await fetch(hit, options); }
    catch (error) { return send(res, 502, { error: "could not reach the finder" }); }
    return send(res, up.status, await up.text());
  }

  const payload = req.body && typeof req.body === "object" ? { ...req.body } : null;
  if (!payload) return send(res, 400, { error: "could not read the lead" });

  // Sending is deliberate: it only happens when the page asks for it, and the
  // page only asks when the toggle is on. Anything else defaults to a dry run.
  payload.send = payload.send === true;
  // A send-only call mails a site that already exists. Same deliberate rule:
  // it is a send unless the page explicitly asked for one, never a default.
  payload.sendOnly = payload.sendOnly === true;

  /* The proposal and the site footer are signed with the business name from
     the profile. Without this the builder fell back to its own default, so a
     student's proposals went out under nobody's name. */
  if (payload.lead && typeof payload.lead === "object" && !payload.lead.agency_name) {
    const prof = await loadProfile();
    if (prof.business) payload.lead.agency_name = prof.business;
  }

  /* The demo builds sites but never mails them. The builder has its own Resend
     credentials, so this is the only place the demo can be stopped from
     emailing a real business a real proposal. A send-only call has nothing left
     to do once the mail is off, so it is refused outright rather than quietly
     doing nothing and reporting success. */
  if (String(process.env.SEND_MODE || "").trim().toLowerCase() === "simulate") {
    if (payload.sendOnly) {
      return send(res, 200, {
        ok: true, simulated: true,
        message: "Demo mode: the email was not sent.",
      });
    }
    payload.send = false;
    payload.simulated = true;
  }

  let upstream;
  try {
    if (!(process.env.INSTANT_BUILD_URL || DEFAULT_URL)) return send(res, 503, { error: "the builder is not configured yet: set INSTANT_BUILD_URL in Vercel" });
    upstream = await fetch(process.env.INSTANT_BUILD_URL || DEFAULT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return send(res, 502, { error: "could not reach the builder" });
  }

  return send(res, upstream.status, await upstream.text());
}
