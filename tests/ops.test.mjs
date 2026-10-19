/* Offline checks of the writes in js/ops.js, against a small fake Lark that keeps
   its rows in memory (no network). Run: npm test */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../js/config.js";
import { saveInvoiceDetails, fillGaps, createRecord, AlreadyDone, columnsToRead, schemaSpec } from "../js/ops.js";
import { collectionRow } from "../js/sync.js";
import { LarkError, isUncertain } from "../js/errors.js";

const seg = (text) => [{ type: "text", text }];
const T = { collections: { app: "APP1", table: "tblCol" }, universe: { app: "APP1", table: "tblUni" } };

/* Just enough of Lark: batch_get and batch_update on one table's rows. */
function fakeLark(rows) {
  const calls = [];
  const call = async (method, url, body) => {
    calls.push({ method, url, body });
    if (/\/records\/batch_get/.test(url)) {
      return { code: 0, data: { records: rows.filter(r => body.record_ids.includes(r.record_id)).map(r => structuredClone(r)) } };
    }
    if (/\/records\/batch_update/.test(url)) {
      for (const u of body.records) Object.assign(rows.find(r => r.record_id === u.record_id).fields, u.fields);
      return { code: 0, data: { records: [] } };
    }
    throw new Error(`fake Lark has no answer for ${method} ${url}`);
  };
  return { call, calls, writes: () => calls.filter(c => /batch_update/.test(c.url)) };
}

const collectionsRow = (fields) => ({ record_id: "recC1", fields: {
  "AR Name": seg("Tranche 1"), "Invoice Number": seg("INV-1680"), "SI Number": seg("610"), ...fields } });

test("invoice details: written when the cells are still what the list showed", async () => {
  const rec = collectionsRow({});
  const lark = fakeLark([rec]);
  const res = await saveInvoiceDetails(lark.call, T, collectionRow(rec), { "Invoice Number": "INV-1700" });
  assert.deepEqual(lark.writes().map(w => w.body.records[0].fields), [{ "Invoice Number": "INV-1700" }]);
  assert.deepEqual(res.written, { "Invoice Number": "INV-1700" });
  assert.deepEqual(res.mismatches, []);
});

test("invoice details: nothing is written if someone changed a cell meanwhile", async () => {
  const rec = collectionsRow({});
  const loaded = collectionRow(rec);                         // what the list showed
  rec.fields["Invoice Number"] = seg("INV-1999");            // someone typed another in Lark
  const lark = fakeLark([rec]);
  await assert.rejects(saveInvoiceDetails(lark.call, T, loaded, { "Invoice Number": "INV-1700" }),
    (err) => err instanceof AlreadyDone && /changed since the list was loaded/.test(err.message) && /Invoice Number changed in Lark/.test(err.detail));
  assert.equal(lark.writes().length, 0);
  assert.equal(rec.fields["Invoice Number"][0].text, "INV-1999");
});

test("invoice details: a change to another cell doesn't block this one", async () => {
  const rec = collectionsRow({});
  const loaded = collectionRow(rec);
  rec.fields["SI Number"] = seg("611");                      // someone else's edit, not ours to touch
  const lark = fakeLark([rec]);
  await saveInvoiceDetails(lark.call, T, loaded, { "Invoice Number": "INV-1700" });
  assert.equal(lark.writes().length, 1);
  assert.equal(rec.fields["SI Number"][0].text, "611");
});

test("invoice details: a row that's gone says so", async () => {
  const lark = fakeLark([]);
  await assert.rejects(saveInvoiceDetails(lark.call, T, collectionRow(collectionsRow({})), { "SI Number": "1" }), /no longer exists/);
  assert.equal(lark.writes().length, 0);
});

test("invoice details: attachments are compared by token", async () => {
  const file = (t) => ({ file_token: t, name: `${t}.pdf`, size: 10 });
  const rec = collectionsRow({ Invoice: [file("a")] });
  const loaded = collectionRow(rec);
  rec.fields.Invoice = [file("a"), file("b")];               // a file added in Lark
  const lark = fakeLark([rec]);
  await assert.rejects(saveInvoiceDetails(lark.call, T, loaded, { Invoice: [{ file_token: "a" }, { file_token: "c" }] }), AlreadyDone);
  assert.equal(lark.writes().length, 0);
});

const universeRow = (fields) => ({ record_id: "recU1", fields: { "Project Code": seg("2026TEG-P0001"), ...fields } });
const AMOUNT = "Amount (VAT-Ex.) (PHP)";

