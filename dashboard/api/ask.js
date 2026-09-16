// The assistant: a question about the CRM, answered from the CRM's own data
// by the owner's free AI key (Google Gemini or Groq, kept in Settings,
// Assistant). The model never sees the whole database: the request carries a
// compact brief (this week's figures, the leads that matter or that the
// question names, open tasks, recent deals and activity) and is told to
// answer from that alone. Nothing here writes anything.
//   POST { question, history: [{ role: "you"|"bot", text }], track }
export const config = { runtime: "edge" };

import { isAuthed } from "./_auth.js";
import { isDemo } from "./_demo.js";
import { loadProfile } from "./_profile.js";
import { leadsInPostgres, readLeads, store } from "./_leads.js";
import { readCoachLeads, db as coachDb } from "./_coach.js";
import { fetchRows } from "./_rows.js";
import { gather } from "./digest.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const day = (v) => String(v || "").slice(0, 10);
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
const HOT = /^(answered|replied|interested|proposal sent|loom\/vsl sent|got on call|call booked|callback)$/i;
const QUIET = /^(new|not dm'd|)$/i;
const money = (cur, n) => ({ GBP: "£", USD: "$", EUR: "€", CAD: "$", AUD: "$" }[cur] || "") + Math.round(n).toLocaleString("en-GB");

/* The words in the question worth matching a lead by: names, not "the". */
function terms(q) {
  return String(q || "").toLowerCase().replace(/[^a-z0-9@'\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !/^(what|when|which|where|about|have|been|this|that|with|from|their|there|they|them|week|month|today|leads?|coach(es)?|business(es)?|replied|reply|interested|customers?|money|collected|follow|followed|since|over|more|than|last|many|much|does|did|who|whose|are|the|and|for|not|yet|any|all|our|your|mine|show|list|give|tell)$/.test(w));
}

function leadLine(l, track) {
  const bits = [
    (track === "coach" ? "coach" : "local") + "#" + l.row,
    clip(l.business || l.name, 60),
    l.owner_name ? "owner " + clip(l.owner_name, 40) : "",
    l.handle ? "@" + l.handle : "",
    l.category ? clip(l.category, 30) : "",
    l.city ? clip(l.city, 30) : "",
    "status " + (l.status || "New"),
    l.assigned_to ? "assigned " + clip(l.assigned_to, 40) : "",
    l.contacted_on ? "last touch " + day(l.contacted_on) : "",
    l.email ? clip(l.email, 50) : "",
    l.phone ? clip(l.phone, 24) : "",
    l.followers ? l.followers + " followers" : "",
    l.notes ? "notes: " + clip(l.notes, 90) : "",
  ].filter(Boolean);
  return bits.join(" | ");
}

async function brief(prof, question, track) {
  const db = store();
  const words = terms(question);
  const hits = (l) => words.some((w) => (String(l.business || "") + " " + String(l.owner_name || "") + " " + String(l.handle || "") + " " + String(l.email || "") + " " + String(l.city || "") + " " + String(l.notes || "")).toLowerCase().includes(w));
  let local = [], coach = [];
  if (await leadsInPostgres()) { try { local = await readLeads(); } catch { local = []; } }
  const cdb = coachDb();
  if (cdb) { try { coach = await readCoachLeads(cdb); } catch { coach = []; } }
  const pick = (leads, t) => {
    const named = leads.filter(hits);
    const hot = leads.filter((l) => !hits(l) && HOT.test(l.status || ""));
    const worked = leads.filter((l) => !hits(l) && !HOT.test(l.status || "") && !QUIET.test(l.status || ""));
    const order = named.slice(0, 120).concat(hot.slice(0, 200), worked.slice(0, 200));
    return { lines: order.map((l) => leadLine(l, t)), total: leads.length, named: named.length, hot: hot.length, worked: worked.length,
             quiet: leads.filter((l) => QUIET.test(l.status || "")).length };
  };
  const L = pick(local, "local"), C = pick(coach, "coach");
  let tasks = [], acts = [], deals = [];
  if (db) {
    const q = async (path, max) => { try { return (await fetchRows(db, path, { max, timeout: 9000 })).rows; } catch { return []; } };
    const since = new Date(Date.now() - 21 * 86400000).toISOString();
    [tasks, acts, deals] = await Promise.all([
      q("tasks?done=is.false&select=business,title,kind,due_on,track&order=due_on.asc", 60),
      q(`activities?occurred_at=gte.${encodeURIComponent(since)}&select=occurred_at,business,channel,kind,preview,track&order=occurred_at.desc`, 140),
      q("deals?select=business,amount,mrr,currency,closed_on,source,track&order=closed_on.desc", 80),
    ]);
  }
  const week = await gather(prof, prof.timezone || "Europe/London");
  const cur = prof.currency || "GBP";
  const w = (b) => `${b.track === "coach" ? "Coaches" : "Local"}: sent ${b.now.sent} (emails ${b.now.emails}, DMs ${b.now.dms}, calls ${b.now.calls}) vs ${b.prev.sent} last week to this point; responses ${b.now.replies} vs ${b.prev.replies}; sales calls held ${b.now.held} vs ${b.prev.held}; customers ${b.now.customers} vs ${b.prev.customers}; money ${money(cur, b.now.cash)} vs ${money(cur, b.prev.cash)}`;
  const text = [
    `OWNER: ${prof.name || "the owner"}${prof.business ? " (" + prof.business + ")" : ""}. Currency ${cur}. Today ${week.today}. Week runs Monday ${week.B.from} to today; "last week to this point" is ${week.B.prevFrom} to ${week.B.prevTo}.`,
    `THIS WEEK: ` + (week.books.length ? week.books.map(w).join(" || ") : "nothing recorded yet"),
    `LOCAL BUSINESSES: ${L.total} on the list (${L.quiet} untouched, ${L.hot} waiting on the owner: replied/interested/proposal/call booked, ${L.worked} in progress). Lines: id | name | details | status | assigned | last touch | contact | notes`,
    L.lines.length ? L.lines.join("\n") : "(none listed)",
    `ONLINE COACHES: ${C.total} on the list (${C.quiet} not DM'd yet, ${C.hot} waiting on the owner, ${C.worked} in progress).`,
    C.lines.length ? C.lines.join("\n") : "(none listed)",
    `OPEN TASKS (${tasks.length}): ` + (tasks.length ? tasks.map((t) => `${day(t.due_on)} ${clip(t.title, 60)}${t.business ? " for " + clip(t.business, 40) : ""} [${t.track || "local"}]`).join("; ") : "none"),
    `DEALS, newest first (${deals.length}): ` + (deals.length ? deals.map((d) => `${day(d.closed_on)} ${clip(d.business, 40)} ${money(d.currency || cur, Number(d.amount) || 0)}${Number(d.mrr) ? " +" + money(d.currency || cur, Number(d.mrr)) + "/mo" : ""} via ${d.source || "?"} [${d.track || "local"}]`).join("; ") : "none"),
    `RECENT ACTIVITY, last 21 days, newest first (${acts.length}): ` + (acts.length ? acts.map((a) => `${String(a.occurred_at || "").slice(0, 10)} ${clip(a.business, 36)}: ${a.channel} ${a.kind}${a.preview ? " \"" + clip(a.preview, 70) + "\"" : ""} [${a.track || "local"}]`).join("; ") : "none"),
  ].join("\n\n");
  return { text, counts: { local: L.total, coach: C.total, tasks: tasks.length, deals: deals.length, activity: acts.length, named: L.named + C.named } };
}

const SYSTEM = (name) => `You are the assistant inside ${name}'s Lead CRM, a tool for cold outreach to local businesses and online coaches. Answer the owner's question using ONLY the CRM data provided. Be brief and concrete: name the people and the numbers. Prefer short lists over prose when several leads are involved. When a figure or a lead is not in the data, say so plainly and say where in the CRM they could look; never invent names, numbers or dates. You cannot send messages or change records; if asked to, say what to click instead. Keep answers under 180 words unless a list needs more. Plain text: no markdown headings, no bold, no emoji; dashes only for list items. The id codes in the data (like local#12 or coach#40) are for your matching only: never print them, use the name.`;

async function askGemini(key, system, history, question) {
  const contents = history.map((h) => ({ role: h.role === "bot" ? "model" : "user", parts: [{ text: h.text }] }));
  contents.push({ role: "user", parts: [{ text: question }] });
  const body = JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.2, maxOutputTokens: 800 } });
  let last = "";
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(40000) });
    const out = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = (((out.candidates || [])[0] || {}).content || {}).parts;
      return (text || []).map((p) => p.text || "").join("").trim() || "I could not put an answer together from that.";
    }
    last = (out.error && out.error.message) || ("HTTP " + r.status);
    if (r.status !== 404) break;
  }
  throw new Error("Gemini said: " + last);
}

