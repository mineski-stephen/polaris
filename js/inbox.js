/* The Inbox: cards for Project Briefs, PARs and Invoice Requests, the push
   sheet (with the BD picker), and Ignore with Undo. */

import { RULES, LARK } from "./config.js";
import { TABLE_TITLES, pushBrief, pushPar, pushCollections, pushAndon, setIgnore, newClientToken, writableOnly, fillGaps } from "./ops.js";
import {
  universeFromBrief, collectionsChange, stepStatus, parAfterAdding, defaultVat, vatMentions,
  people, andonFromBrief, auditPatch, auditMissing, auditFilesMissing, monthOf,
} from "./sync.js";
import { uploadSizeProblem } from "./errors.js";
import { $, h, ic, toast, fmt, flash, copyable, store, collapse, busy, radioKeys } from "./ui.js";
import { copyableText, dateField } from "./polaris-ui.js";
import { createRowDoc } from "./rowdoc.js";
import { describe, isDeadToken, isUncertain, uploadToBase } from "./net.js";

const NOUN = { brief: "briefs", par: "PARs", invoice: "invoices", andon: "briefs for ANDON", audit: "projects with blanks" };
// The search box says what it looks through on each tab.
const SEARCHES = { brief: "Search code, project, AM…", par: "Search request no., code, project…",
                   invoice: "Search request no., code, project…", andon: "Search code, project, AM…",
                   audit: "Search project, code, blank columns…" };
const STAGE_ORDER = ["universe", "brief", "par", "invoice", "collections", "andon"];
// The table each card comes from (ANDON cards are Project Briefs too; invoice
// cards say which table they come from themselves: a won project is a Universe row).
const SOURCE = { brief: "brief", par: "par", invoice: "invoice", andon: "brief" };
const sourceOf = (c) => c.source || SOURCE[c.kind];
// One IGNORE box on the brief hides it from both the Universe and ANDON lists.
const ignoreFieldOf = (c) => c.ignoreField || "IGNORE";
const BADGE = { "Approved": "badge-ok", "Under Review": "badge-warn", "Processing": "badge-info", "Won": "badge-ok" };
const VOID_BADGE = "badge-err";
// A sheet that's cancelled keeps what was typed, per card and step (a request
// comes back as a new card when it's approved).
const draftKey = (c) => `${c.kind}:${c.step || ""}:${c.id}`;

