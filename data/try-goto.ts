// Opens a URL in a new tab of the runner's Chrome with an optional referrer, then prints where the tab landed. Usage: npx tsx data/try-goto.ts <url> [referrer]
import { newTab, Page, sleep } from "../src/browser/cdp.js";
const [url, ref] = process.argv.slice(2) as [string, string | undefined];
const t = await newTab("about:blank");
const page = await Page.attach(t);
await page.navigate(url, ref);
await sleep(6000);
console.log(await page.evaluate<string>("location.href"));
page.close();
process.exit(0);
