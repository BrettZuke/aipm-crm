// Which book of business a request belongs to.
//
// The CRM holds two: local businesses (leads scraped from Google Maps into the
// Google Sheet) and online coaches (added one at a time by pasting a profile
// URL). The requirement is that they are completely separate: neither may
// ever show the other's leads, money or activity.
//
// The separation is one column, `track`, on every shared table, and one filter
// applied here. The track is read from the request rather than held in a
// module variable on purpose: a serverless instance is reused across requests,
// and a stale global would leak one book into the other, which is the single
// failure this whole design exists to prevent.
//
// Anything NOT in TRACKED is deliberately shared or inherently local:
//   profile, outreach_settings  one person, one identity, one set of mailboxes
//   lead_edits, sheet_cache     overlays on Google Sheet rows, local by nature
//   found_leads                 the local instant-builder's own store
import { demoPath } from "./_rows.js";

export const TRACKS = ["local", "coach"];

const TRACKED = [
  "deals", "activities", "tasks", "sequences", "sequence_runs", "referrals",
  "emails", "email_events", "scripts", "saved_views", "templates", "sites",
];

/* Read the track off a request. Anything unrecognised is local, so a missing
   or malformed parameter can only ever under-share, never over-share. */
export function trackOf(req) {
  let raw = "";
  try {
    raw = new URL(req.url, "http://localhost").searchParams.get("track") || "";
  } catch {
    raw = "";
  }
  const t = raw.trim().toLowerCase();
  return t === "coach" ? "coach" : "local";
}

export function isCoach(req) {
  return trackOf(req) === "coach";
}

function tableOf(path) {
  const m = /^([a-z_]+)(?=[?/]|$)/.exec(path);
  return m ? m[1].replace(/_demo$/, "") : "";
}

/* A PostgREST path, pointed at the demo's copy where relevant and narrowed to
   one track. Every read of a shared table goes through this. */
export function rowPath(path, track) {
  const mapped = demoPath(path);
  if (!TRACKED.includes(tableOf(mapped))) return mapped;
  const t = track === "coach" ? "coach" : "local";
  return mapped + (mapped.includes("?") ? "&" : "?") + "track=eq." + t;
}

/* Stamp a row (or rows) with the track before writing. Shared tables must
   never be written without one, or the row becomes invisible to both books. */
export function stampTrack(body, track) {
  const t = track === "coach" ? "coach" : "local";
  if (Array.isArray(body)) return body.map((r) => ({ ...r, track: t }));
  return { ...body, track: t };
}

/* The coach book keeps its leads in Supabase, not the Google Sheet, because a
   pasted Instagram handle has none of the shape a scraped Maps lead has. */
export function coachTable() {
  return demoPath("coach_leads");
}
