/* Offline checks of the transfer rules (js/sync.js). Run: npm test
   The fixtures copy shapes and quirks seen in the real tables. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../js/config.js";
import {
  plain, normCode, allCodes, dayStart, vatExAmount, defaultVat, parAfterAdding, matchOption,
  indexUniverse, indexCollections, briefCards, parCards, invoiceCards,
  universeFromBrief, collectionsFromInvoice, verifyWritten, similarity, vatMentions,
  peoplePool, universeView, shortName, andonFromBrief,
} from "../js/sync.js";
import { writableOnly } from "../js/ops.js";

const seg = (text) => [{ type: "text", text }];
const url = (text, link = `https://applink.larksuite.com/x?instanceId=${text}`) => ({ link, text, type: "url" });
const user = (id, name) => ({ id, name, en_name: name, email: `${id}@x.com`, avatar_url: "" });
const rec = (id, fields) => ({ record_id: id, fields });

test("plain() flattens Lark read formats", () => {
  assert.equal(plain(seg("Hello")), "Hello");
  assert.equal(plain([{ type: "text", text: "DECK - " }, { type: "url", text: "https://a", link: "https://a" }]), "DECK - https://a");
  assert.equal(plain({ type: 1, value: [{ type: "text", text: "Lost" }] }), "Lost");
  assert.equal(plain([user("ou_1", "A"), user("ou_2", "B")]), "A, B");
  assert.equal(plain(url("202610080005")), "202610080005");
  assert.equal(plain(null), "");
});

test("project codes are pulled out of messy text", () => {
  assert.equal(normCode("2026TEG-P0286"), "2026TEG-P0286");
  assert.equal(normCode("2025TEG-P0313 "), "2025TEG-P0313");
  assert.equal(normCode("CE_2026TEG-P0091"), "2026TEG-P0091");
  assert.equal(normCode("CE-2026TEG-P0223"), "2026TEG-P0223");
  assert.equal(normCode("Project Code\n2024TEG-P0131"), "2024TEG-P0131");
  assert.equal(normCode("Project2024TEG-P0434"), "2024TEG-P0434");
  assert.equal(normCode("2026teg-p0001"), "2026TEG-P0001");
  assert.equal(normCode("P0432"), "");
  assert.equal(normCode("2026"), "");
  assert.deepEqual(allCodes("2025TEG-P0082, 2025TEG-P0128, 2025TEG-P0139"),
                   ["2025TEG-P0082", "2025TEG-P0128", "2025TEG-P0139"]);
});

test("dates become midnight Manila time", () => {
  // 2026-10-07 10:52 +08:00 → 2026-10-07 00:00 +08:00
  assert.equal(dayStart(1791341556036, 8), 1791302400000);
  // 2026-10-07 23:30 +08:00 stays on the 7th; 00:30 on the 8th moves to the 8th
  assert.equal(dayStart(1791302400000 + 23.5 * 3600000, 8), 1791302400000);
  assert.equal(dayStart(1791302400000 + 24.5 * 3600000, 8), 1791302400000 + 86400000);
});

test("Amount (VAT-Ex.) (PHP) follows the stated rule", () => {
  assert.equal(vatExAmount(1120000, "PHP", "12%", RULES), 1000000);           // ÷ 1.12
  assert.equal(vatExAmount(1500000, "PHP", "0%", RULES), 1500000);            // as filed
  assert.equal(vatExAmount(2200, "USD", "0%", RULES), 125400);                // × 57
  assert.equal(vatExAmount(45000, "USD", "12%", RULES), 2290178.57);          // × 57 ÷ 1.12, 2 dp
  assert.equal(vatExAmount(39564866.25, "PHP", "0%", RULES), 39564866.25);
  assert.equal(vatExAmount(1000, "PHP", "12%", RULES), 892.86);
  assert.equal(vatExAmount(null, "PHP", "12%", RULES), null);
  assert.equal(vatExAmount(100, "EUR", "0%", RULES), null);
  assert.equal(defaultVat("USD"), "0%");
  assert.equal(defaultVat("PHP"), "12%");
});

test("PAR numbers are appended, never duplicated", () => {
  assert.equal(parAfterAdding("", "202610080029"), "202610080029");
  assert.equal(parAfterAdding(seg("202607030034"), "202610080029"), "202607030034, 202610080029");
  assert.equal(parAfterAdding("202607030034, 202610080029", "202610080029"), null);
});

test("select options match loosely but write the option's own name", () => {
  const opts = ["PDEI-Event Service", "PDEI-Game Marketing", "PDEI-IP", "GG-Event Service"];
  assert.equal(matchOption("PDEI - Event Service", opts), "PDEI-Event Service");
  assert.equal(matchOption("GG - Event Service", opts), "GG-Event Service");
  assert.equal(matchOption("PDEI - Talent Service", opts), null);
  assert.equal(matchOption("", opts), null);
});

/* ---------- a small world: Universe, Collections, sources ---------- */

