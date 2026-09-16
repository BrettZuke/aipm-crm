/**
 * local-lead-finder  ->  Google Sheets publisher (auto-formatting)
 *
 * Paste this into your leads Google Sheet under Extensions > Apps Script,
 * then Deploy it as a Web app. Full click-by-click steps are in SETUP.md.
 *
 * On the first run it styles the sheet automatically: a title banner, a bold
 * frozen header, alternating row shades, colour-coded lead heat and site status,
 * a Status dropdown, and sensible column widths. Every run appends new leads and
 * they pick up the same formatting.
 */

// REQUIRED: a password of your own. Put the same value in the scraper's .env as
// SHEETS_WEBHOOK_TOKEN and on the CRM's Vercel project as LEADS_SHEET_TOKEN.
// While it is blank every request that reads or writes rows is refused: the web
// app URL is not a secret, it sits in .env files, in Vercel and in Make scenarios.
var SHARED_TOKEN = '';
var NO_TOKEN = 'Set SHARED_TOKEN at the top of Code.gs, then Deploy > Manage deployments > edit > Deploy. Put the same value in the scraper .env as SHEETS_WEBHOOK_TOKEN and on the CRM as LEADS_SHEET_TOKEN.';

var SHEET_NAME = 'Leads';
var LAST_FMT_ROW = 2000; // formatting/validation cover this many rows

// Pretty column titles.
var LABELS = {
  lead_heat: 'Lead', business_name: 'Business', category: 'Category', owner_name: 'Owner',
  phone: 'Phone', email: 'Email', why_reach_out: 'Why reach out', website: 'Website',
  facebook: 'Facebook', instagram: 'Instagram', website_status: 'Site status',
  rating: 'Rating', reviews: 'Reviews', address: 'Address', city: 'City', region: 'Region',
  postal_code: 'Postal', country: 'Country', google_maps_url: 'Google Maps',
  status: 'Status', contacted_on: 'Contacted on', notes: 'Notes'
};
var WIDTHS = {
  lead_heat: 70, business_name: 210, category: 150, owner_name: 110, phone: 120, email: 210,
  why_reach_out: 380, website: 220, facebook: 170, instagram: 170, website_status: 95,
  rating: 60, reviews: 70, address: 260, city: 110, region: 90, postal_code: 80, country: 70,
  google_maps_url: 120, status: 120, contacted_on: 110, notes: 220
};
var STATUS_CHOICES = ['New', 'Contacted', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Follow-up 4', 'Follow-up 5', 'Nurturing', 'Replied', 'Removed', 'Interested', 'Proposal sent', 'Won', 'Lost', 'Not a fit', 'Voicemail', 'No answer', 'Callback', 'Bad number'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!SHARED_TOKEN) return _json({ ok: false, error: NO_TOKEN });
    if (typeof body.token !== 'string' || body.token !== SHARED_TOKEN) {
      return _json({ ok: false, error: 'bad token' });
    }
    // The outreach autopilot posts status updates after it emails leads.
    if (body.op === 'mark') {
      return _json(markStatuses(body.updates || []));
    }
    // The CRM's script editor saves the call scripts here.
    if (body.op === 'scripts') {
      return _json(writeScripts(body.scripts || {}));
    }
    // The referral tab logs a new referred customer.
    if (body.op === 'referral') {
      return _json(addReferral(body.referral || {}));
    }
    // The referral tab marks a reward as paid out.
    if (body.op === 'referral_paid') {
      return _json(markReferralPaid(body.row, body.payment_ref || ''));
    }
    // The referral tab saves the terms (reward, discount, keyword, cap).
    if (body.op === 'referral_terms') {
      return _json(writeReferralTerms(body.terms || {}));
    }
    // The customers tab logs a job against somebody.
    if (body.op === 'job') {
      return _json(addJob(body.job || {}));
    }
    // Find and build sends the businesses it scraped straight into the sheet,
    // so they are here to look at like any other lead rather than only living
    // inside the dashboard.
    if (body.op === 'add_leads') {
      return _json(addLeads(body.leads || []));
    }
    // The CRM edits a lead's fields in place: a corrected phone, a new email.
    if (body.op === 'update') {
      return _json(updateLead(body.row, body.fields || {}));
    }
    // The CRM removes a lead. The row is cleared, not deleted, so every other
    // row keeps its number and nothing that points at a row goes wrong.
    if (body.op === 'remove') {
      return _json(removeLead(body.row));
    }
    // The referral desk edits or removes a referral it logged.
    if (body.op === 'referral_update') {
      return _json(updateReferral(body.row, body.fields || {}));
    }
    if (body.op === 'referral_delete') {
      return _json(deleteReferral(body.row));
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.getSheets()[0];
      sheet.setName(SHEET_NAME);
    }

    var headers = body.headers || [];
    var rows = body.rows || [];

    if (sheet.getLastRow() === 0 && headers.length) {
      setupSheet(sheet, headers);
    }
    if (rows.length) {
      var startRow = Math.max(sheet.getLastRow() + 1, 3);
      var needRows = startRow + rows.length - 1;
      if (needRows > sheet.getMaxRows()) {
        sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
      }
      sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows.map(_safeRow));
    }
    return _json({ ok: true, added: rows.length });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function setupSheet(sheet, headers) {
  var ncols = headers.length;
  if (sheet.getMaxRows() < LAST_FMT_ROW) {
    sheet.insertRowsAfter(sheet.getMaxRows(), LAST_FMT_ROW - sheet.getMaxRows());
  }

  function textRule(a1, text, bg, fontColor) {
    var b = SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg);
    if (fontColor) { b.setFontColor(fontColor); b.setBold(true); }
    return b.setRanges([sheet.getRange(a1)]).build();
  }

  // Title banner (row 1).
  sheet.getRange(1, 1, 1, ncols).merge()
    .setValue('Local Lead Finder  |  your leads')
    .setBackground('#14264a').setFontColor('#ffffff').setFontSize(15)
    .setFontWeight('bold').setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  // Header row (row 2), pretty labels.
  var labels = headers.map(function (h) { return LABELS[h] || h; });
  sheet.getRange(2, 1, 1, ncols).setValues([labels.map(_cell)])
    .setBackground('#1f2a44').setFontColor('#ffffff')
    .setFontWeight('bold').setVerticalAlignment('middle');
  sheet.setRowHeight(2, 24);

  // Column widths + wrap on the long text columns.
  headers.forEach(function (h, i) { if (WIDTHS[h]) sheet.setColumnWidth(i + 1, WIDTHS[h]); });
  ['why_reach_out', 'address', 'notes'].forEach(function (h) {
    var i = headers.indexOf(h);
    if (i >= 0) sheet.getRange(3, i + 1, LAST_FMT_ROW, 1).setWrap(true);
  });

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(2);

  // Conditional formatting: colours first (higher priority), banding last.
  var rules = [];
  var heat = headers.indexOf('lead_heat');
  if (heat >= 0) {
    var hc = _colLetter(heat + 1) + '3:' + _colLetter(heat + 1) + LAST_FMT_ROW;
    rules.push(textRule(hc, 'HOT', '#fce0e0', '#b4232a'));
    rules.push(textRule(hc, 'WARM', '#fdefc9', '#946200'));
    rules.push(textRule(hc, 'COOL', '#e9ecf1', '#55607a'));
  }
  var site = headers.indexOf('website_status');
  if (site >= 0) {
    var sc = _colLetter(site + 1) + '3:' + _colLetter(site + 1) + LAST_FMT_ROW;
    ['NONE', 'SOCIAL', 'BROKEN'].forEach(function (v) { rules.push(textRule(sc, v, '#fce0e0', null)); });
    rules.push(textRule(sc, 'OUTDATED', '#fdefc9', null));
    rules.push(textRule(sc, 'modern', '#dcf1e3', null));
  }
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=ISEVEN(ROW())')
    .setBackground('#f4f6f9')
    .setRanges([sheet.getRange('A3:' + _colLetter(ncols) + LAST_FMT_ROW)]).build());
  sheet.setConditionalFormatRules(rules);

  // Status dropdown.
  var st = headers.indexOf('status');
  if (st >= 0) {
    var dv = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_CHOICES, true).setAllowInvalid(false).build();
    sheet.getRange(3, st + 1, LAST_FMT_ROW, 1).setDataValidation(dv);
  }
}

