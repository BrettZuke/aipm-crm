#!/usr/bin/env node
// One-command setup for the Lead CRM.
//
//   node setup.mjs
//
// Asks three things (a Supabase access token, a Vercel token, a name) and does
// the rest: creates the database project, applies schema.sql, reads the keys,
// creates the Vercel project, sets its environment (including a one-time
// SETUP_CODE that the first visit asks for), deploys, and points Supabase's
// sign-in links back at the deployed address. Everything it needs
// is in Node itself (18 or newer) plus the Vercel CLI, which npx fetches.
//
//   Tokens:  supabase.com/dashboard/account/tokens   (Supabase access token)
//            vercel.com/account/tokens              (Vercel token)
//   Flags:   --yes                take every default, ask nothing
//            --name <name>        project name on both sides (default lead-crm)
//            --region <region>    Supabase region (default us-east-1)
//            --supabase-url <u> --service-key <k>   use a database you already have
//            --skip-schema        do not apply schema.sql (already done by hand)
//            --resend-key <k>     Resend API key, optional
//   Env:     SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN, RESEND_API_KEY are read if set.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, env, exit, platform } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0 (lead-crm-setup) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const SB = "https://api.supabase.com";
const VC = "https://api.vercel.com";

/* ------------------------------------------------------------ small helpers */
const args = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2), next = argv[i + 1];
  if (next && !next.startsWith("--")) { args[k] = next; i++; } else args[k] = true;
}
const YES = !!args.yes;
const say = (s) => stdout.write(s + "\n");
let rl = null;
const prompt = () => (rl = rl || createInterface({ input: stdin, output: stdout }));
const closePrompt = () => { if (rl) rl.close(); rl = null; };
async function ask(q, def) {
  if (YES) return def;
  const a = (await prompt().question(q + (def ? ` [${def}] ` : " "))).trim();
  return a || def || "";
}
async function secret(q, envName) {
  if (env[envName]) return env[envName].trim();
  if (YES) return "";
  return (await prompt().question(q + " ")).trim();
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lead-crm";
const fail = (m) => { say("\n" + m); exit(1); };

async function api(base, token, method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { authorization: "Bearer " + token, "content-type": "application/json", "user-agent": UA },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}
const sb = (t, m, p, b) => api(SB, t, m, p, b);
const vc = (t, m, p, b) => api(VC, t, m, p, b);
const err = (j) => (j && (j.message || (j.error && (j.error.message || j.error)) || j.raw)) || "";

/* ---------------------------------------------------------------- Supabase */
export async function supabaseProject(token, { name, region, orgId, log = say }) {
  const orgs = await sb(token, "GET", "/v1/organizations");
  if (!orgs.ok) throw new Error("Supabase did not accept that token (" + orgs.status + " " + err(orgs.json) + ").");
  if (!Array.isArray(orgs.json) || !orgs.json.length) throw new Error("That Supabase account has no organization yet. Open supabase.com once, then run this again.");
  const org = orgs.json.find((o) => o.id === orgId) || orgs.json[0];
  const dbPass = "Db" + randomBytes(14).toString("base64url") + "1!";
  const made = await sb(token, "POST", "/v1/projects", { name, organization_id: org.id, db_pass: dbPass, region });
  if (!made.ok) throw new Error("Supabase would not create the project: " + err(made.json));
  const ref = made.json.id || made.json.ref;
  log(`  Created ${name} (${ref}) in ${org.name}. Waiting for it to come up, usually two or three minutes.`);
  const started = Date.now();
  let status = made.json.status || "";
  while (status !== "ACTIVE_HEALTHY") {
    if (Date.now() - started > 15 * 60 * 1000) throw new Error("The database is still not ready after 15 minutes (status " + status + "). Check supabase.com and run this again with --supabase-url.");
    await new Promise((r) => setTimeout(r, 10000));
    const p = await sb(token, "GET", "/v1/projects/" + ref);
    status = (p.json && p.json.status) || status;
    stdout.write(".");
  }
  say("");
  return { ref, url: `https://${ref}.supabase.co`, dbPass, org: org.name };
}

export async function applySchema(token, ref, sql, log = say) {
  /* A fresh project can answer 5xx for a moment after it turns healthy. */
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await sb(token, "POST", `/v1/projects/${ref}/database/query`, { query: sql });
    if (r.ok) return true;
    if (r.status < 500 || attempt === 6) throw new Error("schema.sql did not apply: " + err(r.json));
    log("  The database is not answering yet, trying again in 15 seconds.");
    await new Promise((res) => setTimeout(res, 15000));
  }
}

