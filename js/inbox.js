/* The Inbox: cards for Project Briefs, PARs and Invoice Requests, the push
   sheet (with the BD picker), and Ignore with Undo. */

import { RULES } from "./config.js";
import { TABLE_TITLES, pushBrief, pushPar, pushCollections, pushAndon, setIgnore, AlreadyDone, newClientToken, writableOnly, fillGaps } from "./ops.js";
import {
  universeFromBrief, collectionsChange, stepStatus, parAfterAdding, defaultVat, amountFormula, vatMentions,
  vatExAmount, people, andonFromBrief, auditPatch,
} from "./sync.js";
import { $, h, ic, toast, fmt, flash, copyable, store, collapse, busy, radioKeys } from "./ui.js";
import { dayOnly, copyableText, dateField } from "./polaris-ui.js";
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
const DATE_FIELDS = new Set(["Project Start", "Project End", "RFP Received Date"]);
// Shown as inputs at the top of the brief sheet, so not repeated under "Also written".
const BRIEF_INPUTS = new Set(["Client", "BD", "VAT%", "Amount (VAT-Ex.) (PHP)", "Other Links"]);

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
    const cards = list.cards.filter(c => matches(c, q));
    box.replaceChildren(...cards.map(cardEl));
    empty.hidden = cards.length > 0;
    empty.textContent = q ? `No ${NOUN[S.tab]} match "${q.trim()}".`
      : { brief: "Every brief is in the Universe. Nice work!",
          par: "Every PAR is in the Universe. Nice work!",
          invoice: "Collections is up to date. Nice work!",
          andon: "Every brief is in ANDON. Nice work!",
          audit: "Nothing in the Universe or ANDON is missing what its brief has. Nice work!" }[S.tab];
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
  dialog.addEventListener("close", () => {
    if (sheet && !sheet.done) S.drafts.set(draftKey(sheet.card) + (sheet.invalid ? ":invalid" : ""), { choices: sheet.choices, clientToken: sheet.clientToken, targetId: sheet.targetId });
    sheet = null;
  });
  $("#sheetForm").addEventListener("submit", (e) => e.preventDefault());   // Enter in a field mustn't send
  go.addEventListener("click", runPush);

  /* ======================= the audit: blanks the brief can fill ======================= */
  const AUDIT_WHERE = { universe: "Universe", andon: "ANDON" };
  const auditRow = (c) => (S.data[c.target] || []).find(r => r.record_id === c.rowId) || { fields: {} };
  const auditOpts = (c) => (c.target === "andon" ? { options: ctx.optionsOf("andon"), fields: ctx.fieldsOf("andon") } : {});
  const AUDIT_DATES = new Set(["Project Start", "Project End", "RFP Received Date", "Event Start", "Event End"]);

  /* A value the audit would write, as text (people by name, dates as days). */
  function auditText(c, k, v) {
    const names = new Map();
    for (const f of ["AM", "MKT", "BD"]) people(c.brief.record.fields[f]).forEach(u => names.set(u.id, u.name));
    if (Array.isArray(v)) return v.map(x => (x && x.id ? names.get(x.id) || x.id : String(x))).join(", ");
    if (v && typeof v === "object") return v.text || v.link || "";
    if (AUDIT_DATES.has(k)) return dayOnly(v);
    if (k === "Amount (VAT-Ex.) (PHP)") return fmt.peso(v);
    return String(v);
  }

  function auditCardEl(c) {
    const writable = ctx.canWriteFor(`audit:${c.target}`);
    return h("article", { class: "card item" + (S.working.has(c.id) ? " is-working" : "") + (S.entering.has(c.id) ? " is-entering" : ""),
                          "data-id": c.id },
      h("div", { class: "item-head" },
        copyable(c.code, { label: "project code", cls: "code" }),
        h("span", { class: "badge badge-info" }, AUDIT_WHERE[c.target]),
        h("span", { class: "item-date" }, c.submittedAt ? `Brief ${fmt.day(c.submittedAt)}` : "")),
      h("h3", null, c.name || "(no name)"),
      h("p", { class: "item-meta" }, h("b", null, `${c.gaps.length} blank`), ` in ${AUDIT_WHERE[c.target]} that the brief `,
        copyable(c.requestNo, { label: "request number" }), " can fill", c.status ? ` · ${c.status}` : ""),
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
    // Names for people shown in "Will be written" (the brief's, plus anyone picked here).
    ch.names = ch.names || new Map();
    for (const f of ["AM", "MKT", "BD"]) people(c.brief.record.fields[f]).forEach(u => ch.names.set(u.id, u.name));
    const fromBrief = () => auditPatch(c, row, { fields: c.gaps, vat: ch.vat }, RULES, opts);
    if (!ch.values) ch.values = { ...fromBrief() };
    ch.edited = ch.edited || [];
    ch.bad = ch.bad || [];

    const written = h("dl", { class: "written" });
    const vatBox = h("div", { class: "field" });
    const show = (k, v) => {
      if (Array.isArray(v)) return v.map(x => (x && x.id ? ch.names.get(x.id) || x.id : String(x))).join(", ");
      if (AUDIT_DATES.has(k)) return dayOnly(v);
      if (k === AMOUNT) return fmt.peso(v);
      return String(v);
    };
    const refresh = () => {
      const patch = auditPatch(c, row, ch, RULES, opts);
      const n = Object.keys(patch).length;
      const bad = ch.bad.filter(k => ch.fields.includes(k));
      sheet.blocked = bad.length ? `Check ${bad.join(", ")}: ${bad.length === 1 ? "it isn't" : "they aren't"} valid yet.`
        : n ? "" : "Tick at least one field to fill.";
      go.disabled = sheet.busy || !!sheet.blocked;
      if (!sheet.busy) go.querySelector(".label").textContent = n ? `Fill ${n} field${n === 1 ? "" : "s"}` : "Fill";
      blockNote.hidden = !sheet.blocked || !n;
      blockNote.textContent = sheet.blocked;
      vatBox.hidden = !(c.needsVat && ch.fields.includes(AMOUNT));
      written.replaceChildren(...Object.entries(patch).flatMap(([k, v]) => [h("dt", null, k),
        h("dd", { class: String(v).length > 140 ? "is-long" : "" }, show(k, v),
          h("span", { class: "why" }, ch.edited.includes(k) ? "Was blank. Edited here." : "Was blank. From the brief."))]));
    };
    sheet.refresh = refresh;
    const blockNote = h("p", { class: "note", role: "status", hidden: true });

    // One row per blank: tick box, name, and an editor that fits the column.
    const tick = {};
    const changed = (k, v, ok = true) => {
      ch.values[k] = v;
      if (!ch.edited.includes(k)) ch.edited.push(k);
      ch.bad = ok ? ch.bad.filter(x => x !== k) : [...new Set([...ch.bad, k])];
      if (!ch.fields.includes(k)) { ch.fields.push(k); tick[k].checked = true; }
      refresh();
    };
    let amountInput = null;
    const editor = (k) => {
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
      box.checked = ch.fields.includes(k);
      tick[k] = box;
      box.addEventListener("change", () => {
        ch.fields = box.checked ? [...ch.fields, k] : ch.fields.filter(x => x !== k);
        refresh();
      });
      return h("div", { class: "gap" },
        h("label", { class: "gap-head", for: box.id }, box, h("b", null, k)),
        editor(k));
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
      vatBox.replaceChildren(h("span", { class: "field-label" }, "VAT"), seg,
        h("p", { class: "set-sub" }, "The row has no VAT%, so the amount needs one. It's written to VAT% too."));
    }
    put(body,
      h("p", { class: "set-sub" }, copyableText(`Blank in the ${AUDIT_WHERE[c.target]} row. Filled in from brief ${c.requestNo}; ` +
        "change anything that's out of date. Cells that have a value are never changed.")),
      h("div", { class: "gaps" }, rows), vatBox, blockNote,
      h("p", { class: "subhead" }, "Will be written"), written);
    refresh();
  }

  function defaults(c) {
    if (c.kind === "brief") return { vat: defaultVat(c.currency), client: "", bd: [], otherLinks: "", showLinks: false };
    if (c.kind === "invoice") {
      return { targetId: c.target, arName: c.name, invoiceNo: "", siNo: "", invoiceDate: null, invoiceDateOk: true, files: [], showDetails: false };
    }
    if (c.kind === "andon") return { pm: [], tribe: "" };
    if (c.kind === "audit") return { fields: [...c.gaps], vat: defaultVat(c.brief.currency), values: null, edited: [], bad: [] };
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
    const amountEl = h("div", { class: "amount" });
    const written = h("dl", { class: "written" });
    const refresh = () => {
      const amount = vatExAmount(c.value, c.currency, ch.vat, RULES);
      amountEl.replaceChildren(
        h("b", null, amount === null ? "Not written" : fmt.peso(amount)),
        h("span", null, `Amount (VAT-Ex.) (PHP) · ${amountFormula(c.value, c.currency, ch.vat, RULES)}`));
      const payload = universeFromBrief(c, ch, RULES);
      const names = new Map();
      for (const k of ["AM", "MKT"]) people(c.record.fields[k]).forEach(u => names.set(u.id, u.name));
      written.replaceChildren(...Object.entries(payload).filter(([k]) => !BRIEF_INPUTS.has(k)).flatMap(([k, v]) => {
        let text = Array.isArray(v) ? v.map(u => names.get(u.id) || u.id).join(", ")
                 : DATE_FIELDS.has(k) ? dayOnly(v) : String(v);
        return [h("dt", null, k), h("dd", { class: text.length > 140 || text.includes("\n") ? "is-long" : "" }, text)];
      }));
    };
    sheet.refresh = refresh;

    const client = suggestInput({
      id: "sheetClient", value: ch.client, placeholder: "Not on the brief. Type or pick a client",
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
      h("div", { class: "field" }, h("span", { class: "field-label" }, "VAT"), h("div", { class: "vat" }, vatSeg, amountEl)),
      said.length ? h("p", { class: "note" }, `Note: the brief says "${said.join(" ")}"`) : null,
      linksBox,
      h("p", { class: "subhead" }, "Also written"),
      written);
    refresh();
  }

  /* --- ANDON --- */
  function andonPayload(c, ch) {
    return writableOnly(andonFromBrief(c, ch, RULES, ctx.optionsOf("andon")), ctx.fieldsOf("andon"));
  }
  function buildAndon(body, c) {
    const ch = sheet.choices;
    const written = h("dl", { class: "written" });
    const refresh = () => {
      const payload = andonPayload(c, ch);
      const names = new Map();
      for (const k of ["AM", "MKT"]) people(c.record.fields[k]).forEach(u => names.set(u.id, u.name));
      written.replaceChildren(...Object.entries(payload).filter(([k]) => k !== "PM (LEAD)" && k !== "TRIBE").flatMap(([k, v]) => {
        const text = Array.isArray(v) ? v.map(x => (x && x.id ? names.get(x.id) || x.id : String(x))).join(", ")
                   : v && typeof v === "object" ? v.text || v.link
                   : k.startsWith("Event ") ? dayOnly(v) : String(v);
        return [h("dt", null, k), h("dd", { class: text.length > 140 || text.includes("\n") ? "is-long" : "" }, text)];
      }));
    };
    sheet.refresh = refresh;
    const pm = peoplePicker({
      id: "sheetPm", selected: ch.pm, pool: S.pmPool, placeholder: "Pick the lead PM", single: true,
      head: "Frequent PMs", onChange: (list) => { ch.pm = list; refresh(); },
    });
    const tribes = ctx.optionsOf("andon").TRIBE || [];
    const tribe = h("select", { id: "sheetTribe" }, h("option", { value: "" }, "Not set"), tribes.map(t => h("option", { value: t }, t)));
    tribe.value = ch.tribe;
    tribe.addEventListener("change", () => { ch.tribe = tribe.value; refresh(); });
    const computed = ctx.computedOf("andon");
    put(body,
      fieldEl("PM (LEAD)", true, pm, "sheetPm"),
      fieldEl("TRIBE", true, h("label", { class: "select" }, tribe), "sheetTribe"),
      computed.length ? h("p", { class: "set-sub" }, `ANDON fills ${computed.join(", ")} itself.`) : null,
      h("p", { class: "subhead" }, "Also written"),
      written);
    refresh();
  }

  /* --- PAR --- */
  function buildPar(body, c) {
    const written = h("dl", { class: "written" });
    const ctxLine = h("p", { class: "set-sub" });
    const refresh = () => {
      const row = c.targets.find(t => t.id === sheet.targetId) || c.target;
      const next = parAfterAdding(row.par, c.requestNo) || row.par;
      ctxLine.replaceChildren(...copyableText(`Goes into the Universe row "${row.project || row.codeText}" (${c.code}).`));
      written.replaceChildren(h("dt", null, "PAR"),
        h("dd", null, copyableText(next), h("span", { class: "why" }, row.par ? `Was ${row.par}. The new number is added after it.` : "Was empty.")));
    };
    sheet.refresh = refresh;
    if (c.targets.length > 1) {
      const sel = h("select", { id: "sheetTarget" },
        c.targets.map(t => h("option", { value: t.id }, `${t.project || "(no name)"}${t.par ? ` · PAR ${t.par}` : ""}`)));
      sel.value = sheet.targetId;
      sel.addEventListener("change", () => { sheet.targetId = sel.value; refresh(); });
      body.append(fieldEl(`Universe row (${c.targets.length} rows share ${c.code})`, false, h("label", { class: "select" }, sel), "sheetTarget"));
    }
    put(body, ctxLine, c.notes.length ? h("p", { class: "note" }, copyableText(`Note: ${c.notes.join(" ")}`)) : null,
                h("p", { class: "subhead" }, "Will be written"), written);
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
  const cellText = (k, v) => (v === null || v === undefined || v === "" ? "(empty)"
    : k === "Invoice Amount" ? fmt.money(v) : String(v));

  function buildInvoice(body, c) {
    const ch = sheet.choices;
    const opts = ctx.collectionOptions();
    const flow = h("p", { class: "flow flow-sheet" });
    const arField = h("div", { class: "field" });
    const blockNote = h("p", { class: "note", role: "status" });
    const written = h("dl", { class: "written" });
    const details = h("div", { class: "field" });
    const refresh = () => {
      const change = collectionsChange(c, ch, opts, RULES);
      const [title, label] = verbs(c, change.action, ch.invalid);
      $("#sheetTitle").textContent = title;
      if (!sheet.busy) go.querySelector(".label").textContent = label;
      flow.replaceChildren(...flowEl(c, ch.targetId, ch.invalid));
      arField.hidden = change.mode !== "create";
      details.hidden = c.step !== "approved";
      sheet.blocked = (change.mode === "create" && !ch.invalid ? c.noNew : "")
        || (ch.invoiceDateOk === false ? "Invoice Date isn't a date Polaris can read. Try Oct 14, 2026, or double-click it to pick one." : "");
      blockNote.hidden = !sheet.blocked;
      blockNote.textContent = sheet.blocked;
      go.disabled = sheet.busy || !!sheet.blocked;
      written.replaceChildren(...Object.entries(change.fields)
        .filter(([k]) => change.mode !== "create" || k !== "AR Name")
        .flatMap(([k, v]) => [h("dt", null, k), h("dd", null, cellText(k, v),
          change.mode === "update" ? h("span", { class: "why" }, change.before[k] === null || change.before[k] === undefined
            ? "Was empty." : `Was ${cellText(k, change.before[k])}.`) : null)]));
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
      const text = (id, key, label, placeholder) => {
        const el = h("input", { type: "text", id, autocomplete: "off", placeholder });
        el.value = ch[key];
        el.addEventListener("input", () => { ch[key] = el.value; });
        return fieldEl(label, true, el, id);
      };
      const date = dateField({ id: "sheetInvDate", value: ch.invoiceDate,
        onChange: (ms, ok) => { ch.invoiceDate = ms; ch.invoiceDateOk = ok; refresh(); } });
      const list = h("ul", { class: "files" });
      const paint = () => list.replaceChildren(...ch.files.map((f, i) => h("li", null, ic("link"),
        h("span", { class: "file-name" }, f.name, " ", h("span", { class: "file-size" }, `(${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB)`)),
        h("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { ch.files.splice(i, 1); paint(); } }, ic("x")))));
      const input = h("input", { type: "file", multiple: true, hidden: true });
      input.addEventListener("change", () => { for (const file of input.files) ch.files.push({ name: file.name, size: file.size, file }); input.value = ""; paint(); });
      paint();
      details.replaceChildren(
        h("p", { class: "subhead" }, "Invoice details"),
        text("sheetInvNo", "invoiceNo", "Invoice Number", "e.g. INV-1680"),
        text("sheetSiNo", "siNo", "SI Number", "e.g. 610"),
        fieldEl("Invoice Date", true, date, "sheetInvDate"),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Invoice", h("em", null, " (optional)")), list,
          h("label", { class: "btn btn-sm file-btn" }, ic("plus"), "Add a file", input),
          h("p", { class: "set-sub" }, "PDF or image, up to 10 MB each. Uploaded when you push.")));
      details.style.gap = "12px";
    };
    if (ch.showDetails || ch.invoiceNo || ch.files.length) showDetails();
    else details.replaceChildren(h("button", { type: "button", class: "linkish", onclick: () => {
      ch.showDetails = true; showDetails(); $("#sheetInvNo").focus(); } }, ic("plus"), "Add invoice details (number, SI, date, file)"));

    put(body, picker, flow, arField, blockNote,
                c.notes.length ? h("p", { class: "note" }, copyableText(`Note: ${c.notes.join(" ")}`)) : null,
                details,
                h("p", { class: "subhead" }, "Will be written"), written);
    refresh();
  }

  /* Invoice details from the sheet, in Lark's write format (files uploaded first,
     with their progress on the button; tokens are kept on the sheet so a retry
     doesn't upload them twice). */
  async function invoiceDetails(ch) {
    const out = {};
    if (ch.invoiceNo.trim()) out["Invoice Number"] = ch.invoiceNo.trim();
    if (ch.siNo.trim()) out["SI Number"] = ch.siNo.trim();
    if (ch.invoiceDate) out["Invoice Date"] = ch.invoiceDate;   // already midnight Manila
    const todo = ch.files.filter(f => !f.file_token);
    const label = go.querySelector(".label");
    for (let i = 0; i < todo.length; i++) {
      const what = todo.length > 1 ? `Uploading ${i + 1} of ${todo.length}` : "Uploading";
      label.textContent = `${what}…`;
      todo[i].file_token = await uploadToBase(todo[i].file, ctx.tables.collections, ctx.token(),
        { onProgress: (p) => { label.textContent = `${what} ${Math.round(p * 100)}%`; } });
    }
    if (ch.files.length) out["Invoice"] = ch.files.map(f => ({ file_token: f.file_token }));
    label.textContent = "Pushing…";
    return out;
  }

  async function runPush() {
    if (!sheet || sheet.busy) return;
    const c = sheet.card;
    // Several uploads can take a while: ask for 2 minutes of login instead of 1.
    const uploads = c.kind === "invoice" && c.step === "approved" ? sheet.choices.files.filter(f => !f.file_token).length : 0;
    if (!ctx.ensureTime(uploads > 1 ? 120000 : 60000)) return;
    $("#sheetError").hidden = true;
    setBusy(true);
    S.working.add(c.id);
    const s = sheet;
    await ctx.track(() => push(c, s));    // the session clock waits for a write that's running
  }

  async function push(c, s) {
    try {
      let res, payload, extra = {};
      if (c.kind === "brief") {
        payload = universeFromBrief(c, s.choices, RULES);
        extra = { bd: s.choices.bd.map(u => ({ id: u.id, name: u.name })) };
        res = await pushBrief(ctx.call, ctx.tables, RULES, c, payload, s.clientToken);
      } else if (c.kind === "andon") {
        payload = andonPayload(c, s.choices);
        res = await pushAndon(ctx.call, ctx.tables, RULES, c, payload, s.clientToken);
      } else if (c.kind === "par") {
        res = await pushPar(ctx.call, ctx.tables, RULES, c, s.targetId);
      } else if (c.kind === "audit") {
        payload = auditPatch(c, auditRow(c), s.choices, RULES, auditOpts(c));
        res = await fillGaps(ctx.call, ctx.tables[c.target], c.rowId, payload);
      } else {
        const change = collectionsChange(c, s.choices, ctx.collectionOptions(), RULES);
        if (c.step === "approved") Object.assign(change.fields, await invoiceDetails(s.choices));
        payload = change.fields;
        const t = c.targets.find(x => x.id === change.rowId);
        extra = { action: change.action, rowName: t ? t.row.arName : payload["AR Name"] };
        res = await pushCollections(ctx.call, ctx.tables, RULES, c, change, s.clientToken);
      }
      s.done = true;
      S.drafts.delete(draftKey(c) + (s.invalid ? ":invalid" : ""));
      S.working.delete(c.id);
      setBusy(false);
      dialog.close();
      await ctx.afterPush(c, res, payload, extra);
    } catch (err) {
      S.working.delete(c.id);
      setBusy(false);
      if (err instanceof AlreadyDone) {
        s.done = true;
        S.drafts.delete(draftKey(c) + (s.invalid ? ":invalid" : ""));
        dialog.close();
        toast(err.message, { type: "info", detail: s.unsure
          ? "It may have been your earlier try. The list has been refreshed."
          : err.detail || "Someone else already did this. The list has been refreshed." });
        ctx.loadData({ quiet: true });
        return;
      }
      if (isDeadToken(err)) { dialog.close(); return; }   // the session already ended (net.js)
      if (isUncertain(err)) return recheck(c, s, err);
      // Lark answered with an error, or the failure came before anything was written.
      const box = $("#sheetError");
      box.textContent = `Nothing was written. ${describe(err)}`;
      box.hidden = false;
    }
  }

  /* A write that may have landed (it timed out, or the connection dropped after
     it was sent). Look at Lark before the person can try again: if the card has
     left the refreshed list, the write is there. */
  async function recheck(c, s, err) {
    s.unsure = true;
    const box = $("#sheetError");
    box.textContent = describe(err);
    box.hidden = false;
    s.busy = true;
    busy(go, true, "Checking Lark…");
    cancel.disabled = true;
    const was = S.loadedAt;
    await ctx.loadData({ quiet: true });
    if (sheet !== s) return;                 // the sheet closed meanwhile (the session ended)
    setBusy(false);
    if (S.loadedAt === was) return;          // couldn't look: the message above stands
    const there = S.lists && (S.lists[c.kind] || { cards: [] }).cards.some(x => x.id === c.id && x.step === c.step);
    if (there) {
      box.textContent = `${describe(err)} A fresh look at Lark shows it isn't there yet, so it's safe to try again.`;
      return;
    }
    s.done = true;
    S.drafts.delete(draftKey(c) + (s.invalid ? ":invalid" : ""));
    dialog.close();
    toast("It's in Lark.", { type: "info", detail: "Polaris didn't hear back at first, but a fresh look shows it's done. The list has been refreshed." });
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

  return { render, renderLoader };
}
