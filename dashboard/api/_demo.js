// Figure helpers this copy does not use.
//
// Every export here answers empty and isDemo() is always false, so every
// caller takes its real path and the CRM shows only what is in your database.
// The exports stay because other files import them. Do not put invented
// numbers here: a CRM that makes figures up is worth nothing to the person
// working from it.
export function isDemo() {
  return false;
}

export const DEMO_MAILBOXES = [];
export const DEMO_DAILY_CEILING = 0;
export const DEMO_REPLY_RATE = 0;
export const DEMO_BOOK_RATE = 0;
export const DEMO_CLOSE_RATE = 0;
export const SEQUENCE_AVG_EMAILS = 0;
export const RATES = {};
export const CALL_WORDS = [];
export const COVERAGE_MEASURED = { total: 0, email: 0, phone: 0, social: 0, instagram: 0, facebook: 0, phone_only: 0 };

export function demoFunnel() { return null; }
export function applyDemoStatuses(leads) { return leads; }
export function demoEmailsFor() { return []; }
export function demoSalesFor() { return []; }
export function replyChannel() { return ""; }

/* Counts real contact coverage off your own list. This one is not demo-only:
   the channel screens use it to say how many of your leads each channel can
   actually reach. */
export function coverageOf(leads) {
  const rows = Array.isArray(leads) ? leads : [];
  const has = (v) => !!String(v || "").trim();
  let email = 0, phone = 0, social = 0, instagram = 0, facebook = 0, phoneOnly = 0;
  for (const l of rows) {
    const e = has(l.email), p = has(l.phone);
    const ig = has(l.instagram), fb = has(l.facebook);
    if (e) email++;
    if (p) phone++;
    if (ig) instagram++;
    if (fb) facebook++;
    if (ig || fb) social++;
    if (p && !e) phoneOnly++;
  }
  return { total: rows.length, email, phone, social, instagram, facebook, phone_only: phoneOnly };
}

export async function demoCustomerCount() { return 0; }
export async function demoCustomerMix() { return null; }
