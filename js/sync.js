/* The transfer rules, as pure functions: no DOM, no network.

   The page (app.js) and the Node checks in tests/ both import this file, so
   what the tests verify is exactly what the page writes.

   Record shapes are Lark's: { record_id, fields: { "<field name>": <value> } },
   with values in Lark's read format (text as rich-text segments, people as
   objects, dates as ms timestamps). Builders return Lark's write format. */

/* ======================= reading cell values ======================= */

/* Reduce any Bitable cell value to plain text. */
export function plain(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // Text fields arrive as rich-text segments ({type, text}); join those seamlessly.
    const segments = v.length > 0 && v.every(x => x && typeof x === "object"
                                              && typeof x.type === "string" && typeof x.text === "string");
    return v.map(plain).filter(s => s !== "").join(segments ? "" : ", ");
  }
  if (typeof v === "object") {
    if ("value" in v) return plain(v.value);                 // formula / lookup
    if (typeof v.text === "string") return v.text;            // text segment, URL field
    if (typeof v.name === "string") return v.name;            // person, attachment
    if (Array.isArray(v.text_arr)) return v.text_arr.join(", ");
  }
  return "";
}

/* Plain text with Windows line endings and outer whitespace removed. */
export const clean = (v) => plain(v).replace(/\r\n?/g, "\n").trim();

/* People fields → [{id, name, short, email}] (id is the open_id Lark expects on
   write; `short` is first + last name for tight spaces, e.g. "Carlos Coscolluela"
   for "Carlos Roberto Francisco, David, IV Coscolluela"). */