function _colLetter(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m - 1) / 26);
  }
  return s;
}

// Sheets reads a cell that starts with = + - @ (or a tab or a return) as a
// formula, and a formula can send the rest of the sheet to a stranger's server
// the moment the owner opens it. Text is written with a leading apostrophe,
// which Sheets treats as "this is text" and leaves out of the value it hands
// back, so nothing the CRM reads changes.
function _cell(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
function _safeRow(row) { return row.map(_cell); }

// A plain visit in the browser confirms the endpoint is live. With ?stats=1 it
// returns status counts and recent replies (the dashboard's replies panel). With
// ?leads=1 it returns every emailable lead's row, status, and dates, which is how
// the outreach autopilot decides who is due for an email. With ?crm=1 it returns
// every lead with every column, which powers the mini CRM (dashboard/README.md).
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.stats || p.leads || p.crm || p.referrals || p.customers) {
    if (!SHARED_TOKEN) return _json({ ok: false, error: NO_TOKEN });
    if (typeof p.token !== 'string' || p.token !== SHARED_TOKEN) {
      return _json({ ok: false, error: 'bad token' });
    }
    if (p.referrals) return _json(sheetReferrals());
    if (p.customers) return _json(sheetCustomers());
    return _json(p.crm ? sheetCrmLeads() : (p.leads ? sheetLeads() : sheetStats()));
  }
  return _json({ ok: true, message: 'local-lead-finder sheet endpoint is live' });
}

// Column positions by their row-2 labels, so layout changes do not break anything.
function _findCols(sheet) {
  var ncols = sheet.getLastColumn();
  var labels = sheet.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
  return {
    biz: labels.indexOf(LABELS.business_name) + 1,
    email: labels.indexOf(LABELS.email) + 1,
    status: labels.indexOf(LABELS.status) + 1,
    when: labels.indexOf(LABELS.contacted_on) + 1,
    notes: labels.indexOf(LABELS.notes) + 1,
    cat: labels.indexOf(LABELS.category) + 1,
    city: labels.indexOf(LABELS.city) + 1
  };
}

// Every lead with an email address: row number, business, status, contacted_on.
// The autopilot works out who is due; leads marked Replied or Removed simply
// come back with that status and are skipped.
function sheetLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet || sheet.getLastRow() < 3) return { ok: true, leads: [] };
  var cols = _findCols(sheet);
  if (!cols.email || !cols.status) return { ok: false, error: 'no Email or Status column found on row 2' };
  var count = sheet.getLastRow() - 2;
  var emails = sheet.getRange(3, cols.email, count, 1).getValues();
  var statuses = sheet.getRange(3, cols.status, count, 1).getValues();
  var bizVals = cols.biz ? sheet.getRange(3, cols.biz, count, 1).getValues() : null;
  var whenVals = cols.when ? sheet.getRange(3, cols.when, count, 1).getValues() : null;
  var catVals = cols.cat ? sheet.getRange(3, cols.cat, count, 1).getValues() : null;
  var cityVals = cols.city ? sheet.getRange(3, cols.city, count, 1).getValues() : null;
  var leads = [];
  for (var i = 0; i < count; i++) {
    var email = String(emails[i][0] || '').trim();
    if (!email) continue;
    leads.push({
      row: i + 3,
      business: bizVals ? String(bizVals[i][0] || '') : '',
      email: email,
      status: String(statuses[i][0] || '').trim(),
      contacted_on: whenVals ? String(whenVals[i][0] || '') : '',
      category: catVals ? String(catVals[i][0] || '') : '',
      city: cityVals ? String(cityVals[i][0] || '') : ''
    });
  }
  return { ok: true, leads: leads };
}

