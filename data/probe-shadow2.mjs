// Opens a URL in the runner's Chrome (port 9333) and prints, for each control inside open shadow roots, its host chain, attributes and nearby label text. Closes the tab.
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result.value; };
await new Promise((r) => setTimeout(r, 6000));
console.log(await ev(String.raw`(() => {
  const out = [];
  const attrs = (e) => [...e.attributes].map(a => a.name + '=' + a.value.slice(0, 40)).join(' ').slice(0, 300);
  const walk = (root, chain) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { const c = chain.concat(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')); for (const x of el.shadowRoot.querySelectorAll('input, select, textarea')) { const sr = el.shadowRoot; out.push('CHAIN ' + c.join(' >>> ') + '\n  CTRL ' + x.tagName + ' ' + attrs(x) + '\n  HOST ' + attrs(el) + '\n  HOSTTEXT ' + (el.innerText||'').replace(/\s+/g,' ').slice(0,120) + '\n  SRLABELS ' + [...sr.querySelectorAll('label, [class*=label]')].map(l => (l.textContent||'').trim().slice(0,60)).join(' | ')); } walk(el.shadowRoot, c); } } };
  walk(document, []);
  return out.join('\n');
})()`));
await send("Page.close");
process.exit(0);
