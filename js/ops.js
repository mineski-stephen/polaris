/* Every Lark read and write the page makes.

   Each function takes `call(method, url, body)`, which sends one Lark Open API
   request and resolves with its JSON body (or throws on a Lark error). The page
   passes one that goes through the CORS proxy with the signed-in user's token;
   the Node checks in tests/ pass one that calls Lark directly. Both therefore run
   exactly the same push logic. */

import {
  indexUniverse, indexCollections, verifyWritten, parAfterAdding, clean,
} from "./sync.js";

export const OPEN_API = "https://open.larksuite.com/open-apis";
export const PAGE_SIZE = 500;   // Lark's max for records/search
const MAX_PAGES = 200;          // runaway guard: 100,000 records
const PAGE_DELAY_MS = 120;      // pause between pages to stay clear of rate limits
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ======================= tables ======================= */

/* "https://<tenant>.larksuite.com/base/<app>?table=<tbl>&view=<vew>" → {app, table, url} */
export function parseBaseLink(link) {
  const u = new URL(link);
  const app = (u.pathname.match(/\/base\/([A-Za-z0-9]+)/) || [])[1];
  const table = u.searchParams.get("table") || "";
  if (!app || !/^tbl[A-Za-z0-9]+$/.test(table)) throw new Error(`Not a Lark Base table link: ${link}`);
  return { app, table, url: link };
}

export const TABLE_TITLES = {
  universe: "Universe", collections: "Collections", brief: "Project Brief",
  par: "Project Approval", invoice: "Invoice Request", andon: "ANDON",
};

/* Lark field type ids. */
const T = { text: 1, number: 2, select: 3, multi: 4, date: 5, checkbox: 7, user: 11, url: 15 };
/* Columns Lark fills itself (lookup, formula, link, stage, auto fields): never written. */
const COMPUTED = new Set([18, 19, 20, 21, 24, 1001, 1002, 1003, 1004, 1005]);
const TYPE_NAMES = { 1: "Text", 2: "Number", 3: "Single select", 4: "Multi select", 5: "Date",
                     7: "Checkbox", 11: "Person", 15: "URL", 17: "Attachment", 18: "Link",
                     19: "Lookup", 20: "Formula" };

/* Every field the page reads or writes, with its required type. Reads only fetch
   these columns. `options` lists select values the page writes, which must exist. */
