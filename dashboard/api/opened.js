// Has one email been opened yet?
//
//   GET /api/opened?id=<resend id>  ->  { state: "sent" | "delivered" | "opened" | "clicked" }
//
// Resend already records every open and click, but the only place that showed
// was the Email health page, averaged over thirty days. That is the wrong shape
// for the moment that actually matters: you send a business their proposal and
// then want to see them read it. Asking about a single email is cheap enough to
// poll for a couple of minutes after a send, so the row can flip from "sent" to
// "opened" while you are still looking at it.
//
// Read only. It cannot send anything and it cannot change anything.

import { isAuthed } from "./_auth.js";

export const config = { runtime: "edge" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Resend ids are uuids. Anything else is refused rather than forwarded, so this
// can never be used to reach another part of their API.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req) {
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const authSecret = (process.env.AUTH_SECRET || "").trim();
  /* Fail closed. This used to read "if a secret is configured, check it", so
   clearing or mistyping AUTH_SECRET would silently open the endpoint to
   anyone instead of raising an error. */
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return json({ error: "no mail account connected" }, 503);

  const id = new URL(req.url).searchParams.get("id") || "";
  if (!ID.test(id)) return json({ error: "not an email id" }, 400);

  let data;
  try {
    const res = await fetch("https://api.resend.com/emails/" + id, {
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return json({ state: "sent", note: "could not read that email yet" });
    data = await res.json();
  } catch {
    // A blip must not make a delivered email look like a failure.
    return json({ state: "sent", note: "could not reach the mail account" });
  }

  /* Resend reports the furthest point reached, so the order below is the order
     of the journey and the first match wins reading backwards: an email that
     was clicked was necessarily opened and delivered before that. */
  const last = String(data.last_event || data.status || "sent").toLowerCase();
  const state =
    last.includes("click") ? "clicked" :
    last.includes("open") ? "opened" :
    last.includes("deliver") ? "delivered" :
    last.includes("bounce") ? "bounced" :
    last.includes("complain") ? "complained" :
    "sent";

  return json({ state, to: (data.to || [])[0] || null, subject: data.subject || null });
}
