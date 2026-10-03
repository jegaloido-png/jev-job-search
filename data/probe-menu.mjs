// Opens a URL in the runner's Chrome (port 9333), finds a dumped field by label, prints its shown value, clicks it and
// prints the options the helpers see and where the list lives. Closes the tab. Usage: node data/probe-menu.mjs <url> <label regex>
import fs from "node:fs";
const [url, labelRe] = process.argv.slice(2);
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
const d = JSON.parse(await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8")));
const f = d.fields.find((x) => new RegExp(labelRe, "i").test(x.label));
console.log("field", JSON.stringify({ kind: f.kind, widget: f.widget, value: f.value, sel: f.selector, options: f.options.length }));
const S = JSON.stringify(f.selector);
console.log("shown", JSON.stringify(await ev(`window.__awj.shown(${S})`)));
console.log("el", await ev(`(() => { const e = window.__awj.q(${S}); return e.tagName + ' ' + [...e.attributes].map(a => a.name + '=' + a.value.slice(0, 50)).join(' '); })()`));
const p = await ev(`window.__awj.point(${S})`);
console.log("point", JSON.stringify(p));
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
await sleep(1500);
console.log("options", JSON.stringify((await ev(`window.__awj.options(${S})`)).slice(0, 15)));
console.log("active", await ev(`(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a ? a.tagName + ' ' + (a.getAttribute('aria-label') || a.id) : 'none'; })()`));
console.log("roles", await ev(String.raw`(() => { const out = []; const walk = (root, chain) => { for (const el of root.querySelectorAll('[role=option], [role=listbox], [role=menu], [role=menuitem]')) out.push(chain + ' ' + el.tagName + ' role=' + el.getAttribute('role') + ' id=' + el.id + ' vis=' + (el.getBoundingClientRect().height > 0)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, chain + '>' + el.tagName.toLowerCase()); }; walk(document, 'doc'); return out.slice(0, 25).join('\n'); })()`));
await send("Page.close");
process.exit(0);
