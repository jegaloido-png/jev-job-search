/**
 * Writes values into an open form and reads every one back. A value that did
 * not stick is tried again with real clicks and typing. What still did not
 * land is returned with the reason, never assumed to be there.
 */
import path from "node:path";
import { BROWSER } from "../config.js";
import type { Method } from "../knowledge/sites.js";
import type { Profile } from "../profile/schema.js";
import { sleep, type Page } from "./cdp.js";
import { pickDate } from "./calendar.js";
import { showsValue } from "../util/dates.js";
import { fillDropdown, fillDropdownByClicking, fillPanel } from "./dropdowns.js";
import type { Failure, Fill } from "./report.js";
import { controlStates, inFront, norm, script, shownValues, trace, type Point } from "./session.js";

/** Applies fills to the open form. Returns the ones that did not land. */
/** What the tool already knows about a site's controls, and where it reports what it finds out. */
export type FillGuide = {
  /** The way this control took a value on this site before, if it is known. */
  prefer: (selector: string) => Method | undefined;
  /** Told once per control whose value was read back from the page: the way that got it there. */
  landed: (selector: string, method: Method) => void;
};

export async function applyFills(page: Page, fills: Fill[], profile: Profile, guide?: FillGuide): Promise<Failure[]> {
  const failed: Failure[] = [];
  const how = new Map<string, Method>();
  const panels = new Set<string>();
  const hints = [profile.address.city, profile.address.region, profile.address.regionCode, profile.address.country];
  // fillFields.js is a function expression under a comment header; the protocol wants the bare expression.
  const fillScript = script("fillFields.js").replace(/^(\s*\/\/.*\n)+/, "").trim().replace(/;$/, "");
  const setFields = async (some: Fill[]) => {
    if (!some.length) return;
    const report = JSON.parse(await page.call<string>(fillScript, some)) as { failed: { selector: string; why: string }[] };
    for (const f of report.failed) if (!failed.some((x) => x.selector === f.selector)) failed.push(f);
  };
  const plain = fills.filter((f) => f.kind !== "combobox" && f.kind !== "calendar");
  // A control known to ignore a value set from script is typed into straight away: no failed first try, no waiting.
  // A date goes in key by key too: date pickers keep only what they saw typed, whatever the box shows.
  const typeFirst = plain.filter((f) => TYPED_KINDS.has(f.kind) && (guide?.prefer(f.selector) === "typed" || DATE_TYPED.test(f.value)));
  const simple = plain.filter((f) => !typeFirst.includes(f));
  page.takeWrites();
  const [first, ...rest] = simple;
  if (first) {
    await setFields([first]);
    await sleep(BROWSER.pollMs);
  }
  if (page.takeWrites().made > 0) {
    // This form saves each field to its server as it changes (Ashby). Fields go in one at a time,
    // each waiting for its save, because a burst of saves gets dropped and the form then submits half empty.
    await page.writesSettled(BROWSER.saveMs);
    for (const f of rest) {
      await setFields([f]);
      await sleep(BROWSER.pollMs / 3);
      await page.writesSettled(BROWSER.saveMs);
    }
  } else {
    await setFields(rest);
  }
  for (const f of typeFirst) {
    const why = await typeInto(page, f.selector, f.value);
    if (why) failed.push({ selector: f.selector, why });
    else how.set(f.selector, "typed");
    await page.writesSettled(BROWSER.saveMs);
  }
  for (const f of fills.filter((x) => x.kind === "combobox")) {
    const t = Date.now();
    if (await page.awj<boolean>("isPanel", f.selector)) {
      // A panel already showing an address is left alone: opening it again would only undo it.
      // The site writes the address in its own words ("70121 Bari BA, Italia"), never the plan's.
      panels.add(f.selector);
      // Only an address that names the candidate's postal code or city counts; a country alone (read from a resume) does not.
      const now = norm(await page.awj<string>("shown", f.selector));
      if ([profile.address.postalCode, profile.address.city].some((x) => x && now.includes(norm(x)))) continue;
      // An address panel is searched by the candidate's own postal code, then city, whatever the plan wrote.
      const why = await fillPanel(page, f.selector, [profile.address.postalCode ?? "", profile.address.city], hints);
      if (why) failed.push({ selector: f.selector, why });
      else how.set(f.selector, "clicked");
      panels.add(f.selector);
      await page.writesSettled(BROWSER.saveMs);
      trace(`panel ${f.selector} ${Date.now() - t}ms${why ? ` failed: ${why}` : ""}`);
      continue;
    }
    const { why, method } = await fillDropdown(page, f.selector, f.value, hints, guide?.prefer(f.selector) === "clicked");
    if (why) failed.push({ selector: f.selector, why });
    else how.set(f.selector, method);
    await page.writesSettled(BROWSER.saveMs);
    trace(`dropdown ${f.selector} ${Date.now() - t}ms${why ? ` failed: ${why}` : ""}`);
  }
  // A calendar is clicked through: there is nothing to type.
  for (const f of fills.filter((x) => x.kind === "calendar")) {
    const why = await pickDate(page, f.selector, f.value);
    if (why) failed.push({ selector: f.selector, why });
    else how.set(f.selector, "calendar");
    await page.writesSettled(BROWSER.saveMs);
    trace(`calendar ${f.selector} ${why ?? "ok"}`);
  }
  // A save the server refused means the value is on the page but not in the application.
  const refused = page.takeWrites().failed;
  if (refused.length) {
    trace(`the form's own saves failed: ${refused.join(" | ")}`);
    await sleep(BROWSER.retryAfterMs / 2);
    for (const f of simple) {
      // Set to something else first: an unchanged value would not be saved again.
      if (TYPED_KINDS.has(f.kind)) await setFields([{ ...f, value: "" }]);
      await setFields([f]);
      await sleep(BROWSER.pollMs);
      await page.writesSettled(BROWSER.saveMs);
    }
    const again = page.takeWrites().failed;
    if (again.length) failed.push({ selector: fills[0]?.selector ?? "form", why: `the form's own server refused ${again.length} save(s): ${again[0]}` });
  }
  await page.evaluate("window.__awj.blur()");
  // Trust nothing: read every control back. A value that did not stick gets one retry with real clicks and typing.
  await sleep(BROWSER.pollMs);
  const shown = await shownValues(page, fills.map((f) => f.selector));
  const states = await controlStates(page, fills.map((f) => f.selector));
  for (const [i, f] of fills.entries()) {
    if (states[i] === "off") {
      // The form switched this control off after another answer (an end date once "still a student" is ticked).
      const at = failed.findIndex((x) => x.selector === f.selector);
      if (at >= 0) failed.splice(at, 1);
      continue;
    }
    if (states[i] === "missing") {
      // Not the same as switched off: the page changed under the selector, so the value is unconfirmed.
      if (!failed.some((x) => x.selector === f.selector)) failed.push({ selector: f.selector, why: "the control is no longer on the page" });
      continue;
    }
    // A typed box must show the value it was given, in whatever shape the site writes it. Anything else is a retry.
    const landed = !!shown[i] && (panels.has(f.selector) ? true : !(TYPED_KINDS.has(f.kind) || f.kind === "combobox") || showsValue(f.value, shown[i] ?? ""));
    if (landed) guide?.landed(f.selector, how.get(f.selector) ?? "script");
    if (landed || failed.some((x) => x.selector === f.selector)) continue;
    if (f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)) continue;
    const why = f.kind === "combobox" ? await fillDropdownByClicking(page, f.selector, f.value, hints) : TYPED_KINDS.has(f.kind) ? await typeInto(page, f.selector, f.value) : f.kind === "radio" ? await clickGroupOption(page, f.selector, f.value) : "the page did not keep the value";
    const after = (await shownValues(page, [f.selector]))[0] ?? "";
    if (why || !after) failed.push({ selector: f.selector, why: why ?? "the page did not keep the value" });
    else if ((TYPED_KINDS.has(f.kind) || f.kind === "combobox") && !showsValue(f.value, after)) failed.push({ selector: f.selector, why: `the box shows "${after.slice(0, 40)}" instead of "${f.value.slice(0, 40)}"` });
    else guide?.landed(f.selector, TYPED_KINDS.has(f.kind) ? "typed" : "clicked");
  }
  return failed;
}

