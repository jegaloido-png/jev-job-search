// Repro of the runner's Apply step with its own primitives. Usage: npx tsx data/try-apply.ts <url> [clear] [nodecline]
import { readFileSync } from "node:fs";
import { clearBrowsingData, closeTab, newTab, Page, sleep } from "../src/browser/cdp.js";
import { inFront, install, settle } from "../src/browser/session.js";
import { declineCookieBanner } from "../src/browser/submit.js";
const [url, ...flags] = process.argv.slice(2);
if (flags.includes("clear")) await clearBrowsingData();
const t = await newTab("about:blank");
const page = await Page.attach(t);
await page.navigate(url!);
await settle(page);
await install(page);
if (!flags.includes("nodecline")) console.log("decline", await inFront(page, () => declineCookieBanner(page)));
await sleep(Number(process.env.WAIT ?? 1000));
const src = readFileSync("src/browser/formRunner.ts", "utf8");
const pattern = eval(src.match(/const APPLY_BUTTON =\s*([\s\S]*?);\r?\n/)![1]!);
const p = await page.awj<{ x: number; y: number; ok: boolean; href?: string }>("clickByText", pattern);
console.log("point", JSON.stringify(p), "under:", await page.evaluate<string>(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? e.tagName + "." + String(e.className).slice(0, 40) : "none"; })()`));
await inFront(page, () => page.click(p.x, p.y));
for (let i = 0; i < 16; i++) { await sleep(500); const h = await page.evaluate<string>("location.href").catch(() => "?"); if (!h.includes("/job/")) { console.log("moved", h.slice(0, 100)); break; } if (i === 15) console.log("stayed", h.slice(0, 100)); }
page.close();
await closeTab(t.id);
process.exit(0);
