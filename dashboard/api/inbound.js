// Replies: the half of outreach this CRM could never see.
//
//   POST /api/inbound   svix-id / svix-timestamp / svix-signature headers
//                       Resend's email.received webhook. A real reply.
//   POST /api/inbound   { test: 1, from, subject, text }  + a session cookie
//                       The "Send myself a test reply" button in Settings.
//
// Every email that went out was tracked: the send, the open, the click on the
// video link. Nothing that came back was. A prospect answering "yes, send it
// over" changed nothing on the screen, the sequence carried on sending them
// follow-ups, and the only way to know was to go and look in the mailbox. Now
// the reply lands on that lead's timeline and the lead moves to Replied on its
// own, which is also what takes them out of the sequence.
//
// Resend's webhook carries metadata only, never the body, so the email it names
// is fetched back from the API and turned into the one line a timeline shows.
//
// Two ways in, proved two completely different ways. A delivery from Resend
// proves itself with a signature over the exact bytes it sent, keyed by the
// webhook's signing secret. The Settings test proves itself with the session
// cookie, the way every other Settings endpoint does. Nothing else is accepted:
// no key in a query string, no unsigned POST, and no CORS headers at all,
// unlike /api/activity. This endpoint writes to a lead's record and moves their
// status, so a page on another site must not be able to reach it carrying a
// signed-in operator's cookie.

import { isAuthed, timingSafeEqual } from "./_auth.js";
import { isDemo } from "./_demo.js";
import { leadsInPostgres, findLeadByEmail, markLeads } from "./_leads.js";
import { demoPath } from "./_rows.js";
import { stampTrack } from "./_track.js";
import { readEdit, upsertEdit } from "./_edits.js";
import { resolvedInboundSecret } from "./_profile.js";
import { db as store } from "./_coach.js";

export const config = { runtime: "edge" };

const RECEIVED_EMAIL = "https://api.resend.com/emails/receiving/";

/* Five minutes, the Svix standard. A body and its signature stay valid
   together forever, so without a window anybody who ever saw one delivery could
   send it again tomorrow and put that reply back on the timeline. The dedupe on
   the insert already makes an identical replay a no-op; this makes it a 401
   instead, and covers the case where the row the first one wrote is gone. */
const TOLERANCE_SECONDS = 300;

/* A marketing signature can be a megabyte of table markup. Only the first three
   hundred characters of it will ever be shown, so the stripping below never
   walks more than this on an edge function's clock. */
const HTML_CAP = 20000;

/* The statuses a reply is allowed to move a lead out of.
 *
 * An allow-list rather than a list of the ones to leave alone, so a status
 * nobody writing this had thought of is left exactly as it is instead of being
 * overwritten by a stranger's email. Interested, Proposal sent, Got on call and
 * Won are all further along than Replied and must never be walked back; Not a
 * fit, Not interested, Lost, Removed and Bad number are decisions a person made
 * deliberately, and somebody answering an old email does not get to undo one. */
const BELOW_REPLIED = new Set([
  "", "new", "contacted",
  "follow-up 1", "follow-up 2", "follow-up 3", "follow-up 4", "follow-up 5",
  "nurturing", "voicemail", "no answer", "dm'd",
  "not dm'd", "left on read",
]);

/* An address plain enough to put in a query filter. Everything PostgREST would
   have to see quoted or escaped (a comma, a bracket, a quote, a space) is absent
   by construction, so a From header written to break the lookup cannot: it
   simply matches no lead, which is the right answer for it anyway. The address
   is url-encoded on the way in as well, so this is the second of two defences
   rather than the only one. */
