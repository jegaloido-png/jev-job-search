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
import { openPrivacyNotice } from "./account.js";
import { sleep, type Page } from "./cdp.js";
import { emptyRequired, loadPlan, loadReport, pickSubmit } from "./report.js";
import type { FillPlan } from "../forms/fields.js";

/** Runs in the page: for each error mark shown, the words of the small box around it (its field), shadow roots included. */
// A visible challenge frame of a known bot check, big enough to be a puzzle a person has to solve.
const CHALLENGE_SHOWN = `[...document.querySelectorAll("iframe")].some((f) => { const b = f.getBoundingClientRect(); const s = f.src || ""; return b.width > 200 && b.height > 200 && getComputedStyle(f).visibility !== "hidden" && /hcaptcha|recaptcha|turnstile|challenges\\.cloudflare|arkoselabs|funcaptcha/i.test(s); })`;
const ERROR_PLACES = `(() => {
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const marks = all.filter((el) => (el.matches('[aria-invalid="true"], [role=alert], [class*="error" i], [class*="invalid" i], [value-state="Error"]')) && (el.offsetWidth || el.offsetHeight));
  const out = [];
  for (const m of marks) {
    let box = m;
    for (let i = 0; i < 4 && box.parentElement && (box.parentElement.innerText || "").length < 220; i++) box = box.parentElement;
    const t = (box.innerText || box.getAttribute("aria-label") || box.tagName).replace(/\\s+/g, " ").trim().slice(0, 110);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 8).join(" || ");
})()`;
import { buttonPoint, controlStates, dump, inFront, install, pageFor, shownValues, trace, type Point } from "./session.js";

const run = promisify(exec);