// The editable call scripts. They live in a "Scripts" tab so anyone can change
// the wording in plain text; the CRM reads them with every ?crm=1 load. On the
// first read the tab is created with the default scripts already filled in.
// Placeholders the CRM fills per lead: [name] [business] [owner] [trade] [town]
// [reviews] [flaw]. Lines wrapped in (brackets) show as grey staging notes.
var SCRIPTS_TAB = 'Scripts';
var DEFAULT_SCRIPTS = {
  no_website: '"Hi, is this [owner]? My name is [name], I will be quick. I was looking for [trade] in [town] on Google and found you through your reviews, but I could not find a website for you. Is that right?"\n(let them answer)\n"You have got [reviews] and a great reputation, but when people search \'[trade] near me\', the businesses with a website show up first and take those jobs. I build websites for local [trade] businesses, and I have already put a demo together for [business] so you can see exactly what I mean."\n"The easiest way is to grab 20 minutes with me this week and I will walk you through it on screen. Have you got your calendar there, what day suits you?"\n(if they hesitate)\n"No problem at all. What is the best personal email for you? I will send the video over tonight so you can watch it when it suits, and I will give you a ring back in a couple of days."',
  old_site: '"Hi, is this [owner]? My name is [name], I will be quick. I found [business] on Google, great reviews. I had a look at your website and [flaw]. Did you know it was doing that?"\n(let them answer, most will not know)\n"That is really common, and it quietly costs you jobs because most people check you out on their phone before they ring anyone. I fix exactly this for local [trade] businesses, and I have already put a short video together showing what [business] could look like."\n"The easiest way is to grab 20 minutes with me this week and I will show you properly on screen. What day works for you?"\n(if they hesitate)\n"Totally fine. What is the best personal email for you? I will send the video across tonight, and I will check back with you in a couple of days."',
  voicemail: '"Hi, it\'s [name]. I was looking at [business] online and spotted something on your website that is probably costing you jobs. I have put a short video together showing the fix. Call or text me back on this number and I will send it over. I will try you again in a couple of days either way. Thanks."\n(leave a reason to call back, not a pitch)'
};
var SCRIPT_KEYS = ['no_website', 'old_site', 'voicemail'];
var SCRIPT_TITLES = {
  no_website: 'Call script: business with NO website',
  old_site: 'Call script: OLD or BROKEN website',
  voicemail: 'Voicemail (keep it under 15 seconds)'
};

function sheetScripts() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tab = ss.getSheetByName(SCRIPTS_TAB);
    if (!tab) {
      tab = ss.insertSheet(SCRIPTS_TAB);
      tab.getRange(1, 1).setValue('Edit your call scripts below; the CRM uses them straight away. Placeholders filled per lead: [name] [business] [owner] [trade] [town] [reviews] [flaw]. Lines in (brackets) show as grey notes to yourself.')
        .setFontWeight('bold').setWrap(true);
      tab.setColumnWidth(1, 220);
      tab.setColumnWidth(2, 720);
      var r = 3;
      for (var i = 0; i < SCRIPT_KEYS.length; i++) {
        var key = SCRIPT_KEYS[i];
        tab.getRange(r, 1).setValue(SCRIPT_TITLES[key]).setFontWeight('bold').setVerticalAlignment('top');
        tab.getRange(r, 2).setValue(DEFAULT_SCRIPTS[key]).setWrap(true);
        tab.getRange(r + 1, 1).setValue(key).setFontColor('#999999').setVerticalAlignment('top');
        r += 3;
      }
    }
    // Read: the key sits in column A (grey row under each title), text in column B
    // of the title row above it. Simplest robust scan: any row whose column A is a
    // known key takes its text from the row ABOVE, column B.
    var out = {};
    var last = tab.getLastRow();
    if (last >= 2) {
      var grid = tab.getRange(1, 1, last, 2).getValues();
      for (var j = 1; j < grid.length; j++) {
        var k = String(grid[j][0] || '').trim();
        if (SCRIPT_KEYS.indexOf(k) >= 0 && j >= 1) {
          out[k] = String(grid[j - 1][1] || '');
        }
      }
    }
    return out;
  } catch (err) {
    return {};
  }
}

// Saves scripts edited in the CRM back into the Scripts tab. The tab is just
// storage; editing happens in the CRM's script editor.
function writeScripts(scripts) {
  try {
    sheetScripts(); // make sure the tab exists with its structure
    var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCRIPTS_TAB);
    var last = tab.getLastRow();
    var grid = tab.getRange(1, 1, last, 1).getValues();
    var saved = 0;
    for (var j = 1; j < grid.length; j++) {
      var k = String(grid[j][0] || '').trim();
      if (SCRIPT_KEYS.indexOf(k) >= 0 && Object.prototype.hasOwnProperty.call(scripts, k)) {
        // The key sits one row below its title row; the text lives in column B
        // of the title row, exactly where sheetScripts() reads it.
        tab.getRange(j, 2).setValue(_cell(String(scripts[k])));
        saved++;
      }
    }
    return { ok: true, saved: saved };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Every lead with every column, for the mini CRM (crm.html). Unlike sheetLeads
// it does not require an email: no-website leads often have only a phone, and the
// CRM works both channels. Row numbers come along for the write-back.
function sheetCrmLeads() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet || sheet.getLastRow() < 3) return { ok: true, leads: [] };
  var ncols = sheet.getLastColumn();
  var labels = sheet.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
  function col(label) { return labels.indexOf(label) + 1; }
  var c = {
    biz: col(LABELS.business_name), owner: col(LABELS.owner_name), phone: col(LABELS.phone),
    email: col(LABELS.email), why: col(LABELS.why_reach_out), website: col(LABELS.website),
    facebook: col(LABELS.facebook), instagram: col(LABELS.instagram), heat: col(LABELS.lead_heat),
    site: col(LABELS.website_status), category: col(LABELS.category), rating: col(LABELS.rating),
    reviews: col(LABELS.reviews), address: col(LABELS.address), city: col(LABELS.city),
    region: col(LABELS.region), postal: col(LABELS.postal_code), country: col(LABELS.country),
    maps: col(LABELS.google_maps_url), status: col(LABELS.status), when: col(LABELS.contacted_on),
    notes: col(LABELS.notes)
  };
  if (!c.biz && !c.phone) return { ok: false, error: 'no Business or Phone column found on row 2. Re-paste the latest Code.gs.' };
  var count = sheet.getLastRow() - 2;
  var grid = sheet.getRange(3, 1, count, ncols).getValues();
  function val(row, ci) { return ci ? String(row[ci - 1] == null ? '' : row[ci - 1]).trim() : ''; }
  var leads = [];
  for (var i = 0; i < count; i++) {
    var r = grid[i];
    var phone = val(r, c.phone);
    if (!phone && !val(r, c.biz) && !val(r, c.email)) continue; // fully blank row
    leads.push({
      row: i + 3,
      business: val(r, c.biz),
      owner_name: val(r, c.owner),
      phone: phone,
      email: val(r, c.email),
      why: val(r, c.why),
      website: val(r, c.website),
      facebook: val(r, c.facebook),
      instagram: val(r, c.instagram),
      heat: val(r, c.heat),
      website_status: val(r, c.site),
      category: val(r, c.category),
      rating: val(r, c.rating),
      reviews: val(r, c.reviews),
      address: val(r, c.address),
      city: val(r, c.city),
      region: val(r, c.region),
      postal_code: val(r, c.postal),
      country: val(r, c.country),
      google_maps_url: val(r, c.maps),
      status: val(r, c.status),
      contacted_on: val(r, c.when),
      notes: val(r, c.notes)
    });
  }
  return { ok: true, leads: leads, scripts: sheetScripts() };
}

