// Fills one field on an open tab of the runner's Chrome the way a run does. Usage: npx tsx data/try-fill.ts <tab url part> <selector> <kind> <value>
import { listTargets, Page } from "../src/browser/cdp.js";
import { applyFills } from "../src/browser/fill.js";
import { install, shownValues } from "../src/browser/session.js";
import { loadProfile } from "../src/profile/schema.js";
const [want, selector, kind, value] = process.argv.slice(2) as [string, string, string, string];
const t = ((await listTargets()) ?? []).find((x) => x.type === "page" && x.url.includes(want));
if (!t) throw new Error("no tab");
const page = await Page.attach(t);
await install(page);
console.log(await applyFills(page, [{ selector, kind, value }], loadProfile()));
console.log("shown:", (await shownValues(page, [selector]))[0]);
page.close();
process.exit(0);
