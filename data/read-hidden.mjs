// Opens a URL in the runner's Chrome (port 9333) and reports, at several moments, every element whose text speaks of a sent application, shown or hidden. Closes the tab.
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = String.raw`(() => { const re = /grazie|inviat|ricevut|success|conferm|thank|registrat/i; return [...document.querySelectorAll('body *')].filter(e => e.children.length < 4 && re.test(e.textContent || '') && (e.textContent || '').length < 500).map(e => e.tagName + '#' + e.id + '.' + (typeof e.className === 'string' ? e.className : '') + ' shown=' + (e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden') + ' :: ' + (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)).slice(0, 25).join('\n'); })()`;
for (const ms of [800, 1500, 3000, 6000]) { await sleep(ms); console.log("== at", ms); console.log(await ev(probe)); }
console.log("== scripts mentioning confirmMessage");
console.log(await ev(String.raw`[...document.scripts].map(s => s.textContent).filter(s => /confirmMessage|message/i.test(s)).map(s => s.slice(0, 600)).join('\n----\n').slice(0, 3000)`));
await send("Page.close");
process.exit(0);
