/* The row beside the push sheet: the Lark row the push changes (or creates),
   laid out as a filled-in document, so what's there can be compared with what
   the sheet will write. It re-renders as the sheet changes. Cells the push
   changes are highlighted, with the old value struck through; blank cells stay
   empty. Lookups and formulas show what Lark has (a new row has none yet). A new
   row has nothing to compare, so nothing is highlighted. */

import { h } from "./ui.js";
import { plain, cellText } from "./sync.js";
import { computedTypes, TABLE_TITLES } from "./ops.js";
import { RULES } from "./config.js";

const TITLE_FIELD = { universe: "Project", andon: "Project", collections: "AR Name" };
const LONG = /description|remarks|links|notes/i;

export function createRowDoc(ctx) {
  const { S } = ctx;

  /* p: { table, rowId, fields (what the push writes), names, code, name } */
  function render(box, p) {
    const rec = p.rowId ? (S.data[p.table] || []).find(r => r.record_id === p.rowId) : null;
    const now = rec ? rec.fields : {};
    const writes = p.fields || {};
    const names = p.names || {};
    const nameOf = (id) => names[id] || ((S.pool || []).find(u => u.id === id) || {}).name
      || ((S.pmPool || []).find(u => u.id === id) || {}).name || "";
    const show = (def, v) => cellText(def, v, { nameOf, offsetHours: RULES.utcOffsetHours });
    // Only columns Polaris read (null: all), so nothing looks blank just because it wasn't loaded.
    const read = (S.columns || {})[p.table];
    const known = Array.isArray(read) ? new Set(read) : null;
    const defs = ctx.fieldsOf(p.table).filter(d => {
      const k = d.field_name;
      if (d.type === 7 && /^ignore$/i.test(k)) return false;          // Polaris's own flag, not row data
      if (!rec && computedTypes.has(d.type)) return false;            // Lark fills these once the row exists
      return k in writes || !known || known.has(k);
    });
    const value = (k) => show(defs.find(d => d.field_name === k), k in writes ? writes[k] : now[k]);

    const fields = defs.map((d) => {
      const k = d.field_name;
      const before = show(d, now[k]);
      const after = k in writes ? show(d, writes[k]) : before;
      const changed = !!rec && after !== before;
      const wide = d.type === 17 || LONG.test(k) || after.length > 48 || after.includes("\n");
      return h("div", { class: `doc-field${wide ? " is-wide" : ""}${changed ? " is-change" : ""}` },
        h("dt", null, k),
        h("dd", null, changed && before ? h("del", null, before) : null, after));
    });

    const title = value(TITLE_FIELD[p.table]) || p.name || "";
    const meta = [p.code || value("Project Code"), value("Status")].filter(Boolean).join(" · ");
    box.replaceChildren(
      h("header", { class: "doc-head" },
        h("p", { class: "doc-kicker" }, rec ? TABLE_TITLES[p.table] : `${TABLE_TITLES[p.table]} · New row`),
        h("h3", null, plain(title) || "(no name)"),
        meta ? h("p", { class: "doc-meta" }, meta) : null),
      h("div", { class: "doc-body" }, h("dl", { class: "doc-fields" }, fields)));
  }

  return { render };
}
