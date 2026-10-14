/* The Collections view (beside the Invoices tab): grouped by Status, sorted by
   Invoice Number. Finance adds the details only they know (Invoice Number, SI
   Number, Invoice Date, the invoice file) from here. */

import { collectionsView, collectionRow, invoiceDetailsPatch, shortName } from "./sync.js";
import { saveInvoiceDetails, loadCollections } from "./ops.js";
import { RULES } from "./config.js";
import { $, h, ic, fmt, flash, store, recall, toast, copyable, busy } from "./ui.js";
import { dayOnly, copyableText, dateField } from "./polaris-ui.js";
import { describe, isDeadToken, uploadToBase } from "./net.js";

const KEY = { sort: "polaris.colSort", collapsed: "polaris.colCollapsed" };
const COLUMNS = [
  ["c-ar", "AR Name"], ["c-code", "Project Code"], ["c-amount num", "Invoice Amount"], ["c-cur", "Currency"],
  ["c-remarks", "Sales Remarks"], ["c-status", "Status"], ["c-people c-am", "AM"], ["c-act", ""],
];

export function createCollections(ctx) {
  const { S } = ctx;
  const C = S.col = { query: "", highlight: null };
  // The sort and the folded groups are remembered on this device.
  function loadPrefs() {
    C.sort = recall("local", KEY.sort) === "asc" ? "asc" : "desc";
    C.collapsed = new Set(recall("local", KEY.collapsed) || []);
  }
  loadPrefs();
  $("#colSearch").addEventListener("input", (e) => { C.query = e.target.value; render(); });
  $("#colOpen").href = ctx.tables.collections.url;

  function renderLoader() {
    const el = $("#colLoader");
    const show = !S.data && S.loading;
    el.hidden = !show;
    if (show) el.replaceChildren(h("div", { class: "loader-title" }, h("span", { class: "spinner" }), "Loading Collections…"));
  }

  function render() {
    renderLoader();
    const table = $("#colTable"), empty = $("#colEmpty");
    if (!S.data) {
      table.replaceChildren();
      empty.hidden = !(S.loadError && !S.loading);
      if (S.loadError) {   // the load failed: say why, with the way out
        empty.className = "callout callout-err";
        empty.replaceChildren(ic("alert"), h("div", null, describe(S.loadError)),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.loadData() }, "Try again"));
      }
      $("#colSub").textContent = "";
      return;
    }
    const v = collectionsView(S.data.collections, { statusOrder: S.colStatusOrder || [], sort: C.sort, query: C.query });
    const waiting = v.groups.flatMap(g => g.rows).filter(r => !r.invoiceNo).length;
    $("#colSub").textContent = `${v.count.toLocaleString()} invoice${v.count === 1 ? "" : "s"}` +
      (waiting ? ` · ${waiting} without an invoice number` : "");

    const sortBtn = h("button", { type: "button", class: "sort-btn",
      title: C.sort === "desc" ? "Newest invoice number first. Click for oldest first." : "Oldest first. Click for newest first.",
      onclick: () => { C.sort = C.sort === "desc" ? "asc" : "desc"; store("local", KEY.sort, C.sort); render(); } },
      "Invoice No.", ic(C.sort === "desc" ? "sortDown" : "sortUp"));
    const head = h("thead", null, h("tr", null, COLUMNS.map(([cls, label], i) =>
      h("th", { class: cls.includes("num") ? "num" : "", scope: "col" }, label, i === 0 ? [" · ", sortBtn] : null))));
    const canEdit = ctx.canWriteFor("invoice");
    const bodies = v.groups.map((g) => {
      const name = g.status || "No status";
      const open = !C.collapsed.has(name);
      const toggle = h("button", { type: "button", class: "group-btn", "aria-expanded": String(open), onclick: () => {
        if (C.collapsed.has(name)) C.collapsed.delete(name); else C.collapsed.add(name);
        store("local", KEY.collapsed, [...C.collapsed]);
        render();
      } }, ic("caret"), name, h("span", { class: "group-n" }, String(g.rows.length)));
      return h("tbody", { class: open ? "" : "is-collapsed", "data-status": name },
        h("tr", { class: "group" }, h("th", { colspan: String(COLUMNS.length), scope: "rowgroup" }, toggle)),
        g.rows.map(r => rowEl(r, canEdit)));
    });
    table.replaceChildren(head, ...bodies);
    empty.hidden = v.count > 0;
    if (!S.data.collections.length) {   // a table that has never had a row
      empty.className = "empty";
      empty.replaceChildren(h("div", { class: "empty-art", "aria-hidden": "true" }, ic("coin")),
        h("h2", null, "Collections is empty"),
        h("p", null, "Invoices you add from the Invoices tab show up here, grouped by status."),
        h("a", { class: "btn", href: ctx.tables.collections.url, target: "_blank", rel: "noopener" }, ic("external"), "Open in Lark"));
    } else {
      empty.className = "empty small";
      empty.replaceChildren(h("p", null, C.query ? `Nothing in Collections matches "${C.query.trim()}".` : "Collections is empty."));
    }
    if (C.highlight) land();
  }

  function rowEl(r, canEdit) {
    const td = (cls, ...kids) => h("td", { class: cls }, ...kids);
    // Under the AR name: invoice and SI numbers (click to copy), date, file count.
    const sub = [r.invoiceNo ? copyable(r.invoiceNo, { label: "invoice number" }) : "",
                 r.siNo ? ["SI ", copyable(r.siNo, { label: "SI number" })] : "",
                 r.invoiceDate ? dayOnly(r.invoiceDate) : "",
                 r.files.length ? `${r.files.length} file${r.files.length === 1 ? "" : "s"}` : ""]
      .filter(x => x !== "").map(x => h("span", { class: "part" }, x)).flatMap((x, i) => (i ? [" · ", x] : [x]));
    return h("tr", { class: "urow", "data-id": r.id },
      td("c-ar", r.arName || h("span", { class: "none" }, "(no AR name)"), sub.length ? h("span", { class: "sub-line" }, sub) : null),
      td("c-code", r.code ? copyableText(r.code) : ""),
      td("c-amount num", r.amount !== null ? fmt.money(r.amount) : ""),
      td("c-cur", r.currency),
      td("c-remarks", r.remarks ? h("span", { class: "clip", title: r.remarks }, r.remarks) : ""),
      td("c-status", r.status),
      h("td", { class: "c-people c-am", title: r.am.map(u => u.name).join(", ") || null }, r.am.map(u => shortName(u.name)).join(", ")),
      td("c-act", h("button", { type: "button", class: "icon-btn icon-sm" + (r.invoiceNo ? "" : " is-todo"), disabled: !canEdit,
        title: r.invoiceNo ? "Edit invoice details" : "Add invoice details",
        "aria-label": `${r.invoiceNo ? "Edit" : "Add"} invoice details for ${r.arName}`,
        onclick: () => openDetails(r) }, ic(r.invoiceNo ? "pencil" : "plus"))),
      h("td", { class: "brk b1", "aria-hidden": "true" }),
      h("td", { class: "brk b2", "aria-hidden": "true" }));
  }

  /* After a push or a save: bring the row into view and let it glow. */
  function land() {
    if (!(ctx.isSplit() || $("#workspace").dataset.show === "universe")) return;
    const tr = $(`#colTable tr[data-id="${C.highlight}"]`);
    if (!tr) return;
    const tbody = tr.closest("tbody");
    if (tbody && tbody.classList.contains("is-collapsed")) {
      C.collapsed.delete(tbody.dataset.status);
      store("local", KEY.collapsed, [...C.collapsed]);
      return render();
    }
    C.highlight = null;
    flash(tr);   // scrolls it into view too
  }
  const highlight = (id) => { C.highlight = id; };

  /* ======================= invoice details sheet ======================= */
  const dlg = $("#details");
  const save = $("#detailsSave");
  let edit = null;   // { row, files: [{file_token?, name, size, file?}], date, dateOk, busy }

  $("#detailsCancel").addEventListener("click", () => { if (!edit || !edit.busy) dlg.close(); });
  dlg.addEventListener("cancel", (e) => { if (edit && edit.busy) e.preventDefault(); });
  dlg.addEventListener("close", () => { edit = null; $("#dFile").value = ""; });
  $("#detailsForm").addEventListener("submit", (e) => e.preventDefault());
  $("#dFile").addEventListener("change", (e) => {
    for (const file of e.target.files) edit.files.push({ name: file.name, size: file.size, file });
    e.target.value = "";
    paintFiles();
  });
  save.addEventListener("click", runSave);

  function openDetails(r) {
    edit = { row: r, files: r.files.map(f => ({ ...f })), date: r.invoiceDate || null, dateOk: true, busy: false };
    $("#detailsSub").replaceChildren(r.arName || r.code, ...(r.request ? [" · request ", copyable(r.request, { label: "request number" })] : []));
    $("#dInvoiceNo").value = r.invoiceNo;
    $("#dSiNo").value = r.siNo;
    $("#dDateBox").replaceChildren(dateField({ id: "dDate", value: edit.date,
      onChange: (ms, ok) => { edit.date = ms; edit.dateOk = ok; } }));
    $("#detailsError").hidden = true;
    paintFiles();
    setBusy(false);
    dlg.showModal();
    $("#dInvoiceNo").focus();
  }

  function paintFiles() {
    $("#dFiles").replaceChildren(...edit.files.map((f, i) => h("li", null, ic("link"),
      h("span", null, f.name, f.size ? ` (${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB)` : ""),
      f.file ? h("span", { class: "is-new-file" }, "new") : null,
      h("button", { type: "button", "aria-label": `Remove ${f.name}`, title: "Remove", onclick: () => { edit.files.splice(i, 1); paintFiles(); } }, ic("x")))));
  }

  // Busy: a spinner on Save, and a label that says what's happening ("Uploading 1 of 3…").
  function setBusy(on, label) {
    if (edit) edit.busy = on;
    busy(save, on, label || "Saving…");
    $("#detailsCancel").disabled = on;
  }

  async function runSave() {
    if (!edit || edit.busy) return;
    if (!ctx.ensureTime()) return;
    const e = edit, r = e.row;
    $("#detailsError").hidden = true;
    if (!e.dateOk) {
      $("#detailsError").textContent = "Invoice Date isn't a date Polaris can read. Try Oct 14, 2026, or double-click it to pick one.";
      $("#detailsError").hidden = false;
      return;
    }
    try {
      // Upload new files first (each once: a retry reuses tokens already returned).
      const fresh = e.files.filter(f => f.file && !f.file_token);
      for (let i = 0; i < fresh.length; i++) {
        setBusy(true, fresh.length > 1 ? `Uploading ${i + 1} of ${fresh.length}…` : "Uploading…");
        fresh[i].file_token = await uploadToBase(fresh[i].file, ctx.tables.collections.app, ctx.token());
      }
      setBusy(true, "Saving…");
      const patch = invoiceDetailsPatch(r, {
        invoiceNo: $("#dInvoiceNo").value, siNo: $("#dSiNo").value,
        invoiceDate: e.date, files: e.files,
      });
      if (!Object.keys(patch).length) { setBusy(false); dlg.close(); toast("Nothing changed."); return; }
      const res = await saveInvoiceDetails(ctx.call, ctx.tables, r.id, patch);
      setBusy(false);
      dlg.close();
      await afterSave(r, res);
    } catch (err) {
      setBusy(false);
      if (isDeadToken(err)) { dlg.close(); return ctx.sessionEnded(); }
      $("#detailsError").textContent = `Not saved. ${describe(err)}`;
      $("#detailsError").hidden = false;
    }
  }

  async function afterSave(r, res) {
    const n = Object.keys(res.written).length;
    if (res.readBackError || res.mismatches.length) {
      const list = res.mismatches ? res.mismatches.map(m => `${m.field}: sent "${m.want}", Lark has "${m.got}"`).join("; ") : describe(res.readBackError);
      toast(`Saved details for ${r.arName}.`, { type: "warn", timeout: 0, detail: `Check these in Lark: ${list}`,
        link: { href: ctx.tables.collections.url, text: "Open Collections" } });
    } else {
      toast(`Saved details for ${r.arName}.`, { type: "success", detail: `${n} field${n === 1 ? "" : "s"} checked in Lark.` });
    }
    await refresh(r.id);
  }

  /* Collections again, straight from Lark. */
  async function refresh(highlightId) {
    try {
      S.data.collections = await loadCollections(ctx.call, ctx.tables, RULES);
      ctx.recompute();
    } catch (err) {
      if (isDeadToken(err)) return ctx.sessionEnded();
    }
    if (highlightId) C.highlight = highlightId;
    ctx.render();
  }

  return { render, renderLoader, highlight, refresh, loadPrefs };
}
