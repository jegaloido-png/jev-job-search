/**
 * The account a careers site wants before its form (Workday, SuccessFactors and the company sites built on it). The
 * candidate's own mailbox address is used, with a password made for that site and kept in data/accounts.json, so the
 * next application there signs in. One account per site and company: one SuccessFactors host serves many companies.
 *
 * On a sign-in page with no account kept for the site, the account is created: its fields are mapped and filled like
 * any form's, the password goes in every password box, the required terms are accepted. A site that mails an
 * activation link, a code or a password-reset link gets it from the mailbox through LINK_COMMAND / CODE_COMMAND.
 * Then the runner goes back to where the wall stood. Nothing here ever prints or logs a password.
 */
import { exec } from "node:child_process";
import { randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ACCOUNT, PATHS } from "../config.js";
import { isApplicationForm, type FieldsDump } from "../forms/fields.js";
import { mapForm } from "../forms/mapForm.js";
import type { JevClient } from "../jev/client.js";
import { applyUrlFor, type Job } from "../jobs/normalize.js";
import type { Profile } from "../profile/schema.js";
import { sleep, type Page } from "./cdp.js";
import { readDropdownOptions } from "./dropdowns.js";
import { applyFills } from "./fill.js";
import { dump, goto, inFront, install, settle, trace, type Point } from "./session.js";
import { declineCookieBanner, SECURITY_CODE } from "./submit.js";

const run = promisify(exec);

type Account = { email: string; password: string; created: string; host: string; tenant: string; company: string; url: string; verified?: boolean; made?: boolean; exists?: boolean; old?: string[] };
type Boxes = { passwords: number; user: boolean; userValue: string; signIn?: number; passcode?: number };

/** A sign-in page that first asks how to sign in (Workday: Google or email): the email way. */
export const EMAIL_WAY =
  "^\\s*(sign in with (your )?e-?mail|continue with (your )?e-?mail|use (your )?e-?mail( address)?|log ?in with (your )?e-?mail|" +
  "accedi con (la tua |l')?e-?mail|continua con (la tua |l')?e-?mail|mit e-?mail (anmelden|fortfahren)|se connecter avec (une |votre )?(adresse )?e-?mail|" +
  "iniciar sesión con (tu )?(correo|e-?mail))\\s*$";
/** The link from a sign-in page to the page that creates an account. */
const CREATE_LINK =
  "^\\s*(create (an |your |new )?account|create an account to apply.*|sign ?up|register( now| here)?|new user|new candidate|join( now)?|" +
  "crea (un |il tuo )?(nuovo )?account|registrati( ora| adesso)?|nuovo utente|registrazione|konto erstellen|registrieren|jetzt registrieren|" +
  "créer (un |mon )?compte|s'inscrire|crear (una )?cuenta|registrarse)\\s*$";
/** The button that sends a create-account form. */
const CREATE_SUBMIT =
  "^\\s*(create (an |my )?account|sign ?up|register|registrati|crea (l'|un )?account|conferma registrazione|registrazione|konto erstellen|registrieren|" +
  "créer (un |mon )?compte|s'inscrire|crear (una )?cuenta|registrarse|submit|invia|continue|continua|next|avanti|" +
  // A sign-up form that is also the application (SuccessFactors: the account boxes and the job's questions, then "Apply").
  "apply|apply now|candidati|candidati ora|invia (la )?candidatura|bewerben|jetzt bewerben|postuler|aplicar)\\s*$";
/** The link on a sign-up form to the sign-in of an account that exists ("Already a registered user? Please sign in"). */
const SIGN_IN_LINK = "^\\s*((already (a )?registered( user)?\\??|have an account\\??|hai già un account\\??|già registrat[oa]\\??)\\s*)?(please )?(sign ?in|log ?in|accedi)( here| now| qui)?\\s*$";
/** Words of a button that sends an application, not only an account. */
const APPLY_WORDS = /^\s*(apply|apply now|candidati|candidati ora|invia (la )?candidatura|bewerben|jetzt bewerben|postuler|aplicar)\s*$/i;
/** The button that sends a sign-in form. */
// Its words can come after another name and a slash (SuccessFactors at ANAS: "Candidatura Spontanea/Accedi").
const SIGN_IN_SUBMIT =
  "^\\s*([^/|]{0,40}[/|]\\s*)?(sign ?in|log ?in|accedi|accedere|entra|login|anmelden|einloggen|se connecter|connexion|iniciar sesión|acceder|continue|continua|next|avanti|submit|invia)\\s*$";
const FORGOT = "^\\s*(forgot (your )?password\\??|forgotten (your )?password\\??|reset (your )?password|password dimenticata\\??|hai dimenticato la password\\??|recupera( la)? password|passwort vergessen\\??|mot de passe oublié\\s*\\??|¿?olvidaste tu contraseña\\??)\\s*$";
const SEND_RESET = "^\\s*(submit|send|send (reset )?(link|e-?mail)|reset( password)?|request (a )?(new )?password|invia|continua|continue|recupera|reimposta|senden|zurücksetzen|envoyer|enviar|ok)\\s*$";
/** A button that mails a password reset straight away, offered where the site says the account exists ("Invia e-mail di reimpostazione password"). */
const RESET_MAIL = "^\\s*(send|request|invia|richiedi|senden|envoyer|enviar)\\b.{0,40}\\b(reset|reimpostazione|recupero|zurücksetzen|réinitialisation|restablecimiento)\\b.{0,20}$";

