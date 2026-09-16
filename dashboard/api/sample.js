// Sample data: a small, obviously-made-up book of leads so a brand-new copy
// shows every page filled in on day one, and one button takes it all away.
//
//   GET  /api/sample            -> { ok, counts: { leads, coaches, activity, deals, tasks, referrals } }
//   POST /api/sample {op:"load"} -> writes the sample rows (refuses if any are already there)
//   POST /api/sample {op:"clear"} -> deletes every row that carries sample = true
//
// Every sample row is flagged in its own column, so clearing never touches a
// real lead. Addresses use the reserved example.com domain and the phone
// numbers are the UK's fiction range, so nothing can reach a real person if
// sending or dialling is switched on while the sample data is still in.
export const config = { runtime: "edge" };

import { isAuthed } from "./_auth.js";
import { isDemo } from "./_demo.js";
import { demoPath } from "./_rows.js";
import { store, rest, LEADS_TABLE } from "./_leads.js";
import { loadProfile } from "./_profile.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const TABLES = () => ({
  leads: LEADS_TABLE(), coaches: demoPath("coach_leads"), activity: demoPath("activities"),
  deals: demoPath("deals"), tasks: demoPath("tasks"), referrals: demoPath("referrals"),
});

const day = (n, h = 10) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); d.setUTCHours(h, 0, 0, 0); return d; };
const iso = (n, h) => day(n, h).toISOString();
const ymd = (n) => iso(n).slice(0, 10);
const hm = (n, h = 10) => ymd(n) + " " + String(h).padStart(2, "0") + ":00";

/* Thirty local businesses across the funnel. Fictional names, reserved
   addresses and numbers. contacted is days ago; null means untouched. */
const LOCAL = [
  ["Brightspark Electrical", "Electrician", "Leeds", "OUTDATED", "Interested", 2],
  ["Oakridge Roofing", "Roofing contractor", "Sheffield", "NONE", "Replied", 1],
  ["Hollins & Sons Plumbing", "Plumber", "Nottingham", "OUTDATED", "Proposal sent", 3],
  ["Ashfield Dental Care", "Dentist", "Derby", "modern", "Contacted", 4],
  ["Riverside Vets", "Veterinarian", "York", "OUTDATED", "Won", 6],
  ["Hartley Kitchens", "Kitchen remodeler", "Leicester", "NONE", "Won", 9],
  ["Pennine Landscapes", "Landscaper", "Huddersfield", "BROKEN", "Follow-up 1", 3],
  ["Castle Motors MOT", "Car inspection station", "Lincoln", "unknown", "Contacted", 5],
  ["Sunrise Cleaning Co", "Cleaning service", "Wakefield", "NONE", "Replied", 2],
  ["Fairview Physio", "Physiotherapist", "Doncaster", "modern", "Not a fit", 7],
  ["Kestrel Locksmiths", "Locksmith", "Hull", "OUTDATED", "Interested", 1],
  ["Beacon Hill Builders", "Builder", "Bradford", "NONE", "Contacted", 6],
  ["Tideway Windows", "Window installer", "Grimsby", "OUTDATED", "Follow-up 1", 4],
  ["Elm Street Barbers", "Barber shop", "Chesterfield", "SOCIAL", "Contacted", 8],
  ["Northgate Accountants", "Accountant", "Harrogate", "modern", "Lost", 10],
  ["Redbrick Removals", "Moving company", "Rotherham", "NONE", "New", null],
  ["Willow Tree Florist", "Florist", "Scarborough", "SOCIAL", "New", null],
  ["Ridge Scaffolding", "Scaffolding service", "Barnsley", "NONE", "New", null],
  ["Greenway Garage", "Auto repair shop", "Mansfield", "OUTDATED", "New", null],
  ["Harbour Fish Bar", "Fish and chips", "Whitby", "NONE", "New", null],
  ["Peak Pest Control", "Pest control service", "Buxton", "unknown", "New", null],
  ["Lakeside Driving School", "Driving school", "Kendal", "SOCIAL", "New", null],
  ["Amber Valley Tiling", "Tile contractor", "Ripley", "NONE", "New", null],
  ["Copperfield Joinery", "Carpenter", "Skipton", "OUTDATED", "New", null],
  ["Ivy House Care", "Home care service", "Halifax", "modern", "New", null],
  ["Stonebridge Fencing", "Fence contractor", "Selby", "NONE", "New", null],
  ["Meadow Lane Nursery", "Day nursery", "Beverley", "unknown", "New", null],
  ["Crown Street Bakery", "Bakery", "Pontefract", "SOCIAL", "New", null],
  ["Fenland Drains", "Drainage service", "Boston", "NONE", "New", null],
  ["Silverdale Tree Care", "Tree service", "Otley", "BROKEN", "New", null],
];
const WHY = { NONE: "No website. A clean first-site pitch.", OUTDATED: "Dated site: copyright still says 2017. Strong redesign angle, you can show them what is wrong.",
  BROKEN: "Broken site: pages do not load on a phone. Easy win to show them.", SOCIAL: "Only a Facebook page, no site of their own. First-site pitch.",
  modern: "Site is fine. Lead with getting more calls, not a redesign.", unknown: "Has a site we could not fully check. Worth a look before you call." };
