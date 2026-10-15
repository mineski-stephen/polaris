/* Talking to Lark through the CORS proxy (tech/lark-proxy, hosted on Render).

   - The proxy sleeps when idle, so it's woken on page load and reads are retried
     while it starts. Writes are never retried automatically.
   - Two instant network failures while online almost always mean an ad blocker
     or privacy extension; that's reported plainly with the host to allow.
   - A different proxy address is a developer override: it only applies on
     localhost and is always shown while active. */

import { sleep } from "./ui.js";

export const HOSTED_PROXY = "https://lark-proxy-dwiw.onrender.com";
const OVERRIDE_KEY = "polaris.proxyOverride";

export const isLocalPage = () => /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname);

export function proxyOverride() {
  if (!isLocalPage()) return "";
  try { return localStorage.getItem(OVERRIDE_KEY) || ""; } catch (e) { return ""; }
}
export function setProxyOverride(url) {
  try {
    if (url) localStorage.setItem(OVERRIDE_KEY, url); else localStorage.removeItem(OVERRIDE_KEY);
  } catch (e) {}
}
export const proxyBase = () => (proxyOverride() || HOSTED_PROXY).replace(/\/+$/, "");
export const proxyHost = () => { try { return new URL(proxyBase()).host; } catch (e) { return proxyBase(); } };
export const viaProxy = (url) => `${proxyBase()}/proxy?url=${encodeURIComponent(url)}`;

export class LarkError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/* ---------- connection state (shown in Settings and in load errors) ---------- */
export const conn = { proxy: "unknown", blocked: false, detail: "", checkedAt: 0 };
const listeners = new Set();
export const onConn = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function setConn(patch) {
  Object.assign(conn, patch, { checkedAt: Date.now() });
  listeners.forEach(fn => fn(conn));
}

/* `timeout` (ms) gives up on a request that never answers (a stuck connection
   to a sleeping proxy can otherwise wait forever). Only for calls where giving
   up is safe: reads, wake-up pings and the login code exchange, not writes. */
let quickFails = 0;
async function send(url, init, timeout = 0) {
  const started = performance.now();
  const ctl = timeout ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
    quickFails = 0;
    return res;
  } catch (e) {
    if (performance.now() - started < 600 && navigator.onLine !== false && ++quickFails >= 2) {
      setConn({ proxy: "down", blocked: true, detail: "blocked by this browser" });
    }
    throw new LarkError(ctl && ctl.signal.aborted ? "no answer in time" : e.message, { network: true });
  } finally {
    clearTimeout(timer);
  }
}

/* One Lark call through the proxy. Resolves with the JSON body; throws LarkError
   carrying {network | status, json | raw}. `read` calls are retried while the
   proxy wakes up (and once after a rate limit). */
export async function lark(method, url, { token, body, read = false, timeout = 0 } = {}) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = "Bearer " + token;
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body || {});
  }
  const waits = read ? [1500, 3000, 6000, 12000, 20000] : [];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await send(viaProxy(url), init, timeout);
    } catch (e) {
      if (conn.blocked || attempt >= waits.length) throw e;
      setConn({ proxy: "waking", detail: "" });
      await sleep(waits[attempt]);
      continue;
    }
    if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < waits.length) {
      setConn({ proxy: "waking", detail: "" });
      await sleep(waits[attempt]);
      continue;
    }
    if (conn.proxy !== "awake") setConn({ proxy: "awake", blocked: false, detail: "" });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!json || typeof json !== "object") {
      throw new LarkError(`HTTP ${res.status}, not JSON`, { status: res.status, raw: text.slice(0, 2000) });
    }
    // Lark reports failures in the body (code ≠ 0); bodies without a code are the proxy's own.
    const ok = json.code !== undefined ? Number(json.code) === 0 : !json.error;
    if (ok) return json;
    if (read && [1254290, 99991400].includes(Number(json.code)) && attempt < 2) { await sleep(1200); continue; }
    throw new LarkError("Lark error", { status: res.status, json });
  }
}

