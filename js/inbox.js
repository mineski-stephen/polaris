/* The Inbox: cards for Project Briefs, PARs and Invoice Requests, the push
   sheet (with the BD picker), and Ignore with Undo. */

import { RULES } from "./config.js";
import { TABLE_TITLES, pushBrief, pushPar, pushCollections, pushAndon, setIgnore, AlreadyDone, newClientToken, writableOnly } from "./ops.js";
import {
  universeFromBrief, collectionsChange, stepStatus, parAfterAdding, defaultVat, amountFormula, vatMentions,
  vatExAmount, people, andonFromBrief,
} from "./sync.js";
import { $, h, ic, toast, fmt, flash, reduceMotion, copyable, copyableText } from "./ui.js";
import { describe, isDeadToken, conn, uploadToBase } from "./net.js";

const NOUN = { brief: "briefs", par: "PARs", invoice: "invoices", andon: "briefs for ANDON" };
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
    search.placeholder = `Search ${NOUN[S.tab]}`;
    if (search.value !== S.query[S.tab]) search.value = S.query[S.tab];
    $("#refreshBtn").classList.toggle("is-busy", S.loading);
    $("#refreshBtn").disabled = S.loading;
    $("#updated").textContent = S.loading && S.quiet ? "Refreshing…"
      : S.loadedAt ? `Updated ${fmt.time(S.loadedAt)}` : "";
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
        done ? ic("check") : st ? h("span", { class: "spinner" }) : h("span", { class: "dot" }),
        TABLE_TITLES[k], h("span", { class: "n" }, st ? `${st.n.toLocaleString()}${st.total ? ` of ${st.total.toLocaleString()}` : ""}` : ""));
    }));
    el.replaceChildren(...head, ...(S.waking ? [] : [stages]));
  }

  function matches(c, q) {
    if (!q) return true;
    const am = c.am ? c.am.map(u => u.name).join(" ") : "";
    return `${c.code} ${c.name} ${c.requestNo} ${c.status} ${am}`.toLowerCase().includes(q.toLowerCase().trim());
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
          andon: "Every brief is in ANDON. Nice work!" }[S.tab];
    hiddenNote.textContent = hiddenSummary(list.hidden);
    S.entering.clear();
    if (S.flashCard) {
      const el = box.querySelector(`[data-id="${S.flashCard}"]`);
      S.flashCard = null;
      if (el) { el.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }); flash(el); }
    }
  }

  function hiddenSummary(hd) {
    const label = {
      done: { invoice: "already up to date in Collections", andon: "already in ANDON" }[S.tab] || "already in the Universe",
      ignored: "ignored", void: "rejected, recalled or cancelled",
      otherDept: "from other departments", noProject: "for projects not in the Universe",
      closed: "for closed or lost projects",
    };
    const parts = Object.keys(label).filter(k => hd[k] > 0).map(k => `${hd[k].toLocaleString()} ${label[k]}`);
    return parts.length ? `Not shown: ${parts.join(" · ")}.` : "";
  }

  function cardEl(c) {
    const writable = ctx.canWriteFor(c.kind);
    const notes = [];
    let meta;
    if (c.kind === "brief" || c.kind === "andon") {
      meta = [c.value !== null ? h("b", null, fmt.money(c.value, c.currency)) : "No contract value",
              c.am.length ? h("span", { title: c.am.map(u => u.name).join(", ") }, ` · AM ${c.am.map(u => u.short).join(", ")}`) : "",
              c.kind === "andon" && c.department ? ` · ${c.department}` : ""];
      c.problems.forEach(p => notes.push(h("li", { class: "is-block" }, p)));
      if (c.similar) {
        notes.push(h("li", null, copyableText(`Note: looks like "${c.similar.project}"${c.similar.code ? ` (${c.similar.code})` : ""}, ` +
          `already in ${c.kind === "andon" ? "ANDON" : "the Universe"}. If it's the same project, ignore this one.`)));
      }
    } else if (c.kind === "par") {
      const t = c.target;
      meta = ["PAR ", copyable(c.requestNo),
              t ? ` · goes to "${t.project || t.codeText}"` : "",
              t && t.par ? [" (already has ", copyableText(t.par), ")"] : ""];
      c.notes.forEach(n => notes.push(h("li", null, copyableText(`Note: ${n}`))));
    } else {
      const t = c.targets.find(x => x.id === c.target);
      meta = [c.amount !== null ? h("b", null, fmt.money(c.amount, c.currency)) : "No amount",
              c.step === "won" ? ` · Amount (VAT-Inc.) · Universe: ${c.status}` : [" · request ", copyable(c.requestNo)],
              !t && c.existing ? ` · ${c.existing} already in Collections for this project` : ""];
      notes.unshift(h("li", { class: "flow" }, flowEl(c, c.target)));
      c.notes.forEach(n => notes.push(h("li", null, copyableText(`Note: ${n}`))));
    }
    if (c.blocked) notes.push(h("li", { class: "is-block" }, c.blocked, fixLink(c.blocked, c.code)));
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
    const before = rec.fields[box];
    const what = c.requestNo && c.kind !== "brief" && c.kind !== "andon" ? `${c.code} · ${c.requestNo}` : c.code;
    const apply = (v) => { rec.fields[box] = v; ctx.recompute(); ctx.render(); };

    if (value && button) {   // let the card slide out, then drop it
      const el = button.closest(".item");
      if (el && !reduceMotion()) { el.classList.add("is-leaving"); await new Promise(r => setTimeout(r, 160)); }
    }
    if (!value) { S.entering.add(c.id); S.flashCard = c.id; }
    apply(value);
    const closeToast = value
      ? toast(`Ignored ${what}.`, { action: "Undo", onAction: () => ignore(c, false),
          detail: c.kind === "brief" || c.kind === "andon" ? "It's hidden from both the Universe and ANDON lists." : undefined })
      : toast(`${what} is back in the list.`, { type: "success" });
    S.working.add(c.id);
    try {
      const res = await setIgnore(ctx.call, ctx.tables[src], c.id, value, box);
      if (res.readBackError || (res.mismatches && res.mismatches.length)) {
        toast(`Lark didn't confirm the change to ${what}.`, { type: "warn", timeout: 0,
          detail: `Check its ${box} box in Lark.`, link: { href: ctx.tables[src].url, text: "Open in Lark" } });
      }
    } catch (err) {
      apply(before);                       // roll back, and say why
      closeToast();
      if (isDeadToken(err)) return ctx.sessionEnded();
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

  function defaults(c) {
    if (c.kind === "brief") return { vat: defaultVat(c.currency), client: "", bd: [], otherLinks: "", showLinks: false };
    if (c.kind === "invoice") {
      return { targetId: c.target, arName: c.name, invoiceNo: "", siNo: "", invoiceDate: "", files: [], showDetails: false };
    }
    if (c.kind === "andon") return { pm: [], tribe: "" };
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
    $("#sheetTitle").textContent = { brief: "Push to Universe", par: "Add PAR to Universe", invoice: "Add to Collections", andon: "Add to ANDON" }[c.kind];
    $("#sheetSub").replaceChildren(copyable(c.code, { label: "project code", empty: "No code" }),
      (c.kind === "par" || c.kind === "invoice") && c.requestNo ? [" · request ", copyable(c.requestNo)] : "", ` · ${c.name}`);
    go.querySelector(".btn-label").textContent = { brief: "Push to Universe", par: "Add PAR", invoice: "Add to Collections", andon: "Add to ANDON" }[c.kind];
    $("#sheetError").hidden = true;
    const body = $("#sheetBody");
    body.replaceChildren();
    if (c.kind === "brief") buildBrief(body, c);
    else if (c.kind === "par") buildPar(body, c);
    else if (c.kind === "andon") buildAndon(body, c);
    else buildInvoice(body, c);
    setBusy(false);
    dialog.showModal();
    const first = body.querySelector("input, select, textarea");
    (first || cancel).focus();
  }

  function setBusy(busy) {
    if (sheet) sheet.busy = busy;
    go.disabled = busy || !!(sheet && sheet.blocked);
    cancel.disabled = busy;
    const label = go.querySelector(".btn-label");
    go.querySelector(".spinner")?.remove();
    if (busy) {
      go.dataset.idle = label.textContent;
      label.textContent = "Pushing…";
      go.prepend(h("span", { class: "spinner", "aria-hidden": "true" }));
    } else if (go.dataset.idle) {
      label.textContent = go.dataset.idle;
      delete go.dataset.idle;
    }
  }

  const put = (parent, ...kids) => parent.append(...kids.filter(Boolean));
  const fieldEl = (labelText, optional, control, id) =>
    h("div", { class: "field" }, h("label", { class: "label", for: id }, labelText, optional ? h("em", null, " (optional)") : null), control);

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
                 : DATE_FIELDS.has(k) ? fmt.dayOnly(v) : String(v);
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
    const vatSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "VAT" },
      ["12%", "0%"].map(v => h("button", { type: "button", role: "radio", "aria-checked": String(ch.vat === v),
        onclick: (e) => {
          ch.vat = v;
          for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-checked", String(b.textContent === v));
          refresh();
        } }, v)));
    const said = vatMentions(c.record.fields["Remarks"]);
    const linksBox = h("div", { class: "field" });
    const showLinks = () => {
      const ta = h("textarea", { id: "sheetLinks", rows: "2", placeholder: "Paste links, one per line" });
      ta.value = ch.otherLinks;
      ta.addEventListener("input", () => { ch.otherLinks = ta.value; refresh(); });
      linksBox.replaceChildren(h("label", { class: "label", for: "sheetLinks" }, "Other Links", h("em", null, " (optional)")), ta);
      return ta;
    };
    if (ch.showLinks || ch.otherLinks) showLinks();
    else linksBox.replaceChildren(h("button", { type: "button", class: "linkish", onclick: () => { ch.showLinks = true; showLinks().focus(); } },
      ic("plus"), "Add other links"));

    put(body,
      fieldEl("Client", true, client, "sheetClient"),
      fieldEl("BD", true, bd, "sheetBd"),
      h("div", { class: "field" }, h("span", { class: "label" }, "VAT"), h("div", { class: "vat" }, vatSeg, amountEl)),
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
                   : k.startsWith("Event ") ? fmt.dayOnly(v) : String(v);
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
      if (!sheet.busy) go.querySelector(".btn-label").textContent = label;
      flow.replaceChildren(...flowEl(c, ch.targetId, ch.invalid));
      arField.hidden = change.mode !== "create";
      details.hidden = c.step !== "approved";
      sheet.blocked = change.mode === "create" && !ch.invalid ? c.noNew : "";
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
    arField.replaceChildren(h("label", { class: "label", for: "sheetAr" }, "AR Name"), ar);

    // Invoice details, once the request is approved and the invoice issued (optional;
    // they can also be added later from the Collections pane).
    const showDetails = () => {
      const text = (id, key, label, placeholder) => {
        const el = h("input", { type: "text", id, autocomplete: "off", placeholder });
        el.value = ch[key];
        el.addEventListener("input", () => { ch[key] = el.value; });
        return fieldEl(label, true, el, id);
      };
      const date = h("input", { type: "date", id: "sheetInvDate" });
      date.value = ch.invoiceDate;
      date.addEventListener("input", () => { ch.invoiceDate = date.value; });
      const list = h("ul", { class: "files" });
      const paint = () => list.replaceChildren(...ch.files.map((f, i) => h("li", null, ic("link"),
        h("span", null, f.name, ` (${Math.max(1, Math.round(f.size / 1024)).toLocaleString()} KB)`),
        h("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { ch.files.splice(i, 1); paint(); } }, ic("x")))));
      const input = h("input", { type: "file", multiple: true, hidden: true });
      input.addEventListener("change", () => { for (const file of input.files) ch.files.push({ name: file.name, size: file.size, file }); input.value = ""; paint(); });
      paint();
      details.replaceChildren(
        h("p", { class: "subhead" }, "Invoice details"),
        text("sheetInvNo", "invoiceNo", "Invoice Number", "e.g. INV-1680"),
        text("sheetSiNo", "siNo", "SI Number", "e.g. 610"),
        fieldEl("Invoice Date", true, date, "sheetInvDate"),
        h("div", { class: "field" }, h("span", { class: "label" }, "Invoice", h("em", null, " (optional)")), list,
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

  /* Invoice details from the sheet, in Lark's write format (files uploaded first;
     tokens are kept on the sheet so a retry doesn't upload them twice). */
  async function invoiceDetails(ch) {
    const out = {};
    if (ch.invoiceNo.trim()) out["Invoice Number"] = ch.invoiceNo.trim();
    if (ch.siNo.trim()) out["SI Number"] = ch.siNo.trim();
    if (ch.invoiceDate) out["Invoice Date"] = Date.parse(ch.invoiceDate + "T00:00:00Z") - 8 * 3600000;   // midnight Manila
    const todo = ch.files.filter(f => !f.file_token);
    for (let i = 0; i < todo.length; i++) {
      go.querySelector(".btn-label").textContent = todo.length > 1 ? `Uploading ${i + 1} of ${todo.length}…` : "Uploading…";
      todo[i].file_token = await uploadToBase(todo[i].file, ctx.tables.collections.app, ctx.token());
    }
    if (ch.files.length) out["Invoice"] = ch.files.map(f => ({ file_token: f.file_token }));
    go.querySelector(".btn-label").textContent = "Pushing…";
    return out;
  }

  async function runPush() {
    if (!sheet || sheet.busy) return;
    const c = sheet.card;
    if (!ctx.ensureTime()) return;
    $("#sheetError").hidden = true;
    setBusy(true);
    S.working.add(c.id);
    const s = sheet;
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
        toast(err.message, { type: "warn", detail: err.detail || "Someone else already did this. The list has been refreshed." });
        ctx.loadData({ quiet: true });
        return;
      }
      if (isDeadToken(err)) { dialog.close(); return ctx.sessionEnded(); }
      const box = $("#sheetError");
      box.textContent = `Nothing was written. ${describe(err)}`;
      box.hidden = false;
      go.querySelector(".btn-label").textContent = conn.proxy === "down" ? "Try again" : go.querySelector(".btn-label").textContent;
    }
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
    const chips = h("span", { class: "chips", style: "display:contents" });
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
