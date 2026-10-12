/* Lark access for the Node checks: an app (tenant) token minted through the
   proxy, then direct HTTPS calls (CORS only applies to browsers). Gives the same
   `call(method, url, body)` shape the page uses, so ops.js runs unchanged. */

import { TABLE_LINKS } from "../js/config.js";
import { parseBaseLink, OPEN_API } from "../js/ops.js";

const PROXY = process.env.LARK_PROXY || "https://lark-proxy-dwiw.onrender.com";

export async function tenantToken() {
  const url = `${OPEN_API}/auth/v3/tenant_access_token/internal`;
  const res = await fetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const j = await res.json();
  if (j.code !== 0 || !j.tenant_access_token) throw new Error(`Couldn't get a tenant token: ${JSON.stringify(j)}`);
  return j.tenant_access_token;
}

export function makeCall(token) {
  return async function call(method, url, body) {
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`); }
    if (Number(j.code) !== 0) {
      const e = new Error(`Lark ${j.code}: ${j.msg}`);
      e.json = j;
      throw e;
    }
    return j;
  };
}

/* The ANDON test Base only opens for users, not for the Lark app this token
   belongs to, so the Node checks leave it out (it's checked in the browser). */
export const tables = () => Object.fromEntries(
  Object.entries(TABLE_LINKS).filter(([k]) => k !== "andon").map(([k, link]) => [k, parseBaseLink(link)]));
