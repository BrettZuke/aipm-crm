// GET /go/<code>  (rewritten from /api/go?c=<code>)
//
// The link in every outreach email, DM or text. It sends the business on to the
// video page, personalised for them, and writes "Opened the video link" on that
// lead's timeline on the way past. A code nobody recognises still lands on the
// video: a prospect must never meet a dead page because of our bookkeeping.
//
// Mail scanners open links before people do. Anything that looks like one, or
// any request that is not a plain GET from a browser, is redirected without
// being logged, so a timeline shows the business opening the link and not
// their spam filter.

import { isDemo } from "./_demo.js";
import { loadProfile } from "./_profile.js";
import { personalizeVideo } from "./_outreach.js";
import { goCode } from "./_go.js";

export const config = { runtime: "edge" };

const CODE = /^[a-z0-9]{4,12}$/;
const SCANNER = /bot|crawl|spider|preview|scan|fetch|curl|wget|python|java|okhttp|monitor|facebookexternalhit|slack|whatsapp|telegram|proofpoint|mimecast|barracuda|safelinks|urldefense|google-safety|headless/i;

function store() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

// The leads as the CRM last saw them: the same saved copy the page paints from.
async function savedLeads(db) {
  const key = isDemo() ? "crm-leads-demo" : "crm-leads";
  const r = await fetch(`${db.url}/rest/v1/sheet_cache?key=eq.${key}&select=payload&limit=1`, {
    headers: db.headers,
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return [];
  const rows = await r.json();
  return (rows[0] && rows[0].payload && rows[0].payload.leads) || [];
}

// One row per lead per minute: a double click or a reload is not two opens.
async function logOpen(db, lead, code) {
  const table = isDemo() ? "activities_demo" : "activities";
  const now = new Date();
  const row = {
    occurred_at: now.toISOString(),
    lead_row: Number.isFinite(+lead.row) && +lead.row > 0 ? +lead.row : null,
    lead_email: String(lead.email || "").trim().toLowerCase() || null,
    business: String(lead.business || "").trim().slice(0, 160) || null,
    channel: "click",
    kind: "opened",
    subject: "Opened the video link",
    provider: "go",
    external_id: code + ":" + now.toISOString().slice(0, 16),
    /* Tracked links belong to the sheet, which is the local book. Named here
       rather than left to the column default because it is half of the unique
       index this insert has to match. */
    track: "local",
  };
  /* Same three columns as the index: (provider, external_id, track). While
     this named only two, every open was rejected and, because nothing read
     the answer, silently: the redirect still worked, so nobody could tell
     that link tracking had stopped recording. */
  const r = await fetch(`${db.url}/rest/v1/${table}?on_conflict=provider,external_id,track`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "return=minimal,resolution=ignore-duplicates" },
    body: JSON.stringify([row]),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) console.error("go: could not log the open (" + r.status + ")");
}

export default async function handler(req) {
  const url = new URL(req.url);
  const code = String(url.searchParams.get("c") || "").trim().toLowerCase();
  const prof = await loadProfile();
  const fallback = prof.video || prof.website || "/";
  const go = (to) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

  if (!CODE.test(code)) return go(fallback);
  const db = store();
  if (!db) return go(fallback);

  let lead = null;
  try {
    lead = (await savedLeads(db)).find((l) => goCode(l) === code) || null;
  } catch {
    lead = null; // the store is down: still send them to the video
  }
  if (!lead) return go(fallback);

  const to = prof.video ? personalizeVideo(prof.video, lead) : fallback;
  const ua = req.headers.get("user-agent") || "";
  if (req.method === "GET" && ua && !SCANNER.test(ua)) {
    try {
      await logOpen(db, lead, code);
    } catch {
      // Logging failed; the prospect still has to land on the video.
    }
  }
  return go(to);
}