export function createInbox(ctx) {
  const { S } = ctx;
  const search = $("#inboxSearch");

  search.addEventListener("input", () => { S.query[S.tab] = search.value; renderCards(); });
  $("#refreshBtn").addEventListener("click", () => ctx.loadData({ quiet: true }));

  /* ======================= list ======================= */
  function render() {
    search.placeholder = SEARCHES[S.tab];
    if (search.value !== S.query[S.tab]) search.value = S.query[S.tab];
    $("#refreshBtn").classList.toggle("is-busy", S.loading);
    $("#refreshBtn").disabled = S.loading;
    $("#updated").replaceChildren(...(S.loading && S.quiet ? [h("span", { class: "spinner", "aria-hidden": "true" }), "Refreshing…"]
      : S.loadedAt ? [`Updated ${fmt.time(S.loadedAt)}`] : []));
    renderMessage();
    renderLoader();
    renderCards();
  }

  function renderMessage() {
    const box = $("#loadMsg");
    let content = null;
    if (S.loadError && !S.loading && !S.quiet) {
      content = ["callout callout-err", [ic("alert"), h("div", null, describe(S.loadError)),
        h("button", { type: "button", class: "btn btn-sm", onclick: () => ctx.loadData() }, "Try again")]];
    } else if (ctx.problemsFor(S.tab).length) {
      content = ["callout callout-err", [ic("alert"), h("div", null,
        "These columns don't match what Polaris expects, so pushing is off here until they're fixed:",
        h("ul", null, ctx.problemsFor(S.tab).map(p => h("li", null, p))))]];
    } else if (S.data && !ctx.canWriteFor(S.tab)) {
      content = ["callout callout-warn", [ic("alert"),
        h("div", null, "Your login can only read the tables. Log in again to allow pushing."),
        h("a", { class: "btn btn-sm", href: "#/settings" }, "Open Settings")]];
    }
    box.hidden = !content;
    if (content) { box.className = content[0]; box.replaceChildren(...content[1]); }
  }

  /* Honest, staged progress: the real tables, ticked off as they arrive. */
  function renderLoader() {
    const el = $("#loader");
    const show = S.loading && !S.quiet;
    el.hidden = !show;
    if (!show) return;
    const head = S.waking
      ? [h("div", { class: "loader-title" }, h("span", { class: "spinner" }), "Waking up the connection…"),
         h("p", { class: "loader-sub" }, "It sleeps when nobody's using it. This can take up to a minute.")]
      : [h("div", { class: "loader-title" }, h("span", { class: "spinner" }), "Reading the tables…")];
    const stages = h("ul", { class: "stages" }, STAGE_ORDER.filter(k => ctx.tables[k]).map((k) => {
      const st = S.stages[k];
      const done = st && st.total !== null && st.n >= st.total;
      return h("li", { class: done ? "done" : "" },
        done ? ic("check") : st ? h("span", { class: "spinner" }) : h("span", { class: "slot" }),
        TABLE_TITLES[k], h("span", { class: "n" }, st ? `${st.n.toLocaleString()}${st.total ? ` of ${st.total.toLocaleString()}` : ""}` : ""));
    }));
    el.replaceChildren(...head, ...(S.waking ? [] : [stages]));
  }

  function matches(c, q) {
    if (!q) return true;
    const am = c.am ? c.am.map(u => u.name).join(" ") : "";
    const extra = c.kind === "audit" ? `${c.target} ${c.gaps.join(" ")}` : "";
    return `${c.code} ${c.name} ${c.requestNo} ${c.status} ${am} ${extra}`.toLowerCase().includes(q.toLowerCase().trim());
  }

  function renderCards() {
    const box = $("#cards");
    const empty = $("#emptyNote");
    const hiddenNote = $("#hiddenNote");
    if (!S.lists) { box.replaceChildren(); empty.hidden = true; hiddenNote.textContent = ""; return; }
    const list = S.lists[S.tab];
    const q = S.query[S.tab] || "";
    const cards = list.cards.filter(c => !ctx.queue.hides(c) && matches(c, q));   // queued ones have left
    // Re-rendering mustn't lose the keyboard's place (the queue re-renders as pushes land).
    const had = document.activeElement && document.activeElement.closest && document.activeElement.closest("#cards .item");
    const hadBtn = had ? [...had.querySelectorAll("button")].indexOf(document.activeElement) : -1;
    box.replaceChildren(...cards.map(cardEl));
    if (had && hadBtn >= 0) {
      const again = box.querySelector(`[data-id="${CSS.escape(had.dataset.id)}"]`);
      const btn = again && again.querySelectorAll("button")[hadBtn];
      if (btn) btn.focus({ preventScroll: true });
    }
    empty.hidden = cards.length > 0;
    empty.textContent = q ? `No ${NOUN[S.tab]} match "${q.trim()}".`
      : { brief: "Every brief is in the Universe. Nice work!",
          par: "Every PAR is in the Universe. Nice work!",
          invoice: "Collections is up to date. Nice work!",
          andon: "Every brief is in ANDON. Nice work!",
          audit: "Nothing in the Universe or ANDON has blanks to fill. Nice work!" }[S.tab];
    hiddenNote.textContent = hiddenSummary(list.hidden);
    S.entering.clear();
    if (S.flashCard) {
      const el = box.querySelector(`[data-id="${S.flashCard}"]`);
      S.flashCard = null;
      if (el) flash(el);   // scrolls it into view too
    }
  }

  function hiddenSummary(hd) {
    const label = {
      done: { invoice: "already up to date in Collections", andon: "already in ANDON" }[S.tab] || "already in the Universe",
      ignored: "ignored", void: "rejected, recalled or cancelled",
      otherDept: "from other departments", noProject: "for projects not in the Universe",
      closed: "for closed or lost projects", hiddenHere: "hidden on this device",
    };
    const parts = Object.keys(label).filter(k => hd[k] > 0).map(k => `${hd[k].toLocaleString()} ${label[k]}`);
    return parts.length ? `Not shown: ${parts.join(" · ")}.` : "";
  }

  function cardEl(c) {
    if (c.kind === "audit") return auditCardEl(c);
    const writable = ctx.canWriteFor(c.kind);
    const notes = [];
    let meta;
    if (c.kind === "brief" || c.kind === "andon") {
      meta = [c.value !== null ? h("b", null, fmt.money(c.value, c.currency)) : "No contract value",
              c.am.length ? h("span", { title: c.am.map(u => u.name).join(", ") }, ` · AM ${c.am.map(u => u.short).join(", ")}`) : "",
              c.kind === "andon" && c.department ? ` · ${c.department}` : ""];
      c.problems.forEach(p => notes.push(h("li", { class: "is-plain" }, p)));
      if (c.similar) {
        notes.push(h("li", null, copyableText(`Note: looks like "${c.similar.project}"${c.similar.code ? ` (${c.similar.code})` : ""}, ` +
          `already in ${c.kind === "andon" ? "ANDON" : "the Universe"}. If it's the same project, ignore this one.`)));
      }
    } else if (c.kind === "par") {
      const t = c.target;
      meta = ["PAR ", copyable(c.requestNo, { label: "request number" }),
              t ? ` · goes to "${t.project || t.codeText}"` : "",
              t && t.par ? [" (already has ", copyableText(t.par), ")"] : ""];
      c.notes.forEach(n => notes.push(h("li", null, copyableText(`Note: ${n}`))));
    } else {
      const t = c.targets.find(x => x.id === c.target);
      meta = [c.amount !== null ? h("b", null, fmt.money(c.amount, c.currency)) : "No amount",
              c.step === "won" ? ` · Amount (VAT-Inc.) · Universe: ${c.status}` : [" · request ", copyable(c.requestNo, { label: "request number" })],
              !t && c.existing ? ` · ${c.existing} already in Collections for this project` : ""];
      notes.unshift(h("li", { class: "flow" }, flowEl(c, c.target)));
      c.notes.forEach(n => notes.push(h("li", null, copyableText(`Note: ${n}`))));
    }
    if (c.blocked) notes.push(h("li", { class: "is-plain" }, c.blocked, fixLink(c.blocked, c.code)));
    const pushable = writable && !c.blocked && !(c.problems && c.problems.length);
    // A won project is hidden with an IGNORE box on its Universe row, if the Universe has one.
    const ignorable = c.source !== "universe" || ctx.hasField("universe", ignoreFieldOf(c));
    const canIgnore = writable && ignorable;
    const ignoreTitle = c.kind === "brief" || c.kind === "andon" ? "Hides this brief from both the Universe and ANDON lists"
      : !ignorable ? `To hide won projects here, add a checkbox column named “${ignoreFieldOf(c)}” to the Universe.`
      : c.source === "universe" ? `Ticks ${ignoreFieldOf(c)} on the project's Universe row` : null;
    const badge = c.step === "won" ? "Won" : c.status;
    return h("article", { class: "card item" + (S.working.has(c.id) ? " is-working" : "") + (S.entering.has(c.id) ? " is-entering" : ""),
                          "data-id": c.id },
      h("div", { class: "item-head" },
        copyable(c.code, { label: "project code", cls: "code", empty: h("span", { class: "code" }, "No code") }),
        badge ? h("span", { class: `badge ${BADGE[badge] || (RULES.voidStatuses.includes(badge) ? VOID_BADGE : "")}` }, badge) : null,
        h("span", { class: "item-date" }, fmt.day(c.submittedAt))),
      h("h3", null, c.name || "(no name)"),
      h("p", { class: "item-meta" }, meta),
      notes.length ? h("ul", { class: "notes" }, notes) : null,
      h("div", { class: "item-actions" },
        h("span", { class: "btn-wrap", title: ignoreTitle },
          h("button", { type: "button", class: "btn btn-ghost", disabled: !canIgnore,
            onclick: (e) => ignore(c, true, e.currentTarget) }, "Ignore")),
        // A won project that shouldn't be billed: a Collections row marked Invalid keeps it off the list.
        c.step === "won" ? h("button", { type: "button", class: "btn btn-ghost", disabled: !writable,
          title: "Adds this project to Collections with Status Invalid, so it stops showing here",
          onclick: () => openSheet(c, { invalid: true }) }, "Mark invalid") : null,
        h("button", { type: "button", class: "btn btn-tonal", disabled: !pushable, onclick: () => openSheet(c) }, "Push")));
  }

  /* Where a Collections card lands: the row (“AR name”), then From → To. */
  function flowEl(c, targetId, invalid = false) {
    const t = invalid ? null : c.targets.find(x => x.id === targetId);
    const to = invalid ? RULES.invalidStatuses[0] : stepStatus(c.step, RULES);
    const arrow = h("span", { class: "flow-arrow", "aria-label": "becomes" }, "→");
    if (!t) return [h("span", { class: "flow-step" }, "New Collections row", arrow, h("b", null, to))];
    const name = h("span", { class: "flow-row" }, `“${t.row.arName || "(no AR name)"}”`);
    if (t.action === "link") return [name, h("span", { class: "flow-step" }, `${t.row.status} · adds the request number`)];
    return [name, h("span", { class: "flow-step" }, t.row.status || "No status", arrow, h("b", null, to))];
  }

  /* A link to the card that clears a blocker, if it's in the lists. */
  function fixLink(reason, code) {
    if (reason.startsWith("Push this project's brief")) {
      const brief = S.lists.brief.cards.find(b => b.code === code);
      return brief ? h("a", { href: "#/briefs", onclick: () => { S.flashCard = brief.id; S.query.brief = ""; } }, "Go to the brief") : null;
    }
    if (reason.startsWith("Add this project's PAR")) {
      const par = S.lists.par.cards.find(p => p.code === code);
      return par ? h("a", { href: "#/pars", onclick: () => { S.flashCard = par.id; S.query.par = ""; } }, "Go to the PAR") : null;
    }
    return null;
  }

  /* ======================= ignore / undo (optimistic) ======================= */
  async function ignore(c, value, button) {
    if (S.working.has(c.id)) return;
    const src = sourceOf(c), box = ignoreFieldOf(c);
    const rec = (S.data[src] || []).find(r => r.record_id === c.id);
    if (!rec) return;
    if (!ctx.ensureTime()) return;     // Ignore and Undo are writes too
    const before = rec.fields[box];
    const what = c.requestNo && c.kind !== "brief" && c.kind !== "andon" ? `${c.code} · ${c.requestNo}` : c.code;
    const apply = (v) => { rec.fields[box] = v; ctx.recompute(); ctx.render(); };

    if (value && button) {   // let the card slide out, then drop it
      const el = button.closest(".item");
      await collapse(el);
    }
    if (!value) { S.entering.add(c.id); S.flashCard = c.id; }
    apply(value);
    const closeToast = value
      ? toast(`Ignored ${what}.`, { action: "Undo", onAction: () => ignore(c, false),
          detail: c.kind === "brief" || c.kind === "andon" ? "It's hidden from both the Universe and ANDON lists." : undefined })
      : toast(`${what} is back in the list.`, { type: "success" });
    S.working.add(c.id);
    try {
      const res = await ctx.track(() => setIgnore(ctx.call, ctx.tables[src], c.id, value, box));
      if (res.readBackError || (res.mismatches && res.mismatches.length)) {
        toast(`Lark didn't confirm the change to ${what}.`, { type: "warn", timeout: 0,
          detail: `Check its ${box} box in Lark.`, link: { href: ctx.tables[src].url, text: "Open in Lark" } });
      }
    } catch (err) {
      closeToast();
      if (isDeadToken(err)) { rec.fields[box] = before; return; }   // the session already ended (net.js); data is gone
      if (isUncertain(err)) {              // it may have landed: don't roll back, show what Lark really has
        toast(`Polaris couldn't confirm the change to ${what}.`, { type: "warn", timeout: 0,
          detail: "The list refreshed to show what Lark has. Check it before trying again.",
          link: { href: ctx.tables[src].url, text: "Open in Lark" } });
        ctx.loadData({ quiet: true });
        return;
      }
      apply(before);                       // roll back, and say why
      toast(`Couldn't ${value ? "ignore" : "restore"} ${what}.`, {
        type: "error", detail: describe(err), action: "Try again", onAction: () => ignore(c, value),
      });
    } finally {
      S.working.delete(c.id);
    }
  }

  /* ======================= push sheet ======================= */
  const dialog = $("#sheet");
  const go = $("#sheetGo");
  const cancel = $("#sheetCancel");
  let sheet = null;   // { card, choices, clientToken, targetId, busy, refresh }

  cancel.addEventListener("click", () => { if (!sheet || !sheet.busy) dialog.close(); });
  dialog.addEventListener("cancel", (e) => { if (sheet && sheet.busy) e.preventDefault(); });
  // A click on the backdrop (or the gap between the two cards) is Cancel. Only one that
  // starts there too, so a text selection dragged out of a field doesn't close it.
  let downOnBackdrop = false;
  dialog.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === dialog; });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && downOnBackdrop && !(sheet && sheet.busy)) dialog.close();
    downOnBackdrop = false;
  });
  dialog.addEventListener("close", () => {
    if (sheet && !sheet.done) S.drafts.set(draftKey(sheet.card) + (sheet.invalid ? ":invalid" : ""), { choices: sheet.choices, clientToken: sheet.clientToken, targetId: sheet.targetId });
    sheet = null;
  });
  $("#sheetForm").addEventListener("submit", (e) => e.preventDefault());   // Enter in a field mustn't send
  go.addEventListener("click", runPush);

  // Beside the form: the Lark row as it will be after this push (js/rowdoc.js).
  // Where there's no room for two side by side, it sits under the form's fields.
  const rowDoc = createRowDoc(ctx);
  const docBox = $("#sheetDoc");
  const narrow = matchMedia("(max-width: 960px)");
  function placeDoc() {
    if (narrow.matches) $("#sheetBody").append(docBox); else dialog.append(docBox);
    docBox.classList.toggle("is-inline", narrow.matches);
  }
  narrow.addEventListener("change", placeDoc);
  function paintDoc() {
    if (!sheet) return;
    rowDoc.render(docBox, preview(sheet.card, { choices: sheet.choices, targetId: sheet.targetId, invalid: sheet.invalid }));
  }

  /* ======================= the audit: blanks the brief can fill ======================= */
  const AUDIT_WHERE = { universe: "Universe", andon: "ANDON" };
  const auditRow = (c) => (S.data[c.target] || []).find(r => r.record_id === c.rowId) || { fields: {} };
  // The table's options and columns (ANDON's select spellings; the type of a column like Month).
  const auditOpts = (c) => ({ options: ctx.optionsOf(c.target), fields: ctx.fieldsOf(c.target) });
  const AUDIT_DATES = new Set(["Project Start", "Project End", "RFP Received Date", "Event Start", "Event End"]);

  function auditCardEl(c) {
    const writable = ctx.canWriteFor(`audit:${c.target}`);
    return h("article", { class: "card item" + (S.working.has(c.id) ? " is-working" : "") + (S.entering.has(c.id) ? " is-entering" : ""),
                          "data-id": c.id },
      h("div", { class: "item-head" },
        copyable(c.code, { label: "project code", cls: "code" }),
        h("span", { class: "badge badge-info" }, AUDIT_WHERE[c.target]),
        h("span", { class: "item-date" }, c.submittedAt ? `Brief ${fmt.day(c.submittedAt)}` : "")),
      h("h3", null, c.name || "(no name)"),
      // "…that the brief can fill" only when it can fill all of them (Sign Date, Month and the signed CE it never has).
      h("p", { class: "item-meta" }, h("b", null, `${c.gaps.length} blank`), ` in ${AUDIT_WHERE[c.target]}`,
        c.requestNo ? ((c.required || []).length || (c.files || []).length ? [" · brief ", copyable(c.requestNo, { label: "request number" })]
          : [" that the brief ", copyable(c.requestNo, { label: "request number" }), " can fill"]) : "",
        c.status ? ` · ${c.status}` : ""),
      h("ul", { class: "notes" }, h("li", { class: "flow" }, h("span", { class: "flow-row" }, "Missing"),
        h("span", { class: "flow-step" }, c.gaps.join(" · ")))),
      h("div", { class: "item-actions" },
        h("button", { type: "button", class: "btn btn-ghost", title: "Hides this card on this device until another cell goes blank",
          onclick: (e) => hideAudit(c, true, e.currentTarget) }, "Hide"),
        h("button", { type: "button", class: "btn btn-tonal", disabled: !writable, onclick: () => openSheet(c) }, "Fill")));
  }

  /* Hide (or bring back) an audit card on this device: nothing is written to Lark. */
  async function hideAudit(c, value, button) {
    if (value && button) {
      const el = button.closest(".item");
      await collapse(el);
    }
    if (value) S.auditHide.add(c.hideKey); else { S.auditHide.delete(c.hideKey); S.entering.add(c.id); S.flashCard = c.id; }
    store("local", "polaris.auditHidden", [...S.auditHide]);
    ctx.recompute();
    ctx.render();
    if (value) toast(`Hid ${c.code} (${AUDIT_WHERE[c.target]}).`, { action: "Undo", onAction: () => hideAudit(c, false),
      detail: "Only on this device. It comes back if another cell goes blank." });
  }

  /* The fill sheet: every blank with an editor, pre-filled from the brief (which
     may be out of date). Ticked ones are written; editing one ticks it. */
  function buildAudit(body, c) {
    const ch = sheet.choices;
    const row = auditRow(c);
    const opts = auditOpts(c);
    const types = new Map(ctx.fieldsOf(c.target).map(f => [f.field_name, f.type]));
    const selects = ctx.optionsOf(c.target);
    const AMOUNT = "Amount (VAT-Ex.) (PHP)";
    // Names for the people in the row beside the sheet (the brief's, plus anyone picked here).
    ch.names = ch.names || new Map();
    if (c.brief) for (const f of ["AM", "MKT", "BD"]) people(c.brief.record.fields[f]).forEach(u => ch.names.set(u.id, u.name));
    const fromBrief = () => auditPatch(c, row, { fields: c.gaps, vat: ch.vat }, RULES, opts);
    if (!ch.values) ch.values = { ...fromBrief() };
    ch.edited = ch.edited || [];
    ch.bad = ch.bad || [];
    ch.files = ch.files || [];   // the signed CE (a draft never keeps files)

    const vatBox = h("div", { class: "field" });
    const refresh = () => {
      const patch = auditPatch(c, row, ch, RULES, opts);
      const n = Object.keys(patch).length;
      const bad = ch.bad.filter(k => ch.fields.includes(k));
      const missing = auditMissing(c, patch);
      const noFile = auditFilesMissing(c, ch);
      const uploading = (c.files || []).some(k => k in patch);
      const tooBig = uploading ? ch.files.map(f => uploadSizeProblem(f, LARK.maxUploadMb)).filter(Boolean) : [];
      sheet.blocked = bad.length ? `Check ${bad.join(", ")}: ${bad.length === 1 ? "it isn't" : "they aren't"} valid yet.`
        : tooBig.length ? tooBig[0]
        : missing.length ? `A won project needs ${missing.join(" and ")}.`
        : noFile.length ? `Add the file for ${noFile.join(", ")}${c.gaps.length > 1 ? ", or untick it to fill the rest" : ""}.`
        : n ? "" : "Tick at least one field to fill.";
      go.disabled = sheet.busy || !!sheet.blocked;
      const files = ch.files.length;
      if (!sheet.busy) {
        go.querySelector(".label").textContent = !n ? "Fill"
          : uploading && n === 1 ? `Upload ${files} file${files === 1 ? "" : "s"}`
          : `Fill ${n} field${n === 1 ? "" : "s"}`;
      }
      blockNote.hidden = !sheet.blocked || (!n && !missing.length && !noFile.length);
      blockNote.textContent = sheet.blocked;
      vatBox.hidden = !(c.needsVat && ch.fields.includes(AMOUNT));
      paintDoc();
    };
    sheet.refresh = refresh;
    const blockNote = h("p", { class: "note", role: "status", hidden: true });

    // One row per blank: tick box, name, and an editor that fits the column.
    const tick = {};
    const editors = {};
    const mo = RULES.auditRequired.month;
    const changed = (k, v, ok = true) => {
      ch.values[k] = v;
      if (!ch.edited.includes(k)) ch.edited.push(k);
      ch.bad = ok ? ch.bad.filter(x => x !== k) : [...new Set([...ch.bad, k])];
      if (!ch.fields.includes(k)) { ch.fields.push(k); tick[k].checked = true; }
      // A new Sign Date moves Month to its month, unless Month was changed by hand.
      if (mo && k === mo.from && ok && v !== null && editors[mo.field] && !ch.edited.includes(mo.field)) {
        const month = monthOf(v, ctx.fieldsOf(c.target).find(f => f.field_name === mo.field), RULES);
        if (month !== null && month !== undefined) {
          ch.values[mo.field] = month;
          const fresh = editor(mo.field);
          editors[mo.field].replaceWith(fresh);
          editors[mo.field] = fresh;
        }
      }
      refresh();
    };
    let amountInput = null;
    // The signed CE: files picked here are uploaded to Lark when the push runs, then
    // put in the attachment cell. Adding a file ticks the row.
    const filesEditor = (k) => {
      const list = h("ul", { class: "files" });
      const btnText = h("span");
      const paint = (again = true) => {
        list.replaceChildren(...ch.files.map((f, i) => h("li", null, ic("link"),
          h("span", { class: "file-name" }, f.name, " ", h("span", { class: "file-size" }, `(${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB)`)),
          h("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { ch.files.splice(i, 1); paint(); } }, ic("x")))));
        list.hidden = !ch.files.length;
        btnText.textContent = ch.files.length ? "Add another file" : "Add the signed CE";
        if (again) refresh();
      };
      const input = h("input", { type: "file", multiple: true, hidden: true, accept: ".pdf,application/pdf" });
      input.addEventListener("change", () => {
        for (const file of input.files) ch.files.push({ name: file.name, size: file.size, file });
        input.value = "";
        if (ch.files.length && !ch.fields.includes(k)) { ch.fields.push(k); tick[k].checked = true; }
        paint();
      });
      paint(false);
      return h("div", { class: "field" }, list,
        h("label", { class: "btn btn-sm file-btn" }, ic("plus"), btnText, input),
        h("p", { class: "set-sub" }, `PDF, up to ${LARK.maxUploadMb} MB each. Uploaded to Lark when the push runs.`));
    };
    const editor = (k) => {
      if ((c.files || []).includes(k)) return filesEditor(k);
      const id = `gap-v-${k.replace(/\W+/g, "-")}`;
      const v = ch.values[k];
      const type = types.get(k) || (AUDIT_DATES.has(k) ? 5 : 1);
      if (type === 5) return dateField({ id, value: v ?? null, onChange: (ms, ok) => changed(k, ms, ok) });
      if (type === 11) {
        const chosen = (Array.isArray(v) ? v : []).map(u => ({ id: u.id, name: ch.names.get(u.id) || u.id, email: "" }));
        const pool = c.target === "andon" ? [...(S.pmPool || []), ...S.pool] : S.pool;
        return peoplePicker({ id, selected: chosen, pool: [...new Map(pool.map(p => [p.id, p])).values()],
          placeholder: "Add someone", single: c.target === "andon" && k === "AM", head: "Frequent people",
          onChange: (list) => { list.forEach(u => ch.names.set(u.id, u.name)); changed(k, list.map(u => ({ id: u.id }))); } });
      }
      if (type === 3) {
        const sel = h("select", { id }, h("option", { value: "" }, "Not set"), (selects[k] || []).map(o => h("option", { value: o }, o)));
        sel.value = v || "";
        sel.addEventListener("change", () => changed(k, sel.value || null));
        return h("label", { class: "select" }, sel);
      }
      if (type === 4) {
        const now = new Set(Array.isArray(v) ? v : []);
        return h("div", { class: "chips", role: "group", "aria-label": k }, (selects[k] || []).map(o =>
          h("button", { type: "button", class: "chip-opt", "aria-pressed": String(now.has(o)), onclick: (e) => {
            if (now.has(o)) now.delete(o); else now.add(o);
            e.currentTarget.setAttribute("aria-pressed", String(now.has(o)));
            changed(k, [...now]);
          } }, o)));
      }
      if (type === 2) {
        const el = h("input", { type: "text", id, inputmode: "decimal", autocomplete: "off" });
        el.value = v ?? "";
        el.addEventListener("input", () => {
          const t = el.value.replace(/[₱,\s]/g, "");
          const n = t === "" ? null : Number(t);
          el.setAttribute("aria-invalid", String(Number.isNaN(n)));
          changed(k, Number.isNaN(n) ? null : n, !Number.isNaN(n));
        });
        if (k === AMOUNT) amountInput = el;
        return el;
      }
      const long = /description|remarks/i.test(k) || String(v || "").length > 60;
      const el = h(long ? "textarea" : "input", long ? { id, rows: "3" } : { type: "text", id, autocomplete: "off" });
      el.value = v ?? "";
      el.addEventListener("input", () => changed(k, el.value));
      return el;
    };
    const rows = c.gaps.map((k) => {
      const box = h("input", { type: "checkbox", id: `gap-${k.replace(/\W+/g, "-")}`, "aria-label": `Fill ${k}` });
      // A required column can't be left out: always ticked.
      if ((c.required || []).includes(k)) { box.disabled = true; if (!ch.fields.includes(k)) ch.fields.push(k); }
      box.checked = ch.fields.includes(k);
      tick[k] = box;
      box.addEventListener("change", () => {
        ch.fields = box.checked ? [...ch.fields, k] : ch.fields.filter(x => x !== k);
        refresh();
      });
      editors[k] = editor(k);
      return h("div", { class: "gap" },
        h("label", { class: "gap-head", for: box.id }, box, h("b", null, k)),
        editors[k]);
    });
    if (c.needsVat) {
      const seg = h("div", { class: "chips", role: "radiogroup", "aria-label": "VAT" },
        ["12%", "0%"].map(v => h("button", { type: "button", class: "chip-opt", role: "radio", "aria-checked": String(ch.vat === v), onclick: (e) => {
          ch.vat = v;
          for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-checked", String(b.textContent === v));
          // An amount still as the brief has it follows the VAT; one typed in stays.
          if (!ch.edited.includes(AMOUNT) && amountInput) {
            ch.values[AMOUNT] = fromBrief()[AMOUNT];
            amountInput.value = ch.values[AMOUNT] ?? "";
          }
          refresh();
        } }, v)));
      radioKeys(seg);
      vatBox.replaceChildren(h("span", { class: "field-label" }, "VAT"), seg);
    }
    put(body, h("div", { class: "gaps" }, rows), vatBox, blockNote);
    refresh();
  }

  function defaults(c) {
    if (c.kind === "brief") return { vat: defaultVat(c.currency), client: "", bd: [], otherLinks: "", showLinks: false };
    if (c.kind === "invoice") {
      return { targetId: c.target, arName: c.name, invoiceNo: "", siNo: "", invoiceDate: null, invoiceDateOk: true, files: [], showDetails: false };
    }
    if (c.kind === "andon") return { pm: [], tribe: "" };
    if (c.kind === "audit") return { fields: [...c.gaps], vat: defaultVat(c.brief ? c.brief.currency : "PHP"), values: null, edited: [], bad: [], files: [] };
    return {};
  }

  function openSheet(c, { invalid = false } = {}) {
    const draft = S.drafts.get(draftKey(c) + (invalid ? ":invalid" : ""));
    sheet = {
      card: c,
      choices: draft ? { ...draft.choices } : defaults(c),
      clientToken: draft ? draft.clientToken : newClientToken(),
      targetId: (draft && draft.targetId) || (c.target && c.target.id) || null,
      busy: false, done: false, blocked: "", invalid,
    };
    sheet.choices.invalid = invalid;
    // A draft's row may have gone (the list was refreshed): fall back to the card's default.
    if (c.kind === "invoice" && sheet.choices.targetId !== "new" && !c.targets.some(t => t.id === sheet.choices.targetId)) {
      sheet.choices.targetId = c.target;
    }
    $("#sheetTitle").textContent = { brief: "Push to Universe", par: "Add PAR to Universe", invoice: "Add to Collections", andon: "Add to ANDON",
                                     audit: `Fill blanks in ${c.target === "andon" ? "ANDON" : "the Universe"}` }[c.kind];
    $("#sheetSub").replaceChildren(copyable(c.code, { label: "project code", empty: "No code" }),
      ...((c.kind === "par" || c.kind === "invoice") && c.requestNo ? [" · request ", copyable(c.requestNo, { label: "request number" })] : []), ` · ${c.name}`);
    go.querySelector(".label").textContent = { brief: "Push to Universe", par: "Add PAR", invoice: "Add to Collections", andon: "Add to ANDON", audit: "Fill" }[c.kind];
    $("#sheetError").hidden = true;
    const body = $("#sheetBody");
    body.replaceChildren();
    if (c.kind === "brief") buildBrief(body, c);
    else if (c.kind === "par") buildPar(body, c);
    else if (c.kind === "andon") buildAndon(body, c);
    else if (c.kind === "audit") buildAudit(body, c);
    else buildInvoice(body, c);
    placeDoc();
    paintDoc();
    setBusy(false);
    dialog.showModal();
    const first = body.querySelector("input, select, textarea");
    (first || cancel).focus();
  }

  // Busy: a spinner on the button and "Pushing…" (uploads write their progress into the label).
  function setBusy(on) {
    if (sheet) sheet.busy = on;
    busy(go, on, "Pushing…");
    go.disabled = on || !!(sheet && sheet.blocked);
    cancel.disabled = on;
  }

  const put = (parent, ...kids) => parent.append(...kids.filter(Boolean));
  const fieldEl = (labelText, optional, control, id) =>
    h("div", { class: "field" }, h("label", { class: "field-label", for: id }, labelText, optional ? h("em", null, " (optional)") : null), control);

  /* --- brief --- */
  function buildBrief(body, c) {
    const ch = sheet.choices;
    const refresh = paintDoc;
    sheet.refresh = refresh;

    const client = suggestInput({
      id: "sheetClient", value: ch.client, placeholder: "Type or pick a client",
      options: S.clients, onChange: (v) => { ch.client = v; refresh(); },
    });
    const bd = peoplePicker({
      id: "sheetBd", selected: ch.bd, pool: S.pool, placeholder: "Add a BD",
      onChange: (list) => { ch.bd = list; refresh(); },
    });
    const vatSeg = h("div", { class: "chips", role: "radiogroup", "aria-label": "VAT" },
      ["12%", "0%"].map(v => h("button", { type: "button", class: "chip-opt", role: "radio", "aria-checked": String(ch.vat === v),
        onclick: (e) => {
          ch.vat = v;
          for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-checked", String(b.textContent === v));
          refresh();
        } }, v)));
    radioKeys(vatSeg);
    const said = vatMentions(c.record.fields["Remarks"]);
    const linksBox = h("div", { class: "field" });
    const showLinks = () => {
      const ta = h("textarea", { id: "sheetLinks", rows: "2", placeholder: "Paste links, one per line" });
      ta.value = ch.otherLinks;
      ta.addEventListener("input", () => { ch.otherLinks = ta.value; refresh(); });
      linksBox.replaceChildren(h("label", { class: "field-label", for: "sheetLinks" }, "Other Links", h("em", null, " (optional)")), ta);
      return ta;
    };
    if (ch.showLinks || ch.otherLinks) showLinks();
    else linksBox.replaceChildren(h("button", { type: "button", class: "linkish", onclick: () => { ch.showLinks = true; showLinks().focus(); } },
      ic("plus"), "Add other links"));

    put(body,
      fieldEl("Client", true, client, "sheetClient"),
      fieldEl("BD", true, bd, "sheetBd"),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "VAT"), vatSeg),
      said.length ? h("p", { class: "note" }, `Note: the brief says "${said.join(" ")}"`) : null,
      linksBox);
    refresh();
  }

  /* --- ANDON --- */
  function andonPayload(c, ch) {
    return writableOnly(andonFromBrief(c, ch, RULES, ctx.optionsOf("andon")), ctx.fieldsOf("andon"));
  }
  function buildAndon(body, c) {
    const ch = sheet.choices;
    const refresh = paintDoc;
    sheet.refresh = refresh;
    const pm = peoplePicker({
      id: "sheetPm", selected: ch.pm, pool: S.pmPool, placeholder: "Pick the lead PM", single: true,
      head: "Frequent PMs", onChange: (list) => { ch.pm = list; refresh(); },
    });
    const tribes = ctx.optionsOf("andon").TRIBE || [];
    const tribe = h("select", { id: "sheetTribe" }, h("option", { value: "" }, "Not set"), tribes.map(t => h("option", { value: t }, t)));
    tribe.value = ch.tribe;
    tribe.addEventListener("change", () => { ch.tribe = tribe.value; refresh(); });
    put(body,
      fieldEl("PM (LEAD)", true, pm, "sheetPm"),
      fieldEl("TRIBE", true, h("label", { class: "select" }, tribe), "sheetTribe"));
    refresh();
  }

  /* --- PAR --- */
  function buildPar(body, c) {
    const refresh = paintDoc;
    sheet.refresh = refresh;
    if (c.targets.length > 1) {
      const sel = h("select", { id: "sheetTarget" },
        c.targets.map(t => h("option", { value: t.id }, `${t.project || "(no name)"}${t.par ? ` · PAR ${t.par}` : ""}`)));
      sel.value = sheet.targetId;
      sel.addEventListener("change", () => { sheet.targetId = sel.value; refresh(); });
      body.append(fieldEl(`Universe row (${c.targets.length} rows share ${c.code})`, false, h("label", { class: "select" }, sel), "sheetTarget"));
    }
    put(body, c.notes.length ? h("p", { class: "note" }, copyableText(`Note: ${c.notes.join(" ")}`)) : null);
    refresh();
  }

  /* --- invoice (a Collections change) --- */
  // The sheet's title and button, for what the chosen row goes through.
  function verbs(c, action, invalid) {
    if (invalid) return ["Mark as Invalid in Collections", "Mark invalid"];
    if (action === "create") return ["Add to Collections", "Add to Collections"];
    if (action === "link") return ["Add the request number", "Add the number"];
    if (action === "reset") return ["Move back to For Invoicing", "Move back"];
    return c.step === "filed" ? ["Mark as pending approval", "Mark pending"] : ["Move to For Collection", "Move to For Collection"];
  }
  const rowMoney = (row) => (row.amount === null ? "no amount" : fmt.money(row.amount, row.currency));

  function buildInvoice(body, c) {
    const ch = sheet.choices;
    const opts = ctx.collectionOptions();
    const arField = h("div", { class: "field" });
    const blockNote = h("p", { class: "note", role: "status" });
    const details = h("div", { class: "field" });
    const refresh = () => {
      const change = collectionsChange(c, ch, opts, RULES);
      const [title, label] = verbs(c, change.action, ch.invalid);
      $("#sheetTitle").textContent = title;
      if (!sheet.busy) go.querySelector(".label").textContent = label;
      arField.hidden = change.mode !== "create";
      details.hidden = c.step !== "approved";
      sheet.blocked = (change.mode === "create" && !ch.invalid ? c.noNew : "")
        || (ch.invoiceDateOk === false ? "Invoice Date isn't a date Polaris can read. Try Oct 14, 2026, or double-click it to pick one." : "");
      blockNote.hidden = !sheet.blocked;
      blockNote.textContent = sheet.blocked;
      go.disabled = sheet.busy || !!sheet.blocked;
      paintDoc();
    };
    sheet.refresh = refresh;

    // Which row, when there's a choice: rows waiting for a request, older rows
    // without a request number, or a new row.
    const rows = [...c.targets.map(t => [t.id, `${t.row.arName || "(no AR name)"} · ${rowMoney(t.row)} · ` +
                    `${t.row.status || "no status"}${t.row.ir ? ` · request ${t.row.ir}` : ""}` +
                    `${t.action === "link" ? " · add the number only" : ""}`]),
                  ...(c.canCreate ? [["new", "New row"]] : [])];
    let picker = null;
    if (rows.length > 1) {
      const sel = h("select", { id: "sheetRow" }, rows.map(([v, text]) => h("option", { value: v }, text)));
      sel.value = ch.targetId;
      sel.addEventListener("change", () => { ch.targetId = sel.value; refresh(); });
      picker = fieldEl("Collections row", false, h("label", { class: "select" }, sel), "sheetRow");
    }
    const ar = h("input", { type: "text", id: "sheetAr", autocomplete: "off" });
    ar.value = ch.arName;
    ar.addEventListener("input", () => { ch.arName = ar.value; refresh(); });
    arField.replaceChildren(h("label", { class: "field-label", for: "sheetAr" }, "AR Name"), ar);

    // Invoice details, once the request is approved and the invoice issued (optional;
    // they can also be added later from the Collections pane).
    const showDetails = () => {
      const text = (id, key, label, placeholder, onInput) => {
        const el = h("input", { type: "text", id, autocomplete: "off", placeholder });
        el.value = ch[key];
        el.addEventListener("input", () => { ch[key] = el.value; onInput(); });
        return fieldEl(label, true, el, id);
      };
      const date = dateField({ id: "sheetInvDate", value: ch.invoiceDate,
        onChange: (ms, ok) => { ch.invoiceDate = ms; ch.invoiceDateOk = ok; refresh(); } });
      const list = h("ul", { class: "files" });
      const paint = () => {
        list.replaceChildren(...ch.files.map((f, i) => h("li", null, ic("link"),
          h("span", { class: "file-name" }, f.name, " ", h("span", { class: "file-size" }, `(${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB)`)),
          h("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { ch.files.splice(i, 1); paint(); } }, ic("x")))));
        refresh();
      };
      const input = h("input", { type: "file", multiple: true, hidden: true });
      input.addEventListener("change", () => { for (const file of input.files) ch.files.push({ name: file.name, size: file.size, file }); input.value = ""; paint(); });
      paint();
      details.replaceChildren(
        h("p", { class: "subhead" }, "Invoice details"),
        text("sheetInvNo", "invoiceNo", "Invoice Number", "e.g. INV-1680", refresh),
        text("sheetSiNo", "siNo", "SI Number", "e.g. 610", refresh),
        fieldEl("Invoice Date", true, date, "sheetInvDate"),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Invoice", h("em", null, " (optional)")), list,
          h("label", { class: "btn btn-sm file-btn" }, ic("plus"), "Add a file", input),
          h("p", { class: "set-sub" }, "PDF or image, up to 10 MB.")));
      details.style.gap = "12px";
    };
    if (ch.showDetails || ch.invoiceNo || ch.files.length) showDetails();
    else details.replaceChildren(h("button", { type: "button", class: "linkish", onclick: () => {
      ch.showDetails = true; showDetails(); $("#sheetInvNo").focus(); } }, ic("plus"), "Add invoice details"));

    put(body, picker, arField, blockNote,
                c.notes.length ? h("p", { class: "note" }, copyableText(`Note: ${c.notes.join(" ")}`)) : null,
                details);
    refresh();
  }

  /* Invoice details from the sheet, in Lark's write format (files uploaded first,
     their progress reported through onStatus; tokens are kept on the job so a
     retry doesn't upload them twice). */
  async function invoiceDetails(ch, onStatus) {
    const out = {};
    if (ch.invoiceNo.trim()) out["Invoice Number"] = ch.invoiceNo.trim();
    if (ch.siNo.trim()) out["SI Number"] = ch.siNo.trim();
    if (ch.invoiceDate) out["Invoice Date"] = ch.invoiceDate;   // already midnight Manila
    await uploadFiles(ch.files, ctx.tables.collections, onStatus);
    if (ch.files.length) out["Invoice"] = ch.files.map(f => ({ file_token: f.file_token }));
    onStatus("Pushing…");
    return out;
  }

  /* Upload the files that don't have a file_token yet to the table's Base (Lark's
     drive upload_all, as you), one at a time, with progress through onStatus. The
     token is kept on each file, so a retry from the queue doesn't upload it twice. */
  async function uploadFiles(files, table, onStatus) {
    const todo = files.filter(f => !f.file_token);
    for (let i = 0; i < todo.length; i++) {
      if (!todo[i].file) {   // a file object only lives in memory: a reload loses it
        throw Object.assign(new Error("lost file"), { userMessage: `“${todo[i].name}” was lost when the page reloaded. Edit the push and add it again.` });
      }
      const what = todo.length > 1 ? `Uploading ${i + 1} of ${todo.length}` : "Uploading";
      onStatus(`${what}…`);
      todo[i].file_token = await uploadToBase(todo[i].file, table, ctx.token(),
        { onProgress: (p) => onStatus(`${what} ${Math.round(p * 100)}%`) });
    }
  }

  /* Push: the sheet closes at once and the write goes to the queue (js/queue.js),
     which runs it exactly as the sheet used to, one at a time. The card leaves the
     list and the next one is ready to review. */
  async function runPush() {
    if (!sheet || sheet.busy || sheet.blocked) return;
    const s = sheet, c = s.card;
    const job = { choices: s.choices, clientToken: s.clientToken, targetId: s.targetId, invalid: !!s.invalid };
    const entry = preview(c, job);
    s.done = true;
    S.drafts.delete(draftKey(c) + (s.invalid ? ":invalid" : ""));
    const el = $(`#cards [data-id="${CSS.escape(c.id)}"]`);
    const nextId = el && el.nextElementSibling && el.nextElementSibling.dataset.id;
    dialog.close();
    ctx.queue.add(c, job, entry);
    if (el) await collapse(el);
    ctx.render();
    // Keyboard and mouse both land on the next card's main button.
    const next = nextId && $(`#cards [data-id="${CSS.escape(nextId)}"]`);
    const nextBtn = next && next.querySelector(".item-actions .btn-tonal:not(:disabled)");
    if (nextBtn) nextBtn.focus({ preventScroll: true });
  }

  /* What a push writes, for the entry card and the queue list: the table, the row
     (null for a new one), the cells, and names for the people in them. Computed
     when Push is pressed; the queue computes the payload again when it runs, from
     what Lark has then. */
  function preview(c, job) {
    const ch = job.choices, names = {};
    const addPeople = (v) => people(v).forEach(u => { names[u.id] = u.name; });
    const record = c.record || (c.brief && c.brief.record);
    if (record) for (const f of ["AM", "MKT", "BD"]) addPeople(record.fields[f]);
    for (const list of [ch.bd, ch.pm]) (list || []).forEach(u => { names[u.id] = u.name; });
    if (ch.names instanceof Map) ch.names.forEach((n, id) => { names[id] = n; });
    const base = { code: c.code || "", name: c.name || "", names };
    if (c.kind === "brief") return { ...base, verb: "Push to Universe", table: "universe", rowId: null, fields: universeFromBrief(c, ch, RULES) };
    if (c.kind === "andon") return { ...base, verb: "Add to ANDON", table: "andon", rowId: null, fields: andonPayload(c, ch) };
    if (c.kind === "par") {
      const row = c.targets.find(t => t.id === job.targetId) || c.target;
      return { ...base, verb: `Add PAR ${c.requestNo}`, table: "universe", rowId: row.id,
               fields: { PAR: parAfterAdding(row.par, c.requestNo) || row.par } };
    }
    if (c.kind === "audit") {
      const fields = auditPatch(c, auditRow(c), ch, RULES, auditOpts(c));
      // The signed CE shows by file name (the write itself uses the uploaded tokens).
      for (const k of c.files || []) if (k in fields) fields[k] = (ch.files || []).map(f => ({ name: f.name }));
      const n = Object.keys(fields).length;
      return { ...base, verb: `Fill ${n} blank${n === 1 ? "" : "s"} in ${AUDIT_WHERE[c.target]}`, table: c.target, rowId: c.rowId, fields };
    }
    const change = collectionsChange(c, ch, ctx.collectionOptions(), RULES);
    const fields = { ...change.fields };
    if (c.step === "approved") {
      if (ch.invoiceNo && ch.invoiceNo.trim()) fields["Invoice Number"] = ch.invoiceNo.trim();
      if (ch.siNo && ch.siNo.trim()) fields["SI Number"] = ch.siNo.trim();
      if (ch.invoiceDate) fields["Invoice Date"] = ch.invoiceDate;
      if (ch.files && ch.files.length) fields["Invoice"] = ch.files.map(f => ({ name: f.name }));
    }
    return { ...base, verb: verbs(c, change.action, job.invalid)[0], table: "collections",
             rowId: change.mode === "update" ? change.rowId : null, fields };
  }

  /* The write itself, for the queue. Resolves { res, payload, extra }; throws
     the same errors the sheet used to show (AlreadyDone, uncertain, dead token…). */
  async function perform(c, job, { onStatus = () => {} } = {}) {
    let res, payload, extra = {};
    const ch = job.choices;
    if (c.kind === "brief") {
      payload = universeFromBrief(c, ch, RULES);
      extra = { bd: (ch.bd || []).map(u => ({ id: u.id, name: u.name })) };
      res = await pushBrief(ctx.call, ctx.tables, RULES, c, payload, job.clientToken);
    } else if (c.kind === "andon") {
      payload = andonPayload(c, ch);
      res = await pushAndon(ctx.call, ctx.tables, RULES, c, payload, job.clientToken);
    } else if (c.kind === "par") {
      res = await pushPar(ctx.call, ctx.tables, RULES, c, job.targetId);
    } else if (c.kind === "audit") {
      payload = auditPatch(c, auditRow(c), ch, RULES, auditOpts(c));
      const missing = auditMissing(c, payload);
      if (missing.length) {   // refused here too, not only in the sheet
        throw Object.assign(new Error("required"), { userMessage: `A won project needs ${missing.join(" and ")}.` });
      }
      const noFile = auditFilesMissing(c, ch);
      if (noFile.length) throw Object.assign(new Error("no file"), { userMessage: `Add the file for ${noFile.join(", ")}.` });
      // The signed CE: upload its files first (a failed upload writes nothing), then
      // the cell gets their tokens, with the rest of the Fill.
      if ((c.files || []).some(k => k in payload)) {
        await uploadFiles(ch.files, ctx.tables[c.target], onStatus);
        payload = auditPatch(c, auditRow(c), ch, RULES, auditOpts(c));
        onStatus("Pushing…");
      }
      if (Object.values(payload).some(v => Array.isArray(v) && v.some(x => x && x.name && !x.file_token))) {
        throw Object.assign(new Error("not uploaded"), { userMessage: "A file didn't upload. Try again." });
      }
      res = await fillGaps(ctx.call, ctx.tables[c.target], c.rowId, payload);
    } else {
      const change = collectionsChange(c, { ...ch, invalid: job.invalid }, ctx.collectionOptions(), RULES);
      if (c.step === "approved") Object.assign(change.fields, await invoiceDetails(ch, onStatus));
      payload = change.fields;
      const t = c.targets.find(x => x.id === change.rowId);
      extra = { action: change.action, rowName: t ? t.row.arName : payload["AR Name"] };
      res = await pushCollections(ctx.call, ctx.tables, RULES, c, change, job.clientToken);
    }
    return { res, payload, extra };
  }

  /* Open the sheet again for a queued push (Edit in the queue), with what was chosen. */
  function reopen(c, job) {
    S.drafts.set(draftKey(c) + (job.invalid ? ":invalid" : ""),
                 { choices: job.choices, clientToken: job.clientToken, targetId: job.targetId });
    openSheet(c, { invalid: job.invalid });
  }

  /* ======================= small inputs ======================= */

  /* A text input with suggestions (free text allowed). */
  function suggestInput({ id, value, placeholder, options, onChange }) {
    const input = h("input", { type: "text", id, autocomplete: "off", placeholder, role: "combobox",
                               "aria-autocomplete": "list", "aria-expanded": "false" });
    input.value = value || "";
    const list = h("ul", { class: "suggest", role: "listbox", hidden: true });
    const wrap = h("div", { class: "picker" }, input, list);
    let items = [], active = -1;
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const pick = (v) => { input.value = v; onChange(v); close(); };
    const show = () => {
      const q = input.value.trim().toLowerCase();
      items = q ? options.filter(o => o.toLowerCase().includes(q) && o.toLowerCase() !== q).slice(0, 8) : [];
      active = -1;
      list.replaceChildren(...items.map((o, i) => h("li", { role: "option", "aria-selected": "false",
        onmousedown: (e) => { e.preventDefault(); pick(o); } }, o)));
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!!items.length));
    };
    input.addEventListener("input", () => { onChange(input.value); show(); });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => keyNav(e, list, () => items.length, (i) => { active = i; return active; },
      () => active, () => { if (active >= 0) pick(items[active]); }, close));
    return wrap;
  }

  /* People as chips, picked from everyone seen in the Universe and on briefs. */
  function peoplePicker({ id, selected, pool, placeholder, onChange, single = false, head = "Frequent BDs" }) {
    const chosen = [...selected];
    const input = h("input", { type: "text", id, autocomplete: "off", placeholder, role: "combobox",
                               "aria-autocomplete": "list", "aria-expanded": "false" });
    const chips = h("span", { class: "picker-chips" });
    const box = h("div", { class: "picker-box", onclick: () => input.focus() }, chips, input);
    const list = h("ul", { class: "suggest", role: "listbox", hidden: true });
    const wrap = h("div", { class: "picker" }, box, list);
    let items = [], active = -1;

    const paintChips = () => chips.replaceChildren(...chosen.map((p, i) => h("span", { class: "chip" }, p.name,
      h("button", { type: "button", "aria-label": `Remove ${p.name}`, onclick: (e) => {
        e.stopPropagation(); chosen.splice(i, 1); paintChips(); onChange([...chosen]); input.focus();
      } }, ic("x")))));
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const add = (p) => {
      if (single) chosen.length = 0;
      if (!chosen.some(x => x.id === p.id)) chosen.push({ id: p.id, name: p.name, email: p.email });
      input.value = ""; paintChips(); onChange([...chosen]); show();
    };
    const show = () => {
      const q = input.value.trim().toLowerCase();
      const free = pool.filter(p => !chosen.some(x => x.id === p.id));
      items = q ? free.filter(p => `${p.name} ${p.email}`.toLowerCase().includes(q)).slice(0, 8)
                : free.filter(p => p.bdCount > 0).slice(0, 6);
      active = -1;
      list.replaceChildren(...[
        !q && items.length ? h("li", { class: "suggest-head", role: "presentation" }, head) : null,
        ...items.map((p) => h("li", { role: "option", "aria-selected": "false",
          onmousedown: (e) => { e.preventDefault(); add(p); } }, p.name, p.email ? h("small", null, p.email) : null)),
        q && !items.length ? h("li", { class: "suggest-head", role: "presentation" }, "No one by that name") : null,
      ].filter(Boolean));
      list.hidden = !list.children.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
    };
    input.addEventListener("focus", show);
    input.addEventListener("input", show);
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); paintChips(); onChange([...chosen]); return; }
      keyNav(e, list, () => items.length, (i) => { active = i; return active; }, () => active,
        () => { if (active >= 0) add(items[active]); else if (items.length === 1) add(items[0]); }, close);
    });
    paintChips();
    return wrap;
  }

  /* Arrow keys move through suggestions, Enter picks, Escape closes the list
     (and only the list: the sheet stays open). */
  function keyNav(e, list, count, setActive, getActive, choose, close) {
    const opts = [...list.querySelectorAll('[role="option"]')];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!count()) return;
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(getActive() + 1, count() - 1) : Math.max(getActive() - 1, 0);
      setActive(next);
      opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === next)));
      opts[next] && opts[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose();
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  return { render, renderLoader, perform, preview, reopen, keyOf: draftKey };
}