export function schemaSpec(rules) {
  return {
    universe: {
      // Everything the cards and the Universe view need; `index` is the lean set
      // re-read just before a push to rule out duplicates.
      read: ["Project Code", "Project", "Client", "PAR", "Amount (VAT-Ex.) (PHP)", "BD", "AM",
             "RFP Received Date", "Status", "Year"],
      index: ["Project Code", "Project", "Client", "PAR"],
      fields: {
        "Client": T.text, "Project": T.text, "Project Code": T.text, "PAR": T.text,
        "AM": T.user, "BD": T.user, "MKT": T.user,
        "Amount (VAT-Ex.) (PHP)": T.number, "VAT%": T.select,
        "Project Description": T.text, "Project Start": T.date, "Project End": T.date,
        "RFP Received Date": T.date, "Year": T.text, "Status": T.select,
        "Mancom Phase": T.select, "Other Links": T.text,
      },
      options: {
        "VAT%": ["12%", "0%"],
        "Status": [rules.newProjectStatus],
        "Mancom Phase": [rules.newProjectMancomPhase],
      },
    },
    collections: {
      read: ["Project Code", "Invoice Request", "AR Name", "Invoice Amount", "Currency", "Sales Remarks", "Status",
             "AM", "Invoice Number", "SI Number", "Invoice", "Invoice Date"],
      index: ["Project Code", "Invoice Request", "AR Name", "Invoice Amount", "Currency"],
      fields: {
        "AR Name": T.text, "Project Code": T.text, "Invoice Amount": T.number,
        "Currency": T.select, "Status": T.select, "Business Unit": T.select, "Invoice Request": T.number,
        "Sales Remarks": T.text, "Invoice Number": T.text, "SI Number": T.text, "Invoice": 17, "Invoice Date": T.date,
      },
      options: {
        "Status": [...new Set([...Object.values(rules.collectionStatus), rules.collectionStatusPending])],
      },
    },
    brief: {
      fields: {
        "Request No.": T.url, "Project Code": T.text, "Project Name": T.text, "Remarks": T.text,
        "Status": T.select, "Submitted at": T.date, "Initiator department": T.text,
        "Contract Value": T.number, "Contract Value-Currency": T.select,
        "Attachment (Project Brief, Pitch Deck)": T.url,
        "AM": T.user, "BD": T.user, "MKT": T.user, "Start date": T.date, "End date": T.date,
        "IGNORE": T.checkbox,
        "Business Unit": T.select,
      },
      optional: { "Required Tools": T.multi },
    },
    andon: {
      // What a person types into an ANDON row. ANDON fills the rest (Brief, Brief Status,
      // amounts, YEAR, MONTH…) itself from the Project Code and dates.
      read: ["Project Code", "Project", "PM (LEAD)", "PM (SUPP)"],
      index: ["Project Code", "Project"],
      fields: {
        "Project": T.text, "Project Code": T.text, "AM": T.user, "PM (LEAD)": T.user, "MKT (PITCH)": T.user,
        "Business Unit": T.select, "Tools": T.multi, "TRIBE": T.select, "Event Start": T.date, "Event End": T.date,
      },
    },
    par: {
      fields: {
        "Request No.": T.url, "Project Code": T.text, "Project Name": T.text, "Status": T.select,
        "Submitted at": T.date, "Associated Project Brief": T.text, "IGNORE": T.checkbox,
      },
    },
    invoice: {
      fields: {
        "Request No.": T.url, "Status": T.select, "Submitted at": T.date, "Initiator department": T.text,
        "Business Unit": T.select, "Project Name": T.text, "Project Code": T.text,
        "Amount": T.number, "Amount-Currency": T.select, "IGNORE": T.checkbox,
      },
    },
  };
}

const tableUrl = (t) => `${OPEN_API}/bitable/v1/apps/${encodeURIComponent(t.app)}/tables/${encodeURIComponent(t.table)}`;

/* ======================= reads ======================= */

export async function loadFields(call, t) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await call("GET", `${tableUrl(t)}/fields?page_size=100` +
                                (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""));
    const d = j.data || {};
    out.push(...(d.items || []));
    if (!d.has_more || !d.page_token) return out;
    pageToken = d.page_token;
  }
  return out;
}

/* All records of a table (never through a view: views filter rows, and a
   missing Universe row would look like a project that still needs pushing). */
export async function loadRecords(call, t, fieldNames, onPage) {
  const items = [];
  let pageToken = "";
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const j = await call("POST", `${tableUrl(t)}/records/search?page_size=${PAGE_SIZE}` +
                                 (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""),
                         { field_names: fieldNames, automatic_fields: false });
    const d = j.data || {};
    items.push(...(d.items || []));
    if (onPage) onPage(items.length, typeof d.total === "number" ? d.total : null);
    if (!d.has_more) return items;
    if (!d.page_token) throw new Error("Lark said there are more records but gave no page token.");
    pageToken = d.page_token;
    await sleep(PAGE_DELAY_MS);
  }
  throw new Error(`Stopped after ${MAX_PAGES} pages; the table is larger than this page supports.`);
}