/** True when words matching `re` are on the page more often than before: a message that appeared, not one that was there. */
const appeared = (re: RegExp, before: string, after: string) => {
  const g = new RegExp(re.source, "gi");
  return (after.match(g)?.length ?? 0) > (before.match(g)?.length ?? 0);
};
const SAVE_PASSWORD = "^\\s*(save|set password|change password|reset password|update password|submit|continue|confirm|salva|conferma|invia|continua|imposta password|speichern|bestätigen|enregistrer|guardar|ok)\\s*$";
/**
 * A link that opens the privacy notice the site wants read before an account is made (SuccessFactors: "Please click on
 * the link to read and acknowledge the information regarding personal data processing"), and the notice's accept button.
 */
const PRIVACY_OPENER = "^\\s*(please )?(click|read)\\b.{0,80}\\b(acknowledge|privacy|personal data|data protection|informativa|dati personali)";
// A screen-reader word can come first in the button's text (SuccessFactors: "Enfatizzato Accetta").
const PRIVACY_ACCEPT = "^\\s*((emphasized|enfatizzato|hervorgehoben|accentué|enfatizado)\\s+)?(i accept|accept|i agree|agree|i have read.{0,40}|accetto|accetta|acconsento|ho letto.{0,40}|(ho )?preso visione|presa visione|ich stimme zu|akzeptieren|j'accepte|accepter|acepto|aceptar|ok|confirm|conferma)\\s*$";

// A link that asks ("Già registrato? Accedi", "Already registered?") is not the site saying so.
export const ALREADY_EXISTS = /already (exists|in use|registered(?!\s*(user)?\s*\?)|taken|associated|have an account(?!\s*\?))|account (with this e-?mail )?already|is already (used|registered)|esiste già|già (registrat(?![oaie]?\s*\?)|in uso|esistente)|bereits (registriert|vergeben|verwendet)|existe déjà|déjà utilisé|ya existe|ya está registrad/i;
const WRONG_LOGIN = /(invalid|incorrect|wrong|not valid|unrecognized|does not match)\b.{0,40}\b(password|credentials|e-?mail|user ?name|sign ?in|login)|(password|credentials|e-?mail|user ?name)\b.{0,30}\b(invalid|incorrect|wrong|not valid)|could not sign you in|unable to sign in|errat[ao]|non (valid[ao]|corrett[ao])|credenziali|falsche[sn]? (passwort|kennwort)|identifiants? (invalide|incorrect)|contraseña incorrecta/i;
const NOT_VERIFIED = /verify your (e-?mail|account)|verification (e-?mail|link)|activate your account|activation (e-?mail|link)|confirm your (e-?mail|account|email address)|check your (e-?mail|inbox|mailbox)|(e-?mail|link) (has been |was )?sent|we(['’]ve| have) (just )?sent|account (is )?not (yet )?(verified|activated|confirmed)|abbiamo inviato|controlla la tua (e-?mail|casella|posta)|verifica (il tuo|la tua)|attiva(re)? il tuo account|(deve ancora essere|non è ancora( stato)?) attivat|collegamento per attivare|e-?mail di attivazione|link di attivazione|bestätigen sie ihre|aktivieren sie ihr konto|vérifiez votre|activez votre compte|verifica tu (cuenta|correo)/i;

/** The account's place in data/accounts.json: the host, and the company when one host serves many. */
export function accountKey(url: string): { key: string; host: string; tenant: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { key: url, host: url, tenant: "" };
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  let tenant = (u.searchParams.get("company") ?? "").toLowerCase(); // SuccessFactors: career5.successfactors.eu/career?company=X
  if (!tenant && /(^|\.)myworkdaysite\.com$/.test(host)) tenant = (segs[segs.indexOf("recruiting") + 1] ?? "").toLowerCase();
  if (!tenant && ACCOUNT.pathTenantHosts.test(host) && segs[0] && !segs[0].endsWith(".php")) tenant = segs[0].toLowerCase();
  return { key: tenant ? `${host}|${tenant}` : host, host, tenant };
}

// A file that does not read throws: written over, it would lose every password in it.
const loadAccounts = (): Record<string, Account> => (existsSync(PATHS.accounts) ? (JSON.parse(readFileSync(PATHS.accounts, "utf8")) as Record<string, Account>) : {});
/**
 * Keeps an account. A password is never dropped: one replaced stays in `old`, and is tried at sign-in before any reset.
 * The file is written whole through a temporary file, and every password kept is also appended to a log next to it.
 */
const saveAccount = (key: string, a: Account) => {
  mkdirSync(path.dirname(PATHS.accounts), { recursive: true });
  const all = loadAccounts();
  const was = all[key];
  const old = [...new Set([...(was?.old ?? []), ...(a.old ?? []), ...(was?.password ? [was.password] : [])])].filter((p) => p && p !== a.password);
  const tmp = `${PATHS.accounts}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...all, [key]: { ...a, ...(old.length ? { old } : {}) } }, null, 1));
  renameSync(tmp, PATHS.accounts);
  if (a.password && a.password !== was?.password) appendFileSync(PATHS.accounts.replace(/\.json$/, ".log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), key, email: a.email, password: a.password })}\n`);
};

/**
 * A password most sites take: 16 characters, at least one lower case letter, one upper case letter, one digit and one
 * common symbol. SuccessFactors allows 8 to 18 and refused "-" and "_"; letters that read alike (l, I, O, 0, 1) are left out.
 */
export function newPassword(plain = false): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (s: string) => s[randomInt(s.length)]!;
  // Plain: letters and digits only, for a site that refused the symbol.
  const chars = [pick(lower), pick(upper), pick(digits), pick(plain ? digits : "!@#$%*")];
  while (chars.length < 16) chars.push(pick(lower + upper + digits));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/**
 * Runs the person's LINK_COMMAND or CODE_COMMAND to read what a site just mailed. The command may use {url},
 * {company} and {since}; it prints a JSON line with "link" or "code", or nothing. Returns it, or "".
 */
async function fromMailbox(kind: "link" | "code", job: { url: string; company: string }, since: Date): Promise<string> {
  const command = kind === "link" ? process.env.LINK_COMMAND : process.env.CODE_COMMAND;
  if (!command) return "";
  const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
  const cmd = command.replace(/\{url\}/g, quote(job.url)).replace(/\{company\}/g, quote(job.company)).replace(/\{since\}/g, since.toISOString());
  try {
    const { stdout } = await run(cmd, { timeout: ACCOUNT.mailWaitMs, windowsHide: true });
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        const got = v[kind];
        if (typeof got === "string" && got.trim()) return got.trim();
      } catch {
        /* not the JSON line */
      }
    }
  } catch (err) {
    trace(`account: the mailbox command failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 160)}`);
  }
  return "";
}