async function askGroq(key, system, history, question) {
  const messages = [{ role: "system", content: system }].concat(history.map((h) => ({ role: h.role === "bot" ? "assistant" : "user", content: h.text })), [{ role: "user", content: question }]);
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0.2, max_tokens: 800 }), signal: AbortSignal.timeout(40000) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Groq said: " + ((out.error && out.error.message) || ("HTTP " + r.status)));
  return ((((out.choices || [])[0] || {}).message || {}).content || "").trim() || "I could not put an answer together from that.";
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!(await isAuthed(req))) return json({ ok: false, login: true }, 401);
  const body = await req.json().catch(() => null);
  const question = clip(body && body.question, 600);
  if (!question) return json({ ok: false, error: "Ask something first." }, 400);
  const history = (Array.isArray(body && body.history) ? body.history : []).slice(-8)
    .map((h) => ({ role: h && h.role === "bot" ? "bot" : "you", text: clip(h && h.text, 1500) })).filter((h) => h.text);
  const prof = await loadProfile();
  const ai = prof.ai || {};
  const provider = ai.provider || (process.env.AI_PROVIDER || "gemini").trim();
  const key = ai.key || (process.env.AI_API_KEY || "").trim();
  if (!key) return json({ ok: false, needs_key: true, error: "Add a free Gemini or Groq key in Settings, Assistant, and I can answer from your CRM." }, 503);

  const b = await brief(prof, question, String((body && body.track) || "local"));
  const system = SYSTEM(prof.name || "the owner") + "\n\nCRM DATA:\n" + b.text;
  try {
    const answer = provider === "groq" ? await askGroq(key, system, history, question) : await askGemini(key, system, history, question);
    return json({ ok: true, answer, used: b.counts, provider, demo: isDemo() });
  } catch (err) {
    return json({ ok: false, error: (err && err.message) || "The AI did not answer." }, 502);
  }
}