const universe = [
  rec("recU1", { "Project Code": seg("2026TEG-P0240"), "Project": seg("FUNaloMAX Social Media"), "PAR": seg("202606010001") }),
  rec("recU2", { "Project Code": seg("2025TEG-P0313 "), "Project": seg("OKGames Barangay Caravan") }),
  rec("recU3", { "Project Code": seg("2026TEG-P0092"), "Project": seg("Color Game (CasinoPlus PH Rebranding)") }),
  rec("recU4", { "Project Code": seg("2026TEG-P0092"), "Project": seg("MPGL 2026") }),
  rec("recU5", { "Project Code": seg("2026TEG-P0098"), "Project": seg("RaizeSquad GG Truck Rental") }),
  rec("recU6", { "Project Code": seg("2026TEG-P0036"), "Project": seg("GG Truck KIS4 HoK") }),
];
const collections = [
  rec("recC1", { "Project Code": seg("2026TEG-P0240"), "Invoice Request": 202609010001, "AR Name": seg("FUNaloMAX DP"),
                 "Invoice Amount": 100, "Currency": "PHP" }),
  rec("recC2", { "Project Code": seg("2026TEG-P0036"), "AR Name": seg("GG Truck KIS4 HoK Full Payment"),
                 "Invoice Amount": 62500, "Currency": "PHP" }),          // legacy row: no request number, VAT-ex amount
  rec("recC3", { "Project Code": seg("2026TEG-P0098"), "AR Name": seg("RaizeSquad Full Payment"),
                 "Invoice Amount": 18303.57, "Currency": "PHP" }),       // legacy row, different amount
];
const brief = (id, code, extra = {}) => rec(id, {
  "Request No.": url(`2026100800${id.slice(-2)}`), "Project Code": seg(code), "Project Name": seg(`Project ${code}`),
  "Initiator department": seg("Account Managers"), "Status": "Approved", "Submitted at": 1791341556036,
  "Contract Value": 1120000, "Contract Value-Currency": "PHP", ...extra,
});
const briefs = [
  brief("recB01", "2026TEG-P0286", { "Submitted at": 1791400000000 }),
  brief("recB02", "2026TEG-P0240"),                                              // already in Universe
  brief("recB03", "2025TEG-P0313"),                                              // in Universe with trailing space
  brief("recB04", "2026TEG-P0300", { "IGNORE": true }),
  brief("recB05", "2026TEG-P0301", { "Initiator department": seg("Sales") }),
  brief("recB06", "2026TEG-P0302", { "Status": "Rejected" }),
  brief("recB07", "2026TEG-P0093", { "Project Name": seg("Color Game (CasinoPlus PH Rebranding & After Party)"),
                                     "Submitted at": 1700000000000 }),
  brief("recB08", "2026TEG-P0098", { "Request No.": url("202604150001") }),
];

test("brief cards: scope, filters and newest first", () => {
  const uni = indexUniverse(universe);
  const { cards, hidden } = briefCards(briefs, uni, RULES);
  assert.deepEqual(cards.map(c => c.code), ["2026TEG-P0286", "2026TEG-P0093"]);
  assert.deepEqual(hidden, { otherDept: 1, ignored: 1, done: 3, void: 1, noProject: 0 });
  assert.equal(cards[1].similar.code, "2026TEG-P0092");      // likely re-filing flagged
  assert.equal(cards[0].similar, null);
});

