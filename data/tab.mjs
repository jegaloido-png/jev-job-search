// A small hand tool for the runner's Chrome (port 9333), to study a page step by step.
//   node data/tab.mjs open <url>                 opens a tab, prints its id
//   node data/tab.mjs text <match>               the page's visible words (first 3000 chars)
//   node data/tab.mjs dump <match>               the form reader's fields and submit buttons
//   node data/tab.mjs click <match> <regex> [n]  clicks the n-th visible button/link whose words match, like a person
//   node data/tab.mjs eval <match> <expression>  evaluates an expression (page helpers installed)
//   node data/tab.mjs close <match>              closes the tab
// <match> is a piece of the tab's URL. Nothing here types a password.
import fs from "node:fs";
const [cmd, want, a1, a2] = process.argv.slice(2);
const base = "http://127.0.0.1:9333/json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (cmd === "open") {
  const t = await fetch(`${base}/new?${encodeURIComponent(want)}`, { method: "PUT" }).then((r) => r.json());
  console.log(t.id);
  process.exit(0);
}
const tabs = (await fetch(`${base}/list`).then((r) => r.json())).filter((x) => x.type === "page");
const t = tabs.find((x) => x.url.includes(want));
if (!t) {
  console.log("no tab; open:", tabs.map((x) => x.url.slice(0, 90)).join(" | "));
  process.exit(1);
}
if (cmd === "close") {
  await fetch(`${base}/close/${t.id}`);
  process.exit(0);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener("message", function h(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 600) : r.result.value; };
await ev(fs.readFileSync("src/forms/pageHelpers.js", "utf8"));
console.log("url:", (await ev("location.href")).slice(0, 160));
if (cmd === "text") console.log((await ev("window.__awj.pageText()")).slice(0, Number(a1) || 3000));
if (cmd === "dump") {
  const d = JSON.parse(await ev(fs.readFileSync("src/forms/dumpFields.js", "utf8")));
  for (const f of d.fields) console.log(f.kind, f.widget ?? "", f.required ? "*" : " ", JSON.stringify(f.label).slice(0, 70), "=", JSON.stringify(f.value).slice(0, 40), f.options?.length ? `[${f.options.length} opts]` : "", f.selector.slice(0, 70));
  if (process.env.OPTS) for (const f of d.fields) if (f.options?.length && f.options.length < 8) console.log("   opts", JSON.stringify(f.label).slice(0, 30), f.options.map((o) => o.label).join(" | ").slice(0, 200));
  console.log("submit:", d.submitSelectors.join(" || ").slice(0, 400), "| password:", d.hasPassword);
}
if (cmd === "click") {
  const p = await ev(`(() => { const re = new RegExp(${JSON.stringify(a1)}, "i"); const all = []; const walk = (r) => { for (const e of r.querySelectorAll("button, a, [role=button], [role=link], input[type=submit], input[type=button]")) all.push(e); for (const e of r.querySelectorAll("*")) if (e.shadowRoot) walk(e.shadowRoot); }; walk(document);
    const hits = all.filter((e) => { const b = e.getBoundingClientRect(); const w = (e.innerText || e.value || e.getAttribute("aria-label") || "").trim(); return b.width > 0 && b.height > 0 && re.test(w); });
    const e = hits[${Number(a2) || 0}]; if (!e) return { ok: false, n: hits.length }; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { ok: true, x: b.x + b.width / 2, y: b.y + b.height / 2, words: (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().slice(0, 60), n: hits.length }; })()`);
  console.log("point", JSON.stringify(p));
  if (p?.ok) {
    await send("Page.bringToFront");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(3000);
    console.log("after:", (await ev("location.href")).slice(0, 160));
  }
}
// node data/tab.mjs type <match> <css selector> <text>: focuses the box and types the text key by key, then waits 3 s.
if (cmd === "type") {
  await send("Page.bringToFront");
  await ev(`(() => { const e = document.querySelector(${JSON.stringify(a1)}); e.scrollIntoView({ block: "center" }); e.focus(); e.value = ""; return 1; })()`);
  for (const ch of a2) { await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch }); await send("Input.dispatchKeyEvent", { type: "keyUp" }); await sleep(80); }
  await sleep(3000);
  console.log("typed");
}
if (cmd === "eval") console.log(JSON.stringify(await ev(a1), null, 1)?.slice(0, 4000));
ws.close();