// Batch status write-back: [{row, status, contacted_on, note}, ...]. The outreach
// autopilot sends status + contacted_on; Call Mode also sends a note, which is
// prepended to the lead's Notes cell (newest first) so the call history is kept.
// Writes the given fields onto one lead's row. Keys are the sheet's own column
// keys (business_name, phone, email, ...); anything not a known column is left.
function updateLead(row, fields) {
  row = parseInt(row, 10);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet) return { ok: false, error: 'no sheet' };
  if (!row || row < 3 || row > sheet.getLastRow()) return { ok: false, error: 'that lead is not on the sheet' };
  var ncols = sheet.getLastColumn();
  var labels = sheet.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
  var updated = 0;
  for (var key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key) || !LABELS[key]) continue;
    var c = labels.indexOf(LABELS[key]) + 1;
    if (c < 1) continue;
    sheet.getRange(row, c).setValue(_cell(fields[key] == null ? '' : String(fields[key])));
    updated++;
  }
  return { ok: true, row: row, updated: updated };
}

// Clears a lead's row. Not deleteRow: that would renumber every row below it,
// and tasks, deals and the activity log all point at rows by number.
function removeLead(row) {
  row = parseInt(row, 10);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet) return { ok: false, error: 'no sheet' };
  if (!row || row < 3 || row > sheet.getLastRow()) return { ok: false, error: 'that lead is not on the sheet' };
  sheet.getRange(row, 1, 1, sheet.getLastColumn()).clearContent();
  return { ok: true, row: row, removed: 1 };
}

// The referral columns, in the order addReferral writes them.
var REFERRAL_FIELD_COL = {
  customer: 2, customer_email: 3, customer_phone: 4, job: 5, referrer: 6, referrer_email: 7,
  reward: 8, reward_type: 9, status: 10, payment_ref: 12
};

function updateReferral(row, fields) {
  row = Number(row);
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REFERRALS_TAB);
  if (!tab) return { ok: false, error: 'no Referrals tab yet' };
  if (!row || row < 3 || row > tab.getLastRow()) return { ok: false, error: 'that referral is not on the sheet' };
  var updated = 0;
  for (var key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key) || !REFERRAL_FIELD_COL[key]) continue;
    var v = fields[key];
    if (key === 'reward') v = Number(v) || 0;
    else v = v == null ? '' : String(v);
    tab.getRange(row, REFERRAL_FIELD_COL[key]).setValue(_cell(v));
    updated++;
  }
  return { ok: true, row: row, updated: updated };
}

// Clears the referral's row, for the same reason removeLead clears rather than
// deletes. A cleared row has no customer name, so the readers skip it.
function deleteReferral(row) {
  row = Number(row);
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REFERRALS_TAB);
  if (!tab) return { ok: false, error: 'no Referrals tab yet' };
  if (!row || row < 3 || row > tab.getLastRow()) return { ok: false, error: 'that referral is not on the sheet' };
  tab.getRange(row, 1, 1, REFERRAL_HEADERS.length).clearContent();
  return { ok: true, row: row, deleted: 1 };
}

function markStatuses(updates) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet) return { ok: false, error: 'no sheet' };
  var cols = _findCols(sheet);
  if (!cols.status) return { ok: false, error: 'no Status column found on row 2' };
  var done = 0;
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i] || {};
    var row = parseInt(u.row, 10);
    if (!row || row < 3 || row > sheet.getLastRow()) continue;
    if (u.status) sheet.getRange(row, cols.status).setValue(_cell(String(u.status)));
    if (u.contacted_on && cols.when) sheet.getRange(row, cols.when).setValue(_cell(String(u.contacted_on)));
    if (u.note && cols.notes) {
      var cell = sheet.getRange(row, cols.notes);
      var prev = String(cell.getValue() || '').trim();
      cell.setValue(_cell(prev ? (String(u.note) + '\n' + prev) : String(u.note)));
    }
    done++;
  }
  return { ok: true, updated: done };
}

