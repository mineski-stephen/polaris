/* Read-only check against the live tables in js/config.js. Writes nothing.
   Run: npm run check:live   (add --json to print the card lists as JSON)

   1. Every field the page uses exists with the right type and options.
   2. Builds the three card lists exactly as the page does and prints them.
   3. For every card, builds the payload the page would write and checks it is
      well-formed (types, select options, canonical codes, no blanks). */

import { RULES } from "../js/config.js";
import { loadEverything, selectOptions, writableOnly } from "../js/ops.js";
import {
  indexUniverse, indexCollections, briefCards, parCards, invoiceCards,
  universeFromBrief, collectionsFromInvoice, defaultVat, normCode, andonFromBrief,
} from "../js/sync.js";
import { tenantToken, makeCall, tables } from "./lark-node.mjs";

const call = makeCall(await tenantToken());
const T = tables();
const t0 = Date.now();
const { fields, problems, data } = await loadEverything(call, T, RULES);
console.log(`Loaded in ${Date.now() - t0} ms:`,
  Object.entries(data).map(([k, v]) => `${k} ${v.length}`).join(", "));

let failures = 0;
const fail = (msg) => { failures++; console.log("  ✗ " + msg); };

console.log("\nSchema:", problems.length ? "" : "all fields present with expected types ✓");
problems.forEach(fail);

const uni = indexUniverse(data.universe);
const coll = indexCollections(data.collections);
const briefs = briefCards(data.brief, uni, RULES);
const pending = new Set(briefs.cards.map(c => c.code).filter(Boolean));
const pars = parCards(data.par, data.brief, uni, pending, RULES);
const invoices = invoiceCards(data.invoice, uni, coll, pending, RULES);

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "----------");
const opts = (key, name) => selectOptions(fields[key].find(f => f.field_name === name));
const universeSelect = { "VAT%": opts("universe", "VAT%"), "Status": opts("universe", "Status"),
                         "Mancom Phase": opts("universe", "Mancom Phase") };
const collOpts = { "Currency": opts("collections", "Currency"), "Business Unit": opts("collections", "Business Unit"),
                   "Status": opts("collections", "Status") };

function checkPayload(label, payload, selects) {
  for (const [k, v] of Object.entries(payload)) {
    if (v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length)) fail(`${label}: ${k} is blank`);
    for (const x of Array.isArray(v) && v.every(e => typeof e === "string") ? v : [v]) {
      if (selects[k] && !selects[k].includes(x)) fail(`${label}: ${k} = "${x}" is not an existing option`);
    }
  }
  if ("Project Code" in payload && payload["Project Code"] !== normCode(payload["Project Code"])) {
    fail(`${label}: Project Code "${payload["Project Code"]}" isn't canonical`);
  }
}

console.log(`\nProject Brief cards: ${briefs.cards.length}  hidden: ${JSON.stringify(briefs.hidden)}`);
for (const c of briefs.cards) {
  const vat = defaultVat(c.currency);
  const p = universeFromBrief(c, { vat, client: "" }, RULES);
  checkPayload(c.code, p, universeSelect);
  if (uni.byCode.has(c.code)) fail(`${c.code} is already in the Universe but shows as a card`);
  if (!("Amount (VAT-Ex.) (PHP)" in p)) fail(`${c.code}: no amount computed`);
  console.log(`  ${day(c.submittedAt)} ${c.code} ${c.status.padEnd(12)} ${c.currency} ${String(c.value).padStart(11)} ` +
              `→ ₱${p["Amount (VAT-Ex.) (PHP)"]} @${vat}  ${c.name.slice(0, 50)}` +
              (c.similar ? `\n${" ".repeat(13)}≈ ${c.similar.code} “${c.similar.project.slice(0, 50)}” (${c.similar.score.toFixed(2)})` : ""));
}

console.log(`\nPAR cards: ${pars.cards.length}  hidden: ${JSON.stringify(pars.hidden)}`);
for (const c of pars.cards) {
  if (uni.parNos.has(c.requestNo)) fail(`PAR ${c.requestNo} is already in the Universe but shows as a card`);
  if (!c.blocked && !c.target) fail(`PAR ${c.requestNo} has no target row`);
  console.log(`  ${day(c.submittedAt)} ${c.requestNo} → ${c.code} ${c.status.padEnd(12)} ${c.blocked ? "[blocked] " : ""}` +
              `${c.name.slice(0, 45)}${c.target && c.target.par ? `  (row has PAR ${c.target.par})` : ""}` +
              c.notes.map(n => `\n${" ".repeat(13)}! ${n}`).join(""));
}

console.log(`\nInvoice cards: ${invoices.cards.length}  hidden: ${JSON.stringify(invoices.hidden)}`);
for (const c of invoices.cards) {
  if (coll.irNos.has(c.requestNo)) fail(`Invoice ${c.requestNo} is already in Collections but shows as a card`);
  if (!c.blocked) checkPayload(c.requestNo, collectionsFromInvoice(c, { arName: "" }, collOpts, RULES), collOpts);
  console.log(`  ${day(c.submittedAt)} ${c.requestNo} → ${c.code || "(no code)"} ${c.status.padEnd(12)} ` +
              `${c.currency} ${String(c.amount).padStart(11)} ${c.blocked ? "[blocked] " : ""}${c.name.slice(0, 40)}` +
              c.notes.map(n => `\n${" ".repeat(13)}! ${n}`).join(""));
}

if (data.andon) {
  const andonIdx = indexUniverse(data.andon);
  const andon = briefCards(data.brief, andonIdx, RULES, { allDepartments: true, kind: "andon" });
  const aOpts = Object.fromEntries(fields.andon.filter(f => f.type === 3 || f.type === 4).map(f => [f.field_name, selectOptions(f)]));
  console.log(`
ANDON cards: ${andon.cards.length}  hidden: ${JSON.stringify(andon.hidden)}`);
  for (const c of andon.cards) {
    if (andonIdx.byCode.has(c.code)) fail(`${c.code} is already in ANDON but shows as a card`);
    const p = writableOnly(andonFromBrief(c, {}, RULES, aOpts), fields.andon);
    checkPayload(c.code, p, aOpts);
    for (const k of Object.keys(p)) if (!fields.andon.some(f => f.field_name === k)) fail(`${c.code}: ${k} isn't an ANDON column`);
    console.log(`  ${day(c.submittedAt)} ${c.code} ${c.department.slice(0, 18).padEnd(18)} ${c.status.padEnd(12)} ${Object.keys(p).length} cols  ${c.name.slice(0, 40)}`);
  }
}

if (process.argv.includes("--json")) {
  const ids = (l) => l.cards.map(c => ({ id: c.id, code: c.code, requestNo: c.requestNo, blocked: c.blocked || "" }));
  console.log("\nJSON " + JSON.stringify({ brief: ids(briefs), par: ids(pars), invoice: ids(invoices) }));
}

console.log(failures ? `\n${failures} problem(s) found.` : "\nAll live checks passed ✓");
process.exitCode = failures ? 1 : 0;
