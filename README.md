# AIPM CRM

The CRM from the AI Partner Method, as one repo: leads, cold calls with a power
dialler, emails that send themselves, Instagram DMs with a two-step run,
sequences, scripts, targets, customers, referrals and the reports, running in
your own free accounts. Nothing in here holds anybody's data.

## Start here

`dashboard/README.md`. One command puts it live (Supabase and Vercel), and the
first visit makes your login.

## Everything it connects to, and where the steps are

| Connection | What it does | Instructions |
|---|---|---|
| Supabase (free) | your database and your login | dashboard/README.md, Put it live |
| Vercel (free) | hosts the CRM and runs the daily autopilot | dashboard/README.md, Put it live |
| Resend (free tier) | sends cold emails from your own domain, tracks opens and clicks | dashboard/README.md, Sending, and One switch that matters |
| Resend replies | replies land on the lead's timeline and stop its follow-ups | dashboard/README.md, Show replies |
| Gmail through Make (free) | sends alongside Resend from your own Gmail | crm-gmail/SETUP-GMAIL.md |
| Google AI Studio or Groq (free) | the assistant bubble that answers questions from your CRM | dashboard/README.md, The assistant |
| Google sign-in (optional) | a Continue with Google button on the login | dashboard/README.md, Put it live, step 3 |
| The site builder | the Build button and the Find and build tab | dashboard/README.md, Find and build |
| The lead scraper | fills the list from Google Maps, straight into the CRM | the AIPM-Complete-Setup repo next to this one, tools/lead-scraper |
| The site builder app | what Build and Find and build call | AIPM-Complete-Setup, tools/instant-builder |
| Proposals | the on-a-call proposal and the builder's proposal template | AIPM-Complete-Setup, tools/sales-proposal and tools/proposal-builder |
| The VSL page | the video page every outreach email links to | AIPM-Complete-Setup, tools/vsl-page |
| Websites | the twenty templates and the client site template | AIPM-Complete-Setup, tools/website-templates and tools/website-template |
| Your links | VSL, proposal, booking page, payment links | Settings, Links |
| Your customer page | what a new customer sees after they pay | `/thanks.html` on your CRM, address in Referral terms |
| Webhooks and the API | anything else that finds a lead or logs an activity | Settings, Developer |
| Google Sheet (older path) | only for copies that started on a sheet | google-sheet/SETUP.md |

Open this folder in Claude Code and ask it to set up your CRM: it walks you
through each one.