const PLAIN_ADDRESS = /^[A-Za-z0-9._+='-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/* No CORS headers, deliberately, the same way api/apikey.js has none. The
   session cookie is SameSite=Strict and this endpoint writes to a lead. */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/* ----------------------------------------------------------- proving it real

   Svix's standard scheme, which is what Resend signs with. The secret is whsec_
   and then base64, and the BYTES behind that base64 are the HMAC key, not the
   text of it: keying on the string "whsec_..." produces a signature that never
   matches anything Resend sends, and the endpoint would refuse every real reply
   while looking perfectly well written. */

function secretBytes(secret) {
  const body = String(secret || "").replace(/^whsec_/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length ? bytes : null;
  } catch {
    return null; // a secret that is not base64 can verify nothing
  }
}

function base64Of(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Is this delivery inside its five minutes? Unix seconds, digits only, so a
 *  sign or an exponent cannot smuggle a date past the window. */
function fresh(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!/^\d{1,15}$/.test(raw)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - parseInt(raw, 10)) <= TOLERANCE_SECONDS;
}

async function signedBySvix(secret, id, timestamp, header, raw) {
  const keyBytes = secretBytes(secret);
  if (!keyBytes) return false;
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  /* The id, the timestamp and the body exactly as it arrived, joined with dots.
     The body has to be the string that came off the wire: parsing it and
     printing it again gives back the same data and different bytes, and a
     signature is over bytes. */
  const signed = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "." + timestamp + "." + raw));
  const mine = base64Of(new Uint8Array(signed));
  let matched = false;
  /* Space separated, and there can be more than one: Svix sends every signature
     that is currently valid, which is how a secret gets rotated without dropping
     a delivery, so any one of them matching is enough. The loop never breaks
     early, so how long this takes does not depend on which entry was the right
     one, and timingSafeEqual walks the whole of the longer string for the same
     reason. */
  for (const part of String(header || "").split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    if (part.slice(0, comma) !== "v1") continue;
    if (timingSafeEqual(part.slice(comma + 1), mine)) matched = true;
  }
  return matched;
}

/* ----------------------------------------------------------- reading a reply

   Everything below this line was typed by whoever sent the email, which makes
   it the only wholly untrusted text this CRM stores. It is cut to one line, and
   angle brackets come out of it entirely: the timeline escapes what it prints,
   and a preview that cannot contain a tag in the first place stays safe if some
   future screen forgets to. */