// Count every lead by Status and list the most recent replies. Columns are found
// by their header labels (row 2), so this survives layout changes.
function sheetStats() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (!sheet || sheet.getLastRow() < 3) {
    return { ok: true, total: 0, statuses: {}, replied: [] };
  }
  var ncols = sheet.getLastColumn();
  var labels = sheet.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
  var bizCol = labels.indexOf(LABELS.business_name) + 1;
  var statusCol = labels.indexOf(LABELS.status) + 1;
  var whenCol = labels.indexOf(LABELS.contacted_on) + 1;
  if (statusCol === 0) return { ok: false, error: 'no Status column found on row 2' };

  var count = sheet.getLastRow() - 2;
  var statusVals = sheet.getRange(3, statusCol, count, 1).getValues();
  var bizVals = bizCol ? sheet.getRange(3, bizCol, count, 1).getValues() : null;
  var whenVals = whenCol ? sheet.getRange(3, whenCol, count, 1).getValues() : null;

  var statuses = {};
  var replied = [];
  for (var i = 0; i < count; i++) {
    var s = String(statusVals[i][0] || '').trim() || 'New';
    statuses[s] = (statuses[s] || 0) + 1;
    if (s === 'Replied' || s === 'Interested') {
      replied.push({
        business: bizVals ? String(bizVals[i][0] || '') : '',
        when: whenVals ? String(whenVals[i][0] || '') : ''
      });
    }
  }
  return { ok: true, total: count, statuses: statuses, replied: replied.slice(-15).reverse() };
}

/* ---------------------------------------------------------------------------
 * Referrals
 *
 * A second tab that records who sent whom, what they are owed, and whether it
 * has been paid. Created on first use so nobody has to set it up by hand.
 * The CRM's referral page reads and writes it through the three ops below.
 * ------------------------------------------------------------------------- */

var REFERRALS_TAB = 'Referrals';
var REFERRAL_HEADERS = [
  'Date', 'New customer', 'Their email', 'Their phone', 'Job',
  'Referred by', 'Referrer email', 'Reward', 'Reward type', 'Status',
  'Paid on', 'Payment ref'
];
var REFERRAL_WIDTHS = [95, 170, 220, 120, 180, 170, 220, 80, 95, 90, 95, 150];

// Builds the tab the first time a referral is logged, styled like the Leads tab
// so the two do not look like they came from different products.
function _referralsTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(REFERRALS_TAB);
  if (tab) return tab;
  tab = ss.insertSheet(REFERRALS_TAB);
  var n = REFERRAL_HEADERS.length;
  tab.getRange(1, 1, 1, n).merge()
    .setValue('Referrals')
    .setFontSize(14).setFontWeight('bold')
    .setBackground('#1a3a6b').setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  tab.setRowHeight(1, 34);
  tab.getRange(2, 1, 1, n).setValues([REFERRAL_HEADERS])
    .setFontWeight('bold').setBackground('#eef2f8').setBorder(null, null, true, null, null, null);
  tab.setFrozenRows(2);
  for (var i = 0; i < n; i++) tab.setColumnWidth(i + 1, REFERRAL_WIDTHS[i]);
  var statusCol = REFERRAL_HEADERS.indexOf('Status') + 1;
  tab.getRange(3, statusCol, LAST_FMT_ROW, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Pending', 'Paid', 'Void'], true).build()
  );
  return tab;
}

/* The referral terms live in their own tab so the owner can change what they
 * pay without anybody redeploying anything, and so every client's copy of this
 * CRM carries its own numbers. Same key-in-A, value-in-B shape as the call
 * scripts tab, for the same reason: it stays readable and editable by hand. */
var REFERRAL_TERMS_TAB = 'Referral Terms';
var REFERRAL_TERM_KEYS = ['reward', 'discount', 'keyword', 'business', 'cash_cap'];
var REFERRAL_TERM_TITLES = {
  reward: 'Reward per referral (number only, eg 150)',
  discount: 'What the new customer gets (eg $50 off)',
  keyword: 'Keyword they have to say (blank = no keyword needed)',
  business: 'Business name on the emails',
  cash_cap: 'Most cash to one person per calendar year (blank = 450)'
};
var REFERRAL_TERM_DEFAULTS = {
  reward: '', discount: '', keyword: '', business: '', cash_cap: '450'
};

function _referralTermsTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(REFERRAL_TERMS_TAB);
  if (tab) return tab;
  tab = ss.insertSheet(REFERRAL_TERMS_TAB);
  tab.getRange(1, 1).setValue('Your referral programme. Change these here or in the CRM; both write to the same place.')
    .setFontWeight('bold').setWrap(true);
  tab.setColumnWidth(1, 380);
  tab.setColumnWidth(2, 260);
  // Two rows per setting: the title with its value in column B, then the machine
  // key underneath. They must not overlap, or each setting overwrites the key of
  // the one before it and only the last one is ever found again.
  for (var i = 0; i < REFERRAL_TERM_KEYS.length; i++) {
    var key = REFERRAL_TERM_KEYS[i];
    var row = 3 + i * 2;
    tab.getRange(row, 1).setValue(REFERRAL_TERM_TITLES[key]);
    tab.getRange(row, 2).setValue(REFERRAL_TERM_DEFAULTS[key]);
    tab.getRange(row + 1, 1).setValue(key).setFontColor('#999999').setFontSize(8);
  }
  return tab;
}

// Reads the terms back as { reward, discount, keyword, business, cash_cap }.
// Missing tab is not an error: the caller falls back to its own defaults.
function referralTerms() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REFERRAL_TERMS_TAB);
  var out = {};
  if (!tab || tab.getLastRow() < 3) return out;
  var grid = tab.getRange(1, 1, tab.getLastRow(), 2).getValues();
  for (var i = 0; i < grid.length; i++) {
    var key = String(grid[i][0] || '').trim();
    if (REFERRAL_TERM_KEYS.indexOf(key) >= 0 && i > 0) {
      // the key label sits one row under its title row; the value is in B of
      // the title row, matching the call-scripts layout
      out[key] = String(grid[i - 1][1] == null ? '' : grid[i - 1][1]).trim();
    }
  }
  return out;
}

