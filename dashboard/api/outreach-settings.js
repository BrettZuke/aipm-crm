// Authenticated proxy to the outreach settings.
//
// Same reasoning as api/instant.js: the builder's shared secret cannot live in
// crm.html, because that file is served to anyone who loads the page and is
// copied verbatim by every student who clones this repo. So the page talks to
// this endpoint, which checks the CRM session cookie and adds the secret from
// its own environment.
//
// GET  -> the sending accounts and their current settings
// POST -> { sender_key, enabled?, daily_cap?, warm_start? }
import { isAuthed } from "./_auth.js";
import { isDemo, demoFunnel, demoCustomerMix, DEMO_MAILBOXES } from "./_demo.js";
import { loadProfile } from "./_profile.js";
import { store } from "./_leads.js";
import { fetchRows } from "./_rows.js";
import { trackOf } from "./_track.js";

export const config = { runtime: "edge" };

const DEFAULT_URL = "";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async function handler(request) {
  if (!(await isAuthed(request))) {
    return json({ error: "sign in first", login: true }, 401);
  }

  /* The demo must not show the real sending identities. This proxies to the
     builder, whose settings list the real operator's domains with the real
     "0 of 100 today", which on a demo is both a leak of somebody's sending
     setup and a contradiction of the 1,160 the rest of the screen claims. The
     demo answers with senders on the demo owner's own domain, carrying today's
     volume from the same funnel as everything else. Saves are accepted and
     discarded, so the toggles work on screen without touching the builder. */
  if (isDemo()) {
    if (request.method === "POST") return json({ ok: true, demo: true });
    /* The demo's mailboxes and today's volume are the local book's story.
       The coach book on the demo has sent nothing, so it has no senders to
       show, and it must not fall through to the real builder below either:
       that would put the real operator's sending identities on a coach
       screen, the very thing this block exists to prevent. A real CRM shares
       its mailboxes across both books and takes the normal path. */
    if (trackOf(request) === "coach") return json({ ok: true, demo: true, senders: [] });
    const fn = demoFunnel(await demoCustomerMix());
    const todayTotal = Math.round((fn.email.sent_30d || fn.email.sent) / 24);   // sends per working day
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    /* The mailboxes come from _demo.js, so this table, the health tables and
       the warm-up ring cannot drift apart. */
    return json({ ok: true, demo: true, senders: DEMO_MAILBOXES.map((b) => ({
      sender_key: b.key, from: b.from, domain: b.domain, enabled: true,
      daily_cap: b.cap, used_today: Math.round(todayTotal * b.share), warm_start: day(b.warm_days),
    })) });
  }

  const secret = process.env.INSTANT_BUILD_SECRET;
  /* No site builder on this copy: the one sending address is the profile's,
     and what it sent today is what the CRM itself logged. */
  if (!secret || !(process.env.INSTANT_SETTINGS_URL || DEFAULT_URL)) {
    if (request.method === "POST") return json({ ok: false, error: "On this copy the sending address lives in Settings, You, and the daily cap in Vercel (OUTREACH_DAILY_MAX)." }, 501);
    const prof = await loadProfile();
    if (!prof.from) return json({ ok: true, builder: false, senders: [] });
    const address = String(prof.from).replace(/^.*<([^>]+)>.*$/, "$1").trim().toLowerCase();
    let used = 0;
    const db = store();
    if (db) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const got = await fetchRows(db, `activities?channel=eq.email&kind=eq.sent&occurred_at=gte.${today}T00:00:00Z&select=id`, { max: 2000, timeout: 6000 });
        used = got.rows.length;
      } catch { used = 0; }
    }
    return json({ ok: true, builder: false, senders: [{
      sender_key: "", from: prof.from, domain: address.split("@")[1] || "", enabled: true,
      daily_cap: Math.max(1, parseInt(process.env.OUTREACH_DAILY_MAX || "40", 10) || 40), used_today: used, warm_start: "",
    }] });
  }

  const url = process.env.INSTANT_SETTINGS_URL || DEFAULT_URL;
  const options = {
    method: request.method === "POST" ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-build-secret": secret },
  };
  if (request.method === "POST") {
    options.body = await request.text();
  }

  let upstream;
  try {
    upstream = await fetch(url, options);
  } catch (error) {
    return json({ error: "could not reach the builder" }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
