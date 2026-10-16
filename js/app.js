/* Polaris: the page shell. State, routes, the header, loading, settings, and what
   happens after a push. The cards live in inbox.js, the table in universe.js; the
   transfer rules in sync.js and every Lark read/write in ops.js. */

import { APP, ENV_LABEL, TABLE_LINKS, RULES, SERVICES } from "./config.js";
import { parseBaseLink, loadEverything, loadUniverse, selectOptions, TABLE_TITLES, computedTypes } from "./ops.js";
import {
  indexUniverse, indexCollections, briefCards, parCards, collectionCards, stepStatus, peoplePool, pmPool, auditCards, briefsByCode,
  draftsToJSON, draftsFromJSON,
} from "./sync.js";
import { $, $$, h, ic, fillIcons, toast, fmt, store, recall, sleep, initTheme } from "./ui.js";
import { lark, wake, conn, onConn, describe, isDeadToken, LarkError, proxyHost, unreachable } from "./net.js";
import { overrides, setLarkUrl, savedLarkUrl, isLocalPage, isServiceUrl } from "./settings.js";
import * as auth from "./auth.js";
import { createInbox } from "./inbox.js";
import { createUniverse } from "./universe.js";
import { createCollections } from "./collections.js";
import { createQueue } from "./queue.js";

const tables = Object.fromEntries(Object.entries(TABLE_LINKS).map(([k, link]) => [k, parseBaseLink(link)]));
const KEY = { theme: "polaris.theme", tab: "polaris.tab", draft: "polaris.draft" };
// What "Clear local data" forgets: views, hidden cards and unsent drafts, never the login or the theme.
const LOCAL_KEYS = ["polaris.auditHidden", "polaris.uniSort", "polaris.uniCollapsed", "polaris.colSort", "polaris.colCollapsed", KEY.draft];
const STALE_AFTER_MS = 5 * 60 * 1000;    // reload when the page comes back after this long
const LOW_SESSION_MS = 10 * 60 * 1000;

/* What was typed in a push sheet that was cancelled, with its client_token. Kept in
   this browser (polaris.draft), so a reload and a retry can't add a second row. */
class DraftMap extends Map {
  set(key, value) {
    super.set(key, value);
    if (value && !value.at) value.at = Date.now();
    this.save();
    return this;
  }
  delete(key) { const had = super.delete(key); if (had) this.save(); return had; }
  save() { store("local", KEY.draft, draftsToJSON(this)); }
}
function loadDrafts() {
  const map = new DraftMap();
  for (const [k, v] of draftsFromJSON(recall("local", KEY.draft))) Map.prototype.set.call(map, k, v);
  return map;
}

/* ======================= state ======================= */
const S = {
  view: "login",            // login | busy | work | settings
  tab: ["brief", "par", "invoice", "andon", "audit"].includes(recall("local", KEY.tab)) ? recall("local", KEY.tab) : "brief",
  show: "inbox",            // on narrow screens: inbox | universe
  data: null,               // { universe, collections, brief, par, invoice }: records as read
  fields: null,
  problems: [],
  tableProblems: {},
  kindProblems: {},
  lists: null,              // { brief, par, invoice }: { cards, hidden }
  pool: [], pmPool: [], clients: [], statusOrder: [],
  loading: false, quiet: false, waking: false, stages: {}, loadError: null, loadedAt: 0,
  user: null,
  loginNote: "", returnTo: "",
  working: new Set(),       // cards with a write in flight
  entering: new Set(),      // cards that just came back (Undo): animate once
  flashCard: null,          // a card to highlight where it lands
  drafts: loadDrafts(),     // what was typed in a push sheet, kept if it's cancelled (and across a reload)
  query: { brief: "", par: "", invoice: "", andon: "", audit: "" },
  auditHide: new Set(recall("local", "polaris.auditHidden") || []),   // audit cards hidden on this device
};

