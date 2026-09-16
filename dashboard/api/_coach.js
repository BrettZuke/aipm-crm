// The online coach book: leads, and the shape the rest of the CRM expects.
//
// Local business leads are scraped from Google Maps in their thousands and
// live in the Google Sheet. A coach is different in every way that matters:
// there is one at a time, they are found by hand, and the only thing you
// reliably have is a profile URL. No address, no trade, no Google rating.
// So they live here, in Supabase, and never touch the sheet.
//
// Deliberately NOT a scraper. Scraping Instagram from a student's own account
// is how that account gets banned, so a coach is added by pasting a link or a
// username and nothing in this file ever talks to Instagram.
import { fetchRows, demoPath } from "./_rows.js";

const PLATFORMS = ["instagram", "youtube", "tiktok", "x", "linkedin", "facebook", "other"];

/* Every spelling of "here is a profile" a person might paste.
   Ordered longest-host-first so twitter.com is not caught by the x.com rule. */
const HOSTS = [
  [/(?:^|\.)instagram\.com$/, "instagram"],
  [/(?:^|\.)youtube\.com$/, "youtube"],
  [/(?:^|\.)youtu\.be$/, "youtube"],
  [/(?:^|\.)tiktok\.com$/, "tiktok"],
  [/(?:^|\.)linkedin\.com$/, "linkedin"],
  [/(?:^|\.)facebook\.com$/, "facebook"],
  [/(?:^|\.)fb\.com$/, "facebook"],
  [/(?:^|\.)twitter\.com$/, "x"],
  [/(?:^|\.)x\.com$/, "x"],
];

/* Path segments that are the site's own furniture, not somebody's name. */
const NOT_A_HANDLE = new Set(["in", "company", "c", "channel", "user", "profile", "p", "pages", "watch", "shorts"]);

/**
 * Turn whatever was pasted into { handle, platform, profile_url }.
 * Accepts a full URL, a bare @handle, or a bare username. Returns null when
 * there is nothing usable, so the caller can say so rather than saving a row
 * that means nothing.
 */
export function parseHandle(input, platformHint) {
  let raw = String(input || "").trim();
  if (!raw) return null;

  let platform = PLATFORMS.includes(platformHint) ? platformHint : "";
  let handle = "";
  let url = "";

  if (/^https?:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}\//i.test(raw)) {
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    } catch {
      return null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const [re, name] of HOSTS) {
      if (re.test(host)) { platform = name; break; }
    }
    if (!platform) platform = "other";

    const parts = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    // linkedin.com/in/someone and youtube.com/channel/xyz put the name second.
    const first = parts.find((p) => !NOT_A_HANDLE.has(p.toLowerCase()));
    handle = (first || "").replace(/^@/, "");
    // A bare domain with no path is somebody's website, not a social profile.
    if (!handle) { url = u.origin + u.pathname; return { handle: host, platform: "other", profile_url: url }; }
    url = u.origin + "/" + (platform === "linkedin" && parts[0] === "in" ? "in/" : "") + (platform === "tiktok" || platform === "youtube" ? "@" : "") + handle;
  } else {
    handle = raw.replace(/^@/, "").split(/[\/\s?]/)[0];
    if (!platform) platform = "instagram"; // the overwhelming default for coaches
    url = profileUrl(handle, platform);
  }

  handle = handle.replace(/^@+/, "").trim();
  if (!handle || handle.length > 120) return null;
  /* A handle is letters, digits, dots, underscores and hyphens. Without this
     a mistyped link saves a row called "ht!tp:" that nobody can find again. */
  if (!/^[A-Za-z0-9._-]+$/.test(handle)) return null;
  if (!PLATFORMS.includes(platform)) platform = "other";
  return { handle, platform, profile_url: url || profileUrl(handle, platform) };
}

export function profileUrl(handle, platform) {
  const h = String(handle || "").replace(/^@/, "");
  if (!h) return "";
  switch (platform) {
    case "instagram": return "https://instagram.com/" + h;
    case "youtube": return "https://youtube.com/@" + h;
    case "tiktok": return "https://tiktok.com/@" + h;
    case "x": return "https://x.com/" + h;
    case "linkedin": return "https://linkedin.com/in/" + h;
    case "facebook": return "https://facebook.com/" + h;
    default: return "";
  }
}