/**
 * The site said an account with the candidate's address already exists, made before with a password not kept here
 * (a sign-up form that is also the application answers "Account Already Exists" only after Submit). The next try signs
 * in from the form's own sign-in link, and the site is asked for a new password.
 */
export function markAccountExists(url: string): void {
  let { key, host, tenant } = accountKey(url);
  // The page after Submit names no company (SuccessFactors: career?_s.crb=…): the account made last on that host.
  if (!tenant) {
    const latest = Object.entries(loadAccounts()).filter(([, x]) => x.host === host).sort(([, x], [, y]) => Date.parse(y.created) - Date.parse(x.created))[0];
    if (latest) [key, tenant] = [latest[0], latest[1].tenant];
  }
  const a = loadAccounts()[key];
  saveAccount(key, a ? { ...a, made: true, verified: true, exists: true } : { email: "", password: "", created: new Date().toISOString(), host, tenant, company: "", url, made: true, verified: true, exists: true });
}

/** True when the page shows a sign-in way to choose (Workday: Google or email) or a password box: an account wall. */
export async function atAccountWall(page: Page, d: FieldsDump): Promise<boolean> {
  if (d.hasPassword) return true;
  if (isApplicationForm(d)) return false;
  return (await page.awj<Point>("clickByText", EMAIL_WAY)).ok;
}

/**
 * Gets past an account wall: signs in with the account kept for the site, or creates one. Gives the page as it is
 * once no password box is left (the form, or the next step of the site's own flow), or the reason it could not.
 */
