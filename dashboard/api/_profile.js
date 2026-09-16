// The operator's identity, in one place.
//
// Name, business, phone, sending address and video link used to live only as
// Vercel environment variables, which meant a student who had not set them
// inherited the original operator's, and changing your own name meant a
// redeploy. They now live in a profile row the Settings page edits. Every
// server that needs them calls loadProfile(); the environment is read only as
// a fallback, so an existing deployment keeps working unchanged.

import { isDemo } from "./_demo.js";

const env = (k) => (process.env[k] || "").trim();

export const PROFILE_TABLE = () => (isDemo() ? "profile_demo" : "profile");

export async function readProfileRow() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=*", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch { return null; }
}

/** The resolved identity: profile first, environment second, empty last. */
export async function loadProfile() {
  const row = (await readProfileRow()) || {};
  const pick = (v, k) => (String(v || "").trim() || env(k));
  const from = pick(row.sender_from, "RESEND_FROM");
  return {
    name: pick(row.name, "OUTREACH_SENDER_NAME"),
    business: pick(row.business, "AGENCY_NAME") || pick("", "REFERRAL_BUSINESS"),
    phone: pick(row.phone, "OUTREACH_SENDER_PHONE") || env("REFERRAL_PHONE"),
    from,
    /* Profile first, environment second, the sending address last: the same
       precedence every other field here follows. Nothing stored and nothing in
       the environment still means "replies come back to whatever you send
       from", which is what this has always done. */
    reply_to: pick(row.reply_to, "RESEND_REPLY_TO") || from,
    video: pick(row.video_link, "OUTREACH_VIDEO_LINK"),
    website: String(row.website || "").trim(),
    timezone: String(row.timezone || "").trim(),
    currency: String(row.currency || "").trim() || "GBP",
    links: Array.isArray(row.links) ? row.links : [],
    avatar: String(row.avatar || "").trim(),
    digest: digestOf(row.digest),
    targets: targetsOf(row.targets),
    /* The assistant's key: server-side only, never in a page response. */
    ai: aiOf(row.ai),
    // Where each value came from, so the page can say "set in Settings" or
    // "set in Vercel" honestly.
    source: {
      name: row.name ? "profile" : (env("OUTREACH_SENDER_NAME") ? "env" : ""),
      business: row.business ? "profile" : (env("AGENCY_NAME") || env("REFERRAL_BUSINESS") ? "env" : ""),
      phone: row.phone ? "profile" : (env("OUTREACH_SENDER_PHONE") || env("REFERRAL_PHONE") ? "env" : ""),
      from: row.sender_from ? "profile" : (env("RESEND_FROM") ? "env" : ""),
      reply_to: row.reply_to ? "profile" : (env("RESEND_REPLY_TO") ? "env" : ""),
      video: row.video_link ? "profile" : (env("OUTREACH_VIDEO_LINK") ? "env" : ""),
    },
  };
}

// The logins this CRM authorized itself.
//
// Settings, You makes an email login through the Supabase admin API, and making
// one from a signed-in session is the authorization. The emails are kept in the
// same profile row because the sign-in gate has to read them and CRM_USERS is a
// Vercel environment variable: a running deployment cannot add itself to it.

const emailList = (v) =>
  (Array.isArray(v) ? v : []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);

/** The authorized emails. A store it cannot read comes back as none, not as all. */
/* The digest email: how often, which morning, and to whom. Three daily
   schedules exist (vercel.json) and the one matching `slot` sends. */
export const AI_PROVIDERS = ["gemini", "groq"];
export function aiOf(v) {
  const a = v && typeof v === "object" ? v : {};
  return { provider: AI_PROVIDERS.includes(a.provider) ? a.provider : "gemini", key: String(a.key || "").trim().slice(0, 300) };
}
export const DIGEST_FREQS = ["off", "daily", "weekly", "monthly"];
export const DIGEST_SLOTS = { uk: "Europe/London", ny: "America/New_York", la: "America/Los_Angeles" };
/* Daily and weekly targets, per book and per channel. A row that has never
   saved any gets the one default worth having: forty DMs a day for the coach
   book. Once saved, every number is explicit and zero means "no target". */