/* Every Lark call runs as the signed-in user. Reads retry while the proxy wakes;
   writes never do. While a write or upload is running (track), its calls may use
   the token through Lark's last 30 s of grace, so the clock can't cut it off. */
let inflight = 0;
async function track(work) {
  inflight++;
  try { return await work(); } finally { if (--inflight === 0) tickSession(); }
}
function call(method, url, body) {
  const t = inflight ? auth.workToken() : auth.currentToken();
  if (!t) {
    auth.end();
    return Promise.reject(new LarkError("login ended", { deadToken: true, json: { code: 99991677 } }));
  }
  const read = method === "GET" || /\/records\/(search|batch_get)/.test(url);
  return lark(method, url, { token: t.access_token, body, read, write: !read });
}

const field = (table, name) => ((S.fields && S.fields[table]) || []).find(f => f.field_name === name);
// The tables each kind of card reads or writes; a column problem in one of them
// stops only that kind of push.
const TABLES_FOR = {
  brief: ["brief", "universe"], par: ["par", "brief", "universe"],
  invoice: ["invoice", "collections", "universe"], andon: ["brief", "andon"],
  // The audit fills Universe or ANDON cells from the brief: each card checks its own table.
  audit: ["brief", "universe"], "audit:universe": ["brief", "universe"], "audit:andon": ["brief", "andon"],
};
const problemsFor = (kind) => [...(TABLES_FOR[kind] || []).flatMap(t => S.tableProblems[t] || []),
                                ...(S.kindProblems[kind] || [])];
const canWriteFor = (kind) => auth.canWrite() && problemsFor(kind).length === 0;
const canWriteNow = () => auth.canWrite() && S.problems.length === 0;
const fieldsOf = (table) => (S.fields && S.fields[table]) || [];
// Columns ANDON fills itself in the live table (lookups and formulas); listed in the push sheet.
const ANDON_AUTO = ["Brief", "Brief Status", "Brief Contract Value", "Brief Currency", "Contract Value (USD)",
                    "YEAR", "MONTH", "Remarks"];
const isSplit = () => matchMedia("(min-width: 1280px)").matches;

const ctx = {
  S, tables, call, canWriteNow, canWriteFor, problemsFor, fieldsOf, isSplit,
  hasField: (table, name) => fieldsOf(table).some(f => f.field_name === name),
  optionsOf: (table) => Object.fromEntries(fieldsOf(table).filter(f => f.type === 3 || f.type === 4)
    .map(f => [f.field_name, selectOptions(f)])),
  computedOf: (table) => ANDON_AUTO.filter(n => fieldsOf(table).some(f => f.field_name === n && computedTypes.has(f.type))),
  render: () => render(),
  recompute: () => recompute(),
  loadData: (o) => loadData(o),
  sessionEnded: (m) => auth.end(m),
  track: (work) => track(work),
  afterPush: (c, res, payload, extra) => afterPush(c, res, payload, extra),
  afterQueue: (dests) => afterQueue(dests),
  msLeft: () => auth.msLeft(),
  signedIn: () => !!auth.currentToken(),
  login: (returnTo) => login(returnTo),
  ensureTime: (ms) => ensureTime(ms),
  collectionOptions: () => ({
    "Currency": selectOptions(field("collections", "Currency")),
    "Business Unit": selectOptions(field("collections", "Business Unit")),
  }),
};
ctx.token = () => (auth.workToken() || {}).access_token;   // for uploads, which run inside track()
const inbox = createInbox(ctx);
const universe = createUniverse(ctx);
const collections = createCollections(ctx);
const queue = ctx.queue = createQueue(ctx, inbox);   // Push hands its write to the queue

