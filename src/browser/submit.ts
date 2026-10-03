/**
 * Sending a form, and reading what the page became. A form is sent only when
 * its report says ready and its required fields are read once more as filled.
 * An application counts only when the page after the click is a confirmation.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BROWSER } from "../config.js";
import { decidePageState, type AfterSubmit, type PageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import { sleep, type Page } from "./cdp.js";
import { emptyRequired, loadPlan, loadReport, pickSubmit } from "./report.js";
import type { FillPlan } from "../forms/fields.js";
import { controlStates, dump, inFront, install, pageFor, shownValues, type Point } from "./session.js";

const run = promisify(exec);

/** Clicks the form's Submit control and reports what the page became. */
export async function submitJob(jev: JevClient, jobId: string, force = false): Promise<{ state: PageState["state"]; confidence: number; url: string; errors: string[]; needsCode: boolean; humanCheck: boolean; refused: boolean; excerpt: string }> {
  const r = loadReport(jobId);
  if (!r.ready && !force) throw new Error(`not ready to submit: ${r.resolution?.reason || [...r.missingRequired.map((l) => `empty: ${l.slice(0, 50)}`), ...r.failed.map((f) => `failed: ${f.label.slice(0, 50)}`), ...r.reviews.map((x) => `review: ${x.label.slice(0, 50)}`), ...r.drafts.map((x) => `draft: ${x.label.slice(0, 50)}`)].join("; ") || r.reason}`);
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = loadPlan(jobId);
    const pick = pickSubmit(plan.submitSelectors);
    if (!pick) throw new Error("No submit control in the plan.");
    if (!force) {
      // A question may have appeared since the page was read, or the tool may never have seen one. The whole page is
      // read afresh, and any required control on it that shows nothing stops the click.
      const now = await dump(page);
      const all = now.fields.filter((f) => f.kind !== "file");
      const asPlan = { fields: all.map((f) => ({ selector: f.selector, kind: f.kind, label: f.label, required: f.required, action: "fill" })) } as unknown as FillPlan;
      const unseen = emptyRequired(now, asPlan, await shownValues(page, all.map((f) => f.selector)), await controlStates(page, all.map((f) => f.selector))).map((l) => l.slice(0, 50));
      if (unseen.length) throw new Error(`not ready to submit, required fields are empty on the page: ${unseen.join("; ")}`);
      // The report says ready, but the page is what gets submitted: read the required fields once more.
      const selectors = plan.fields.map((f) => f.selector);
      const empty = emptyRequired(d, plan, await shownValues(page, selectors), await controlStates(page, selectors)).map((l) => l.slice(0, 50));
      if (empty.length) throw new Error(`not ready to submit, required fields are empty on the page: ${empty.join("; ")}`);
    }
    await page.writesSettled(BROWSER.saveMs);
    const before = await page.evaluate<string>("window.__awj.pageText()");
    const controlsBefore = await page.evaluate<number>("window.__awj.shownControls()");
    // Signals a board confirms with outside its words (the address, a shown part named for success, the form gone).
    const afterSubmit = async (): Promise<AfterSubmit> => ({ signals: await page.evaluate<string[]>("window.__awj.successSignals()"), controlsBefore, controlsNow: await page.evaluate<number>("window.__awj.shownControls()") });
    // Other forms may be filling in their own tabs. The click takes its turn for the front of the window.
    await inFront(page, async () => {
      // A cookie banner still open (one that came up late) is answered before the click, with its most private choice.
      await declineCookieBanner(page);
      let p = await page.awj<Point>("point", pick.selector);
      if (!p.ok) throw new Error(`Submit control ${pick.selector} is not on the page.`);
      // A cookie banner over the button would take the click. It is answered with its most private choice
      // (necessary cookies only), never with "accept all". If the button is still covered, it is pressed from script.
      if (await page.awj<string>("coveredBy", pick.selector)) {
        const decline = await page.awj<Point>("clickByText", DECLINE_COOKIES);
        if (decline.ok) {
          await page.click(decline.x, decline.y);
          await sleep(BROWSER.pollMs * 3);
          p = await page.awj<Point>("point", pick.selector);
        }
      }
      if (await page.awj<string>("coveredBy", pick.selector)) await page.awj<boolean>("press", pick.selector);
      else await page.click(p.x, p.y);
    });
    const clickedAt = new Date(Date.now() - 60_000);
    const deadline = Date.now() + BROWSER.submitMs;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(BROWSER.pollMs * 3);
      try {
        await install(page);
        after = await page.evaluate<string>("window.__awj.pageText()");
      } catch {
        continue; // mid-navigation
      }
      if (after !== before && after.length > 0) break;
    }
    await sleep(BROWSER.pollMs * 6);
    await install(page);
    after = await page.evaluate<string>("window.__awj.pageText()");
    const url = await page.evaluate<string>("location.href");
    let state = await decidePageState(jev, after, url, jobId, await afterSubmit());
    let errors = await page.evaluate<string[]>("window.__awj.errors()");
    // Still the form, and the page reports nothing wrong: the board may only be slow to confirm. Wait for the page to change once more, then look again.
    if (state.state !== "submitted" && !errors.length && !SECURITY_CODE.test(after)) {
      const settled = after;
      const until = Date.now() + BROWSER.confirmMs;
      while (Date.now() < until && after === settled) {
        await sleep(BROWSER.pollMs * 6);
        try {
          await install(page);
          after = await page.evaluate<string>("window.__awj.pageText()");
        } catch {
          continue; // mid-navigation
        }
      }
      if (after !== settled) {
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await page.evaluate<string[]>("window.__awj.errors()");
      }
    }
    // The page never changed at all and names no error: the click came before the form was ready to send (Ashby
    // ignored a Submit pressed seconds after the uploads). The button is pressed once more and the page read again.
    if (state.state !== "submitted" && !errors.length && after === before) {
      const again = await page.awj<Point>("point", pick.selector);
      if (again.ok) {
        console.log("  the page did not change after Submit: pressing it once more");
        await inFront(page, () => page.click(again.x, again.y));
        const until = Date.now() + BROWSER.submitMs + BROWSER.confirmMs;
        while (Date.now() < until && after === before) {
          await sleep(BROWSER.pollMs * 6);
          try {
            await install(page);
            after = await page.evaluate<string>("window.__awj.pageText()");
          } catch {
            continue; // mid-navigation
          }
        }
        await sleep(BROWSER.pollMs * 6);
        await install(page);
        after = await page.evaluate<string>("window.__awj.pageText()");
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await page.evaluate<string[]>("window.__awj.errors()");
      }
    }
    // A board that emails a code: with CODE_COMMAND set, the code is read from the person's mailbox and typed in.
    if (state.state !== "submitted" && SECURITY_CODE.test(after) && process.env.CODE_COMMAND) {
      const code = await mailedCode(process.env.CODE_COMMAND, { url: r.url, company: r.company, since: clickedAt });
      const boxes = code ? await page.evaluate<number>("window.__awj.codeBoxes()") : 0;
      console.log(`  emailed code: ${code ? "found" : "not found"}, ${boxes} box(es)`);
      if (code && boxes) {
        await inFront(page, async () => {
          for (let i = 0; i < (boxes > 1 ? Math.min(boxes, code.length) : 1); i++) {
            const b = await page.awj<Point>("point", `[data-awj-code="${i}"]`);
            if (!b.ok) break;
            await page.click(b.x, b.y);
            await page.typeKeys(boxes > 1 ? code[i]! : code);
          }
          await sleep(BROWSER.pollMs * 3);
          const again = await page.awj<Point>("point", pick.selector);
          const go = again.ok ? again : await page.awj<Point>("clickByText", "^\\s*(submit|verify|confirm|continue|invia|verifica|conferma|continua)\\b");
          if (go.ok) await page.click(go.x, go.y);
        });
        const typed = after;
        const until = Date.now() + BROWSER.submitMs + BROWSER.confirmMs;
        while (Date.now() < until && after === typed) {
          await sleep(BROWSER.pollMs * 6);
          try {
            await install(page);
            after = await page.evaluate<string>("window.__awj.pageText()");
          } catch {
            continue; // mid-navigation
          }
        }
        await sleep(BROWSER.pollMs * 6);
        await install(page);
        after = await page.evaluate<string>("window.__awj.pageText()");
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await page.evaluate<string[]>("window.__awj.errors()");
      }
    }
    const notSent = state.state !== "submitted";
    return { state: state.state, confidence: state.confidence, url: await page.evaluate<string>("location.href"), errors, needsCode: notSent && SECURITY_CODE.test(after), humanCheck: notSent && !SECURITY_CODE.test(after) && HUMAN_CHECK.test(after), refused: notSent && ALREADY_APPLIED.test(after), excerpt: after.replace(/\s+/g, " ").slice(-400) };
  } finally {
    page.close();
  }
}