/* Check one table's fields against the spec. Returns a list of problems (strings). */
export function checkSchema(key, fields, spec) {
  const title = TABLE_TITLES[key];
  const byName = new Map(fields.map(f => [f.field_name, f]));
  const problems = [];
  for (const [name, type] of Object.entries(spec.fields)) {
    const f = byName.get(name);
    if (!f) { problems.push(`${title}: column “${name}” is missing.`); continue; }
    if (f.type !== type) {
      problems.push(`${title}: column “${name}” is ${TYPE_NAMES[f.type] || "type " + f.type}, expected ${TYPE_NAMES[type]}.`);
    }
  }
  for (const [name, type] of Object.entries(spec.optional || {})) {
    const f = byName.get(name);
    if (f && f.type !== type) {
      problems.push(`${title}: column “${name}” is ${TYPE_NAMES[f.type] || "type " + f.type}, expected ${TYPE_NAMES[type]}.`);
    }
  }
  for (const [name, wanted] of Object.entries(spec.options || {})) {
    const have = selectOptions(byName.get(name));
    for (const w of wanted) {
      if (byName.has(name) && !have.includes(w)) problems.push(`${title}: “${name}” has no option “${w}”.`);
    }
  }
  return problems;
}

export const computedTypes = COMPUTED;
export const selectOptions = (field) => ((field && field.property && field.property.options) || []).map(o => o.name);

/* Load the schema and every record the page needs, all tables in parallel.
   Returns { fields: {key: [field]}, problems: [string], data: {key: [record]} }. */
export async function loadEverything(call, tables, rules, onProgress) {
  const spec = schemaSpec(rules);
  const keys = Object.keys(spec);
  const fields = {}, data = {}, tableProblems = {};
  await Promise.all(keys.filter(k => tables[k]).map(async (k) => {
    fields[k] = await loadFields(call, tables[k]);
    tableProblems[k] = checkSchema(k, fields[k], spec[k]);
    const present = new Set(fields[k].map(f => f.field_name));
    const want = (spec[k].read || [...Object.keys(spec[k].fields), ...Object.keys(spec[k].optional || {})])
      .filter(n => present.has(n));
    data[k] = await loadRecords(call, tables[k], want, (n, total) => onProgress && onProgress(k, n, total));
  }));
  // `problems`: every table; `tableProblems`: by table, so a broken ANDON only stops ANDON pushes.
  return { fields, problems: Object.values(tableProblems).flat(), tableProblems, data };
}

/* ======================= writes ======================= */

/* A push the destination already has (someone else got there first). Nothing was written. */
export class AlreadyDone extends Error {
  constructor(message) { super(message); this.name = "AlreadyDone"; }
}

export function newClientToken() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* client_token makes the create idempotent: retrying after a lost response
   with the same token returns the first record instead of adding another. */
export async function createRecord(call, t, fields, clientToken) {
  const j = await call("POST", `${tableUrl(t)}/records` +
                               (clientToken ? `?client_token=${encodeURIComponent(clientToken)}` : ""),
                       { fields });
  const rec = j.data && j.data.record;
  if (!rec || !rec.record_id) throw new Error("Lark didn't return the new record.");
  return rec;
}

/* batch_get, not GET …/records/{id}: the single-record GET returns a display
   format (numbers as strings, text unsegmented) that doesn't match what search
   returns or what was written. batch_get returns the same format as search. */
export async function getRecord(call, t, recordId) {
  const j = await call("POST", `${tableUrl(t)}/records/batch_get`, { record_ids: [recordId] });
  const rec = ((j.data && j.data.records) || []).find(r => r.record_id === recordId);
  if (!rec) throw new Error(`Couldn't read back record ${recordId}.`);
  return rec;
}

/* batch_update is a POST, so every write uses the proxy's POST route. */
export async function updateRecord(call, t, recordId, fields) {
  await call("POST", `${tableUrl(t)}/records/batch_update`, { records: [{ record_id: recordId, fields }] });
}

const universeIndex = async (call, tables, rules) =>
  indexUniverse(await loadRecords(call, tables.universe, schemaSpec(rules).universe.index));

/* The Universe again, fresh from Lark, with every column the page shows. */
export async function loadUniverse(call, tables, rules) {
  return loadRecords(call, tables.universe, schemaSpec(rules).universe.read);
}

/* After a write has succeeded: read the record back and compare. A failed read
   doesn't undo the write, so it's reported as `readBackError`, not thrown. */
