/**
 * Fills one job's application form in the runner's Chrome window, a page at
 * a time: read every field, read each dropdown's options, one JEV call to map
 * them, write every value, read every value back. A form that runs over
 * several pages is walked with its own Next button once a page is clean.
 * Nothing here sends an application: that is submit.ts.
 */
import path from "node:path";
import { BROWSER, FORM, MEMORY, RUN } from "../config.js";
import { isApplicationForm, type DumpedField, type FieldsDump, type FillPlan } from "../forms/fields.js";
import { hasChoosableOptions, mapForm, startDayOf } from "../forms/mapForm.js";
import { decidePageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import { applyUrlFor, greenhouseFallbackUrl, hostIs, type Job } from "../jobs/normalize.js";
import type { Profile } from "../profile/schema.js";
import { loadMemory, recallExact, recallForm, recallSameFields, recallSimilar, remember, saveMemory, type Recalled } from "../answers/memory.js";
import { contextFingerprint, resolveOpenFields, type OpenField, type Resolution } from "../answers/resolve.js";
import type { QueueEntry } from "../jobs/queue.js";
import { closeTab, ensureBrowser, newTab, Page, sleep } from "./cdp.js";
import { candidateOptions, closestOptions, readDropdownOptions } from "./dropdowns.js";
import { applyFills, provinceForRegion, TYPED_KINDS, uploadFile, type FillGuide } from "./fill.js";
import { learn, notesFor, signatureOf, type Method } from "../knowledge/sites.js";
import { showsValue, toYmd } from "../util/dates.js";
import { declineCookieBanner } from "./submit.js";
import { atAccountWall, passAccountWall } from "./account.js";
import { blockedReport, comparePages, emptyRequired, emptyRequiredFields, isClean, isReady, loadPlan, loadReport, pickNext, savePlan, saveReport, SIGN_IN_REASON, splitFailures, type Failure, type FieldReport, type Fill, type FillReport } from "./report.js";
import { buttonPoint, controlStates, dump, goto, inFront, inTurn, install, loadSession, pageFor, saveSession, settle, shownValues, trace, type Point } from "./session.js";

/** The text of a button that leads from a posting to its form. */
// A short label that starts with an apply verb: "Apply for this job", "Candidati per questo ruolo", "Candidarsi alla
// posizione", "Jetzt bewerben". Italian, German, French, Spanish, Portuguese and Dutch boards (Teamtailor, Personio,
// Breezy, Manatal, Recruitee) label it in the posting's language. Apply-with-LinkedIn and other autofill helpers are left alone.
// Some labels put the verb last ("Auf diese Stelle bewerben") or after a short lead-in ("Presenta candidatura per la
// posizione", "Invia la domanda di lavoro"), and HiBob names its form tab just "Application". SmartRecruiters says
// "I'm interested" in the posting's language ("Mi interessa", "Ich bin interessiert", "Me interesa").
const APPLY_BUTTON =
  "^\\s*(?!.*(linkedin|indeed|xing|google|facebook|seek|later|share|condividi))" +
  "((apply|start (your )?application|submit (your )?application|(continue|resume) (your |my )?application|(riprendi|continua) (la )?(tua )?candidatura|bewerbung fortsetzen|i'm interested|i am interested|" +
  "mi interessa|sono interessat[oa]|ich bin interessiert|je suis intéressée?|ça m'intéresse|me interesa|estoy interesad[oa]|tenho interesse|estou interessad[oa]|ik ben geïnteresseerd|" +
  "candidati|candidarsi|candidatati|candidatura|invia (la tua |la )?candidatura|invia (il tuo )?cv|inviaci il tuo cv|applica|" +
  "presenta (la )?(tua )?candidatura|invia (la )?(tua )?domanda|fai domanda|" +
  "bewerben|jetzt bewerben|postuler|aplicar|inscribirse|candidatar|solliciteer|prijavi se|aplikuj)\\b.{0,45}|" +
  "application|.{0,30}\\bbewerben|.{0,30}\\bbewirb dich( jetzt)?)\\s*$";

/**
 * The consent page some boards put between a posting and its form (Jobvite's "Application for Employment":
 * personal data for recruiting, "I Accept" / "I Decline"). It belongs to the application, like a required
 * privacy box, so it is accepted. A cookie banner never matches: its buttons say "accept all" or "accetta tutti".
 */
const APPLICATION_CONSENT = "^\\s*(i accept|i agree|accetto|acconsento|ich stimme zu|j'accepte)\\s*$";
const CONSENT_PAGE = /personal data|dati personali|personenbezogene|données personnelles/i;

/** The way into a form that reads the resume and fills the form from it, offered next to "Apply manually" (Workday). */
const RESUME_AUTOFILL = "^\\s*(autofill with (your )?(resume|cv)|upload (your )?(resume|cv) to apply|compila (automaticamente )?con (il )?(tuo )?(cv|curriculum)|candidati con (il )?(tuo )?cv|mit lebenslauf (automatisch )?ausfüllen|remplir (automatiquement )?avec (mon |votre )?cv|autocompletar con (tu )?(cv|currículum))\\s*$";

/** The site a host belongs to: its last two labels, three under a country's second level ("co.uk", "com.br"). */
const siteOfHost = (host: string) => {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  const n = parts.length >= 3 && /^(co|com|net|org|gov|ac|edu)$/.test(parts[parts.length - 2] ?? "") ? 3 : 2;
  return parts.slice(-n).join(".");
};
const hostOfUrl = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
/**
 * Where a step of opening the form may not go: a page on another site that is not an ATS (a job board, a social
 * sign-in, a home page). The posting's own site and every ATS are fine. Gives the host when the step leaves, or null.
 */
export function offSite(postingUrl: string, to: string): string | null {
  const from = hostOfUrl(postingUrl);
  const host = hostOfUrl(to);
  if (!host || !/^https?:/.test(to)) return to.split(":")[0] || "an unknown page";
  if (siteOfHost(host) === siteOfHost(from) || RUN.atsDomains.some((d) => hostIs(host, d))) return null;
  return host;
}
const leftTheBoard = (host: string) => new Error(`the Apply link leads off the board to ${host}: not followed`);

/** Lands on the page that holds the form: the URL itself, an embedded ATS frame, or behind an Apply button. */
async function openForm(page: Page, job: Job, resume?: string): Promise<FieldsDump> {
  await goto(page, applyUrlFor(job));
  return reachForm(page, job, resume, await dump(page));
}

/**
 * From the page the tab shows, on to the form: a cookie banner answered, a frame followed, an Apply button pressed. A
 * sign-in page stops it: the account is the account step's (account.ts), which then calls this again from where it left.
 */
async function reachForm(page: Page, job: Job, resume: string | undefined, d: FieldsDump): Promise<FieldsDump> {
  // A cookie banner over the Apply button takes its click, so it is answered first too.
  if (!isApplicationForm(d) || (await formFolded(page, d))) d = await declineCookies(page, d);
  let expanded = false;
  for (let hop = 0; hop < 4 && !d.hasPassword && (!isApplicationForm(d) || (await formFolded(page, d))); hop++) {
    // A form folded into sections ("Expand all sections" on SuccessFactors) is opened before anything is pressed: its
    // own Apply at the bottom sends the application, and is never pressed to bring up a form that is already here.
    if (!expanded && (expanded = await expandSections(page))) {
      d = await dump(page);
      trace(`open hop ${hop}: sections expanded, ${d.fields.length} fields, form=${isApplicationForm(d)}`);
      continue;
    }
    // A site that offers to read the resume into its form (Workday's "Autofill with Resume") is given it that way: the
    // form comes up filled from the file, its work history included.
    const autofill = await page.awj<Point>("clickByText", RESUME_AUTOFILL);
    const frame = autofill.ok ? undefined : d.frames[0];
    const consent = !frame && !autofill.ok && CONSENT_PAGE.test(await page.evaluate<string>("window.__awj.pageText()")) ? await page.awj<Point>("clickByText", APPLICATION_CONSENT) : null;
    if (autofill.ok) {
      const away = autofill.href ? offSite(applyUrlFor(job), autofill.href) : null;
      if (away) throw leftTheBoard(away);
      await page.click(autofill.x, autofill.y);
      await settle(page);
      await install(page);
    } else if (frame) {
      await goto(page, frame);
    } else if (consent?.ok) {
      await page.click(consent.x, consent.y);
      await settle(page);
      await install(page);
    } else {
      // The button is measured until it holds still: a cookie banner closing or a box unfolding moves it, and a click
      // on where it was lands on something else (SuccessFactors' company sites: the job-alert box under it).
      // A layer drawn over the page while it loads (SuccessFactors' company sites: "loading") takes the click: the
      // runner waits until the point reaches the button itself.
      let p = await page.awj<Point & { clear?: boolean }>("clickByText", APPLY_BUTTON, { content: true });
      for (let look = 0; p.ok && look < 24; look++) {
        await sleep(250);
        const again = await page.awj<Point & { clear?: boolean }>("clickByText", APPLY_BUTTON, { content: true });
        if (!again.ok) break;
        const still = Math.abs(again.x - p.x) < 2 && Math.abs(again.y - p.y) < 2;
        p = again;
        if (still && p.clear !== false) break;
      }
      if (p.ok && p.clear === false) trace("apply button: still covered by another layer, clicking anyway");
      if (!p.ok) break;
      if (p.href) {
        const away = offSite(applyUrlFor(job), p.href);
        if (away) throw leftTheBoard(away);
        // The link is clicked like a person would: some sites run their own step on the click (SuccessFactors' company
        // sites send a link opened directly back to their home page). A click that leaves this tab where it was (the
        // link opens a new tab) is made good by following the link in this tab; the other tab is closed with the job's.
        const was = await page.evaluate<string>("location.href");
        // In front, like a person's click: a tab behind another one does not run some sites' own step on the click.
        await inFront(page, () => page.click(p.x, p.y));
        await settle(page);
        // The click's own step can take a few seconds before the page moves (SuccessFactors' company sites go through
        // their apply page on to the sign-in): the link is followed by hand only when the tab really stayed.
        let now = await page.evaluate<string>("location.href").catch(() => was);
        for (const until = Date.now() + 8_000; now === was && Date.now() < until; ) {
          await sleep(400);
          now = await page.evaluate<string>("location.href").catch(() => was);
        }
        trace(`apply link: clicked at ${Math.round(p.x)},${Math.round(p.y)}, the tab ${now === was ? "stayed: following the link" : `moved to ${now.replace(/[?#].*/, "")}`}`);
        if (now !== was) await settle(page);
        if (now === was) await goto(page, p.href, was);
        else {
          const off = offSite(applyUrlFor(job), now);
          if (off) throw leftTheBoard(off);
          await install(page);
        }
      } else {
        await inFront(page, () => page.click(p.x, p.y));
        // A button that stays on the page (it opens a list of ways to apply) is not the one pressed next time.
        await page.awj("markPressed").catch(() => false);
        await settle(page);
        // A button can lead off the site too: the runner does not stay there.
        const away = offSite(applyUrlFor(job), await page.evaluate<string>("location.href"));
        if (away) throw leftTheBoard(away);
        await install(page);
        // A form that unfolds in place animates open; read it once it has stopped moving.
        await unfolded(page);
      }
    }
    d = await dump(page);
    trace(`open hop ${hop}: ${autofill.ok ? "resume autofill" : frame ? "frame" : consent?.ok ? "consent" : "apply button"}, ${d.fields.length} fields, form=${isApplicationForm(d)}`);
  }
  // A careers page that shows the job without the form: go to the board's own form for the same posting.
  const fallback = !isApplicationForm(d) && !d.hasPassword ? greenhouseFallbackUrl(job) : null;
  if (fallback) {
    await goto(page, fallback);
    d = await dump(page);
  }
  d = await declineCookies(page, d);
  if (!expanded && (await expandSections(page))) d = await dump(page);
  if (resume && !isApplicationForm(d) && d.fields.length === 1 && d.fields[0]?.kind === "file" && !(await formFolded(page, d))) d = await resumeFirst(page, d, resume);
  if (isApplicationForm(d) && (await page.awj<number>("exposeFileButtons")) > 0) d = await dump(page);
  return d;
}

/**
 * A form that asks for the resume before anything else (inRecruiting's "carica il CV per registrarti"): it reads
 * the file and only then shows its fields, filled from it. The candidate's resume is given and the form waited for.
 */
async function resumeFirst(page: Page, d: FieldsDump, resume: string): Promise<FieldsDump> {
  const box = d.fields[0];
  if (!box) return d;
  trace(`only a resume box on the page: uploading ${path.basename(resume)} to bring up the form`);
  if (await uploadFile(page, box.selector, resume)) return d;
  await page.call("function (s) { document.documentElement.setAttribute('data-awj-resume-given', s); }", box.selector);
  const deadline = Date.now() + BROWSER.settleMs;
  while (Date.now() < deadline) {
    await sleep(BROWSER.pollMs * 4);
    await install(page);
    const now = await dump(page);
    if (now.fields.length > d.fields.length && isApplicationForm(now)) {
      // The site is still writing what it read from the file into the form ("Importando i dati"). Anything typed
      // before it finishes is overwritten, so wait until the form has held still for a few looks in a row.
      let last = "";
      let still = 0;
      let settled = now;
      while (still < 4 && Date.now() < deadline) {
        await sleep(BROWSER.pollMs * 4);
        settled = await dump(page);
        const sig = settled.fields.map((f) => `${f.label}=${f.value}`).join("|") + (await page.evaluate<string>("window.__awj.pageText()")).length;
        still = sig === last ? still + 1 : 0;
        last = sig;
      }
      trace(`form brought up by the resume held still after ${Math.round((Date.now() - deadline + BROWSER.settleMs) / 100) / 10}s`);
      return settled;
    }
  }
  return dump(page);
}

/**
 * A form folded away under the posting until Apply is pressed (inRecruiting): its file box is in the dump,
 * since file boxes are always hidden, but the form around it takes no room on the page yet.
 */
async function formFolded(page: Page, d: FieldsDump): Promise<boolean> {
  const files = d.fields.filter((f) => f.kind === "file");
  if (!files.length || files.length < d.fields.length) return false;
  return page.evaluate<boolean>(
    `${JSON.stringify(files.map((f) => f.selector))}.every((s) => { const el = window.__awj.q(s); const box = el && (el.closest("form") || el.parentElement?.parentElement); return !!box && box.getBoundingClientRect().height === 0; })`,
  );
}

/** The button that opens every folded section of a form at once. */
const EXPAND_ALL =
  "^\\s*(expand all( sections)?|show all sections|espandi tutt[eoi]( le sezioni)?|mostra tutte le sezioni|alle (abschnitte )?(erweitern|aufklappen|einblenden)|" +
  "tout (développer|déplier)|développer toutes les sections|expandir todo|expandir todas las secciones)\\s*$";

/** Presses "Expand all sections" when the page has it, and waits for the sections to open. True when pressed. */
async function expandSections(page: Page): Promise<boolean> {
  const b = await page.awj<Point>("clickByText", EXPAND_ALL);
  if (!b.ok || b.href) return false;
  await inFront(page, () => page.click(b.x, b.y));
  await unfolded(page);
  await settle(page);
  await install(page);
  return true;
}

/** Waits until no element is mid-animation and the page's height stops changing, at most a few seconds. */
async function unfolded(page: Page): Promise<void> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await sleep(BROWSER.pollMs);
    const h = await page.evaluate<number>(`document.querySelector(".collapsing, .animating, [class*='-enter-active']") ? -2 : document.documentElement.scrollHeight`);
    if (h >= 0 && h === last) return;
    last = h;
  }
}

/**
 * A European cookie banner can sit over the form and keep its boxes from taking focus. It is answered
 * with its most private choice, as at Submit; never "accept all".
 */
async function declineCookies(page: Page, d: FieldsDump): Promise<FieldsDump> {
  if (!(await inFront(page, () => declineCookieBanner(page)))) return d;
  await settle(page);
  return dump(page);
}

/** A posting that sends the browser to the ATS vendor's own home page (Personio does) has been taken down. */
const removedPosting = (job: Job, url: string) => {
  try {
    const from = new URL(applyUrlFor(job));
    const to = new URL(url);
    return to.hostname !== from.hostname && to.pathname.replace(/\/+$/, "") === "" && from.pathname.length > 1;
  } catch {
    return false;
  }
};

/**
 * Opens a job's form in a tab of its own and fills its first page. A sign-in page, a page with no
 * form, or a posting that has closed comes back as blocked with the reason.
 */
export async function fillJob(jev: JevClient, profile: Profile, job: Job): Promise<FillReport> {
  const started = Date.now();
  await ensureBrowser();
  const old = loadSession()[job.id];
  // Opening a tab puts it in front, so it waits its turn behind any typing in another tab.
  const target = await inTurn(async () => {
    if (old) await closeTab(old.targetId);
    return newTab("about:blank");
  });
  // The tab is the job's from the start, so a form that fails to open still has its tab closed with the job.
  saveSession({ ...loadSession(), [job.id]: { targetId: target.id, url: "about:blank" } });
  const page = await Page.attach(target);
  const seconds = () => (Date.now() - started) / 1000;
  try {
    let d = await openForm(page, job, profile.resume.path);
    // A page that draws its form late and in parts (Workday after "Continue Application": the top boxes, the button, then
    // the rest) is read once it has fields and a button and has held still for two looks a second apart.
    for (let still = 0, until = Date.now() + BROWSER.settleMs; !d.hasPassword && Date.now() < until && (still < 2 || !d.fields.length || !d.submitSelectors.length); ) {
      await sleep(1_000);
      await install(page);
      const again = await dump(page);
      still = pageSignature(again) === pageSignature(d) ? still + 1 : 0;
      d = again;
    }
    trace(`${job.company}: form open ${Date.now() - started}ms, ${d.fields.length} fields`);
    // Read and written in one synchronous step, so jobs filled side by side do not overwrite each other.
    saveSession({ ...loadSession(), [job.id]: { targetId: target.id, url: d.url } });
    if (!isApplicationForm(d) && !d.hasPassword && !(await atAccountWall(page, d))) {
      // Job boards answer bursts with an error page. One unhurried second try settles most of them.
      const first = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      if (first.state === "error" || first.state === "other") {
        trace(`${job.company}: page looked like ${first.state}, retrying in ${BROWSER.retryAfterMs}ms`);
        await sleep(BROWSER.retryAfterMs);
        d = await openForm(page, job, profile.resume.path);
      }
    }
    // A sign-in or account page: the account kept for the site signs in, or one is made with the candidate's mailbox.
    // Twice at most: going back to the posting after an activation link meets the sign-in once more.
    // A sign-up form that is the application too keeps its password boxes, already typed by the account step.
    let signUpForm = false;
    for (let pass = 0; pass < 2 && (await atAccountWall(page, d)); pass++) {
      const passed = await passAccountWall(page, jev, profile, job, d);
      if (typeof passed === "string") return saveReport(blockedReport(job, `${SIGN_IN_REASON}: ${passed}`, d.url, seconds()));
      if ("signUpForm" in passed) {
        d = passed.signUpForm;
        signUpForm = true;
        break;
      }
      d = await reachForm(page, job, profile.resume.path, passed);
      saveSession({ ...loadSession(), [job.id]: { targetId: target.id, url: d.url } });
      trace(`${job.company}: past the account wall ${Date.now() - started}ms, ${d.fields.length} fields`);
    }
    if (d.hasPassword && !signUpForm) return saveReport(blockedReport(job, SIGN_IN_REASON, d.url, seconds()));
    if (!isApplicationForm(d) && removedPosting(job, d.url)) return saveReport(blockedReport(job, "no form found, page looks like: closed", d.url, seconds()));
    if (!isApplicationForm(d)) {
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      // A form the quick test does not know (a later page of a long form, opened again: Workday's "My Information" with
      // the email shown as text) is still a form when the page reads as one and has fields to fill.
      if (!(state.state === "application_form" && d.fields.length >= 2)) return saveReport(blockedReport(job, `no form found, page looks like: ${state.state}`, d.url, seconds()));
      trace(`${job.company}: the page reads as an application form: filling its ${d.fields.length} fields`);
    }
    return await fillPage(page, jev, profile, job, d, { page: 1, earlier: [], started });
  } finally {
    page.close();
  }
}

/**
 * A required section the form fills one entry at a time ("Experience *", an Add button, "Please provide at least one
 * work experience entry"). Its Add is pressed, the entry's own fields are read, mapped and filled from the profile like
 * any other, and the entry is kept with its own Save. One entry per section: the candidate's latest.
 */
async function addEntries(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump): Promise<FieldsDump> {
  for (let round = 0; round < FORM.maxEntrySections; round++) {
    const add = (await page.awj<(Point & { section: string })[]>("entryAdds"))[0];
    if (!add?.ok) break;
    const before = new Set(d.fields.map((f) => f.selector));
    await inFront(page, () => page.click(add.x, add.y));
    await sleep(BROWSER.pollMs * 4);
    await settle(page);
    const opened = await dump(page);
    const fresh = opened.fields.filter((f) => !before.has(f.selector));
    trace(`${job.company}: entry for "${add.section.slice(0, 50)}", ${fresh.length} field(s)`);
    const first = fresh[0];
    if (!first) return opened;
    const entry = { ...opened, fields: fresh };
    await readDropdownOptions(page, entry.fields);
    const plan = await mapForm(jev, profile, job, entry);
    trace(`${job.company}: entry plan: ${plan.fields.map((f) => `${f.label.slice(0, 20)}=${f.action}:${String(f.value ?? "").slice(0, 20)}`).join(" | ")}`);
    const unset = await applyFills(page, plan.fills, profile, guideFor(entry));
    if (unset.length) trace(`${job.company}: entry fields not set: ${unset.map((f) => f.why).join("; ").slice(0, 200)}`);
    // A suggestion list left open takes the first click as a click away from it, so lists are closed first, and the
    // Save is pressed once more when the entry is still open.
    for (let attempt = 0; attempt < 2; attempt++) {
      await inFront(page, async () => {
        await page.key("Escape");
        await page.evaluate("window.__awj.blur()");
      });
      const save = await page.awj<Point>("entrySave", first.selector);
      if (!save.ok) {
        trace(`${job.company}: the entry has no Save`);
        return dump(page);
      }
      await inFront(page, () => page.click(save.x, save.y));
      await sleep(BROWSER.pollMs * 4);
      await settle(page);
      d = await dump(page);
      if (!d.fields.some((f) => f.selector === first.selector)) break;
    }
    // An entry the form refused stays open with its fields: the page's own fill then sees them like any other.
    if (d.fields.some((f) => f.selector === first.selector)) {
      trace(`${job.company}: the entry did not save: ${(await page.evaluate<string[]>("window.__awj.errors()")).join(" | ").slice(0, 300)}`);
      return d;
    }
  }
  return d;
}

/** Fills the page the tab shows, from its dump, and reports what the page holds afterwards. */
async function fillPage(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, at: { page: number; earlier: FieldReport[]; started: number; jevCostUsd?: number }): Promise<FillReport> {
  d = await addEntries(page, jev, profile, job, d);
  await readDropdownOptions(page, d.fields);
  trace(`${job.company}: options read ${Date.now() - at.started}ms`);
  const plan = await mapForm(jev, profile, job, d);
  trace(`${job.company}: mapped ${Date.now() - at.started}ms`);
  // The resume goes in first: some boards (Lever) read it and write what they find into the form,
  // and the profile's values have to be the ones that stay.
  const uploaded = new Set<string>();
  const uploadFailures: Failure[] = [];
  for (const u of plan.uploads) {
    // A box that already took the resume to bring up the form keeps it: a second file would be read again and
    // written over the form, wiping the answers put in after it.
    if (await page.call<boolean>("function (s) { return document.documentElement.getAttribute('data-awj-resume-given') === s; }", u.selector)) {
      uploaded.add(u.selector);
      trace(`${job.company}: resume already given to bring up the form, not uploaded again`);
      continue;
    }
    const why = (await uploadFile(page, u.selector, u.path)) ?? null;
    if (!why) uploaded.add(u.selector);
    else uploadFailures.push({ selector: u.selector, why });
    trace(`${job.company}: upload ${why ?? "ok"}`);
  }
  const guide = guideFor(d);
  let failedRaw = await applyFills(page, plan.fills, profile, guide);
  trace(`${job.company}: filled ${Date.now() - at.started}ms`);
  // A page that finishes starting up after the fill can wipe what was typed, and a phone box throws a number away
  // until its own checker has loaded. Such values are put back after a short wait, then once more after a longer one.
  for (const [round, wait] of BROWSER.putBackAfterMs.entries()) {
    const wiped = plan.fills
      .filter((f) => TYPED_KINDS.has(f.kind) && failedRaw.some((x) => x.selector === f.selector))
      // A phone box that refused the bare number is given it with the country code: some only accept a number they can place in a country.
      .map((f) => (round > 0 && f.kind === "tel" && f.value === profile.phone.national ? { ...f, value: `${profile.phone.countryCode}${profile.phone.national}` } : f));
    if (!wiped.length) break;
    await sleep(wait);
    const still = await applyFills(page, wiped, profile, guide);
    failedRaw = [...failedRaw.filter((x) => !wiped.some((f) => f.selector === x.selector)), ...still];
    trace(`${job.company}: put back ${wiped.length - still.length} of ${wiped.length} wiped value(s) after ${wait}ms`);
  }
  // A start written in words that the box threw away means a date box with no format named: it gets the day the
  // words name as yyyy-mm-dd, which date boxes read one way only. A box left holding words it refuses stops the form
  // (Cornerstone: "Please enter a valid date" blocked Next on an optional field).
  for (const p of plan.fields.filter((x) => x.key === "earliest_start_date" && x.action === "fill" && TYPED_KINDS.has(x.kind) && !!x.value && !toYmd(x.value) && failedRaw.some((f) => f.selector === x.selector))) {
    const day = startDayOf(p.value!, new Date());
    if (!day) continue;
    const still = await applyFills(page, [{ selector: p.selector, kind: p.kind, value: day }], profile, guide);
    trace(`${job.company}: start date in words refused, typed ${day}: ${still.length ? still[0]!.why : "kept"}`);
    if (still.length) continue;
    failedRaw = failedRaw.filter((f) => f.selector !== p.selector);
    p.value = day;
    for (const f of plan.fills) if (f.selector === p.selector) f.value = day;
  }
  failedRaw = [...(await secondLook(page, jev, profile, job, d, plan, failedRaw)), ...uploadFailures];
  failedRaw = await followUp(page, jev, profile, job, d, plan, failedRaw);
  // A page read before its buttons were drawn (Workday draws "Save and Continue" last) is read again for them.
  if (!plan.submitSelectors.length) {
    await page.key("Escape").catch(() => undefined);
    const again = await dump(page);
    d.submitSelectors = again.submitSelectors;
    plan.submitSelectors = again.submitSelectors;
  }
  savePlan(job.id, d, plan);
  const read = await readBack(page, d, plan, failedRaw, uploaded, profile);
  guide.learn([...read.failed, ...read.leftBlank]);
  const partial = { jobId: job.id, company: job.company, title: job.title, ats: job.ats, ...read, takeHome: d.takeHome, page: at.page, earlier: at.earlier, hasNext: !!pickNext(plan.submitSelectors), seconds: (Date.now() - at.started) / 1000, jevCostUsd: (at.jevCostUsd ?? 0) + plan.jevCostUsd };
  return saveReport({ ...partial, ready: isReady(partial) });
}

/**
 * Some questions only appear once another is answered ("Are you willing to relocate?" after "No, I do
 * not live near the office"). After a fill the page is read again. Controls that moved get their new
 * selector, and controls that are new are mapped and filled like the rest. The dump and the plan are
 * updated in place, so every later step sees the page as it is.
 */
async function followUp(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, plan: FillPlan, failed: Failure[]): Promise<Failure[]> {
  let out = failed;
  for (let round = 0; round < FORM.followUpRounds; round++) {
    const now = await dump(page);
    const { moved, fresh } = comparePages(d, now);
    if (moved.size) {
      const to = (selector: string) => moved.get(selector) ?? selector;
      for (const list of [d.fields, plan.fields, plan.fills, plan.drafts, plan.reviews, plan.uploads, out]) for (const f of list) f.selector = to(f.selector);
    }
    // A look taken while a list is open over the form can miss its buttons; the ones known stay then.
    if (now.submitSelectors.length) {
      d.submitSelectors = now.submitSelectors;
      plan.submitSelectors = now.submitSelectors;
    }
    if (!fresh.length) break;
    trace(`${job.company}: ${fresh.length} new field(s) appeared: ${fresh.map((f) => f.label.slice(0, 30)).join(" | ")}`);
    // Ids are per read of the page, so the new fields get ids of their own.
    const added = fresh.map((f) => ({ ...f, id: `r${round}${f.id}` }));
    await readDropdownOptions(page, added);
    const more = await mapForm(jev, profile, job, { ...now, fields: added });
    const late = await applyFills(page, more.fills, profile, guideFor({ ...now, fields: added }));
    // A dropdown among them that refused its value gets the same second look as the first ones: its whole list, and JEV
    // chooses there ("Laurea triennale" against Workday's "Bachelor's Degree").
    out = [...out, ...(late.length ? await secondLook(page, jev, profile, job, { ...now, fields: added }, more, late) : late)];
    // A file box that appears once the resume is in (an upload widget redrawn around the file) is the same box: the
    // resume is not given twice. Any other new file box is given its file like the first ones.
    // Such a box is left out of the plan altogether: it is the first box, already read back with its file.
    const same = new Set<string>();
    for (const f of more.fields.filter((p) => p.action === "upload" && p.value)) {
      const given = await Promise.all(plan.uploads.map((u) => page.awj<boolean>("showsFile", path.basename(u.path))));
      if (f.key === "resume_upload" && given.some(Boolean)) {
        same.add(f.selector);
        trace(`${job.company}: a resume box came up after the upload; the page already holds the resume`);
        continue;
      }
      const why = await uploadFile(page, f.selector, f.value as string);
      if (why) out.push({ selector: f.selector, why });
      else plan.uploads.push({ selector: f.selector, path: f.value as string });
    }
    d.fields.push(...added.filter((f) => !same.has(f.selector)));
    plan.fields.push(...more.fields.filter((f) => !same.has(f.selector)));
    plan.fills.push(...more.fills);
    plan.drafts.push(...more.drafts);
    plan.reviews.push(...more.reviews);
    plan.jevCostUsd += more.jevCostUsd;
  }
  return out;
}

/**
 * What is known about this site's controls, for the fill step to use, and the notebook it writes
 * what it finds into. Kinds of controls are told apart by their signature, never by their label.
 */
function guideFor(d: FieldsDump): FillGuide & { learn: (unset: Failure[]) => void } {
  const notes = notesFor(d.url);
  const signature = new Map(d.fields.map((f) => [f.selector, signatureOf(f)]));
  const landed: Record<string, Method> = {};
  return {
    prefer: (selector) => notes.controls[signature.get(selector) ?? ""]?.method,
    landed: (selector, method) => {
      const s = signature.get(selector);
      if (s) landed[s] = method;
    },
    learn: (unset) => {
      const trouble: Record<string, string> = {};
      for (const f of unset) {
        const s = signature.get(f.selector);
        if (s && !(s in landed)) trouble[s] = f.why;
      }
      if (Object.keys(landed).length || Object.keys(trouble).length) learn(d.url, { landed, trouble });
    },
  };
}

/**
 * The controls a page holds, as one text: used to tell whether a click moved the form to another
 * page. Labels are left out, since a page that refuses to move on rewrites them with its complaints.
 */
const pageSignature = (d: FieldsDump) => `${d.url.split("#")[0]}\n${d.fields.map((f) => f.selector).join("\n")}\n${d.submitSelectors.map((s) => s.split("  /*")[0]).join("\n")}`;

/**
 * Moves a form whose current page is clean to its next page and fills that one. The page's own
 * Next button is clicked, once. If the form does not move, what the page says is reported and the
 * form is held. If the click turns out to have sent the application, the report says so.
 *
 * In a rehearsal the button is clicked only when JEV agrees that the form goes on, so that a
 * rehearsal does not send a form whose last button happens to be called Continue.
 */
export async function nextPage(jev: JevClient, profile: Profile, job: Job, opts: { dry: boolean }): Promise<FillReport> {
  const r = loadReport(job.id);
  const { dump: before, plan } = loadPlan(job.id);
  const next = pickNext(plan.submitSelectors);
  if (!next || !isClean(r)) return r;
  const started = Date.now();
  const hold = (reason: string): FillReport => saveReport({ ...r, ready: false, reason, stuck: reason, failed: [...r.failed, { selector: next.selector, label: next.text, why: reason }] });
  const page = await pageFor(job.id);
  try {
    if (opts.dry) {
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), r.url, job.id);
      if (state.hasMorePages < 0.5) return hold(`could not tell that "${next.text}" leads to another page and does not send the form, so the rehearsal stopped here`);
    }
    await page.writesSettled(BROWSER.saveMs);
    const was = pageSignature(before);
    await inFront(page, async () => {
      const p = await buttonPoint(page, next);
      if (!p.ok) throw new Error(`The "${next.text}" button is not on the page.`);
      await page.click(p.x, p.y);
    });
    // Wait for another page: other fields, or other buttons.
    const deadline = Date.now() + BROWSER.submitMs;
    let d = before;
    let moved = false;
    while (Date.now() < deadline && !moved) {
      await sleep(BROWSER.pollMs * 3);
      try {
        await install(page);
        d = await dump(page);
      } catch {
        continue; // mid-navigation
      }
      moved = pageSignature(d) !== was;
    }
    if (!moved) {
      const errors = await page.evaluate<string[]>("window.__awj.errors()");
      return hold(`the form did not move on after "${next.text}"${errors.length ? `: ${errors.slice(0, 3).join("; ").slice(0, 200)}` : ""}`);
    }
    await settle(page);
    await install(page);
    d = await dump(page);
    // A form that draws its next page in steps (Workday shows the old page's last box while the new one loads) is read
    // once its controls have stayed the same for two looks in a row.
    for (let still = 0, until = Date.now() + BROWSER.settleMs; still < 2 && Date.now() < until; ) {
      await sleep(1_000);
      try {
        await install(page);
        const again = await dump(page);
        still = pageSignature(again) === pageSignature(d) ? still + 1 : 0;
        d = again;
      } catch {
        still = 0; // mid-navigation
      }
    }
    const earlier = [...r.earlier, ...r.fields];
    const cost = r.jevCostUsd;
    if (d.hasPassword) return saveReport({ ...blockedReport(job, SIGN_IN_REASON, d.url), earlier, page: r.page + 1 });
    if (!d.fields.length && !d.submitSelectors.length) {
      // No form any more. Either the application went through, or the site showed something else.
      const state = await decidePageState(jev, await page.evaluate<string>("window.__awj.pageText()"), d.url, job.id);
      if (state.state === "submitted") return saveReport({ ...r, earlier, fields: [], page: r.page + 1, hasNext: false, ready: false, sent: true, reason: `"${next.text}" sent the application` });
      return saveReport({ ...blockedReport(job, `after "${next.text}" the page was: ${state.state}`, d.url), earlier, page: r.page + 1 });
    }
    trace(`${job.company}: page ${r.page + 1}, ${d.fields.length} fields`);
    return await fillPage(page, jev, profile, job, d, { page: r.page + 1, earlier, started, jevCostUsd: cost });
  } finally {
    page.close();
  }
}

/** True while a form should be taken to its next page: this page is clean, it has a Next, and the form has not run past the limit. */
export const shouldAdvance = (r: FillReport) => r.state === "filled" && !r.stuck && r.hasNext && isClean(r) && (r.resolution?.verdict ?? "ready") === "ready" && !r.sent && r.page < RUN.maxPages;

/**
 * Two retries before anything is handed to Claude.
 * A dropdown that refused the value JEV named gets its real options gathered, cut to the closest few, and JEV picks among those.
 * A search box whose starter suggestions held nothing for the candidate is asked again as a value to type.
 */
async function secondLook(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump, plan: FillPlan, failed: { selector: string; why: string }[]): Promise<{ selector: string; why: string }[]> {
  const again: DumpedField[] = [];
  for (const f of d.fields) {
    if (f.kind !== "combobox" && f.kind !== "select") continue;
    const planned = plan.fields.find((p) => p.selector === f.selector);
    if (!hasChoosableOptions(f) && failed.some((x) => x.selector === f.selector)) {
      const wanted = planned?.value ?? "";
      const pool = f.kind === "select" ? f.options : (await candidateOptions(page, f.selector, wanted)).map((o) => ({ value: o, label: o }));
      const keep = new Set(pool.length <= FORM.maxOptionsSecondLook ? pool.map((o) => o.label) : closestOptions(pool.map((o) => o.label), wanted, FORM.maxOptionsForJev));
      const options = pool.filter((o) => keep.has(o.label));
      if (options.length) again.push({ ...f, options, wholeList: true });
    } else if (f.kind === "combobox" && hasChoosableOptions(f) && planned && planned.action !== "fill" && /no option fits|left unselected/.test(planned.note ?? "")) {
      again.push({ ...f, options: [] });
    }
  }
  if (!again.length) return failed;
  const second = await mapForm(jev, profile, job, { ...d, fields: again });
  const stillFailed = await applyFills(page, second.fills, profile, guideFor(d));
  for (const p of second.fields) {
    const i = plan.fields.findIndex((x) => x.selector === p.selector);
    const first = plan.fields[i];
    // A second answer replaces the first only when it produced a value.
    if (first && (p.action === "fill" || first.action === "fill")) plan.fields[i] = { ...p, id: first.id, note: p.note ?? "settled on a second look" };
  }
  const settled = new Set(second.fills.map((f) => f.selector));
  plan.reviews = [...plan.reviews.filter((r) => !settled.has(r.selector)), ...second.reviews.filter((r) => !plan.reviews.some((x) => x.selector === r.selector))];
  plan.jevCostUsd += second.jevCostUsd;
  trace(`${job.company}: second look at ${again.length} dropdown(s), ${second.fills.length - stillFailed.length} settled`);
  // A dropdown the second look could not settle either goes to Claude with its closest options attached.
  for (const f of again) {
    if (settled.has(f.selector) && !stillFailed.some((x) => x.selector === f.selector)) continue;
    if (!plan.reviews.some((r) => r.selector === f.selector)) plan.reviews.push({ id: f.id, selector: f.selector, kind: f.kind, label: f.label, options: f.options.map((o) => o.label), why: "no option matched the profile value" });
  }
  return [...failed.filter((f) => !settled.has(f.selector)), ...stillFailed];
}

/** Reads the page back against the plan: what each field shows, what did not land, what is still empty. */
async function readBack(page: Page, d: FieldsDump, plan: FillPlan, failedRaw: Failure[], uploaded = new Set<string>(), profile?: Profile): Promise<Pick<FillReport, "url" | "state" | "reason" | "fields" | "drafts" | "reviews" | "failed" | "leftBlank" | "missingRequired">> {
  const shown = await shownValues(page, plan.fields.map((f) => f.selector));
  // A board can redraw its upload control once the file is in (HiBob), so the file's name on the page counts too.
  const onPage = await Promise.all(plan.fields.map((f) => (f.action === "upload" && f.value ? page.awj<boolean>("showsFile", path.basename(f.value)) : Promise.resolve(false))));
  const fields = plan.fields.map((f, i) => ({ label: f.label, required: f.required, action: f.action, shown: uploaded.has(f.selector) || onPage[i] ? path.basename(f.value ?? "") : shown[i] ?? "", note: f.note }));
  const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
  // The last line of defence: a value the plan wanted that the page does not show is a failure, whatever happened on the way.
  const states = await controlStates(page, plan.fields.map((f) => f.selector));
  const failed = [...failedRaw];
  // An address panel writes the place in its own words ("70121 Bari BA, Italia"); any address it shows is its answer.
  const isPanelField = (selector: string) => d.fields.some((x) => x.selector === selector && x.widget === "panel");
  plan.fields.forEach((f, i) => {
    if (states[i] === "off" || failed.some((x) => x.selector === f.selector)) return;
    const shownNow = fields[i]?.shown ?? "";
    if ((f.action === "fill" || f.action === "upload") && !shownNow) {
      failed.push({ selector: f.selector, why: states[i] === "missing" ? "the control is no longer on the page" : "the value is not confirmed on the page" });
    } else if (f.action === "fill" && f.value && (TYPED_KINDS.has(f.kind) || f.kind === "combobox") && !isPanelField(f.selector) && !showsValue(f.value, shownNow) && !provinceForRegion(f.value, shownNow, profile)) {
      failed.push({ selector: f.selector, why: `the box shows "${shownNow.slice(0, 40)}" instead of "${f.value.slice(0, 40)}"` });
    }
  });
  const { holds, leftBlank } = splitFailures(plan, failed, fields.map((f) => f.shown));
  return {
    url: plan.url,
    state: "filled",
    reason: null,
    fields,
    drafts: plan.drafts,
    reviews: plan.reviews,
    failed: holds.map((f) => ({ ...f, label: labelOf(f.selector) })),
    leftBlank: leftBlank.map((f) => ({ ...f, label: labelOf(f.selector) })),
    missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
  };
}

/**
 * Hands every field still open on a filled form to Claude, writes its answers into the page,
 * reads them back, and records whether the form is now ready to submit.
 */
export async function resolveJob(profile: Profile, entry: QueueEntry | null, jobId: string, opts: { jev?: JevClient; fresh?: boolean } = {}): Promise<FillReport> {
  const r = loadReport(jobId);
  if (r.state !== "filled" || r.stuck || isClean(r)) return r;
  const { dump: d, plan } = loadPlan(jobId);
  // Each page of a form has its own place in the answer memory.
  const memoryKey = r.page > 1 ? `${jobId}#p${r.page}` : jobId;
  const page = await pageFor(jobId);
  try {
    const dumped = (selector: string) => d.fields.find((f) => f.selector === selector);
    const open = new Map<string, OpenField>();
    const add = (selector: string, why: string) => {
      const f = dumped(selector);
      if (f && !open.has(selector)) open.set(selector, { selector, kind: f.kind, label: f.label, question: f.kind === "checkbox" || f.kind === "radio" ? f.section : "", hint: f.hint || f.placeholder, required: f.required, maxLength: f.maxLength, options: f.options.map((o) => o.label), why });
    };
    for (const x of plan.drafts) add(x.selector, `needs writing (${x.intent})`);
    for (const x of plan.reviews) {
      add(x.selector, x.why);
      // A review can carry options gathered after the dump, on the second look.
      const o = open.get(x.selector);
      if (o && !o.options.length && x.options.length) o.options = x.options;
    }
    // A file that did not upload is not something Claude can answer; it stays a failure.
    for (const x of [...r.failed, ...(r.leftBlank ?? [])]) if (dumped(x.selector)?.kind !== "file") add(x.selector, x.why);
    const before = await shownValues(page, plan.fields.map((f) => f.selector));
    const statesBefore = await controlStates(page, plan.fields.map((f) => f.selector));
    for (const f of emptyRequiredFields(d, plan, before, statesBefore)) add(f.selector, "required and still empty");
    // An option is shown with its question, so Claude can see which choice a group already holds.
    const withQuestion = (selector: string, label: string) => {
      const f = dumped(selector);
      return f && (f.kind === "checkbox" || f.kind === "radio") && f.section && f.section !== label ? `${f.section} / ${label}` : label;
    };
    const filled = plan.fields.map((f, i) => ({ label: withQuestion(f.selector, f.label), value: before[i] ?? "" })).filter((f) => f.value && f.label);
    const openFields = [...open.values()];
    const company = entry?.job.company ?? r.company;
    const fingerprint = contextFingerprint(profile);
    const useMemory = MEMORY.enabled && !opts.fresh;
    const mem = useMemory ? loadMemory() : null;
    // The same form with the same open fields was resolved before: what was read then is what goes in now.
    const remembered = mem ? recallForm(mem, memoryKey, fingerprint, openFields) : null;
    // Read again only when every answer it holds still fits its list.
    const sameForm = remembered && remembered.answers.every((a) => { const f = open.get(a.selector); return !f || fitsOptions(f, a.value); }) ? remembered : null;
    let recalled = new Map<string, Recalled>();
    let resolution: Resolution;
    if (sameForm) {
      resolution = sameForm;
      recalled = new Map(sameForm.answers.map((a) => [a.selector, { value: a.value, reusable: a.reusable, source: "same form", from: company }]));
    } else {
      if (mem) {
        recalled = recallSameFields(mem, memoryKey, fingerprint, openFields);
        for (const [selector, hit] of recallExact(mem, fingerprint, company, openFields.filter((f) => !recalled.has(f.selector)))) recalled.set(selector, hit);
        const rest = openFields.filter((f) => !recalled.has(f.selector));
        if (opts.jev && rest.length) {
          // A question worded another way: JEV says whether it is the same question. If it cannot be asked, Claude answers as before.
          const similar = await recallSimilar(opts.jev, mem, fingerprint, company, rest, `same-question:${jobId}`).catch(() => new Map<string, Recalled>());
          for (const [selector, hit] of similar) recalled.set(selector, hit);
        }
      }
      // An answer remembered from another form is kept for a list only when this list has it ("Corporate Website" from one
      // company's "How did you hear about us?" is not among the next company's options).
      for (const f of openFields) {
        const hit = recalled.get(f.selector);
        if (hit && !fitsOptions(f, hit.value)) recalled.delete(f.selector);
      }
      const rest = openFields.filter((f) => !recalled.has(f.selector));
      const settled = openFields.filter((f) => recalled.has(f.selector) && f.kind !== "checkbox").map((f) => ({ label: withQuestion(f.selector, f.label), value: recalled.get(f.selector)?.value ?? "" }));
      const fresh = await resolveOpenFields(profile, entry, [...filled, ...settled], rest);
      resolution = { ...fresh, answers: [...[...recalled].map(([selector, hit]) => ({ selector, value: hit.value, reusable: hit.reusable })), ...fresh.answers] };
      // The sheet note written for this posting last time is kept when Claude is not asked again.
      const prior = mem?.forms[memoryKey];
      if (!resolution.note && prior?.fingerprint === fingerprint && prior.resolution.note) resolution.note = prior.resolution.note;
    }
    const fills = resolution.answers
      .map((a) => ({ selector: a.selector, kind: open.get(a.selector)?.kind ?? "text", value: a.value }))
      .filter((f) => !(f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)));
    let failedRaw: Failure[] = [...(await applyFills(page, fills, profile, guideFor(d))), ...r.failed.filter((x) => dumped(x.selector)?.kind === "file").map(({ selector, why }) => ({ selector, why }))];
    // An answer Claude gave may have brought up a further question. JEV fills what it can of those; what it cannot is open on the next look.
    if (opts.jev && entry) {
      const fieldsBefore = plan.fields.length;
      failedRaw = await followUp(page, opts.jev, profile, entry.job as unknown as Job, d, plan, failedRaw);
      if (plan.fields.length > fieldsBefore) savePlan(jobId, d, plan);
    }
    const after = await shownValues(page, plan.fields.map((f) => f.selector));
    const states = await controlStates(page, plan.fields.map((f) => f.selector));
    const answered = new Set(resolution.answers.map((a) => a.selector));
    const stillRequired = new Set(emptyRequiredFields(d, plan, after, states).map((f) => f.selector));
    const labelOf = (selector: string) => plan.fields.find((f) => f.selector === selector)?.label ?? selector;
    const fields = plan.fields.map((f, i) => {
      const was = r.fields[i];
      const shown = was?.action === "upload" && was.shown ? was.shown : after[i] ?? "";
      return { label: f.label, required: f.required, action: recalled.has(f.selector) ? "memory" : answered.has(f.selector) ? "claude" : f.action, shown, note: f.note };
    });
    if (mem && !sameForm) {
      const landed = (selector: string) => !!after[plan.fields.findIndex((f) => f.selector === selector)];
      saveMemory(remember(loadMemory(), { jobId: memoryKey, company, fingerprint, open: openFields, resolution, landed, recalled: new Set(recalled.keys()) }));
    }
    const { holds, leftBlank } = splitFailures(
      plan,
      [
        ...failedRaw,
        // Anything the plan or Claude wanted in the form that the page does not show.
        ...plan.fields.filter((f, i) => (f.action === "fill" || f.action === "upload" || fills.some((x) => x.selector === f.selector)) && !fields[i]?.shown && states[i] !== "off" && !failedRaw.some((x) => x.selector === f.selector)).map((f) => ({ selector: f.selector, why: "the value is not confirmed on the page" })),
      ],
      fields.map((f) => f.shown),
    );
    const next: Omit<FillReport, "ready"> = {
      ...r,
      fields,
      // An open question Claude chose to leave blank is settled too, unless it is required and still empty.
      drafts: plan.drafts.filter((x) => stillRequired.has(x.selector)),
      // An open field Claude chose to leave blank is settled, unless it is still a required field with nothing in it.
      reviews: plan.reviews.filter((x) => stillRequired.has(x.selector)),
      failed: holds.map((f) => ({ ...f, label: labelOf(f.selector) })),
      leftBlank: leftBlank.map((f) => ({ ...f, label: labelOf(f.selector) })),
      missingRequired: emptyRequired(d, plan, fields.map((f) => f.shown), states),
      resolution,
      recalled: recalled.size,
      writerCalled: !sameForm && openFields.some((f) => !recalled.has(f.selector)),
    };
    // A verdict other than ready holds the page whatever it shows: it is recorded as a review the person has to settle.
    const held = resolution.verdict === "ready" ? next : { ...next, reason: resolution.reason || next.reason };
    return saveReport({ ...held, ready: resolution.verdict === "ready" && isReady(held) });
  } finally {
    page.close();
  }
}

/** Writes extra values (Claude's drafts and review decisions) into a form that fill already opened. */
export async function setValues(profile: Profile, jobId: string, fills: Fill[]): Promise<{ failed: { selector: string; why: string }[]; shown: Record<string, string> }> {
  const page = await pageFor(jobId);
  try {
    const failed = await applyFills(page, fills, profile);
    const values = await shownValues(page, fills.map((f) => f.selector));
    return { failed, shown: Object.fromEntries(fills.map((f, i) => [f.selector, values[i] ?? ""])) };
  } finally {
    page.close();
  }
}

/** Reads the current state of an already-filled form: every planned field with what the page shows now. */
export async function inspect(jobId: string): Promise<{ fields: FieldReport[]; errors: string[] }> {
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = loadPlan(jobId);
    const r = await readBack(page, d, plan, []);
    return { fields: r.fields, errors: await page.evaluate<string[]>("window.__awj.errors()") };
  } finally {
    page.close();
  }
}

/** True when a value suits an open field: any value for a field with no list, one of the list's options otherwise. */
function fitsOptions(f: OpenField, value: string): boolean {
  if (!f.options.length || f.kind === "checkbox") return true;
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return f.options.some((o) => n(o) === n(value));
}