export const TYPED_KINDS = new Set(["text", "email", "tel", "url", "number", "textarea"]);

/** A date written out in digits ("25-06-2004", "06/25/2004", "2004-06-25"), a month and year ("01/2022"), or a year alone ("2023"), which year pickers take the same way. */
const DATE_TYPED = /^(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}|\d{1,2}[\/.-]\d{4}|(19|20)\d{2})$/;

/** Types into a field with real key input, for the rare control that ignores a value set from script. */
function typeInto(page: Page, selector: string, value: string): Promise<string | null> {
  return inFront(page, async () => {
    const p = await page.awj<Point>("point", selector);
    if (!p.ok) return "control not found";
    await page.click(p.x, p.y);
    // Keys go wherever the focus is, so no focus on this exact control means no typing.
    if (!(await page.awj<boolean>("hasFocus", selector))) return "could not focus the control";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        // A box that threw the text away may have been waiting for a script of its own, which a tab only loads once it
        // is in front. It is in front now, so give it a moment and type again.
        await sleep(BROWSER.retryAfterMs / 4);
        await page.click(p.x, p.y);
        if (!(await page.awj<boolean>("hasFocus", selector))) break;
      }
      await page.evaluate("window.__awj.selectAll()");
      if (DATE_TYPED.test(value)) {
        await page.key("Backspace");
        await page.typeKeys(value);
      } else await page.type(value);
      // Leave the box the way a person does. Some phone boxes throw away what was typed when focus is taken from them by script.
      // A date box is left with Escape instead: its calendar closes, and Tab would land on the next control and open it.
      if (DATE_TYPED.test(value)) {
        await page.key("Escape");
        await page.evaluate("window.__awj.blur()");
      } else await page.key("Tab");
      await sleep(BROWSER.pollMs);
      if (await page.awj<string>("shown", selector)) break;
    }
    await page.evaluate("window.__awj.blur()");
    return null;
  });
}