/* Upload a file as an attachment for a Base (Lark's drive "upload_all", through the
   proxy as multipart). Resolves with the file_token to put in an attachment field.
   The proxy accepts up to 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export async function uploadToBase(file, appToken, token) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new LarkError("too large", { json: { code: -1, msg: `${file.name} is over 10 MB, the most the connection service takes. Compress it first.` } });
  }
  const fd = new FormData();
  fd.append("file_name", file.name);
  fd.append("parent_type", "bitable_file");
  fd.append("parent_node", appToken);
  fd.append("size", String(file.size));
  fd.append("file", file, file.name);
  const res = await send(viaProxy("https://open.larksuite.com/open-apis/drive/v1/medias/upload_all"),
                         { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (e) {}
  if (!json || Number(json.code) !== 0 || !json.data || !json.data.file_token) {
    throw new LarkError("upload failed", json ? { status: res.status, json } : { status: res.status, raw: "" });
  }
  return json.data.file_token;
}

/* Wake the proxy (free Render instances sleep). Resolves true once it answers,
   false if it stays unreachable for about three minutes. Pings "/" because
   blockers list paths like /health on onrender.com. */
let waking = null;
export function wake() {
  if (conn.proxy === "awake" && Date.now() - conn.checkedAt < 60000) return Promise.resolve(true);
  if (waking) return waking;
  waking = (async () => {
    const until = Date.now() + 180000;
    let wait = 2000;
    const slow = setTimeout(() => conn.proxy !== "awake" && setConn({ proxy: "waking", detail: "" }), 1200);
    try {
      for (;;) {
        try {
          const res = await send(proxyBase() + "/", { method: "GET" }, 20000);
          if (res.ok) { setConn({ proxy: "awake", blocked: false, detail: "" }); return true; }
          if (res.status < 500) { setConn({ proxy: "down", detail: `answered HTTP ${res.status}` }); return false; }
        } catch (e) {
          if (conn.blocked) return false;
        }
        if (Date.now() > until) { setConn({ proxy: "down", detail: "no answer for 3 minutes" }); return false; }
        setConn({ proxy: "waking", detail: "" });
        await sleep(wait);
        wait = Math.min(wait * 1.6, 15000);
      }
    } finally {
      clearTimeout(slow);
      waking = null;
    }
  })();
  return waking;
}

/* Turn a failure into one plain sentence: what happened, and what to do. */
export function describe(err) {
  if (!err) return "Something went wrong. Try again.";
  if (err.name === "AlreadyDone") return err.message;
  if (conn.blocked) {
    return `Your browser is blocking ${proxyHost()}, probably an ad blocker or privacy extension. ` +
           "Allow that site (or pause the blocker on this page), then reload.";
  }
  if (err.network) {
    return `Polaris can't reach its connection service (${proxyHost()}). It may still be waking up; ` +
           "try again in a moment.";
  }
  const j = err.json || {};
  const code = Number(j.code);
  if (j.code === undefined && j.error === "not found") {
    return "The connection service doesn't support Lark login. Check the proxy address in Settings.";
  }
  switch (code) {
    case 20003: case 20004: case 20065: return "That login code expired or was already used. Log in again.";
    case 20049: return "The login check failed, probably because it started in another tab. Log in again.";
    case 20071: return "The login came back to a different address than it started from. Log in again.";
    case 20010: return "Your Lark account isn't allowed to use this app yet. Ask the app admin to add you.";
    case 20005: case 99991668: case 99991677: return "Your login has ended. Log in again.";
    case 99991679: return "Your login is missing a permission this needs. Log out, then log in again.";
    case 91403: return "Lark says your account can't open or edit this Base. Ask its owner for edit access.";
    case 91402: case 1254003: case 1254040: return "A Base in js/config.js wasn't found. Check the table links.";
    case 1254004: case 1254041: return "A table in js/config.js wasn't found. Check the table links.";
    case 1254045: return `A column Polaris uses doesn't exist: ${j.msg}`;
    case 1254006: case 1254043: return "That record no longer exists. Refresh the list.";
    case 1254291: return "Lark is busy writing to this table. Wait a moment and try again.";
    case 1254290: case 99991400: return "Lark is getting too many requests. Wait a moment and try again.";
  }
  if (code >= 1254060 && code <= 1254068) return `A value didn't fit its column in Lark: ${j.msg}`;
  if (/syncTable|ConnectorSyncTable/i.test(j.msg || "")) {
    return "This table is a synced copy of another table, so Lark won't let anyone add or change its rows. " +
           "Point Polaris at the table it's synced from (js/config.js).";
  }
  if (err.raw !== undefined) return `The connection service answered with an error (HTTP ${err.status}). Try again.`;
  const msg = j.error_description || j.msg || j.error || err.message;
  return `Lark said: ${msg}${Number.isNaN(code) ? "" : ` (code ${code})`}`;
}

export const isDeadToken = (err) => !!(err && err.json && [20005, 99991668, 99991677].includes(Number(err.json.code)));
