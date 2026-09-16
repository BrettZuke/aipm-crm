// Shared outreach brain for the dashboard app: which email goes to whom and
// when, the warm-up formula, and the rendering. The words themselves live in
// _emails.js (one source for the sender, the Email report and the Scripts tab),
// and a student's edited copy of any of them, saved from Scripts, wins over the
// built-in wording when the sender runs. Used by send.js (the autopilot) and
// stats.js (the dashboard).
import { EMAILS, EMAIL_SIGN, emailsOf } from "./_emails.js";
import { demoPath } from "./_rows.js";

const withSign = (e) => ({ ...e, body: e.body + EMAIL_SIGN });
export const TEMPLATES = emailsOf("any").map(withSign);       // rotated first emails
export const NOSITE = emailsOf("nosite").map(withSign);       // first emails only for a business with no website
export const HASSITE = emailsOf("hassite").map(withSign);     // only for a business that has a website
export const FACEBOOK = emailsOf("facebook").map(withSign);   // only for a Facebook page with no website
export const DATED = emailsOf("dated").map(withSign);         // only for an old or broken website
export const FOLLOWUPS = emailsOf("follow").map(withSign);    // days 3, 7, 12, 18, 25
export const NURTURES = emailsOf("nurture").map(withSign);    // every 30 days after

/* The set the sender uses: the built-in wording, with any row the student
   saved from Scripts (channel email, same key, its own words) laid over it. */
export async function loadEmailSet(db, track) {
  const set = { templates: TEMPLATES.slice(), nosite: NOSITE.slice(), hassite: HASSITE.slice(), facebook: FACEBOOK.slice(), dated: DATED.slice(), followups: FOLLOWUPS.slice(), nurtures: NURTURES.slice() };
  if (!db) return set;
  try {
    const r = await fetch(db.url + "/rest/v1/" + demoPath("scripts") + "?channel=eq.email&key=not.is.null&track=eq." + (track === "coach" ? "coach" : "local") + "&select=key,subject,body", {
      headers: db.headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return set;
    const rows = await r.json();
    const over = {};
    for (const row of rows) if (row.key && String(row.body || "").trim()) over[row.key] = row;
    const lay = (list) => list.map((e) => over[e.key] ? { ...e, subject: String(over[e.key].subject || "").trim() || e.subject, body: String(over[e.key].body || "").trim() + EMAIL_SIGN, edited: true } : e);
    for (const k of Object.keys(set)) set[k] = lay(set[k]);
  } catch { /* the built-in wording is the fallback */ }
  return set;
}

/* Which first email a lead gets: its own row decides, so the pick never
   changes under a student between runs, and a business with no website draws
   from the no-website emails as well. */
export const noSite = (lead) => /^(NONE|SOCIAL)$/i.test(String(lead.website_status || "").trim()) && !String(lead.website || "").trim();
const facebookOnly = (lead) => /^SOCIAL$/i.test(String(lead.website_status || "").trim()) && !String(lead.website || "").trim();
const datedSite = (lead) => /^(OUTDATED|BROKEN)$/i.test(String(lead.website_status || "").trim());
const hasSite = (lead) => !!String(lead.website || "").trim() && !/^(NONE|SOCIAL)$/i.test(String(lead.website_status || "").trim());
export function pickInitial(lead, set) {
  let pool = set.templates;
  if (noSite(lead)) pool = pool.concat(set.nosite || []);
  if (facebookOnly(lead)) pool = pool.concat(set.facebook || []);
  if (datedSite(lead)) pool = pool.concat(set.dated || []);
  if (hasSite(lead)) pool = pool.concat(set.hassite || []);
  if (!pool.length) return null;
  const row = parseInt(lead.row, 10);
  return pool[(Number.isFinite(row) ? Math.abs(row) : 0) % pool.length];
}

/* A sent subject back to the name of the email that sent it, for the Email
   report. Subjects carry the business or the town, so match on shape. */
const SUBJECT_PATTERNS = EMAILS.map((e) => ({ title: e.title, literal: e.subject.replace(/\{\{(business|town)\}\}/g, "").length,
    re: new RegExp("^" + e.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\{(business|town)\\\}\\\}/g, ".+?") + "$", "i") }))
  /* The most literal subject wins, so "{{business}}" on its own is the last resort. */
  .sort((a, b) => b.literal - a.literal);
export function subjectName(subject) {
  const s = String(subject || "").trim();
  for (const p of SUBJECT_PATTERNS) if (p.re.test(s)) return p.title;
  return "";
}
export const KNOWN_SUBJECTS = new Proxy({}, { get: (_, k) => subjectName(String(k)) });

export const INITIAL_STATUS = "Contacted";
export const FOLLOWUP_STAGES = [
  ["contacted", 3, "Follow-up 1", 0],
  ["follow-up 1", 7, "Follow-up 2", 1],
  ["follow-up 2", 14, "Follow-up 3", 2],
  ["follow-up 3", 21, "Follow-up 4", 3],
  ["follow-up 4", 30, "Follow-up 5", 4],
];
export const NURTURE_STATUS = "Nurturing";
export const NURTURE_GAP = 30;
// Statuses that end the sequence for good. "Removed" is what the reply watcher
// sets when someone asks to be taken off; nothing ever sends to these again.
export const STOP_STATUSES = new Set([
  "replied", "removed", "unsubscribed", "not interested", "won",
  "interested", "proposal sent", "lost", "not a fit",
]);

