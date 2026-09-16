// The key outside software calls this CRM with.
//
// /api/activity and /api/log take a key in the x-activity-secret header, which
// is how a Make scenario, a Zapier zap or a student's own script logs a call, a
// text or a payment against a lead. Until now that key was only the Vercel
// environment variable ACTIVITY_SECRET, and a running deployment can neither
// read its own environment back to a screen nor change it: Settings could list
// the endpoints and then leave the operator with nothing to authenticate with,
// and nothing to do on the day the key leaked. Selling this CRM to somebody
// means they can get a key, see it once, and replace it themselves, without a
// Vercel account and without a redeploy.
//
//   GET                -> { ok, configured, masked, source, env_fallback }
//   POST {reveal: 1}   -> { ok, key }   the key in full
//   POST {rotate: 1}   -> { ok, key }   a new key, stored, in full
//
// Session-authenticated, the same cookie as every other Settings endpoint:
// handing out a key is exactly as privileged as changing a password, so it is
// gated the same way. GET never carries the key, only its last four characters,
// so the screen can show which key is in force without the whole one sitting in
// a response during a screen share. Reveal and rotate are POSTs for the reason
// that matters more: a GET lands in browser history, in a proxy log and in a
// Referer header, and a key in any of those is a key that has to be rotated
// again. No CORS headers here either, deliberately, unlike /api/activity: the
// session cookie is SameSite=Strict and another site must not be able to read
// this answer out of a signed-in operator's browser.
import { isAuthed } from "./_auth.js";
import { readApiKey, saveApiKey, resolvedApiKey } from "./_profile.js";

export const config = { runtime: "edge" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const env = (k) => (process.env[k] || "").trim();

/* Enough of the key to recognise which one you are looking at, and not enough
   to use: four characters of a 256-bit key leaves 252 bits to guess. A key too
   short to keep a secret from its own tail shows nothing but the bullets. */
const mask = (key) => {
  const k = String(key || "");
  if (!k) return "";
  return "••••••••" + (k.length > 4 ? k.slice(-4) : "");
};

/* 32 bytes from the platform's own CSPRNG, rendered hex the way _auth.js
   already renders bytes, behind a prefix that says what it is when it turns up
   in somebody's log. getRandomValues, not Math.random and not node's crypto:
   this runs on the edge, where Web Crypto is what there is, and a key a caller
   could predict is not a key. */
function newKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return "crm_live_" + hex;
}

export default async function handler(req) {
  const authSecret = env("AUTH_SECRET");
  /* Fail closed, the same way api/store.js does. isAuthed already answers false
     without AUTH_SECRET, and this says so a second time on purpose: an endpoint
     that hands out a credential must not be one mistyped variable away from
     answering the internet. */
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true, error: "Sign in first." }, 401);

  if (req.method === "GET") {
    const stored = await readApiKey();
    const fallback = env("ACTIVITY_SECRET");
    const key = stored || fallback;
    return json({
      ok: true,
      configured: !!key,
      masked: mask(key),
      source: stored ? "profile" : (fallback ? "env" : "none"),
      /* Rotating stores a new key; it cannot unset a Vercel variable. While
         ACTIVITY_SECRET is set it keeps working alongside the stored one, and
         a screen that says "rotated" without saying that would be lying to
         somebody whose old key just leaked. */
      env_fallback: !!fallback,
    });
  }

  if (req.method !== "POST") return json({ ok: false, error: "GET or POST." }, 405);

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request." }, 400);

  /* Rotate is read before reveal, so a request asking for both gets the new key
     rather than the one it just replaced. */
  if (body.rotate) {
    const key = newKey();
    const err = await saveApiKey(key);
    /* Said out loud rather than answered with the key: a key shown on screen
       that never reached storage is a key the operator pastes into Make and
       then spends an afternoon debugging. */
    if (err) return json({ ok: false, error: err }, 502);
    return json({ ok: true, key });
  }

  if (body.reveal) {
    const key = await resolvedApiKey();
    if (!key) return json({ ok: false, error: "There is no key yet. Press Rotate to make one." }, 400);
    return json({ ok: true, key });
  }

  return json({ ok: false, error: "Say which: reveal or rotate." }, 400);
}