/**
 * Runs the person's CODE_COMMAND to read a code a board just emailed. The command may use {url}, {company} and
 * {since} (ISO time); it prints a JSON line with "code", or nothing. Returns the code, or "" when none came.
 */
async function mailedCode(command: string, job: { url: string; company: string; since: Date }): Promise<string> {
  const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
  const cmd = command.replace(/\{url\}/g, quote(job.url)).replace(/\{company\}/g, quote(job.company)).replace(/\{since\}/g, job.since.toISOString());
  try {
    const { stdout } = await run(cmd, { timeout: BROWSER.codeWaitMs, windowsHide: true });
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const v = JSON.parse(line) as { code?: unknown };
        if (typeof v.code === "string" && v.code.trim()) return v.code.trim();
      } catch {
        /* not the JSON line */
      }
    }
  } catch (err) {
    console.log(`  CODE_COMMAND failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 160)}`);
  }
  return "";
}

/** The choice on a cookie banner that allows the least. */
export const DECLINE_COOKIES =
  "^\\s*(necessary only|only necessary|necessary cookies only|use necessary cookies only|reject all|reject|decline|decline all|refuse|deny|" +
  "(decline|reject|refuse|deny|rifiuta|nega|ablehnen|refuser|rechazar)\\b.{0,30}\\b(non[- ]?(necessary|essential)|optional|unnecessary|non (necessari|essenziali)|facoltativi|opzionali|nicht notwendige?n?|non essentiels|no necesarias)( cookies?)?|" +
  "rifiuta|rifiuta tutto|rifiuta tutti|rifiuta i cookie|solo necessari|solo cookie necessari|richiesto solo|solo richiesti|solo essenziali|samo nužni|samo nužni kolačići|accetta solo (i )?(cookie )?necessari|continua senza accettare|non accetto|non accettare|nega|" +
  "alle ablehnen|ablehnen|nur notwendige|tout refuser|refuser|continuer sans accepter|rechazar todo|rechazar)\\s*$";

