/* Polaris-only UI helpers, built on the shared ui.js (which stays an unedited copy
   of design-ref): Lark date-only days, the date field, and sentences with their
   request numbers and project codes made copyable. */

import { h, ic, copyable } from "./ui.js";
import { parseDay } from "./sync.js";

const OFFSET_H = 8;   // date-only Lark fields are midnight Manila time

/* A Lark date-only value as "Oct 14, 2026" (the Manila day, wherever the browser is). */
export const dayOnly = (ms) => (ms ? new Date(ms + OFFSET_H * 3600000)
  .toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "");

/* ---------- date fields ----------
   Type a date (2026-10-14, 10/14/2026, Oct 14 2026…) or double-click (or tap the
   calendar button) for the browser's date picker. Values are ms at midnight
   Manila, Lark's date-only format. onChange(ms | null, ok): null when empty;
   ok is false while the text isn't a date. */
const toPicker = (ms) => (ms ? new Date(ms + OFFSET_H * 3600000).toISOString().slice(0, 10) : "");
export function dateField({ id, value = null, onChange = () => {} }) {
  const text = h("input", { type: "text", id, autocomplete: "off", spellcheck: "false", placeholder: "e.g. Oct 14, 2026",
                            title: "Type a date, or double-click to pick one" });
  const pick = h("input", { type: "date", class: "date-pick", tabindex: "-1", "aria-hidden": "true" });
  const btn = h("button", { type: "button", class: "date-btn", "aria-label": "Pick a date", title: "Pick a date" }, ic("calendar"));
  const wrap = h("div", { class: "date-field" }, text, btn, pick);
  let current = value;
  const show = (ms) => { text.value = ms ? dayOnly(ms) : ""; pick.value = toPicker(ms); };
  const set = (ms, ok) => {
    current = ok ? ms : current;
    wrap.classList.toggle("is-bad", !ok);
    text.setAttribute("aria-invalid", String(!ok));
    onChange(ok ? ms : current, ok);
  };
  const open = () => {
    pick.value = toPicker(current);
    try { pick.showPicker(); } catch (e) { pick.focus(); pick.click(); }
  };
  text.addEventListener("dblclick", (e) => { e.preventDefault(); open(); });
  btn.addEventListener("click", open);
  text.addEventListener("input", () => {
    const ms = parseDay(text.value, OFFSET_H);
    set(Number.isNaN(ms) ? current : ms, !Number.isNaN(ms));
  });
  text.addEventListener("blur", () => { if (!wrap.classList.contains("is-bad")) show(current); });
  pick.addEventListener("change", () => {
    const ms = pick.value ? Date.parse(pick.value + "T00:00:00Z") - OFFSET_H * 3600000 : null;
    show(ms);
    set(ms, true);
    text.focus();
  });
  show(value);
  return wrap;
}

/* A sentence with every request number and project code in it made copyable,
   e.g. "Its PAR 202608240082 is on 2026TEG-P0155" or a PAR cell "202607030034, 202610080029". */
const ID_RE = /(\b\d{12}\b|\b\d{4}TEG-P\d{4,5}\b)/i;
export function copyableText(text) {
  return String(text || "").split(ID_RE).filter(Boolean).map(p => (!ID_RE.test(p) ? p
    : copyable(p, { label: /TEG/i.test(p) ? "project code" : "request number" })));
}
