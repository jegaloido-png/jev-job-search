// Runs the runner's upload on an open tab: npx tsx data/try-up.ts <url-part> <selector> <file>
import { listTargets, Page } from "../src/browser/cdp.js";
import { install } from "../src/browser/session.js";
import { uploadFile } from "../src/browser/fill.js";
const [want, sel, file] = process.argv.slice(2);
const t = ((await listTargets()) ?? []).find((x) => x.type === "page" && x.url.includes(want!))!;
const page = await Page.attach(t);
await install(page);
console.log("proxy?", await page.awj("isFileProxy", sel), "q?", await page.evaluate(`!!window.__awj.q(${JSON.stringify(sel)})`));
console.log("upload:", await uploadFile(page, sel!, file!));
page.close();
process.exit(0);