test("PAR cards: linked brief beats a typo'd code; pending briefs block; shared codes flagged", () => {
  const uni = indexUniverse(universe);
  const pending = new Set(["2026TEG-P0286"]);
  const par = (id, req, fields) => rec(id, { "Request No.": url(req), "Status": "Approved", "Submitted at": 1, ...fields });
  const pars = [
    par("recP1", "202606010001", { "Project Code": seg("2026TEG-P0240") }),                             // already recorded
    par("recP2", "202610080029", { "Project Code": seg("2025TEG-P0098"),                               // typo: year
                                   "Associated Project Brief": seg("202604150001-Someone-Project Brief-2026-04-15") }),
    par("recP3", "202610080030", { "Project Code": seg("2026TEG-P0286") }),                             // brief pending
    par("recP4", "202610080031", { "Project Code": seg("2023TEG-P0001") }),                             // project not in Universe
    par("recP5", "202610080032", { "Project Code": seg("2026TEG-P0092"), "Project Name": seg("MPGL 2026") }),
    par("recP6", "202610080033", { "Project Code": seg("2026TEG-P0240"), "IGNORE": true }),
  ];
  const { cards, hidden } = parCards(pars, briefs, uni, pending, RULES);
  const by = Object.fromEntries(cards.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(by).sort(), ["recP2", "recP3", "recP5"]);
  assert.equal(by.recP2.code, "2026TEG-P0098");
  assert.equal(by.recP2.target.id, "recU5");
  assert.match(by.recP2.notes[0], /differs/);
  assert.equal(by.recP3.blocked, "Push this project's brief first.");
  assert.equal(by.recP5.targets.length, 2);
  assert.equal(by.recP5.target.id, "recU4");                  // best name match among rows sharing the code
  assert.deepEqual(hidden, { otherDept: 0, ignored: 1, done: 1, void: 0, noProject: 1 });
});

test("invoice cards: one project, many invoices; legacy look-alikes flagged", () => {
  const uni = indexUniverse(universe);
  const coll = indexCollections(collections);
  const ir = (id, req, fields) => rec(id, { "Request No.": url(req), "Status": "Approved", "Submitted at": 1,
    "Initiator department": seg("Account Managers"), "Project Name": seg(`Invoice ${req}`),
    "Amount": 100, "Amount-Currency": "PHP", ...fields });
  const irs = [
    ir("recI1", "202609010001", { "Project Code": seg("2026TEG-P0240") }),                 // already in Collections
    ir("recI2", "202610010001", { "Project Code": seg("2026TEG-P0240"), "Amount": 200 }),  // 2nd invoice, same project
    ir("recI3", "202602090061", { "Project Code": seg("2026TEG-P0036"), "Amount": 70000 }),// legacy look-alike
    ir("recI4", "202610010002", { "Project Code": seg("CE-2026TEG-P0098"), "Status": "Under Review" }),
    ir("recI5", "202610010003", { "Project Code": seg("2026TEG-P0240"), "Status": "Recalled" }),
    ir("recI6", "202610010004", { "Project Code": seg("2023TEG-P0001") }),                 // project not in Universe
    ir("recI7", "202610010005", { "Project Code": seg("2026TEG-P0240"), "Initiator department": seg("Sales") }),
  ];
  const { cards, hidden } = invoiceCards(irs, uni, coll, new Set(), RULES);
  const by = Object.fromEntries(cards.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(by).sort(), ["recI2", "recI3", "recI4"]);
  assert.equal(by.recI2.existingCount, 1);
  assert.match(by.recI3.notes[0], /already has “GG Truck KIS4 HoK Full Payment” \(PHP 62,500\).*likely this invoice/);
  assert.equal(by.recI4.code, "2026TEG-P0098");
  assert.match(by.recI4.notes[0], /1 older row .*“RaizeSquad Full Payment” PHP 18,303.57.*Check/);
  assert.deepEqual(by.recI2.notes, []);
  assert.deepEqual(hidden, { otherDept: 1, ignored: 0, done: 1, void: 1, noProject: 1 });

  const opts = { "Currency": ["PHP", "USD"], "Business Unit": ["PDEI-Event Service", "GG-Event Service"] };
  const approved = collectionsFromInvoice({ ...by.recI2, businessUnit: "PDEI - Event Service" }, { arName: "" }, opts, RULES);
  assert.deepEqual(approved, {
    "AR Name": "Invoice 202610010001", "Project Code": "2026TEG-P0240",
    "Invoice Amount": 200, "Invoice Request": 202610010001, "Status": "For Invoicing",
    "Currency": "PHP", "Business Unit": "PDEI-Event Service",
  });
  const pendingRow = collectionsFromInvoice(by.recI4, { arName: "Custom AR" }, opts, RULES);
  assert.equal(pendingRow["Status"], "Pending Invoice Request Approval");
  assert.equal(pendingRow["AR Name"], "Custom AR");
  assert.equal("Business Unit" in pendingRow, false);          // unknown BU is left out, never invented
});

