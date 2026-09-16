// Settings, "You": the operator's profile.
//
//   GET /api/profile         -> the resolved profile and where each field comes from
//   PUT /api/profile { name, business, phone, sender_from, reply_to, video_link, website, timezone, currency, links, avatar, inbound_secret }
//
// Session-authenticated. One row per deployment. On the demo it writes the
// demo's own row, so a persona can be set there without touching the real one.

import { isAuthed } from "./_auth.js";
import { loadProfile, PROFILE_TABLE, resolvedInboundSecret, digestOf, readProfileRow, aiOf, AI_PROVIDERS, targetsOf } from "./_profile.js";

export const config = { runtime: "edge" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

/* The profile as Settings needs it: everything loadProfile() resolves, plus
   whether replies are connected. The secret itself never leaves the server, so
   the page gets a yes or a no and can say "connected" without ever holding the
   thing that would let somebody forge a reply. Built here rather than inside
   loadProfile() because every tracked link redirect and every send calls that,
   and none of them need a second read of the profile row. */
async function settingsProfile() {
  const [profile, secret] = await Promise.all([loadProfile(), resolvedInboundSecret()]);
  /* The AI key stays on the server; the page gets a yes or a no. */
  const { ai, ...safe } = profile;
  return { ...safe, inbound_set: !!secret, ai_provider: ai.provider, ai_set: !!ai.key };
}

export default async function handler(req) {
  const authSecret = (process.env.AUTH_SECRET || "").trim();
  if (!authSecret || !(await isAuthed(req))) return json({ ok: false, login: true }, 401);

  if (req.method === "GET") {
    const prof = await settingsProfile();
    /* Where finished sites and proposals live, when this copy runs its own builder. */
    prof.instant = { site: (process.env.INSTANT_SITE_URL || "").trim(), proposal: (process.env.INSTANT_PROPOSAL_URL || "").trim() };
    return json({ ok: true, profile: prof });
  }
  if (req.method !== "PUT" && req.method !== "POST") return json({ ok: false, error: "GET or PUT." }, 405);

  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "Bad request." }, 400);
  const from = clean(body.sender_from, 200);
  if (from && !/^[^<>@]*<[^\s@]+@[^\s@]+\.[^\s@]+>$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return json({ ok: false, error: "Sending address should look like  Sam <sam@yourdomain.com>  or  sam@yourdomain.com" }, 400);
  }
  /* Held to the same shape as the sending address, because it is the same kind
     of thing: a mail server will reject either one if it is malformed. */
  const replyTo = clean(body.reply_to, 200);
  if (replyTo && !/^[^<>@]*<[^\s@]+@[^\s@]+\.[^\s@]+>$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
    return json({ ok: false, error: "Reply-to should look like  Sam <sam@yourdomain.com>  or  sam@yourdomain.com" }, 400);
  }
  /* Resend's webhook signing secret: the whsec_ prefix Svix stamps on it, then
     base64. Measured raw rather than through clean(), unlike every other field
     here: quietly storing the first 200 characters of a credential gives you a
     secret that looks saved on screen and rejects every delivery. */
  const inbound = String(body.inbound_secret == null ? "" : body.inbound_secret).trim();
  if (inbound && (inbound.length > 200 || !/^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(inbound))) {
    return json({ ok: false, error: "That does not look like a Resend signing secret. Copy the one starting whsec_ from the webhook you just made." }, 400);
  }
  const video = clean(body.video_link, 500);
  if (video && !/^https?:\/\//i.test(video)) return json({ ok: false, error: "The video link needs to start with http:// or https://" }, 400);
  let links = [];
  if (Array.isArray(body.links)) {
    links = body.links.slice(0, 40).map((l) => ({ group: ["sell", "deliver", "pay"].includes(String(l && l.group)) ? String(l.group) : "sell",
                                                  label: clean(l && l.label, 80), note: clean(l && l.note, 160), url: clean(l && l.url, 500) }))
      .filter((l) => l.label && /^https?:\/\//i.test(l.url));
  }
  /* The photo arrives as a data URL the page has already squared and shrunk to
     256px. It is read back on every load and rendered in the sidebar, so it is
     capped hard: anything past a quarter of a megabyte is a full-size camera
     photo that slipped past the resizer, and is refused rather than stored. */
  let avatar = String(body.avatar == null ? "" : body.avatar).trim();
  if (avatar) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
      return json({ ok: false, error: "That photo could not be read. Use a PNG or a JPEG." }, 400);
    }
    if (avatar.length > 260000) {
      return json({ ok: false, error: "That photo is too big. Try one under 250KB." }, 400);
    }
  }

  const row = {
    id: 1,
    name: clean(body.name, 80) || null,
    business: clean(body.business, 120) || null,
    phone: clean(body.phone, 40) || null,
    sender_from: from || null,
    video_link: video || null,
    website: clean(body.website, 200) || null,
    timezone: clean(body.timezone, 60) || null,
    currency: /^[A-Z]{3}$/.test(clean(body.currency, 3)) ? clean(body.currency, 3) : "GBP",
    links,
    avatar: avatar || null,
    updated_at: new Date().toISOString(),
  };
  /* These two are written only when the caller actually sent them. Every other
     field above is on the Settings form and comes back on every save, so one
     that is missing means "clear it". Not these. The page is never given the
     signing secret, so it cannot send it back, and saving a phone number would
     otherwise erase the thing that makes replies work. A blank value is still
     a clear, which is how Settings disconnects them on purpose; absent is left
     exactly as it was. */
  if (body.reply_to !== undefined) row.reply_to = replyTo || null;
  if (body.inbound_secret !== undefined) row.inbound_secret = inbound || null;
  /* The assistant's key: a new key replaces the old, a bare provider change
     keeps the key, and clear:1 takes it out. Absent is left alone. */
  if (body.ai !== undefined) {
    const a = body.ai && typeof body.ai === "object" ? body.ai : {};
    const cur = aiOf(((await readProfileRow()) || {}).ai);
    const provider = AI_PROVIDERS.includes(a.provider) ? a.provider : cur.provider;
    const key = String(a.key || "").trim().slice(0, 300);
    if (a.clear) row.ai = null;
    else if (key && !/^[A-Za-z0-9_\-]{20,}$/.test(key)) return json({ ok: false, error: "That does not look like an API key. Copy the whole key from Google AI Studio or Groq." }, 400);
    else row.ai = { provider, key: key || cur.key };
  }
  /* Targets are saved whole, both books at once, so a book you are not
     looking at keeps its numbers. */
  if (body.targets !== undefined) row.targets = targetsOf(body.targets);
  /* The digest keeps its own last-sent date, which the page never holds. */
  if (body.digest !== undefined) {
    const want = digestOf(body.digest);
    const bad = want.to.split(/[\s,;]+/).filter(Boolean).find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (bad) return json({ ok: false, error: "The digest address should look like sam@yourdomain.com (commas between more than one)." }, 400);
    const cur = digestOf(((await readProfileRow()) || {}).digest);
    row.digest = { ...want, last_sent: cur.last_sent };
  }
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return json({ ok: false, error: "Profile storage is not configured." }, 503);
  const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row]), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return json({ ok: false, error: "Could not save the profile (" + r.status + ")." }, 502);
  return json({ ok: true, profile: await settingsProfile() });
}