export const TARGET_CHANNELS = ["emails", "dms", "calls"];
export function targetsOf(v) {
  const fresh = !(v && typeof v === "object");
  const num = (x) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0; };
  const book = (b, def) => {
    const src = (v && v[b] && typeof v[b] === "object") ? v[b] : {};
    const out = { daily: {}, weekly: {} };
    for (const p of ["daily", "weekly"]) for (const c of TARGET_CHANNELS) out[p][c] = fresh ? ((def[p] || {})[c] || 0) : num((src[p] || {})[c]);
    return out;
  };
  return { local: book("local", {}), coach: book("coach", { daily: { dms: 40 } }) };
}
export function digestOf(v) {
  const d = v && typeof v === "object" ? v : {};
  return {
    freq: DIGEST_FREQS.includes(d.freq) ? d.freq : "off",
    slot: DIGEST_SLOTS[d.slot] ? d.slot : "uk",
    to: String(d.to || "").trim().slice(0, 300),
    last_sent: String(d.last_sent || "").slice(0, 10),
  };
}
export async function saveDigest(next) {
  const url = (process.env.SUPABASE_URL || "").trim(), key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("Profile storage is not configured.");
  const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: 1, digest: digestOf(next), updated_at: new Date().toISOString() }]), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error("Could not save the digest settings (" + r.status + ").");
}

export async function readAllowedEmails() {
  return emailList(((await readProfileRow()) || {}).allowed_emails);
}

/** The same list, but a store it cannot read says so instead of answering
 *  "nobody". The first-run gate needs the difference: an empty list means a
 *  fresh deployment and an unreadable one means nothing of the kind, and
 *  treating the second as the first would offer the owner's account to a
 *  stranger during a storage outage. Answers { list } or { error }. */
export async function readAllowedEmailsStrict() {
  return listForUpdate();
}

// The same list, read for a change about to be made. This one tells a store it
// could not read apart from a list that is genuinely empty, because writing back
// what we failed to read would delete every other login.
async function listForUpdate() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { error: "Storage is not connected, so the login list cannot be changed." };
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=allowed_emails", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { error: "Could not read the login list (" + r.status + ")." };
    const rows = await r.json();
    return { list: emailList((rows[0] || {}).allowed_emails) };
  } catch { return { error: "Could not reach storage to read the login list." }; }
}

// Only id and allowed_emails go in the write, so a profile saved from Settings
// in the same moment keeps the columns this does not name.
async function saveAllowedEmails(list) {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: 1, allowed_emails: list }]),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "" : "Could not save the login list (" + r.status + ").";
  } catch { return "Could not reach storage to save the login list."; }
}

/** Let an email sign in. Returns "" once it is stored, otherwise why it is not. */
export async function addAllowedEmail(email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return "";
  const got = await listForUpdate();
  if (got.error) return got.error;
  if (got.list.includes(who)) return "";
  return saveAllowedEmails(got.list.concat([who]));
}

/** Stop an email signing in. Returns "" once it is stored, otherwise why not. */
export async function dropAllowedEmail(email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return "";
  const got = await listForUpdate();
  if (got.error) return got.error;
  if (!got.list.includes(who)) return "";
  return saveAllowedEmails(got.list.filter((e) => e !== who));
}

// Who each login belongs to.
//
// Supabase Auth knows an email and when it last signed in, and nothing else. A
// team page that can only say "three addresses can sign in" is not a team page,
// so the readable part of a colleague (their name, and what they are here to
// do) is kept beside the profile, keyed by the same email.
//
// The role is a label, not a permission. Everyone who can sign in can do
// everything, and the page says so rather than implying a restriction that is
// not enforced anywhere.

export const TEAM_ROLES = ["Owner", "Admin", "Sales", "Setter", "Assistant"];

const teamList = (v) =>
  (Array.isArray(v) ? v : [])
    .map((m) => ({
      email: String((m && m.email) || "").trim().toLowerCase(),
      name: String((m && m.name) || "").trim().slice(0, 80),
      role: TEAM_ROLES.includes(String(m && m.role)) ? String(m.role) : "Sales",
    }))
    .filter((m) => m.email);

