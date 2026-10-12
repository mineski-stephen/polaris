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
/* A number from a number column or a formula ({type, value: [n]}). */
const numOf = (v) => num(v) ?? (v && typeof v === "object" && Array.isArray(v.value) ? num(v.value[0]) : null);

/* An approval's request number is the text of its "Request No." URL field. */
export const requestNo = (v) => clean(v);

/* Request numbers inside free text, e.g. a Universe PAR cell "202607030034, 202607080041". */
export const requestNos = (text) => String(text || "").match(/\d{12}/g) || [];

/* A request number starts with its filing date (202606030032 → 3 Jun 2026); as
   midnight in the given UTC offset, or null. */
export function requestDate(no, offsetHours) {
  const m = String(no || "").match(/^(\d{4})(\d{2})(\d{2})\d{4}$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - offsetHours * 3600000;
}

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

const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };

/* Universe, keyed by every project code found in each row's Project Code cell,
   and by every PAR request number in its PAR cell. */
export function indexUniverse(records, { ignoreField = "IGNORE" } = {}) {
  const rows = [], byCode = new Map(), byPar = new Map();
  for (const r of records) {
    const f = r.fields || {};
    const row = {
      id: r.record_id,
      codeText: clean(f["Project Code"]),
      project: clean(f["Project"]),
      client: clean(f["Client"]),
      par: clean(f["PAR"]),
      status: clean(f["Status"]),
      amountInc: numOf(f["Amount (VAT-Inc.)"]),
      businessUnit: clean(f["Business Unit"]),
      ignored: f[ignoreField] === true,
    };
    rows.push(row);
    for (const c of new Set(allCodes(row.codeText))) push(byCode, c, row);
    for (const n of new Set(requestNos(row.par))) push(byPar, n, row);
  }
  return { rows, byCode, byPar, parNos: new Set(byPar.keys()) };
}

/* Collections, keyed by invoice request number and by project code. */
export function indexCollections(records) {
  const rows = [], byIr = new Map(), byCode = new Map();
  for (const r of records) {
    const f = r.fields || {};
    const ir = num(f["Invoice Request"]);
    const row = {
      id: r.record_id,
      ir: ir === null ? "" : String(Math.round(ir)),
      code: normCode(plain(f["Project Code"])),
      arName: clean(f["AR Name"]),
      amount: num(f["Invoice Amount"]),
      currency: clean(f["Currency"]),
      status: clean(f["Status"]),
      invoiceDate: num(f["Invoice Date"]),
    };
    rows.push(row);
    if (row.ir) push(byIr, row.ir, row);
    for (const c of new Set(allCodes(plain(f["Project Code"])))) push(byCode, c, row);
  }
  return { rows, byIr, byCode, irNos: new Set(byIr.keys()) };
}

/* ======================= cards ======================= */

const bySubmittedDesc = (a, b) => (b.submittedAt || 0) - (a.submittedAt || 0);

/* Filed by one of the departments Polaris covers (Account Managers, once called Sales). */
const inDepartment = (f, rules) => (rules.departments || [rules.department]).includes(clean(f["Initiator department"]));

function emptyHidden() {
  return { otherDept: 0, ignored: 0, done: 0, void: 0, noProject: 0 };
}

/* Project Briefs that should become Universe rows.
   Returns { cards, hidden } where hidden counts what was filtered out and why. */
