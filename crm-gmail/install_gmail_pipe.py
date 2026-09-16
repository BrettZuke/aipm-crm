#!/usr/bin/env python3
"""
Send your CRM's emails from your own Gmail, automatically.

You do NOT build anything by hand. This creates a small Make.com scenario that
takes an email from your CRM, sends it from your Gmail, and tells the CRM it
went. Four steps, created switched OFF, and it works on Make's free plan.

Put these in a .env file next to this script. Keep it here and never inside
the dashboard folder: everything in there is published with the CRM, and a
Make token sitting on a public URL is a Make token somebody else can use.

    MAKE_API_TOKEN=your_make_api_token
    MAKE_ZONE=eu2                 the bit before .make.com in your browser
    CRM_URL=https://your-crm.vercel.app
    CRM_API_KEY=crm_live_...      Settings, Developer, Reveal

Then run:

    python3 crm-gmail/install_gmail_pipe.py

It prints your webhook URL. Paste that into the CRM (Settings, Sending), then
connect Gmail in the scenario and run:

    python3 crm-gmail/install_gmail_pipe.py --connect

which puts your Gmail on the send step and switches the scenario on.

Full walkthrough: crm-gmail/SETUP-GMAIL.md
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCENARIO_NAME = "CRM - Send from my Gmail"
# A browser User-Agent is required or Make's Cloudflare returns "error code: 1010".
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
# An instant scenario is triggered by its webhook, not by a clock, but Make
# still refuses to start one without a schedule (it answers IM008).
SCHEDULE = {"type": "indefinitely", "interval": 900}
GMAIL = "google-email"
OWN_KEYS = ("CRM_URL", "CRM_API_KEY")


def die(msg):
    print("\nERROR: " + msg + "\n")
    sys.exit(1)


def load_env():
    env = {}
    for path in (os.path.join(ROOT, ".env"), os.path.join(HERE, ".env")):
        if os.path.exists(path):
            for line in open(path):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    # real environment variables win over the file
    for k, v in os.environ.items():
        if k.startswith("MAKE_") or k in OWN_KEYS:
            env[k] = v
    return env


def client(env):
    token = env.get("MAKE_API_TOKEN")
    zone = env.get("MAKE_ZONE", "").strip().lower().rstrip(".")
    if not token:
        die("MAKE_API_TOKEN is not set in your .env. See crm-gmail/SETUP-GMAIL.md for how to get it.")
    if not zone:
        die("MAKE_ZONE is not set in your .env. It is the part before .make.com in your "
            "browser address bar, for example eu2. See crm-gmail/SETUP-GMAIL.md.")
    base = "https://%s.make.com/api/v2" % zone
    hdrs = {"Authorization": "Token %s" % token, "User-Agent": UA,
            "Content-Type": "application/json"}

    def req(method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        r = urllib.request.Request(base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except urllib.error.URLError as e:
            die("Could not reach %s. Check your MAKE_ZONE (eu1, eu2, us1 or us2). (%s)"
                % (base, e))
    return zone, req


def find_team(env, req):
    if env.get("MAKE_TEAM_ID"):
        return env["MAKE_TEAM_ID"]
    s, b = req("GET", "/organizations")
    if s == 401:
        die("Make rejected your token (401). Double-check MAKE_API_TOKEN, and that "
            "MAKE_ZONE matches the account the token is from.")
    if s == 403:
        die("Your token cannot list organizations. Either give it the organizations:read "
            "scope, or find your team id in your Make URL (make.com/NNNNNN/...) and add "
            "MAKE_TEAM_ID=NNNNNN to your .env, then run again.")
    if s != 200:
        die("Could not list organizations (HTTP %s). %s" % (s, b[:200]))
    orgs = json.loads(b).get("organizations", [])
    if not orgs:
        die("No organizations found on this account.")
    s, b = req("GET", "/teams?organizationId=%s" % orgs[0]["id"])
    if s != 200:
        die("Could not list teams (HTTP %s). %s" % (s, b[:200]))
    teams = json.loads(b).get("teams", [])
    if not teams:
        die("No teams found on this account.")
    if len(teams) > 1:
        print("You have more than one team. Pick one, then add its id to your .env as "
              "MAKE_TEAM_ID=... and run again:")
        for t in teams:
            print("  %s   %s" % (t["id"], t.get("name")))
        sys.exit(1)
    return teams[0]["id"]


def find_scenario(req, team_id):
    s, b = req("GET", "/scenarios?teamId=%s" % team_id)
    if s != 200:
        die("Could not list your scenarios (HTTP %s). Your token needs the scenarios:read "
            "scope. %s" % (s, b[:200]))
    for sc in json.loads(b).get("scenarios", []):
        if sc.get("name") == SCENARIO_NAME:
            return sc
    return None


def blueprint(hook_id, crm_url, crm_key):
    """The four steps, in the order that makes a failure honest.

    The CRM must only count an email as sent when Gmail actually sent it, and
    Make answers a blocked run with a plain "Accepted" and HTTP 200. So the
    answer is built by a step of its own that can only run after Gmail has, and
    the CRM refuses anything that is not that step's JSON.

    The answer goes out BEFORE the CRM is told about the send, on purpose: the
    log line is worth an operation but not worth losing a send over, so if the
    CRM is briefly unreachable the ignore handler ends that run quietly and the
    email still counts.
    """
    # Make drops each mapped value straight into this template, so a quote or a
    # newline in any of them would make the body invalid JSON and the CRM would
    # answer 400. The CRM sends the three free-text values flattened for exactly
    # this step (log_business, log_subject, log_preview); never map 1.subject,
    # 1.business or 1.text in here.
    log_body = json.dumps({
        "email": "{{1.to}}",
        "business": "{{1.log_business}}",
        "lead_row": "{{1.lead_row}}",
        "channel": "email",
        "kind": "sent",
        "subject": "{{1.log_subject}}",
        "preview": "{{1.log_preview}}",
        "provider": "make-gmail",
        "external_id": "{{2.id}}",
        "source": "gmail",
    }, indent=2)
    return {
        "name": SCENARIO_NAME,
        "flow": [
            {"id": 1, "module": "gateway:CustomWebHook", "version": 1,
             "parameters": {"hook": hook_id, "maxResults": 1}, "mapper": {},
             "metadata": {"designer": {"x": 0, "y": 0, "name": "The CRM hands over an email"}}},

            {"id": 2, "module": "google-email:sendAnEmail", "version": 4,
             "parameters": {},
             # rawHtml, never "text": Make's text body type arrives as one
             # run-on paragraph with every line break lost.
             "mapper": {"to": ["{{1.to}}"], "subject": "{{1.subject}}",
                        "bodyType": "rawHtml", "content": "{{1.html}}",
                        "attachments": []},
             "metadata": {"designer": {"x": 300, "y": 0, "name": "Send it from my Gmail"}},
             # Nobody but your CRM may make your Gmail send. The webhook URL is
             # long and random, and this is the second lock: a POST without your
             # CRM's key stops here, and the CRM reads the resulting "Accepted"
             # as a failure rather than as a send.
             "filter": {"name": "Only my CRM",
                        "conditions": [[{"a": "{{1.secret}}", "b": crm_key,
                                         "o": "text:equal"}]]}},

            {"id": 3, "module": "gateway:WebhookRespond", "version": 1,
             "parameters": {},
             "mapper": {"status": "200",
                        "body": "{\"ok\": true, \"id\": \"{{2.id}}\"}",
                        "headers": [{"key": "Content-Type", "value": "application/json"}]},
             "metadata": {"designer": {"x": 600, "y": 0, "name": "Tell the CRM it went"}}},

            {"id": 4, "module": "http:MakeRequest", "version": 4,
             "parameters": {},
             "mapper": {"url": crm_url.rstrip("/") + "/api/activity",
                        "method": "post", "contentType": "json",
                        "inputMethod": "jsonString",
                        "jsonStringBodyContent": log_body,
                        "headers": [{"name": "x-activity-secret", "value": crm_key}],
                        "shareCookies": False, "parseResponse": False,
                        "allowRedirects": True, "stopOnHttpError": False,
                        "requestCompressedContent": True},
             "metadata": {"designer": {"x": 900, "y": 0, "name": "Log it on the lead"}},
             # One unreachable host would otherwise switch the whole scenario
             # off, and every email after it would stop going out.
             "onerror": [{"id": 5, "module": "builtin:Ignore", "version": 1,
                          "metadata": {"designer": {"x": 900, "y": 200}}}]},
        ],
        "metadata": {"instant": True, "version": 1,
                     "scenario": {"roundtrips": 1, "maxErrors": 3, "autoCommit": True,
                                  "autoCommitTriggerLast": True, "sequential": False,
                                  "confidential": False, "dataloss": False, "dlq": False},
                     "designer": {"orphans": []}},
    }


def edit_url(zone, team_id, scenario_id):
    return "https://%s.make.com/%s/scenarios/%s/edit" % (zone, team_id, scenario_id)


def crm_settings(env):
    url = (env.get("CRM_URL") or "").strip().rstrip("/")
    key = (env.get("CRM_API_KEY") or "").strip()
    if not url:
        die("CRM_URL is not set in your .env. It is the address you open your CRM at, "
            "for example https://your-crm.vercel.app")
    if not url.startswith("https://"):
        die("CRM_URL has to start with https://")
    if not key:
        die("CRM_API_KEY is not set in your .env. Open your CRM, Settings, Developer, "
            "press Reveal (or Rotate if there is no key yet) and copy it.")
    return url, key


def install(env, zone, req, team_id):
    crm_url, crm_key = crm_settings(env)
    existing = find_scenario(req, team_id)
    if existing:
        print("\nYou already have this scenario. Nothing to create.\n  %s\n"
              % edit_url(zone, team_id, existing["id"]))
        print("Its webhook URL is on the first step. If you need it again, open the "
              "scenario, click the first step and copy it.")
        return

    s, b = req("POST", "/hooks", {"name": SCENARIO_NAME, "teamId": int(team_id),
                                  "typeName": "gateway-webhook",
                                  "method": True, "headers": True, "stringify": False})
    if s not in (200, 201):
        die("Make would not create the webhook (HTTP %s). Your token needs the "
            "hooks:write scope. %s" % (s, b[:300]))
    hook = json.loads(b)["hook"]

    payload = {"blueprint": json.dumps(blueprint(hook["id"], crm_url, crm_key)),
               "scheduling": json.dumps(SCHEDULE), "teamId": int(team_id)}
    s, b = req("POST", "/scenarios", payload)
    if s not in (200, 201):
        # Leave nothing half-built behind.
        req("DELETE", "/hooks/%s?confirmed=true" % hook["id"])
        try:
            detail = json.loads(b).get("detail", b[:300])
        except ValueError:
            detail = b[:300]
        die("Make could not create the scenario (HTTP %s). %s" % (s, detail))
    scenario_id = json.loads(b)["scenario"]["id"]

    print("\nDone. Your Gmail sender is created. It is OFF, so nothing sends yet.")
    print("\nYour webhook URL (paste this into the CRM, Settings, Sending):\n  " + hook["url"])
    print("\nOpen the scenario here:\n  " + edit_url(zone, team_id, scenario_id))
    print("""