async function readBack(call, t, recordId, written) {
  try {
    const back = await getRecord(call, t, recordId);
    return { mismatches: verifyWritten(written, back.fields), readBackError: null };
  } catch (e) {
    return { mismatches: null, readBackError: e };
  }
}

/* Brief → new Universe row. Re-reads the Universe first so a project someone
   else just added is never added twice; then creates, reads back and compares. */
export async function pushBrief(call, tables, rules, card, fields, clientToken) {
  const uni = await universeIndex(call, tables, rules);
  if (uni.byCode.has(card.code)) throw new AlreadyDone(`${card.code} is already in the Universe.`);
  const rec = await createRecord(call, tables.universe, fields, clientToken);
  return { recordId: rec.record_id, written: fields,
           ...await readBack(call, tables.universe, rec.record_id, fields) };
}

/* PAR → the PAR cell of an existing Universe row (appended if it already has one). */
export async function pushPar(call, tables, rules, card, targetId) {
  const uni = await universeIndex(call, tables, rules);
  if (uni.parNos.has(card.requestNo)) throw new AlreadyDone(`PAR ${card.requestNo} is already in the Universe.`);
  const row = uni.rows.find(r => r.id === targetId);
  if (!row) throw new Error("That Universe row no longer exists. Refresh and try again.");
  const next = parAfterAdding(row.par, card.requestNo);
  if (next === null) throw new AlreadyDone(`PAR ${card.requestNo} is already on that row.`);
  const written = { PAR: next };
  await updateRecord(call, tables.universe, targetId, written);
  return { recordId: targetId, before: clean(row.par), written,
           ...await readBack(call, tables.universe, targetId, written) };
}

/* Only the columns a person can type into (lookups, formulas and the like are
   filled by Lark), and only columns the table has. */
export function writableOnly(payload, fields) {
  const byName = new Map(fields.map(f => [f.field_name, f]));
  return Object.fromEntries(Object.entries(payload).filter(([k]) => byName.has(k) && !COMPUTED.has(byName.get(k).type)));
}

/* Brief → new ANDON row, with the same re-check, idempotent create and read-back as the Universe. */
export async function pushAndon(call, tables, rules, card, fields, clientToken) {
  const andon = indexUniverse(await loadRecords(call, tables.andon, schemaSpec(rules).andon.index));
  if (andon.byCode.has(card.code)) throw new AlreadyDone(`${card.code} is already in ANDON.`);
  const rec = await createRecord(call, tables.andon, fields, clientToken);
  return { recordId: rec.record_id, written: fields, ...await readBack(call, tables.andon, rec.record_id, fields) };
}

/* Invoice request → new Collections row, unless one already carries its request number. */
export async function pushInvoice(call, tables, rules, card, fields, clientToken) {
  const coll = indexCollections(await loadRecords(call, tables.collections, schemaSpec(rules).collections.index));
  if (coll.irNos.has(card.requestNo)) {
    throw new AlreadyDone(`Invoice request ${card.requestNo} is already in Collections.`);
  }
  const rec = await createRecord(call, tables.collections, fields, clientToken);
  return { recordId: rec.record_id, written: fields,
           ...await readBack(call, tables.collections, rec.record_id, fields) };
}

/* The Collections table again, fresh from Lark. */
export async function loadCollections(call, tables, rules) {
  return loadRecords(call, tables.collections, schemaSpec(rules).collections.read);
}

/* Invoice details typed in by finance (Invoice Number, SI Number, Invoice Date, the
   invoice file): writes only what changed, then reads it back. */
export async function saveInvoiceDetails(call, tables, recordId, patch) {
  await updateRecord(call, tables.collections, recordId, patch);
  return { recordId, written: patch, ...await readBack(call, tables.collections, recordId, patch) };
}

/* Tick (or untick) a source row's IGNORE box, then confirm it stuck. */
export async function setIgnore(call, t, recordId, value, field = "IGNORE") {
  const written = { [field]: value };
  await updateRecord(call, t, recordId, written);
  return { recordId, written, ...await readBack(call, t, recordId, written) };
}
