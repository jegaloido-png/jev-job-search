// Opens a URL in the runner's Chrome (port 9333) and counts form controls in the page and inside open shadow roots, at a few moments. Closes the tab.
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result.value; };
const probe = String.raw`(() => {
  const light = [...document.querySelectorAll('input, select, textarea')];
  const deep = []; const hosts = new Set();
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { hosts.add(el.tagName.toLowerCase()); for (const c of el.shadowRoot.querySelectorAll('input, select, textarea')) deep.push(el.tagName.toLowerCase() + '>' + c.tagName + '[' + (c.type||'') + '] ' + (c.getAttribute('aria-label')||c.name||c.id||'')); walk(el.shadowRoot); } } };
  walk(document);
  return 'light=' + light.length + ' ' + light.map(c => c.tagName + '[' + (c.type||'') + ']' + (c.name||c.id||'')).join(', ').slice(0, 600) + '\nshadow hosts=' + [...hosts].join(',').slice(0, 400) + '\nshadow controls=' + deep.length + '\n' + deep.slice(0, 40).join('\n');
})()`;
for (const ms of [3000, 5000]) { await new Promise((r) => setTimeout(r, ms)); console.log("== at", ms); console.log(await ev(probe)); }
if (!process.argv.includes("--keep")) await send("Page.close");
process.exit(0);
