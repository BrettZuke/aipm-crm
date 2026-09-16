# The Google Sheet (optional)

The CRM keeps everything in its database. A Google Sheet is only for a copy
that started on one, or when you want the leads visible in a spreadsheet as
well. Ten minutes, once.

## Set the sheet up

1. Go to https://sheets.new and name the sheet.
2. Extensions, Apps Script. Delete what is in the editor, paste the whole of
   `Code.gs` from this folder, Save.
3. At the top of the script, put a password of your own between the quotes:
   `var SHARED_TOKEN = 'a-long-random-word';` and Save again. The script
   refuses every request until this is set, because the web app address is
   not a secret: it ends up in Vercel and in Make scenarios.
4. Deploy, New deployment, gear icon, Web app. Execute as: Me. Who has
   access: Anyone (the password from step 3 is what keeps strangers out).
   Deploy.
5. Google asks you to authorise it: your account, Advanced, Go to (project),
   Allow. It is your own script writing to your own sheet.
6. Copy the Web app URL. It ends in `/exec`.

## Point the CRM at it

In the CRM's Vercel project, Settings, Environment Variables:

```
LEADS_SHEET_URL=https://script.google.com/macros/s/xxxxxxxx/exec
LEADS_SHEET_TOKEN=a-long-random-word
```

Redeploy. Paste the `/exec` address into a browser and you should see
`{"ok":true,"message":"local-lead-finder sheet endpoint is live"}`.

## Changing the script later

Paste the new `Code.gs` over the old one, Save, then Deploy, Manage
deployments, edit, Deploy. A new deployment keeps the same address.

## The scraper and the reply watcher

The lead scraper writes into the same sheet with `SHEETS_WEBHOOK_URL` and
`SHEETS_WEBHOOK_TOKEN` in its `.env` (the same address and password). It and
`reply-watcher.gs`, which flips a lead to Replied when they email you back,
live in the AIPM-Complete-Setup repo next to this one on GitHub, under
`tools/lead-scraper/google-sheet`.