export function people(v) {
  return (Array.isArray(v) ? v : [])
    .filter(u => u && typeof u.id === "string" && u.id)
    .map(u => {
      const name = u.name || u.en_name || u.email || u.id;
      return { id: u.id, name, short: shortName(name), email: u.email || "" };
    });
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
export function shortName(name) {
  const words = String(name || "").replace(/,/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 2 && SUFFIX.test(words[words.length - 1])) words.pop();
  return words.length > 2 ? `${words[0]} ${words[words.length - 1]}` : words.join(" ");
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* An approval's request number is the text of its "Request No." URL field. */
export const requestNo = (v) => clean(v);

/* Request numbers inside free text, e.g. a Universe PAR cell "202607030034, 202607080041". */
export const requestNos = (text) => String(text || "").match(/\d{12}/g) || [];

/* Project codes look like 2026TEG-P0286. Source tables are typed by hand, so
   codes arrive as "CE_2026TEG-P0091", "Project Code\n2024TEG-P0131" or with a
   trailing space; pull out the canonical form. */
const CODE_RE = /(\d{4}TEG-P\d{4,5})(?!\d)/gi;
export const allCodes = (text) => [...String(text || "").matchAll(CODE_RE)].map(m => m[1].toUpperCase());
export const normCode = (text) => allCodes(text)[0] || "";

/* ======================= small helpers ======================= */

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

const DAY_MS = 86400000;

/* Midnight of the same calendar day in the given UTC offset, as ms. Lark stores
   date-only fields this way (e.g. 2026-10-07 00:00 +08:00). */
export function dayStart(ms, offsetHours) {
  const off = offsetHours * 3600000;
  return Math.floor((ms + off) / DAY_MS) * DAY_MS - off;
}
export const yearIn = (ms, offsetHours) => new Date(ms + offsetHours * 3600000).getUTCFullYear();

/* Single-select options are matched loosely ("PDEI - Event Service" fits the
   option "PDEI-Event Service") but always written using the option's own name,
   so a write can never create a new option. */
const optionKey = (s) => String(s || "").toLowerCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
export function matchOption(value, options) {
  const k = optionKey(value);
  return k ? (options || []).find(o => optionKey(o) === k) || null : null;
}

/* Name similarity (Jaccard over meaningful words), used to flag briefs that look
   like a project already in the Universe under another code. */
const STOP = new Set(("the a an of and x for in at on with to by ph season addendum project " +
                      "2023 2024 2025 2026 2027 2028").split(" "));
function words(s) {
  return new Set((String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length > 1 && !STOP.has(w)));
}
export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/* ======================= indexes over the destination tables ======================= */

/* Universe, keyed by every project code found in each row's Project Code cell. */
export function indexUniverse(records) {
  const rows = [], byCode = new Map(), parNos = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const row = {
      id: r.record_id,
      codeText: clean(f["Project Code"]),
      project: clean(f["Project"]),
      client: clean(f["Client"]),
      par: clean(f["PAR"]),
    };
    rows.push(row);
    for (const c of new Set(allCodes(row.codeText))) {
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(row);
    }
    for (const n of requestNos(row.par)) parNos.add(n);
  }
  return { rows, byCode, parNos };
}

/* Collections, keyed by invoice request number and by project code. */
export function indexCollections(records) {
  const irNos = new Set(), byCode = new Map();
  for (const r of records) {
    const f = r.fields || {};
    const ir = num(f["Invoice Request"]);
    const row = {
      id: r.record_id,
      ir: ir === null ? "" : String(Math.round(ir)),
      arName: clean(f["AR Name"]),
      amount: num(f["Invoice Amount"]),
      currency: clean(f["Currency"]),
    };
    if (row.ir) irNos.add(row.ir);
    for (const c of new Set(allCodes(plain(f["Project Code"])))) {
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(row);
    }
  }
  return { irNos, byCode };
}

/* ======================= cards ======================= */

const bySubmittedDesc = (a, b) => (b.submittedAt || 0) - (a.submittedAt || 0);

function emptyHidden() {
  return { otherDept: 0, ignored: 0, done: 0, void: 0, noProject: 0 };
}

/* Project Briefs that should become Universe rows.
   Returns { cards, hidden } where hidden counts what was filtered out and why. */
export function briefCards(briefs, uni, rules, { allDepartments = false, ignoreField = "IGNORE", kind = "brief" } = {}) {
  const cards = [], hidden = emptyHidden();
  for (const r of briefs) {
    const f = r.fields || {};
    if (!allDepartments && clean(f["Initiator department"]) !== rules.department) { hidden.otherDept++; continue; }
    if (f[ignoreField] === true) { hidden.ignored++; continue; }
    const code = normCode(plain(f["Project Code"]));
    if (code && uni.byCode.has(code)) { hidden.done++; continue; }
    const status = clean(f["Status"]);
    if (rules.voidStatuses.includes(status)) { hidden.void++; continue; }

    const name = clean(f["Project Name"]);
    const card = {
      kind, id: r.record_id, record: r, code, name, status,
      department: clean(f["Initiator department"]),
      requestNo: requestNo(f["Request No."]),
      submittedAt: num(f["Submitted at"]),
      value: num(f["Contract Value"]),
      currency: clean(f["Contract Value-Currency"]),
      am: people(f["AM"]),
      problems: [], similar: null,
    };
    if (!code) card.problems.push(`Project Code "${clean(f["Project Code"])}" isn't a valid code (e.g. 2026TEG-P0123).`);

    let best = null;
    for (const row of uni.rows) {
      const s = similarity(name, row.project);
      if (s >= rules.similarityHint && (!best || s > best.score)) best = { score: s, row };
    }
    if (best) card.similar = { project: best.row.project, code: normCode(best.row.codeText), score: best.score };
    cards.push(card);
  }
  cards.sort(bySubmittedDesc);
  return { cards, hidden };
}

/* Project Approvals whose request number isn't in the Universe yet. A PAR can
   only land on an existing Universe row, so PARs for a project that isn't there
   are hidden, unless that project's brief is waiting as a card (then the PAR
   shows as blocked until the brief is pushed).

   The project is found through the PAR's "Associated Project Brief" (which
   starts with the brief's request number) because PAR's own Project Code is
   free text and sometimes wrong; the typed code is the fallback. */
export function parCards(pars, briefs, uni, pendingCodes, rules) {
  const briefByReq = new Map();
  for (const b of briefs) briefByReq.set(requestNo((b.fields || {})["Request No."]), b);

  const cards = [], hidden = emptyHidden();
  for (const r of pars) {
    const f = r.fields || {};
    if (f["IGNORE"] === true) { hidden.ignored++; continue; }
    const reqNo = requestNo(f["Request No."]);
    if (reqNo && uni.parNos.has(reqNo)) { hidden.done++; continue; }
    const status = clean(f["Status"]);
    if (rules.voidStatuses.includes(status)) { hidden.void++; continue; }

    const linked = (clean(f["Associated Project Brief"]).match(/^(\d{12})/) || [])[1];
    const brief = linked ? briefByReq.get(linked) : null;
    const briefCode = brief ? normCode(plain(brief.fields["Project Code"])) : "";
    const typedCode = normCode(plain(f["Project Code"]));
    const options = [...new Set([briefCode, typedCode].filter(Boolean))];
    const code = options.find(c => uni.byCode.has(c)) || options.find(c => pendingCodes.has(c)) || "";

    const notes = [];
    if (briefCode && typedCode && briefCode !== typedCode) {
      notes.push(code === typedCode
        ? `Linked brief is ${briefCode}, which isn't in the Universe; using the PAR's typed code ${typedCode}.`
        : `PAR's typed code ${typedCode} differs from its linked brief's ${briefCode}; using ${briefCode}.`);
    }
    const targets = code ? uni.byCode.get(code) || [] : [];
    const blocked = !targets.length;
    if (blocked && !(code && pendingCodes.has(code))) { hidden.noProject++; continue; }

    const name = clean(f["Project Name"]);
    let target = targets[0] || null;
    if (targets.length > 1) {
      target = targets.reduce((a, b) => (similarity(name, b.project) > similarity(name, a.project) ? b : a));
      notes.push(`${targets.length} Universe rows share ${code}; check which one this PAR belongs to.`);
    }
    if (!reqNo) notes.push("This PAR has no request number.");
    cards.push({
      kind: "par", id: r.record_id, record: r, code, name, status, requestNo: reqNo,
      submittedAt: num(f["Submitted at"]),
      targets, target, blocked: blocked ? "Push this project's brief first." : (reqNo ? "" : "No request number to copy."),
      notes,
    });
  }
  cards.sort(bySubmittedDesc);
  return { cards, hidden };
}

/* Invoice Requests not yet in Collections. One project can have many invoices,
   so "already there" means a Collections row carries this request number. */
export function invoiceCards(invoices, uni, coll, pendingCodes, rules) {
  const cards = [], hidden = emptyHidden();
  for (const r of invoices) {
    const f = r.fields || {};
    if (clean(f["Initiator department"]) !== rules.department) { hidden.otherDept++; continue; }
    if (f["IGNORE"] === true) { hidden.ignored++; continue; }
    const reqNo = requestNo(f["Request No."]);
    if (reqNo && coll.irNos.has(reqNo)) { hidden.done++; continue; }
    const status = clean(f["Status"]);
    if (rules.voidStatuses.includes(status)) { hidden.void++; continue; }

    const code = normCode(plain(f["Project Code"]));
    const inUniverse = !!code && uni.byCode.has(code);
    if (code && !inUniverse && !pendingCodes.has(code)) { hidden.noProject++; continue; }

    const amount = num(f["Amount"]);
    const currency = clean(f["Amount-Currency"]);
    const existing = code ? coll.byCode.get(code) || [] : [];
    const notes = [];
    // Older Collections rows predate the request-number column, so they can't be
    // matched exactly. Point them out so an invoice isn't recorded twice; a row
    // with the same amount (as filed, or VAT-ex) is very likely this invoice.
    const legacy = existing.filter(e => !e.ir);
    const close = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.01;
    const money = (e) => `${e.currency || "?"} ${e.amount === null ? "?" : e.amount.toLocaleString("en-US")}`;
    const same = legacy.find(e => e.currency === currency && amount !== null
                                  && (close(e.amount, amount) || close(e.amount, round2(amount / rules.vatDivisor))));
    if (same) {
      notes.push(`Collections already has “${same.arName}” (${money(same)}) for this project with no request ` +
                 "number. It's likely this invoice; if so, ignore this card.");
    } else if (legacy.length) {
      notes.push(`Collections has ${legacy.length} older row${legacy.length === 1 ? "" : "s"} for this project with ` +
                 `no request number (${legacy.slice(0, 2).map(e => `“${e.arName}” ${money(e)}`).join(", ")}` +
                 `${legacy.length > 2 ? ", …" : ""}). Check this invoice isn't one of them.`);
    }
    let blocked = "";
    if (!code) blocked = `Project Code "${clean(f["Project Code"])}" isn't a valid code.`;
    else if (!inUniverse) blocked = "Push this project's brief first.";
    else if (!reqNo) blocked = "No request number to copy.";
    else if (amount === null) blocked = "The request has no Amount.";

    cards.push({
      kind: "invoice", id: r.record_id, record: r, code, name: clean(f["Project Name"]), status,
      requestNo: reqNo, submittedAt: num(f["Submitted at"]),
      amount, currency, businessUnit: clean(f["Business Unit"]),
      existingCount: existing.length, notes, blocked,
    });
  }
  cards.sort(bySubmittedDesc);
  return { cards, hidden };
}

/* ======================= what gets written ======================= */

export const defaultVat = (currency) => (currency === "USD" ? "0%" : "12%");

/* Sentences in the brief's Remarks that talk about VAT or tax, to show beside
   the VAT choice. They're too inconsistent ("all in with tax" briefs ended up
   0% in the Universe) to pick the VAT automatically. */
export function vatMentions(remarks, max = 2) {
  return (clean(remarks).match(/[^.!?\n]+[.!?]?/g) || [])
    .map(s => s.trim())
    .filter(s => /\bvat\b|\btax(es)?\b|zero[- ]?rated|vat[- ]?(ex|inc)/i.test(s))
    .slice(0, max);
}

/* Amount (VAT-Ex.) (PHP) from the brief's filed value. null if it can't be computed. */
export function vatExAmount(value, currency, vat, rules) {
  if (num(value) === null) return null;
  const rate = currency === "USD" ? rules.usdRate : currency === "PHP" ? 1 : null;
  if (rate === null) return null;
  return round2(value * rate / (vat === "12%" ? rules.vatDivisor : 1));
}

/* How the amount was derived, for the confirmation sheet. */
export function amountFormula(value, currency, vat, rules) {
  if (num(value) === null) return "no Contract Value on the brief";
  const parts = [`${currency || "?"} ${value.toLocaleString("en-US")}`];
  if (currency === "USD") parts.push(`× ${rules.usdRate}`);
  if (vat === "12%") parts.push(`÷ ${rules.vatDivisor}`);
  return parts.join(" ");
}

const userRefs = (list) => list.map(u => ({ id: u.id }));

/* Universe fields for a brief. `choices` = { vat: "12%" | "0%", client, bd, otherLinks }:
   Client, BD and Other Links come only from what the user enters (BD and Other
   Links are blank unless set). Empty values are left out, so nothing is
   written as blank. */
export function universeFromBrief(card, choices, rules) {
  const f = card.record.fields || {};
  const out = {};
  const put = (k, v) => {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
  };
  put("Project Code", card.code);
  put("Project", card.name);
  put("Client", (choices.client || "").trim());
  put("AM", userRefs(people(f["AM"])));
  put("BD", userRefs(choices.bd || []));
  put("MKT", userRefs(people(f["MKT"])));
  const amount = vatExAmount(card.value, card.currency, choices.vat, rules);
  put("Amount (VAT-Ex.) (PHP)", amount);
  if (amount !== null) put("VAT%", choices.vat);
  put("Project Description", clean(f["Remarks"]));
  put("Project Start", num(f["Start date"]));
  put("Project End", num(f["End date"]));
  const submitted = num(f["Submitted at"]);
  if (submitted !== null) put("RFP Received Date", dayStart(submitted, rules.utcOffsetHours));
  put("Year", card.code ? card.code.slice(0, 4) : (submitted !== null ? String(yearIn(submitted, rules.utcOffsetHours)) : ""));
  put("Status", rules.newProjectStatus);
  put("Mancom Phase", rules.newProjectMancomPhase);
  put("Other Links", (choices.otherLinks || "").replace(/\r\n?/g, "\n").trim());
  return out;
}

/* ANDON fields for a brief (the Project Management board). `choices` =
   { pm: [person], tribe: string }: PM (LEAD) and TRIBE come only from what the
   user picks. `options` = ANDON's select options, so values never invent new
   ones. Empty values are left out. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
                "September", "October", "November", "December"];
export function andonFromBrief(card, choices, rules, options) {
  const f = card.record.fields || {};
  const out = {};
  const put = (k, v) => {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
  };
  const opt = (name, v) => matchOption(v, options[name] || []);
  put("Project", card.name);
  put("Project Code", card.code);
  put("AM", userRefs(people(f["AM"]).slice(0, 1)));                 // ANDON holds one AM
  put("PM (LEAD)", userRefs((choices.pm || []).slice(0, 1)));
  put("MKT (PITCH)", userRefs(people(f["MKT"])));
  put("Business Unit", opt("Business Unit", clean(f["Business Unit"])));
  put("Tools", (Array.isArray(f["Required Tools"]) ? f["Required Tools"] : [])
    .map(t => opt("Tools", t)).filter(Boolean));
  put("TRIBE", opt("TRIBE", choices.tribe));
  const value = num(f["Contract Value"]);
  const cur = opt("Brief Currency", card.currency);
  put("Brief Contract Value", value);
  if (cur) put("Brief Currency", [cur]);
  if (value !== null && (card.currency === "PHP" || card.currency === "USD")) {
    put("Contract Value (USD)", round2(card.currency === "USD" ? value : value / rules.usdRate));
  }
  const brief = f["Request No."];
  if (brief && brief.link) put("Brief", { link: brief.link, text: card.requestNo || brief.link });
  put("Brief Status", [opt("Brief Status", card.status)].filter(Boolean));
  const submitted = num(f["Submitted at"]);
  put("YEAR", card.code ? card.code.slice(0, 4) : (submitted !== null ? String(yearIn(submitted, rules.utcOffsetHours)) : ""));
  const start = num(f["Start date"]);
  const when = start !== null ? start : submitted;
  if (when !== null) put("MONTH", MONTHS[new Date(when + rules.utcOffsetHours * 3600000).getUTCMonth()]);
  put("Event Start", start);
  put("Event End", num(f["End date"]));
  put("Remarks", clean(f["Remarks"]));
  return out;
}

/* Everyone the BD picker can offer: people seen in the Universe's BD and AM
   columns and on the briefs, most frequent Universe BDs first. */
export function peoplePool(universe, briefs) {
  const pool = new Map();
  const add = (list, bd) => list.forEach(u => {
    const p = pool.get(u.id) || { id: u.id, name: u.name, email: u.email, bdCount: 0 };
    if (!p.email && u.email) p.email = u.email;
    if (bd) p.bdCount++;
    pool.set(u.id, p);
  });
  for (const r of universe) { const f = r.fields || {}; add(people(f["BD"]), true); add(people(f["AM"]), false); }
  for (const r of briefs) {
    const f = r.fields || {};
    for (const k of ["BD", "AM", "MKT"]) add(people(f[k]), false);
  }
  return [...pool.values()].sort((a, b) => b.bdCount - a.bdCount || a.name.localeCompare(b.name));
}

/* Everyone the PM picker can offer: ANDON's PM (LEAD) and PM (SUPP) people first. */
export function pmPool(andon, universe) {
  const pool = new Map();
  const add = (list, pm) => list.forEach(u => {
    const p = pool.get(u.id) || { id: u.id, name: u.name, email: u.email, bdCount: 0 };
    if (pm) p.bdCount++;
    pool.set(u.id, p);
  });
  for (const r of andon) { const f = r.fields || {}; add(people(f["PM (LEAD)"]), true); add(people(f["PM (SUPP)"]), true); }
  for (const r of universe) add(people((r.fields || {})["PM"]), false);
  return [...pool.values()].sort((a, b) => b.bdCount - a.bdCount || a.name.localeCompare(b.name));
}

/* ======================= the Universe view ======================= */

/* One Universe record as a table row. */
export function universeRow(r) {
  const f = r.fields || {};
  return {
    id: r.record_id,
    client: clean(f["Client"]),
    project: clean(f["Project"]),
    amount: num(f["Amount (VAT-Ex.) (PHP)"]),
    bd: people(f["BD"]),
    am: people(f["AM"]),
    code: clean(f["Project Code"]),
    rfp: num(f["RFP Received Date"]),
    status: clean(f["Status"]),
    year: clean(f["Year"]),
  };
}

/* The Universe the way the team reads it: one Year (or "all"), statuses in
   `hidden` left out, grouped by Status in the column's option order, each group
   sorted by RFP Received Date (rows without one go last). `query` narrows rows
   by client, project, code or people. */
export function universeView(records, { year = "all", hidden = [], statusOrder = [], sort = "desc", query = "" } = {}) {
  const all = records.map(universeRow);
  const years = [...new Set(all.map(r => r.year).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
  const q = query.trim().toLowerCase();
  const text = (r) => [r.client, r.project, r.code, ...r.bd.map(u => u.name), ...r.am.map(u => u.name)]
    .join(" ").toLowerCase();
  const picked = all.filter(r => (year === "all" || r.year === String(year)) && (!q || text(r).includes(q)));

  const hiddenCounts = {};
  const byStatus = new Map();
  for (const r of picked) {
    if (hidden.includes(r.status)) { hiddenCounts[r.status] = (hiddenCounts[r.status] || 0) + 1; continue; }
    if (!byStatus.has(r.status)) byStatus.set(r.status, []);
    byStatus.get(r.status).push(r);
  }
  // Option order first, then any status the options don't list, then rows with no status.
  const order = [...statusOrder, ...[...byStatus.keys()].filter(s => s && !statusOrder.includes(s)), ""];
  const dir = sort === "asc" ? 1 : -1;
  const byDate = (a, b) => (a.rfp === null) - (b.rfp === null) || dir * ((a.rfp || 0) - (b.rfp || 0))
                           || a.project.localeCompare(b.project);
  const groups = order.filter(s => byStatus.has(s)).map(status => {
    const rows = byStatus.get(status).sort(byDate);
    return { status, rows, amount: round2(rows.reduce((s, r) => s + (r.amount || 0), 0)) };
  });
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  return { groups, years, hiddenCounts, count: shown,
           amount: round2(groups.reduce((s, g) => s + g.amount, 0)) };
}

/* The Universe PAR cell after adding a request number, or null if it's already there. */
export function parAfterAdding(current, reqNo) {
  const cur = clean(current);
  if (requestNos(cur).includes(reqNo)) return null;
  return cur ? `${cur}, ${reqNo}` : reqNo;
}

/* Collections fields for an invoice request. `choices` = { arName }.
   `options` = the Collections select options, so values never invent new ones. */
export function collectionsFromInvoice(card, choices, options, rules) {
  const out = {
    "AR Name": (choices.arName || "").trim() || card.name,
    "Project Code": card.code,
    "Invoice Amount": card.amount,
    "Invoice Request": Number(card.requestNo),
    "Status": rules.collectionStatus[card.status] || rules.collectionStatusPending,
  };
  const currency = matchOption(card.currency, options["Currency"]);
  if (currency) out["Currency"] = currency;
  const bu = matchOption(card.businessUnit, options["Business Unit"]);
  if (bu) out["Business Unit"] = bu;
  return out;
}

/* ======================= read-back verification ======================= */

/* Compare what was written (write format) with the record Lark returns (read
   format). Returns [{field, want, got}] for every field that didn't land as sent. */
export function verifyWritten(expected, actualFields) {
  const bad = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = (actualFields || {})[name];
    if (!sameValue(want, got)) bad.push({ field: name, want: show(want), got: show(got) });
  }
  return bad;
}

function sameValue(want, got) {
  if (Array.isArray(want)) {                                    // people: compare ids
    const ids = (a) => (Array.isArray(a) ? a : []).map(u => u && u.id).filter(Boolean).sort().join(",");
    return ids(want) === ids(got);
  }
  if (typeof want === "number") return typeof got === "number" && Math.abs(got - want) < 0.005;
  if (typeof want === "boolean") return (got === true) === want;
  return clean(got) === String(want).replace(/\r\n?/g, "\n").trim();
}

function show(v) {
  if (v === null || v === undefined) return "(empty)";
  if (Array.isArray(v) && v.every(u => u && typeof u === "object" && "id" in u)) {
    return v.map(u => u.name || u.id).join(", ") || "(empty)";
  }
  if (typeof v === "number") return String(v);
  return plain(v) || "(empty)";
}