/** Clicks the form's Submit control and reports what the page became. */
export async function submitJob(jev: JevClient, jobId: string, force = false): Promise<{ state: PageState["state"]; confidence: number; url: string; errors: string[]; needsCode: boolean; humanCheck: boolean; refused: boolean; ineligible: boolean; excerpt: string }> {
  const r = loadReport(jobId);
  if (!r.ready && !force) throw new Error(`not ready to submit: ${r.resolution?.reason || [...r.missingRequired.map((l) => `empty: ${l.slice(0, 50)}`), ...r.failed.map((f) => `failed: ${f.label.slice(0, 50)}`), ...r.reviews.map((x) => `review: ${x.label.slice(0, 50)}`), ...r.drafts.map((x) => `draft: ${x.label.slice(0, 50)}`)].join("; ") || r.reason}`);
  const page = await pageFor(jobId);
  try {
    const { dump: d, plan } = loadPlan(jobId);
    let pick = pickSubmit(plan.submitSelectors);
    // The button the plan named may have been drawn again since the page was read (Teamtailor: input[name=commit]
    // gone): the page's own Submit as it stands now is taken.
    if (!pick || !(await buttonPoint(page, pick)).ok) pick = pickSubmit((await dump(page)).submitSelectors) ?? pick;
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
    // A privacy statement the site wants opened and accepted in its own dialog (SuccessFactors' "Read and accept the
    // data privacy statement"), which it opens only once the other fields are valid: it is accepted now. It takes its
    // own turns at the front of the window, so it comes before the click's turn.
    await openPrivacyNotice(page, true);
    // Other forms may be filling in their own tabs. The click takes its turn for the front of the window.
    await inFront(page, async () => {
      // A cookie banner still open (one that came up late) is answered before the click, with its most private choice.
      await declineCookieBanner(page, false);
      let p = await buttonPoint(page, pick);
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
        after = await settledRead(page, "window.__awj.pageText()", after);
      } catch {
        continue; // mid-navigation
      }
      if (after !== before && after.length > 0) break;
    }
    await sleep(BROWSER.pollMs * 6);
    after = await settledRead(page, "window.__awj.pageText()", after);
    // A page still saying it is sending ("Submitting…", Workable) has not answered yet: it is given up to 45 s more.
    for (const until = Date.now() + 45_000; SENDING.test(after) && Date.now() < until; ) {
      await sleep(BROWSER.pollMs * 5);
      after = await settledRead(page, "window.__awj.pageText()", after);
    }
    const url = await page.evaluate<string>("location.href");
    let state = await decidePageState(jev, after, url, jobId, await afterSubmit());
    let errors = await settledRead<string[]>(page, "window.__awj.errors()", []);
    // Still the form, and the page reports nothing wrong: the board may only be slow to confirm. Wait for the page to change once more, then look again.
    if (state.state !== "submitted" && !errors.length && !SECURITY_CODE.test(after)) {
      const settled = after;
      const until = Date.now() + BROWSER.confirmMs;
      while (Date.now() < until && after === settled) {
        await sleep(BROWSER.pollMs * 6);
        try {
          after = await settledRead(page, "window.__awj.pageText()", after);
        } catch {
          continue; // mid-navigation
        }
      }
      if (after !== settled) {
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await settledRead<string[]>(page, "window.__awj.errors()", []);
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
            after = await settledRead(page, "window.__awj.pageText()", after);
          } catch {
            continue; // mid-navigation
          }
        }
        await sleep(BROWSER.pollMs * 6);
        after = await settledRead(page, "window.__awj.pageText()", after);
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await settledRead<string[]>(page, "window.__awj.errors()", []);
      }
    }
    // The site's own server said it failed for now ("An error occurred, please try again later", SmartRecruiters):
    // the form still holds every answer, so Submit is pressed again after a pause, twice at most.
    for (let retry = 0; retry < 2 && state.state !== "submitted" && TRY_LATER.test(after) && !TRY_LATER.test(before); retry++) {
      const again = await page.awj<Point>("point", pick.selector);
      if (!again.ok) break;
      console.log(`  the site answered "try again later": pressing Submit again (${retry + 1})`);
      await sleep(8_000 * (retry + 1));
      const shown = after;
      await inFront(page, () => page.click(again.x, again.y));
      const until = Date.now() + BROWSER.submitMs + BROWSER.confirmMs;
      while (Date.now() < until) {
        await sleep(BROWSER.pollMs * 6);
        try {
          after = await settledRead(page, "window.__awj.pageText()", after);
        } catch {
          continue; // mid-navigation
        }
        if (!TRY_LATER.test(after) || after !== shown) break;
      }
      await sleep(BROWSER.pollMs * 6);
      after = await settledRead(page, "window.__awj.pageText()", after);
      state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
      errors = await settledRead<string[]>(page, "window.__awj.errors()", []);
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
            after = await settledRead(page, "window.__awj.pageText()", after);
          } catch {
            continue; // mid-navigation
          }
        }
        await sleep(BROWSER.pollMs * 6);
        after = await settledRead(page, "window.__awj.pageText()", after);
        state = await decidePageState(jev, after, await page.evaluate<string>("location.href"), jobId, await afterSubmit());
        errors = await settledRead<string[]>(page, "window.__awj.errors()", []);
      }
    }
    // A page that says outright that the application went is a confirmation, whatever else it offers under it (Workday
    // puts "Create Account" under "Your application has successfully been submitted", which read as a sign-in page).
    if (state.state !== "submitted" && SAYS_SENT.test(after) && !SAYS_SENT.test(before)) state = { ...state, state: "submitted", confidence: Math.max(state.confidence, 0.9) };
    const notSent = state.state !== "submitted";
    // A challenge drawn in its own frame over the form (hCaptcha, reCAPTCHA, Turnstile) has no words in the page text.
    const challenge = notSent && !errors.length && (await page.evaluate<boolean>(CHALLENGE_SHOWN).catch(() => false));
    if (challenge) trace("after submit, a bot challenge is shown over the form");
    // A page that says only "correct the errors below": the words of each field box an error mark sits in, for the log.
    if (notSent && errors.length) trace(`after submit, errors sit in: ${await page.evaluate<string>(ERROR_PLACES).catch(() => "")}`.slice(0, 700));
    return { state: state.state, confidence: state.confidence, url: await page.evaluate<string>("location.href"), errors, needsCode: notSent && SECURITY_CODE.test(after), humanCheck: challenge || (notSent && !SECURITY_CODE.test(after) && HUMAN_CHECK.test(after)), refused: notSent && ALREADY_APPLIED.test(after), ineligible: notSent && NOT_ELIGIBLE.test(after), excerpt: after.replace(/\s+/g, " ").slice(-400) };
  } finally {
    page.close();
  }
}