export async function serviceKey(token, ref) {
  const r = await sb(token, "GET", `/v1/projects/${ref}/api-keys?reveal=true`);
  if (!r.ok || !Array.isArray(r.json)) throw new Error("Could not read the project's keys: " + err(r.json));
  const k = r.json.find((x) => x.name === "service_role");
  if (!k || !k.api_key) throw new Error("No service_role key on that project. Copy it from Project Settings, API, and run again with --service-key.");
  return k.api_key;
}

export async function pointAuthAt(token, ref, url) {
  const r = await sb(token, "PATCH", `/v1/projects/${ref}/config/auth`, { site_url: url, uri_allow_list: url + "," + url + "/**" });
  return r.ok;
}

/* ------------------------------------------------------------------ Vercel */
function cliToken() {
  const spots = platform === "win32"
    ? [path.join(env.APPDATA || "", "com.vercel.cli", "auth.json")]
    : [path.join(env.HOME || "", "Library", "Application Support", "com.vercel.cli", "auth.json"),
       path.join(env.XDG_DATA_HOME || path.join(env.HOME || "", ".local", "share"), "com.vercel.cli", "auth.json"),
       path.join(env.HOME || "", ".config", "com.vercel.cli", "auth.json")];
  for (const p of spots) {
    try { const j = JSON.parse(readFileSync(p, "utf8")); if (j && j.token) return j.token; } catch {}
  }
  return "";
}

export async function vercelProject(token, name, envVars, log = say) {
  const me = await vc(token, "GET", "/v2/user");
  if (!me.ok) throw new Error("Vercel did not accept that token (" + me.status + " " + err(me.json) + ").");
  const user = me.json.user || me.json;
  let proj = await vc(token, "POST", "/v10/projects", { name });
  if (!proj.ok) {
    if (proj.status === 409) proj = await vc(token, "GET", "/v9/projects/" + encodeURIComponent(name));
    if (!proj.ok) throw new Error("Vercel would not create the project: " + err(proj.json));
    log(`  Using the existing Vercel project ${name}.`);
  } else log(`  Created the Vercel project ${name}.`);
  const id = proj.json.id;
  const body = Object.entries(envVars).filter(([, v]) => v).map(([key, value]) => ({ key, value, type: "encrypted", target: ["production", "preview", "development"] }));
  const set = await vc(token, "POST", `/v10/projects/${id}/env?upsert=true`, body);
  if (!set.ok) throw new Error("Could not set the environment variables: " + err(set.json));
  mkdirSync(path.join(HERE, ".vercel"), { recursive: true });
  writeFileSync(path.join(HERE, ".vercel", "project.json"), JSON.stringify({ projectId: id, orgId: user.id, projectName: name }));
  return { id, orgId: user.id, username: user.username };
}

export function deploy(token, log = say) {
  log("  Deploying (the Vercel CLI prints its progress below).");
  const r = spawnSync("npx", ["vercel", "deploy", "--prod", "--yes"], { cwd: HERE, encoding: "utf8", shell: true, env: { ...process.env, VERCEL_TOKEN: token }, stdio: ["inherit", "pipe", "pipe"] });
  const out = (r.stdout || "") + (r.stderr || "");
  const urls = out.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) || [];
  if (r.status !== 0 || !urls.length) throw new Error("The deploy did not finish:\n" + out.slice(-1500));
  return urls[urls.length - 1];
}

export async function liveUrl(token, id, fallback) {
  const p = await vc(token, "GET", `/v9/projects/${id}`);
  const aliases = (((p.json || {}).targets || {}).production || {}).alias || [];
  const best = aliases.filter((a) => /\.vercel\.app$/.test(a)).sort((a, b) => a.length - b.length)[0];
  return best ? "https://" + best : fallback;
}