const HEAT = { Interested: "HOT", Replied: "HOT", "Proposal sent": "HOT", Won: "HOT", "Follow-up 1": "WARM", Contacted: "WARM", "Not a fit": "COOL", Lost: "COOL", New: "WARM" };

/* Twenty coaches across the nine stages. Handles end in .sample so they never
   collide with a real account. */
const COACH = [
  ["jess.morgan.fit.sample", "Jess Morgan", "Online fitness coach", 18400, "Interested", 1],
  ["thecalmmethod.sample", "Priya Anand", "Mindset coach", 42100, "Call booked", 2],
  ["coachdanieltyler.sample", "Daniel Tyler", "Business coach", 9800, "Closed", 8],
  ["runwithmaya.sample", "Maya Osei", "Running coach", 27300, "Answered", 1],
  ["leanwithluke.sample", "Luke Barrett", "Nutrition coach", 15600, "Loom/VSL sent", 3],
  ["sara.speaks.sample", "Sara Marin", "Public speaking coach", 6200, "Left on read", 5],
  ["ironhabits.sample", "Tom Whitfield", "Strength coach", 33900, "DM'd", 2],
  ["hannah.hormones.sample", "Hannah Reid", "Women's health coach", 21700, "Not interested", 6],
  ["adhdwithamir.sample", "Amir Khan", "ADHD coach", 12400, "DM'd", 1],
  ["thequietclose.sample", "Ella Fontaine", "Sales coach", 8900, "Answered", 2],
  ["yogawithnadia.sample", "Nadia Kaur", "Yoga teacher", 54200, "Left on read", 4],
  ["fatherhoodfirst.sample", "Chris Dunne", "Parenting coach", 7100, "DM'd", 3],
  ["studysmart.ella.sample", "Ella Brooks", "Study coach", 16800, "Not DM'd", null],
  ["coachmarcusj.sample", "Marcus James", "Boxing coach", 29500, "Not DM'd", null],
  ["mindfulmoney.sample", "Grace Liu", "Money coach", 11300, "Not DM'd", null],
  ["the.golf.fix.sample", "Ryan Cole", "Golf coach", 23800, "Not DM'd", null],
  ["postnatalpower.sample", "Amelia Hart", "Postnatal fitness coach", 19200, "Not DM'd", null],
  ["climbwithzoe.sample", "Zoe Lindqvist", "Climbing coach", 8700, "Not DM'd", null],
  ["careerclarity.sample", "Ben Okafor", "Career coach", 14100, "Not DM'd", null],
  ["breathe.with.sam.sample", "Sam Rivera", "Breathwork coach", 5400, "Not DM'd", null],
];

