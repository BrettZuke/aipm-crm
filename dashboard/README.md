# AIPM CRM

One page that runs your outreach: every lead in one list, who has been called,
emailed or messaged and what happened, replies floating to the top, a power
dialler, email sequences that run themselves, DM follow-ups, customers and
referrals, and a Results page that says what all of it is worth. It runs in
your own free Vercel account, keeps its data in your own free Supabase
database, and sends through your own Resend account. Nobody else can see it,
and there is nothing to pay for beyond what you already use.

The easiest way to do anything below is to ask Claude ("set up my Lead CRM")
with this folder open. The steps are here so it, or you, can do them.

## Put it live (about 5 minutes, one time)

Two free tokens and one command.

1. Make the tokens: a Supabase access token at
   supabase.com/dashboard/account/tokens (Generate new token) and a Vercel
   token at vercel.com/account/tokens (Create). Both accounts are free.
2. In a terminal, from this `dashboard` folder:

   ```
   node setup.mjs
   ```

   It asks for a name and the two tokens, then creates the database project,
   applies `schema.sql`, creates the Vercel project, sets its environment
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, a random `AUTH_SECRET`,
   `CRON_SECRET` and `SETUP_CODE`, your Resend key if you have one) and
   deploys. It prints your CRM's address and the setup code at the end. Node
   18 or newer is all it needs.
3. Open the printed address. The first visit asks for the setup code (the
   printed address carries it), your name, email and a password, and that
   becomes the owner account. From then on you sign in
   with it, or press "Email me a sign-in link" and skip the password;
   Settings, Team is where you invite anyone else. "Forgot your password?"
   emails a reset link. For a "Continue with Google" button: in Supabase open
   Authentication, Providers, Google, and paste a client ID and secret from a
   Google Cloud OAuth client (about ten minutes, Google's own guide walks it);
   the button appears on its own once the provider is on.
4. **See it working.** Settings, Data, Load sample data puts thirty made-up
   businesses and twenty coaches in, with their emails, calls, DMs, deals and
   tasks, so every page shows what it looks like in use. Nothing in it can
   reach a real person, and Remove sample data takes it all out again without
   touching anything you added.
5. **Bring leads in.** Settings, Data, Import a CSV takes any spreadsheet and
   matches the columns once. Add lead puts one in by hand. The lead scraper in
   AIPM-Complete-Setup (`tools/lead-scraper/find_leads.py`) sends every scrape straight in when its
   `.env` has `CRM_URL` (your CRM's address) and `CRM_KEY` (Settings,
   Developer, Your API key); anyone already on the list is skipped.
6. **Sending.** Settings, You: your name, your sending address (on a domain
   verified in Resend), your video link and your phone. Settings, Sending
   holds the address's daily cap and warm-up. The Today page lists whatever is
   still missing until it is all there.

### By hand instead

The same thing without the script: create a free project at supabase.com,
paste the whole of `schema.sql` into its SQL editor and run it once (safe to
run again), and copy the Project URL and the service_role key from Project
Settings, API. Then from this folder run `npx vercel deploy --prod`, and in
the Vercel project's Settings, Environment Variables add `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `AUTH_SECRET` and `CRON_SECRET` (two long random
strings; the second lets the daily schedule in), `SETUP_CODE` (eight characters
or more: the first visit asks for it, so nobody who finds the address can claim
the CRM before you do) and, when you have one, `RESEND_API_KEY`; redeploy. Under Supabase Authentication,
URL Configuration, set the Site URL to your CRM's address so sign-in and
reset links come back to the right place. Already have a database? `node
setup.mjs --supabase-url <url> --service-key <key>` skips straight to the app.

Every change saves as you make it, and everything lives in your database.
Settings, Data, Backup downloads your leads, customers and referrals as CSV
files (they open in Google Sheets or Excel), and the leads file imports
straight back in.

### Setting a client up

Same five steps, in the client's own accounts (Supabase, Vercel and Resend
under their email), so the business owns its data and its login. To feed
their website's contact form into it, open Settings, Developer: the API key
and the two addresses there take a POST from Make, Zapier or the form itself,
and every enquiry lands as a lead.

## Show replies (about 5 minutes, one time)

Replies come in through Resend and land on the lead's timeline with the whole
message (open the lead, "Read the whole reply"), the lead moves to **Replied**
on its own, and "Reply by email" opens your mail app with the thread ready. Works for emails the CRM sends and for the ones
your Make scenarios send, as long as they carry the same Reply-To address. One
setup per domain, and it is the same steps when you set a client up on theirs:

1. **In Resend, add a receiving domain.** Domains, Add domain, type
   `reply.yourdomain.com` (a subdomain, so the business's normal mailbox is
   untouched), and pick *Receiving* only. Resend then shows you two DNS records:
   an **MX** record and a **TXT** record.
2. **Add those records at the registrar**, wherever the domain's DNS lives
   (Porkbun, GoDaddy, Namecheap, Cloudflare: open the domain, then *DNS
   records*). The one that matters is the MX: Type `MX`, Host `reply`, Answer
   `inbound-smtp.us-east-1.amazonaws.com` (copy the exact value Resend shows; it
   changes with the region), Priority `10`. Add the TXT record the same way. Only
   the `reply` subdomain is touched: the business's existing email keeps working.
3. Back in Resend click **Verify**. DNS usually catches up in minutes, sometimes
   an hour.
4. **Point Resend at the CRM.** Resend, Webhooks, Add webhook: the address is on
   the CRM's Settings, Developer tab, *Replies* card (it ends in `/api/inbound`),
   and the one event to tick is **email.received**. Copy the webhook's signing
   secret (`whsec_...`) and paste it into that Replies card. Save.
5. **Tell the emails where to reply.** Settings, Sending, *Where replies go*:
   `Your Name <reply@reply.yourdomain.com>`. Put the same address as the
   Reply-To on any Make scenario that sends for you.

Press **Send myself a test reply** on the Replies card: it writes a pretend
reply from the first lead with an email so you can see where real ones appear.
Nothing is sent. From then on every reply lands on the lead's timeline within a
minute and the lead floats to the top of the list.

## Working the leads

Click a lead and you get its full story: a timeline of every email sent to it
(with opens and clicks, read from Resend), every call and DM you logged, every
reply, and everything the scraper found (phone, email, website, address,
rating, socials, notes). From there you can **Call**, **Email**, change its
**Status**, or add a dated **note**. Every field can be changed where it is
shown: hover it, click the pencil, type, press Enter.

**The power dialler is built for the desk.** Sit at your computer, click Call,
and the call rings out on your own number through the phone beside you: you talk
on the computer's mic or a headset, click what happened, and the next lead is
already on screen. Nobody ever types a number, and calls cost nothing extra.
It takes one pairing setup per computer, using the phone you already have:

- **Mac + iPhone**: open the **Phone app** on the Mac (macOS 26 or newer; on older
  Macs it is FaceTime > Settings > Calls from iPhone) and finish its setup, and on
  the iPhone turn on Settings > Phone > **Calls on Other Devices** and allow your
  Mac. Same Apple account on both, same Wi-Fi. The "iPhone calls are not
  available" error means one of those two switches is off.
- **Windows + Android**: install Microsoft's free **Phone Link** app (comes with
  Windows 11), pair your phone once, and clicking Call dials through your phone.
- **Windows + iPhone**: Phone Link also pairs with iPhones over Bluetooth for
  basic calling.
- **If clicking Call opens Zoom or Teams** instead of dialing, those apps grabbed
  phone links; pick the phone option when asked, or turn it off in that app.

The same steps live inside the CRM under **How it works**, "Call from this
computer". No computer around? Open the CRM in your phone's browser and tap
Call: the phone's dialer opens with the number already filled.

**Power dial** works through everyone still worth calling, hottest first: it shows
the phone script (filled in with your name and their details), you tap Call, then
tap what happened (Interested, Call back, Voicemail, No answer, Not interested, Bad
number) and it logs it and moves to the next lead. Voicemails, no-answers and
call-backs come round again next session; the rest drop out.

**Scripts** (Library, Scripts) hold your email templates, call scripts, DM
scripts and the sales call framework. Placeholders like [business] and [owner]
fill themselves per lead, every card has a "Copy for <business>" button, and an
edit to a built-in script is kept as your own version.

**Sequences** are follow-ups that run themselves: an email today, a call task
in three days, another email next week. Make one, tick leads in the list, add
them to it. **DMs** runs the same idea for Instagram: first message, three
follow-ups spaced out, the script for each step on screen.

### Online coaches

The Coaches book is worked from Instagram: a coach is a name, a profile link
and a stage. The board runs Not DM'd, DM'd, Answered, Interested, Not
interested, Left on read, Loom/VSL sent, Call booked, Closed. Open the
profile from the card, send the DM, come back and move the stage. The DM run
does the same thing in order, with the follow-up scripts on screen.

### Working as a team