/* ======================= routes ======================= */
const ROUTES = { "": "brief", briefs: "brief", pars: "par", invoices: "invoice", andon: "andon", audit: "audit", universe: "brief", collections: "invoice", settings: "settings", queue: "queue" };
const parseRoute = () => ROUTES[(location.hash.match(/^#\/?([a-z]*)/) || [])[1] || ""] || "brief";

function onRoute() {
  const r = parseRoute();
  if (r === "settings") S.view = "settings";
  else if (!auth.currentToken()) {
    S.view = "login";
    S.returnTo = location.hash || "#/briefs";
  } else {
    if (r === "queue") {
      S.view = "queue";
      render();
      if (!S.data && !S.loading && !S.loadError) loadData();
      window.scrollTo(0, 0);
      return;
    }
    S.view = "work";
    S.lastWork = location.hash;
    S.tab = r;
    store("local", KEY.tab, r);
  }
  $("#workLink").href = S.lastWork || "#/briefs";
  render();
  // Load as soon as there's a login, whatever page this is, so the lists are ready.
  if (auth.currentToken() && !S.data && !S.loading && !S.loadError) loadData();
  if (S.view !== "work") window.scrollTo(0, 0);
}

/* ======================= rendering ======================= */
const TAB_TITLES = { brief: "Briefs", par: "PARs", invoice: "Invoices", andon: "ANDON", audit: "Audit" };
function pageTitle() {
  const name = { login: "Log in", busy: "Logging in", settings: "Settings", queue: "Queue" }[S.view] || TAB_TITLES[S.tab];
  return `${name} · ${APP.name}`;
}

function render() {
  for (const v of $$(".view")) v.classList.toggle("active", v.dataset.view === S.view);
  document.title = pageTitle();
  renderHeader();
  $("#blockNote").hidden = !conn.blocked;
  if (S.view === "login") renderLogin();
  if (S.view === "work") {
    // On wide screens the table sits beside the list: Collections beside Invoices, the Universe otherwise.
    $("#workspace").dataset.side = S.tab === "invoice" ? "collections" : "universe";
    for (const t of $$(".tab")) {
      const on = t.dataset.tab === S.tab;
      if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
      const n = t.querySelector("[data-count]");
      // Pushes waiting in the queue have left their list.
      if (n) n.textContent = S.lists && S.lists[n.dataset.count] ? String(S.lists[n.dataset.count].cards.filter(c => !queue.hides(c)).length) : "";
    }
    // On a phone the tab strip scrolls: keep the open tab in view.
    const strip = $(".tabs"), open = strip.querySelector('[aria-current="page"]');
    if (open && strip.scrollWidth > strip.clientWidth) {
      const left = open.offsetLeft - 8, right = open.offsetLeft + open.offsetWidth + 8;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
    }
    inbox.render();
    universe.render();
    collections.render();
  }
  if (S.view === "settings") renderSettings();
  queue.paint();      // the Queue tab, its peek and the queue page
}

function initials(name) {
  return (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
}

function renderHeader() {
  $("#appVersion").textContent = `v${APP.version}`;
  $("#appVersion").title = `${APP.name} version ${APP.version}`;
  const signedIn = !!auth.currentToken();
  $("#envBadge").hidden = !ENV_LABEL;
  $("#envBadge").textContent = ENV_LABEL;
  const over = overrides();
  $("#overrideBadge").hidden = !over.length;
  $("#overrideBadge").title = over.length ? `Overridden in this browser. ${over.join(". ")}` : "";
  $("#sessionPill").hidden = !signedIn;
  $("#meLink").hidden = !signedIn;
  $("#workLink").hidden = !signedIn;
  for (const a of $$(".nav a")) {
    if (a.dataset.nav === S.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  if (signedIn) {
    const left = auth.msLeft();
    $("#sessionLeft").textContent = fmt.duration(left);
    $("#sessionPill").classList.toggle("is-low", left < LOW_SESSION_MS);
    $("#sessionPill").title = `Your login lasts until ${fmt.time(auth.endsAt())}`;
    $("#sessionPill").setAttribute("aria-label", `Logged in for ${fmt.duration(left)} more, until ${fmt.time(auth.endsAt())}`);
    const u = S.user || {};
    $("#avatar").hidden = !u.avatar;
    if (u.avatar && $("#avatar").getAttribute("src") !== u.avatar) $("#avatar").src = u.avatar;
    $("#initials").hidden = !!u.avatar;
    $("#initials").textContent = initials(u.name);
    $("#meLink").title = u.name ? `${u.name} · Settings` : "Settings";
  }
}

/* ======================= login ======================= */
let redirectChecked = false;
function renderLogin() {
  const note = $("#loginMsg");
  note.hidden = !S.loginNote;
  note.textContent = S.loginNote;
  if (!redirectChecked) {
    redirectChecked = true;
    wake();     // start waking the proxy now, so it's ready after login
    auth.redirectProblem().then((problem) => {
      $("#redirectMsg").hidden = !problem;
      $("#redirectMsg").textContent = problem || "";
    });
  }
}

async function login(returnTo) {
  try {
    await auth.startLogin(returnTo || S.returnTo || "#/briefs");
  } catch (e) {
    S.loginNote = e.message;
    if (S.view === "login") renderLogin(); else toast(e.message, { type: "error" });
  }
}

/* A session ended (the clock, a dead-token code from Lark, Log out): auth.end() has
   cleared the login; drop what's on screen. Drafts stay, so a new login picks up where this left off. */
function sessionEnded(message) {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();   // any open sheet: the push sheet or invoice details
  S.data = null; S.lists = null; S.user = null; S.loadError = null;
  S.loginNote = message || "Your login ended after about 2 hours. Log in again to keep going.";
  S.returnTo = location.hash || "#/briefs";
  if (S.view !== "settings") S.view = "login";
  render();
}
auth.onEnded(sessionEnded);

/* Every write needs a little time left on the login (a longer task, like several
   uploads, asks for more). */
function ensureTime(ms = 60000) {
  if (auth.msLeft() > ms) return true;
  toast("Your login is about to end, so this wasn't sent.", {
    type: "error", detail: "Log in again, then try it.", action: "Log in again", onAction: () => login(location.hash),
  });
  return false;
}

/* ======================= loading ======================= */
async function loadData({ quiet = false } = {}) {
  if (S.loading) return;
  if (!auth.currentToken()) return auth.end();
  S.loading = true;
  S.quiet = quiet && !!S.data;
  S.loadError = null;
  S.stages = {};
  S.waking = false;
  render();
  try {
    const awake = wake();
    if ((await Promise.race([awake, sleep(1200).then(() => "slow")])) === "slow") { S.waking = true; render(); }
    if (!(await awake)) throw unreachable();
    S.waking = false;
    render();
    const res = await loadEverything(call, tables, RULES, (k, n, total) => {
      S.stages[k] = { n, total };
      inbox.renderLoader();
      universe.renderLoader();
      collections.renderLoader();
    });
    S.data = res.data;
    S.fields = res.fields;
    S.columns = res.columns;      // what was read per table (null: every column), for the push sheet's row
    S.problems = res.problems;
    S.tableProblems = res.tableProblems;
    S.kindProblems = res.kindProblems || {};
    S.loadedAt = Date.now();
    recompute();
  } catch (err) {
    if (isDeadToken(err)) return;   // the session already ended (net.js); the login screen is up
    S.loadError = err;
    if (S.quiet) toast("Couldn't refresh.", { type: "error", detail: describe(err), action: "Try again", onAction: () => loadData({ quiet: true }) });
  } finally {
    S.loading = false;
    S.quiet = false;
    render();
    queue.pump();     // pushes waiting for the data (after a reload or a re-login) carry on
  }
}

function recompute() {
  const d = S.data;
  const uni = indexUniverse(d.universe, { ignoreField: RULES.universeIgnoreField });
  const coll = indexCollections(d.collections);
  const brief = briefCards(d.brief, uni, RULES);
  const pending = new Set(brief.cards.map(c => c.code).filter(Boolean));
  S.lists = {
    brief,
    par: parCards(d.par, d.brief, uni, pending, RULES),
    invoice: collectionCards(d.invoice, uni, coll, pending, RULES),
  };
  if (d.andon) {
    S.lists.andon = briefCards(d.brief, indexUniverse(d.andon), RULES,
      { allDepartments: true, kind: "andon" });   // the same IGNORE box as the Universe
    S.pmPool = pmPool(d.andon, d.universe);
  }
  // The audit: Universe and ANDON cells left blank that the brief can fill.
  const byCode = briefsByCode(d.brief, RULES);
  const uniAudit = auditCards("universe", d.universe, d.brief, RULES, { hide: S.auditHide, byCode, fields: fieldsOf("universe") });
  const andonAudit = d.andon ? auditCards("andon", d.andon, d.brief, RULES,
    { hide: S.auditHide, byCode, options: ctx.optionsOf("andon"), fields: fieldsOf("andon") }) : { cards: [], hidden: { noBrief: 0, hidden: 0 } };
  S.lists.audit = {
    cards: [...uniAudit.cards, ...andonAudit.cards].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0)),
    hidden: { hiddenHere: uniAudit.hidden.hidden + andonAudit.hidden.hidden },
  };
  S.pool = peoplePool(d.universe, d.brief);
  S.clients = [...new Set(uni.rows.map(r => r.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  S.statusOrder = selectOptions(field("universe", "Status"));
  S.colStatusOrder = selectOptions(field("collections", "Status"));
}

/* The Universe again, straight from Lark, so the table shows what's really there. */
async function refreshUniverse() {
  try {
    S.data.universe = await loadUniverse(call, tables, RULES);
    recompute();
    return true;
  } catch (err) {
    return false;   // (a dead login already ended the session in net.js)
  }
}

/* ======================= after a push ======================= */
/* Every push runs in the queue (js/queue.js). Update the local copy at once (the
   card leaves, dependent cards move on) and report what Lark confirmed as
   { title, detail, warn, dest } for the queue to list. The tables are re-read once
   the queue is empty (afterQueue), not after every push. */
function afterPush(c, res, payload, extra = {}) {
  const d = S.data;
  if (c.kind === "audit") return afterFill(c, res);
  if (c.kind === "brief") {
    d.universe.push({ record_id: res.recordId, fields: {
      "Project Code": payload["Project Code"], "Project": payload["Project"], "Client": payload["Client"] || "",
      "PAR": "", "Status": payload["Status"], "Year": payload["Year"],
      "RFP Received Date": payload["RFP Received Date"], "Amount (VAT-Ex.) (PHP)": payload["Amount (VAT-Ex.) (PHP)"],
      "BD": extra.bd || [], "AM": (c.record.fields || {})["AM"] || [],
    } });
  } else if (c.kind === "andon") {
    d.andon.push({ record_id: res.recordId, fields: { "Project Code": payload["Project Code"], "Project": payload["Project"],
      "PM (LEAD)": [] } });
  } else if (c.kind === "par") {
    const row = d.universe.find(r => r.record_id === res.recordId);
    if (row) row.fields["PAR"] = res.written.PAR;
  } else if (res.mode === "update") {     // a Collections row moved along
    const row = d.collections.find(r => r.record_id === res.recordId);
    if (row) Object.assign(row.fields, res.written);
  } else {
    d.collections.push({ record_id: res.recordId, fields: { ...payload } });
  }
  recompute();
  render();

  const what = c.kind === "brief" || c.kind === "andon" ? c.code : `${c.code} · ${c.requestNo}`;
  const title = c.kind === "invoice" ? collectionsTitle(c, res, extra) : {
    andon: `Added ${what} to ANDON.`,
    brief: `Pushed ${what} to the Universe.`,
    par: `Added PAR ${c.requestNo} to ${c.code}.`,
  }[c.kind];
  const dest = { invoice: "collections", andon: "andon" }[c.kind] || "universe";
  if (res.readBackError) {
    return { title, dest, warn: true, detail: `Saved, but Polaris couldn't read it back to check it (${describe(res.readBackError)}). Check it in Lark.` };
  }
  if (res.mismatches.length) {
    return { title, dest, warn: true, detail: `Check these in Lark: ${res.mismatches.map(m => `${m.field}: sent “${m.want}”, Lark has “${m.got}”`).join("; ")}` };
  }
  return { title, dest, warn: false, detail: "" };
}

/* After the audit filled a row's blanks (the card goes; a cell someone filled
   meanwhile was left alone, which the report says). */
function afterFill(c, res) {
  const t = c.target, rec = (S.data[t] || []).find(r => r.record_id === res.recordId);
  if (rec) Object.assign(rec.fields, res.written);
  recompute();
  render();
  const n = Object.keys(res.written).length;
  const where = t === "andon" ? "ANDON" : "the Universe";
  const title = `Filled ${n} missing field${n === 1 ? "" : "s"} on ${c.code} in ${where}.`;
  const skipped = res.skipped.length ? `Someone had already filled ${res.skipped.join(", ")}, so ${res.skipped.length === 1 ? "it was" : "those were"} left as they were.` : "";
  if (res.readBackError || res.mismatches.length) {
    const list = res.mismatches.length ? res.mismatches.map(m => `${m.field}: sent “${m.want}”, Lark has “${m.got}”`).join("; ") : describe(res.readBackError);
    return { title, dest: t, warn: true, detail: `Check these in Lark: ${list}. ${skipped}`.trim() };
  }
  return { title, dest: t, warn: false, detail: skipped };
}

/* After the queue has emptied: re-read the tables it wrote to, once, so the views
   show what Lark really has (formulas, lookups, other people's edits). */
async function afterQueue(dests) {
  if (!S.data) return;
  if (dests.has("collections")) await collections.refresh();
  if (dests.has("universe")) await refreshUniverse();
  render();
}

/* What a Collections push did, in a sentence. */
function collectionsTitle(c, res, extra) {
  const to = stepStatus(c.step, RULES);
  const row = extra.rowName ? `“${extra.rowName}”` : "The row";
  if (res.mode === "create") return `Added ${c.requestNo ? `request ${c.requestNo}` : c.code} to Collections as ${res.written["Status"] || to}.`;
  if (extra.action === "link") return `Added request ${c.requestNo} to ${row}.`;
  if (extra.action === "reset") return `${row} is back to ${to}.`;
  return `${row} is now ${to}.`;
}

/* ======================= settings ======================= */
function renderSettings() {
  const acc = $("#account");
  const t = auth.currentToken();
  if (t) {
    const u = S.user || {};
    const pic = u.avatar ? h("img", { class: "avatar", src: u.avatar, alt: "", referrerpolicy: "no-referrer" })
                         : h("span", { class: "avatar avatar-initials", "aria-hidden": "true" }, initials(u.name));
    acc.replaceChildren(pic,
      h("div", { class: "account-text" },
        h("b", null, u.name || "Logged in"),
        h("span", { id: "accSession" }, sessionLine())),
      h("div", { class: "account-actions" },
        h("button", { type: "button", class: "btn btn-sm", onclick: () => login(location.hash) }, "Log in again"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => {
          auth.end("You've logged out of Polaris. You're still logged in to Lark itself.");
          location.hash = "#/";
        } }, ic("logout"), "Log out")));
  } else {
    acc.replaceChildren(
      h("div", { class: "account-text" }, h("b", null, "You're not logged in."),
        h("span", null, "Log in with Lark to see and push changes. A login lasts about 2 hours.")),
      h("div", { class: "account-actions" },
        h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: () => login("#/briefs") }, "Log in with Lark")));
  }

  const proxyState = conn.blocked ? ["is-err", "Blocked by this browser. Allow it in your ad blocker, then reload."]
    : { awake: ["is-ok", `Awake${conn.version ? ` · v${conn.version.replace(/^v/i, "")}` : ""}`],
        waking: ["is-warn", "Waking up… This can take up to a minute."],
        outdated: ["is-err", `Out of date (${conn.detail}). Ask the admin to redeploy it.`],
        down: ["is-err", `Unreachable${conn.detail ? ` (${conn.detail})` : ""}`] }[conn.proxy]
    || ["", "Not checked yet"];
  const rows = S.data ? Object.values(S.data).reduce((n, list) => n + list.length, 0) : 0;
  const larkState = S.problems.length ? ["is-err", `${S.problems.length} column problem${S.problems.length === 1 ? "" : "s"}: ${S.problems.join(" ")}`]
    : S.loadError ? ["is-err", describe(S.loadError)]
    : S.data ? ["is-ok", `Connected · ${Object.keys(S.data).length} tables · ${rows.toLocaleString()} rows`]
    : S.loading ? ["is-warn", "Loading…"]
    : ["", t ? "Not loaded yet" : "Log in to connect"];
  $("#connList").replaceChildren(
    h("li", null, h("span", { class: `dot ${proxyState[0]}` }),
      h("span", { class: "status-text" }, h("b", null, "Connection service"), h("span", null, `${proxyState[1]} · ${proxyHost()}`)),
      h("button", { type: "button", class: "btn btn-sm", onclick: () => { conn.checkedAt = 0; wake().then(renderSettings); renderSettings(); } },
        conn.proxy === "down" || conn.proxy === "outdated" ? "Try again" : "Wake up")),
    h("li", null, h("span", { class: `dot ${larkState[0]}` }),
      h("span", { class: "status-text" }, h("b", null, "Lark tables"), h("span", null, larkState[1])),
      t ? h("button", { type: "button", class: "btn btn-sm", disabled: S.loading, onclick: () => loadData({ quiet: !!S.data }) }, "Refresh") : null),
    ...Object.entries(tables).map(([k, tb]) => h("li", null,
      h("span", { class: "status-text" }, h("b", null, TABLE_TITLES[k]),
        h("span", null, S.data ? `${S.data[k].length.toLocaleString()} rows` : tb.table)),
      h("a", { class: "btn btn-sm btn-ghost", href: tb.url, target: "_blank", rel: "noopener" }, "Open in Lark", ic("external")))));
  $("#envNote").textContent = ENV_LABEL
    ? `Polaris is connected to the ${ENV_LABEL.toLowerCase()} tables. To go live, set APP.env in js/config.js.`
    : "";
  $("#advanced").hidden = !isLocalPage();
  const input = $("#proxyInput");
  if (document.activeElement !== input) input.value = savedLarkUrl();
  input.placeholder = SERVICES.lark.url;
}

function sessionLine() {
  return `Logged in until ${fmt.time(auth.endsAt())} · ${fmt.duration(auth.msLeft())} left`;
}

/* "This browser": forget the hidden audit cards and how the tables are sorted and
   folded (the login and the theme stay). Undo puts them back. */
function clearLocal() {
  const saved = LOCAL_KEYS.map(k => [k, recall("local", k)]);
  LOCAL_KEYS.forEach(k => store("local", k));
  reloadLocal();
  toast("Cleared this browser's hidden cards, sort order, folded groups and unsent drafts.", {
    type: "success", detail: "Your login and theme are kept.", action: "Undo", onAction: () => {
      saved.forEach(([k, v]) => { if (v !== null) store("local", k, v); });
      reloadLocal();
    },
  });
}
function reloadLocal() {
  S.auditHide = new Set(recall("local", "polaris.auditHidden") || []);
  S.drafts = loadDrafts();
  universe.loadPrefs();
  collections.loadPrefs();
  if (S.data) recompute();
  render();
}

/* ======================= session clock ======================= */
let warnedLow = false;
function tickSession() {
  if (!auth.hadSession()) return;
  if (!auth.currentToken()) {
    // A write or upload still running finishes first (track() ticks again when it settles).
    if (!inflight && S.view !== "login") auth.end();
    return;
  }
  renderHeader();
  const line = $("#accSession");
  if (line) line.textContent = sessionLine();
  if (!warnedLow && auth.msLeft() < 5 * 60 * 1000) {
    warnedLow = true;
    toast(`Your login ends at ${fmt.time(auth.endsAt())}.`, {
      type: "warn", timeout: 0, detail: "Log in again to keep working without a break.",
      action: "Log in again", onAction: () => login(location.hash),
    });
  }
}

/* ======================= wiring ======================= */
fillIcons();
initTheme($("#themeSeg"), KEY.theme);
$("#loginBtn").addEventListener("click", () => login());
$("#reloadBtn").addEventListener("click", () => location.reload());
$("#clearLocal").addEventListener("click", clearLocal);
$("#proxySave").addEventListener("click", () => {
  const v = $("#proxyInput").value.trim();
  if (v && !isServiceUrl(v)) { toast("Use an https:// address, or http:// for one on this computer.", { type: "error" }); return; }
  setLarkUrl(v);
  toast(v ? "Using that connection service on this computer." : "Using the hosted connection service.", { type: "success" });
  conn.checkedAt = 0; conn.proxy = "unknown"; conn.blocked = false;
  wake().then(() => render());
  render();
});
$("#proxyReset").addEventListener("click", () => {
  setLarkUrl("");
  $("#proxyInput").value = "";
  toast("Using the hosted connection service.", { type: "success" });
  conn.checkedAt = 0; conn.proxy = "unknown"; conn.blocked = false;
  wake().then(() => render());
  render();
});
onConn(() => {
  $("#blockNote").hidden = !conn.blocked;
  $("#blockHost").textContent = proxyHost();
  if (S.view === "settings") renderSettings();
  if (S.view === "busy") {
    $("#busyMsg").textContent = conn.proxy === "waking"
      ? "Logging you in… Waking up the connection service, which can take up to a minute."
      : "Logging you in…";
  }
  if (S.view === "work" && S.loading) { inbox.renderLoader(); universe.renderLoader(); }
});
window.addEventListener("hashchange", onRoute);
// A write or upload is running: closing the tab now could lose it.
window.addEventListener("beforeunload", (e) => { if (inflight) { e.preventDefault(); e.returnValue = ""; } });
matchMedia("(min-width: 1280px)").addEventListener("change", () => render());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  tickSession();
  // Back on the page after a while (common on a phone): pick up what changed meanwhile.
  if (S.view === "work" && S.data && !S.loading && !$("#sheet").open && Date.now() - S.loadedAt > STALE_AFTER_MS) {
    loadData({ quiet: true });
  }
});
setInterval(tickSession, 20000);

(async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has("code") || params.has("error")) {
    S.view = "busy";
    render();
    // The code is single-use: take it out of the address now, so a reload while
    // this runs starts over cleanly instead of replaying a spent code.
    history.replaceState(null, "", location.pathname + location.hash);
    const res = await auth.finishLogin(params);
    history.replaceState(null, "", location.pathname + (res.returnTo && res.returnTo !== "#/" ? res.returnTo : "#/briefs"));
    if (!res.ok) S.loginNote = res.message || describe(res.err);
  } else if (!location.hash) {
    history.replaceState(null, "", location.pathname + location.search + "#/briefs");
  }
  if (auth.currentToken()) {
    S.user = null;
    auth.loadUser().then((u) => { S.user = u; renderHeader(); if (S.view === "settings") renderSettings(); })
      .catch(() => {});   // no name or picture is fine; a dead login already ended the session (net.js)
  } else if (auth.hadSession() && !S.loginNote) {
    S.loginNote = "Your login ended after about 2 hours. Log in again to keep going.";
    auth.clearSession();
  }
  wake();
  onRoute();
})();
document.documentElement.dataset.booted = "";   // started: the boot watchdog in index.html stands down
