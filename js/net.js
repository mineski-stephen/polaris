/* Talking to Lark through the CORS proxy (tech/lark-proxy, hosted on Render).

   - The proxy sleeps when idle, so it's woken on page load and reads are retried
     while it starts. Writes are never retried automatically.
   - Reads time out after 60 s, writes after 120 s, uploads after 180 s. A write
     that times out, or fails on the network, may still have landed: it throws an
     `uncertain` error and is never reported as "nothing was written".
   - Two instant network failures while online almost always mean an ad blocker
     or privacy extension; that's reported plainly with the host to allow.
   - A login Lark says is over (a dead-token code) is detected here, once, for
     every call: the handler set with onDeadToken() ends the session, and the
     call still throws (err.deadToken) so callers can roll back first.
   - A different proxy address is a developer override (settings.js): it only
     applies on localhost and is always shown while active. */

import { sleep } from "./ui.js";
import { APP, SERVICES, LARK } from "./config.js";
import { larkUrl } from "./settings.js";
import { serviceVerdict } from "./service.js";
import {
  LarkError, DEAD_TOKEN_CODES, isDeadToken, describeLark, uploadSizeProblem, uploadEntries, uploadToken,
} from "./errors.js";

export { LarkError, isDeadToken, isUncertain } from "./errors.js";

export const READ_TIMEOUT_MS = 60000;
export const WRITE_TIMEOUT_MS = 120000;
export const UPLOAD_TIMEOUT_MS = 180000;

export const proxyBase = larkUrl;
export const proxyHost = () => { try { return new URL(proxyBase()).host; } catch (e) { return proxyBase(); } };
export const viaProxy = (url) => `${proxyBase()}/proxy?url=${encodeURIComponent(url)}`;

/* ---------- connection state (shown in Settings and in load errors) ---------- */
// proxy: unknown | waking | awake | down | outdated
export const conn = { proxy: "unknown", blocked: false, detail: "", version: "", checkedAt: 0 };
const listeners = new Set();
export const onConn = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function setConn(patch) {
  Object.assign(conn, patch, { checkedAt: Date.now() });
  listeners.forEach(fn => fn(conn));
}

let deadHandler = null;
export const onDeadToken = (fn) => { deadHandler = fn; };
function flagDead(err, token) {
  if (token && isDeadToken(err)) { err.deadToken = true; if (deadHandler) deadHandler(err); }
  return err;
}

/* Two thrown errors within 600 ms while online: probably a blocker. HTTP answers never count. */
let quickFails = 0;
function failed(started) {
  if (performance.now() - started < 600 && navigator.onLine !== false && ++quickFails >= 2) {
    setConn({ proxy: "down", blocked: true, detail: "blocked by this browser" });
  }
}

/* `timeout` (ms) gives up on a request that never answers (a stuck connection
   to a sleeping proxy can otherwise wait forever). `write`: the request may have
   landed when it fails, so the error says so (and a blocked request, which never
   left, doesn't). */
async function send(url, init, timeout = 0, write = false) {
  const started = performance.now();
  const ctl = timeout ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
    quickFails = 0;
    return res;
  } catch (e) {
    const timedOut = !!(ctl && ctl.signal.aborted);
    failed(started);
    throw new LarkError(timedOut ? "no answer in time" : e.message, { network: true, timedOut, uncertain: write && !conn.blocked });
  } finally {
    clearTimeout(timer);
  }
}

/* One Lark call through the proxy. Resolves with the JSON body; throws LarkError
   carrying {network | status, json | raw, uncertain, deadToken}. `read` calls are
   retried while the proxy wakes up (and twice after a rate limit); `write` calls
   never are. Without a `timeout`: 60 s for reads, 120 s for writes. */
export async function lark(method, url, { token, body, read = false, write = false, timeout } = {}) {
  const init = { method, headers: {}, cache: "no-store" };
  if (token) init.headers.Authorization = "Bearer " + token;
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(body || {});
  }
  if (timeout === undefined) timeout = write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const waits = read ? [1500, 3000, 6000, 12000, 20000] : [];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await send(viaProxy(url), init, timeout, write);
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
    if (conn.proxy !== "awake" && conn.proxy !== "outdated") setConn({ proxy: "awake", blocked: false, detail: "" });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!json || typeof json !== "object") {
      throw new LarkError(`HTTP ${res.status}, not JSON`, { status: res.status, raw: text.slice(0, 2000), uncertain: write });
    }
    // Lark reports failures in the body (code ≠ 0); bodies without a code are the proxy's own.
    const ok = json.code !== undefined ? Number(json.code) === 0 : !json.error;
    if (ok) return json;
    if (read && [1254290, 99991400].includes(Number(json.code)) && attempt < 2) { await sleep(1200); continue; }
    throw flagDead(new LarkError("Lark error", { status: res.status, json, uncertain: write && json.code === undefined && res.status >= 500 }), token);
  }
}

