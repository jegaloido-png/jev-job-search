// Opens a URL in the runner's Chrome (port 9333) and lists its iframes and the links/buttons that look like Apply. Closes the tab.
const url = process.argv[2];
const t = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 400) : r.result.value; };
await new Promise((r) => setTimeout(r, 6000));
console.log("URL", await ev("location.href"));
console.log(await ev(String.raw`[...document.querySelectorAll('iframe')].map(f => 'IFRAME ' + (f.src || '(no src)').slice(0, 160) + ' size=' + f.offsetWidth + 'x' + f.offsetHeight).join('\n')`));
console.log(await ev(String.raw`[...document.querySelectorAll('a, button, [role=button]')].filter(e => /apply|interess|candid/i.test(e.innerText || '')).map(e => e.tagName + ' "' + (e.innerText || '').trim().slice(0, 60) + '" href=' + (e.href || '').slice(0, 160)).join('\n')`));
await send("Page.close");
process.exit(0);
