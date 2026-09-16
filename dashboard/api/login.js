// The login endpoint. Node serverless (NOT edge): pbkdf2 with 600k iterations
// would blow the edge CPU-ms budget, so this must run on node.
//
// GET                                -> which ways of signing in this deployment offers.
// POST {user, pass}                  -> the env-var login (CRM_USERS + CRM_PASS_HASH) or,
//                                       when the name is an email, a Supabase Auth login.
// POST {recover: 1, email}           -> emails a password reset link. Always answers ok.
// POST {access_token[, new_password]} -> turns the token a reset link or a Google
//                                       sign-in lands with into a session, setting
//                                       the new password first when one is given.
// POST {logout: 1}                   -> clears the cookie.
// POST {setup: 1, email, password, name} -> on a deployment nobody owns yet,
//                                           makes the owner's login and signs
//                                           them in.
//
// Whichever way you sign in, the session is the same HttpOnly cookie: an expiry
// signed with HMAC over AUTH_SECRET, which _auth.js re-checks on every API call.
// Supabase Auth is only ever asked "are these credentials good", server to
// server with the service key, so the page never holds a Supabase key or
// library and nothing else in the CRM had to change to gain email login.
//
// Whichever way you sign in, an allow-list decides who is let in: CRM_USERS, plus
// the emails a signed-in operator authorized by making a login in Settings, You.
// Supabase Auth only ever answers who someone is: with Google sign-in on, anyone
// with a Google account can become a Supabase user, so an identity Supabase
// vouches for is not permission to use this CRM until that email is on one of
// those two lists. Both of them empty lets nobody in through Supabase.
//
// The env-var password is never stored anywhere: the student sets CRM_PASS_SALT
// and CRM_PASS_HASH (salt + PBKDF2 hash of their chosen password) as Vercel env
// vars. We hash the submitted password the same way and compare in constant
// time.
//
// A brand new deployment has none of that yet, and the first person to reach it
// makes the owner's login on the login screen itself. That replaced the day-one
// ritual every student had to perform before they could see their own CRM: run a
// node one-liner to salt and hash a password, paste three values into Vercel,
// redeploy. The screen is offered for exactly as long as this CRM has no way in
// at all, and shut the moment it has one. The GET says whether to draw it; the
// POST decides whether to honour it, and only the second of those is security.
import { pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { currentEpoch, bumpEpoch, sessionValue, sessionCookie as cookieFor, clearedCookie as cleared } from "./_auth.js";
import { readAllowedEmails, addAllowedEmail, saveTeamMember, readAllowedEmailsStrict, dropAllowedEmail } from "./_profile.js";

export const config = { runtime: "nodejs" };

const COOKIE_NAME = "crm_session";
const THIRTY_DAYS = 2592000; // seconds
const PBKDF2_ITERS = 600000;
const PBKDF2_KEYLEN = 32;
const FAIL_DELAY_MS = 800; // constant wait on every failure, to blunt brute force
const PROVIDER_TTL_MS = 300000; // how long one instance remembers whether Google is on
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // the shape account.js accepts, Supabase judges the rest
const MIN_PASSWORD = 8; // the floor account.js puts on a colleague's password
const MIN_SETUP_CODE = 8; // a shorter code is treated as no code at all

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settings() {
  const s = {
    secret: (process.env.AUTH_SECRET || "").trim(),
    hash: (process.env.CRM_PASS_HASH || "").trim(),
    salt: (process.env.CRM_PASS_SALT || "").trim(),
    users: (process.env.CRM_USERS || "").trim(),
    sbUrl: (process.env.SUPABASE_URL || "").trim().replace(/\/$/, ""),
    sbKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    setupCode: (process.env.SETUP_CODE || "").trim(),
  };
  // "crm" as a setup code would hand the CRM to the first guess, so a code
  // under the floor counts as unset and the page asks for a longer one.
  if (s.setupCode.length < MIN_SETUP_CODE) s.setupCode = "";
  s.legacy = !!(s.hash && s.salt && s.users);
  s.supabase = !!(s.sbUrl && s.sbKey);
  return s;
}

// Vercel parses a JSON body into req.body, but be defensive: accept an object, a
// JSON string, or a raw stream. Returns null when the body is not valid JSON, so
// a malformed body is treated as a failed attempt (same 401 as bad credentials).
async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === "object") return req.body;
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch { return null; }
    }
  }
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function clearedCookie() {
  return cleared();
}