function writeReferralTerms(terms) {
  try {
    var tab = _referralTermsTab();
    var grid = tab.getRange(1, 1, tab.getLastRow(), 1).getValues();
    var saved = 0;
    for (var i = 1; i < grid.length; i++) {
      var key = String(grid[i][0] || '').trim();
      if (REFERRAL_TERM_KEYS.indexOf(key) >= 0 &&
          Object.prototype.hasOwnProperty.call(terms, key)) {
        tab.getRange(i, 2).setValue(_cell(String(terms[key])));
        saved++;
      }
    }
    return { ok: true, saved: saved, terms: referralTerms() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Every referral row, newest last, with its row number for the write-back.
function sheetReferrals() {
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REFERRALS_TAB);
  var out = { ok: true, referrals: [], directory: _referralDirectory(), terms: referralTerms() };
  if (!tab || tab.getLastRow() < 3) return out;
  var count = tab.getLastRow() - 2;
  var grid = tab.getRange(3, 1, count, REFERRAL_HEADERS.length).getValues();
  for (var i = 0; i < count; i++) {
    var r = grid[i];
    if (!String(r[1] || '').trim() && !String(r[5] || '').trim()) continue; // blank row
    out.referrals.push({
      row: i + 3,
      date: _dateStr(r[0]),
      customer: String(r[1] || '').trim(),
      customer_email: String(r[2] || '').trim(),
      customer_phone: String(r[3] || '').trim(),
      job: String(r[4] || '').trim(),
      referrer: String(r[5] || '').trim(),
      referrer_email: String(r[6] || '').trim(),
      reward: Number(r[7] || 0),
      reward_type: String(r[8] || '').trim(),
      status: String(r[9] || '').trim() || 'Pending',
      paid_on: _dateStr(r[10]),
      payment_ref: String(r[11] || '').trim()
    });
  }
  return out;
}

// Everyone who could be named as the referrer: people already in the Leads tab,
// plus anybody who has previously been referred in (today's new customer is next
// year's referrer). Deduped on email, falling back to phone, then name.
function _referralDirectory() {
  var people = [];
  var seen = {};
  function push(name, email, phone, note) {
    name = String(name || '').trim();
    email = String(email || '').trim().toLowerCase();
    phone = String(phone || '').trim();
    if (!name && !email) return;
    var key = email || phone || name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    people.push({ name: name, email: email, phone: phone, note: String(note || '').trim() });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var leads = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (leads && leads.getLastRow() >= 3) {
    var ncols = leads.getLastColumn();
    var labels = leads.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
    var cBiz = labels.indexOf(LABELS.business_name) + 1;
    var cOwner = labels.indexOf(LABELS.owner_name) + 1;
    var cEmail = labels.indexOf(LABELS.email) + 1;
    var cPhone = labels.indexOf(LABELS.phone) + 1;
    var cWhen = labels.indexOf(LABELS.contacted_on) + 1;
    var count = leads.getLastRow() - 2;
    var grid = leads.getRange(3, 1, count, ncols).getValues();
    for (var i = 0; i < count; i++) {
      var row = grid[i];
      function cell(c) { return c ? String(row[c - 1] == null ? '' : row[c - 1]).trim() : ''; }
      var name = cell(cOwner) || cell(cBiz);
      push(name, cell(cEmail), cell(cPhone), cell(cBiz) && cell(cOwner) ? cell(cBiz) : _dateStr(cell(cWhen)));
    }
  }

  var tab = ss.getSheetByName(REFERRALS_TAB);
  if (tab && tab.getLastRow() >= 3) {
    var rcount = tab.getLastRow() - 2;
    var rgrid = tab.getRange(3, 1, rcount, 5).getValues();
    for (var j = 0; j < rcount; j++) {
      push(rgrid[j][1], rgrid[j][2], rgrid[j][3], 'referred ' + _dateStr(rgrid[j][0]));
    }
  }
  return people;
}

// Appends one referral. The caller (dashboard/api/referrals.js) has already
// validated the referrer exists and worked out cash vs credit, because that is
// where the cap and the email templates live.
function addReferral(r) {
  var name = String(r.customer || '').trim();
  var referrer = String(r.referrer || '').trim();
  if (!name) return { ok: false, error: 'the new customer needs a name' };
  if (!referrer) return { ok: false, error: 'no referrer given' };

  var tab = _referralsTab();
  var row = Math.max(tab.getLastRow() + 1, 3);
  if (row > tab.getMaxRows()) tab.insertRowsAfter(tab.getMaxRows(), row - tab.getMaxRows());
  tab.getRange(row, 1, 1, REFERRAL_HEADERS.length).setValues([_safeRow([
    new Date(),
    name,
    String(r.customer_email || '').trim(),
    String(r.customer_phone || '').trim(),
    String(r.job || '').trim(),
    referrer,
    String(r.referrer_email || '').trim(),
    Number(r.reward || 0),
    String(r.reward_type || 'cash'),
    'Pending',
    '',
    ''
  ])]);
  return { ok: true, row: row };
}

// Flips one referral to Paid and stamps the date plus the e-transfer reference,
// which is the line the client's bookkeeper actually needs at year end.
function markReferralPaid(row, paymentRef) {
  row = Number(row);
  if (!row || row < 3) return { ok: false, error: 'bad row' };
  var tab = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REFERRALS_TAB);
  if (!tab) return { ok: false, error: 'no Referrals tab yet' };
  if (row > tab.getLastRow()) return { ok: false, error: 'that referral is not on the sheet' };
  var statusCol = REFERRAL_HEADERS.indexOf('Status') + 1;
  var paidCol = REFERRAL_HEADERS.indexOf('Paid on') + 1;
  var refCol = REFERRAL_HEADERS.indexOf('Payment ref') + 1;
  tab.getRange(row, statusCol).setValue('Paid');
  tab.getRange(row, paidCol).setValue(new Date());
  tab.getRange(row, refCol).setValue(_cell(String(paymentRef || '').trim()));
  return { ok: true, row: row };
}

// Dates come back from the sheet as Date objects or strings depending on how the
// cell was written; the CRM only ever wants YYYY-MM-DD.
function _dateStr(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim().slice(0, 10);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================================
   CUSTOMERS
   A customer is not a second copy of a person. It is a view over people we
   already hold: a lead that reached Won, anybody logged as the new customer on
   a referral, and anybody with a job against their name. Keeping one list of
   people and deriving this view is what stops the same person existing twice
   with two different phone numbers.

   Everything is merged here rather than in the dashboard because Apps Script is
   slow and spiky: one round trip that does the work beats three that stitch it
   together.
   ============================================================================ */

var JOBS_TAB = 'Jobs';
var JOB_HEADERS = ['Date', 'Customer', 'Their email', 'Their phone', 'What the job was', 'Notes'];
var JOB_WIDTHS = [95, 190, 230, 130, 300, 280];

function _jobsTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName(JOBS_TAB);
  if (tab) return tab;
  tab = ss.insertSheet(JOBS_TAB);
  var n = JOB_HEADERS.length;
  tab.getRange(1, 1, 1, n).merge()
    .setValue('Jobs')
    .setFontSize(14).setFontWeight('bold')
    .setBackground('#1a3a6b').setFontColor('#ffffff')
    .setVerticalAlignment('middle');
  tab.setRowHeight(1, 34);
  tab.getRange(2, 1, 1, n).setValues([JOB_HEADERS])
    .setFontWeight('bold').setBackground('#eef2f8').setBorder(null, null, true, null, null, null);
  tab.setFrozenRows(2);
  for (var i = 0; i < n; i++) tab.setColumnWidth(i + 1, JOB_WIDTHS[i]);
  return tab;
}

function addJob(j) {
  var name = String(j.customer || '').trim();
  var what = String(j.job || '').trim();
  if (!name) return { ok: false, error: 'the customer needs a name' };
  if (!what) return { ok: false, error: 'say what the job was' };
  var tab = _jobsTab();
  var row = Math.max(tab.getLastRow() + 1, 3);
  if (row > tab.getMaxRows()) tab.insertRowsAfter(tab.getMaxRows(), row - tab.getMaxRows());
  tab.getRange(row, 1, 1, JOB_HEADERS.length).setValues([_safeRow([
    j.date ? new Date(j.date) : new Date(),
    name,
    String(j.customer_email || '').trim(),
    String(j.customer_phone || '').trim(),
    what,
    String(j.notes || '').trim()
  ])]);
  return { ok: true, row: row };
}

function sheetCustomers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var people = [];
  var byKey = {};

  // Email first, then phone, then a lowered name. Same order the referral
  // directory uses, so the two views can never disagree about who is who.
  function keyFor(email, phone, name) {
    return String(email || '').trim().toLowerCase()
      || String(phone || '').replace(/[^0-9]/g, '')
      || String(name || '').trim().toLowerCase();
  }

  function upsert(name, email, phone, source, when) {
    name = String(name || '').trim();
    email = String(email || '').trim();
    phone = String(phone || '').trim();
    var key = keyFor(email, phone, name);
    if (!key) return null;
    var p = byKey[key];
    if (!p) {
      p = {
        name: name, email: email, phone: phone, source: source || '',
        since: when || '', row: 0,
        last_job: '', last_job_date: '', jobs: 0,
        referred_by: '', sent: 0, owed: 0, earned: 0
      };
      byKey[key] = p;
      people.push(p);
      return p;
    }
    // Fill in blanks from whichever source knows more, never overwrite.
    if (!p.name && name) p.name = name;
    if (!p.email && email) p.email = email;
    if (!p.phone && phone) p.phone = phone;
    if (!p.source && source) p.source = source;
    if (when && (!p.since || String(when) < String(p.since))) p.since = when;
    return p;
  }

  // ---- 1. leads that reached Won ------------------------------------------
  var leads = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (leads && leads.getLastRow() >= 3) {
    var ncols = leads.getLastColumn();
    var labels = leads.getRange(2, 1, 1, ncols).getValues()[0].map(function (v) { return String(v).trim(); });
    var cBiz = labels.indexOf(LABELS.business_name) + 1;
    var cOwner = labels.indexOf(LABELS.owner_name) + 1;
    var cEmail = labels.indexOf(LABELS.email) + 1;
    var cPhone = labels.indexOf(LABELS.phone) + 1;
    var cStatus = labels.indexOf(LABELS.status) + 1;
    var cWhen = labels.indexOf(LABELS.contacted_on) + 1;
    var count = leads.getLastRow() - 2;
    var grid = leads.getRange(3, 1, count, ncols).getValues();
    for (var i = 0; i < count; i++) {
      var r = grid[i];
      function cell(c) { return c ? String(r[c - 1] == null ? '' : r[c - 1]).trim() : ''; }
      if (cell(cStatus).toLowerCase() !== 'won') continue;
      var p = upsert(cell(cOwner) || cell(cBiz), cell(cEmail), cell(cPhone), 'Outreach', _dateStr(cell(cWhen)));
      if (p) p.row = i + 3;
    }
  }

  // ---- 2. people who came in on a referral --------------------------------
  var refs = ss.getSheetByName(REFERRALS_TAB);
  if (refs && refs.getLastRow() >= 3) {
    var rcount = refs.getLastRow() - 2;
    var rgrid = refs.getRange(3, 1, rcount, REFERRAL_HEADERS.length).getValues();
    for (var j = 0; j < rcount; j++) {
      var rr = rgrid[j];
      var newName = String(rr[1] || '').trim();
      if (!newName) continue;
      var when = _dateStr(rr[0]);
      var cust = upsert(newName, rr[2], rr[3], 'Referral', when);
      if (cust) {
        cust.referred_by = String(rr[5] || '').trim();
        // The referral row records the job they came in for, so it counts.
        var job = String(rr[4] || '').trim();
        if (job && (!cust.last_job_date || when >= cust.last_job_date)) {
          cust.last_job = job; cust.last_job_date = when;
        }
        if (job) cust.jobs += 1;
      }
      // Whoever sent them belongs in this view too, and gets added if they are
      // not here already. Somebody can send you work without ever having bought
      // from you, and leaving them out would under-report the money owed, which
      // is the one number on this screen that has to be right.
      var sender = upsert(String(rr[5] || '').trim(), rr[6], '', 'Referrer', when);
      if (sender) {
        sender.sent += 1;
        var amount = Number(rr[7] || 0);
        var status = String(rr[9] || '').trim().toLowerCase();
        if (status === 'paid') sender.earned += amount;
        else if (status !== 'void') sender.owed += amount;
      }
    }
  }

  // ---- 3. logged jobs ------------------------------------------------------
  var jobs = ss.getSheetByName(JOBS_TAB);
  if (jobs && jobs.getLastRow() >= 3) {
    var jcount = jobs.getLastRow() - 2;
    var jgrid = jobs.getRange(3, 1, jcount, JOB_HEADERS.length).getValues();
    for (var k = 0; k < jcount; k++) {
      var jr = jgrid[k];
      var jname = String(jr[1] || '').trim();
      if (!jname) continue;
      var jwhen = _dateStr(jr[0]);
      var who = upsert(jname, jr[2], jr[3], 'Added', jwhen);
      if (!who) continue;
      who.jobs += 1;
      if (!who.last_job_date || jwhen >= who.last_job_date) {
        who.last_job = String(jr[4] || '').trim();
        who.last_job_date = jwhen;
      }
    }
  }

  return { ok: true, customers: people };
}


// Appends scraped businesses, skipping any already in the sheet.
//
// Matching is on business name plus city, because the same trade name turns up
// in more than one town and two rows for one business is worse than a missing
// one. Columns are located by their header text, exactly like the readers do,
// so a re-ordered sheet still fills correctly.
function addLeads(leads) {
  if (!leads.length) return { ok: true, added: 0, skipped: 0 };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];

  var ncols = sheet.getLastColumn();
  var labels = sheet.getRange(2, 1, 1, ncols).getValues()[0]
    .map(function (v) { return String(v).trim(); });
  function col(key) { return labels.indexOf(LABELS[key]) + 1; }

  var bizCol = col('business_name');
  var cityCol = col('city');
  if (bizCol < 1) return { ok: false, error: 'no Business column found' };

  // What is already here, so a repeated search does not duplicate anybody.
  var lastRow = sheet.getLastRow();
  var seen = {};
  if (lastRow > 2) {
    var existing = sheet.getRange(3, 1, lastRow - 2, ncols).getValues();
    for (var i = 0; i < existing.length; i++) {
      var name = String(existing[i][bizCol - 1] || '').trim().toLowerCase();
      var town = cityCol > 0 ? String(existing[i][cityCol - 1] || '').trim().toLowerCase() : '';
      if (name) seen[name + '|' + town] = true;
    }
  }

  var rows = [], added = 0, skipped = 0;
  for (var j = 0; j < leads.length; j++) {
    var l = leads[j] || {};
    var key = String(l.business || '').trim().toLowerCase() + '|' +
              String(l.city || '').trim().toLowerCase();
    if (!l.business || seen[key]) { skipped++; continue; }
    seen[key] = true;

    var row = new Array(ncols).fill('');
    function put(key, value) {
      var c = col(key);
      if (c > 0 && value !== undefined && value !== null && value !== '') row[c - 1] = _cell(value);
    }
    put('business_name', l.business);
    put('category', l.category);
    put('phone', l.phone);
    put('email', l.email);
    put('website', l.website);
    put('website_status', l.website_status);
    put('rating', l.rating);
    put('reviews', l.reviews);
    put('address', l.address);
    put('city', l.city);
    put('postal_code', l.postal_code);
    put('google_maps_url', l.google_maps_url);
    put('why_reach_out', l.why_reach_out);
    put('status', 'New');
    rows.push(row);
    added++;
  }

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ncols).setValues(rows);
  }
  return { ok: true, added: added, skipped: skipped };
}