export function briefCards(briefs, uni, rules, { allDepartments = false, ignoreField = "IGNORE", kind = "brief" } = {}) {
  const cards = [], hidden = emptyHidden();
  for (const r of briefs) {
    const f = r.fields || {};
    if (!allDepartments && !inDepartment(f, rules)) { hidden.otherDept++; continue; }
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

/* ======================= Collections: the invoice lifecycle =======================

   A Collections row moves through three stages (rules.collectionStages):
     For Invoicing   the project is won (it has a PAR and an amount); nothing is filed yet
     Pending …       an invoice request has been filed for it
     For Collection  the request was approved and the invoice issued
   A row can skip Pending when its request is approved straight away.

   Each card is one change Polaris can push with a click:
     won        a won project with no Collections row yet → a new For Invoicing row
     filed      an invoice request under review → its row becomes Pending (or a new Pending row)
     approved   an approved request → its row becomes For Collection (or a new row)
     withdrawn  a request on a row was recalled or rejected → the row goes back to For Invoicing
   So the same invoice request can come up twice: when it's filed, and again when it's approved.

   A card's `targets` are the existing rows it can go on, each with an action:
     attach   a row waiting for a request takes this one
     advance  the row already carries this request; only its stage moves
     link     an older row that's already invoiced but never got a request number:
              only the number is added
     reset    a withdrawn request comes off its row
   `target` is the default (a row id, or "new" for a new row). */

/* The Collections status a card's step leads to. */
export function stepStatus(step, rules) {
  const st = rules.collectionStages;
  return { won: st.forInvoicing, filed: st.pending, approved: st.forCollection, withdrawn: st.forInvoicing }[step];
}

/* How well a free row fits a request: the same currency first, then the closest amount. */
function fitScore(row, card) {
  const gap = row.amount === null || card.amount === null ? 1e6
    : Math.abs(row.amount - card.amount) / Math.max(Math.abs(card.amount), 1);
  return (row.currency === card.currency ? 0 : 1e7) + gap;
}

const moneyOf = (row) => `${row.currency || "?"} ${row.amount === null ? "?" : row.amount.toLocaleString("en-US")}`;
const near = (a, b, tol = 0.01) => a !== null && b !== null && Math.abs(a - b) < tol;

/* Every change Collections needs, newest first. `invoices` = Invoice Request
   records; `uni`/`coll` = the indexes above; `pendingCodes` = codes of briefs
   still waiting as cards. Returns { cards, hidden } like the other lists. */
export function collectionCards(invoices, uni, coll, pendingCodes, rules) {
  const st = rules.collectionStages;
  const cards = [], hidden = { ...emptyHidden(), closed: 0 };
  const early = (row) => row.status === st.forInvoicing || row.status === st.pending;
  const voidNos = new Set(invoices.filter(r => rules.voidStatuses.includes(clean((r.fields || {})["Status"])))
    .map(r => requestNo(r.fields["Request No."])).filter(Boolean));
  // A row waiting for a request: an early stage, with no live request on it.
  const isFree = (row) => early(row) && (!row.ir || voidNos.has(row.ir));
  // An older row that's already invoiced but has no (live) request number.
  const isLegacy = (row) => !early(row) && !(rules.invalidStatuses || []).includes(row.status)
                            && (!row.ir || voidNos.has(row.ir));
  const projects = (code) => uni.byCode.get(code) || [];
  const isClosed = (code) => projects(code).length > 0 && projects(code).every(u => rules.closedStatuses.includes(u.status));

  const withdrawn = [];   // added last: a replacement request may take the row instead
  const fresh = [];       // requests not in Collections yet, to be matched with free rows

  for (const r of invoices) {
    const f = r.fields || {};
    const reqNo = requestNo(f["Request No."]);
    const status = clean(f["Status"]);
    const isVoid = rules.voidStatuses.includes(status);
    const approved = status === rules.approvedStatus;
    const card = {
      kind: "invoice", id: r.record_id, record: r, source: "invoice", ignoreField: "IGNORE",
      step: isVoid ? "withdrawn" : approved ? "approved" : "filed",
      code: "", name: clean(f["Project Name"]), status, requestNo: reqNo,
      submittedAt: num(f["Submitted at"]), completedAt: num(f["Completed at"]),
      amount: num(f["Amount"]), currency: clean(f["Amount-Currency"]), businessUnit: clean(f["Business Unit"]),
      targets: [], target: "new", canCreate: false, noNew: "", notes: [], blocked: "", existing: 0,
    };

    // Already on a row: move that row along, whichever department filed the request.
    const carrying = reqNo ? coll.byIr.get(reqNo) || [] : [];
    if (carrying.length) {
      const row = isVoid || approved ? carrying.find(early) : carrying.find(x => x.status === st.forInvoicing);
      if (!row) { if (isVoid) hidden.void++; else hidden.done++; continue; }
      if (f["IGNORE"] === true) { hidden.ignored++; continue; }
      card.code = row.code || normCode(plain(f["Project Code"]));
      card.targets = [{ id: row.id, row, action: isVoid ? "reset" : "advance" }];
      card.target = row.id;
      (isVoid ? withdrawn : cards).push(card);
      continue;
    }

    if (!inDepartment(f, rules)) { hidden.otherDept++; continue; }
    if (f["IGNORE"] === true) { hidden.ignored++; continue; }
    if (isVoid) { hidden.void++; continue; }

    // The project: the typed code, or failing that, the one its PAR is on in the Universe.
    const typed = normCode(plain(f["Project Code"]));
    const parNo = (clean(f["Associated Project Approval"]).match(/^(\d{12})/) || [])[1] || "";
    const viaPar = [...new Set((uni.byPar.get(parNo) || []).flatMap(u => allCodes(u.codeText)))];
    let code = typed;
    if (!(typed && uni.byCode.has(typed)) && viaPar.length === 1) {
      code = viaPar[0];
      card.notes.push(`Its project code ${typed || `"${clean(f["Project Code"])}"`} isn't in the Universe; ` +
                      `using ${code}, the project its PAR ${parNo} is on.`);
    } else if (typed && viaPar.length && !viaPar.includes(typed)) {
      card.notes.push(`Its PAR ${parNo} is on ${viaPar.join(", ")} in the Universe, not ${typed}. Check the project code.`);
    }
    card.code = code;
    if (!code || !uni.byCode.has(code)) {
      if (code && !pendingCodes.has(code)) { hidden.noProject++; continue; }
      card.blocked = code ? "Push this project's brief first." : `Project Code "${clean(f["Project Code"])}" isn't a valid code.`;
      cards.push(card);
      continue;
    }

    const rows = coll.byCode.get(code) || [];
    const free = rows.filter(isFree);
    const legacy = approved ? rows.filter(isLegacy) : [];
    if (isClosed(code) && !free.length) { hidden.closed++; continue; }
    card.targets = [...free.map(row => ({ id: row.id, row, action: "attach" })),
                    ...legacy.map(row => ({ id: row.id, row, action: "link" }))];
    card.canCreate = true;
    card.existing = rows.length;
    if (!projects(code).some(u => u.par)) card.noNew = "Add this project's PAR to the Universe first.";
    else if (card.amount === null) card.noNew = "The request has no Amount.";
    if (!reqNo) card.blocked = "No request number to copy.";
    fresh.push({ card, free, legacy });
    cards.push(card);
  }

  // Each request takes at most one existing row and each row at most one request,
  // best fits first. An invoiced row with no request number and exactly the
  // request's amount (as filed, or VAT-ex) was recorded by hand before requests
  // were tracked: it is that invoice (ties go to the request completed closest to
  // the row's Invoice Date, then the older request). Then rows waiting in For
  // Invoicing: the same currency first, then the closest amount.
  const pairs = [];
  for (const x of fresh) {
    const c = x.card;
    for (const row of x.legacy) {
      if (c.amount === null || row.currency !== c.currency) continue;
      if (!near(row.amount, c.amount) && !near(row.amount, round2(c.amount / rules.vatDivisor))) continue;
      const gap = row.invoiceDate && c.completedAt ? Math.abs(row.invoiceDate - c.completedAt) / DAY_MS / 1e4 : 0.5;
      pairs.push({ x, row, score: gap + (c.submittedAt || 0) / 1e16, link: true });
    }
    for (const row of x.free) pairs.push({ x, row, score: 1 + fitScore(row, c) });
  }
  pairs.sort((a, b) => a.score - b.score);
  const taken = new Set(), placed = new Map();
  for (const p of pairs) {
    if (taken.has(p.row.id) || placed.has(p.x)) continue;
    taken.add(p.row.id);
    placed.set(p.x, p);
    p.x.card.target = p.row.id;
  }
  for (const x of fresh) {
    const c = x.card, p = placed.get(x);
    if (p && p.link) {
      c.notes.push(`“${p.row.arName}” (${moneyOf(p.row)}, ${p.row.status}) is most likely this invoice: it has ` +
                   "the same amount and was recorded without a request number.");
    } else if (p) {
      if (p.row.currency && c.currency && p.row.currency !== c.currency) {
        c.notes.push(`“${p.row.arName}” is in ${p.row.currency}; the request is in ${c.currency}.`);
      }
    } else {
      const left = x.legacy.filter(e => !taken.has(e.id));
      if (left.length) {
        c.notes.push(`Collections has ${left.length} older row${left.length === 1 ? "" : "s"} for this project ` +
                     `without a request number (${left.slice(0, 2).map(e => `“${e.arName}” ${moneyOf(e)}`).join(", ")}` +
                     `${left.length > 2 ? ", …" : ""}). Check this invoice isn't one of them.`);
      }
      if (c.noNew && !c.blocked) c.blocked = c.noNew;
    }
  }

  // A withdrawn request's row goes back to For Invoicing, unless a new request is taking it.
  for (const w of withdrawn) {
    const row = w.targets[0].row;
    const taker = cards.find(c => c.target === row.id);
    if (taker) {
      taker.notes.push(`It replaces request ${w.requestNo} (${w.status.toLowerCase()}) on “${row.arName}”.`);
      hidden.void++;
      continue;
    }
    cards.push(w);
  }

  // Won projects (with a PAR) that have no Collections row and no request on its way.
  const busy = new Set(cards.map(c => c.code).filter(Boolean));
  const seen = new Set();
  for (const u of uni.rows) {
    if (!rules.wonStatuses.includes(u.status) || !u.par) continue;
    const codes = [...new Set(allCodes(u.codeText))];
    // Any row counts, Invalid included: that's how a won project is kept out of Collections.
    if (!codes.length || codes.some(c => coll.byCode.has(c) || busy.has(c) || seen.has(c))) continue;
    codes.forEach(c => seen.add(c));
    if (u.ignored) { hidden.ignored++; continue; }
    const code = codes[0];
    const dates = requestNos(u.par).map(n => requestDate(n, rules.utcOffsetHours)).filter(d => d !== null);
    const card = {
      kind: "invoice", id: u.id, record: null, source: "universe", ignoreField: rules.universeIgnoreField,
      step: "won", code, name: u.project, status: u.status, requestNo: "",
      submittedAt: dates.length ? Math.max(...dates) : null,
      amount: u.amountInc ? round2(u.amountInc) : null, currency: "PHP", businessUnit: u.businessUnit,
      targets: [], target: "new", canCreate: true, noNew: "", notes: [], blocked: "",
    };
    if (card.amount === null) card.blocked = card.noNew = "The Universe row has no amount yet.";
    if (projects(code).length > 1) card.notes.push(`${projects(code).length} Universe rows share ${code}; this uses “${u.project}”.`);
    cards.push(card);
  }

  cards.sort(bySubmittedDesc);
  return { cards, hidden };
}

/* What pushing a Collections card writes. `choices` = { targetId, arName, invalid }
   (`invalid`: a new row marked Invalid, for a won project that shouldn't be billed);
   `options` = Collections' select options, so values never invent new ones.
   Returns { mode: "create" | "update", rowId, action, fields, before, expect }:
   `fields` in Lark's write format (null clears a cell), `before` the row's
   current values of those fields, `expect` what the row must still say when
   the push happens (else someone changed it meanwhile). */
export function collectionsChange(card, choices, options, rules) {
  const invalid = !!choices.invalid && card.step === "won";
  const to = invalid ? rules.invalidStatuses[0] : stepStatus(card.step, rules);
  const t = invalid ? null : card.targets.find(x => x.id === (choices.targetId || card.target)) || null;
  const currency = matchOption(card.currency, options["Currency"]);
  if (!t) {
    const out = { "AR Name": (choices.arName || "").trim() || card.name, "Project Code": card.code };
    if (card.amount !== null) out["Invoice Amount"] = card.amount;
    if (currency) out["Currency"] = currency;
    if (card.requestNo) out["Invoice Request"] = Number(card.requestNo);
    out["Status"] = to;
    const bu = matchOption(card.businessUnit, options["Business Unit"]);
    if (bu) out["Business Unit"] = bu;
    return { mode: "create", rowId: null, action: "create", fields: out, before: {}, expect: null };
  }
  const row = t.row, out = {};
  if (t.action === "reset") {
    out["Invoice Request"] = null;
    if (row.status !== to) out["Status"] = to;
  } else if (t.action === "link") {
    out["Invoice Request"] = Number(card.requestNo);
  } else {
    if (row.ir !== card.requestNo) out["Invoice Request"] = Number(card.requestNo);
    if (row.status !== to) out["Status"] = to;
    if (card.step === "approved") {   // the invoice as issued: its amount may differ from the plan
      if (card.amount !== null && !near(row.amount, card.amount, 0.005)) out["Invoice Amount"] = card.amount;
      if (currency && currency !== row.currency) out["Currency"] = currency;
    }
  }
  const was = { "Invoice Request": row.ir ? Number(row.ir) : null, "Status": row.status || null,
                "Invoice Amount": row.amount, "Currency": row.currency || null };
  return { mode: "update", rowId: row.id, action: t.action, fields: out,
           before: Object.fromEntries(Object.keys(out).map(k => [k, was[k]])),
           expect: { status: row.status, ir: row.ir } };
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
  if (want === null) return got === null || got === undefined || got === "" || (Array.isArray(got) && !got.length);
  if (Array.isArray(want) && want.every(x => x && "file_token" in x)) {   // attachments: compare tokens
    const toks = (a) => (Array.isArray(a) ? a : []).map(x => x && x.file_token).filter(Boolean).sort().join(",");
    return toks(want) === toks(got);
  }
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

/* ======================= the Collections view ======================= */

/* One Collections record as a table row. */
export function collectionRow(r) {
  const f = r.fields || {};
  return {
    id: r.record_id,
    arName: clean(f["AR Name"]),
    code: clean(f["Project Code"]),
    amount: num(f["Invoice Amount"]),
    currency: clean(f["Currency"]),
    remarks: clean(f["Sales Remarks"]),
    status: clean(f["Status"]),
    am: people(Array.isArray(f["AM"]) ? f["AM"] : (f["AM"] && f["AM"].value) || (f["AM"] && f["AM"].users) || []),
    request: num(f["Invoice Request"]) === null ? "" : String(Math.round(f["Invoice Request"])),
    invoiceNo: clean(f["Invoice Number"]),
    siNo: clean(f["SI Number"]),
    invoiceDate: num(f["Invoice Date"]),
    files: (Array.isArray(f["Invoice"]) ? f["Invoice"] : []).filter(a => a && a.file_token)
      .map(a => ({ file_token: a.file_token, name: a.name || "file", size: a.size || 0 })),
  };
}

/* Invoice numbers sort by their number part ("INV-1670" after "INV-0177"); rows
   without one go last. */
const invNo = (s) => { const m = String(s || "").match(/\d+/g); return m ? Number(m[m.length - 1]) : null; };
export function compareInvoiceNo(a, b, dir = 1) {
  const x = invNo(a), y = invNo(b);
  if (x === null || y === null) return (x === null) - (y === null);
  return dir * (x - y) || dir * String(a).localeCompare(String(b));
}

/* Collections grouped by Status (in the column's option order), each group sorted
   by Invoice Number. `query` narrows by AR name, code, request, invoice or AM. */
export function collectionsView(records, { statusOrder = [], sort = "desc", query = "" } = {}) {
  const q = query.trim().toLowerCase();
  const rows = records.map(collectionRow).filter(r => !q ||
    [r.arName, r.code, r.request, r.invoiceNo, r.siNo, r.remarks, ...r.am.map(u => u.name)].join(" ").toLowerCase().includes(q));
  const byStatus = new Map();
  for (const r of rows) {
    if (!byStatus.has(r.status)) byStatus.set(r.status, []);
    byStatus.get(r.status).push(r);
  }
  const order = [...statusOrder, ...[...byStatus.keys()].filter(s => s && !statusOrder.includes(s)), ""];
  const dir = sort === "asc" ? 1 : -1;
  const groups = order.filter(s => byStatus.has(s)).map(status => ({
    status, rows: byStatus.get(status).sort((a, b) => compareInvoiceNo(a.invoiceNo, b.invoiceNo, dir) || a.arName.localeCompare(b.arName)),
  }));
  return { groups, count: rows.length };
}

/* Only the invoice details that changed, in Lark's write format. `files` are the
   attachments to keep plus newly uploaded ones ({file_token}). */
export function invoiceDetailsPatch(row, edit) {
  const out = {};
  const text = (k, before, after) => { if ((after || "").trim() !== (before || "")) out[k] = (after || "").trim() || null; };
  text("Invoice Number", row.invoiceNo, edit.invoiceNo);
  text("SI Number", row.siNo, edit.siNo);
  if ((edit.invoiceDate || null) !== (row.invoiceDate || null)) out["Invoice Date"] = edit.invoiceDate || null;
  const keep = (edit.files || []).map(f => f.file_token);
  if (keep.join(",") !== row.files.map(f => f.file_token).join(",")) out["Invoice"] = keep.map(t => ({ file_token: t }));
  return out;
}