/** The button of a cookie banner that opens its settings, for a banner whose first layer offers only "accept all". */
const COOKIE_SETTINGS =
  "^\\s*(cookie settings|cookies settings|cookie preferences|manage (cookies|cookie preferences|preferences|settings)|customi[sz]e( cookies)?|more options|" +
  "impostazioni( dei)? cookie|personalizza|gestisci (le )?preferenze|preferenze( dei)? cookie|cookie-einstellungen|einstellungen|paramètres( des cookies)?|personnaliser|configurar( cookies)?|personalizar)\\s*$";
/** In a cookie banner's settings, the button that saves the choices as they stand: only the necessary cookies are on. */
const SAVE_COOKIE_CHOICES =
  "^\\s*(confirm my choices|save (my )?(settings|choices|preferences)|salva (le )?(impostazioni|preferenze|scelte)|conferma (le )?(mie )?scelte|auswahl (speichern|bestätigen)|einstellungen speichern|enregistrer( mes choix)?|guardar( configuración)?)\\s*$";

/**
 * Answers a cookie banner with its most private choice, never "accept all". A banner whose first layer has no such
 * choice (Usercentrics: "Cookie settings" and "Accept all cookies") is opened at its settings, where "Deny optional
 * cookies" or saving the untouched choices is. Returns whether a banner was answered.
 */
