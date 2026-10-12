/* End-to-end integrity check. It WRITES to the tables in js/config.js, so it
   refuses to run unless ENV_LABEL is "Test copy".

   Runs in the browser (tests/e2e.html, as the signed-in user, the way the page
   writes) or in Node (tests/e2e.mjs). Using the same ops.js functions as the
   page, it:
     1. snapshots every stored (non-computed) field of all five tables,
     2. pushes the newest brief, a PAR (preferring one that appends to an
        existing PAR) and the newest clean invoice, then ignores and un-ignores
        a brief,
     3. re-pushes each one and expects "already done" (no duplicates),
     4. snapshots again and requires the difference to be exactly:
        one new Universe row, one Universe PAR cell, one new Collections row,
        and nothing else anywhere. */

import { ENV_LABEL, RULES } from "../js/config.js";
import {
  loadEverything, loadFields, loadRecords, selectOptions, getRecord,
  pushBrief, pushPar, pushInvoice, pushAndon, writableOnly, setIgnore, AlreadyDone, newClientToken, TABLE_TITLES,
} from "../js/ops.js";
import {
  indexUniverse, indexCollections, briefCards, parCards, invoiceCards,
  universeFromBrief, collectionsFromInvoice, defaultVat, verifyWritten, parAfterAdding, plain,
  peoplePool, universeView, andonFromBrief, pmPool,
} from "../js/sync.js";

const COMPUTED = new Set([19, 20, 1001, 1002, 1003, 1004, 1005]);   // lookup, formula, auto fields

/* Normalise a cell so equal values compare equal: empty-ish values are all
   "empty", volatile parts (temporary attachment URLs, avatars) are dropped. */
function norm(v) {
  if (v === false || v === null || v === "" || (Array.isArray(v) && !v.length)) return undefined;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    if ("file_token" in v) return { file_token: v.file_token, name: v.name, size: v.size };
    if ("id" in v && ("name" in v || "en_name" in v)) return { id: v.id };
    const entries = Object.keys(v).sort().map(k => [k, norm(v[k])]).filter(([, x]) => x !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;   // e.g. {link_record_ids: null}
  }
  return v;
}
const storedKeys = (fields) => Object.keys(fields).filter(k => norm(fields[k]) !== undefined).sort().join("|");

function diff(before, after) {
  const out = {};
  for (const k of Object.keys(before)) {
    const added = [], removed = [], changed = [];
    for (const id of after[k].keys()) if (!before[k].has(id)) added.push(id);
    for (const id of before[k].keys()) if (!after[k].has(id)) removed.push(id);
    for (const [id, f0] of before[k]) {
      const f1 = after[k].get(id);
      if (!f1) continue;
      const names = new Set([...Object.keys(f0), ...Object.keys(f1)]);
      const fields = [...names].filter(n => JSON.stringify(norm(f0[n])) !== JSON.stringify(norm(f1[n])));
      if (fields.length) changed.push({ id, fields });
    }
    out[k] = { added, removed, changed };
  }
  return out;
}

/* `call` = (method, url, body) → Lark JSON; `T` = parsed table links; `log` prints a line.
   Resolves with the number of failed checks. */
