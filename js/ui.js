/* Small UI helpers shared by every view: DOM building, icons, toasts, formats, storage. */

import { ICONS } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* h("div", {class: "x", onclick}, "text", child, [more]) builds an element. Text is
   always set as text, never as HTML. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/* An icon from icons.js (trusted, static markup). */
export function ic(name, cls = "i") {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

/* ---------- storage that never throws (private mode, blocked site data) ---------- */
export function store(area, key, value) {
  try {
    const s = window[area + "Storage"];
    if (value === undefined) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}
export function recall(area, key) {
  try { return JSON.parse(window[area + "Storage"].getItem(key)); } catch (e) { return null; }
}

/* ---------- formats ---------- */
const OFFSET_H = 8;   // date-only Lark fields are midnight Manila time
export const fmt = {
  money: (v, cur) => `${cur ? cur + " " : ""}${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  peso: (v) => "₱" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pesoShort(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return "₱" + (v / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
    if (a >= 1e6) return "₱" + (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return "₱" + Math.round(v / 1e3) + "K";
    return "₱" + Math.round(v);
  },
  day: (ms) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""),
  dayOnly: (ms) => (ms ? new Date(ms + OFFSET_H * 3600000)
    .toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : ""),
  time: (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  duration(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
  },
};

/* ---------- toasts ----------
   Results answer right away; success fades after a few seconds, errors stay until
   dismissed. An action (Undo, View, Try again) closes the toast and runs. */
export function toast(message, { type = "info", detail, action, onAction, link, timeout } = {}) {
  const box = $("#toasts");
  const icon = { success: "check", error: "alert", warn: "alert" }[type];
  const body = h("div", { class: "toast-body" }, h("p", { class: "toast-msg" }, message),
                 detail ? h("p", { class: "toast-detail" }, detail) : null);
  const el = h("div", { class: `toast toast-${type} is-entering`, role: type === "error" ? "alert" : "status" },
               icon ? ic(icon, "i toast-icon") : null, body);
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), reduceMotion() ? 0 : 180);
  };
  if (link) body.append(h("a", { class: "toast-link", href: link.href, target: "_blank", rel: "noopener" }, link.text));
  if (action) el.append(h("button", { type: "button", class: "toast-action", onclick: () => { close(); onAction && onAction(); } }, action));
  el.append(h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onclick: close }, ic("x")));
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  const ms = timeout !== undefined ? timeout : type === "error" ? 0 : action ? 8000 : 4500;
  if (ms) setTimeout(close, ms);
  setTimeout(() => el.classList.remove("is-entering"), 400);
  return close;
}

/* Put text on the clipboard; works on http://127.0.0.1 and https pages, with an
   older fallback for in-app browsers. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = h("textarea", { style: "position:fixed;opacity:0;top:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  return ok;
}

/* A request number you can click to copy. */
export function copyable(text) {
  if (!text) return h("b", null, "?");
  return h("button", { type: "button", class: "copy", title: "Copy request number", onclick: async (e) => {
    e.stopPropagation();
    const ok = await copyText(text);
    toast(ok ? `Copied ${text}.` : `Couldn't copy. Select ${text} and copy it by hand.`, { type: ok ? "success" : "error", timeout: ok ? 2200 : 0 });
  } }, text);
}

/* A short-lived highlight on something that just arrived ("is-new" fades out in CSS). */
export function flash(el) {
  if (!el) return;
  el.classList.remove("is-new");
  void el.offsetWidth;   // restart the animation
  el.classList.add("is-new");
  setTimeout(() => el.classList.remove("is-new"), 3200);
}
