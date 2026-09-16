// Tracked links. Every outreach email carries one link, the video, and a DM or
// a text can carry it too. goUrl turns it into https://<this crm>/go/<code>,
// one code per lead, so the moment a business opens it the open lands on that
// lead's timeline (api/go.js does the redirect and the logging).
//
// The code is a hash of who the lead is, not a lookup in a table, so the page
// can show it without asking the server and api/go.js can find the lead again
// by hashing the saved leads. The same function, character for character,
// lives in crm-close.html as goCodeFor: change one and change the other.

export function goIdentity(lead) {
  const email = String((lead && lead.email) || "").trim().toLowerCase();
  if (email) return email;
  const business = String((lead && lead.business) || "").trim().toLowerCase();
  const city = String((lead && lead.city) || "").trim().toLowerCase();
  return business ? business + "|" + city : "";
}

// FNV-1a over the identity, in base 36, padded to seven characters.
export function goCode(lead) {
  const s = goIdentity(lead);
  if (!s) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

export function goUrl(host, lead) {
  const code = goCode(lead);
  const h = String(host || "").split(",")[0].trim();
  if (!code || !h) return "";
  return "https://" + h + "/go/" + code;
}