function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || "").trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

// What (if anything) a lead is due for today. Returns null, or
// {kind: "initial"|"followup"|"nurture", index, next}.
export function dueAction(lead, todayUtcMs) {
  if (!String(lead.email || "").trim()) return null;
  const status = String(lead.status || "").trim();
  if (!status || status.toLowerCase() === "new") return { kind: "initial", index: -1, next: INITIAL_STATUS };
  const low = status.toLowerCase();
  if (STOP_STATUSES.has(low)) return null;
  const last = parseDay(lead.contacted_on);
  for (const [cur, gap, next, index] of FOLLOWUP_STAGES) {
    if (low === cur) {
      if (Number.isNaN(last)) return null;
      return (todayUtcMs - last) / 86400000 >= gap ? { kind: "followup", index, next } : null;
    }
  }
  if (low === "follow-up 5" || low === NURTURE_STATUS.toLowerCase()) {
    if (Number.isNaN(last)) return null;
    return (todayUtcMs - last) / 86400000 >= NURTURE_GAP ? { kind: "nurture", index: -1, next: NURTURE_STATUS } : null;
  }
  return null; // custom status the student invented: leave it alone
}

// Warm-up: day 1 allows 5 emails, plus 2 more each day, up to the ceiling
// (OUTREACH_DAILY_MAX, default 40, never above Resend's 100/day).
export function warmupCeiling() {
  const raw = parseInt(process.env.OUTREACH_DAILY_MAX || "40", 10);
  const value = Number.isNaN(raw) ? 40 : raw;
  return Math.max(1, Math.min(value, 100));
}
export function capForDay(dayNumber) {
  return Math.min(5 + 2 * (Math.max(1, dayNumber) - 1), warmupCeiling());
}

/* A sentence that needs the lead's number goes when there is no number, so
   "is 01632 still the best number?" never becomes "is  still the best number?". */
function dropSentencesNeeding(text, token) {
  if (!text.includes(token)) return text;
  return text.split("\n").map((line) => line.includes(token)
    ? line.split(/(?<=[.?!])\s+/).filter((sentence) => !sentence.includes(token)).join(" ").trim()
    : line).join("\n");
}
/* "Veterinarian" reads as "veterinarian" mid-sentence, "Bakery" as "bakeries"
   when the script wants the plural; an acronym like MOT keeps its capitals. */
export function tradeWords(category) {
  const raw = String(category || "").trim();
  if (!raw) return { one: "business like yours", many: "businesses like yours" };
  const one = raw.split(/\s+/).map((w) => (/^[A-Z0-9&]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ");
  const many = /s$/i.test(one) ? one : /[^aeiou]y$/i.test(one) ? one.replace(/y$/i, "ies") : /(sh|ch|x)$/i.test(one) ? one + "es" : one + "s";
  return { one, many };
}
function fill(body, cfg) {
  let text = body;
  if (!String(cfg.leadPhone || "").trim()) text = dropSentencesNeeding(text, "{{phone}}");
  const trade = tradeWords(cfg.trade);
  return text
    .replaceAll("{{business}}", cfg.business || "your business")
    .replaceAll("{{town}}", cfg.town || "your area")
    .replaceAll("{{trades}}", trade.many)
    .replaceAll("{{trade}}", trade.one)
    .replaceAll("{{link}}", cfg.video || "")
    .replaceAll("{{phone}}", cfg.leadPhone || "")
    .replaceAll("{{your_name}}", cfg.name || "")
    .replaceAll("{{your_phone}}", cfg.phone || "")
    .replaceAll("[video link]", cfg.video || "")
    .replaceAll("[name]", cfg.name || "")
    .replaceAll("[phone]", cfg.phone || "");
}

// Build a per-lead video link so the demo page greets each business by name.
// The demo page (your video page) reads ?business= &trade= &town= to personalize
// its copy. Fields the lead is missing are simply left off the link.
export function personalizeVideo(base, lead) {
  if (!base || !lead) return base;
  const parts = [];
  if (lead.business) parts.push("business=" + encodeURIComponent(lead.business));
  const trade = lead.category || lead.trade;
  if (trade) parts.push("trade=" + encodeURIComponent(trade));
  const town = lead.city || lead.town;
  if (town) parts.push("town=" + encodeURIComponent(town));
  if (!parts.length) return base;
  return base + (base.includes("?") ? "&" : "?") + parts.join("&");
}

export function renderText(body, cfg) {
  const out = [];
  for (const ln of fill(body, cfg).split("\n")) {
    if (ln.trim() === "" && out.length && out[out.length - 1].trim() === "") continue;
    out.push(ln);
  }
  return out.join("\n").trim();
}

export function renderHtml(body, cfg) {
  const text = renderText(body, cfg);
  const paras = text.split("\n\n").map((b) => b.trim()).filter(Boolean);
  const parts = paras.map((para) => {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = para.split("\n").map((line) =>
      esc(line).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    );
    return "<p>" + lines.join("<br>") + "</p>";
  });
  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,' +
    'sans-serif;font-size:15px;line-height:1.5;color:#222;">' + parts.join("") + "</div>"
  );
}