export async function runE2E(call, T, log) {
  if (ENV_LABEL !== "Test copy") {
    log(`Refusing to run: js/config.js says ENV_LABEL = "${ENV_LABEL}", not "Test copy".`);
    return 1;
  }
  let failures = 0;
  const ok = (cond, msg) => { log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };

  async function snapshot() {
    const snap = {};
    for (const k of Object.keys(T)) {
      const fields = await loadFields(call, T[k]);
      const computed = new Set(fields.filter(f => COMPUTED.has(f.type)).map(f => f.field_name));
      // No field_names (Lark caps that list at 50): fetch every column, drop the computed ones here.
      const recs = await loadRecords(call, T[k], undefined);
      snap[k] = new Map(recs.map(r => [r.record_id, Object.fromEntries(
        Object.entries(r.fields || {}).filter(([n]) => !computed.has(n)))]));
    }
    return snap;
  }

  /* ---------- pick what to push ---------- */
  log(`E2E against: ${ENV_LABEL}`);
  const before = await snapshot();
  log("Snapshot taken: " + Object.entries(before).map(([k, m]) => `${k} ${m.size}`).join(", "));

  const { fields, problems, data } = await loadEverything(call, T, RULES);
  ok(problems.length === 0, `schema check (${problems.length} problems)`);
  const uni = indexUniverse(data.universe);
  const coll = indexCollections(data.collections);
  const briefs = briefCards(data.brief, uni, RULES);
  const pending = new Set(briefs.cards.map(c => c.code));
  const pars = parCards(data.par, data.brief, uni, pending, RULES);
  const invoices = invoiceCards(data.invoice, uni, coll, pending, RULES);

  const brief = briefs.cards.find(c => !c.problems.length);
  const par = pars.cards.find(c => !c.blocked && c.target.par && c.targets.length === 1)
           || pars.cards.find(c => !c.blocked && c.targets.length === 1);
  const invoice = invoices.cards.find(c => !c.blocked && !c.notes.length);
  const ignoreMe = briefs.cards.find(c => c !== brief);
  if (!brief || !par || !invoice || !ignoreMe) { log("Not enough cards to test with."); return 1; }

  const collOptions = Object.fromEntries(["Currency", "Business Unit"].map(n =>
    [n, selectOptions(fields.collections.find(f => f.field_name === n))]));

  /* ---------- 1. brief → Universe ---------- */
  log(`\n1. Push brief ${brief.code} “${brief.name}” (${brief.currency} ${brief.value}, ${brief.status})`);
  // As a user would fill the sheet: a client typed in, the most frequent Universe BD
  // picked, Other Links left blank (the default).
  const bdPick = peoplePool(data.universe, data.brief).find(p => p.bdCount > 0);
  const briefChoices = { vat: defaultVat(brief.currency), client: brief.name.split(" - ")[0],
                         bd: bdPick ? [bdPick] : [], otherLinks: "" };
  const briefFields = universeFromBrief(brief, briefChoices, RULES);
  ok(!("Other Links" in briefFields), "Other Links is left blank by default");
  ok(bdPick ? JSON.stringify(briefFields.BD) === JSON.stringify([{ id: bdPick.id }]) : !("BD" in briefFields),
     `BD is the person picked (${bdPick ? bdPick.name : "nobody"}), not the brief's BD`);
  const b1 = await pushBrief(call, T, RULES, brief, briefFields, newClientToken());
  ok(!b1.readBackError, "read back the new Universe row");
  ok(b1.mismatches && b1.mismatches.length === 0,
     `all ${Object.keys(briefFields).length} written fields match on read-back` +
     (b1.mismatches && b1.mismatches.length ? `: ${JSON.stringify(b1.mismatches)}` : ""));
  const newU = await getRecord(call, T.universe, b1.recordId);
  const expectAmount = Math.round(brief.value * (brief.currency === "USD" ? 57 : 1) /
                                  (briefChoices.vat === "12%" ? 1.12 : 1) * 100) / 100;
  ok(Number(newU.fields["Amount (VAT-Ex.) (PHP)"]) === expectAmount,
     `Amount (VAT-Ex.) (PHP) = ${newU.fields["Amount (VAT-Ex.) (PHP)"]} (independent calc ${expectAmount})`);
  ok(plain(newU.fields["Amount (VAT-Inc.)"]) !== "",
     `Universe's own VAT-Inc. formula computed ${plain(newU.fields["Amount (VAT-Inc.)"])} from it`);
  ok(plain(newU.fields["Other Links"]) === "", "Other Links is empty in Lark");
  // The Universe view (what Polaris shows after a push) finds the new row in its group.
  const view = universeView([newU], { year: briefFields.Year, hidden: ["Lost", "Stalled", "Archived"],
                                      statusOrder: [RULES.newProjectStatus] });
  ok(view.groups.length === 1 && view.groups[0].status === RULES.newProjectStatus && view.groups[0].rows[0].id === b1.recordId,
     `the Universe view shows it under "${RULES.newProjectStatus}" for ${briefFields.Year}`);
  try {
    await pushBrief(call, T, RULES, brief, briefFields, newClientToken());
    ok(false, "second push of the same brief was refused");
  } catch (e) { ok(e instanceof AlreadyDone, `second push of the same brief was refused (${e.message})`); }

  /* ---------- 2. PAR → Universe ---------- */
  log(`\n2. Push PAR ${par.requestNo} → ${par.code} “${par.target.project}” (row PAR before: “${par.target.par || ""}”)`);
  const p1 = await pushPar(call, T, RULES, par, par.target.id);
  ok(p1.written.PAR === parAfterAdding(par.target.par, par.requestNo), `PAR cell becomes “${p1.written.PAR}”`);
  ok(p1.mismatches && p1.mismatches.length === 0, "PAR read-back matches");
  try {
    await pushPar(call, T, RULES, par, par.target.id);
    ok(false, "second push of the same PAR was refused");
  } catch (e) { ok(e instanceof AlreadyDone, `second push of the same PAR was refused (${e.message})`); }

  /* ---------- 3. invoice → Collections ---------- */
  log(`\n3. Push invoice ${invoice.requestNo} → ${invoice.code} (${invoice.currency} ${invoice.amount}, ${invoice.status})`);
  const invFields = collectionsFromInvoice(invoice, { arName: "" }, collOptions, RULES);
  const i1 = await pushInvoice(call, T, RULES, invoice, invFields, newClientToken());
  ok(i1.mismatches && i1.mismatches.length === 0,
     `all ${Object.keys(invFields).length} Collections fields match on read-back` +
     (i1.mismatches && i1.mismatches.length ? `: ${JSON.stringify(i1.mismatches)}` : ""));
  const newC = await getRecord(call, T.collections, i1.recordId);
  ok(plain(newC.fields["Project Name"]) !== "",
     `Collections' lookups found the project in the Universe: “${plain(newC.fields["Project Name"])}”, ` +
     `PAR “${plain(newC.fields["PAR"])}”, AM “${plain(newC.fields["AM"])}”`);
  try {
    await pushInvoice(call, T, RULES, invoice, invFields, newClientToken());
    ok(false, "second push of the same invoice was refused");
  } catch (e) { ok(e instanceof AlreadyDone, `second push of the same invoice was refused (${e.message})`); }

  /* ---------- 4. ignore + undo ---------- */
  log(`\n4. Ignore then restore brief ${ignoreMe.code}`);
  const g1 = await setIgnore(call, T.brief, ignoreMe.id, true);
  ok(g1.mismatches && g1.mismatches.length === 0, "IGNORE ticked and read back");
  {
    const recs = await loadRecords(call, T.brief, ["Project Code", "Initiator department", "IGNORE", "Status",
                                                    "Project Name", "Request No.", "Submitted at"]);
    const u = indexUniverse(await loadRecords(call, T.universe, ["Project Code", "Project", "Client", "PAR"]));
    ok(!briefCards(recs, u, RULES).cards.some(c => c.id === ignoreMe.id), "ignored brief no longer listed");
  }
  const g2 = await setIgnore(call, T.brief, ignoreMe.id, false);
  ok(g2.mismatches && g2.mismatches.length === 0, "IGNORE cleared (undo) and read back");

  /* ---------- 5. nothing else changed ---------- */
  log("\n5. Compare every stored field of every table, before vs after");
  const after = await snapshot();
  const d = diff(before, after);
  for (const k of Object.keys(d)) {
    const { added, removed, changed } = d[k];
    log(`  ${TABLE_TITLES[k]}: +${added.length} −${removed.length} ~${changed.length}` +
        changed.map(c => ` [${c.id}: ${c.fields.join(", ")}]`).join(""));
  }
  ok(d.universe.added.length === 1 && d.universe.added[0] === b1.recordId, "Universe: exactly one new row, the pushed brief");
  ok(d.universe.changed.length === 1 && d.universe.changed[0].id === par.target.id
     && d.universe.changed[0].fields.join() === "PAR", "Universe: exactly one changed row, and only its PAR cell");
  ok(d.collections.added.length === 1 && d.collections.added[0] === i1.recordId && !d.collections.changed.length,
     "Collections: exactly one new row, nothing else changed");
  for (const k of ["brief", "par", "invoice"]) {
    ok(!d[k].added.length && !d[k].removed.length && !d[k].changed.length, `${TABLE_TITLES[k]}: unchanged`);
  }
  ok(!d.universe.removed.length && !d.collections.removed.length, "nothing removed anywhere");

  // The new rows hold exactly what was sent, and nothing else stored.
  const storedU = after.universe.get(b1.recordId) || {};
  ok(storedKeys(storedU) === Object.keys(briefFields).sort().join("|"),
     `new Universe row stores only the ${Object.keys(briefFields).length} pushed fields`);
  const storedC = after.collections.get(i1.recordId) || {};
  ok(storedKeys(storedC) === Object.keys(invFields).sort().join("|"),
     `new Collections row stores only the ${Object.keys(invFields).length} pushed fields`);
  ok(verifyWritten(briefFields, storedU).length === 0 && verifyWritten(invFields, storedC).length === 0,
     "full-table re-read agrees with what was sent");

  log(`\nRecords written (test copy):\n  Universe new row  ${b1.recordId}  (${brief.code})\n` +
      `  Universe PAR      ${par.target.id}  (${par.code}: “${par.target.par || ""}” → “${p1.written.PAR}”)\n` +
      `  Collections row   ${i1.recordId}  (request ${invoice.requestNo})\n` +
      `  Brief IGNORE      ${ignoreMe.id}  (${ignoreMe.code}: ticked, then cleared)`);
  log(failures ? `\n${failures} check(s) FAILED.` : "\nAll end-to-end checks passed ✓");
  return failures;
}