async function counts(db, T) {
  const out = {};
  for (const [k, table] of Object.entries(T)) {
    const r = await rest(db, `${table}?sample=is.true&select=id`, { headers: { Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" } });
    const total = parseInt(String(r.headers.get("content-range") || "").split("/")[1], 10);
    out[k] = r.ok ? (Number.isFinite(total) ? total : 0) : 0;
  }
  return out;
}

/* PostgREST writes a batch only when every object carries the same keys, so
   each row is padded to the union of them (missing values become null). */
function pad(rows) {
  const keys = new Set(); rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return rows.map((r) => { const o = {}; for (const k of keys) o[k] = r[k] === undefined ? null : r[k]; return o; });
}

async function insert(db, table, rows) {
  if (!rows.length) return [];
  const r = await rest(db, table, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(pad(rows)), ms: 20000 });
  if (!r.ok) throw new Error("Could not write " + table.replace(/_demo$/, "") + " (" + r.status + " " + (await r.text()).slice(0, 160) + ")");
  return r.json();
}

async function load(db, T, cur) {
  const emailOf = (n) => "hello@" + n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".example.com";
  const leads = LOCAL.map(([business, category, city, site, status, ago], i) => ({
    track: "local", source: "sample", sample: true, business, category, city, region: "England", country: "United Kingdom",
    owner_name: "", phone: "01632 960" + String(100 + i).padStart(3, "0"), email: emailOf(business),
    website: site === "NONE" || site === "SOCIAL" ? "" : "https://" + emailOf(business).split("@")[1],
    facebook: site === "SOCIAL" ? "https://facebook.com/" + emailOf(business).split("@")[1].replace(".example.com", "") + ".sample" : "",
    heat: HEAT[status] || "WARM", website_status: site, why: WHY[site], status,
    contacted_on: ago == null ? "" : hm(ago), rating: String(4 + ((i * 7) % 10) / 10), reviews: String(12 + (i * 13) % 90),
    notes: "Sample lead. Remove all sample data from Settings, Data.",
  }));
  const savedLeads = await insert(db, T.leads, leads);
  const byName = new Map(savedLeads.map((r) => [r.business, r]));
  const L = (name) => byName.get(name) || {};
  const act = (name, channel, kind, ago, extra) => ({ track: "local", sample: true, provider: "sample", channel, kind, occurred_at: iso(ago, 10 + (name.length % 6)),
    lead_row: L(name).id, lead_email: L(name).email || "", business: name, ...extra });

  const activity = [];
  for (const [business, , , , status, ago] of LOCAL) {
    if (ago == null) continue;
    const l = L(business);
    activity.push(act(business, "email", "sent", ago + 2, { step: 1, subject: "Quick question about " + business, preview: "First email of the sequence" }));
    if (["Replied", "Interested", "Proposal sent", "Won"].includes(status)) {
      activity.push(act(business, "email", "replied", ago, { subject: "Re: Quick question about " + business,
        preview: "Yes, send me some more details and a price.", data: { text: "Hi,\n\nYes, send me some more details and a price. What would it involve on our side?\n\nThanks" } }));
    }
    if (["Contacted", "Follow-up 1"].includes(status)) activity.push(act(business, "call", l.phone ? "voicemail" : "no_answer", ago, { preview: "Left a voicemail, try again Thursday" }));
    if (status === "Proposal sent") activity.push(act(business, "call", "sales_booked", -1, { subject: "Sales call", preview: "Walk through the proposal", data: { scheduled_at: iso(-1, 14), duration_min: 30 } }));
    if (status === "Won") {
      activity.push(act(business, "call", "sales_won", business === "Riverside Vets" ? 0 : ago - 1, { subject: "Sales call", preview: "Agreed on the spot, wants it live this month", data: { duration_min: 35 } }));
    }
    if (status === "Not a fit") activity.push(act(business, "call", "not_fit", ago, { preview: "Happy with their current agency" }));
  }
  activity.push(act("Sunrise Cleaning Co", "note", "note", 1, { preview: "Owner is Karen, best reached before 9am" }));
  for (const name of ["Ashfield Dental Care", "Castle Motors MOT", "Beacon Hill Builders"]) activity.push(act(name, "email", "sent", 0, { step: 2, subject: "Following up, " + name, preview: "Second email of the sequence" }));
  activity.push(act("Elm Street Barbers", "call", "voicemail", 0, { preview: "Left a voicemail" }));
  activity.push(act("Tideway Windows", "call", "interested", 0, { preview: "Spoke to the owner, wants the video" }));
  await insert(db, T.activity, activity);

  const deals = [
    { track: "local", sample: true, business: "Riverside Vets", email: L("Riverside Vets").email, lead_row: L("Riverside Vets").id, amount: 2500, mrr: 0, currency: cur, source: "call", closed_on: ymd(0), notes: "Five-page site" },
    { track: "local", sample: true, business: "Hartley Kitchens", email: L("Hartley Kitchens").email, lead_row: L("Hartley Kitchens").id, amount: 1800, mrr: 150, currency: cur, source: "email", closed_on: ymd(8), notes: "Site plus monthly care" },
  ];
  const tasks = [
    { track: "local", sample: true, business: "Oakridge Roofing", lead_row: L("Oakridge Roofing").id, title: "Answer their reply", kind: "follow_up", due_on: ymd(0) },
    { track: "local", sample: true, business: "Brightspark Electrical", lead_row: L("Brightspark Electrical").id, title: "Send the proposal they asked for", kind: "email", due_on: ymd(0) },
    { track: "local", sample: true, business: "Pennine Landscapes", lead_row: L("Pennine Landscapes").id, title: "Ring back, they asked for Thursday", kind: "call", due_on: ymd(-2) },
    { track: "local", sample: true, business: "Castle Motors MOT", lead_row: L("Castle Motors MOT").id, title: "Second email", kind: "email", due_on: ymd(1) },
    { track: "local", sample: true, business: "Riverside Vets", lead_row: L("Riverside Vets").id, title: "Onboarding call, walk through the new site", kind: "call", due_on: ymd(-3) },
  ];
  const referrals = [{ track: "local", sample: true, date: ymd(2), customer: "Hartley Kitchens", customer_email: L("Hartley Kitchens").email, job: "Website", referrer: "Riverside Vets", referrer_email: L("Riverside Vets").email, reward: 150, reward_type: "cash", status: "Pending" }];

  /* the coach book */
  const coaches = COACH.map(([handle, name, niche, followers, status, ago]) => ({
    sample: true, handle, platform: "instagram", profile_url: "https://instagram.com/" + handle, name, business: name, niche, followers,
    heat: ["Interested", "Call booked", "Closed", "Answered", "Loom/VSL sent"].includes(status) ? "HOT" : status === "Not interested" ? "COOL" : "WARM",
    status, notes: "Sample coach. Remove all sample data from Settings, Data.",
  }));
  const savedCoaches = await insert(db, T.coaches, coaches);
  const C = new Map(savedCoaches.map((r) => [r.handle, r]));
  const cact = (handle, kind, ago, extra) => { const c = C.get(handle) || {}; return { track: "coach", sample: true, provider: "sample", channel: "dm", kind, occurred_at: iso(ago, 11),
    lead_row: c.id, lead_email: "", business: c.business || c.name, source: "dm", ...extra }; };
  const cactivity = [];
  for (const [handle, name, , , status, ago] of COACH) {
    if (ago == null) continue;
    cactivity.push(cact(handle, "sent", ["ironhabits.sample", "adhdwithamir.sample"].includes(handle) ? 0 : ago + 1, { preview: "Hey " + name.split(" ")[0] + ", loved the post on consistency. Quick question about how you take clients on?" }));
    if (["Answered", "Interested", "Call booked", "Closed", "Loom/VSL sent"].includes(status)) cactivity.push(cact(handle, "replied", ago, { preview: "Hey! Thanks, go on then, what's the question?" }));
    if (["Left on read"].includes(status)) cactivity.push(cact(handle, "sent", ago - 1, { preview: "No worries if not, just wanted to send this over." }));
    if (status === "Call booked") cactivity.push({ ...cact(handle, "sales_booked", -2, { subject: "Sales call", preview: "Zoom, 20 minutes", data: { scheduled_at: iso(-2, 15), duration_min: 20 } }), channel: "call" });
    if (status === "Closed") cactivity.push({ ...cact(handle, "sales_won", ago - 2, { subject: "Sales call", preview: "Signed for the three-month build", data: { duration_min: 40 } }), channel: "call" });
  }
  await insert(db, T.activity, cactivity);
  deals.push({ track: "coach", sample: true, business: "Daniel Tyler", email: "", lead_row: (C.get("coachdanieltyler.sample") || {}).id, amount: 3000, mrr: 0, currency: cur, source: "dm", closed_on: ymd(6), notes: "Three-month build" });
  tasks.push({ track: "coach", sample: true, business: "Luke Barrett", lead_row: (C.get("leanwithluke.sample") || {}).id, title: "Follow up on the Loom", kind: "follow_up", due_on: ymd(0) });
  tasks.push({ track: "coach", sample: true, business: "Priya Anand", lead_row: (C.get("thecalmmethod.sample") || {}).id, title: "Prep for the call", kind: "call", due_on: ymd(-2) });
  await insert(db, T.deals, deals);
  await insert(db, T.tasks, tasks);
  await insert(db, T.referrals, referrals);
}

async function clear(db, T) {
  for (const table of Object.values(T)) {
    const r = await rest(db, `${table}?sample=is.true`, { method: "DELETE", ms: 20000 });
    if (!r.ok) throw new Error("Could not clear " + table.replace(/_demo$/, "") + " (" + r.status + ")");
  }
}

export default async function handler(req) {
  if (!(await isAuthed(req))) return json({ ok: false, login: true }, 401);
  const db = store();
  if (!db) return json({ ok: false, error: "No database connected yet." }, 503);
  const T = TABLES();
  if (req.method === "GET") {
    try { return json({ ok: true, counts: await counts(db, T) }); }
    catch (err) { return json({ ok: false, error: err.message }, 502); }
  }
  if (req.method !== "POST") return json({ ok: false, error: "GET or POST" }, 405);
  let body; try { body = await req.json(); } catch { body = {}; }
  try {
    const have = await counts(db, T);
    const any = Object.values(have).some((n) => n > 0);
    if (body.op === "load") {
      if (any) return json({ ok: false, error: "The sample data is already in. Remove it first if you want a fresh set." }, 409);
      const prof = await loadProfile();
      await load(db, T, (prof && prof.currency) || "GBP");
      return json({ ok: true, counts: await counts(db, T), demo: isDemo() });
    }
    if (body.op === "clear") {
      await clear(db, T);
      return json({ ok: true, counts: await counts(db, T) });
    }
    return json({ ok: false, error: "Unknown op." }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message || "Could not do that." }, 502);
  }
}
