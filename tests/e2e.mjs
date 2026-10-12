/* Node runner for the end-to-end check (tests/e2e-core.js), using the app's
   tenant token:   npm run check:e2e -- --yes

   Only works if the Lark app itself has edit access to the Bases. If it can only
   read them (Lark 91403 on the first write), run tests/e2e.html in the browser
   instead, after logging in on the page: that runs as you. */

import { runE2E } from "./e2e-core.js";
import { tenantToken, makeCall, tables } from "./lark-node.mjs";

if (!process.argv.includes("--yes")) {
  console.error("This writes to the tables in js/config.js. Re-run with --yes to confirm.");
  process.exit(2);
}
const failures = await runE2E(makeCall(await tenantToken()), tables(), (line) => console.log(line));
process.exitCode = failures ? 1 : 0;