/** The name and role for every login. Unreadable storage reads as none. */
export async function readTeam() {
  return teamList(((await readProfileRow()) || {}).team);
}

// Same read-before-write care as the allow-list: writing back a list we failed
// to read would erase everyone else's name.
async function teamForUpdate() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { error: "Storage is not connected, so the team cannot be changed." };
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=team", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { error: "Could not read the team (" + r.status + ")." };
    const rows = await r.json();
    return { list: teamList((rows[0] || {}).team) };
  } catch { return { error: "Could not reach storage to read the team." }; }
}

async function saveTeam(list) {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: 1, team: list }]),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "" : "Could not save the team (" + r.status + ").";
  } catch { return "Could not reach storage to save the team."; }
}

/** Add or update one member's name and role. Returns "" when stored. */
export async function saveTeamMember(email, name, role) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return "";
  const got = await teamForUpdate();
  if (got.error) return got.error;
  const member = {
    email: who,
    name: String(name || "").trim().slice(0, 80),
    role: TEAM_ROLES.includes(String(role)) ? String(role) : "Sales",
  };
  /* An invite that leaves the name blank must not wipe the name already there:
     a password reset for a colleague would otherwise erase who they are. */
  const was = got.list.find((m) => m.email === who);
  if (was && !member.name) member.name = was.name;
  return saveTeam(got.list.filter((m) => m.email !== who).concat([member]));
}

/** Forget a member. Returns "" when stored. */
export async function dropTeamMember(email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return "";
  const got = await teamForUpdate();
  if (got.error) return got.error;
  if (!got.list.some((m) => m.email === who)) return "";
  return saveTeam(got.list.filter((m) => m.email !== who));
}

// The key outside software calls this CRM with.
//
// ACTIVITY_SECRET is a Vercel environment variable, so a running deployment can
// neither show it nor change it: Settings could list the endpoints and then
// leave the operator with no key to put in Make, and a key that leaked could
// only be replaced by somebody with the Vercel account. The key now lives in
// the same profile row, for the same reason the allow-list does, and the
// environment is read only as a fallback, so an existing deployment keeps
// working unchanged.
//
// Rotating stores a new key and the old stored one stops working on the next
// request. It does not retire ACTIVITY_SECRET: nothing running here can unset a
// Vercel variable, and while that variable is set it keeps authenticating
// callers. A deployment that has rotated and wants one key only clears the
// variable in Vercel.

/** The stored key, or "" when there is none. A store that cannot be read reads
 *  as none, which refuses a stored key rather than accepting an unchecked one. */
export async function readApiKey() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "";
  try {
    /* One column, not the whole row: every outside call to /api/activity runs
       this, and select=* drags the operator's avatar (a data URL of up to a
       quarter of a megabyte) across the wire to compare a header. */
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=api_key", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return "";
    const rows = await r.json();
    return String((rows[0] || {}).api_key || "").trim();
  } catch { return ""; }
}

// The same read, made before a change. Like the allow-list's, it tells a store
// it could not read apart from one with nothing stored, for a different reason:
// there is no list to merge into, but a rotation reported as done against a
// store that is not answering leaves the operator holding a key that nothing
// will accept and no way to tell.
async function keyForUpdate() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { error: "Storage is not connected, so the API key cannot be changed." };
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=api_key", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { error: "Could not read the API key (" + r.status + ")." };
    const rows = await r.json();
    return { key: String((rows[0] || {}).api_key || "").trim() };
  } catch { return { error: "Could not reach storage to read the API key." }; }
}

// Only id and api_key go in the write, so a profile saved from Settings in the
// same moment keeps the columns this does not name.
async function writeApiKey(value) {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: 1, api_key: value || null }]),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "" : "Could not save the API key (" + r.status + ").";
  } catch { return "Could not reach storage to save the API key."; }
}

/** Put a key in force. Returns "" once it is stored, otherwise why it is not. */
export async function saveApiKey(key) {
  const got = await keyForUpdate();
  if (got.error) return got.error;
  return writeApiKey(String(key || "").trim());
}

