// The team: every email that can sign in to this CRM, and who it belongs to.
//
// Supabase Auth holds the login itself. It knows an address and when that
// address last signed in, and nothing else, so the readable half of a
// colleague (their name, and what they are here to do) is kept in the profile
// row and joined on here. One endpoint answers the whole Team page.
//
// GET                                -> { configured, logins: [{email, name, role, last_sign_in}] }
// POST {email, password, name, role} -> creates the login, or sets a new password on it
// POST {email, name, role}           -> renames or re-roles an existing member
// POST {email, remove: 1}            -> removes the login
// POST {signout_all: 1}              -> ends every session but this one
//
// Making a login here also puts the email on the sign-in allow-list, and removing
// one takes it off again. Doing this from a signed-in session is what authorizes
// that person, and the login screen refuses anyone neither list names, so a login
// made without the list entry would be a login nobody could use.
//
// A role is a label, not a permission. Everyone who can sign in can do
// everything; the page says that out loud rather than implying a restriction
// nothing enforces.
import { isAuthed, bumpEpoch, sessionValue, sessionCookie } from "./_auth.js";
import { addAllowedEmail, dropAllowedEmail, readTeam, saveTeamMember, dropTeamMember, TEAM_ROLES } from "./_profile.js";

export const config = { runtime: "edge" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

// Signs everyone out except the person doing it: the epoch goes up and the
// answer carries a cookie stamped with the new one.
async function signedOutOthers(body, status = 200) {
  const secret = (process.env.AUTH_SECRET || "").trim();
  let epoch;
  try { epoch = await bumpEpoch(); } catch (e) { return json({ ok: false, error: e.message }, 502); }
  const cookie = sessionCookie(await sessionValue(secret, epoch));
  return json({ ...body, others_signed_out: true }, status, { "set-cookie": cookie });
}

function cfg() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return { url, key, configured: !!(url && key) };
}

async function admin(c, path, init = {}) {
  const res = await fetch(c.url + "/auth/v1/admin" + path, {
    ...init,
    headers: {
      apikey: c.key,
      authorization: "Bearer " + c.key,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body: body || {} };
}

const adminError = (r, fallback) => (r.body && (r.body.msg || r.body.message)) || fallback;

async function listLogins(c) {
  const r = await admin(c, "/users?per_page=200");
  if (!r.ok) throw new Error(adminError(r, "Could not read the logins."));
  return (r.body.users || []).map((u) => ({
    id: u.id,
    email: u.email || "",
    last_sign_in: u.last_sign_in_at || "",
    created: u.created_at || "",
  }));
}

const publicLogin = (l) => ({ email: l.email, last_sign_in: l.last_sign_in, created: l.created });

// One login, dressed with whoever it belongs to.
const withMember = (l, team) => {
  const m = team.find((t) => t.email === String(l.email || "").toLowerCase());
  return { ...publicLogin(l), name: (m && m.name) || "", role: (m && m.role) || "Sales" };
};

export default async function handler(req) {
  if (!(await isAuthed(req))) return json({ ok: false, login: true, error: "Sign in first." }, 401);
  const c = cfg();

  if (req.method === "GET") {
    if (!c.configured) return json({ ok: true, configured: false, logins: [], roles: TEAM_ROLES });
    try {
      const [logins, team] = await Promise.all([listLogins(c), readTeam()]);
      return json({ ok: true, configured: true, roles: TEAM_ROLES, logins: logins.map((l) => withMember(l, team)) });
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    }
  }

  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
  if (!c.configured) {
    return json({ ok: false, error: "Supabase is not connected, so email logins cannot be made yet." }, 400);
  }

  let body = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
  if (body.signout_all) return signedOutOthers({ ok: true });
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return json({ ok: false, error: "That does not look like an email." }, 400);

  let logins;
  try { logins = await listLogins(c); } catch (e) { return json({ ok: false, error: e.message }, 502); }
  const existing = logins.find((l) => l.email.toLowerCase() === email);

  const name = String(body.name || "").trim().slice(0, 80);
  const role = TEAM_ROLES.includes(String(body.role)) ? String(body.role) : "Sales";

  if (body.remove) {
    /* Off the allow-list first, whether or not Supabase still has the login, and
       stop here if that cannot be saved. The other order would delete the login
       and leave the email allowed in, which Google sign-in could then walk through. */
    const listErr = await dropAllowedEmail(email);
    if (listErr) return json({ ok: false, error: listErr }, 502);
    await dropTeamMember(email);
    if (!existing) return json({ ok: true, removed: false });
    const r = await admin(c, "/users/" + existing.id, { method: "DELETE" });
    if (!r.ok) return json({ ok: false, error: adminError(r, "Could not remove that login.") }, 502);
    return signedOutOthers({ ok: true, removed: true });
  }

  const password = String(body.password || "");

  /* Changing somebody's name or role is not a password change. Asking for a
     password to fix a typo in a colleague's name would mean resetting their
     login to rename them, and would sign them out to do it. */
  if (!password && existing) {
    const teamErr = await saveTeamMember(email, name, role);
    if (teamErr) return json({ ok: false, error: teamErr }, 502);
    return json({ ok: true, email, created: false, updated: true });
  }

  if (password.length < MIN_PASSWORD) {
    return json({ ok: false, error: "Use a password of at least " + MIN_PASSWORD + " characters." }, 400);
  }
  const r = existing
    ? await admin(c, "/users/" + existing.id, { method: "PUT", body: JSON.stringify({ password, email_confirm: true }) })
    : await admin(c, "/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!r.ok) return json({ ok: false, error: adminError(r, "Supabase refused that login.") }, 502);
  /* Allowed in only after Supabase took the login, so a typo that Supabase turns
     down never authorizes an address. Said out loud when it cannot be saved: a
     login that silently cannot sign in is worse than an error on this screen. */
  const listErr = await addAllowedEmail(email);
  if (listErr) return json({ ok: false, error: listErr }, 502);
  /* The name and role are the readable half of the same person, so a failure to
     save them is said out loud rather than leaving a nameless row on Team. */
  const teamErr = await saveTeamMember(email, name, role);
  if (teamErr) return json({ ok: false, error: teamErr }, 502);

  /* Changing an existing password ends every other session, because the whole
     point of changing it is that the old one stops working. Adding a NEW
     colleague does not: nobody's credentials changed, and a session cookie
     carries no identity, so the only lever available (the epoch) would sign
     the entire team out because one person was hired. */
  if (existing) return signedOutOthers({ ok: true, email, created: false });
  return json({ ok: true, email, created: true });
}