/* A coach row, dressed as the lead object the rest of the app already knows.
   Doing the mapping here means the lead list, the drawer, sorting, coldness
   and the activity timeline all work on coaches without a second code path. */
export function toLead(r) {
  const platform = PLATFORMS.includes(r.platform) ? r.platform : "other";
  const url = r.profile_url || profileUrl(r.handle, platform);
  return {
    row: r.id,
    coach: true,
    business: r.business || r.name || "@" + r.handle,
    name: r.name || "",
    handle: r.handle || "",
    platform,
    profile_url: url,
    followers: Number.isFinite(+r.followers) ? +r.followers : null,
    category: r.niche || "",
    city: "",
    address: "",
    phone: r.phone || "",
    email: r.email || "",
    website: r.website || "",
    instagram: platform === "instagram" ? url : "",
    facebook: platform === "facebook" ? url : "",
    linkedin: platform === "linkedin" ? url : "",
    rating: null,
    reviews: null,
    heat: r.heat || "WARM",
    status: r.status || "Not DM'd",
    notes: r.notes || "",
    assigned_to: r.assigned_to || "",
    snooze_until: r.snooze_until ? String(r.snooze_until).slice(0, 10) : "",
    lead_code: r.lead_code || "",
    website_status: "",
  };
}

export function db() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

export async function readCoachLeads(store) {
  const table = demoPath("coach_leads");
  const got = await fetchRows(store, `${table}?deleted=is.false&order=created_at.desc`, { max: 10000, timeout: 8000 });
  return got.rows.map(toLead);
}

