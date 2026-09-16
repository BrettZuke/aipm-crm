// Shared session verifier for the login gate. Imported by both the edge APIs
// (crm.js, stats.js) and the node API (send.js), so it must run in either
// runtime: it uses only Web Crypto (globalThis.crypto.subtle) and TextEncoder,
// never node's crypto module.
//
// A session cookie is "<exp>.<epoch>.<sig>": exp is unix seconds the cookie
// stops being valid, epoch is the session epoch it was issued under, and sig
// is HMAC-SHA256("<exp>.<epoch>") hex, keyed by AUTH_SECRET. The epoch lives in
// the profile row and goes up by one whenever a password changes, a login is
// removed or somebody presses "Sign out everywhere"; a cookie stamped with an
// older epoch is refused, which is how a lost laptop or an old password stops
// working before its thirty days are up. Cookies from before the epoch existed
// ("<exp>.<sig>") count as epoch 0 and keep working until the first bump.
//
// No AUTH_SECRET means the login layer is off, so isAuthed returns false and
// the caller falls back to its other checks (open, or the ?k= key).
const COOKIE_NAME = "crm_session";
export const THIRTY_DAYS = 2592000; // seconds
const EPOCH_CACHE_MS = 30000;

// Cookie header from either an edge Request (Headers with .get) or a node
// request (plain headers object).
function cookieHeader(req) {
  const h = req && req.headers;
  if (!h) return "";
  if (typeof h.get === "function") return h.get("cookie") || h.get("Cookie") || "";
  return h.cookie || h.Cookie || "";
}

// Pull one cookie value out of a Cookie header without a regex on attacker input.
function readCookie(header, name) {
  const parts = String(header || "").split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Constant-time compare of two hex strings. Walks the full length of the longer
// one so the time taken does not depend on where they first differ.
export function timingSafeEqual(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  const n = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// The profile row holds the epoch. Same rule as isDemo(), without importing
// anything: the demo has its own profile row and its own epoch.
function profilePath() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  const table = (process.env.DEALS_TABLE || "").trim() === "deals_demo" ? "profile_demo" : "profile";
  return { url: `${url}/rest/v1/${table}`, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

let epochCache = { at: 0, value: 0, known: false };

// The current session epoch, remembered for thirty seconds per instance so
// the gate costs nothing on most requests. When the store cannot be reached
// the last known value stands.
//
// `known` is the fix for the random sign-outs. A fresh serverless instance
// starts with value 0, and when its FIRST read of the profile timed out the
// old code "kept the last known epoch": but nothing had ever been known, so
// it kept the placeholder 0, and isAuthed then compared a real epoch-1 cookie
// against 0 and refused it. Vercel starts fresh instances all day and the page
// fires ten calls at boot, so one landing on a cold instance with a slow
// pooler was a near certainty. Unknown is not zero; it is unknown, and the
// caller has to be told which it got.
export async function currentEpoch() {
  if (epochCache.known && Date.now() - epochCache.at < EPOCH_CACHE_MS) return epochCache.value;
  const p = profilePath();
  // No store means the epoch feature is off, which is a KNOWN state of zero.
  if (!p) { epochCache = { at: Date.now(), value: 0, known: true }; return 0; }
  // Two attempts: a cold connection pooler routinely misses the first one.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${p.url}?id=eq.1&select=session_epoch`, { headers: p.headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const rows = await r.json();
        epochCache = { at: Date.now(), value: Number((rows[0] || {}).session_epoch) || 0, known: true };
        return epochCache.value;
      }
    } catch {
      // try once more, then fall through with whatever we had
    }
  }
  return epochCache.value;
}

// Whether currentEpoch() has ever succeeded on this instance. While it has
// not, the epoch cannot be checked, and the caller must decide what a signed
// cookie is worth on its own.
export function epochKnown() {
  return epochCache.known;
}

// Raise the epoch by one: every cookie issued before this moment stops
// working. Returns the new epoch.
export async function bumpEpoch() {
  const p = profilePath();
  if (!p) throw new Error("Storage is not configured.");
  const next = (await currentEpoch()) + 1;
  const r = await fetch(`${p.url}?on_conflict=id`, {
    method: "POST",
    headers: { ...p.headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: 1, session_epoch: next }]),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("Could not update the session epoch (" + r.status + ").");
  epochCache = { at: Date.now(), value: next, known: true };
  return next;
}

// A signed cookie value for the given epoch, valid for thirty days.
export async function sessionValue(secret, epoch) {
  const exp = Math.floor(Date.now() / 1000) + THIRTY_DAYS;
  const sig = await hmacHex(secret, exp + "." + epoch);
  return exp + "." + epoch + "." + sig;
}

export function sessionCookie(value) {
  return COOKIE_NAME + "=" + value + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + THIRTY_DAYS;
}

export function clearedCookie() {
  return COOKIE_NAME + "=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

export async function isAuthed(req) {
  const secret = (process.env.AUTH_SECRET || "").trim();
  if (!secret) return false; // login layer is off
  const token = readCookie(cookieHeader(req), COOKIE_NAME);
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2 && parts.length !== 3) return false;
  const expStr = parts[0];
  if (!/^\d+$/.test(expStr)) return false; // exp must be a positive integer
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false; // expired
  const epoch = parts.length === 3 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(epoch) || epoch < 0 || (parts.length === 3 && !/^\d+$/.test(parts[1]))) return false;
  const sig = parts[parts.length - 1];
  const expected = await hmacHex(secret, parts.length === 3 ? expStr + "." + epoch : expStr);
  if (!timingSafeEqual(sig, expected)) return false;
  const current = await currentEpoch();
  /* The signature has already proved this server issued the cookie and it is
     inside its thirty days. The epoch only exists to revoke it early ("Sign
     out everywhere", a password change). If the store could not be reached
     at all, that revocation cannot be checked: the honest options are to
     accept a cookie we know we issued, or to sign every user out on every
     cold start. The window where a revoked cookie still works is one
     unreachable store on one fresh instance; the alternative was happening
     several times a day. */
  if (!epochKnown()) return true;
  return epoch === current;
}
