/* Pure rules for the connection service (no DOM, no network): which addresses
   count as local, which addresses an override may use, and whether the Lark proxy's
   `GET /` answer means it's awake and recent enough. net.js does the talking. */

export const isLocalHostname = (name) => /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(name);

/* An override address: https, or http on this computer. */
export function isServiceUrl(text) {
  try {
    const u = new URL(String(text).trim());
    return u.protocol === "https:" || (u.protocol === "http:" && isLocalHostname(u.hostname));
  } catch (e) { return false; }
}

/* "1.4.0" vs "1.10.0": negative, 0 or positive. Missing parts count as 0. */
export function cmpVersion(a, b) {
  const part = (v) => String(v || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
  const x = part(a), y = part(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* Judge the JSON a service answered `GET /` with. `expect` = {service, min, headers}.
     "wrong"    it isn't this service (a wrong address, or Render's "starting" page)
     "outdated" it reports a version below `min`, or its CORS list lacks a header we send
     "awake"    otherwise (a proxy that reports no version yet counts as awake)
   Returns {state, version, detail}. */
export function serviceVerdict(info, expect) {
  if (!info || typeof info !== "object" || info.service !== expect.service) {
    return { state: "wrong", version: "", detail: "" };
  }
  const version = typeof info.version === "string" ? info.version : "";
  if (version && expect.min && cmpVersion(version, expect.min) < 0) {
    return { state: "outdated", version, detail: `v${version.replace(/^v/i, "")}, needs ${expect.min}` };
  }
  const allowed = info.cors && Array.isArray(info.cors.allow_headers) ? info.cors.allow_headers.map(x => String(x).toLowerCase()) : null;
  const lacking = allowed ? (expect.headers || []).find(x => !allowed.includes(x.toLowerCase())) : null;
  if (lacking) return { state: "outdated", version, detail: `${version ? `v${version.replace(/^v/i, "")}, ` : ""}it doesn't allow ${lacking}` };
  return { state: "awake", version, detail: "" };
}
