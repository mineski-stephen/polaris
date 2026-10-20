/* The Universe view: one Year (this year by default), grouped by Status, sorted by
   RFP Received Date; Stalled / Lost / Archived last, folded until opened, and out of
   the totals. A just-pushed row is highlighted where it lands. */

import { UNIVERSE_VIEW } from "./config.js";
import { universeView, universeRow } from "./sync.js";
import { $, h, ic, fmt, flash, store, recall, toast } from "./ui.js";
import { dayOnly, copyableText } from "./polaris-ui.js";
import { describe } from "./net.js";

// collapsed: groups folded by hand; opened: folded-by-default groups (Stalled, Lost, Archived) opened by hand
const KEY = { sort: "polaris.uniSort", collapsed: "polaris.uniCollapsed", opened: "polaris.uniOpened" };
const COLUMNS = [
  ["c-client", "Client"], ["c-project", "Project"], ["c-amount num", "Amount (VAT-Ex.) (PHP)"],
  ["c-people c-bd", "BD"], ["c-people c-am", "AM"], ["c-code", "Project Code"], ["c-date", "RFP Received Date"],
];

export function createUniverse(ctx) {
  const { S } = ctx;
  const U = S.uni = { year: String(new Date().getFullYear()), query: "", highlight: null };
  // The sort and the folded groups are remembered on this device.
  function loadPrefs() {
    U.sort = recall("local", KEY.sort) === "asc" ? "asc" : UNIVERSE_VIEW.defaultSort;
    U.collapsed = new Set(recall("local", KEY.collapsed) || []);
    U.opened = new Set(recall("local", KEY.opened) || []);
  }
  loadPrefs();

  $("#uniYear").addEventListener("change", (e) => { U.year = e.target.value; render(); });
  $("#uniSearch").addEventListener("input", (e) => { U.query = e.target.value; render(); });
  $("#uniOpen").href = ctx.tables.universe.url;

  function renderLoader() {
    const el = $("#uniLoader");
    const show = !S.data && S.loading;
    el.hidden = !show;
    if (show) {
      el.replaceChildren(h("div", { class: "loader-title" }, h("span", { class: "spinner" }),
        S.waking ? "Waking up the connection…" : "Loading the Universe…"));
    }
  }

  function render() {
    renderLoader();
    const table = $("#uniTable");
    const empty = $("#uniEmpty");
    if (!S.data) {
      table.replaceChildren();
      empty.hidden = !(S.loadError && !S.loading);
      if (S.loadError) {   // the load failed: say why, with the way out
        empty.className = "callout callout-err";
        empty.replaceChildren(ic("alert"), h("div", null, describe(S.loadError)),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.loadData() }, "Try again"));
      }
      $("#uniSub").textContent = "";
      $("#uniFoot").textContent = "";
      return;
    }
    const v = universeView(S.data.universe, {
      year: U.year, folded: UNIVERSE_VIEW.foldedStatuses, statusOrder: S.statusOrder, sort: U.sort, query: U.query,
    });

    // Year choices: every year in the table, this year, and all years.
    const years = [...new Set([...v.years, String(new Date().getFullYear()), U.year].filter(y => y !== "all"))].sort().reverse();
    const sel = $("#uniYear");
    const want = [...years, "all"].join(",");
    if (sel.dataset.options !== want) {
      sel.replaceChildren(...years.map(y => h("option", { value: y }, y)), h("option", { value: "all" }, "All years"));
      sel.dataset.options = want;
    }
    sel.value = U.year;

    // While searching, count everything found (Stalled, Lost and Archived too); the amount stays the pipeline's.
    const n = U.query.trim() ? v.count + v.foldedCount : v.count;
    $("#uniSub").textContent = `${n.toLocaleString()} project${n === 1 ? "" : "s"}${U.query.trim() ? " found" : ""} · ₱${fmt.short(v.amount)} (VAT-Ex.)`;
    $("#uniFoot").textContent = v.foldedCount
      ? `${v.foldedCount.toLocaleString()} stalled, lost or archived at the bottom, not counted in the total above.` : "";

    const sortBtn = h("button", { type: "button", class: "sort-btn",
      title: U.sort === "desc" ? "Newest first. Click for oldest first." : "Oldest first. Click for newest first.",
      onclick: () => { U.sort = U.sort === "desc" ? "asc" : "desc"; store("local", KEY.sort, U.sort); render(); } },
      "RFP Received Date", ic(U.sort === "desc" ? "sortDown" : "sortUp"));
    const head = h("thead", null, h("tr", null, COLUMNS.map(([cls, label], i) =>
      h("th", { class: cls.includes("num") ? "num" : "", scope: "col",
                "aria-sort": i === COLUMNS.length - 1 ? (U.sort === "desc" ? "descending" : "ascending") : null },
        i === COLUMNS.length - 1 ? sortBtn : label))));

    // Stalled, Lost and Archived stay folded until opened (remembered on this device);
    // while searching they open like the others, so what's found is in view.
    const searching = !!U.query.trim();
    const byOpened = (g) => g.folded && !searching;
    const isOpen = (g, name) => (byOpened(g) ? U.opened.has(name) : !U.collapsed.has(name));
    const bodies = v.groups.map((g, i) => {
      const name = g.status || "No status";
      const open = isOpen(g, name);
      const toggle = h("button", { type: "button", class: "group-btn", "aria-expanded": String(open), onclick: () => {
        const set = byOpened(g) ? U.opened : U.collapsed;
        if (set.has(name)) set.delete(name); else set.add(name);
        store("local", KEY.collapsed, [...U.collapsed]);
        store("local", KEY.opened, [...U.opened]);
        render();
      } }, ic("caret"), name, h("span", { class: "group-n" }, String(g.rows.length)),
        h("span", { class: "group-sum" }, g.amount ? "₱" + fmt.short(g.amount) : ""));
      const first = g.folded && !(v.groups[i - 1] || {}).folded;   // a line above the first of them
      return h("tbody", { class: [open ? "" : "is-collapsed", g.folded ? "is-folded" : "", first ? "is-first-folded" : ""].filter(Boolean).join(" "),
                          "data-status": name, "data-folded": g.folded ? "1" : null },
        h("tr", { class: "group" }, h("th", { colspan: String(COLUMNS.length), scope: "rowgroup" }, toggle)),
        g.rows.map(rowEl));
    });
    table.replaceChildren(head, ...bodies);
    empty.hidden = v.count + v.foldedCount > 0;
    if (!S.data.universe.length) {   // a table that has never had a row
      empty.className = "empty";
      empty.replaceChildren(h("div", { class: "empty-art", "aria-hidden": "true" }, ic("table")),
        h("h2", null, "The Universe is empty"),
        h("p", null, "Briefs you push show up here, grouped by status."),
        h("a", { class: "btn", href: ctx.tables.universe.url, target: "_blank", rel: "noopener" }, ic("external"), "Open in Lark"));
    } else {
      empty.className = "empty small";
      empty.replaceChildren(h("p", null, U.query ? `Nothing in ${U.year === "all" ? "the Universe" : U.year} matches "${U.query.trim()}".`
        : `No projects for ${U.year === "all" ? "any year" : U.year} yet.`));
    }

    if (U.highlight) landHighlight();
  }

  function rowEl(r) {
    const cell = (cls, content, label, title) => h("td", { class: cls, "data-label": label && content ? label : null, title },
      content || "");
    // People by their short display names; the full Lark names on hover.
    const who = (list, label, cls) => cell(cls, list.map(u => u.short).join(", "), label,
                                           list.length ? list.map(u => u.name).join(", ") : null);
    // A click (or Enter) opens the record in the row editor.
    return ctx.openable(h("tr", { class: "urow", "data-id": r.id },
      cell("c-client", r.client),
      cell("c-project", r.project || h("span", { class: "none" }, "(no name)")),
      cell("c-amount num", r.amount !== null ? fmt.peso(r.amount) : ""),
      who(r.bd, "BD", "c-people c-bd"),
      who(r.am, "AM", "c-people c-am"),
      cell("c-code", r.code ? copyableText(r.code) : ""),
      cell("c-date", dayOnly(r.rfp)),
      h("td", { class: "brk b1", "aria-hidden": "true" }),
      h("td", { class: "brk b2", "aria-hidden": "true" })), "universe", r.id, r.project || r.code);
  }

  /* After a push: make sure the row is in view (switching the year if needed),
     scroll to it and let it glow. */
  function landHighlight() {
    if (!ctx.isSplit()) return;   // the table only shows beside the list, on wide screens
    const id = U.highlight;
    const rec = S.data.universe.find(r => r.record_id === id);
    if (!rec) return;
    const { year } = universeRow(rec);
    if (U.year !== "all" && /^\d{4}$/.test(year) && year !== U.year) {
      U.year = year;
      toast(`Showing ${year}, the year of the project you pushed.`);
      return render();
    }
    const tr = $(`#uniTable tr[data-id="${id}"]`);
    if (!tr) return;
    const tbody = tr.closest("tbody");
    if (tbody && tbody.classList.contains("is-collapsed")) {   // open its group (a folded one too: Stalled, Lost, Archived)
      if (tbody.dataset.folded && !U.query.trim()) U.opened.add(tbody.dataset.status); else U.collapsed.delete(tbody.dataset.status);
      store("local", KEY.collapsed, [...U.collapsed]);
      store("local", KEY.opened, [...U.opened]);
      return render();
    }
    U.highlight = null;
    flash(tr);   // scrolls it into view too
  }

  /* Remember a row to highlight once it's on screen. */
  function highlight(id) { U.highlight = id; }

  return { render, renderLoader, highlight, loadPrefs };
}