/* ANDON end-to-end: one brief → one new ANDON row, nothing else changed. Run in
   the browser (tests/e2e.html), as the user: the ANDON test Base only opens for users. */
export async function runAndonE2E(call, T, log) {
  if (ENV_LABEL !== "Test copy") { log(`Refusing to run: ENV_LABEL is "${ENV_LABEL}", not "Test copy".`); return 1; }
  let failures = 0;
  const ok = (cond, msg) => { log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; return cond; };
  const snap = async (k) => {
    const fields = await loadFields(call, T[k]);
    const computed = new Set(fields.filter(f => COMPUTED.has(f.type)).map(f => f.field_name));
    const recs = await loadRecords(call, T[k], undefined);
    return { fields, map: new Map(recs.map(r => [r.record_id, Object.fromEntries(
      Object.entries(r.fields || {}).filter(([n]) => !computed.has(n)))])) };
  };
  log("ANDON E2E against: " + ENV_LABEL);
  const before = { andon: await snap("andon"), brief: await snap("brief") };
  log(`Snapshot taken: andon ${before.andon.map.size}, brief ${before.brief.map.size}`);

  const { fields, tableProblems, data } = await loadEverything(call, T, RULES);
  ok(!(tableProblems.andon || []).length && !(tableProblems.brief || []).length,
     `ANDON and Project Brief columns check out ${JSON.stringify([...(tableProblems.andon || []), ...(tableProblems.brief || [])])}`);
  const andonIdx = indexUniverse(data.andon);
  const cards = briefCards(data.brief, andonIdx, RULES, { allDepartments: true, kind: "andon" }).cards;
  const card = cards.find(c => !c.problems.length);
  if (!card) { log("No ANDON cards to test with."); return 1; }
  const opts = Object.fromEntries(fields.andon.filter(f => f.type === 3 || f.type === 4).map(f => [f.field_name, selectOptions(f)]));
  const pm = pmPool(data.andon, data.universe)[0];
  const tribe = (opts.TRIBE || []).find(t => t === "TRIBE D - Marketing") || (opts.TRIBE || [])[0];
  const payload = writableOnly(andonFromBrief(card, { pm: pm ? [pm] : [], tribe }, RULES, opts), fields.andon);

  log(`\n1. Add ${card.code} “${card.name}” (${card.department}) with PM ${pm ? pm.name : "none"}, ${tribe}`);
  log(`   writes: ${Object.keys(payload).join(", ")}`);
  ok(!["Brief", "YEAR", "MONTH", "Brief Status", "Remarks"].some(k => k in payload),
     "columns ANDON fills itself (lookups, formulas) are not written");
  const r1 = await pushAndon(call, T, RULES, card, payload, newClientToken());
  ok(!r1.readBackError && r1.mismatches.length === 0,
     `all ${Object.keys(payload).length} written columns match on read-back ${r1.mismatches ? JSON.stringify(r1.mismatches) : r1.readBackError}`);
  try { await pushAndon(call, T, RULES, card, payload, newClientToken()); ok(false, "second push refused"); }
  catch (e) { ok(e instanceof AlreadyDone, `second push refused (${e.message})`); }
  const row = await getRecord(call, T.andon, r1.recordId);
  for (const k of ["Brief", "Brief Status", "YEAR", "MONTH", "Contract Value (USD)"]) {
    log(`   ANDON filled ${k}: ${plain(row.fields[k]) || "(empty)"}`);
  }

  log("\n2. Compare every stored field, before vs after");
  const after = { andon: await snap("andon"), brief: await snap("brief") };
  const d = diff({ andon: before.andon.map, brief: before.brief.map }, { andon: after.andon.map, brief: after.brief.map });
  ok(d.andon.added.length === 1 && d.andon.added[0] === r1.recordId && !d.andon.changed.length && !d.andon.removed.length,
     `ANDON: exactly one new row (+${d.andon.added.length} ~${d.andon.changed.length} −${d.andon.removed.length})`);
  ok(!d.brief.added.length && !d.brief.changed.length && !d.brief.removed.length, "Project Brief: unchanged");
  const stored = after.andon.map.get(r1.recordId) || {};
  ok(storedKeys(stored) === Object.keys(payload).sort().join("|"), `the new row stores only the ${Object.keys(payload).length} pushed columns`);
  log(`\nRecord written (ANDON test copy): ${r1.recordId} (${card.code})`);
  log(failures ? `\n${failures} check(s) FAILED.` : "\nAll ANDON checks passed ✓");
  return failures;
}