/**
 * Reads something through the page helpers on a page that may still be loading the next document after a click:
 * the helpers are put back and the read tried again for a few seconds. Gives the fallback when the page never answers.
 */
async function settledRead<T>(page: Page, expression: string, fallback: T): Promise<T> {
  for (let i = 0; i < 10; i++) {
    try {
      await install(page);
      return await page.evaluate<T>(expression);
    } catch {
      await sleep(BROWSER.pollMs * 3);
    }
  }
  return fallback;
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
  "^\\s*(necessary only|only necessary|necessary cookies only|use necessary cookies only|(agree to|accept) (only )?(the )?necessary( cookies)?|reject all|reject|decline|decline all|refuse|deny|" +
  "(reject|decline|refuse|deny) all( the)? cookies|rifiuta tutti i cookie|alle cookies ablehnen|refuser tous les cookies|rechazar todas las cookies|" +
  "disagree( and close)?|continue without agreeing|(rifiuta|non accetto|non accettare) e chiudi|ablehnen und schließen|refuser et fermer|rechazar y cerrar|" +
  "(decline|reject|refuse|deny|rifiuta|nega|ablehnen|refuser|rechazar)\\b.{0,30}\\b(non[- ]?(necessary|essential)|optional|unnecessary|non (necessari|essenziali)|facoltativi|opzionali|nicht notwendige?n?|non essentiels|no necesarias)( cookies?)?|" +
  "rifiuta|rifiuta tutto|rifiuta tutti|rifiuta i cookie|solo necessari|solo cookie necessari|richiesto solo|solo richiesti|solo essenziali|samo nužni|samo nužni kolačići|accetta solo (i )?(cookie )?necessari|continua senza accettare|non accetto|non accettare|nega|" +
  "alle ablehnen|ablehnen|nur notwendige|tout refuser|refuser|continuer sans accepter|rechazar todo|rechazar)\\s*$";

/** The button of a cookie banner that opens its settings, for a banner whose first layer offers only "accept all". */
const COOKIE_SETTINGS =
  "^\\s*(cookie settings|cookies settings|cookie preferences|manage (cookies|cookie preferences|preferences|settings)|customi[sz]e( cookies)?|more options|" +
  "impostazioni( dei)? cookie|personalizza|gestisci (le )?preferenze|preferenze( dei)? cookie|cookie-einstellungen|einstellungen|paramètres( des cookies)?|personnaliser|configurar( cookies)?|personalizar)\\s*$";
/** A cookie banner's "accept all" button: while it shows, a banner is on screen. */
const ACCEPT_ALL_COOKIES =
  "^\\s*(accept all( cookies)?|allow all( cookies)?|accept and close|accetta tutt[io]( i cookie)?|accetta e chiudi|consenti tutt[io]|alle (cookies )?(akzeptieren|zulassen|erlauben)|tout accepter|accepter (tout|et fermer)|aceptar (todas?|y cerrar)( las cookies)?|aceitar tod[ao]s)\\s*$";
/** In a cookie banner's settings, the button that saves the choices as they stand: only the necessary cookies are on. */
const SAVE_COOKIE_CHOICES =
  "^\\s*(confirm my choices|save (my )?(settings|choices|preferences)|salva (le )?(impostazioni|preferenze|scelte)|conferma (le )?(mie )?scelte|auswahl (speichern|bestätigen)|einstellungen speichern|enregistrer( mes choix)?|guardar( configuración)?)\\s*$";

/**
 * Answers a cookie banner with its most private choice, never "accept all". A banner whose first layer has no such
 * choice (Usercentrics: "Cookie settings" and "Accept all cookies") is opened at its settings, where "Deny optional
 * cookies" or saving the untouched choices is. Returns whether a banner was answered.
 */
export async function declineCookieBanner(page: Page, settings = true): Promise<boolean> {
  const press = async (pattern: string): Promise<boolean> => {
    const b = await page.awj<Point>("clickByText", pattern);
    if (!b.ok || b.href) return false;
    await page.click(b.x, b.y);
    await sleep(BROWSER.pollMs * 4);
    return true;
  };
  if (await press(DECLINE_COOKIES)) return true;
  // The settings layer is opened only for a banner on screen, one that offers "accept all". A page's own lasting
  // "Manage cookies" button opens it too, and saving the choice there reloads the page (Teamtailor): a filled form
  // came back empty and was submitted so. Right before Submit (`settings` false) it is never opened.
  if (!settings || !(await page.awj<Point>("clickByText", ACCEPT_ALL_COOKIES)).ok) return false;
  if (!(await press(COOKIE_SETTINGS))) return false;
  return (await press(DECLINE_COOKIES)) || (await press(SAVE_COOKIE_CHOICES));
}

/** A page whose server failed the send for now and asks to try again. */
const TRY_LATER = /(please )?try again later|riprova(re)? più tardi|réessayer plus tard|réessayez plus tard|später erneut|inténtalo (de nuevo )?más tarde|vuelve a intentarlo más tarde|tente novamente mais tarde/i;
/** A page that says its Submit is still on the way. */
const SENDING = /\b(submitting|sending|invio in corso|invio\.\.\.|wird gesendet|wird übermittelt|envoi en cours|enviando)\s*(…|\.\.\.)/i;

/** A form whose answer to a screening question rules the candidate out. The job is skipped, not held. */
export const NOT_ELIGIBLE = /you (have|need) to meet (these|the|all) requirements|you do not meet (the|these) (minimum )?requirements|devi soddisfare (questi|i) requisiti|non soddisfi (i|questi) requisiti|vous devez remplir ces (conditions|crit[eè]res)|sie m[uü]ssen (diese|die) (anforderungen|voraussetzungen) erf[uü]llen|debes cumplir (estos|los) requisitos/i;

/** A board that refuses a second application from the same person for now. The job is skipped, not held. */
export const ALREADY_APPLIED = /recently applied for another role|unable to accept an additional application|already (applied|submitted an application)/i;

/** Words that say the application went through, in the languages of the boards met so far. */
export const SAYS_SENT =
  /your application has (successfully )?been (submitted|received|sent)|application (was|has been) (successfully )?(submitted|received|sent)|successfully (submitted|applied)|thank you for (your application|applying)|(la tua |la sua )?candidatura (è stata )?(inviata|ricevuta|registrata) con successo|grazie per (la tua candidatura|esserti candidat|aver(e)? inviato la (tua )?candidatura)|ihre bewerbung (wurde|ist) (erfolgreich )?(eingereicht|übermittelt|eingegangen)|votre candidature a (bien )?été (envoyée|reçue|transmise)|tu (solicitud|candidatura) (ha sido|se ha) enviad[ao]/i;

/** A page that asks the person to prove they are not a robot (BambooHR after Submit). Only the person can pass it. */
export const HUMAN_CHECK = /not a robot|i am human|i'm human|captcha|human check/i;

/** A board that emails a code to confirm a person is applying, in the page's language (Greenhouse writes it in Italian on an Italian posting). */
export const SECURITY_CODE = /verification code was sent|passcode|\botp\b|one-?time (password|code)|codice monouso|password monouso|einmal(passwort|code)|code à usage unique|código de un solo uso|enter the \S+ code|security code|codice di (verifica|sicurezza)|sicherheitscode|bestätigungscode|code de (vérification|sécurité)|código de (verificación|seguridad)/i;

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
