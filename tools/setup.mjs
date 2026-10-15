/* Setup and repair: makes the Lark tables match the spec Polaris checks on every
   load (schemaSpec in js/ops.js), so a missing column or select option is fixed
   once, here, instead of switching pushes off for everyone.

     npm run setup                    dry run: lists what's missing, changes nothing
     npm run setup -- --apply         creates the missing columns and select options
     npm run setup -- --optional      also counts the optional columns (e.g. the Universe's IGNORE box)
     npm run setup -- --tables universe,collections

   It only ever ADDS: it never deletes, renames or retypes a column, and never
   removes an option. A column with the wrong type is reported, for a person to fix.
   It only creates in the Universe and Collections, the two tables Polaris owns; the
   Project Brief, PAR and Invoice Request tables are filled by Lark Approval, so a
   missing column there is reported (with --tables), never created.

   It runs as the Lark app (tests/lark-node.mjs: LARK_APP_SECRET in the environment
   or .env) and needs the app to have edit access to the Base. */

import { pathToFileURL } from "node:url";
import { RULES } from "../js/config.js";
import { OPEN_API, schemaSpec, loadFields, selectOptions, TABLE_TITLES } from "../js/ops.js";
import { tenantToken, makeCall, tables as allTables } from "../tests/lark-node.mjs";

const TYPE_NAMES = { 1: "Text", 2: "Number", 3: "Single select", 4: "Multi select", 5: "Date",
                     7: "Checkbox", 11: "Person", 15: "URL", 17: "Attachment" };
const SELECTS = new Set([3, 4]);
const OWNED = ["universe", "collections"];     // tables Polaris adds columns to by default

/* What's missing in one table. `live` = the table's fields as Lark lists them.
   Returns { columns: [{name, type, options}], options: [{field, id, type, existing, add}], wrongType: [string], notes: [string] }. */
export function planRepair(key, spec, live, { optional = false } = {}) {
  const byName = new Map(live.map(f => [f.field_name, f]));
  const wanted = (name) => ((spec.options || {})[name] || []);
  const plan = { columns: [], options: [], wrongType: [], notes: [] };
  const title = TABLE_TITLES[key] || key;
  const consider = (name, type, required) => {
    const f = byName.get(name);
    if (!f) {
      if (required || optional) plan.columns.push({ name, type, options: SELECTS.has(type) ? wanted(name) : [] });
      else plan.notes.push(`${title}: optional column “${name}” isn't there (add it with --optional).`);
    } else if (f.type !== type) {
      plan.wrongType.push(`${title}: column “${name}” is ${TYPE_NAMES[f.type] || "type " + f.type}, expected ${TYPE_NAMES[type] || "type " + type}. Fix it by hand.`);
    }
  };
  for (const [name, type] of Object.entries(spec.fields || {})) consider(name, type, true);
  for (const [name, type] of Object.entries(spec.optional || {})) consider(name, type, false);
  // Options the page writes: add the ones an existing select column lacks.
  for (const [name, list] of Object.entries(spec.options || {})) {
    const f = byName.get(name);
    if (!f || !SELECTS.has(f.type)) continue;
    const have = selectOptions(f);
    const add = list.filter(o => !have.includes(o));
    if (add.length) plan.options.push({ field: name, id: f.field_id, type: f.type, existing: (f.property && f.property.options) || [], add });
  }
  return plan;
}

const fieldsUrl = (t) => `${OPEN_API}/bitable/v1/apps/${encodeURIComponent(t.app)}/tables/${encodeURIComponent(t.table)}/fields`;

/* The property Lark wants when a column is created. */
const propertyFor = (c) => (SELECTS.has(c.type) ? { options: c.options.map(name => ({ name })) }
  : c.type === 11 ? { multiple: true } : undefined);

/* Plan (and, with apply, carry out) the repair of each table. `call(method, url, body)` is
   a direct Lark caller. Resolves { plans, changes, problems }: what was found, how many
   changes were made, and what needs a person. */
export async function runSetup({ call, tables, rules = RULES, apply = false, only = OWNED, optional = false, log = console.log }) {
  const spec = schemaSpec(rules);
  const out = { plans: {}, changes: 0, problems: 0 };
  for (const key of only) {
    const t = tables[key];
    if (!t || !spec[key]) { log(`${TABLE_TITLES[key] || key}: no link in js/config.js that this script can open, skipped.`); continue; }
    const plan = planRepair(key, spec[key], await loadFields(call, t), { optional });
    out.plans[key] = plan;
    const title = TABLE_TITLES[key];
    const owned = OWNED.includes(key);                       // the others are only ever reported
    const verb = !owned ? "missing" : apply ? "+" : "would add";
    const todo = plan.columns.length + plan.options.length;
    log(`\n${title}: ${todo ? `${todo} change${todo === 1 ? "" : "s"} to make` : "nothing to add"}`);
    if (!owned && todo) log("  · Lark Approval fills this table: a column is added there, not here.");
    for (const p of plan.wrongType) { log(`  ! ${p}`); out.problems++; }
    for (const n of plan.notes) log(`  · ${n}`);
    for (const c of plan.columns) {
      log(`  ${verb} column “${c.name}” (${TYPE_NAMES[c.type] || c.type}${c.options.length ? `: ${c.options.join(", ")}` : ""})`);
      if (apply && owned) {
        const body = { field_name: c.name, type: c.type };
        if (propertyFor(c)) body.property = propertyFor(c);
        await call("POST", fieldsUrl(t), body);
        out.changes++;
      }
    }
    for (const o of plan.options) {
      log(`  ${verb} option${o.add.length === 1 ? "" : "s"} ${o.add.map(x => `“${x}”`).join(", ")} to “${o.field}”`);
      if (apply && owned) {
        await call("PUT", `${fieldsUrl(t)}/${encodeURIComponent(o.id)}`, {
          field_name: o.field, type: o.type,
          property: { options: [...o.existing, ...o.add.map(name => ({ name }))] },   // every existing option stays, ids and colors included
        });
        out.changes++;
      }
    }
  }
  if (!apply && Object.values(out.plans).some(p => p.columns.length || p.options.length)) log("\nThis was a dry run. Add --apply to make these changes.");
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const pick = args.indexOf("--tables");
  const only = pick >= 0 && args[pick + 1] ? args[pick + 1].split(",").map(s => s.trim()).filter(Boolean) : OWNED;
  const call = makeCall(await tenantToken());
  const res = await runSetup({ call, tables: allTables(), apply: args.includes("--apply"), only, optional: args.includes("--optional") });
  console.log(res.problems ? `\n${res.problems} problem(s) need a person.` : "\nDone.");
  process.exitCode = res.problems ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