/** The key an outside caller may present: stored first, environment second,
 *  empty last. Same precedence as loadProfile(), so a key rotated in Settings
 *  wins over whatever the deployment was first set up with. */
export async function resolvedApiKey() {
  return (await readApiKey()) || env("ACTIVITY_SECRET");
}

// Where a reply comes back to, and the secret that proves one is real.
//
// Two settings, one job: making the other half of outreach work. reply_to is
// the address a prospect's answer goes to, which is rarely the address the mail
// went out from: sending happens on a subdomain nobody reads, and the person
// who reads the replies is somewhere else entirely. That was RESEND_REPLY_TO,
// a Vercel variable, which means a redeploy to change your own inbox.
//
// inbound_secret is the signing secret Resend hands out when a webhook is
// pointed at /api/inbound. Every delivery is signed with it, and without it
// there is no way to tell Resend's POST from anybody else's. That endpoint
// writes to a lead's timeline and moves them to Replied, so an unsigned caller
// could invent a reply from anyone: no secret stored means it refuses
// everything rather than trusting what it cannot check.
//
// Stored the way the API key is, for the same reason. A running deployment can
// neither read its own environment back to a screen nor change it, so a secret
// that leaked could only be replaced by somebody with the Vercel account.
// Unlike the API key it is never handed back OUT: nothing needs to see it
// twice, so Settings is told whether one is set and nothing more.

/** The stored signing secret, or "" when there is none. A store that cannot be
 *  read reads as none, which refuses every delivery rather than accepting one
 *  whose signature was never checked. */
export async function readInboundSecret() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "";
  try {
    /* One column, for the same reason readApiKey() reads one: this runs on
       every inbound delivery, and select=* would drag the operator's avatar
       across the wire to check a signature. */
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=inbound_secret", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return "";
    const rows = await r.json();
    return String((rows[0] || {}).inbound_secret || "").trim();
  } catch { return ""; }
}

// The same read, made before a change, so a store that is not answering is told
// apart from one with nothing stored. A secret reported as saved that never
// reached storage leaves the operator watching a webhook that answers 401 with
// nothing on the screen to say why.
async function inboundForUpdate() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { error: "Storage is not connected, so the signing secret cannot be saved." };
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=inbound_secret", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { error: "Could not read the signing secret (" + r.status + ")." };
    const rows = await r.json();
    return { key: String((rows[0] || {}).inbound_secret || "").trim() };
  } catch { return { error: "Could not reach storage to read the signing secret." }; }
}

// Only id and inbound_secret go in the write, so a profile saved from Settings
// in the same moment keeps the columns this does not name.
async function writeInboundSecret(value) {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?on_conflict=id", {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ id: 1, inbound_secret: value || null }]),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? "" : "Could not save the signing secret (" + r.status + ").";
  } catch { return "Could not reach storage to save the signing secret."; }
}

/** Put a signing secret in force. Returns "" once it is stored, otherwise why
 *  it is not. A blank secret disconnects replies. */
export async function saveInboundSecret(secret) {
  const got = await inboundForUpdate();
  if (got.error) return got.error;
  return writeInboundSecret(String(secret || "").trim());
}

/** The secret a delivery is checked against: stored first, environment second,
 *  empty last. Same precedence as loadProfile(), so a secret pasted into
 *  Settings wins over whatever the deployment was first set up with. Empty
 *  means replies are not connected, and /api/inbound says exactly that. */
export async function resolvedInboundSecret() {
  return (await readInboundSecret()) || env("RESEND_WEBHOOK_SECRET");
}

/** The stored reply-to address, or "" when there is none. loadProfile() is the
 *  usual way to read it, already resolved against the environment and the
 *  sending address; this is the one column on its own, for a caller that needs
 *  to know what was actually saved rather than what is in force. */
export async function readReplyTo() {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "";
  try {
    const r = await fetch(url + "/rest/v1/" + PROFILE_TABLE() + "?id=eq.1&select=reply_to", {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return "";
    const rows = await r.json();
    return String((rows[0] || {}).reply_to || "").trim();
  } catch { return ""; }
}