// Who signed in, readable by the page. The session cookie is HttpOnly and
// carries no identity on purpose, so the sidebar had nothing to show but the
// sending address from Settings, which is not who is logged in. This one is a
// plain cookie holding the email or username that was accepted, nothing else.
const WHO_COOKIE = "crm_who";
function whoCookie(who) {
  const v = encodeURIComponent(String(who || "").trim().toLowerCase().slice(0, 120));
  return WHO_COOKIE + "=" + v + "; Secure; SameSite=Strict; Path=/; Max-Age=" + THIRTY_DAYS;
}
function clearedWhoCookie() {
  return WHO_COOKIE + "=; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

// A cookie stamped with the current session epoch, or with the one just
// made when this sign-in itself changed the password.
async function issueSession(res, cfg, epoch, who) {
  const e = Number.isFinite(epoch) ? epoch : await currentEpoch();
  res.setHeader("Set-Cookie", [cookieFor(await sessionValue(cfg.secret, e)), whoCookie(who)]);
}

// Check a submitted user+pass against the configured allow-list and hash. This
// always runs the full PBKDF2 regardless of whether the username is known, so the
// time it takes never reveals whether a username exists (no user enumeration).
function verifyCredentials(body, cfg) {
  const user = String((body && body.user) || "").trim().toLowerCase();
  const pass = String((body && body.pass) || "");
  const allowed = cfg.users.split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
  const userOk = allowed.includes(user);

  let salt, expected;
  try {
    salt = Buffer.from(cfg.salt, "hex");
    expected = Buffer.from(cfg.hash, "hex");
  } catch {
    return false;
  }

  // Always derive, even for an unknown user, to keep the timing uniform.
  const derived = pbkdf2Sync(pass, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, "sha256");

  // Guard the length first (timingSafeEqual throws on a mismatch), but still run
  // a compare either way so the branch does not leak timing.
  let passOk;
  if (derived.length === expected.length && expected.length > 0) {
    passOk = timingSafeEqual(derived, expected);
  } else {
    timingSafeEqual(derived, derived); // dummy, keep timing steady
    passOk = false;
  }

  return userOk && passOk;
}

// Whether an email Supabase vouched for is allowed to use this CRM. Two lists
// answer it: the same CRM_USERS verifyCredentials reads, and the emails stored by
// Settings, You when a signed-in operator made a login. Both empty matches nobody
// on purpose: a Supabase identity is not permission, and the CRM has to refuse on
// its own rather than lean on the signup setting of another system.
const crmUsers = (cfg) => cfg.users.split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);

async function emailAllowed(cfg, email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  if (crmUsers(cfg).includes(who)) return true;
  // Read only when CRM_USERS does not already cover the email, so that route
  // never waits on storage. A read that fails comes back empty, which refuses.
  return (await readAllowedEmails()).includes(who);
}

// Whether anybody at all could get through the gate right now.
/* Fails closed. This answers two questions: whether to offer the Google
   button, and whether a deployment is fresh enough to hand its owner's login
   to whoever is looking at it. An allow-list that could not be read is not
   an empty allow-list. Answering "somebody is allowed" on a bad read costs
   a Google button that leads to a 403 for a minute; answering "nobody" would
   put the first-run screen in front of a stranger. */
async function anyoneAllowed(cfg) {
  if (crmUsers(cfg).length) return true;
  const got = await readAllowedEmailsStrict();
  if (got.error) return true;
  return got.list.length > 0;
}

