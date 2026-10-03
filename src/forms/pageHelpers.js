// Runs inside the page through the fill runner (src/browser/formRunner.ts).
// Installs window.__awj: small read-only helpers plus the two writes the
// runner cannot do with real input events. Nothing here is page-supplied code.
(() => {
  // Forms drawn with web components keep their controls in open shadow roots. A selector reaches one through its
  // hosts, joined by " >>> " (dumpFields writes them): "spl-input#email-input >>> #email-input".
  const SHADOW = " >>> ";
  const q = (s) => {
    const parts = s.split(SHADOW);
    let root = document;
    let el = null;
    for (const [i, part] of parts.entries()) {
      el = root.querySelector(part);
      if (!el) return null;
      if (i < parts.length - 1) {
        root = el.shadowRoot;
        if (!root) return null;
      }
    }
    return el;
  };
  // Every element matching sel, in page order, inside open shadow roots too.
  const deepAll = (sel, root = document) => {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.matches(sel)) out.push(el);
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    }
    return out;
  };
  // Elements under el matching sel, the ones handed into its <slot>s from outside included: a web component's group
  // (SmartRecruiters' spl-radio-group) draws its frame in its shadow root and takes its options through a slot.
  const withSlotted = (el, sel) => {
    const out = [...el.querySelectorAll(sel)];
    for (const slot of el.querySelectorAll("slot")) {
      for (const n of slot.assignedElements({ flatten: true })) {
        if (n.matches(sel)) out.push(n);
        out.push(...n.querySelectorAll(sel));
      }
    }
    return [...new Set(out)];
  };
  // One step up the page, out of a shadow root into its host when the root is reached.
  const up = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  // The words of a button, or of the web component that draws it (<spl-button>Save</spl-button>).
  const buttonWords = (x) => text(x) || (x.getRootNode() instanceof ShadowRoot ? text(x.getRootNode().host) : "");
  // The element that has the keyboard, inside a shadow root when the focus is there.
  const activeEl = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  // An element by id, in el's own shadow root first, then in the roots around it, then anywhere.
  const byIdNear = (el, id) => {
    for (let root = el.getRootNode(); root; root = root instanceof ShadowRoot ? root.host.getRootNode() : null) {
      const found = root.getElementById ? root.getElementById(id) : null;
      if (found) return found;
    }
    return deepAll(`[id="${attr(id)}"]`)[0] || null;
  };
  // The page's words in reading order, the words drawn inside shadow roots included. innerText leaves those out.
  const flatText = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    let block = false;
    if (node.nodeType === 1) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return "";
      const st = getComputedStyle(node);
      if (st.display === "none" || st.visibility === "hidden") return "";
      block = !/^inline/.test(st.display) && st.display !== "contents";
      if (node.tagName === "SLOT") {
        const given = node.assignedNodes({ flatten: true });
        return (given.length ? given : [...node.childNodes]).map(flatText).join("");
      }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) return "";
    }
    const kids = node.nodeType === 1 && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    const inner = [...kids].map(flatText).join("");
    return block ? `\n${inner}\n` : inner;
  };
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // The words of an element. An icon's fallback text ("SVGs not supported by this browser.") is not one of them.
  // An element drawn by a web component (an option, a button) may hold its words only in its shadow root.
  // A <slot> inside it shows words handed in from outside, often passed on through several components.
  const holdsShadow = (el) => !!el.shadowRoot || !!el.querySelector("slot") || [...el.querySelectorAll("*")].some((x) => x.shadowRoot);
  const text = (el) => {
    if (!el) return "";
    let t = el.innerText || el.textContent || "";
    // A label may show only its "*" in its own words and take the question through a slot: the fuller reading wins.
    if (el.nodeType === 1 && holdsShadow(el)) { const flat = flatText(el); if (flat.trim().length > t.trim().length) t = flat; }
    return t.replace(/SVGs? not supported by this browser\.?/gi, "").replace(/\s+/g, " ").trim();
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const center = (el) => {
    // Instant: a page with smooth scrolling would otherwise report the position before the scroll.
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 };
  };
  // Only a dropdown's own frame counts: a looser match would land clicks on some unrelated wrapper.
  const control = (el) => {
    if (el.getAttribute("role") !== "combobox") return el;
    const frame = el.closest('[class*="select__control"], [class$="-control"]');
    if (frame) return frame;
    // A search box that is only drawn while its list is open: the closed dropdown around it is what gets clicked.
    const r = el.getBoundingClientRect();
    return (r.width === 0 || r.height === 0) && el.closest('[data-testid="select-controller"]') ? el.closest('[data-testid="select-controller"]') : el;
  };
  // The list a picker opens: named by aria-controls or aria-owns, or by the menu id a button carries (BambooHR).
  const listRootOf = (el) => {
    const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || el.getAttribute("data-menu-id");
    return listId ? byIdNear(el, listId) : null;
  };
  const optionEls = (sel) => {
    const el = q(sel);
    if (!el) return [];
    let root = listRootOf(el);
    if (!root) {
      const wrap = el.closest('[class*="container"], [class*="select"], [class*="field"], [class*="question"]');
      root = wrap ? wrap.querySelector('[role=listbox], [class*="menu"]') : null;
    }
    if (!root) {
      // A plain input with a suggestion list beside it: its rows are the options.
      const box = el.parentElement && el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i] ul, [class*="typeahead" i] ul, [class*="suggestions" i]');
      if (box) return [...box.children].filter(visible);
    }
    if (!root) {
      // A list the page draws from a <datalist> beside the input.
      const list = el.parentElement && el.parentElement.querySelector("datalist, [role=listbox]");
      if (list) return [...list.querySelectorAll("option, [role=option]")].filter(visible);
    }
    if (!root && el.getAttribute("aria-expanded") !== "true") return [];
    const own = root ? deepAll(root.tagName === "DATALIST" ? "option, [role=option]" : "[role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]", root).filter(visible) : [];
    if (own.length) return own;
    // A menu drawn as a list of radio buttons or checkboxes (Teamtailor's choice questions): their labels are the options.
    if (root) {
      const boxes = [...root.querySelectorAll("input[type=radio], input[type=checkbox]")];
      const labels = boxes.map((b) => (b.id && root.querySelector(`label[for="${CSS.escape(b.id)}"]`)) || b.closest("label")).filter((l) => l && visible(l));
      if (labels.length) return labels;
    }
    // A list drawn by web components holds its options through slots (SmartRecruiters' spl-select): they are not
    // inside it in the page's tree, so the options shown anywhere on the page are the open list's.
    return deepAll("[role=option]").filter((o) => !o.closest(".iti") && visible(o));
  };
  // Dropdown components keep their option list and their select handler on their own props.
  // Reading them is instant and needs no clicking. Two shapes are known:
  //   "select": react-select (Greenhouse). options + selectOption, and loadOptions when the list is lazy.
  //   "search": a search box with results (Ashby schools and locations). onSearch + results + onSelect.
  // For anything else these return null and the runner opens the dropdown with real clicks.
  const adapter = (el) => {
    const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let f = key ? el[key] : null;
    if (!f) return null;
    // The node may hold the previous render's fiber; the live tree is the one its root points at.
    let top = f;
    while (top.return) top = top.return;
    if (top.stateNode && top.stateNode.current && top.stateNode.current !== top && f.alternate) f = f.alternate;
    for (let i = 0; f && i < 12; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (typeof p.selectOption === "function" && Array.isArray(p.options)) return { shape: "select", p };
      if (typeof p.onSelect === "function" && typeof p.onSearch === "function") return { shape: "search", p };
    }
    return null;
  };
  const loaded = {};
  const flat = (options) => options.flatMap((o) => (o && Array.isArray(o.options) ? o.options : [o]));
  const labelOf = (a, o) => {
    const get = a.shape === "select" && a.p.selectProps && a.p.selectProps.getOptionLabel;
    const l = typeof get === "function" ? get(o) : o.label;
    return String(typeof l === "string" || typeof l === "number" ? l : o.label ?? o.name ?? o.placeName ?? o.title ?? o.value ?? "").replace(/\s+/g, " ").trim();
  };
  const optionsOf = (a) => (a.shape === "select" ? flat(a.p.options) : a.p.results || []);
  window.__awj = {
    /** Option labels straight from the component, or null when the control is not one of the known shapes. */
    reactOptions(sel) {
      const a = adapter(q(sel));
      return a ? optionsOf(a).map((o) => labelOf(a, o)) : null;
    },
    /** Starts a search in a search-as-you-type dropdown without touching the keyboard. */
    reactSearch(sel, typed) {
      const a = adapter(q(sel));
      if (!a) return false;
      if (a.shape === "search") {
        a.p.onSearch(typed);
        return true;
      }
      const onInput = a.p.selectProps && a.p.selectProps.onInputChange;
      if (typeof onInput !== "function") return false;
      onInput(typed, { action: "input-change", prevInputValue: "" });
      if (!typed && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Opens or closes a react-select's menu through its own handlers, which is what makes a lazy list load. */
    reactMenu(sel, open) {
      const a = adapter(q(sel));
      const fn = a && a.shape === "select" && a.p.selectProps && (open ? a.p.selectProps.onMenuOpen : a.p.selectProps.onMenuClose);
      if (typeof fn !== "function") return false;
      fn();
      return true;
    },
    /**
     * Asks a paginated or lazy select for its options through its own loader, with a search text.
     * Returns the labels, or null when the control has no loader. The option objects are kept for reactSelect.
     */
    async reactLoad(sel, search) {
      const a = adapter(q(sel));
      const load = a && a.shape === "select" && a.p.selectProps && a.p.selectProps.loadOptions;
      if (typeof load !== "function") return null;
      const res = await load(search, [], a.p.selectProps.additional);
      const options = flat(Array.isArray(res) ? res : (res && res.options) || []);
      loaded[sel] = options;
      return options.map((o) => labelOf(a, o));
    },
    reactSelect(sel, label) {
      const a = adapter(q(sel));
      if (!a) return false;
      const o = optionsOf(a).find((x) => labelOf(a, x) === label) || (loaded[sel] || []).find((x) => labelOf(a, x) === label);
      if (!o) return false;
      if (a.shape === "search") {
        a.p.onSelect(o);
        return true;
      }
      a.p.selectOption(o);
      if (a.p.selectProps && typeof a.p.selectProps.onMenuClose === "function") a.p.selectProps.onMenuClose();
      return true;
    },
    /** Centre of the control to click, after scrolling it into view. */
    point(sel) {
      const el = q(sel);
      return el && visible(control(el)) ? center(control(el)) : { x: 0, y: 0, ok: false };
    },
    /**
     * "on" for a control that can take a value, "off" for one the form has hidden or disabled
     * (usually because of another answer), "missing" when the selector no longer finds anything.
     */
    state(sel) {
      const el = q(sel);
      if (!el) return "missing";
      // A box drawn by its label counts as there when the label is.
      const label = (el.type === "radio" || el.type === "checkbox") && (el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("[role=checkbox]"));
      // A select drawn by select2 counts as there when the box beside it is.
      const select2 = el.tagName === "SELECT" && /select2-hidden/.test(el.className) && el.nextElementSibling;
      return !el.disabled && (el.type === "file" || visible(el) || visible(control(el)) || (label && visible(label)) || (select2 && visible(select2))) ? "on" : "off";
    },
    /** True when keyboard input would land in this control right now. */
    hasFocus(sel) {
      const el = q(sel);
      if (!el) return false;
      // A menu that opened with its own search box took the keyboard on purpose: typing goes to the list.
      const list = listRootOf(el);
      const a = activeEl();
      return a === el || el.contains(a) || (!!list && list.contains(a));
    },
    /** Puts the keyboard in a text box. False for anything that is not one, or that would not take it. */
    focus(sel) {
      const el = q(sel);
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
      el.focus();
      return activeEl() === el;
    },
    selectAll() {
      const a = activeEl();
      if (a && typeof a.select === "function") a.select();
    },
    options(sel) {
      return optionEls(sel).map(text);
    },
    /**
     * Empties the search box inside a list's own menu (Teamtailor's "Cerca"), so the whole list shows again after an
     * earlier search left it filtered. True when there was something to clear.
     */
    clearListSearch(sel) {
      const el = q(sel);
      const root = el && listRootOf(el);
      const box = root && [...root.querySelectorAll('input[type=search], input[type=text]')].find((b) => b.value);
      if (!box) return false;
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      desc.set.call(box, "");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    optionPoint(sel, label) {
      const o = optionEls(sel).find((x) => text(x) === label);
      return o ? center(o) : { x: 0, y: 0, ok: false };
    },
    /**
     * The calendar that belongs to a date box, as the runner needs it to click through: whether it
     * is open, the month it shows, where its two arrows are, and where each day of that month is.
     */
    /**
     * Sets a date through the picker library that draws the box, when it is one that offers that (flatpickr keeps its
     * instance on the input). The library then writes the box and tells the form, as a click on the day would.
     * Returns false when the box has no such picker.
     */
    pickerSet(sel, iso) {
      const el = q(sel);
      const fp = el && el._flatpickr;
      if (!fp || typeof fp.setDate !== "function") return false;
      fp.setDate(iso, true);
      if (typeof fp.close === "function") fp.close();
      return true;
    },
    calendar(sel) {
      const closed = { open: false, heading: "", prev: { x: 0, y: 0, ok: false }, next: { x: 0, y: 0, ok: false }, days: [] };
      const el = q(sel);
      if (!el) return closed;
      const PICKER = '[class*="date-picker" i], [class*="datepicker" i], [class*="calendar" i], [role=dialog], [role=grid]';
      const item = el.closest("[variant], [class*=form-item i], [class*=field i]") || el.parentElement;
      // The pop-up sits in the field itself, or the page draws it at the end of the document.
      const isDay = (n) => /^\d{1,2}$/.test(text(n));
      // A calendar is whatever holds a week or more of day numbers. A calendar icon matches the same words and holds none.
      const holdsDays = (p) => p instanceof HTMLElement && visible(p) && [...p.querySelectorAll("button, td, [role=gridcell]")].filter((n) => visible(n) && isDay(n)).length >= 7;
      const near = item ? [...item.querySelectorAll(PICKER)].filter(holdsDays) : [];
      const anywhere = near.length ? near : [...document.querySelectorAll(PICKER)].filter(holdsDays);
      const pop = anywhere.find((p) => !anywhere.some((o) => o !== p && o.contains(p)));
      if (!pop) return closed;
      const MONTH = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s,]+\d{4}|\d{4}[\s,]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
      const OUTSIDE = /not-this-month|outside|other-month|adjacent|prev-month|next-month|disabled|muted/i;
      const cells = [...pop.querySelectorAll('button, td, [role=gridcell], [class*="day" i]')].filter((n) => visible(n) && isDay(n) && !n.querySelector('button, td, [role=gridcell]'));
      const days = cells.filter((n) => !OUTSIDE.test(String(n.getAttribute("class") || "")) && n.getAttribute("aria-disabled") !== "true" && !n.disabled);
      if (!cells.length) return closed;
      const first = cells[0];
      const headingEl = [...pop.querySelectorAll("*")].find((n) => n.children.length === 0 && MONTH.test(text(n)) && text(n).length < 30 && (n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
      // Pickers with a month list and a year box have no single heading: their header's text is read whole.
      const selects = [...pop.querySelectorAll("select")].filter(visible).map((s2) => text(s2.selectedOptions[0]));
      const yearBox = [...pop.querySelectorAll('input[type=number], input[class*="year" i]')].filter(visible).map((i) => i.value);
      const heading = headingEl ? text(headingEl) : [...selects, ...yearBox].join(" ");
      // The arrows are the buttons above the days that are not days. By name when they are named, else first and last.
      const arrows = [...pop.querySelectorAll('button, [role=button], a, [class*="nav" i], [class*="arrow" i]')].filter((n) => visible(n) && !isDay(n) && !cells.includes(n) && (n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
      const named = (re) => arrows.find((n) => re.test(`${n.getAttribute("aria-label") || ""} ${n.getAttribute("class") || ""} ${n.title || ""}`));
      const prev = named(/prev|back|earlier|left/i) || arrows[0];
      const next = named(/next|forward|later|right/i) || arrows[arrows.length - 1];
      // The pop-up is brought into view once, and every point is then read without scrolling again:
      // points read at different scroll positions would not belong to the same picture.
      pop.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const at = (n) => {
        if (!n) return { x: 0, y: 0, ok: false };
        const r = n.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight };
      };
      return { open: true, heading, prev: at(prev), next: prev === next ? { x: 0, y: 0, ok: false } : at(next), days: days.map((n) => ({ day: Number(text(n)), ...at(n) })).filter((d) => d.ok) };
    },
    /** Centre of one choice in a button group or a drawn radio row, for a real click. */
    groupOptionPoint(sel, label) {
      const el = q(sel);
      if (!el) return { x: 0, y: 0, ok: false };
      const want = label.toLowerCase().trim();
      const o = withSlotted(el, "button, [role=radio], [role=option], label").find((x) => visible(x) && text(x).toLowerCase() === want);
      return o ? center(o) : { x: 0, y: 0, ok: false };
    },
    /** What the control shows as its current value. */
    shown(sel) {
      const el = q(sel);
      if (!el) return "";
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.type === "radio" && el.name) {
          const on = [...document.querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`)].find((r) => r.checked);
          return on ? text(on.closest("label") || (on.id && document.querySelector(`label[for="${CSS.escape(on.id)}"]`)) || on.parentElement) || on.value : "";
        }
        return el.checked ? "checked" : "";
      }
      if (el.type === "file") {
        const wrap = el.closest('[class*="field"], [class*="upload"], [class*="file"], fieldset, div');
        return el.files && el.files.length ? el.files[0].name : /\.pdf/i.test(text(wrap)) ? text(wrap).slice(0, 80) : "";
      }
      if (el.tagName === "SELECT") return el.selectedOptions[0] && el.value !== "" ? text(el.selectedOptions[0]) : "";
      if (window.__awj.isPanel(sel)) return el.querySelector("input:not([type=hidden])").value || "";
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && (el.getAttribute("role") === "combobox" || el.hasAttribute("aria-haspopup"))) {
        // A dropdown drawn without an input shows its value as its own text, or a placeholder when empty.
        const t = text(el);
        // A placeholder, in any language and said twice (once for screen readers), is no choice.
        return t.replace(/(select an option|select one|please select|select\.\.\.|select|choose|search|seleziona (un'opzione|una o più opzioni|una opzione)|seleziona|scegli (un'opzione)?|bitte wählen|auswählen|sélectionner une option|sélectionner|choisir|selecciona una opción|seleccionar|selecciona)/gi, "").replace(/[-–—\s]/g, "") === "" ? "" : t;
      }
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
        // A button group: the pressed button's text.
        const on = withSlotted(el, "button, [role=radio], [role=option]").find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked");
        return on ? text(on) : "";
      }
      if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") {
        const a = adapter(el);
        if (a && a.shape === "select" && typeof a.p.getValue === "function") return a.p.getValue().map((o) => labelOf(a, o)).join(", ");
        if (a && a.shape === "search") return a.p.selectedItemText || el.value || "";
        // Selectize keeps the picks as items beside an input that stays empty.
        const selectize = el.closest(".selectize-input");
        if (selectize) return [...selectize.querySelectorAll(".item")].map(text).join(", ") || el.value || "";
        // A multiselect empties its box after each pick and marks the picks in its list (SmartRecruiters' spl-multiselect).
        const list = listRootOf(el);
        if (!el.value && list && list.getAttribute("aria-multiselectable") === "true") {
          const picked = [...list.querySelectorAll("*")].filter((o) => o.getAttribute("aria-selected") === "true" || o.selected === true).map(text).filter(Boolean);
          if (picked.length) return [...new Set(picked)].join(", ");
        }
        const c = control(el);
        const single = c.querySelector('[class*="single-value"], [class*="singleValue"]');
        const multi = [...c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue"]')].map(text).join(", ");
        return single ? text(single) : multi || el.value || "";
      }
      return el.value || "";
    },
    /** A combobox drawn around a switched-off box that opens a panel of fields of its own (inRecruiting's address). */
    isPanel(sel) {
      const el = q(sel);
      if (!el || el.getAttribute("role") !== "combobox" || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return false;
      const inner = el.querySelectorAll("input:not([type=hidden]), select, textarea");
      return inner.length === 1 && inner[0].disabled;
    },
    /**
     * The boxes an open panel shows that take typing, in page order, each marked with data-awj-panel so it can
     * be focused and typed into. The panel is the nearest box around the trigger that holds more fields.
     */
    panelBoxes(sel) {
      const el = q(sel);
      if (!el) return [];
      let root = el.parentElement;
      while (root && root.querySelectorAll("input:not([type=hidden])").length < 2) root = root.parentElement;
      if (!root) return [];
      const own = el.querySelector("input");
      return [...root.querySelectorAll("input:not([type=hidden])")]
        .filter((b) => b !== own && visible(b) && !b.disabled && !b.readOnly && (b.type || "text") === "text")
        .map((b, i) => {
          b.setAttribute("data-awj-panel", String(i));
          // The label sits beside the box's own wrapper, so look outward until a wrapper holds one.
          let lab = b.id ? document.querySelector(`label[for="${attr(b.id)}"]`) : null;
          for (let g = b.parentElement, depth = 0; !lab && g && g !== root && depth < 5; g = g.parentElement, depth++) {
            const found = g.querySelector("label");
            if (found && g.querySelectorAll("input:not([type=hidden])").length === 1) lab = found;
          }
          return { selector: `[data-awj-panel="${i}"]`, label: text(lab), value: b.value || "" };
        });
    },
    /** The panel's country box, when it has one, marked data-awj-panel="country". */
    panelCountry(sel) {
      const box = window.__awj.panelBoxes(sel).find((b) => /\b(nazione|country|paese|land|pays|pa[ií]s|stato)\b/i.test(b.label));
      if (!box) return null;
      q(box.selector).setAttribute("data-awj-panel", "country");
      return { ...box, selector: '[data-awj-panel="country"]' };
    },
    /** The suggestions on the page that name the typed text, with where to click each. */
    suggestions(typed) {
      const want = typed.toLowerCase();
      const rows = deepAll('[role=option], li, .dropdown-item, [class*="option" i], [class*="suggest" i] > *')
        .filter((o) => visible(o) && o.children.length <= 3 && text(o).toLowerCase().includes(want) && text(o).length < 120);
      return rows.slice(0, 20).map((o) => ({ label: text(o), ...center(o) }));
    },
    /** True when the page shows this file name, which is how an accepted upload looks once the input is replaced. */
    /**
     * Some boards (HiBob) have no file box until their "Add file" button is pressed: the button makes one and
     * opens the file picker. Each such button is pressed once with the picker held back, and the box it makes
     * is kept in the page next to the button, where the form reader finds it like any other file box.
     */
    // Only a stand-in is placed now: pressing the button opens a dialog, which would cover the form while it fills.
    // The button is pressed at upload time (openFileButton), and the file box it brings up is marked (pickFileBox).
    exposeFileButtons() {
      let made = 0;
      for (const b of document.querySelectorAll("button, [role=button]")) {
        if (!visible(b) || !/^(aggiungi file|carica file|allega file|add file|upload file|choose file|select file|datei hinzuf(ü|u)gen|ajouter un fichier)$/i.test(text(b))) continue;
        const box = b.closest("div, section, fieldset");
        if (!box || box.querySelector("input[type=file]")) continue;
        const n = String(document.querySelectorAll("[data-awj-proxy]").length);
        const proxy = document.createElement("input");
        proxy.type = "file";
        proxy.style.display = "none";
        proxy.setAttribute("data-awj-proxy", n);
        b.setAttribute("data-awj-proxy-button", n);
        b.parentElement.appendChild(proxy);
        made++;
      }
      return made;
    },
    isFileProxy(sel) {
      const el = q(sel);
      return !!el && el.hasAttribute("data-awj-proxy");
    },
    /** Presses the button behind a stand-in file box. A file box it makes on the spot opens no picker: it is kept in the page instead. */
    openFileButton(sel) {
      const proxy = q(sel);
      const b = proxy && document.querySelector(`[data-awj-proxy-button="${proxy.getAttribute("data-awj-proxy")}"]`);
      if (!b) return false;
      window.__awjBefore = new Set(document.querySelectorAll("input[type=file]"));
      window.__awjMade = null;
      const proto = HTMLInputElement.prototype;
      if (!proto.__awjClick) {
        proto.__awjClick = proto.click;
        proto.click = function () {
          if (this.type === "file" && window.__awjBefore) {
            window.__awjMade = this;
            if (!this.isConnected) document.body.appendChild(this);
            return;
          }
          return proto.__awjClick.call(this);
        };
      }
      b.click();
      return true;
    },
    /** Marks the file box the last pressed button brought up, in a dialog or made on the spot. */
    pickFileBox() {
      const before = window.__awjBefore;
      if (!before) return false;
      const fresh = window.__awjMade || [...document.querySelectorAll("input[type=file]")].find((i) => !before.has(i) && !i.hasAttribute("data-awj-proxy"));
      if (!fresh) return false;
      document.querySelectorAll("[data-awj-picked]").forEach((x) => x.removeAttribute("data-awj-picked"));
      fresh.setAttribute("data-awj-picked", "1");
      window.__awjBefore = null;
      window.__awjMade = null;
      return true;
    },
    /** A button inside an open dialog whose words match, so a dialog's own "Done" is pressed and not a look-alike on the page. */
    dialogButton(pattern) {
      const re = new RegExp(pattern, "i");
      const dialogs = [...document.querySelectorAll("[role=dialog], [aria-modal=true], .cdk-overlay-container, .modal, [class*=dialog i]")].filter(visible);
      for (const d of dialogs) {
        const b = [...d.querySelectorAll("button, [role=button]")].find((x) => visible(x) && re.test(text(x)));
        if (b) return { ...center(b), ok: true };
      }
      return { x: 0, y: 0, ok: false };
    },
    showsFile(name) {
      return window.__awj.pageText().includes(name) || deepAll("input[type=file]").some((i) => i.files && [...i.files].some((f) => f.name === name));
    },
    blur() {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    },
    errors() {
      return deepAll('[aria-invalid="true"], [class*="error" i]').filter(visible).map(text).filter((t) => t && t.length < 200).slice(0, 20);
    },
    pageText() {
      if (!document.body) return "";
      // A page with no shadow roots is read as before; one that draws its words in them is walked whole.
      if (![...document.querySelectorAll("*")].some((el) => el.shadowRoot)) return document.body.innerText;
      return flatText(document.body).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    },
    /**
     * The first Add button of a section the form fills one entry at a time and that still want one: "Experience *", an Add
     * button, "Please provide at least one work experience entry". Where to click each, and the section's words.
     */
    entryAdds() {
      const ADD = /^\s*\+?\s*(add|aggiungi|hinzufügen|ajouter|añadir|agregar|adicionar|toevoegen)\s*$/i;
      const MISSING = /\b(at least one|almeno una?|mindestens (ein|eine)|au moins une?|al menos una?|pelo menos uma?)\b/i;
      const out = [];
      const seen = new Set();
      for (const b of deepAll("button, [role=button]")) {
        const own = buttonWords(b);
        if (!visible(b) || !ADD.test(own)) continue;
        // A web component's inner button and its host are one button.
        const host = b.getRootNode() instanceof ShadowRoot ? b.getRootNode().host : b;
        if (seen.has(host)) continue;
        seen.add(host);
        // The section wants an entry when it says so, or when it is still only its required heading and its Add.
        let box = b;
        let header = "";
        let wants = false;
        for (let i = 0; i < 8 && box; i++) {
          box = up(box);
          const said = box ? text(box) : "";
          if (!said) break;
          if (MISSING.test(said) && said.length <= 400) { wants = true; break; }
          if (!header) {
            const rest = said.replace(own, "").trim();
            if (rest === "") continue;
            if (/^.{1,60}[*✱]$/.test(rest)) { header = said; continue; }
            break;
          }
          if (said === header) continue;
          // The first box around the heading that holds more: the section's saved entries, or, past an empty section,
          // the rest of the form (fields to fill, other sections' Add buttons).
          const beyond = deepAll("input:not([type=hidden]), select, textarea", box).some(visible) || deepAll("button, [role=button]", box).filter((x) => visible(x) && ADD.test(buttonWords(x))).length > 1;
          wants = beyond || said.replace(header, "").trim() === "";
          break;
        }
        if (!wants) continue;
        out.push({ b, section: (header || (box ? text(box) : own)).slice(0, 120) });
      }
      // Only the first is brought into view and measured: measuring another would scroll the page and move the first.
      return out.slice(0, 1).map((o) => ({ ...center(o.b), section: o.section }));
    },
    /** The Save of the entry a field belongs to: the nearest Save, Done or OK around it, for a real click. */
    entrySave(sel) {
      const SAVE = /^\s*(save|salva|salvare|done|fatto|ok|speichern|enregistrer|guardar|salvar|opslaan)\s*$/i;
      let box = q(sel);
      for (let i = 0; box && i < 16; i++) {
        box = up(box);
        if (!box) break;
        const hit = deepAll("button, [role=button]", box).find((x) => visible(x) && SAVE.test(buttonWords(x)));
        if (hit) return center(hit);
      }
      return { x: 0, y: 0, ok: false };
    },
    /** Finds a control by its selector, through shadow roots. */
    q(sel) {
      return q(sel);
    },
    /**
     * Where a page reports a sent application outside its words: a part of its address, or the id or class of a part
     * it shows (an inRecruiting confirmation shows the posting again, with message=confirmMessage in the address and an
     * empty "containerSuccessValidationForm"). Buttons, links and fields are left out, and so are colour classes
     * ("btn-success", "text-success"). These are clues for the page-state question, never a verdict on their own.
     */
    successSignals() {
      const re = /success|thank|grazie|confirm(?:ation|ed|msg|message|page)|conferma(?:ta|to|zione)|submitted|ricevut|inviat|completed|danke|merci|gracias/i;
      const out = [];
      try {
        const u = new URL(location.href);
        for (const [k, v] of u.searchParams) if (re.test(k) || re.test(v)) out.push(`address ${k}=${v.slice(0, 40)}`);
        for (const seg of u.pathname.split("/")) if (re.test(seg)) out.push(`address path ${seg.slice(0, 60)}`);
        if (re.test(u.hash)) out.push(`address ${u.hash.slice(0, 60)}`);
      } catch {}
      const colour = /^(btn|text|bg|border|badge|label|has|is|fa|icon)[-_]/i;
      for (const el of deepAll("[id], [class]").filter((x) => document.body.contains(x.getRootNode() instanceof ShadowRoot ? x.getRootNode().host : x))) {
        if (out.length >= 8) break;
        if (el.closest("button, a, input, select, textarea, label, script, style, [role=button]")) continue;
        const names = [el.id, ...(typeof el.className === "string" ? el.className.split(/\s+/) : [])].filter((n) => n && !colour.test(n) && re.test(n));
        if (names.length && visible(el)) out.push(`shown element ${names[0].slice(0, 60)}`);
      }
      return [...new Set(out)];
    },
    /**
     * The boxes a board shows for an emailed code, in page order: one box for the whole code, or a row of
     * one-character boxes. Each is marked with data-awj-code=<n> so it can be clicked. Returns how many there are.
     */
    codeBoxes() {
      const re = /code|codice|otp|pin|verif|security|sicurezza|token/i;
      const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("autocomplete"), ...(el.labels ? [...el.labels].map((l) => text(l)) : [])].filter(Boolean).join(" ");
      const boxes = deepAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=email])").filter((el) => visible(el) && !el.disabled && !el.readOnly && !el.value);
      const singles = boxes.filter((el) => el.maxLength === 1);
      const found = singles.length >= 4 ? singles : boxes.filter((el) => re.test(words(el)) || el.getAttribute("autocomplete") === "one-time-code").slice(0, 1);
      found.forEach((el, i) => el.setAttribute("data-awj-code", String(i)));
      return found.length;
    },
    /** How many fields a person could type into or pick from are shown now. */
    shownControls() {
      return deepAll("input:not([type=hidden]), select, textarea").filter(visible).length;
    },
    controlCount() {
      return document.readyState !== "loading" ? document.querySelectorAll("input, select, textarea").length : -1;
    },
    /** What lies over a control at the point a click would land: empty when nothing does, else the words of the thing in the way (a cookie banner, a chat bubble). */
    coveredBy(sel) {
      const el = q(sel);
      if (!el) return "";
      const p = center(el);
      const top = document.elementFromPoint(p.x, p.y);
      if (!top || el.contains(top) || top.contains(el)) return "";
      let box = top;
      while (box.parentElement && box.parentElement !== document.body && text(box).length < 40) box = box.parentElement;
      return text(box).slice(0, 200) || top.tagName;
    },
    /** Clicks a control from script, for the case where something lies over it and a real click cannot reach it. */
    press(sel) {
      const el = q(sel);
      if (!el) return false;
      el.click();
      return true;
    },
    clickByText(pattern) {
      const re = new RegExp(pattern, "i");
      // A button drawn by a web component shows the words slotted into its host, not its own.
      const words = (x) => text(x) || (x.getRootNode() instanceof ShadowRoot ? text(x.getRootNode().host) : "");
      const b = deepAll("a, button, [role=button]").find((x) => visible(x) && re.test(words(x)));
      if (!b) return { x: 0, y: 0, ok: false };
      // Where the button leads, when it is a plain link to another page.
      const a = b.closest("a[href]");
      const href = a && /^https?:/.test(a.href) && a.href.split("#")[0] !== location.href.split("#")[0] ? a.href : undefined;
      return { ...center(b), href };
    },
  };
  return "ok";
})();