export async function declineCookieBanner(page: Page): Promise<boolean> {
  const press = async (pattern: string): Promise<boolean> => {
    const b = await page.awj<Point>("clickByText", pattern);
    if (!b.ok || b.href) return false;
    await page.click(b.x, b.y);
    await sleep(BROWSER.pollMs * 4);
    return true;
  };
  if (await press(DECLINE_COOKIES)) return true;
  if (!(await press(COOKIE_SETTINGS))) return false;
  return (await press(DECLINE_COOKIES)) || (await press(SAVE_COOKIE_CHOICES));
}

/** A board that refuses a second application from the same person for now. The job is skipped, not held. */
export const ALREADY_APPLIED = /recently applied for another role|unable to accept an additional application|already (applied|submitted an application)/i;

/** A page that asks the person to prove they are not a robot (BambooHR after Submit). Only the person can pass it. */
export const HUMAN_CHECK = /not a robot|i am human|i'm human|captcha|human check/i;

/** A board that emails a code to confirm a person is applying. Only the person can enter it. */
export const SECURITY_CODE = /verification code was sent|enter the \S+ code|security code/i;

/**
 * Reads the page a job's tab shows now, without clicking anything. This is how an application is
 * recorded after the person finished it by hand: a human check, an emailed code, a field they fixed.
 */
export async function checkJob(jev: JevClient, jobId: string): Promise<{ state: PageState["state"]; confidence: number; url: string; needsCode: boolean; excerpt: string }> {
  const page = await pageFor(jobId);
  try {
    await install(page);
    const text = await page.evaluate<string>("window.__awj.pageText()");
    const url = await page.evaluate<string>("location.href");
    const state = await decidePageState(jev, text, url, jobId);
    return { state: state.state, confidence: state.confidence, url, needsCode: state.state !== "submitted" && SECURITY_CODE.test(text), excerpt: text.replace(/\s+/g, " ").slice(-300) };
  } finally {
    page.close();
  }
}

/**
 * Brings a job's tab to the front and watches it while the person finishes the form by hand (a
 * code to type, a human check). Nothing is typed or clicked. The page is judged only when its
 * text changes. Returns "submitted" on a confirmation, "gave_up" when `stop` says so or time runs out.
 */
export async function watchForConfirmation(jev: JevClient, jobId: string, opts: { timeoutMs: number; stop?: () => boolean }): Promise<"submitted" | "gave_up"> {
  const page = await pageFor(jobId);
  try {
    await page.bringToFront();
    const deadline = Date.now() + opts.timeoutMs;
    let last = "";
    while (Date.now() < deadline && !opts.stop?.()) {
      await sleep(BROWSER.pollMs * 6);
      let text: string;
      try {
        await install(page);
        text = await page.evaluate<string>("window.__awj.pageText()");
      } catch {
        continue; // mid-navigation
      }
      if (text === last) continue;
      last = text;
      // The form with its code box or robot check still showing is not worth a judgement.
      if (SECURITY_CODE.test(text) || HUMAN_CHECK.test(text)) continue;
      const state = await decidePageState(jev, text, await page.evaluate<string>("location.href"), jobId);
      if (state.state === "submitted") return "submitted";
    }
    return "gave_up";
  } finally {
    page.close();
  }
}
