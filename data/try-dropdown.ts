// Sets one dropdown on an open tab of the runner's Chrome the way a run does, and prints what the page shows after.
// Usage: npx tsx data/try-dropdown.ts <tab url part> <selector> <value>
import { listTargets, Page } from "../src/browser/cdp.js";
import { fillDropdown } from "../src/browser/dropdowns.js";
import { install, shownValues } from "../src/browser/session.js";
const [want, selector, value] = process.argv.slice(2) as [string, string, string];
const t = ((await listTargets()) ?? []).find((x) => x.type === "page" && x.url.includes(want));
if (!t) throw new Error("no tab");
const page = await Page.attach(t);
await install(page);
console.log(await fillDropdown(page, selector, value, ["Bari", "Puglia", "Italy"], true));
console.log("shown:", (await shownValues(page, [selector]))[0]);
page.close();
process.exit(0);
