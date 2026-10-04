/**
 * The runner's tabs. One tab per job, remembered in data/runs/browser-session.json
 * so a later command (resolve, submit, check) finds the form that fill opened.
 * Also the few page helpers every step needs: install the in-page helpers, wait
 * for a page to settle, read the form, read values back, and take turns at the
 * front of the window.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BROWSER, PATHS } from "../config.js";
import { FieldsDump } from "../forms/fields.js";
import { closeTab, listTargets, newTab, Page, sleep } from "./cdp.js";

export const script = (name: string) => readFileSync(path.join(PATHS.browserScripts, name), "utf8");
const SESSION = path.join(PATHS.runs, "browser-session.json");

type Session = Record<string, { targetId: string; url: string }>;
export type Point = { x: number; y: number; ok: boolean; href?: string };
export type ControlState = "on" | "off" | "missing";

export const loadSession = (): Session => (existsSync(SESSION) ? (JSON.parse(readFileSync(SESSION, "utf8")) as Session) : {});
export const saveSession = (s: Session) => {
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(SESSION, JSON.stringify(s, null, 2));
};

/** Step timings on stderr when AWJ_TRACE is set. */
export const trace = (line: string) => {
  if (process.env.AWJ_TRACE) console.error(`[fill] ${line}`);
};

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export async function install(page: Page): Promise<void> {
  await page.evaluate(script("pageHelpers.js"));
}
Page.reinstall = install;

/** Waits until the document is loaded and its form controls stop changing. A page with no controls yet gets longer: single-page forms render late. */
export async function settle(page: Page): Promise<void> {
  const started = Date.now();
  let last = -2;
  let stable = 0;
  while (Date.now() - started < BROWSER.settleMs) {
    await sleep(BROWSER.pollMs);
    let n = -1;
    try {
      // "interactive" is enough: a tracker or a font that never finishes loading must not hold the form up.
      // Controls inside shadow roots count too: a form drawn with web components shows none in the page itself.
      n = await page.evaluate<number>(
        "(() => { if (document.readyState === 'loading') return -1; let n = 0; const walk = (r) => { n += r.querySelectorAll('input, select, textarea').length; for (const e of r.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot); }; walk(document); return n; })()",
      );
    } catch {
      n = -1; // mid-navigation
    }
    stable = n >= 0 && n === last ? stable + 1 : 0;
    last = n;
    if (stable >= 3 && (n >= 3 || Date.now() - started > BROWSER.emptyPageMs)) break;
  }
  trace(`settled in ${Date.now() - started}ms with ${last} controls`);
}

export async function dump(page: Page): Promise<FieldsDump> {
  return FieldsDump.parse(JSON.parse(await page.evaluate<string>(script("dumpFields.js"))));
}

export async function goto(page: Page, url: string, referrer?: string): Promise<void> {
  await page.navigate(url, referrer);
  await settle(page);
  await install(page);
}

/** Clicks and typing need the tab in front, so tabs filled side by side take turns for them. */
let turn: Promise<unknown> = Promise.resolve();
export function inFront<T>(page: Page, work: () => Promise<T>): Promise<T> {
  return inTurn(async () => {
    await page.bringToFront();
    return work();
  });
}

/**
 * Anything that changes which tab is in front takes the same turns: opening a tab, closing one.
 * A tab that opens while another is being typed into takes the window from it, and a box that
 * loses the window in the middle of typing can throw the text away.
 */
export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work);
  turn = run.catch(() => undefined);
  return run;
}

export function controlStates(page: Page, selectors: string[]): Promise<ControlState[]> {
  return page.call<ControlState[]>("(selectors) => selectors.map((s) => window.__awj.state(s))", selectors);
}

export function shownValues(page: Page, selectors: string[]): Promise<string[]> {
  return page.call<string[]>('(selectors) => selectors.map((s) => { try { return window.__awj.shown(s); } catch { return ""; } })', selectors);
}

export async function pageFor(jobId: string): Promise<Page> {
  const s = loadSession()[jobId];
  const targets = (await listTargets()) ?? [];
  const t = s ? targets.find((x) => x.id === s.targetId) : undefined;
  if (!t) throw new Error(`No open tab for job ${jobId}. Run fill first.`);
  const page = await Page.attach(t);
  await install(page);
  return page;
}

/** True when the job still has a tab open in the runner's window. */
export async function hasOpenTab(jobId: string): Promise<boolean> {
  const s = loadSession()[jobId];
  return !!s && ((await listTargets()) ?? []).some((t) => t.id === s.targetId);
}

export async function closeJobTab(jobId: string): Promise<void> {
  const s = loadSession()[jobId];
  if (s) await inTurn(() => closeTab(s.targetId));
  // Read and written in one synchronous step, so jobs handled side by side do not overwrite each other.
  const session = loadSession();
  delete session[jobId];
  saveSession(session);
}

/**
 * Closes every tab of the runner's window that belongs to no job: a page a site opened by itself (a privacy policy,
 * a pop-up), or one left by a run that stopped halfway. One blank tab stays, so the window stays open. Jobs that
 * no longer have a tab are dropped from the session. Returns how many tabs were closed.
 */
export async function closeStrayTabs(): Promise<number> {
  const targets = (await listTargets()) ?? [];
  const session = loadSession();
  const open = new Set(targets.map((t) => t.id));
  for (const [id, s] of Object.entries(session)) if (!open.has(s.targetId)) delete session[id];
  saveSession(session);
  const jobs = new Set(Object.values(session).map((s) => s.targetId));
  const blank = targets.filter((t) => t.url === "about:blank" && !jobs.has(t.id));
  // With no blank tab and no job left, closing the rest would close the window: a blank one is opened first.
  const keep = blank[0]?.id ?? (jobs.size ? undefined : (await inTurn(() => newTab("about:blank"))).id);
  const stray = targets.filter((t) => !jobs.has(t.id) && t.id !== keep);
  for (const t of stray) await inTurn(() => closeTab(t.id));
  return stray.length;
}

/**
 * Where to click a form's own button. Its selector can stop naming it once the page has redrawn around it (Workday: a
 * path of positions), so a button with the same words that the page shows now is taken instead.
 */
export async function buttonPoint(page: Page, b: { selector: string; text: string }): Promise<Point> {
  const p = await page.awj<Point>("point", b.selector);
  if (p.ok || !b.text) return p;
  const now = await dump(page);
  for (const s of now.submitSelectors) {
    const selector = s.split("  /*")[0] ?? s;
    const text = /\/\*\s*(.*?)\s*\*\//.exec(s)?.[1] ?? "";
    if (text.toLowerCase() !== b.text.toLowerCase()) continue;
    const again = await page.awj<Point>("point", selector);
    if (again.ok) return again;
  }
  return p;
}