export async function passAccountWall(page: Page, jev: JevClient, profile: Profile, job: Job, d: FieldsDump): Promise<FieldsDump | string | { signUpForm: FieldsDump }> {
  const wallUrl = d.url;
  let { key, host, tenant } = accountKey(wallUrl);
  // A sign-in page that names no company (SuccessFactors: career?_s.crb=…) is the posting's company's when the posting
  // is on the same host: one host holds many companies, each with its own account (Intercos took Tod's password).
  if (!tenant) {
    const posting = accountKey(applyUrlFor(job));
    if (posting.host === host && posting.tenant) ({ key, tenant } = posting);
  }
  const email = profile.email;
  // The mailbox is searched for the posting's own site too: SuccessFactors on a company site mails from that company
  // (noreply@bonduelle.com for career5.successfactors.eu), and the posting (jobs.bonduelle.com) names it.
  const mailJob = { url: applyUrlFor(job), company: job.company };
  const postingHost = (() => { try { return new URL(applyUrlFor(job)).hostname; } catch { return host; } })();
  // An account kept for another address (an earlier mailbox) is not this one's: its password, its "exists" and its
  // activation say nothing about the account of this address. The row is replaced when this address makes its own.
  let account: Account | undefined = loadAccounts()[key];
  if (account?.email && account.email.toLowerCase() !== email.toLowerCase()) {
    trace(`account: the account kept here is for another address: treated as none`);
    account = undefined;
  }
  const tries = { signIn: 0, signInLink: 0, create: 0, reset: 0, link: 0, code: 0, back: 0 };
  let text = "";
  const read = async () => {
    await install(page);
    text = await page.evaluate<string>("window.__awj.pageText()");
    return page.awj<Boxes>("accountBoxes");
  };
  const press = async (pattern: string, near = true): Promise<boolean> => {
    const b = await page.awj<Point & { words?: string; href?: string }>(near ? "nearButton" : "clickByText", pattern);
    if (!b.ok) return false;
    trace(`account: pressing "${b.words ?? pattern.slice(0, 30)}"`);
    const from = await page.evaluate<string>("location.href").catch(() => "");
    await inFront(page, () => page.click(b.x, b.y));
    // A link loads another page: the old one is not read as the new one while it is still on screen.
    let moved = !b.href;
    for (const until = Date.now() + 8_000; !moved && Date.now() < until; ) {
      await sleep(300);
      moved = (await page.evaluate<string>("location.href").catch(() => from)) !== from;
    }
    // A link the click did not follow (the page was redrawing under it) is opened in this tab: it is on the same site.
    if (!moved && b.href) await goto(page, b.href, from);
    return true;
  };
  /** Waits for the page to change after a press, then lets it settle. */
  const afterPress = async (was: string) => {
    const until = Date.now() + ACCOUNT.pressWaitMs;
    while (Date.now() < until) {
      await sleep(500);
      try {
        await install(page);
        if ((await page.evaluate<string>("window.__awj.pageText()")) !== was) break;
      } catch {
        /* mid-navigation */
      }
    }
    await settle(page);
    await install(page);
  };
  const typeInto = async (selector: string, value: string) =>
    inFront(page, async () => {
      const p = await page.awj<Point>("point", selector);
      if (!p.ok) return false;
      await page.click(p.x, p.y);
      await page.awj("selectAll");
      await page.key("Backspace");
      await page.typeKeys(value);
      await page.key("Tab");
      return true;
    });
  const typePasswords = async (n: number, password: string) => {
    for (let i = 0; i < n; i++) {
      const sel = `[data-awj-pw="${i}"]`;
      await typeInto(sel, password);
      // A box that did not take the keys (the click landed on something over it) gets the password from script, with
      // the events a person's typing sends. Only the length is read back, never the password.
      const held = () => page.evaluate<number>(`(() => { const find = (q, r = document) => r.querySelector(q) || [...r.querySelectorAll("*")].map((e) => e.shadowRoot && find(q, e.shadowRoot)).find(Boolean) || null; const b = find(${JSON.stringify(sel)}); return b ? b.value.length : -1; })()`).catch(() => -1);
      if ((await held()) === password.length) continue;
      // Focused from script and typed with real keys: the site's own checks listen to keys (a click that a password
      // policy layer took never focused the box).
      await inFront(page, async () => {
        await page.evaluate(`(() => { const find = (q, r = document) => r.querySelector(q) || [...r.querySelectorAll("*")].map((e) => e.shadowRoot && find(q, e.shadowRoot)).find(Boolean) || null; const b = find(${JSON.stringify(sel)}); if (b) { b.focus(); b.select && b.select(); } })()`);
        await page.key("Backspace");
        await page.typeKeys(password);
        await page.key("Tab");
      });
      if ((await held()) === password.length) {
        trace(`account: password box ${i} took the keys once focused from script`);
        continue;
      }
      await page.evaluate(`(() => { const find = (q, r = document) => r.querySelector(q) || [...r.querySelectorAll("*")].map((e) => e.shadowRoot && find(q, e.shadowRoot)).find(Boolean) || null; const b = find(${JSON.stringify(sel)}); if (!b) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; b.focus(); set.call(b, ${JSON.stringify(password)}); for (const t of ["input", "change", "keyup", "blur"]) b.dispatchEvent(new Event(t, { bubbles: true })); })()`).catch(() => undefined);
      trace(`account: password box ${i} did not take the typed keys: set from script, it now holds ${await held()} of ${password.length} characters`);
    }
  };
  /** Opens a link from the mailbox in the job's tab: only on the wall's own site or an ATS. */
  const openMailed = async (since: Date): Promise<boolean> => {
    if (tries.link >= ACCOUNT.maxLinks) return false;
    tries.link++;
    trace("account: waiting for the site's mail");
    const link = await fromMailbox("link", mailJob, since);
    if (!link) return false;
    const to = (() => {
      try {
        return new URL(link).hostname;
      } catch {
        return "";
      }
    })();
    const same = (a: string, b: string) => a.split(".").slice(-2).join(".") === b.split(".").slice(-2).join(".");
    if (!to || !(same(to, host) || same(to, postingHost) || ACCOUNT.mailLinkHosts.some((h) => to === h || to.endsWith(`.${h}`)))) {
      trace(`account: the mailed link goes to ${to || "an unknown page"}: not opened`);
      return false;
    }
    trace(`account: opening the mailed link on ${to}`);
    await goto(page, link);
    await inFront(page, () => declineCookieBanner(page)).catch(() => false);
    // A confirm or activate button on the page the link opens is pressed once.
    await press("^\\s*(confirm|activate|verify|continue|conferma|attiva|verifica|continua|bestätigen|aktivieren|confirmer|activer|confirmar|activar)\\b", false).catch(() => false);
    await settle(page);
    return true;
  };
  // Back to where the account was asked for when that address names the job (Workday's .../job/.../apply), else to the
  // posting itself (SuccessFactors asks on a page of the whole careers site): its Apply then opens the form signed in.
  const backTo = (() => {
    try {
      const u = new URL(wallUrl);
      return /job|apply|req/i.test(u.pathname + u.search.replace(/company=[^&]*/i, "")) ? wallUrl : applyUrlFor(job);
    } catch {
      return applyUrlFor(job);
    }
  })();
  const back = async () => {
    tries.back++;
    trace("account: back to the page that asked for the account");
    await goto(page, backTo);
    await inFront(page, () => declineCookieBanner(page)).catch(() => false);
  };
  /** A code the site mailed, typed into its boxes and sent. */
  // Twice at most: a passcode right after the account is made, and one more after a sign-in (a code mailed late or refused).
  const typeMailedCode = async (since: Date): Promise<boolean> => {
    if (tries.code >= 2) return false;
    tries.code++;
    const code = await fromMailbox("code", mailJob, since);
    const boxes = code ? await page.evaluate<number>("window.__awj.codeBoxes()") : 0;
    trace(`account: mailed code ${code ? "found" : "not found"}, ${boxes} box(es)`);
    if (!code || !boxes) return false;
    for (let i = 0; i < (boxes > 1 ? Math.min(boxes, code.length) : 1); i++) await typeInto(`[data-awj-code="${i}"]`, boxes > 1 ? code[i]! : code);
    const was = text;
    // The button nearest the code box: a dialog over the sign-up form has its own.
    const b = await page.awj<Point & { words?: string }>("nearButton", "^\\s*(submit|verify|confirm|continue|next|ok|invia|verifica|conferma|continua|avanti|bestätigen|weiter|vérifier|continuer|verificar|continuar)\\b", '[data-awj-code="0"]');
    if (!b.ok) return false;
    trace(`account: pressing "${b.words ?? "send code"}"`);
    await inFront(page, () => page.click(b.x, b.y));
    await afterPress(was);
    if (account) {
      account = { ...account, made: true, verified: true };
      saveAccount(key, account);
    }
    return true;
  };
  /** Since when a mailed code can be this one's: the account's making, at most a few minutes back (an older code expired). */
  const codeSince = () => new Date(Math.max(account ? Date.parse(account.created) - 60_000 : 0, Date.now() - 3 * 60_000));
  /** Asks the site for a password-reset mail, opens its link and sets a new password. */
  const reset = async (): Promise<boolean> => {
    if (tries.reset >= 1) return false;
    tries.reset++;
    trace(`account: the password is not known here (${(await page.evaluate<string[]>("window.__awj.errors()")).slice(0, 2).join(" | ").slice(0, 160)}): asking the site for a reset`);
    const since = new Date(Date.now() - 60_000);
    // A page that says the account exists can offer the reset mail as one button; otherwise the "Forgot password" page,
    // the address, and its send button.
    if (await press(RESET_MAIL, false)) await afterPress(text);
    else {
      if (!(await press(FORGOT))) return false;
      await afterPress(text);
      const b = await read();
      if (!b.user) {
        trace(`account: the reset page has no box for the address: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
        return false;
      }
      await typeInto("[data-awj-user]", email);
      const was = text;
      if (!(await press(SEND_RESET)) && !(await press(RESET_MAIL, false))) {
        trace(`account: the reset page has no send button: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
        return false;
      }
      await afterPress(was);
    }
    if (!(await openMailed(since))) return false;
    const after = await read();
    if (after.passwords < 1) return false;
    account = { email, password: newPassword(), created: new Date().toISOString(), host, tenant, company: job.company, url: wallUrl, verified: true };
    saveAccount(key, account);
    await typePasswords(after.passwords, account.password);
    const was2 = text;
    if (!(await press(SAVE_PASSWORD))) return false;
    await afterPress(was2);
    await back();
    return true;
  };

  for (let round = 0; round < ACCOUNT.maxRounds; round++) {
    const boxes = await read();
    const now = await dump(page);
    trace(`account: round ${round}, ${boxes.passwords} password box(es), user box ${boxes.user ? "yes" : "no"}, ${now.fields.length} field(s)${boxes.passcode ? ", a passcode box" : ""}`);
    // A box for the passcode the site mailed (SuccessFactors verifies a new account so, and asks again at a sign-in
    // until it is verified): the code from the mailbox, never a password.
    if (boxes.passcode) {
      trace("account: the site asks for the passcode it mailed");
      if (await typeMailedCode(codeSince())) continue;
    }
    if (!boxes.passwords) {
      // A sign-in way to choose comes before the boxes (Workday: "Sign in with email").
      if (!isApplicationForm(now) && (await press(EMAIL_WAY, false))) {
        await afterPress(text);
        continue;
      }
      // The site wants the address confirmed first: the mail it sent holds the link.
      // Asked even for an account kept as verified: a sign-in can land on "not activated yet" (SuccessFactors). The mail
      // link is opened at most ACCOUNT.maxLinks times.
      if (account && NOT_VERIFIED.test(text) && (await openMailed(new Date(Date.parse(account.created) - 60_000)))) {
        account = { ...account, verified: true };
        saveAccount(key, account);
        await back();
        continue;
      }
      if (SECURITY_CODE.test(text) && (await typeMailedCode(codeSince()))) continue;
      return now;
    }
    // One masked box and no address box on a page asking for a mailed passcode, or right after an account was made and
    // before it is verified: the code, never the password (SuccessFactors "Your passcode for account verification").
    if (boxes.passwords === 1 && !boxes.user && (SECURITY_CODE.test(text) || (account?.made && !account.verified))) {
      trace(`account: one masked box and no address box: the passcode the site mailed`);
      if (await typeMailedCode(codeSince())) continue;
    }
    if (boxes.passwords >= 2 && account?.exists) {
      // An account the site already holds (it said so after an earlier Submit): the sign-up form's own sign-in link and
      // the passwords kept for it. Only with none kept, or none taken, is the site asked for a new one.
      const kept = account.password || account.old?.length;
      // The sign-in sits on this same page beside the sign-up: the address and the kept password go in its own boxes, and
      // Enter sends it. Only when that is refused is the site asked for a new password.
      if (kept && (boxes.signIn ?? -1) >= 0 && tries.signIn < 2) {
        tries.signIn++;
        trace("account: signing in with the kept password in the sign-in boxes beside the sign-up");
        await typeInto("[data-awj-signin-user]", email);
        await typeInto(`[data-awj-pw="${boxes.signIn}"]`, account.password || account.old?.[0] || "");
        const p = await page.awj<Point>("point", `[data-awj-pw="${boxes.signIn}"]`);
        if (p.ok) {
          const was = text;
          await inFront(page, async () => {
            await page.click(p.x, p.y);
            await page.key("Enter");
          });
          await afterPress(was);
          continue;
        }
      }
      if (tries.signInLink < 2 && (await press(SIGN_IN_LINK, false))) {
        tries.signInLink++;
        await afterPress(text);
        if (kept) continue;
      }
      if (await reset()) continue;
      return "the site holds an account for this address, and its password could not be reset";
    }
    if (boxes.passwords >= 2) {
      // A form that makes the account: its fields like any form's, the password in every password box, the terms accepted.
      if (tries.create >= ACCOUNT.maxCreates) return "the site refused the new account twice";
      tries.create++;
      const fresh = !account;
      if (!account) {
        account = { email, password: newPassword(), created: new Date().toISOString(), host, tenant, company: job.company, url: wallUrl, verified: false, made: false };
        saveAccount(key, account);
      }
      trace(`account: ${fresh ? "creating the account" : "the account page again, with the password kept for it"}`);
      const fields = now.fields.filter((f) => f.kind !== "file");
      // A sign-up form can ask application questions with lists ("How did you hear about this position?"): their
      // options are read first, as on any form, so the answer is one of them.
      await readDropdownOptions(page, fields);
      const plan = await mapForm(jev, profile, job, { ...now, fields });
      // The email box gets the address of the account, whatever the profile maps.
      // A sign-up form has no writer round: a required field the plan was unsure of takes its best guess, and so does any
      // unsure field once the site has refused the account ("Make My Profile Visible to").
      const guesses = plan.fields
        .filter((p) => p.action === "review" && p.value && (p.required || tries.create > 1))
        .map((p) => ({ selector: p.selector, kind: p.kind, value: p.value as string }));
      const fills = [...plan.fills, ...guesses].map((f) => (fields.find((x) => x.selector === f.selector && (x.kind === "email" || /e-?mail/i.test(x.label))) ? { ...f, value: email } : f));
      trace(`account: fields ${plan.fields.map((p) => `${p.label.slice(0, 24)}=${p.action}:${String(p.value ?? "").slice(0, 20)}`).join(" | ")}`);
      const unset = await applyFills(page, fills, profile);
      if (unset.length) trace(`account: ${unset.length} account field(s) did not take a value: ${unset.map((u) => u.why).join("; ").slice(0, 200)}`);
      // The passwords go in before the privacy statement (SuccessFactors opens it only once the form is filled) and again
      // after it: accepting it can draw the form anew with empty password boxes.
      await page.awj<Boxes>("accountBoxes");
      await typePasswords(boxes.passwords, account.password);
      await acceptTerms(page, now);
      await openPrivacyNotice(page);
      await page.awj<Boxes>("accountBoxes");
      await typePasswords(boxes.passwords, account.password);
      const since = new Date(Date.now() - 60_000);
      account = { ...account, created: since.toISOString() };
      saveAccount(key, account);
      // A sign-up form that is also the application (its only button is "Apply"): it is not sent from here. It goes
      // back to the runner with the password typed, to be filled, checked and submitted like any form.
      const send = await page.awj<Point & { words?: string }>("nearButton", CREATE_SUBMIT);
      if (send.ok && APPLY_WORDS.test(send.words ?? "") && isApplicationForm(now)) {
        trace(`account: the sign-up form is the application ("${send.words}"): handing it to the form runner`);
        saveAccount(key, { ...account, made: true });
        // Upload buttons that open a dialog get their stand-in file boxes on this page too.
        await page.awj("exposeFileButtons").catch(() => 0);
        return { signUpForm: await dump(page) };
      }
      const was = text;
      if (!(await press(CREATE_SUBMIT))) return "no button to create the account";
      await afterPress(was);
      const after = await read();
      // The site made the account and asks for the passcode it mailed, in a box over the form or on a page of its own: the
      // next round types it. The password is kept as it is: the account holds it.
      if (after.passcode || appeared(SECURITY_CODE, was, text)) {
        account = { ...account, made: true };
        saveAccount(key, account);
        trace("account: account made; the site asks for the passcode it mailed");
        continue;
      }
      if (appeared(ALREADY_EXISTS, was, text)) {
        trace(`account: the site says the account exists: "${(text.match(new RegExp(`.{0,60}(${ALREADY_EXISTS.source}).{0,40}`, "i"))?.[0] ?? "").replace(/\s+/g, " ")}"`);
        // Made by an earlier try of this tool (its sign-up went through though the page said otherwise): the password
        // kept here is its own, so the site's sign-in comes first. A wrong password then asks for the reset there.
        // The candidate's address is the run's own: an account the site holds for it was made by this tool, with a
        // password kept here (the one just typed, or one before it), so the sign-in comes before any reset.
        if (await press(SIGN_IN_LINK, false)) {
          account = { ...account, made: true };
          saveAccount(key, account);
          await afterPress(text);
          continue;
        }
        // No sign-in link to follow: the site is asked for a new password.
        if (await reset()) continue;
        return "the site says the account exists, and its password could not be reset";
      }
      if (after.passwords >= 2) {
        const errors = await page.evaluate<string[]>("window.__awj.errors()");
        if (tries.create >= ACCOUNT.maxCreates) return `the site did not take the new account${errors.length ? `: ${errors.slice(0, 3).join("; ").slice(0, 200)}` : ""}`;
        trace(`account: the account page is still open${errors.length ? `: ${errors.slice(0, 3).join("; ").slice(0, 200)}` : ""}`);
        // A password the site refused (or a refusal that names no field), on an account it has not made: the next try types one
        // with no symbol. The refused one stays in the account's old list.
        if (!account.made && (!errors.length || errors.some((e) => /password|passwort|mot de passe|contraseña/i.test(e)))) {
          account = { ...account, password: newPassword(true), old: [...(account.old ?? []), account.password] };
          saveAccount(key, account);
          trace("account: the site refused the password: a plain one next");
        }
        // What a person would see as the reason: boxes the page marks invalid, and any alert or error words it shows.
        if (!errors.length)
          trace(
            `account: page notes: ${await page.evaluate<string>(
              "(() => { const vis = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed'; const bad = [...document.querySelectorAll('[aria-invalid=true], :invalid')].filter((e) => e.tagName !== 'FORM' && vis(e)).map((e) => e.id || e.name || e.tagName); const notes = [...document.querySelectorAll('[role=alert], [class*=error i], [class*=alert i], [class*=warning i], [class*=invalid i]')].filter(vis).map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).filter((t) => t && t.length < 300); return 'invalid ' + JSON.stringify(bad.slice(0, 6)) + ' notes ' + JSON.stringify([...new Set(notes)].slice(0, 4)); })()",
            ).catch(() => "")}`.slice(0, 500),
          );
        // Words that came on the page with the press, and any open layer: what the site answered.
        const fresh = text.split(/\n+/).map((l) => l.trim()).filter((l) => l && !was.includes(l));
        trace(`account: new on the page: ${JSON.stringify(fresh.slice(0, 8)).slice(0, 400)}; layers: ${await page.evaluate<string>("JSON.stringify([...document.querySelectorAll('.modal, [role=dialog], [aria-modal=true], .ui-dialog, dialog')].filter((m) => getComputedStyle(m).display !== 'none' && m.offsetWidth).map((m) => (m.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)))").catch(() => "")}`.slice(0, 700));
        continue;
      }
      trace(`account: account created; the page now: ${(await page.evaluate<string>("location.href")).replace(/[?#].*/, "")} ${text.replace(/\s+/g, " ").slice(0, 160)}`);
      account = { ...account, made: true };
      saveAccount(key, account);
      if (SECURITY_CODE.test(text) && (await typeMailedCode(since))) continue;
      if (NOT_VERIFIED.test(text) || !after.passwords) {
        const nowForm = await dump(page);
        if (!after.passwords && isApplicationForm(nowForm)) {
          saveAccount(key, { ...account, verified: true });
          return nowForm;
        }
        if (NOT_VERIFIED.test(text) && (await openMailed(since))) {
          account = { ...account, verified: true };
          saveAccount(key, account);
          await back();
          continue;
        }
      }
      if (!after.passwords && tries.back < ACCOUNT.maxBacks) {
        // The site moved on by itself to the form (SuccessFactors can open the application right after the account):
        // the runner goes on from there. Any other page (its list of open positions) means back to the posting or to
        // where the account was asked for, now signed in.
        const nowUrl = await page.evaluate<string>("location.href").catch(() => wallUrl);
        const landed = await dump(page);
        trace(`account: after sign-up the site shows ${nowUrl.replace(/[?#].*/, "")}: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
        if (nowUrl.split("#")[0] !== wallUrl.split("#")[0] && isApplicationForm(landed)) return landed;
        await back();
        continue;
      }
      continue;
    }
    // One password box: a sign-in form.
    // No account kept for this site, or one an earlier try never got the site to take: its sign-up page.
    if (!account || (account.made === false && tries.create < ACCOUNT.maxCreates)) {
      if (await press(CREATE_LINK)) {
        await afterPress(text);
        continue;
      }
      if (!account) return "no way to create an account on the sign-in page";
    }
    // Every password kept for the site, the current one first: a replaced one may be the one the site still holds.
    const kept = [account.password, ...(account.old ?? [])].filter(Boolean);
    const maxSignIns = Math.max(ACCOUNT.maxSignIns, kept.length);
    if (tries.signIn >= maxSignIns) return "the site refused the sign-in";
    const password = kept[Math.min(tries.signIn, kept.length - 1)] ?? account.password;
    tries.signIn++;
    trace(`account: signing in with the account kept for this site${kept.length > 1 ? ` (kept password ${Math.min(tries.signIn, kept.length)} of ${kept.length})` : ""}`);
    if (boxes.user) await typeInto("[data-awj-user]", account.email);
    await typePasswords(1, password);
    const was = text;
    if (!(await press(SIGN_IN_SUBMIT))) return "no sign-in button";
    await afterPress(was);
    const after = await read();
    if (!after.passwords) {
      account = { ...account, password, verified: account.verified || !NOT_VERIFIED.test(text) };
      saveAccount(key, account);
      // A sign-in that lands on the site's home page and not on the form: back to where the wall stood.
      const landed = await dump(page);
      if (!isApplicationForm(landed) && !(await page.awj<Point>("clickByText", EMAIL_WAY)).ok && tries.back < ACCOUNT.maxBacks && /home|dashboard|profile|candidate/i.test(await page.evaluate<string>("location.pathname"))) await back();
      continue;
    }
    if (NOT_VERIFIED.test(text) && !NOT_VERIFIED.test(was) && (await openMailed(new Date(Date.parse(account.created) - 60_000)))) {
      account = { ...account, verified: true };
      saveAccount(key, account);
      await back();
      continue;
    }
    if (SECURITY_CODE.test(text) && !SECURITY_CODE.test(was) && (await typeMailedCode(new Date(Date.now() - 2 * 60_000)))) continue;
    if (WRONG_LOGIN.test(text) || tries.signIn >= maxSignIns) {
      if (tries.signIn < kept.length) continue;
      // An account the site never confirmed (no sign-in, no activation, no mail) may never have been made: the sign-up
      // comes before any reset. A site that then says it exists gets the reset.
      if (!account.verified && tries.create < ACCOUNT.maxCreates && (await press(CREATE_LINK))) {
        trace("account: the site does not know the kept password of an account it never confirmed: making it again");
        account = { ...account, made: false };
        saveAccount(key, account);
        await afterPress(text);
        continue;
      }
      if (await reset()) continue;
      return "the site refused the sign-in, and the password could not be reset";
    }
  }
  return "the account wall did not open";
}

/** Ticks the required boxes a create-account form shows unticked: its terms and privacy. */
async function acceptTerms(page: Page, d: FieldsDump): Promise<void> {
  for (const f of d.fields.filter((x) => x.kind === "checkbox" && x.required)) {
    const on = await page.call<boolean>("function (s) { const el = window.__awj.q(s); return !!el && !!el.checked; }", f.selector);
    if (on) continue;
    const p = await page.awj<Point>("point", f.selector);
    if (!p.ok) continue;
    trace(`account: accepting "${f.label.slice(0, 60)}"`);
    await inFront(page, () => page.click(p.x, p.y));
    await sleep(300);
  }
}

/** Opens the privacy notice a site wants read before an account is made, and accepts it. */
export async function openPrivacyNotice(page: Page, dialogOnly = false): Promise<void> {
  // The link says so in words, or it is a control that opens a dialog and names the privacy terms in its own label
  // (SuccessFactors in Italian: "Aprire l'accordo per il trattamento dei dati personali per accettarne le condizioni").
  // Right before Submit only a control that says it opens a dialog is pressed: a plain link could leave the form.
  // The control that opens the dialog comes first: it is clicked on its first line of words, where a link that wraps
  // over two lines still takes the click (Ferrari's "Please click on the link to read and acknowledge…").
  let link = await page.awj<Point & { clicked?: boolean }>("privacyOpener");
  if (!link.ok && !dialogOnly) link = await page.awj<Point>("clickByText", PRIVACY_OPENER);
  if (!link.ok) return;
  trace(`account: reading and accepting the privacy notice${link.clicked ? " (its link, out of view, clicked from script)" : ""}`);
  if (!link.clicked) await inFront(page, () => page.click(link.x, link.y));
  // The notice can take a few seconds to load its text and buttons.
  let p: Point = { x: 0, y: 0, ok: false };
  for (const until = Date.now() + 6_000; !p.ok && Date.now() < until; ) {
    await sleep(500);
    // Some notices are drawn at no opacity (SuccessFactors): they are shown, so a click lands where a person would see it.
    await page.evaluate("document.querySelectorAll('.modal, [role=dialog]').forEach((m) => { if (getComputedStyle(m).display !== 'none') m.style.opacity = '1'; })");
    p = await page.awj<Point>("dialogButton", PRIVACY_ACCEPT);
  }
  if (!p.ok) p = await page.awj<Point>("clickByText", PRIVACY_ACCEPT);
  if (p.ok) {
    await inFront(page, () => page.click(p.x, p.y));
    await sleep(800);
  } else
    trace(
      `account: the privacy notice has no accept button; open layers: ${await page.evaluate<string>(
        "JSON.stringify([...document.querySelectorAll('.modal, [role=dialog], [aria-modal=true], .ui-dialog')].filter((m) => getComputedStyle(m).display !== 'none' && m.offsetWidth).map((m) => (m.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) + ' | ' + [...m.querySelectorAll('button, input[type=button], input[type=submit], a')].map((b) => (b.innerText || b.value || '').trim()).filter(Boolean).slice(-6).join(' / ')).slice(-3))",
      ).catch(() => "")}`.slice(0, 600),
    );
}