test("fill blanks: a VAT% someone filled meanwhile is not overwritten", async () => {
  const row = universeRow({ "VAT%": "0%" });                  // filled after the list loaded
  const lark = fakeLark([row]);
  // the amount was worked out at 12%: with a different VAT% in the row it can't go out either
  await assert.rejects(fillGaps(lark.call, T.universe, "recU1", { [AMOUNT]: 892.86, "VAT%": "12%" }),
    (err) => err instanceof AlreadyDone && /aren't blank anymore/.test(err.message));
  assert.equal(lark.writes().length, 0);
  assert.equal(row.fields["VAT%"], "0%");
});

test("fill blanks: a VAT% that's the same is left alone, the amount goes out", async () => {
  const row = universeRow({ "VAT%": "12%" });
  const lark = fakeLark([row]);
  const res = await fillGaps(lark.call, T.universe, "recU1", { [AMOUNT]: 892.86, "VAT%": "12%" });
  assert.deepEqual(res.written, { [AMOUNT]: 892.86 });
  assert.deepEqual(res.skipped, []);
});

test("fill blanks: blank cells are written, filled ones are skipped and reported", async () => {
  const row = universeRow({ "Project Description": seg("typed by hand") });
  const lark = fakeLark([row]);
  const res = await fillGaps(lark.call, T.universe, "recU1", { [AMOUNT]: 500, "VAT%": "12%", "Project Description": "from the brief" });
  assert.deepEqual(res.written, { [AMOUNT]: 500, "VAT%": "12%" });
  assert.deepEqual(res.skipped, ["Project Description"]);
  assert.equal(row.fields["Project Description"][0].text, "typed by hand");
});

test("fill blanks: the signed CE goes in by token, is read back, and never replaces a file someone attached", async () => {
  const CE = RULES.auditFiles.field;
  const row = universeRow({ "Status": "Signed CE" });
  const lark = fakeLark([row]);
  const files = [{ file_token: "boxA" }, { file_token: "boxB" }];
  const res = await fillGaps(lark.call, T.universe, "recU1", { [CE]: files });
  assert.deepEqual(lark.writes().map(w => w.body.records[0].fields), [{ [CE]: files }]);
  assert.deepEqual(res.mismatches, []);                       // compared by token
  // someone attached one meanwhile: nothing is written
  const theirs = universeRow({ [CE]: [{ file_token: "boxZ", name: "theirs.pdf" }] });
  const lark2 = fakeLark([theirs]);
  await assert.rejects(fillGaps(lark2.call, T.universe, "recU1", { [CE]: files }), AlreadyDone);
  assert.equal(lark2.writes().length, 0);
});

test("schema: the signed CE is an Attachment the Universe reads, and only audit pushes need it", () => {
  const u = schemaSpec(RULES).universe, CE = RULES.auditFiles.field;
  assert.ok(u.read.includes(CE));
  assert.equal(u.optional[CE], 17);
  assert.ok(u.neededBy["audit:universe"].includes(CE));
  assert.ok(!(CE in u.fields), "a missing column mustn't stop brief and PAR pushes");
});

test("a create that Lark accepted but sent no row for is an unknown outcome", async () => {
  const call = async () => ({ code: 0, data: {} });
  await assert.rejects(createRecord(call, T.universe, { "Project Code": "X" }, "tok"),
    (err) => err instanceof LarkError && isUncertain(err));
});

test("creates carry their client_token", async () => {
  const seen = [];
  const call = async (method, url) => { seen.push(url); return { code: 0, data: { record: { record_id: "rec9", fields: {} } } }; };
  const rec = await createRecord(call, T.universe, { "Project Code": "X" }, "abc-123");
  assert.equal(rec.record_id, "rec9");
  assert.match(seen[0], /\/records\?client_token=abc-123$/);
  assert.ok(RULES.newProjectStatus);
});

test("columnsToRead: a destination table also reads its lookups and formulas; source tables don't", () => {
  const f = (field_name, type) => ({ field_name, type });
  const spec = schemaSpec(RULES);
  const universe = [...spec.universe.read.filter(n => n !== RULES.universeIgnoreField).map(n => f(n, 1)),
    f("Contract Value (USD)", 20), f("Brief Submitted", 19), f("Linked ANDON", 21), f("Created", 1001)];
  const cols = columnsToRead("universe", universe, RULES);
  for (const n of ["Project Code", "Contract Value (USD)", "Brief Submitted", "Linked ANDON"]) assert.ok(cols.includes(n), n);
  assert.ok(!cols.includes("Created"));                               // Lark's own metadata isn't row data
  assert.ok(!cols.includes(RULES.universeIgnoreField));               // not in this table: never asked for
  // a source table reads only what its cards need
  const brief = [...Object.keys(spec.brief.fields).map(n => f(n, 1)), f("Some Formula", 20)];
  assert.ok(!columnsToRead("brief", brief, RULES).includes("Some Formula"));
  // ANDON reads every column; so does any table past Lark's 50-name limit
  assert.equal(columnsToRead("andon", [f("Project", 1)], RULES), undefined);
  const wide = [...universe, ...Array.from({ length: 40 }, (_, i) => f(`Formula ${i}`, 20))];
  assert.equal(columnsToRead("universe", wide, RULES), undefined);
});
