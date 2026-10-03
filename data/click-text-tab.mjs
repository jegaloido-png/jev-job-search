// In an open tab of the runner's Chrome (port 9333) whose URL contains the given text: clicks the n-th visible button
// whose words match the regex (through shadow roots), waits, then prints the form reader's fields. Usage: <tab> <regex> [n]
import fs from "node:fs";
const [want, re, nth] = process.argv.slice(2);
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const p = await ev(`(() => { const all = []; const walk = (r) => { for (const e of r.querySelectorAll('*')) { if (e.matches('button, [role=button]')) all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document);
  const words = (x) => (x.innerText || '').trim() || (x.getRootNode().host ? (x.getRootNode().host.innerText || '').trim() : '');
  const hits = all.filter(b => b.getBoundingClientRect().height > 0 && new RegExp(${JSON.stringify(re)}, 'i').test(words(b)));
  const b = hits[${Number(nth || 0)}]; if (!b) return { ok: false, n: hits.length };
  b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: true, n: hits.length }; })()`);
console.log("click", JSON.stringify(p));
if (p.ok) { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }); }
await sleep(1500);
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const d = JSON.parse(await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8")));
for (const f of d.fields) console.log(`${f.kind}${f.required ? "*" : ""} value=${JSON.stringify(f.value).slice(0, 30)} "${f.label.replace(/\s+/g, " ").slice(0, 90)}" ${f.selector.slice(0, 90)}`);
console.log("submit:", d.submitSelectors.map((s) => s.split("/*")[1]).join(" | "));
process.exit(0);
