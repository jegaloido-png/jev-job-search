// Records the runner's Chrome (port 9333) from outside: a JPEG frame of every page tab
// twice a second, and an MP4 of the tab's frames when the tab closes.
// Frames: data/rec/<start>_<host>/NNNNN.jpg. Videos: data/rec/<start>_<host>.mp4.
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const OUT = "C:/Users/corna/Desktop/jev-job-search/data/rec";
const FFMPEG = "C:/Users/corna/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin/ffmpeg.exe";
mkdirSync(OUT, { recursive: true });
const ver = await (await fetch("http://127.0.0.1:9333/json/version")).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    setTimeout(() => { if (pending.delete(i)) rej(new Error("timeout " + method)); }, 4000);
  });
const tabs = new Map(); // targetId -> { sessionId, url, dir, n }
const stamp = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`; };
const host = (u) => { try { return new URL(u).host.replace(/[^a-z0-9.]+/gi, "_"); } catch { return "page"; } };

const finish = (t) => {
  if (!t.dir || t.n < 2) return;
  const mp4 = `${t.dir}.mp4`;
  spawn(FFMPEG, ["-y", "-loglevel", "error", "-framerate", "2", "-i", `${t.dir}/%05d.jpg`, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", mp4], { stdio: "ignore" })
    .on("exit", () => console.log("video", mp4, `${t.n} frames`));
};

ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") {
    const info = m.params.targetInfo;
    if (info.type !== "page") return;
    let t = tabs.get(info.targetId);
    if (!t) {
      t = { url: info.url, n: 0 };
      tabs.set(info.targetId, t);
      try { t.sessionId = (await send("Target.attachToTarget", { targetId: info.targetId, flatten: true })).sessionId; } catch {}
    }
    t.url = info.url;
    // A tab gets its folder once it leaves about:blank, named after the site it opened.
    if (!t.dir && /^https?:/.test(info.url)) { t.dir = `${OUT}/${stamp()}_${host(info.url)}`; mkdirSync(t.dir, { recursive: true }); }
  }
  if (m.method === "Target.targetDestroyed") {
    const t = tabs.get(m.params.targetId);
    if (t) { finish(t); tabs.delete(m.params.targetId); }
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Target.setDiscoverTargets", { discover: true });
setInterval(async () => {
  for (const t of tabs.values()) {
    if (!t.sessionId || !t.dir || t.busy) continue;
    t.busy = true;
    try {
      const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, t.sessionId);
      writeFileSync(`${t.dir}/${String(++t.n).padStart(5, "0")}.jpg`, Buffer.from(r.data, "base64"));
    } catch {} finally { t.busy = false; }
  }
}, 500);
console.log("recording", OUT);