test("universeFromBrief maps every transferable field", () => {
  const uni = indexUniverse(universe);
  const b = rec("recB99", {
    "Request No.": url("202610080069", "https://applink.larksuite.com/approval?instanceId=1"),
    "Project Code": seg("2026TEG-P0286 "), "Project Name": seg("  Korea Tourism Expo  "),
    "Initiator department": seg("Account Managers"), "Status": "Under Review",
    "Submitted at": 1791341556036, "Contract Value": 45000, "Contract Value-Currency": "USD",
    "Remarks": seg("Line 1\r\nLine 2"), "Start date": 1794326400000, "End date": 1794412800000,
    "AM": [user("ou_am", "Am")], "BD": [user("ou_bd", "Bd")],
    "Attachment (Project Brief, Pitch Deck)": { link: "https://www.larksuite.com/approval/admin/previewAttachment?key=K", text: "1 attachment(s)" },
  });
  const [card] = briefCards([b], uni, RULES).cards;
  const out = universeFromBrief(card, {
    vat: "0%", client: " Korea Tourism Organization ",
    bd: [{ id: "ou_picked", name: "Picked BD" }], otherLinks: " Deck: https://x\r\n",
  }, RULES);
  assert.deepEqual(out, {
    "Project Code": "2026TEG-P0286",
    "Project": "Korea Tourism Expo",
    "Client": "Korea Tourism Organization",
    "AM": [{ id: "ou_am" }],
    "BD": [{ id: "ou_picked" }],                  // what the user picked, not the brief's BD
    "Amount (VAT-Ex.) (PHP)": 2565000,
    "VAT%": "0%",
    "Project Description": "Line 1\nLine 2",
    "Project Start": 1794326400000,
    "Project End": 1794412800000,
    "RFP Received Date": 1791302400000,
    "Year": "2026",
    "Status": "For CE/Pitch Creation",
    "Mancom Phase": "1. Client Brief Kickoff",
    "Other Links": "Deck: https://x",
  });
  // No MKT on the brief → no MKT key at all (nothing written as blank).
  assert.equal("MKT" in out, false);
  // By default Client, BD and Other Links stay blank: not written at all.
  const defaults = universeFromBrief(card, { vat: "12%" }, RULES);
  for (const k of ["Client", "BD", "Other Links"]) assert.equal(k in defaults, false, k);
  assert.equal(defaults["Amount (VAT-Ex.) (PHP)"], 2290178.57);
});

test("short names keep first and last name", () => {
  assert.equal(shortName("Carlos Roberto Francisco, David, IV Coscolluela"), "Carlos Coscolluela");
  assert.equal(shortName("Marinella M. Casabuena"), "Marinella Casabuena");
  assert.equal(shortName("Pepito Laureola Garcia Jr."), "Pepito Garcia");
  assert.equal(shortName("Kirk Agcaoili"), "Kirk Agcaoili");
  assert.equal(shortName("Vince"), "Vince");
});

test("the BD picker offers frequent Universe BDs first", () => {
  const u = [
    rec("u1", { "BD": [user("ou_kirk", "Kirk")], "AM": [user("ou_pat", "Pat")] }),
    rec("u2", { "BD": [user("ou_kirk", "Kirk"), user("ou_ella", "Ella")] }),
  ];
  const b = [rec("b1", { "MKT": [user("ou_mkt", "Mika")], "BD": [user("ou_ella", "Ella")] })];
  const pool = peoplePool(u, b);
  assert.deepEqual(pool.map(p => [p.name, p.bdCount]), [["Kirk", 2], ["Ella", 1], ["Mika", 0], ["Pat", 0]]);
  assert.equal(pool[0].email, "ou_kirk@x.com");
});