function plain(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/* The same, with angle brackets taken out: for anything a screen will print.
   Kept apart from plain() because a Message-ID is angle brackets by definition
   and nothing renders one, so mangling it would only make the stored header
   wrong for whoever wants to thread a reply on it later. */
function oneLine(value, max) {
  return plain(value, max).replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

/** The line a timeline shows: the plain text part, or the HTML one stripped back
 *  to words when there is no plain text part to use. */
function stripHtml(html) {
  return String(html).slice(0, HTML_CAP)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    /* Entities after the tags, and the ampersand last of all, so "&amp;lt;"
       reads back as the text "&lt;" rather than turning into a bracket.
       Anything that does become a bracket is taken out again afterwards. */
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0*39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}
function previewOf(text, html) {
  let body = String(text == null ? "" : text);
  if (!body.trim() && html) body = stripHtml(html);
  return oneLine(body, 300);
}

/** The whole reply with its line breaks, for the drawer to open out. */
function fullTextOf(text, html) {
  let body = String(text == null ? "" : text);
  if (!body.trim() && html) body = stripHtml(html);
  return body
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    .replace(/[<>]/g, " ").trim().slice(0, 20000);
}

/** "Sam Jones <sam@yourdomain.com>" or "sam@yourdomain.com", either way round. */
function parseFrom(value) {
  /* Capped before the regex runs: a From header is a name and an address, and
     an unbounded one is somebody measuring how long this will spend. */
  const raw = (Array.isArray(value) ? String(value[0] == null ? "" : value[0]) : String(value == null ? "" : value)).trim().slice(0, 400);
  const angled = /^([^<>]*)<([^<>]+)>$/.exec(raw);
  const name = angled ? angled[1].trim().replace(/^"(.*)"$/, "$1").trim() : "";
  const address = (angled ? angled[2] : raw).trim().toLowerCase();
  return { name: oneLine(name, 120), address: oneLine(address, 200) };
}

async function fetchEmail(id, key) {
  let r;
  try {
    r = await fetch(RECEIVED_EMAIL + encodeURIComponent(id), {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* Whatever the platform put in that rejection stays out of the answer. The
       key travels in a header rather than the URL, so there is nothing in it to
       leak, and no reason to widen what a caller can make this print. */
    throw new Error("Could not reach Resend to read that reply.");
  }
  if (!r.ok) throw new Error("Resend would not hand over that reply (" + r.status + ").");
  try {
    return await r.json();
  } catch {
    throw new Error("Resend's answer could not be read.");
  }
}

/* ---------------------------------------------------------- finding the lead

   The coach book first, because it is one indexed row rather than a whole
   sheet, then the leads the page itself paints from.

   Both reads throw rather than answering "no lead" when the store will not
   talk. The activity row is written once and deduped on a retry, so guessing
   "nobody" during a five second outage would put the reply on nothing, for
   good, and Resend's retry would be swallowed as a duplicate. Failing instead
   means Resend retries and it lands properly. */

async function findCoach(db, address) {
  /* ilike, not eq, and then the match is confirmed here in JS.
   *
   * A coach added one at a time, which is how nearly all of them are added,
   * keeps whatever capitals were typed: _coach.js lowercases an email on a CSV
   * import and not on a single add. eq is case sensitive, so Sam@Yourdomain.com in
   * the book would never be matched by sam@yourdomain.com off a From header, and the
   * reply would land on nobody with nothing to show anybody why.
   *
   * ilike with no wildcards in it is a case-insensitive exact match, and the
   * one wildcard that can reach it is the underscore in a real address, which
   * matches any single character. So the rows it hands back are narrowed in SQL
   * and then confirmed by comparing the address properly, which makes the
   * result exactly "lowercased email equals this address" and nothing else. A
   * handful rather than one, so the right row is not lost behind a near miss
   * the wildcard also caught. The percent sign, the wildcard that could match
   * the whole book, cannot get here at all: PLAIN_ADDRESS has no room for it. */
  const r = await fetch(
    db.url + "/rest/v1/" + demoPath("coach_leads") +
    "?email=ilike." + encodeURIComponent(address) + "&deleted=is.false&select=id,business,name,handle,status,email&limit=5",
    { headers: db.headers, signal: AbortSignal.timeout(6000) },
  );
  if (!r.ok) throw new Error("Could not look that address up in the coach book (" + r.status + ").");
  const rows = await r.json();
  return rows.find((c) => String((c && c.email) || "").trim().toLowerCase() === address) || null;
}

async function findLocal(db, address) {
  /* On Postgres the lead is one row away, and its status is the live one. */
  if (await leadsInPostgres()) {
    const lead = await findLeadByEmail(address);
    return lead ? { ...lead, pg: true } : null;
  }
  /* The same saved copy of the sheet the page paints from, read the way
     api/go.js reads it. crm.js keeps this copy and does not export its reader,
     and importing the CRM endpoint into a webhook to get at four lines would
     drag the whole of it along. */
  const key = isDemo() ? "crm-leads-demo" : "crm-leads";
  const r = await fetch(db.url + "/rest/v1/sheet_cache?key=eq." + key + "&select=payload&limit=1",
    { headers: db.headers, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("Could not read your leads to match that reply (" + r.status + ").");
  const rows = await r.json();
  const leads = (rows[0] && rows[0].payload && rows[0].payload.leads) || [];
  return leads.find((l) => String((l && l.email) || "").trim().toLowerCase() === address) || null;
}

/** What a local lead's status actually is now, rather than what the saved copy
 *  of the sheet said when it was last read. A status set in the CRM is written
 *  to lead_edits and laid over the leads on the way out, and that copy can be
 *  six hours old: trusting it alone is how a lead somebody marked Won this
 *  morning gets walked back to Replied this afternoon. */
async function localStatus(leadRow, lead) {
  if (lead && lead.pg) return String(lead.status || "").trim();
  const edit = await readEdit(leadRow);
  const overlaid = String(((edit && edit.fields) || {}).status || "").trim();
  return overlaid || String((lead && lead.status) || "").trim();
}

async function moveToReplied(db, track, leadRow, coach, lead) {
  const now = track === "coach" ? String((coach && coach.status) || "") : await localStatus(leadRow, lead);
  if (!BELOW_REPLIED.has(now.trim().toLowerCase())) return false;
  if (track === "coach") {
    const r = await fetch(db.url + "/rest/v1/" + demoPath("coach_leads") + "?id=eq." + encodeURIComponent(String(leadRow)), {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "Answered" }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error("The reply was logged, but they could not be moved to Replied (" + r.status + ").");
    return true;
  }
  /* Local leads live in the Google Sheet, and the CRM's own copy of a change is
     lead_edits, laid over them on every read. Written there and not pushed to
     the sheet: a webhook has seconds, an Apps Script write takes a good part of
     a minute, and the overlay is what every screen in this CRM reads. */
  if (lead && lead.pg) {
    const r = await markLeads([{ row: leadRow, status: "Replied" }]);
    if (!r.updated) throw new Error("The reply was logged, but they could not be moved to Replied.");
    return true;
  }
  await upsertEdit(leadRow, { fields: { status: "Replied" } });
  return true;
}

/* ----------------------------------------------------------------- recording

   One row on the timeline, and a status that moves itself. */

async function recordReply(reply) {
  const db = store();
  if (!db) throw new Error("Storage is not configured.");
  const address = reply.from;

  let track = "local", leadRow = null, business = "", coach = null, lead = null;
  /* Only an address plain enough to go in a filter is looked up in the coach
     book; the local match is a comparison in memory, so it is safe whatever
     arrived. An address too strange for either is still logged, with nobody
     attached, which is exactly what an unmatched reply is. */
  if (PLAIN_ADDRESS.test(address)) coach = await findCoach(db, address);
  if (coach) {
    track = "coach";
    leadRow = Number(coach.id) || null;
    business = String(coach.business || coach.name || ("@" + (coach.handle || ""))).trim();
  } else {
    lead = await findLocal(db, address);
    if (lead) {
      leadRow = Number(lead.row) || null;
      business = String(lead.business || "").trim();
    }
  }

  const row = {
    occurred_at: new Date().toISOString(),
    lead_row: leadRow,
    lead_email: address || null,
    business: oneLine(business, 160) || null,
    channel: "email",
    kind: "replied",
    subject: oneLine(reply.subject, 200) || null,
    preview: reply.preview || null,
    provider: reply.provider,
    external_id: reply.externalId,
    data: { message_id: reply.messageId || null, from_name: reply.fromName || null, text: reply.text || null },
  };
  /* The same three columns as the unique index, (provider, external_id, track),
     and ignore-duplicates on top of them. Resend retries any delivery it did not
     get a 2xx for, so without this a slow answer to the first attempt puts the
     same reply on the timeline twice. Naming two of the three matches no
     constraint and Postgres refuses the insert outright, which is how link
     tracking silently stopped for a day. */
  const r = await fetch(db.url + "/rest/v1/" + (isDemo() ? "activities_demo" : "activities") + "?on_conflict=provider,external_id,track", {
    method: "POST",
    headers: { ...db.headers, Prefer: "return=representation,resolution=ignore-duplicates" },
    body: JSON.stringify([stampTrack(row, track)]),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("Could not put that reply on the timeline (" + r.status + ").");
  const saved = await r.json();

  /* Attempted on a repeat delivery as well as a first one. Moving a lead that is
     already Replied to Replied changes nothing, and the case worth covering is
     the other one: the row went in, the status write failed, Resend retried.
     Skipping it there would leave the reply on the timeline and the lead still
     sitting in the sequence. */
  const moved = leadRow ? await moveToReplied(db, track, leadRow, coach, lead) : false;
  return { matched: !!leadRow, track, lead_row: leadRow, moved, duplicate: !saved.length };
}

/* ------------------------------------------------------------ the two ways in */

async function fromResend(req, svixId) {
  /* The raw bytes, read before anything parses them. The signature covers the
     body exactly as it was sent, so a round trip through JSON.parse and
     JSON.stringify (same data, different spacing) would be checked against a
     string Resend never signed. */
  const raw = await req.text();
  const timestamp = req.headers.get("svix-timestamp") || "";
  const signature = req.headers.get("svix-signature") || "";

  const secret = await resolvedInboundSecret();
  /* Fail closed. No secret stored and none in the environment means there is
     nothing to check a delivery against, and an endpoint that writes to a lead
     must not accept what it cannot verify. */
  if (!secret) return json({ ok: false, error: "Replies are not connected yet." }, 401);

  /* One answer for every way a delivery can fail to prove itself: the wrong
     secret, a replayed body, a signature over different bytes, a stored secret
     that is not base64. Saying which would tell somebody probing this endpoint
     how far they had got. */
  const refused = { ok: false, error: "Could not verify that webhook." };
  if (!fresh(timestamp)) return json(refused, 401);
  if (!(await signedBySvix(secret, svixId, timestamp, signature, raw))) return json(refused, 401);

  let event = null;
  try { event = JSON.parse(raw); } catch { event = null; }
  if (!event || typeof event !== "object") return json({ ok: false, error: "That webhook was not JSON." }, 400);
  /* Resend sends every event type the operator ticked down one webhook. A
     delivery, a bounce or an open is somebody else's business here, and
     answering 200 stops Resend retrying it for the rest of the day. */
  if (event.type !== "email.received") return json({ ok: true, ignored: true });

  const data = (event.data && typeof event.data === "object") ? event.data : {};
  const emailId = String(data.email_id || "").trim();
  /* This goes straight into a URL path, so it is checked rather than trusted: a
     valid signature proves Resend sent the payload, not that everything inside
     it is the shape this expects. */
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(emailId)) {
    return json({ ok: false, error: "That webhook named no email to fetch." }, 400);
  }

  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) return json({ ok: false, error: "RESEND_API_KEY is not set, so the reply could not be read." }, 503);

  /* The webhook carries metadata only. The body, which is the whole point of
     showing a reply at all, comes from the API. */
  const mail = await fetchEmail(emailId, key);
  const who = parseFrom(mail.from == null ? data.from : mail.from);
  const result = await recordReply({
    from: who.address,
    fromName: who.name,
    subject: mail.subject == null ? data.subject : mail.subject,
    preview: previewOf(mail.text, mail.html),
    text: fullTextOf(mail.text, mail.html),
    messageId: plain(mail.message_id == null ? data.message_id : mail.message_id, 200),
    provider: "resend",
    externalId: emailId,
  });
  return json({ ok: true, ...result });
}

async function fromSettings(req) {
  /* Session only, checked before the body is read. This writes to a lead and
     moves their status, which is as privileged as anything else in Settings, so
     it is gated the same way. */
  if (!(await isAuthed(req))) return json({ ok: false, login: true, error: "Sign in first." }, 401);
  const body = await req.json().catch(() => null);
  if (!body || !body.test) {
    return json({ ok: false, error: "Send { test: 1, from, subject, text }, or point Resend's webhook here." }, 400);
  }
  const who = parseFrom(body.from);
  if (!who.address) return json({ ok: false, error: "Say who the reply is from." }, 400);
  const result = await recordReply({
    from: who.address,
    fromName: who.name,
    subject: body.subject == null ? "Re: your email" : body.subject,
    preview: previewOf(body.text, ""),
    text: fullTextOf(body.text, ""),
    messageId: "",
    /* Its own provider, so a test can never collide with a real delivery on the
       dedupe index, and the clock in the id so pressing the button twice writes
       two lines rather than silently doing nothing the second time. */
    provider: "test",
    externalId: "test-" + Date.now(),
  });
  return json({ ok: true, ...result });
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ ok: false, error: "POST only." }, 405);
  /* Which way in. Resend stamps svix-id on every delivery; the page sends no
     such header, and gets the session check instead. */
  const svixId = req.headers.get("svix-id") || "";
  try {
    return svixId ? await fromResend(req, svixId) : await fromSettings(req);
  } catch (err) {
    /* Nothing thrown in this file, or in what it calls, carries the signing
       secret, the Resend key or a line of anybody's email: every message here is
       written by hand and at worst carries an HTTP status number. The cap is for
       an unexpected runtime error getting this far. */
    const why = String((err && err.message) || "").slice(0, 160);
    console.error("inbound: " + (why || "failed"));
    return json({ ok: false, error: why || "Could not record that reply." }, 502);
  }
}
