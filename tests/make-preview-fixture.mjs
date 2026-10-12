/* Makes tests/.preview-fixture.json: a read-only snapshot of the tables in
   js/config.js, for preview mode (http://127.0.0.1:9123/?preview). Run:
     npm run preview:fixture
   The snapshot holds real business data: keep it on your computer (it's in
   .gitignore), never publish it, and delete it when you're done. */

import { writeFileSync } from "node:fs";
import { RULES } from "../js/config.js";
import { loadEverything } from "../js/ops.js";
import { tenantToken, makeCall, tables } from "./lark-node.mjs";

const T = tables();
const { data, fields } = await loadEverything(makeCall(await tenantToken()), T, RULES);
writeFileSync(new URL("./.preview-fixture.json", import.meta.url), JSON.stringify({
  tables: Object.fromEntries(Object.entries(T).map(([k, t]) => [k, t.table])),
  fields,
  records: data,
}));
console.log("Wrote tests/.preview-fixture.json:",
  Object.entries(data).map(([k, v]) => `${k} ${v.length}`).join(", "));
console.log("Open http://127.0.0.1:9123/?preview in its own tab. Delete the file when you're done.");