test("Universe view: one year, hidden statuses out, grouped in option order, newest RFP first", () => {
  const row = (id, f) => rec(id, { "Project": seg(`P ${id}`), "Client": seg(`C ${id}`), "Year": seg("2026"), ...f });
  const recs = [
    row("a", { "Status": "For CE/Pitch Creation", "RFP Received Date": 300, "Amount (VAT-Ex.) (PHP)": 100 }),
    row("b", { "Status": "For CE/Pitch Creation", "RFP Received Date": 500, "Amount (VAT-Ex.) (PHP)": 50.5 }),
    row("c", { "Status": "For CE/Pitch Creation" }),                                   // no RFP date: last
    row("d", { "Status": "Fully Closed", "RFP Received Date": 100 }),
    row("e", { "Status": "Lost", "RFP Received Date": 900 }),                          // hidden
    row("f", { "Status": "Archived" }),                                                // hidden
    row("g", { "Status": "For CE/Pitch Creation", "Year": seg("2025"), "RFP Received Date": 999 }),
    row("h", { "RFP Received Date": 50 }),                                             // no status
    row("i", { "Status": "Brand New Status", "RFP Received Date": 70 }),
  ];
  const order = ["Fully Closed", "For CE/Pitch Creation", "Stalled", "Lost", "Archived"];
  const v = universeView(recs, { year: "2026", hidden: ["Lost", "Stalled", "Archived"], statusOrder: order });
  assert.deepEqual(v.groups.map(g => g.status), ["Fully Closed", "For CE/Pitch Creation", "Brand New Status", ""]);
  assert.deepEqual(v.groups[1].rows.map(r => r.id), ["b", "a", "c"]);
  assert.equal(v.groups[1].amount, 150.5);
  assert.deepEqual(v.hiddenCounts, { Lost: 1, Archived: 1 });
  assert.equal(v.count, 6);
  assert.deepEqual(v.years, ["2026", "2025"]);
  const asc = universeView(recs, { year: "2026", hidden: [], statusOrder: order, sort: "asc" });
  assert.deepEqual(asc.groups.find(g => g.status === "For CE/Pitch Creation").rows.map(r => r.id), ["a", "b", "c"]);
  const all = universeView(recs, { year: "all", hidden: [], statusOrder: order });
  assert.equal(all.count, 9);
  const found = universeView(recs, { year: "all", statusOrder: order, query: "c g" });
  assert.deepEqual(found.groups.flatMap(g => g.rows.map(r => r.id)), ["g"]);
});

test("verifyWritten compares write format against read format", () => {
  const written = {
    "Project": "Korea", "AM": [{ id: "ou_1" }, { id: "ou_2" }], "Amount (VAT-Ex.) (PHP)": 892.86,
    "VAT%": "12%", "Project Start": 1794326400000, "IGNORE": true, "Other Links": "A: https://x\nB",
  };
  const readBack = {
    "Project": seg("Korea"), "AM": [user("ou_2", "B"), user("ou_1", "A")], "Amount (VAT-Ex.) (PHP)": 892.86,
    "VAT%": "12%", "Project Start": 1794326400000, "IGNORE": true,
    "Other Links": [{ type: "text", text: "A: " }, { type: "url", text: "https://x", link: "https://x" }, { type: "text", text: "\nB" }],
  };
  assert.deepEqual(verifyWritten(written, readBack), []);
  const bad = verifyWritten(written, { ...readBack, "VAT%": "0%", "AM": [user("ou_1", "A")] });
  assert.deepEqual(bad.map(b => b.field), ["AM", "VAT%"]);
  assert.deepEqual(verifyWritten({ IGNORE: false }, {}), []);
});

test("VAT sentences are quoted from the remarks", () => {
  assert.deepEqual(vatMentions(seg("Budget is inclusive of VAT. \n\nSOW\n- Pavilion")), ["Budget is inclusive of VAT."]);
  assert.deepEqual(vatMentions("Estimated budget : Php 200-250k VAT-ex"), ["Estimated budget : Php 200-250k VAT-ex"]);
  assert.deepEqual(vatMentions("Budget: $150,000 (all in with tax and ASF)"), ["Budget: $150,000 (all in with tax and ASF)"]);
  assert.deepEqual(vatMentions("Activation at the venue. No pricing yet."), []);
});