/* Upload a file as an attachment for a Base (Lark's drive "upload_all", through the
   proxy as multipart). Resolves with the file_token to put in an attachment field.
   XHR, not fetch, so the page can show progress: onProgress(0..1). Gives up after
   180 s. Never retried; a failed upload writes nothing, so a retry is safe. */
export function uploadToBase(file, table, token, { onProgress, timeout = UPLOAD_TIMEOUT_MS } = {}) {
  const tooBig = uploadSizeProblem(file, LARK.maxUploadMb);
  if (tooBig) return Promise.reject(new LarkError("too large", { userMessage: tooBig }));
  const fd = new FormData();
  for (const [k, v] of uploadEntries(file, table)) fd.append(k, v);
  fd.append("file", file, file.name);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open("POST", viaProxy(`${LARK.api}/drive/v1/medias/upload_all`));
    xhr.timeout = timeout;
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      quickFails = 0;
      try { resolve(uploadToken(xhr.status, xhr.responseText, file.name)); } catch (e) { reject(flagDead(e, token)); }
    };
    xhr.onerror = () => { failed(started); reject(new LarkError("network error", { network: true })); };
    xhr.ontimeout = () => reject(new LarkError("no answer in time", { network: true, timedOut: true }));
    xhr.send(fd);
  });
}

/* Download an attachment's bytes from Lark through the proxy (it passes them through
   as they are). Resolves with a Blob; Lark answering with JSON instead (an error, or
   a file it won't hand over) throws a LarkError with that JSON. A read: safe to retry. */
export async function downloadFromBase(url, token, { timeout = UPLOAD_TIMEOUT_MS } = {}) {
  const res = await send(viaProxy(url), { method: "GET", headers: { Authorization: "Bearer " + token }, cache: "no-store" }, timeout);
  const type = res.headers.get("content-type") || "";
  if (res.ok && !/json/i.test(type)) return res.blob();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  throw flagDead(new LarkError(json ? "Lark error" : `HTTP ${res.status}, not a file`,
    { status: res.status, json: json || undefined, raw: json ? undefined : text.slice(0, 2000) }), token);
}

/* Wake the proxy (free Render instances sleep). Resolves true once it answers as the
   Lark proxy, false if it stays unreachable for about three minutes, or answers but
   is out of date (conn.proxy says which). Pings "/" because blockers list paths like
   /health on onrender.com. "Awake" is strict: JSON naming the service (Render's
   "starting" page and a wrong address aren't). */
let waking = null;
export function wake() {
  if (Date.now() - conn.checkedAt < 60000 && (conn.proxy === "awake" || conn.proxy === "outdated")) {
    return Promise.resolve(conn.proxy === "awake");
  }
  if (waking) return waking;
  waking = (async () => {
    const until = Date.now() + 180000;
    let wait = 2000;
    const slow = setTimeout(() => conn.proxy !== "awake" && setConn({ proxy: "waking", detail: "" }), 1200);
    try {
      for (;;) {
        try {
          const res = await send(proxyBase() + "/", { method: "GET", cache: "no-store" }, 20000);
          let info = null;
          try { info = await res.json(); } catch (e) {}
          const v = serviceVerdict(info, SERVICES.lark);
          if (res.ok && v.state !== "wrong") {
            setConn({ proxy: v.state, blocked: false, detail: v.detail, version: v.version });
            return v.state === "awake";
          }
          if (res.ok && info && typeof info === "object" && info.service) {
            setConn({ proxy: "down", detail: "that address isn't the connection service" });
            return false;
          }
          if (res.status >= 400 && res.status < 500) { setConn({ proxy: "down", detail: `answered HTTP ${res.status}` }); return false; }
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

/* The error for a proxy that never woke (or is out of date), for load errors. */
export const unreachable = () => (conn.proxy === "outdated"
  ? new LarkError("outdated", { outdated: true, detail: conn.detail })
  : new LarkError("unreachable", { network: true }));

/* Turn a failure into one plain sentence: what happened, and what to do. */
export const describe = (err) => describeLark(err, {
  app: APP.name, host: proxyHost(), blocked: conn.blocked,
  address: location.origin + location.pathname.replace(/index\.html?$/i, ""),
});

export { DEAD_TOKEN_CODES };
