/* The Inbox: cards for Project Briefs, PARs and Invoice Requests, the push
   sheet (with the BD picker), and Ignore with Undo. */

import { RULES } from "./config.js";
import { TABLE_TITLES, pushBrief, pushPar, pushInvoice, pushAndon, setIgnore, AlreadyDone, newClientToken, writableOnly } from "./ops.js";
import {
  universeFromBrief, collectionsFromInvoice, parAfterAdding, defaultVat, amountFormula, vatMentions,
  vatExAmount, people, andonFromBrief,
} from "./sync.js";
import { $, h, ic, toast, fmt, flash, reduceMotion } from "./ui.js";
import { describe, isDeadToken, conn } from "./net.js";

const NOUN = { brief: "briefs", par: "PARs", invoice: "invoices", andon: "briefs for ANDON" };
const STAGE_ORDER = ["universe", "brief", "par", "invoice", "collections", "andon"];
// The table each card comes from (ANDON cards are Project Briefs too).
const SOURCE = { brief: "brief", par: "par", invoice: "invoice", andon: "brief" };
// One IGNORE box on the brief hides it from both the Universe and ANDON lists.
const ignoreField = () => "IGNORE";
const BADGE = { "Approved": "badge-ok", "Under Review": "badge-warn", "Processing": "badge-info" };
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
          invoice: "Every invoice is in Collections. Nice work!" }[S.tab];
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
      done: { invoice: "already in Collections", andon: "already in ANDON" }[S.tab] || "already in the Universe",
      ignored: "ignored", void: "rejected, recalled or cancelled",
      otherDept: "from other departments", noProject: "for projects not in the Universe",
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
        notes.push(h("li", null, `Note: looks like "${c.similar.project}"${c.similar.code ? ` (${c.similar.code})` : ""}, ` +
          `already in ${c.kind === "andon" ? "ANDON" : "the Universe"}. If it's the same project, ignore this one.`));
      }
    } else if (c.kind === "par") {
      const t = c.target;
      meta = ["PAR ", h("b", null, c.requestNo || "?"),
              t ? ` · goes to "${t.project || t.codeText}"` : "",
              t && t.par ? ` (already has ${t.par})` : ""];
      c.notes.forEach(n => notes.push(h("li", null, `Note: ${n}`)));
    } else {
      meta = [c.amount !== null ? h("b", null, fmt.money(c.amount, c.currency)) : "No amount",
              ` · request ${c.requestNo || "?"}`,
              c.existingCount ? ` · ${c.existingCount} in Collections for this project` : ""];
      c.notes.forEach(n => notes.push(h("li", null, `Note: ${n}`)));
    }
    if (c.blocked) {
      const brief = c.blocked.startsWith("Push this project's brief")
        ? S.lists.brief.cards.find(b => b.code === c.code) : null;
      notes.push(h("li", { class: "is-block" }, c.blocked,
        brief ? h("a", { href: "#/briefs", onclick: () => { S.flashCard = brief.id; S.query.brief = ""; } }, "Go to the brief") : null));
    }
    const pushable = writable && !c.blocked && !(c.problems && c.problems.length);
    const canIgnore = writable;
    return h("article", { class: "card item" + (S.working.has(c.id) ? " is-working" : "") + (S.entering.has(c.id) ? " is-entering" : ""),
                          "data-id": c.id },
      h("div", { class: "item-head" },
        h("span", { class: "code" }, c.code || "No code"),
        c.status ? h("span", { class: `badge ${BADGE[c.status] || ""}` }, c.status) : null,
        h("span", { class: "item-date" }, fmt.day(c.submittedAt))),
      h("h3", null, c.name || "(no name)"),
      h("p", { class: "item-meta" }, meta),
      notes.length ? h("ul", { class: "notes" }, notes) : null,
      h("div", { class: "item-actions" },
        h("button", { type: "button", class: "btn btn-ghost", disabled: !canIgnore,
          title: c.kind === "brief" || c.kind === "andon" ? "Hides this brief from both the Universe and ANDON lists" : null,
          onclick: (e) => ignore(c, true, e.currentTarget) }, "Ignore"),
        h("button", { type: "button", class: "btn btn-tonal", disabled: !pushable, onclick: () => openSheet(c) }, "Push")));
  }

  /* ======================= ignore / undo (optimistic) ======================= */
  async function ignore(c, value, button) {
    if (S.working.has(c.id)) return;
    const src = SOURCE[c.kind], box = ignoreField(c.kind);
    const rec = (S.data[src] || []).find(r => r.record_id === c.id);
    if (!rec) return;
    const before = rec.fields[box];
    const what = c.kind === "brief" || c.kind === "andon" ? c.code : `${c.code} · ${c.requestNo}`;
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
    if (sheet && !sheet.done) S.drafts.set(sheet.card.id, { choices: sheet.choices, clientToken: sheet.clientToken, targetId: sheet.targetId });
    sheet = null;
  });
  $("#sheetForm").addEventListener("submit", (e) => e.preventDefault());   // Enter in a field mustn't send
  go.addEventListener("click", runPush);

  function defaults(c) {
    if (c.kind === "brief") return { vat: defaultVat(c.currency), client: "", bd: [], otherLinks: "", showLinks: false };
    if (c.kind === "invoice") return { arName: c.name };
    if (c.kind === "andon") return { pm: [], tribe: "" };
    return {};
  }

  function openSheet(c) {
    const draft = S.drafts.get(c.id);
    sheet = {
      card: c,
      choices: draft ? { ...draft.choices } : defaults(c),
      clientToken: draft ? draft.clientToken : newClientToken(),
      targetId: (draft && draft.targetId) || (c.target && c.target.id) || null,
      busy: false, done: false,
    };
    $("#sheetTitle").textContent = { brief: "Push to Universe", par: "Add PAR to Universe", invoice: "Add to Collections", andon: "Add to ANDON" }[c.kind];
    $("#sheetSub").textContent = `${c.code}${(c.kind === "par" || c.kind === "invoice") && c.requestNo ? ` · request ${c.requestNo}` : ""} · ${c.name}`;
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
    go.disabled = busy;
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
      ctxLine.textContent = `Goes into the Universe row "${row.project || row.codeText}" (${c.code}).`;
      written.replaceChildren(h("dt", null, "PAR"),
        h("dd", null, next, h("span", { class: "why" }, row.par ? `Was ${row.par}. The new number is added after it.` : "Was empty.")));
    };
    sheet.refresh = refresh;
    if (c.targets.length > 1) {
      const sel = h("select", { id: "sheetTarget" },
        c.targets.map(t => h("option", { value: t.id }, `${t.project || "(no name)"}${t.par ? ` · PAR ${t.par}` : ""}`)));
      sel.value = sheet.targetId;
      sel.addEventListener("change", () => { sheet.targetId = sel.value; refresh(); });
      body.append(fieldEl(`Universe row (${c.targets.length} rows share ${c.code})`, false, h("label", { class: "select" }, sel), "sheetTarget"));
    }
    put(body, ctxLine, c.notes.length ? h("p", { class: "note" }, `Note: ${c.notes.join(" ")}`) : null,
                h("p", { class: "subhead" }, "Will be written"), written);
    refresh();
  }

  /* --- invoice --- */
  function buildInvoice(body, c) {
    const ch = sheet.choices;
    const written = h("dl", { class: "written" });
    const refresh = () => {
      const payload = collectionsFromInvoice(c, ch, ctx.collectionOptions(), RULES);
      written.replaceChildren(...Object.entries(payload).filter(([k]) => k !== "AR Name").flatMap(([k, v]) => [
        h("dt", null, k),
        h("dd", null, k === "Invoice Amount" ? fmt.money(v) : String(v)),
      ]));
    };
    sheet.refresh = refresh;
    const ar = h("input", { type: "text", id: "sheetAr", autocomplete: "off" });
    ar.value = ch.arName;
    ar.addEventListener("input", () => { ch.arName = ar.value; refresh(); });
    put(body, fieldEl("AR Name", false, ar, "sheetAr"),
                c.notes.length ? h("p", { class: "note" }, `Note: ${c.notes.join(" ")}`) : null,
                h("p", { class: "subhead" }, "Also written"), written);
    refresh();
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
        payload = collectionsFromInvoice(c, s.choices, ctx.collectionOptions(), RULES);
        res = await pushInvoice(ctx.call, ctx.tables, RULES, c, payload, s.clientToken);
      }
      s.done = true;
      S.drafts.delete(c.id);
      S.working.delete(c.id);
      setBusy(false);
      dialog.close();
      await ctx.afterPush(c, res, payload, extra);
    } catch (err) {
      S.working.delete(c.id);
      setBusy(false);
      if (err instanceof AlreadyDone) {
        s.done = true;
        S.drafts.delete(c.id);
        dialog.close();
        toast(err.message, { type: "warn", detail: "Someone else already did this. The list has been refreshed." });
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