test("similarity spots re-filed projects", () => {
  assert.ok(similarity("MPL PH S18 - Media Day", "MPL PH S18 - Media Day") === 1);
  assert.ok(similarity("FunaloMax, FunaloMax Studios, Solaire Online Social Media Ad",
                       "FUNaloMAX, FUNaloMAX Studios, Solaire Online - (Social Media, Paid Media)") >= RULES.similarityHint);
  assert.ok(similarity("Korea Tourism Organization - Travel Tour Expo 2027", "COD:M KOL Tour") < RULES.similarityHint);
});

test("ANDON: briefs from every department, the shared IGNORE box, typed columns only", () => {
  const andon = indexUniverse([rec("a1", { "Project Code": seg("2026TEG-P0240"), "Project": seg("FUNaloMAX Social Media") })]);
  const briefs = [
    brief("recB01", "2026TEG-P0286", { "Initiator department": seg("Project Management") }),
    brief("recB02", "2026TEG-P0240"),                                         // already in ANDON
    brief("recB03", "2026TEG-P0301", { "IGNORE": true }),                     // ignored: hidden here too
  ];
  const { cards, hidden } = briefCards(briefs, andon, RULES, { allDepartments: true, kind: "andon" });
  assert.deepEqual(cards.map(c => c.code), ["2026TEG-P0286"]);
  assert.equal(cards[0].kind, "andon");
  assert.deepEqual(hidden, { otherDept: 0, ignored: 1, done: 1, void: 0, noProject: 0 });

  const b = rec("recB99", {
    "Request No.": url("202610080069", "https://applink.larksuite.com/approval?instanceId=1"),
    "Project Code": seg("2026TEG-P0286"), "Project Name": seg("Korea Tourism Expo"), "Status": "Under Review",
    "Initiator department": seg("Account Managers"), "Submitted at": 1791341556036,
    "Contract Value": 5700, "Contract Value-Currency": "PHP", "Business Unit": "PDEI - Marketing",
    "Required Tools": ["None", "Mystery Tool"], "Remarks": seg("Notes"),
    "Start date": 1794326400000, "End date": 1794412800000,       // Nov 11 / Nov 12 2026, Manila
    "AM": [user("ou_am1", "Am One"), user("ou_am2", "Am Two")], "MKT": [user("ou_mkt", "Mika")],
  });
  const [card] = briefCards([b], indexUniverse([]), RULES, { allDepartments: true, kind: "andon" }).cards;
  const options = { "Business Unit": ["PDEI - Marketing"], "Tools": ["None", "Slash"], "TRIBE": ["TRIBE D - Marketing"],
                    "Brief Currency": ["PHP", "USD"], "Brief Status": ["Approved", "Under Review"] };
  const out = andonFromBrief(card, { pm: [{ id: "ou_pm", name: "Pam" }], tribe: "TRIBE D - Marketing" }, RULES, options);
  assert.deepEqual(out, {
    "Project": "Korea Tourism Expo", "Project Code": "2026TEG-P0286",
    "AM": [{ id: "ou_am1" }],                      // ANDON holds one AM
    "PM (LEAD)": [{ id: "ou_pm" }], "MKT (PITCH)": [{ id: "ou_mkt" }],
    "Business Unit": "PDEI - Marketing", "Tools": ["None"],     // unknown options are left out
    "TRIBE": "TRIBE D - Marketing",
    "Brief Contract Value": 5700, "Brief Currency": ["PHP"], "Contract Value (USD)": 100,
    "Brief": { link: "https://applink.larksuite.com/approval?instanceId=1", text: "202610080069" },
    "Brief Status": ["Under Review"], "YEAR": "2026", "MONTH": "November",
    "Event Start": 1794326400000, "Event End": 1794412800000, "Remarks": "Notes",
  });
  const blank = andonFromBrief(card, {}, RULES, options);
  assert.equal("PM (LEAD)" in blank, false);
  assert.equal("TRIBE" in blank, false);

  // The live ANDON fills Brief, YEAR, MONTH… itself: those are never sent there.
  const live = [
    { field_name: "Project", type: 1 }, { field_name: "Project Code", type: 1 }, { field_name: "AM", type: 11 },
    { field_name: "Brief", type: 19 }, { field_name: "YEAR", type: 20 }, { field_name: "MONTH", type: 20 },
    { field_name: "Event Start", type: 5 }, { field_name: "Main Project", type: 18 },
  ];
  assert.deepEqual(Object.keys(writableOnly(out, live)).sort(), ["AM", "Event Start", "Project", "Project Code"]);
});