/* -------------------------------------------------------------------- main */
async function main() {
  say("\nLead CRM setup\n");
  say("You need two tokens, both free and one minute each:");
  say("  Supabase: supabase.com/dashboard/account/tokens  (Generate new token)");
  say("  Vercel:   vercel.com/account/tokens              (Create)\n");

  const name = slug(args.name || (await ask("Name for the project (letters, numbers, dashes):", "lead-crm")));
  const region = args.region || (await ask("Supabase region (us-east-1, eu-west-2, ap-southeast-2 ...):", "us-east-1"));
  const sbToken = args["supabase-url"] && args["service-key"] && args["skip-schema"] ? "" : await secret("Supabase access token:", "SUPABASE_ACCESS_TOKEN");
  const vcToken = env.VERCEL_TOKEN || args["vercel-token"] || cliToken() || (await secret("Vercel token:", "VERCEL_TOKEN"));
  if (!vcToken) fail("A Vercel token is needed. Create one at vercel.com/account/tokens and run this again.");
  const resend = args["resend-key"] || env.RESEND_API_KEY || (await ask("Resend API key (Enter to skip, it can be added later):", ""));

  /* 1. the database */
  let supaUrl = args["supabase-url"] || "", key = args["service-key"] || "", ref = "", dbPass = "";
  if (supaUrl) {
    ref = (supaUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || "";
    say(`\n1. Database: using ${supaUrl}`);
    if (!key) { if (!sbToken || !ref) fail("Add --service-key, or give a Supabase access token so it can be read."); key = await serviceKey(sbToken, ref); }
  } else {
    if (!sbToken) fail("A Supabase access token is needed to create the database. Create one at supabase.com/dashboard/account/tokens and run this again, or pass --supabase-url and --service-key for a project you already have.");
    say("\n1. Database");
    const made = await supabaseProject(sbToken, { name, region });
    supaUrl = made.url; ref = made.ref; dbPass = made.dbPass;
    key = await serviceKey(sbToken, ref);
  }
  if (!args["skip-schema"]) {
    if (!sbToken || !ref) say("  Skipping schema.sql (no access token): paste it into the Supabase SQL editor and run it once.");
    else { await applySchema(sbToken, ref, readFileSync(path.join(HERE, "schema.sql"), "utf8")); say("  schema.sql applied."); }
  }

  /* 2. the app */
  say("\n2. App");
  const authSecret = randomBytes(32).toString("hex"), cronSecret = randomBytes(24).toString("hex"), setupCode = randomBytes(6).toString("hex");
  const proj = await vercelProject(vcToken, name, {
    SUPABASE_URL: supaUrl, SUPABASE_SERVICE_ROLE_KEY: key, AUTH_SECRET: authSecret, CRON_SECRET: cronSecret, SETUP_CODE: setupCode, RESEND_API_KEY: resend,
  });
  say("  Vercel account: " + proj.username + ", project " + name + ".");
  const deployed = deploy(vcToken);
  const url = await liveUrl(vcToken, proj.id, deployed);

  /* 3. sign-in links come back to the right place */
  if (sbToken && ref) { const ok = await pointAuthAt(sbToken, ref, url); say(ok ? "  Supabase sign-in links point at " + url : "  Could not set the Supabase site URL; set it under Authentication, URL Configuration."); }

  say("\nDone.\n");
  say("  Your CRM:      " + url + "#setup=" + setupCode);
  say("  Setup code:    " + setupCode + "   (asked for once, on the first visit; the address above carries it)");
  say("  Database:      " + supaUrl + (dbPass ? "\n  DB password:   " + dbPass + "   (only needed for Supabase's own tools; keep it somewhere safe)" : ""));
  say("\nOpen the CRM address. The first visit asks for the setup code, your name, email and a password, and that becomes your login.");
  say("Then Settings, Data: import a CSV, or load the sample data to see every page filled in.\n");
  closePrompt();
}

if (env.LEAD_CRM_SETUP_LIB !== "1") main().catch((e) => { say("\n" + (e && e.message ? e.message : String(e))); closePrompt(); exit(1); });