Settings, Team is where you invite people. Every lead can then be assigned
to someone: open the lead, click the pencil beside "Assigned to", pick a
name. Their initials sit beside the business in the list and on the board,
and the list's "Assigned" filter shows your own leads, anyone's, or the ones
nobody has yet. Tick several leads and the bar at the bottom assigns them,
sets a status, makes a task, adds them to a sequence or removes them in one
go, with an undo.

### Your links

Settings, Links holds every address you send people: booking page, proposal,
VSL, the coach VSL, onboarding forms, payment links. Name them and any script
can drop them in with `[booking]`, `[proposal]`, `[vsl]`, `[coach_vsl]` and
`[pay]`; the Assets section has a Copy button for each.

### The emails

Sixty-six of them, written to get the click: 51 first emails rotated across
every lead (a lead's row decides which, so it never changes under you), 9 that
only go where they are true (six for no website, one each for a Facebook page
only, a dated site and a working site), 5 follow-ups on days 3, 7, 12, 18 and
25, and a monthly one after that. Scripts, Email templates shows them by group.
Edit any of them and the sender uses your version from the next run; Back to
built in puts the original back.

### Coach DMs

The DM run works a two-step DM. The opener exists only to get a reply, so the
thread moves out of Requests; there are 24 of them and every coach gets a
different one. When they answer, the run hands you a pivot that picks the
thread up and sends your video, then chases it on days 2, 4 and 7. Scripts,
DM scripts shows every message by group, Add one puts your own in, Edit
changes any of them, and the star makes a favourite: favourites sit at the
top and are the only ones the run uses while you have any.

### Targets and snooze

Today keeps a score against the targets you set: so many emails, DMs or
calls a day, and a week, per book. Set them from the Targets card on Today
(the coach book starts at forty DMs a day; the local book starts blank,
because its emails ramp with the warm-up). A streak counts the days in a row
you hit every daily target. Snooze, on any lead (or the s key), takes it out
of the list and the runs until the day you pick, then brings it back on its
own; the Snoozed tab is where it waits.

### Your week

Reports, This week: what went out (emails, DMs, cold calls), what came back,
sales calls had, customers won and money collected, across both books, this
week against last week to the same point, with the people waiting on you
listed underneath. Consistency is the whole game, so the report says plainly
whether you are ahead of or behind last week. "Email me this report" sends
that page to your inbox.

Settings, Sending, "Digest email" puts the same report on a schedule: every
day, every Monday or on the 1st, landing at 8am UK, New York or Los Angeles
time, to whoever you name. It needs `RESEND_API_KEY` and your sending address.

### The assistant

The bubble at the bottom right answers questions from your CRM: who replied
this week, which coaches are interested, what you collected this month, who
you have not followed up with. It runs on a free AI key you keep in
Settings, Assistant (Google AI Studio or Groq, a minute to get). Every
question sends your working lead list (names, emails, phones, notes, recent
replies, deals) to that provider, and the free tiers can keep and train on
what they receive, so on a CRM you run for a client leave the key out or use
a paid tier. It reads, it never sends or changes anything.

### Customers and referrals

Somebody becomes a customer when you mark their lead **Won**, log a deal, or
log a referral that brought them in. The Customers section shows what each
one paid, the jobs logged against them and who they have sent you. Referrals
holds the terms (what a referral pays, the discount, the keyword), logs each
one, emails both people, and marks rewards paid; cash to any one person is
capped per calendar year and turns into credit past the cap. Your customer
page is `/thanks.html` on your CRM: put that address in Referral terms and
every new customer is sent there.

### Tracked links

Every outreach email carries `https://<your crm>/go/<code>` instead of the raw
video link, one code per lead. A business that opens it lands on your video,
personalised for them, and "Opened the video link" appears on that lead's
timeline. Each lead's drawer shows its link next to the name: copy it into a DM
or a text, and opens from there show up the same way. Mail scanners that open
links before people do are not counted.

## Find and build (the site builder)

The Build button on a lead, the Find and build tab and the `[site]` and
`[proposal]` fields in scripts all hand a business to a site builder that
makes its website and proposal. The builder is its own small app: deploy
`tools/instant-builder` from the AIPM-Complete-Setup repo (next to this one on
GitHub) to your Vercel, then add these to this CRM's environment and redeploy:

- `INSTANT_BUILD_URL`: your builder's address plus `/api/build`
- `INSTANT_SCRAPE_URL`: the same address plus `/api/scrape`
- `INSTANT_SETTINGS_URL`: the same address plus `/api/settings`
- `INSTANT_BUILD_SECRET`: the secret you set on the builder
- `INSTANT_SITE_URL`: where the builder hosts finished sites
- `INSTANT_PROPOSAL_URL`: where it hosts finished proposals

Until they are set, Build says the builder is not configured, and everything
else works without it.

## The Google Sheet (optional)

The lead scraper can publish every run into a Google Sheet as well as into
the CRM: `google-sheet/SETUP.md` wires it, an Apps Script web app that takes
about two minutes. A copy of the CRM that starts life on a sheet reads it
through `LEADS_SHEET_URL` and `LEADS_SHEET_TOKEN` until the first import;
from then on the database is the book.

## The autopilot

The daily schedule ships with the app (`vercel.json`), so there is nothing to
enable: once a day it emails whoever is due (first touches, follow-ups, monthly
nurtures), skips anyone who replied or asked to be removed, respects the
warm-up, and writes the new statuses back. There is also a **Send now** button.
It needs the sending details from step 5 above; the Today page says what is
missing until then.

## All the settings (Vercel environment variables)

Required:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: your database.
- `AUTH_SECRET`: signs the login so nobody can fake it.
- `SETUP_CODE`: eight characters or more. The first visit asks for it; once the
  owner account exists it is never used again.

For sending and email health:

- `RESEND_API_KEY`: your Resend key.

Optional:

- `RESEND_FROM`, `OUTREACH_VIDEO_LINK`, `OUTREACH_SENDER_NAME`,
  `OUTREACH_SENDER_PHONE`, `RESEND_REPLY_TO`: the same things Settings, You
  holds; the settings win when both are set.
- `OUTREACH_DAILY_MAX`: raise the 40-a-day ceiling once the verdict stays green.
- `THANKYOU_URL`: the customer-facing thank-you page a new Won customer is sent.
- `CRON_SECRET`: the autopilot's own key (`setup.mjs` sets one).
- `INSTANT_BUILD_URL`, `INSTANT_SCRAPE_URL`, `INSTANT_SETTINGS_URL`,
  `INSTANT_BUILD_SECRET`, `INSTANT_SITE_URL`, `INSTANT_PROPOSAL_URL`: your own
  site builder. See Find and build below.
- `CRM_URL`: the address the digest email links to, when it is not the
  deployment's own (a custom domain, say).
- `SEND_MODE=simulate`: the sender plans every batch and sends nothing. For a
  demo copy, never a working one.
- `REFERRAL_BUSINESS`, `REFERRAL_REWARD`, `REFERRAL_DISCOUNT`, `REFERRAL_KEYWORD`:
  the same things Referral terms holds; the terms win when both are set.
- `CRM_USERS`, `CRM_PASS_SALT`, `CRM_PASS_HASH`: the older environment-variable
  login. Not needed when you make your login on the first visit.
- `AI_PROVIDER` and `AI_API_KEY`: the assistant's key, if you would rather
  keep it in Vercel than in Settings, Assistant (`gemini` or `groq`).
- `LEADS_SHEET_URL` and `LEADS_SHEET_TOKEN`: copies that keep leads on a
  Google Sheet (`../google-sheet/SETUP.md`).
- `ACTIVITY_SECRET` and `RESEND_WEBHOOK_SECRET`: the API key and the replies
  signing secret, if you would rather keep them in Vercel than in Settings,
  Developer.
- `AGENCY_NAME`, `REFERRAL_PHONE`: older names for the business and phone
  that Settings, You holds; the settings win. `THANKYOU_OWNER`: the owner's
  name on the customer thank-you page.
- `REFERRAL_CASH_CAP` and `REFERRAL_TZ`: the most cash one referrer gets per
  calendar year (450 unless set) and the timezone referral dates are stamped
  in (your profile's timezone unless set).
- `DASH_KEY`: leave unset. An older key-in-the-address login that the
  sign-in replaced.

The schedule runs once a day (some time within the hour after 16:00 UTC). If
nothing is due, it sends nothing. Anyone marked **Replied** or **Removed** is
never emailed again; the list is checked at the moment of sending.

## One switch that matters

In Resend, open **Domains**, click your domain, and turn on **open tracking** and
**click tracking**. Without that, Resend cannot see opens and clicks, and the
dashboard will show zeros for both. Turn it on before you start sending.

## Reading the verdict

- **Healthy**: bounces under 2 percent, spam complaints under 0.1 percent. Keep
  going. If you are steady at your daily cap, raise `OUTREACH_DAILY_MAX` a
  little at a time.
- **Throttle down**: something is drifting. Hold or lower your pace for a few days
  and watch this page.
- **Pause and fix**: bounces or spam complaints are at damaging levels. Stop
  sending on this domain, fix the cause (bad list, too much volume, copy that reads
  like spam), or start a fresh domain.
