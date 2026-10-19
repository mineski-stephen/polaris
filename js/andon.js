/* The ANDON view (beside the ANDON tab): every ANDON row, sorted by Project Code
   Z-A (the newest projects first). A row opens its record in the row editor (js/inbox.js). */

import { andonView } from "./sync.js";
import { $, h, ic, store, recall, flash } from "./ui.js";
import { dayOnly, copyableText } from "./polaris-ui.js";
import { describe } from "./net.js";

const KEY = { sort: "polaris.andonCodeSort" };   // (1.2.0 sorted by Event Start under "polaris.andonSort")
const SORT_COL = 1;                               // Project Code
const COLUMNS = [
  ["c-project", "Project"], ["c-code", "Project Code"], ["c-people c-am", "AM"], ["c-people c-pm", "PM (LEAD)"],
  ["c-status", "TRIBE"], ["c-date", "Event Start"],
];

export function createAndon(ctx) {
  const { S } = ctx;
  const A = S.andonView = { query: "", highlight: null };
  function loadPrefs() { A.sort = recall("local", KEY.sort) === "asc" ? "asc" : "desc"; }
  loadPrefs();
  $("#andonSearch").addEventListener("input", (e) => { A.query = e.target.value; render(); });
  if (ctx.tables.andon) $("#andonOpen").href = ctx.tables.andon.url;

  function renderLoader() {
    const el = $("#andonLoader");
    const show = !S.data && S.loading;
    el.hidden = !show;
    if (show) el.replaceChildren(h("div", { class: "loader-title" }, h("span", { class: "spinner" }), "Loading ANDON…"));
  }

  function render() {
    renderLoader();
    const table = $("#andonTable"), empty = $("#andonEmpty");
    if (!S.data || !S.data.andon) {
      table.replaceChildren();
      empty.hidden = !(S.loadError && !S.loading);
      if (S.loadError) {
        empty.className = "callout callout-err";
        empty.replaceChildren(ic("alert"), h("div", null, describe(S.loadError)),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.loadData() }, "Try again"));
      }
      $("#andonSub").textContent = "";
      return;
    }
    const v = andonView(S.data.andon, { sort: A.sort, query: A.query });
    $("#andonSub").textContent = `${v.count.toLocaleString()} project${v.count === 1 ? "" : "s"}`;
    const sortBtn = h("button", { type: "button", class: "sort-btn",
      title: A.sort === "desc" ? "Z-A: newest projects first. Click for A-Z." : "A-Z: oldest projects first. Click for Z-A.",
      onclick: () => { A.sort = A.sort === "desc" ? "asc" : "desc"; store("local", KEY.sort, A.sort); render(); } },
      "Project Code", ic(A.sort === "desc" ? "sortDown" : "sortUp"));
    const head = h("thead", null, h("tr", null, COLUMNS.map(([cls, label], i) =>
      h("th", { scope: "col", "aria-sort": i === SORT_COL ? (A.sort === "desc" ? "descending" : "ascending") : null },
        i === SORT_COL ? sortBtn : label))));
    table.replaceChildren(head, h("tbody", null, v.rows.map(rowEl)));
    empty.hidden = v.count > 0;
    empty.className = "empty small";
    empty.replaceChildren(h("p", null, A.query.trim() ? `Nothing in ANDON matches "${A.query.trim()}".` : "ANDON is empty."));
    if (A.highlight) land();
  }

  function rowEl(r) {
    const cell = (cls, content, label, title) => h("td", { class: cls, "data-label": label && content ? label : null, title }, content || "");
    const who = (list, label, cls) => cell(cls, list.map(u => u.short).join(", "), label, list.length ? list.map(u => u.name).join(", ") : null);
    return ctx.openable(h("tr", { class: "urow", "data-id": r.id },
      cell("c-project", r.project || h("span", { class: "none" }, "(no name)")),
      cell("c-code", r.code ? copyableText(r.code) : ""),
      who(r.am, "AM", "c-people c-am"),
      who(r.pm, "PM", "c-people c-pm"),
      cell("c-status", r.tribe),
      cell("c-date", dayOnly(r.start)),
      h("td", { class: "brk b1", "aria-hidden": "true" }),
      h("td", { class: "brk b2", "aria-hidden": "true" })), "andon", r.id, r.project || r.code);
  }

  function land() {
    if (!ctx.isSplit()) return;
    const tr = $(`#andonTable tr[data-id="${A.highlight}"]`);
    A.highlight = null;
    if (tr) flash(tr);
  }
  const highlight = (id) => { A.highlight = id; };

  return { render, renderLoader, highlight, loadPrefs };
}