export async function coachWrite(store, body) {
  const table = demoPath("coach_leads");
  const rest = (path, init) =>
    fetch(store.url + "/rest/v1/" + path, {
      ...init,
      headers: { ...store.headers, ...(init && init.headers) },
      signal: AbortSignal.timeout(8000),
    });

  if (body.op === "add_lead") {
    const parsed = parseHandle(body.paste || body.handle || body.instagram || "", body.platform);
    if (!parsed) return { ok: false, error: "Paste their profile link or their username." };
    const row = {
      handle: parsed.handle,
      platform: parsed.platform,
      profile_url: parsed.profile_url,
      name: String(body.name || "").trim().slice(0, 160) || null,
      business: String(body.business || "").trim().slice(0, 160) || null,
      niche: String(body.niche || body.category || "").trim().slice(0, 80) || null,
      followers: Number.isFinite(+body.followers) ? Math.max(0, Math.round(+body.followers)) : null,
      email: String(body.email || "").trim().slice(0, 200) || null,
      phone: String(body.phone || "").trim().slice(0, 60) || null,
      website: String(body.website || "").trim().slice(0, 300) || null,
      heat: ["HOT", "WARM", "COOL"].includes(body.heat) ? body.heat : "WARM",
      status: String(body.status || "Not DM'd").trim().slice(0, 60) || "Not DM'd",
      notes: String(body.notes || "").trim().slice(0, 2000) || null,
    };
    const res = await rest(table, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([row]),
    });
    if (res.status === 409) return { ok: false, error: "You already have " + parsed.handle + " on your list." };
    if (!res.ok) return { ok: false, error: "Could not add that coach." };
    const saved = await res.json();
    return { ok: true, lead: toLead(saved[0]), row: saved[0].id };
  }

  /* A batch, from a CSV or a script. Each row is parsed the same way one
     pasted profile is, so a column of full URLs, bare handles or @names all
     land. Duplicates are found in JS against what is already there rather
     than with ON CONFLICT: the handle index is partial (deleted = false), and
     Postgres will not take a partial index as a conflict target, which is
     the trap that silently refused every activity insert for a day. */
  if (body.op === "add_leads") {
    const wanted = (Array.isArray(body.leads) ? body.leads : []).slice(0, 500);
    const rows = [], seen = new Set();
    let invalid = 0, skipped = 0;
    for (const l of wanted) {
      const raw = String(l.paste || l.handle || l.instagram || l.profile_url || "").trim();
      /* parseHandle takes the first word of whatever is pasted, a leniency
         for one profile typed by hand with something after it. In a CSV that
         turns "not a handle" into a coach called @not. A handle has no spaces
         and a link starts with a scheme, so anything else is a bad row. */
      if (/\s/.test(raw) && !/^https?:\/\//i.test(raw)) { invalid++; continue; }
      const parsed = parseHandle(raw, l.platform);
      if (!parsed) { invalid++; continue; }
      const k = parsed.platform + ":" + parsed.handle.toLowerCase();
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);
      rows.push({
        handle: parsed.handle,
        platform: parsed.platform,
        profile_url: parsed.profile_url,
        name: String(l.name || "").trim().slice(0, 160) || null,
        business: String(l.business || "").trim().slice(0, 160) || null,
        niche: String(l.niche || l.category || "").trim().slice(0, 80) || null,
        followers: Number.isFinite(+l.followers) ? Math.max(0, Math.round(+l.followers)) : null,
        email: String(l.email || "").trim().slice(0, 200).toLowerCase() || null,
        phone: String(l.phone || "").trim().slice(0, 60) || null,
        website: String(l.website || "").trim().slice(0, 300) || null,
        heat: ["HOT", "WARM", "COOL"].includes(l.heat) ? l.heat : "WARM",
        status: String(l.status || "Not DM'd").trim().slice(0, 60) || "Not DM'd",
        notes: String(l.notes || "").trim().slice(0, 2000) || null,
      });
    }
    if (!rows.length) return { ok: true, added: 0, skipped, invalid };
    const have = await fetchRows(store, `${table}?deleted=is.false&select=handle,platform`, { max: 10000, timeout: 8000 });
    const existing = new Set(have.rows.map((r) => r.platform + ":" + String(r.handle || "").toLowerCase()));
    const fresh = rows.filter((r) => {
      const dup = existing.has(r.platform + ":" + r.handle.toLowerCase());
      if (dup) skipped++;
      return !dup;
    });
    if (!fresh.length) return { ok: true, added: 0, skipped, invalid };
    const res = await rest(table, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fresh) });
    if (!res.ok) return { ok: false, error: "Could not add those coaches (" + res.status + ")." };
    return { ok: true, added: fresh.length, skipped, invalid };
  }

  const id = parseInt(body.row, 10);
  if (!Number.isFinite(id)) return { ok: false, error: "Which coach?" };

  if (body.op === "remove_lead") {
    const res = await rest(`${table}?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ deleted: true }) });
    return res.ok ? { ok: true, row: id } : { ok: false, error: "Could not remove that coach." };
  }
  if (body.op === "restore_lead") {
    const res = await rest(`${table}?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ deleted: false }) });
    return res.ok ? { ok: true, row: id } : { ok: false, error: "Could not restore that coach." };
  }

  /* update_lead, and the status/note writes the drawer and the dialler send.
     Only these columns may be written: anything else the page sends is
     ignored rather than trusted. */
  const patch = {};
  const fields = body.fields && typeof body.fields === "object" ? body.fields : body;
  const allow = { name: 160, business: 160, niche: 80, email: 200, phone: 60, website: 300, notes: 4000, handle: 120, status: 60, assigned_to: 200 };
  for (const [k, max] of Object.entries(allow)) {
    if (fields[k] !== undefined) patch[k] = String(fields[k] || "").trim().slice(0, max) || null;
  }
  if (fields.snooze_until !== undefined) patch.snooze_until = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.snooze_until || "")) ? String(fields.snooze_until) : null;
  if (fields.category !== undefined && patch.niche === undefined) patch.niche = String(fields.category || "").trim().slice(0, 80) || null;
  if (["HOT", "WARM", "COOL"].includes(fields.heat)) patch.heat = fields.heat;
  if (PLATFORMS.includes(fields.platform)) patch.platform = fields.platform;
  if (fields.followers !== undefined) patch.followers = Number.isFinite(+fields.followers) ? Math.max(0, Math.round(+fields.followers)) : null;
  if (patch.handle) patch.profile_url = profileUrl(patch.handle, patch.platform || fields.platform || "instagram");
  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change." };

  const res = await rest(`${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return { ok: false, error: "Could not save that." };
  const saved = await res.json();
  return { ok: true, row: id, fields: patch, lead: saved[0] ? toLead(saved[0]) : null };
}
