// In an open tab (port 9333) whose URL contains the given text: installs the page helpers and runs fillFields.js
// with one fill {selector, kind, value}, the way the runner sets a value from script. Prints the report.
import fs from "node:fs";
const [want, sel, kind, value] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const fill = fs.readFileSync("src/forms/fillFields.js", "utf8").replace(/^(\s*\/\/.*\n)+/, "").trim().replace(/;$/, "");
console.log(await ev(`(${fill})(${JSON.stringify([{ selector: sel, kind, value, label: "", action: "fill" }])})`));
process.exit(0);