async function authFetch(cfg, path, init = {}) {
  const res = await fetch(cfg.sbUrl + "/auth/v1" + path, {
    ...init,
    headers: { apikey: cfg.sbKey, "content-type": "application/json", ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body: body || {} };
}

const authError = (r, fallback) =>
  (r.body && (r.body.msg || r.body.error_description || r.body.message)) || fallback;

// The admin half of Supabase Auth, which wants the service key as a bearer
// token on top of the apikey header.
//
// This one swallows a transport failure where authFetch lets it through, and
// the difference is deliberate. Both of its callers are decisions taken for an
// unauthenticated stranger standing in front of a deployment that may have no
// login yet, and a URL that does not resolve has to become a definite no there,
// not an exception the runtime turns into a 500 with nothing on the screen. A
// mistyped SUPABASE_URL is a day-one certainty, and it should read as "this CRM
// is not ready", never as "this CRM is empty, help yourself".
async function adminFetch(cfg, path, init = {}) {
  try {
    return await authFetch(cfg, "/admin" + path, {
      ...init,
      headers: { authorization: "Bearer " + cfg.sbKey, ...(init.headers || {}) },
    });
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

// "Are this email and password good?" asked of Supabase Auth. Returns the email
// of the signed-in user, or "" for anything short of a clean yes.
async function supabaseSignIn(cfg, email, pass) {
  const r = await authFetch(cfg, "/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password: pass }),
  });
  return r.ok && r.body.user && r.body.user.email ? r.body.user.email : "";
}

async function emailForToken(cfg, token) {
  const r = await authFetch(cfg, "/user", { headers: { authorization: "Bearer " + token } });
  return r.ok && r.body.email ? r.body.email : "";
}

async function setPassword(cfg, token, password) {
  const r = await authFetch(cfg, "/user", {
    method: "PUT",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify({ password }),
  });
  return r.ok ? "" : authError(r, "Could not set that password.");
}

let providerCache = { at: 0, google: false };
async function googleOn(cfg) {
  if (!cfg.supabase) return false;
  if (Date.now() - providerCache.at < PROVIDER_TTL_MS) return providerCache.google;
  const r = await authFetch(cfg, "/settings");
  providerCache = { at: Date.now(), google: !!(r.ok && r.body.external && r.body.external.google) };
  return providerCache.google;
}

// Whether Supabase Auth holds no users at all. One page of one answers it, so
// this costs the same on a CRM with a thousand logins as on an empty one.
//
// A read that did not succeed answers "there are users". The only question this
// is ever asked in service of is whether to let an unauthenticated stranger
// make an owner's login, and a Supabase that failed to answer is not evidence
// that nobody has signed up here.
async function noSupabaseUsers(cfg) {
  const r = await adminFetch(cfg, "/users?per_page=1");
  return !!(r.ok && Array.isArray(r.body.users) && r.body.users.length === 0);
}

// Is this a deployment nobody owns yet?
//
// Fresh means every way in is absent at the same moment: AUTH_SECRET set so
// there is a session to issue at the end, no env-var login, nobody on either
// allow-list, Supabase connected so there is somewhere to put the login, and
// not one user in Supabase Auth. Any single one of those failing means this CRM
// already has a door, and the first-run screen is then neither offered nor
// honoured. Nothing here is cached: the POST re-asks the whole question at the
// moment it would write, because the answer the GET gave is minutes old and was
// given to whoever asked.
//
// The local answers come first and it stops at the first no, so a CRM in daily
// use is settled by the same allow-list the login screen was reading anyway and
// never touches the admin API. Pass `anyone` when the caller has already read
// that list, to save the second trip.
//
// `needs` is the single thing a deployment that is fresh but for Supabase gets
// told, as one word. A student who has not connected Supabase has to be told
// something, and naming the variables they are missing is not a sentence this
// endpoint says to an unauthenticated caller.
async function freshState(cfg, anyone) {
  if (!cfg.secret || cfg.legacy) return { fresh: false, needs: "" };
  if (anyone === undefined ? await anyoneAllowed(cfg) : anyone) return { fresh: false, needs: "" };
  if (!cfg.supabase) return { fresh: false, needs: "supabase" };
  return { fresh: await noSupabaseUsers(cfg), needs: "" };
}

// The page this CRM lives on, on the host the browser reached, so reset links
// and Google come back to the same deployment that sent them. Supabase only
// honours hosts on its allow-list, so a forged host header goes nowhere.
function pageUrl(req) {
  const host = String(req.headers.host || "").split(",")[0].trim();
  return "https://" + host + "/crm-close.html";
}

/* A database that cannot be reached (a typo in SUPABASE_URL, a paused
   project) used to crash the function, and the page showed Vercel's own
   error. It now says what is wrong in the login box instead. */
export default async function handler(req, res) {
  try { return await run(req, res); }
  catch (err) {
    return res.status(503).json({ ok: false, error: "The database did not answer (" + ((err && err.message) || "unreachable") + "). Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, then redeploy." });
  }
}

async function run(req, res) {
  const cfg = settings();

  if (req.method === "GET") {
    if (!cfg.secret) return res.status(200).json({ ok: true, off: true });
    // Read once and used twice: the allow-list is a round trip to storage and
    // both of the answers below turn on it.
    const anyone = await anyoneAllowed(cfg);
    // Google is offered only when somebody could actually pass the gate. With
    // both lists empty every Google sign-in ends at the same 403, and a button
    // that can only refuse you is worse than no button.
    const google = (await googleOn(cfg)) && anyone;
    const state = await freshState(cfg, anyone);
    const answer = {
      ok: true,
      legacy: cfg.legacy,
      email: cfg.supabase,
      google,
      google_url: google
        ? cfg.sbUrl + "/auth/v1/authorize?provider=google&redirect_to=" + encodeURIComponent(pageUrl(req))
        : "",
      // True only where there is no way in at all, which is the page's cue to
      // ask for an owner instead of for a password.
      fresh: state.fresh && !!cfg.setupCode,
    };
    /* One word, never an environment variable: enough for the page to say
       "connect Supabase first" and no more than that. */
    if (state.needs) answer.setup_needs = state.needs;
    else if (state.fresh && !cfg.setupCode) answer.setup_needs = "code";
    return res.status(200).json(answer);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  if (!cfg.secret || !(cfg.legacy || cfg.supabase)) {
    // Plain message on purpose: never name the missing env vars to the page.
    return res.status(500).json({ ok: false, error: "Login is not configured." });
  }

  const body = await readBody(req);

  if (body && body.logout) {
    res.setHeader("Set-Cookie", [clearedCookie(), clearedWhoCookie()]);
    return res.status(200).json({ ok: true });
  }

  /* Making the owner's login on a deployment that has none. Everything after
     the first check is validation; that check is the whole security of this,
     and it is made here, against storage, at the moment of the write. What the
     GET answered minutes ago is a hint for drawing a screen and is never taken
     as permission. */
  if (body && body.setup) {
    if (!(await freshState(cfg)).fresh) {
      await sleep(FAIL_DELAY_MS);
      return res.status(403).json({ ok: false, error: "This CRM already has an owner." });
    }
    /* A new *.vercel.app address is in the public certificate logs within
       seconds of deploying, so fresh is not the same as unseen: whoever
       posted here first would own the CRM. The code setup.mjs made, or the
       SETUP_CODE set by hand, says the owner is the person who deployed it.
       Compared in constant time, like a password. */
    if (!cfg.setupCode) {
      await sleep(FAIL_DELAY_MS);
      return res.status(403).json({ ok: false, error: "This CRM has no setup code yet." });
    }
    const given = Buffer.from(String(body.setup_code || ""), "utf8");
    const wanted = Buffer.from(cfg.setupCode, "utf8");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      await sleep(FAIL_DELAY_MS);
      return res.status(403).json({ ok: false, error: "That setup code is not right." });
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL.test(email)) {
      return res.status(400).json({ ok: false, error: "That does not look like an email." });
    }
    const password = String(body.password || "");
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ ok: false, error: "Use a password of at least " + MIN_PASSWORD + " characters." });
    }
    const name = String(body.name || "").trim().slice(0, 80);

    /* Two people running setup in the same second both get past the check
       above. Supabase settles it: the address is unique in auth.users, so the
       second create is refused and that request ends at the 502 below having
       written nothing and been given no session. The loser cannot simply try
       again either, because the winner's user is now the reason this deployment
       is no longer fresh.

       What Supabase said about it is not passed on. Its 422 reads "already
       registered", which would tell an unauthenticated caller that an address
       has a login here: the enumeration the rest of this file goes out of its
       way to avoid. */
    const made = await adminFetch(cfg, "/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!made.ok) {
      return res.status(502).json({ ok: false, error: "Could not make that login. Try again in a moment." });
    }
    /* Allowed in after Supabase took the login, the same order account.js uses,
       and said out loud when it cannot be stored. The gate reads the allow-list,
       so a silent failure here would leave a login that exists and cannot sign
       in, and a student staring at a screen refusing the password they chose
       four seconds ago is worse than an error that says what went wrong. */
    /* If either write after this fails, the login is taken back. Otherwise the
       deployment is no longer fresh (a Supabase user exists) and the person
       who made it cannot sign in (the gate never heard of them): a lockout
       nobody can undo from the product. Deleting a user created seconds ago
       in this same request, on a deployment verified fresh at its start, is
       the one deletion here that is safe. */
    const undo = async () => { if (made.body && made.body.id) await adminFetch(cfg, "/users/" + made.body.id, { method: "DELETE" }); };
    const listErr = await addAllowedEmail(email);
    if (listErr) { await undo(); return res.status(502).json({ ok: false, error: listErr }); }
    /* Same again for the readable half of them. Owner, because this one is: it
       is a label rather than a permission, and the person who made the CRM is
       the one the Team page should name as owning it. */
    const teamErr = await saveTeamMember(email, name, "Owner");
    if (teamErr) { await undo(); await dropAllowedEmail(email); return res.status(502).json({ ok: false, error: teamErr }); }

    /* Signed in on the spot. Asking somebody to retype the password they chose
       four seconds ago into the form underneath would be a second step that
       proves nothing the last three calls have not already proved. */
    await issueSession(res, cfg, undefined, email);
    return res.status(200).json({ ok: true, who: email });
  }

  if (body && body.recover) {
    if (!cfg.supabase) {
      return res.status(400).json({ ok: false, error: "Email login is not set up on this CRM yet." });
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (email) {
      const r = await authFetch(cfg, "/recover?redirect_to=" + encodeURIComponent(pageUrl(req)), {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      if (r.status === 429) {
        return res.status(429).json({ ok: false, error: "Too many reset emails for now. Try again in a little while." });
      }
    }
    // The same answer whether or not that email has a login: no user enumeration.
    return res.status(200).json({ ok: true });
  }

  /* A one-click sign-in link, for people who would rather not type a password.
     Only an address on the list gets one, and the answer is the same either
     way, so the form cannot be used to find out who is on it. The link lands
     back here with an access token, the same path a reset link takes. */
  if (body && body.magic) {
    if (!cfg.supabase) {
      return res.status(400).json({ ok: false, error: "Email login is not set up on this CRM yet." });
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (email && (await emailAllowed(cfg, email))) {
      const r = await authFetch(cfg, "/otp?redirect_to=" + encodeURIComponent(pageUrl(req)), {
        method: "POST",
        body: JSON.stringify({ email, create_user: false }),
      });
      if (r.status === 429) {
        return res.status(429).json({ ok: false, error: "Too many sign-in links for now. Try again in a little while." });
      }
    }
    return res.status(200).json({ ok: true });
  }

  if (body && body.access_token) {
    if (!cfg.supabase) {
      return res.status(400).json({ ok: false, error: "Email login is not set up on this CRM yet." });
    }
    const token = String(body.access_token);
    const newPass = String(body.new_password || "");
    // Check the token before doing anything with it, so a dead link reads as a
    // dead link and not as whatever Supabase says about an unparseable JWT.
    const email = await emailForToken(cfg, token);
    if (!email) {
      await sleep(FAIL_DELAY_MS);
      return res.status(401).json({ ok: false, error: "That link has expired. Ask for a new one." });
    }
    // A live token says who this is, not that they belong here. Checked before
    // the password is set as well as before the session, so a token from outside
    // the list leaves nothing behind it.
    if (!(await emailAllowed(cfg, email))) {
      await sleep(FAIL_DELAY_MS);
      return res.status(403).json({ ok: false, error: "That account is not allowed to use this CRM." });
    }
    let epoch;
    if (newPass) {
      const err = await setPassword(cfg, token, newPass);
      if (err) return res.status(400).json({ ok: false, error: err });
      /* A new password signs every other device out. */
      try { epoch = await bumpEpoch(); } catch { epoch = undefined; }
    }
    await issueSession(res, cfg, epoch, email);
    return res.status(200).json({ ok: true, email });
  }

  const user = String((body && body.user) || "").trim().toLowerCase();
  let ok = cfg.legacy && verifyCredentials(body, cfg);
  if (!ok && cfg.supabase && user.includes("@")) {
    // Supabase says whether the password is right; CRM_USERS says whether that
    // email is let in at all, the same test the reset and Google path makes.
    const signedIn = await supabaseSignIn(cfg, user, String((body && body.pass) || ""));
    ok = await emailAllowed(cfg, signedIn);
  }
  if (!ok) {
    await sleep(FAIL_DELAY_MS);
    // Never say whether the name or the password was wrong.
    return res.status(401).json({ ok: false, error: "Wrong email or password." });
  }

  await issueSession(res, cfg, undefined, user);
  return res.status(200).json({ ok: true, who: user });
}
