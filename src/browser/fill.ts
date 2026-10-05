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
import { isoOf, PRESENT, showsValue, toYmd } from "../util/dates.js";
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

/** The candidate's city picked where the plan named the region: an Italian list of regions and provinces takes the province (dropdowns.ts). */
export const provinceForRegion = (want: string, shown: string, profile?: Profile) =>
  !!profile && want.trim().toLowerCase() === profile.address.region.trim().toLowerCase() && shown.trim().toLowerCase() === profile.address.city.trim().toLowerCase();

export async function applyFills(page: Page, given: Fill[], profile: Profile, guide?: FillGuide): Promise<Failure[]> {
  // Filling never leaves the page: a "Leave site?" asked meanwhile is answered "stay".
  const was = page.stayOnPage;
  page.stayOnPage = true;
  try {
    return await fillAll(page, given, profile, guide);
  } finally {
    page.stayOnPage = was;
  }
}

async function fillAll(page: Page, given: Fill[], profile: Profile, guide?: FillGuide): Promise<Failure[]> {
  // A browser's own date box (type=date) takes only yyyy-mm-dd, whatever it shows: "January 2022" is written as 2022-01-01.
  let fills = given.map((f) => (f.kind === "date" && toYmd(f.value) ? { ...f, value: isoOf(toYmd(f.value)!) } : f));
  const failed: Failure[] = [];
  // A date drawn as one box per part (Workday's MM / DD / YYYY): the first part is clicked and each part typed in turn,
  // in the order the boxes stand; the boxes move on by themselves.
  for (const f of fills.filter((x) => x.kind === "date")) {
    const parts = await page.awj<(Point & { part: string })[]>("spinParts", f.selector);
    if (parts.length < 2) continue;
    fills = fills.filter((x) => x !== f);
    const d = toYmd(f.value);
    if (!d || !parts[0]?.ok) {
      failed.push({ selector: f.selector, why: d ? "the date boxes cannot be clicked" : `"${f.value}" is not a date` });
      continue;
    }
    const of: Record<string, string> = { m: String(d.month).padStart(2, "0"), d: String(d.day).padStart(2, "0"), y: String(d.year) };
    await inFront(page, async () => {
      await page.click(parts[0]!.x, parts[0]!.y);
      for (const p of parts) await page.typeKeys(of[p.part] ?? "");
      await page.key("Tab");
    });
    await sleep(BROWSER.pollMs * 2);
    if (!(await shownValues(page, [f.selector]))[0]) failed.push({ selector: f.selector, why: "the date boxes did not keep the date" });
  }
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
  const typeFirst = plain.filter((f) => TYPED_KINDS.has(f.kind) && (guide?.prefer(f.selector) === "typed" || (f.kind !== "date" && DATE_TYPED.test(f.value))));
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
      const why = await fillPanel(page, f.selector, [profile.address.postalCode ?? "", profile.address.city], hints, profile.address.line1);
      if (why) failed.push({ selector: f.selector, why });
      else how.set(f.selector, "clicked");
      panels.add(f.selector);
      await page.writesSettled(BROWSER.saveMs);
      trace(`panel ${f.selector} ${Date.now() - t}ms${why ? ` failed: ${why}` : ""}`);
      continue;
    }
    let { why, method } = await fillDropdown(page, f.selector, f.value, hints, guide?.prefer(f.selector) === "clicked");
    // A state or province list without the candidate's region lists provinces, named after their main town: the city
    // is tried next ("Puglia" missing, "Bari" there).
    const region = [profile.address.region, profile.address.regionCode].filter(Boolean).map((x) => norm(x as string));
    if (why && f.required !== false && /no option matches/.test(why) && region.includes(norm(f.value)) && profile.address.city) {
      const again = await fillDropdown(page, f.selector, profile.address.city, hints, true);
      if (!again.why) ({ why, method } = { why: null, method: again.method });
      trace(`dropdown ${f.selector}: region "${f.value}" not listed, city "${profile.address.city}" ${again.why ? "not listed either" : "picked"}`);
    }
    if (why) failed.push({ selector: f.selector, why });
    else how.set(f.selector, method);
    await page.writesSettled(BROWSER.saveMs);
    trace(`dropdown ${f.selector} ${Date.now() - t}ms${why ? ` failed: ${why}` : ""}`);
  }
  // A list that matched nothing may hang on another set after it (a state list filled once the country is chosen): it
  // is tried once more now that every list holds its value.
  // Only a required one: an optional list that took nothing is left empty, with no more time spent on it.
  for (const f of fills.filter((x) => x.kind === "combobox" && x.required !== false && !panels.has(x.selector))) {
    const at = failed.findIndex((x) => x.selector === f.selector && /no option matches/.test(x.why));
    if (at < 0) continue;
    const region = [profile.address.region, profile.address.regionCode].filter(Boolean).map((x) => norm(x as string));
    const tries = region.includes(norm(f.value)) && profile.address.city ? [f.value, profile.address.city] : [f.value];
    for (const value of tries) {
      const { why, method } = await fillDropdown(page, f.selector, value, hints, true);
      trace(`dropdown ${f.selector}: "${value}" again after the other lists: ${why ?? "picked"}`);
      if (why) continue;
      failed.splice(at, 1);
      how.set(f.selector, method);
      break;
    }
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
    const landed = !!shown[i] && (panels.has(f.selector) ? true : !(TYPED_KINDS.has(f.kind) || f.kind === "combobox") || showsValue(f.value, shown[i] ?? "") || provinceForRegion(f.value, shown[i] ?? "", profile));
    if (landed) guide?.landed(f.selector, how.get(f.selector) ?? "script");
    if (landed || failed.some((x) => x.selector === f.selector)) continue;
    if (f.kind === "checkbox" && !/^(true|yes|1|on|checked)$/i.test(f.value)) continue;
    const why = f.kind === "combobox" ? await fillDropdownByClicking(page, f.selector, f.value, hints) : TYPED_KINDS.has(f.kind) ? await typeInto(page, f.selector, f.value) : f.kind === "radio" ? await clickGroupOption(page, f.selector, f.value) : "the page did not keep the value";
    const after = (await shownValues(page, [f.selector]))[0] ?? "";
    if (why || !after) failed.push({ selector: f.selector, why: why ?? "the page did not keep the value" });
    else if ((TYPED_KINDS.has(f.kind) || f.kind === "combobox") && !showsValue(f.value, after) && !provinceForRegion(f.value, after, profile)) failed.push({ selector: f.selector, why: `the box shows "${after.slice(0, 40)}" instead of "${f.value.slice(0, 40)}"` });
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
    let p = await page.awj<Point>("point", selector);
    if (!p.ok) return "control not found";
    // A slider is set to the number in the value; it has nothing to type into.
    if ((await page.awj<string | null>("setRange", selector, value)) !== null) return null;
    // A box that already shows this value (a date the site read from the resume: "01/2022" for 2022-01-01) keeps it.
    const before = await page.awj<string>("shown", selector);
    if (before && showsValue(value, before)) return null;
    await page.click(p.x, p.y);
    if (!(await page.awj<boolean>("hasFocus", selector))) {
      // A calendar left open by the box before can lie over this one and take the click (inRecruiting's month boxes,
      // one under the other): it is closed, and the box clicked again, then focused from script.
      await page.key("Escape");
      await page.evaluate("window.__awj.blur()");
      await sleep(BROWSER.pollMs);
      p = await page.awj<Point>("point", selector);
      if (p.ok) await page.click(p.x, p.y);
      if (!(await page.awj<boolean>("hasFocus", selector))) await page.awj<boolean>("focus", selector);
    }
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
      // A box that Escape puts back the way it was (UI5's date picker on SuccessFactors) is typed again and left with Tab.
      if (DATE_TYPED.test(value)) {
        await page.key("Escape");
        await sleep(BROWSER.pollMs);
        // Put back means empty, or the date the box held before (a profile the site kept from an earlier application).
        if (!showsValue(value, await page.awj<string>("shown", selector)) && (await page.awj<boolean>("focus", selector))) {
          await page.evaluate("window.__awj.selectAll()");
          await page.key("Backspace");
          await page.typeKeys(value);
          await page.key("Tab");
        }
        await page.evaluate("window.__awj.blur()");
      } else await page.key("Tab");
      await sleep(BROWSER.pollMs);
      const kept = await page.awj<string>("shown", selector);
      if (DATE_TYPED.test(value)) trace(`typed date into ${selector.slice(-40)}, try ${attempt + 1}: the box shows "${kept}"`);
      if (kept && (!DATE_TYPED.test(value) || showsValue(value, kept))) break;
    }
    // A date box that names no format and threw the date away (Cornerstone's work entry takes "01/2022" only) is given
    // the same date in the other ways boxes write one, month and year first. "Present" for the job the candidate still
    // holds is this month, in a box that has no word for it.
    if (!(await page.awj<string>("shown", selector))) {
      for (const other of otherDateShapes(value)) {
        if (!(await page.awj<boolean>("focus", selector))) break;
        await page.evaluate("window.__awj.selectAll()");
        await page.key("Backspace");
        await page.typeKeys(other);
        await page.key("Escape");
        await page.evaluate("window.__awj.blur()");
        await sleep(BROWSER.pollMs);
        const kept = await page.awj<string>("shown", selector);
        trace(`typed date into ${selector.slice(-40)} as "${other}": the box shows "${kept}"`);
        if (kept) break;
      }
    }
    await page.evaluate("window.__awj.blur()");
    return null;
  });
}