Then, in that screen:
  1. Click "Send it from my Gmail", and next to Connection click Add. Sign in
     with the Gmail you want the emails to come from. A personal @gmail.com
     address needs the one-time Google setup in crm-gmail/SETUP-GMAIL.md, step 2,
     first. A Google Workspace address does not.
  2. Click Save (bottom of the screen) and close the tab.
  3. Run:  python3 crm-gmail/install_gmail_pipe.py --connect

Full walkthrough: crm-gmail/SETUP-GMAIL.md
""")


def describe(connection):
    meta = connection.get("metadata") or {}
    who = meta.get("value") if isinstance(meta, dict) else ""
    return "%s%s" % (connection.get("name"), " (%s)" % who if who else "")


def pick(connections, env):
    matches = [c for c in connections if c.get("accountName") == GMAIL]
    chosen = (env.get("MAKE_GMAIL_CONNECTION_ID") or "").strip()
    if chosen:
        for c in matches:
            if str(c["id"]) == chosen:
                return c
        die("MAKE_GMAIL_CONNECTION_ID=%s is not one of your Gmail connections." % chosen)
    if len(matches) == 1:
        return matches[0]
    if not matches:
        die("There is no Gmail connection on your Make account yet. Do step 1 that "
            "install_gmail_pipe.py printed (crm-gmail/SETUP-GMAIL.md, step 3), then run this "
            "again.")
    print("\nYou have more than one Gmail connection. Put the id of the one to use in "
          "your .env as MAKE_GMAIL_CONNECTION_ID=<id>, then run this again:")
    for c in matches:
        print("  %s   %s" % (c["id"], describe(c)))
    sys.exit(1)


def connect(env, zone, req, team_id):
    scenario = find_scenario(req, team_id)
    if not scenario:
        die("There is no \"%s\" scenario yet. Run python3 crm-gmail/install_gmail_pipe.py "
            "first, without --connect." % SCENARIO_NAME)
    s, b = req("GET", "/connections?teamId=%s" % team_id)
    if s != 200:
        die("Could not list your connections (HTTP %s). Your token needs the "
            "connections:read scope. %s" % (s, b[:200]))
    gmail = pick(json.loads(b).get("connections", []), env)

    s, b = req("GET", "/scenarios/%s/blueprint" % scenario["id"])
    if s != 200:
        die("Could not read the scenario (HTTP %s). %s" % (s, b[:200]))
    bp = json.loads(b)["response"]["blueprint"]
    found = 0
    for m in bp["flow"]:
        if m["module"].startswith("google-email:"):
            m.setdefault("parameters", {})["__IMTCONN__"] = gmail["id"]
            found += 1
    if not found:
        die("That scenario has no Gmail step. Delete it in Make and run "
            "install_gmail_pipe.py again.")

    s, b = req("PATCH", "/scenarios/%s" % scenario["id"], {"blueprint": json.dumps(bp)})
    if s != 200:
        die("Make would not save the connection (HTTP %s). Your token needs the "
            "scenarios:write scope. %s" % (s, b[:200]))

    # Read it back rather than trusting the 200.
    s, b = req("GET", "/scenarios/%s/blueprint" % scenario["id"])
    if s != 200:
        die("Saved, but Make would not let me read the scenario back to check it "
            "(HTTP %s). Open it and check the send step shows your Gmail. %s" % (s, b[:200]))
    saved = json.loads(b)["response"]["blueprint"]
    stuck = [m for m in saved["flow"] if m["module"].startswith("google-email:")
             and (m.get("parameters") or {}).get("__IMTCONN__") == gmail["id"]]
    if not stuck:
        die("Saved, but the send step did not keep your Gmail connection. Open the "
            "scenario and set it by hand: " + edit_url(zone, team_id, scenario["id"]))

    s, b = req("POST", "/scenarios/%s/start" % scenario["id"])
    if s != 200:
        print("\nYour Gmail is on the send step, but Make would not switch the scenario "
              "on (HTTP %s). Open it and use the switch at the bottom left:\n  %s\n"
              % (s, edit_url(zone, team_id, scenario["id"])))
        print(b[:300])
        return

    print("\nDone. Emails now go out from %s, and the scenario is ON." % describe(gmail))
    print("\nLast step: in the CRM, Settings, Sending, paste your webhook URL, turn "
          "\"Send from my own Gmail\" on and press Save. Then send yourself a test "
          "(crm-gmail/SETUP-GMAIL.md, step 5).")
    print("\n  " + edit_url(zone, team_id, scenario["id"]) + "\n")


def main():
    ap = argparse.ArgumentParser(
        description="Create the Gmail sender scenario on your Make account.")
    ap.add_argument("--connect", action="store_true",
                    help="put your Gmail on the send step of the scenario you already "
                         "created, and switch it on")
    args = ap.parse_args()
    env = load_env()
    zone, req = client(env)
    team_id = find_team(env, req)
    if args.connect:
        connect(env, zone, req, team_id)
    else:
        install(env, zone, req, team_id)


if __name__ == "__main__":
    main()
