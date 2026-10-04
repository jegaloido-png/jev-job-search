// Runs the runner's dropdown fill on an open tab: npx tsx data/try-dd.ts <url-part> <selector> <value>
import { listTargets, Page } from "../src/browser/cdp.js";
import { install } from "../src/browser/session.js";
import { fillDropdown, readOptions } from "../src/browser/dropdowns.js";
const [want, sel, value] = process.argv.slice(2);
const t = ((await listTargets()) ?? []).find((x) => x.type === "page" && x.url.includes(want!))!;
const page = await Page.attach(t);
await install(page);
console.log("options", (await readOptions(page, sel!)).slice(0, 8));
process.env.AWJ_TRACE = "1";
console.log("fill", await fillDropdown(page, sel!, value!, []));
console.log("shown", await page.evaluate(`window.__awj.shown(${JSON.stringify(sel)})`));
page.close();
process.exit(0);
