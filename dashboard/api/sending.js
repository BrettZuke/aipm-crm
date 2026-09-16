// Settings, Sending: "send my emails through my own Gmail".
//
//   GET  /api/sending              -> { ok, on, webhook, account, resend_ready }
//   PUT  /api/sending { on, webhook, account, daily_cap }
//
// Gmail runs alongside Resend rather than instead of it, so daily_cap is that
// inbox's own allowance. Zero means "use the same warm-up curve Resend gets".
//
// Session-authenticated, like every other Settings endpoint. The webhook is not
// a secret (the scenario behind it refuses anything that does not carry this
// CRM's API key) but it is still only handed to somebody who is signed in.
//
// Kept apart from /api/profile deliberately: that endpoint writes the whole
// profile row on every save, so a toggle living there would be at the mercy of
// whichever screen saved last.

import { isAuthed } from "./_auth.js";
import { loadSendingPipe, saveSendingPipe, checkWebhook, gmailAllowance } from "./_sending.js";

export const config = { runtime: "edge" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  const simulated = String(process.env.SEND_MODE || "").trim().toLowerCase() === "simulate";

  if (req.method === "GET") {
    const pipe = await loadSendingPipe();
    const gmail = await gmailAllowance(pipe);
    return json({
      ok: true, ...pipe,
      /* So the screen can say what the two senders add up to today, and which
         of them is the one running out. */
      resend_ready: !!(process.env.RESEND_API_KEY || "").trim(),
      gmail_today: gmail.on ? { day: gmail.day, cap: gmail.cap, sent: gmail.sent_today, room: gmail.room } : null,
      simulated,
    });
  }
  if (req.method !== "PUT" && req.method !== "POST") return json({ ok: false, error: "GET or PUT." }, 405);

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request." }, 400);

  const webhook = String(body.webhook == null ? "" : body.webhook).trim();
  const bad = checkWebhook(webhook);
  if (bad) return json({ ok: false, error: bad }, 400);
  if (body.on && !webhook) return json({ ok: false, error: "Paste the webhook URL your Make scenario printed first." }, 400);

  const err = await saveSendingPipe({ on: !!body.on, webhook, account: body.account,
                                     daily_cap: body.daily_cap });
  if (err) return json({ ok: false, error: err }, 502);
  return json({ ok: true, ...(await loadSendingPipe()), simulated });
}