/** Picks a choice in a button group or a drawn radio row with a real click, for the group that ignores a click made from script. */
function clickGroupOption(page: Page, selector: string, value: string): Promise<string | null> {
  return inFront(page, async () => {
    const p = await page.awj<Point>("groupOptionPoint", selector, value);
    if (!p.ok) return "the page did not keep the value";
    await page.click(p.x, p.y);
    await sleep(BROWSER.pollMs);
    return null;
  });
}

/** Attaches a file and waits until the form's server has it. A refused upload (a rate limit) gets one unhurried second try. Returns why it failed, or undefined. */
export async function uploadFile(page: Page, selector: string, file: string): Promise<string | undefined> {
  if (await page.awj<boolean>("isFileProxy", selector)) return uploadThroughButton(page, selector, file);
  let why: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(BROWSER.retryAfterMs * 2);
    page.takeWrites();
    if (!(await page.setFiles(selector, attempt ? [] : [file]))) return "file input not found";
    if (attempt) await page.setFiles(selector, [file]);
    if (!(await waitForFile(page, path.basename(file)))) {
      why = "the page did not show the uploaded file";
      continue;
    }
    // The file travels to the form's server in the background; the application only has it once that finishes.
    await sleep(BROWSER.pollMs * 2);
    const settled = await page.writesSettled(BROWSER.uploadMs);
    const refused = page.takeWrites().failed;
    // Some boards (HiBob) show the chosen file in a dialog that keeps it only once its own "Done" is pressed.
    const done = await page.awj<Point>("dialogButton", DIALOG_DONE);
    if (done.ok) {
      await page.click(done.x, done.y);
      await sleep(BROWSER.pollMs * 3);
    }
    if (settled && !refused.length) return undefined;
    why = settled ? `the upload was refused: ${refused[0]}` : "the upload did not finish";
  }
  return why;
}

/** The button that closes an upload dialog once it holds the file. */
const DIALOG_DONE = "^\\s*(done|ok|save|confirm|fatto|salva|conferma|fertig|speichern|ok, fertig|terminé|enregistrer|listo|guardar)\\s*$";

/**
 * A form whose "Add file" button opens a dialog of its own (HiBob): the button is pressed, the file goes into
 * the box the dialog shows, and the dialog is closed with its own button. The form then shows the file.
 */
async function uploadThroughButton(page: Page, selector: string, file: string): Promise<string | undefined> {
  const name = path.basename(file);
  if (!(await page.awj<boolean>("openFileButton", selector))) return "the upload button was not found";
  const deadline = Date.now() + BROWSER.optionsMs * 2;
  while (!(await page.awj<boolean>("pickFileBox"))) {
    if (Date.now() > deadline) return "the upload button brought up no file box";
    await sleep(BROWSER.pollMs);
  }
  if (!(await page.setFiles('[data-awj-picked="1"]', [file]))) return "file input not found";
  if (!(await waitForFile(page, name))) return "the page did not show the uploaded file";
  await sleep(BROWSER.pollMs * 2);
  await page.writesSettled(BROWSER.uploadMs);
  const done = await page.awj<Point>("dialogButton", DIALOG_DONE);
  if (done.ok) {
    await page.click(done.x, done.y);
    await sleep(BROWSER.pollMs * 3);
  }
  return (await page.awj<boolean>("showsFile", name)) ? undefined : "the form did not keep the uploaded file";
}

async function waitForFile(page: Page, name: string): Promise<boolean> {
  const deadline = Date.now() + BROWSER.optionsMs * 2;
  while (Date.now() < deadline) {
    if (await page.awj<boolean>("showsFile", name)) return true;
    await sleep(BROWSER.pollMs);
  }
  return false;
}