/** The same date in the shapes a box with no stated format may want: month/year, then the full date both ways when the day cannot be misread. */
export function otherDateShapes(value: string, today = new Date()): string[] {
  const d = PRESENT.test(value.trim()) ? { year: today.getFullYear(), month: today.getMonth() + 1, day: 1 } : toYmd(value);
  if (!d || !(DATE_TYPED.test(value) || PRESENT.test(value.trim()) || /\d{4}/.test(value))) return [];
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  const shapes = [`${mm}/${d.year}`, `${mm}-${d.year}`];
  // 03/04/2022 reads two ways; a day that is also a possible month only goes in when both readings are the same day.
  if (d.day > 12 || d.day === d.month) shapes.push(`${mm}/${dd}/${d.year}`, `${dd}/${mm}/${d.year}`);
  return [...new Set(shapes)].filter((s) => s !== value);
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

/**
 * The button that closes an upload dialog once it holds the file. A photo is often shown in a crop dialog first
 * (Workable: "Crop your photo", then "Upload"); the form holds the photo only once that is pressed.
 */
const DIALOG_DONE =
  "^\\s*(done|ok|save|confirm|fatto|salva|conferma|fertig|speichern|ok, fertig|terminé|enregistrer|listo|guardar|" +
  "upload|crop|apply|use (this )?(photo|image)|carica|ritaglia|applica|usa (questa )?(foto|immagine)|hochladen|zuschneiden|übernehmen|télécharger|recadrer|appliquer|subir|recortar|aplicar)\\s*$";

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
