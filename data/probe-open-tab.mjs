// Attaches to an open tab of the runner's Chrome (port 9333) whose URL contains the given text, and prints the screening
// structure: every control inside shadow roots with its host chain and the words around it. Leaves the tab open.
const want = process.argv[2];
const tabs = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const t = tabs.find((x) => x.type === "page" && x.url.includes(want));
if (!t) { console.log("no tab"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
console.log(await ev(process.argv[3] || String.raw`(() => {
  const out = [];
  const attrs = (e) => [...e.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ').slice(0, 250);
  const walk = (root, chain) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const c = chain.concat(el.tagName.toLowerCase() + (el.id ? '#' + el.id.slice(0, 20) : '')); for (const x of el.shadowRoot.querySelectorAll('input, select, textarea, button[role=combobox]')) out.push(c.join(' > ') + '\n   CTRL ' + x.tagName + ' ' + attrs(x) + '\n   HOST ' + attrs(el) + '\n   HOSTTEXT ' + (el.innerText || '').replace(/\s+/g, ' ').slice(0, 150)); walk(el.shadowRoot, c); } } };
  walk(document, []);
  return out.join('\n');
})()`));
process.exit(0);