// Copy an older scrape that lives in its own tab into the live Leads tab, so it
// shows up in the CRM and can be filtered by city. Dedupe comes from addLeads,
// so running this twice is harmless.
//
//   importArchiveTab('Manchester (archive)', false)  // report what it would do
//   importArchiveTab('Manchester (archive)', true)   // write the rows
function importArchiveTab(tabName, commit) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(tabName);
  if (!src) return { ok: false, error: 'no tab named ' + tabName };

  var range = src.getDataRange();
  var values = range.getValues();
  // Hyperlinked cells (the Google Maps column) read as their link text, so
  // pull the underlying URL out of the rich text instead.
  var rich = range.getRichTextValues();
  var headerRow = -1;
  for (var r = 0; r < Math.min(4, values.length); r++) {
    if (values[r].join('|').toLowerCase().indexOf('business') > -1) { headerRow = r; break; }
  }
  if (headerRow < 0) return { ok: false, error: 'no header row with a Business column' };

  var head = values[headerRow].map(function (v) { return String(v).trim(); });
  var map = {
    business: 'Business', category: 'Category', phone: 'Phone', email: 'Email',
    why_reach_out: 'Why reach out', website: 'Website', website_status: 'Site status',
    rating: 'Rating', reviews: 'Reviews', address: 'Address', city: 'City',
    postal_code: 'Postal', google_maps_url: 'Google Maps'
  };

  var leads = [], keys = Object.keys(map);
  for (var i = headerRow + 1; i < values.length; i++) {
    var row = values[i], lead = {};
    for (var k = 0; k < keys.length; k++) {
      var c = head.indexOf(map[keys[k]]);
      var cell = c > -1 ? String(row[c] === null ? '' : row[c]).trim() : '';
      if (c > -1 && cell) {
        var link = rich[i][c] ? rich[i][c].getLinkUrl() : null;
        if (link) cell = link;
      }
      lead[keys[k]] = cell;
    }
    if (!lead.business) continue;
    if (!lead.city) lead.city = tabName.replace(/\s*\(archive\)\s*/i, '').trim();
    leads.push(lead);
  }

  if (!commit) return { ok: true, dryRun: true, found: leads.length, sample: leads.slice(0, 2) };
  var result = addLeads(leads);
  result.found = leads.length;
  return result;
}

function previewManchester() {
  Logger.log(JSON.stringify(importArchiveTab('Manchester (archive)', false)));
}

function importManchester() {
  Logger.log(JSON.stringify(importArchiveTab('Manchester (archive)', true)));
}
