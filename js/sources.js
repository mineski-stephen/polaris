/* The source tables (Project Brief, Project Approval, Invoice Request), shown beside
   the list when picked with the table switcher. They're filled by Lark Approval, so
   they're for looking things up: every row, newest submitted first, searchable
   across every column Polaris reads. Not editable from here (Open in Lark). */

import { sourceView } from "./sync.js";
import { TABLE_TITLES } from "./ops.js";
import { $, h, ic, fmt, store, recall, copyable } from "./ui.js";
import { copyableText } from "./polaris-ui.js";
import { describe } from "./net.js";

export const SOURCE_KINDS = ["brief", "par", "invoice"];
const KEY = { sort: "polaris.srcSort" };
const MAX_ROWS = 300;   // drawn at once; a search narrows the rest
// The columns of each table; the money column is the brief's Contract Value or the request's Amount.
const COLUMNS = {
  brief:   [["c-req", "Request No."], ["c-project", "Project"], ["c-code", "Project Code"], ["c-people c-am", "AM"],
            ["c-amount num", "Contract Value"], ["c-status", "Status"], ["c-date", "Submitted"]],
  par:     [["c-req", "Request No."], ["c-project", "Project"], ["c-code", "Project Code"], ["c-status", "Status"], ["c-date", "Submitted"]],
  invoice: [["c-req", "Request No."], ["c-project", "Project"], ["c-code", "Project Code"], ["c-amount num", "Amount"],
            ["c-status", "Status"], ["c-date", "Submitted"]],
};
const NOUN = { brief: ["brief", "briefs"], par: ["PAR", "PARs"], invoice: ["invoice request", "invoice requests"] };

export function createSources(ctx) {
  const { S } = ctx;
  const V = S.srcView = { kind: "brief", query: { brief: "", par: "", invoice: "" } };
  function loadPrefs() { V.sort = recall("local", KEY.sort) === "asc" ? "asc" : "desc"; }
  loadPrefs();
  $("#srcSearch").addEventListener("input", (e) => { V.query[V.kind] = e.target.value; render(V.kind); });

  function renderLoader() {
    const el = $("#srcLoader");
    const show = !S.data && S.loading;
    el.hidden = !show;
    if (show) el.replaceChildren(h("div", { class: "loader-title" }, h("span", { class: "spinner" }), `Loading ${TABLE_TITLES[V.kind]}…`));
  }

  /* Draw `kind` (only when it's the pane showing: app.js passes the side). */
  function render(kind) {
    if (!SOURCE_KINDS.includes(kind)) return;
    V.kind = kind;
    const title = TABLE_TITLES[kind], q = V.query[kind] || "";
    $("#srcName").textContent = title;
    $("#srcSearchLabel").textContent = `Search ${title}`;
    const search = $("#srcSearch");
    if (search.value !== q) search.value = q;
    const t = ctx.tables[kind];
    $("#srcOpen").href = t ? t.url : "#";
    $("#srcOpen").setAttribute("aria-label", `Open ${title} in Lark`);
    renderLoader();
    const table = $("#srcTable"), empty = $("#srcEmpty"), foot = $("#srcFoot");
    if (!S.data || !S.data[kind]) {
      table.replaceChildren();
      foot.textContent = "";
      empty.hidden = !(S.loadError && !S.loading);
      if (S.loadError) {
        empty.className = "callout callout-err";
        empty.replaceChildren(ic("alert"), h("div", null, describe(S.loadError)),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.loadData() }, "Try again"));
      }
      $("#srcSub").textContent = "";
      return;
    }
    const v = sourceView(S.data[kind], { sort: V.sort, query: q, limit: MAX_ROWS });
    const [one, many] = NOUN[kind];
    $("#srcSub").textContent = `${v.count.toLocaleString()} ${v.count === 1 ? one : many}`;
    const cols = COLUMNS[kind];
    const sortBtn = h("button", { type: "button", class: "sort-btn",
      title: V.sort === "desc" ? "Newest first. Click for oldest first." : "Oldest first. Click for newest first.",
      onclick: () => { V.sort = V.sort === "desc" ? "asc" : "desc"; store("local", KEY.sort, V.sort); render(kind); } },
      "Submitted", ic(V.sort === "desc" ? "sortDown" : "sortUp"));
    const last = cols.length - 1;
    const head = h("thead", null, h("tr", null, cols.map(([cls, label], i) =>
      h("th", { scope: "col", class: cls.includes("num") ? "num" : null,
                "aria-sort": i === last ? (V.sort === "desc" ? "descending" : "ascending") : null },
        i === last ? sortBtn : label)), h("th", { scope: "col", class: "c-act" }, h("span", { class: "sr-only" }, "Open"))));
    table.replaceChildren(head, h("tbody", null, v.rows.map(r => rowEl(kind, r))));
    foot.textContent = v.count > v.rows.length
      ? `Showing the newest ${v.rows.length.toLocaleString()} of ${v.count.toLocaleString()}. Search to find the others.` : "";
    empty.hidden = v.count > 0;
    empty.className = "empty small";
    empty.replaceChildren(h("p", null, q.trim() ? `Nothing in ${title} matches "${q.trim()}".` : `${title} is empty.`));
  }

  function rowEl(kind, r) {
    const cell = (cls, content, title) => h("td", { class: cls, title }, content || "");
    const money = r.amount !== null ? fmt.money(r.amount, r.currency) : "";
    const cells = {
      "c-req": cell("c-req", r.requestNo ? copyable(r.requestNo, { label: "request number" }) : ""),
      "c-project": cell("c-project", r.name || h("span", { class: "none" }, "(no name)")),
      "c-code": cell("c-code", r.code ? copyableText(r.code) : ""),
      "c-people c-am": cell("c-people c-am", r.am.map(u => u.short).join(", "), r.am.length ? r.am.map(u => u.name).join(", ") : null),
      "c-amount num": cell("c-amount num", money),
      "c-status": cell("c-status", r.status, r.dept ? `Filed by ${r.dept}` : null),
      "c-date": cell("c-date", r.submittedAt ? fmt.day(r.submittedAt) : ""),
    };
    return h("tr", { class: "urow", "data-id": r.id },
      COLUMNS[kind].map(([cls]) => cells[cls]),
      // The approval itself, in Lark (its Request No. is a link to it).
      h("td", { class: "c-act" }, r.link ? h("a", { class: "icon-btn icon-sm", href: r.link, target: "_blank", rel: "noopener",
        title: "Open the approval in Lark", "aria-label": `Open ${r.requestNo || "the approval"} in Lark` }, ic("external")) : null),
      h("td", { class: "brk b1", "aria-hidden": "true" }),
      h("td", { class: "brk b2", "aria-hidden": "true" }));
  }

  return { render, renderLoader, loadPrefs };
}
