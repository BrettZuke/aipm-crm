# Send your CRM's emails from your own Gmail (about 20 minutes, once)

Out of the box the CRM sends through Resend, from a domain you set up for it.
This is the other way: every outreach email leaves from your own Gmail, so it
arrives looking exactly like an email you typed yourself.

Nothing else changes. The CRM still decides who is due, which email they get,
how many go out today and what lands on each lead's timeline. Make is only the
pipe between the two.

## What it costs

Four Make operations per email: the CRM hands it over, Gmail sends it, the
scenario answers the CRM, and it logs the send back on the lead. Make's free
plan gives you 1,000 operations a month, so **about 250 emails a month for
nothing**. The CRM's own warm-up cap starts at 5 a day and climbs, so you will
be well inside that for the first few weeks either way.

## What you need

- A free Make.com account.
- The Gmail you want to send from. A Google Workspace address on your own
  domain (you@yourbusiness.com) is easiest. A personal @gmail.com works too but
  needs step 2 first.
- Python 3.
- Your CRM open in another tab.

---

## 1. Get your Make token

1. Sign up at https://www.make.com. Once you are in, look at the address bar:
   the part before `.make.com` (for example `eu2`) is your **zone**.
2. Click your profile icon, choose **Profile**, open the **API access** tab and
   click **Add token**. Tick `scenarios:read`, `scenarios:write`, `hooks:write`,
   `connections:read`, `organizations:read` and `teams:read`. Copy the token
   straight away, because Make only shows it once.
3. In your CRM, open **Settings, Developer** and press **Reveal** on your API
   key (press **Rotate** first if there is no key yet). Copy it.
4. Make a file called `.env` in the `crm-gmail` folder with these four lines.
   Keep it there. Anything inside `dashboard` is published with the CRM, so a
   `.env` in that folder puts your Make token and your CRM key on a public web
   address.

       MAKE_API_TOKEN=your_make_api_token
       MAKE_ZONE=eu2
       CRM_URL=https://your-crm.vercel.app
       CRM_API_KEY=crm_live_...

   `CRM_URL` is the address you open your CRM at, with no slash on the end.

## 2. Only if you are sending from a personal @gmail.com (about 10 minutes)

Google will not let Make send from a personal Gmail through Make's own sign-in,
so you create a sign-in of your own, just for you. Do all of this signed in as
the Gmail you will send from. **On a Google Workspace address, skip to step 3.**

1. Go to https://console.cloud.google.com and create a project called `Make`.
2. **APIs & Services > Library**: enable the **Gmail API**.
3. **OAuth consent screen** (newer screens call it **Google Auth Platform**): app
   name `Make`, your Gmail as the support and developer contact, and `make.com`
   and `integromat.com` as authorised domains. When it asks who the users are,
   choose **External**.
4. **Data access**: add these two scopes.
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
5. **Audience**: add your Gmail as a test user, then click **Publish app**. Do
   not skip this. Left in testing, Google makes you sign in again every 7 days,
   and your emails stop without telling you.
6. **Clients > Create client**, type **Web application**. Under **Authorised
   redirect URIs** add all four of these, click **Create**, and copy the
   **Client ID** and **Client secret**.
   - `https://www.integromat.com/oauth/cb/google-restricted`
   - `https://www.make.com/oauth/cb/google-restricted`
   - `https://www.integromat.com/oauth/cb/google/`
   - `https://www.make.com/oauth/cb/google/`

In step 3, before you click sign in, tick **Show advanced settings** and paste
that Client ID and Client secret. Google will warn that the app is not verified:
click **Advanced**, then **Go to Make**, then **Allow**. It is your own app.

Google also makes personal Gmail accounts renew Make's access every six months.
When that happens, open **Connections** in Make and click **Reauthorize**.

## 3. Create the scenario

    python3 crm-gmail/install_gmail_pipe.py

It builds the whole thing on your account, switched OFF, and prints two things:
your **webhook URL** and a link to the scenario. Keep the webhook URL, you need
it in step 5.

## 4. Connect your Gmail

1. Open the scenario link it printed.
2. Click **Send it from my Gmail**. Next to **Connection**, click **Add** and
   sign in with the Gmail you want the emails to come from.
3. Click **Save** at the bottom, and close the tab.
4. Run:

       python3 crm-gmail/install_gmail_pipe.py --connect

   That puts your Gmail on the send step, checks it stuck, and switches the
   scenario on.

## 5. Turn it on in the CRM

In the CRM, **Settings, Sending**, find **Send from my own Gmail**. Paste the
webhook URL from step 3, turn the switch on, and press **Save**.

From the next send onwards every outreach email and every sequence email leaves
from your Gmail instead of Resend. Turn the switch off and it goes straight back
to Resend, with no redeploy and nothing to undo in Make.

## 6. Test it on yourself

1. In the CRM, add yourself as a lead with a second email address of yours.
2. Press **Send now** on Today.
3. The email should land in that inbox, from your Gmail, within a few seconds,
   and the send should appear on that lead's timeline in the CRM.

If it does not, open the scenario in Make and click **History**. Every run is
listed with the step that failed.

---

## Things worth knowing

**Replies land in your Gmail, not in the CRM.** That is the trade. Resend-sent
email comes back through the CRM's reply address and moves the lead to Replied
on its own; Gmail-sent email is a normal email from you, so the answer arrives
in your inbox like any other. Mark the lead **Replied** in the CRM when it does,
or the follow-ups keep going out.

**Do not rotate your CRM API key without re-running the installer.** The key is
baked into the scenario: it is what stops anyone else who finds your webhook URL
from making your Gmail send. Rotate it in Settings, Developer and every send
will start failing with "Your Make scenario did not send it". Delete the
scenario in Make and run `install_gmail_pipe.py` again to fix it.

**Gmail's own limits still apply**: 500 emails a day on a personal account,
2,000 on Google Workspace. The CRM's warm-up cap keeps you far under either, and
you should stay there. A brand new Gmail sending 200 cold emails on day one gets
shut down.

**Make switches a scenario off after three failed mornings in a row** and emails
you about it. Open it, click History, read the red run, fix what it names and
switch it back on. Usually it is an expired Google sign-in.

**Turning the switch off in the CRM is the emergency stop.** It takes effect on
the very next send, with no deploy. You do not have to touch Make at all.
