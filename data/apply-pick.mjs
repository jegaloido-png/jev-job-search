// Prints what the runner's APPLY_BUTTON would press on a tab: node data/apply-pick.mjs <match>
import fs from "node:fs";
const src = fs.readFileSync("src/browser/formRunner.ts", "utf8");
const m = src.match(/const APPLY_BUTTON =\s*([\s\S]*?);\n/);
const pattern = eval(m[1]);
const tabs = (await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json())).filter((x) => x.type === "page" && x.url.includes(process.argv[2]));
const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const x = JSON.parse(ev.data); if (x.id === my) { ws.removeEventListener("message", h); res(x.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
console.log(JSON.stringify(await ev(`window.__awj.clickByText(${JSON.stringify(pattern)})`)));
ws.close();
