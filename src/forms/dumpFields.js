// Runs inside the page through Claude in Chrome's javascript tool.
// Serializes every visible form control to JSON so JEV can map it.
// Returns a string: JSON.stringify(FieldsDump). No side effects.
(() => {
  // Password inputs are never dumped: a page that asks for one is a login or account page, not an application form.
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "search", "password"]);
  // Long enough for a question that follows a paragraph of legal text: the question is usually at the end.
  const LABEL_MAX = 700;
  const seenRadio = new Set();
  const fields = [];
  const out = { url: location.href, title: document.title, context: "", fields, submitSelectors: [] };

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    if (el.type === "file") return true; // file inputs are routinely hidden behind a styled button
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // A box one or two pixels wide is kept for screen readers or validation ("sr-only"), not for typing.
    if (r.width <= 2 && r.height <= 2) return false;
    // A box pushed off the left of the page is a trap for robots (Breezy's "hp_" field), never a question.
    if (r.right <= 0) return false;
    // react-select and friends keep a transparent, focus-skipped input around for HTML5 validation.
    if (st.opacity === "0" && el.tabIndex === -1) return false;
    return true;
  };
  // The words of an element. An icon's fallback text ("SVGs not supported by this browser.") is not one of them.
  // The words drawn inside shadow roots, which innerText leaves out, in reading order.
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
  // An element drawn by a web component (an option, a button) may hold its words only in its shadow root.
  // A <slot> inside it shows words handed in from outside, often passed on through several components.
  const pageHasShadow = [...document.querySelectorAll("*")].some((x) => x.shadowRoot);
  const holdsShadow = (el) => pageHasShadow && (!!el.shadowRoot || !!el.querySelector("slot") || [...el.querySelectorAll("*")].some((x) => x.shadowRoot));
  const text = (el) => {
    if (!el) return "";
    let t = el.innerText || el.textContent || "";
    // A label may show only its "*" in its own words and take the question through a slot: the fuller reading wins.
    if (el.nodeType === 1 && holdsShadow(el)) { const flat = flatText(el); if (flat.trim().length > t.trim().length) t = flat; }
    return t.replace(/SVGs? not supported by this browser\.?/gi, "").replace(/\s+/g, " ").trim();
  };
  // An attribute value inside a quoted CSS selector: backslashes and quotes escaped.
  const attr = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, "\\$1"));
  // Forms drawn with web components (SmartRecruiters' spl-input) keep their real controls in open shadow roots. Those
  // controls are read like any other; a selector reaches one through its hosts, joined by " >>> " (see pageHelpers' q).
  const SHADOW = " >>> ";
  const rootOf = (el) => el.getRootNode();
  const inShadow = (el) => rootOf(el) instanceof ShadowRoot;
  // One step up the page, out of a shadow root into its host when the root is reached.
  const up = (el) => el.parentElement || (inShadow(el) ? rootOf(el).host : null);
  // The element of the page itself that holds el, through any shadow roots: its place in the page order.
  const outer = (el) => { while (inShadow(el)) el = rootOf(el).host; return el; };
  const byId = (el, id) => (rootOf(el).getElementById ? rootOf(el).getElementById(id) : null) || document.getElementById(id);
  const labelsFor = (el) => (el.id ? [...rootOf(el).querySelectorAll(`label[for="${cssEscape(el.id)}"]`)] : []);
  // Elements under el matching sel, the ones handed into its <slot>s from outside included (see pageHelpers).
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
  // Every element matching sel, in page order, inside open shadow roots too.
  const deepAll = (sel, root = document) => {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.matches(sel)) out.push(el);
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    }
    return out;
  };
  const unique = (s, root = document) => { try { return root.querySelectorAll(s).length === 1; } catch { return false; } };
  // Ids a UI library numbers on each render (FabricTextField-349, :r1:, radix-12) can change under us, so they are not used to find a field again.
  // An id that merely ends in digits (question_8595663005, school--0) is the form's own and stays put.
  // A run of twelve or more letters and digits in both cases (nNpgf9k9eygQEJqI) is drawn at random on each render.
  // SuccessFactors numbers its controls per render ("86:_input" becomes "194:_input" once a file is uploaded), as do UI5's
  // web components ("ui5wc_5-inner").
  const RENDER_ID = /^(:r|\d+:|ui5wc_\d|radix-|headlessui-|mui-|react-aria|downshift-|rc_select_|el-id-|Fabric[A-Za-z]*-?\d|field-\d+$|(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9]{12,}$)/;
  const stableId = (id, root = document) => !!id && !RENDER_ID.test(id) && unique("#" + cssEscape(id), root);
  // A control inside a shadow root is found through its host: the host's selector, " >>> ", then its own inside the root.
  // A stand-in file box the runner made for an upload button is named by its own mark: a path to it moves as the page
  // redraws around it.
  const selectorFor = (el) => el.hasAttribute && el.hasAttribute("data-awj-proxy") && !inShadow(el) ? `[data-awj-proxy="${el.getAttribute("data-awj-proxy")}"]` : (inShadow(el) ?selectorFor(rootOf(el).host) + SHADOW + localSelector(el, rootOf(el)) : localSelector(el, document));
  const localSelector = (el, root) => {
    const tag = el.tagName.toLowerCase();
    // A radio button is one of a group, and the group is what gets set: its name finds it again whatever its id.
    if (el.type === "radio" && el.name) return `${tag}[name="${attr(el.name)}"]`;
    if (stableId(el.id, root)) return "#" + cssEscape(el.id);
    // A name the site's own tests use for the control stays put across renders.
    for (const a of ["data-testid", "data-ui", "data-qa", "data-test"]) {
      const v = el.getAttribute(a);
      if (v && unique(`${tag}[${a}="${attr(v)}"]`, root)) return `${tag}[${a}="${attr(v)}"]`;
    }
    // Next best: the nearest container the site names, when it holds exactly one control of this kind.
    for (let cur = el.parentElement, depth = 0; cur && depth < 6; cur = cur.parentElement, depth++) {
      const v = cur.getAttribute("data-testid");
      if (v && unique(`[data-testid="${attr(v)}"] ${tag}`, root) && unique(`[data-testid="${attr(v)}"]`, root)) return `[data-testid="${attr(v)}"] ${tag}`;
    }
    if (el.name) {
      const s = `${tag}[name="${attr(el.name)}"]`;
      if (unique(s, root) || el.type === "radio") return s;
    }
    // Walk up until the path names exactly one element: two fields must never share a selector.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (stableId(cur.id, root)) { parts.unshift("#" + cssEscape(cur.id)); break; }
      const t = cur.tagName.toLowerCase();
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [...(cur.parentNode ? cur.parentNode.children : [])].filter((c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      if (parts.length >= 3 && unique(parts.join(" > "), root)) break;
      // At the top of a shadow root the path is complete: it is looked up inside that root.
      if (!cur.parentElement) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  // Placeholder-style labels say nothing about the question. The real question is the text block just above the control.
  const GENERIC = /^(select|select\.\.\.|select an option|select one|please select|choose|choose one|search|search\.\.\.|type to search|start typing\.*|textbox)?$/i;
  const questionFor = (el) => {
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 7; depth++, cur = up(cur)) {
      let sib = cur.previousElementSibling;
      while (sib) {
        // The page title is not a question, and anything above it belongs to another part of the page.
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const t = text(sib);
        if (t && t.length <= LABEL_MAX && !GENERIC.test(t) && !sib.querySelector("input, select, textarea, [role=combobox]")) return t;
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  // What the site itself calls the control, as words: "phone_number-code" reads "phone number code".
  const ownName = (el) => {
    for (let cur = el, depth = 0; cur && depth < 8; cur = up(cur), depth++) {
      const v = cur.getAttribute("data-testid") || cur.getAttribute("data-ui") || cur.getAttribute("data-test") || "";
      const words = v.replace(/^(input|select|field)[-_]/i, "").replace(/[-_]+/g, " ").trim();
      if (words && !/^(select|search|input|controller|option|wrapper)\b/i.test(words) && !/^[A-Za-z]{0,3}\d+$/.test(words)) return words;
    }
    return "";
  };
  const cleanLabel = (el, label) => {
    const stripped = label.replace(/^(select\.\.\.|select an option|select|search|textbox|seleziona|scegli|cerca|auswählen|sélectionner|seleccionar)\s+/i, "").trim();
    if (stripped && !GENERIC.test(stripped)) return stripped;
    return questionFor(el).replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX) || ownName(el) || label;
  };
  // A file box is usually labelled by its button ("Attach", "Choose file"). Which file it wants is said by the question above it.
  // In the posting's language too: "Scegli un file o trascinalo qui", "Datei auswählen", "Choisir un fichier".
  const FILE_BUTTON = /^(attach|upload|upload file|choose (a )?file|select (a )?file|browse|replace file|drop or select|drag and drop|svgs? not supported|file[-_ ]?input|file$|no file (selected|chosen)|dropbox|google drive|one ?drive|enter manually|from device|my computer|scegli (un )?file|seleziona (un )?file|carica (un )?file|allega (un |il )?file|sfoglia|trascina|nessun file|datei (auswählen|hochladen|wählen)|durchsuchen|choisir (un )?fichier|parcourir|glisser|seleccionar archivo|elegir archivo|examinar|bestand kiezen)/i;
  // The question above a file box, skipping the box's own buttons ("Attach", "Dropbox", "Enter manually").
  const fileQuestion = (el) => {
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++, cur = up(cur)) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const t = text(sib);
        if (t && t.length <= LABEL_MAX && !GENERIC.test(t) && !FILE_BUTTON.test(t) && !sib.querySelector("input, select, textarea, button, [role=combobox]")) return t;
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  const fileLabel = (el, label) => {
    if (label && !FILE_BUTTON.test(label)) return label;
    const said = (inShadow(el) ? slotLabel(el, FILE_BUTTON) : "") || fileQuestion(el) || ownName(el) || (el.name || el.id || "").replace(/[-_]+/g, " ");
    return said && !FILE_BUTTON.test(said) ? `${said.replace(/\s*[*✱]\s*$/, "")} (${label || "file"})`.slice(0, LABEL_MAX) : label;
  };
  // The heading of the box a control sits in: the form's own label for the question, when the control itself carries no id for it.
  const fieldHeading = (el) => {
    const box = el.closest("fieldset, [class*=field-entry i], [class*=fieldEntry], [data-field-path]");
    if (!box) return null;
    const h = [...box.querySelectorAll("label, legend, [class*=question-title i]")].find((l) => !l.querySelector("input, select, textarea") && !(l.htmlFor && document.getElementById(l.htmlFor) && document.getElementById(l.htmlFor) !== el && /^(radio|checkbox)$/.test(document.getElementById(l.htmlFor).type || "")));
    return h && text(h) ? h : null;
  };
  // Web components take a field's question through a slot named for it (<span slot="label-content">). The nearest
  // box around the control, through its hosts, that is handed such a slot holds the control's question.
  const slotLabel = (el, skip = null) => {
    for (let cur = up(el), depth = 0; cur && cur !== document.body && depth < 16; cur = up(cur), depth++) {
      const given = [...cur.children].find((c) => /label/i.test(c.getAttribute("slot") || "") && text(c) && !(skip && skip.test(text(c))));
      if (given) return text(given).slice(0, LABEL_MAX);
    }
    return "";
  };
  const hostLabel = (el) => {
    for (let cur = el, depth = 0; inShadow(cur) && depth < 4; depth++) {
      const h = rootOf(cur).host;
      const named = h.getAttribute("label") || h.getAttribute("aria-label") || h.getAttribute("arialabel") || "";
      if (named.trim()) return named.trim();
      // innerText of a host is its own light words, the ones it shows through its slots.
      const own = (h.innerText || "").replace(/\s+/g, " ").trim();
      if (own && own.length <= LABEL_MAX) return own;
      cur = h;
    }
    return "";
  };
  const labelFor = (el) => {
    const bits = [];
    labelsFor(el).forEach((l) => bits.push(text(l)));
    const al = el.getAttribute("aria-label"); if (al) bits.push(al);
    const by = el.getAttribute("aria-labelledby");
    if (by) by.split(/\s+/).forEach((id) => { const n = byId(el, id); if (n) bits.push(text(n)); });
    // A web component may carry the label only on its host: as an attribute (<spl-input label="Nome">), or as the
    // words slotted into it (<spl-checkbox>Accetto…</spl-checkbox>). The hosts around it are asked in turn.
    if (!bits.join("").trim() && inShadow(el)) bits.push(slotLabel(el) || hostLabel(el));
    const wrap = el.closest("label"); if (wrap) bits.push(text(wrap).replace(text(el), ""));
    const isOption = el.type === "checkbox" || el.type === "radio";
    if (isOption && !bits.join("").trim()) {
      // An option's own text sits right after its box. The text before it belongs to the option above,
      // so it must never be used: that would tick the wrong box.
      const next = el.nextElementSibling;
      const after = next && !next.matches("input, select, textarea") ? text(next) : (el.nextSibling && el.nextSibling.nodeType === 3 ? el.nextSibling.textContent.trim() : "");
      return (after || (inShadow(el) ? slotLabel(el) || hostLabel(el) : "") || el.value || el.id || "").replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX);
    }
    if (!bits.join("").trim()) {
      // A label whose "for" names no element on the page (Cornerstone: <label for="actionItem.firstName.idTag"> over an
      // input with no id) belongs to the one control in its own small container. The section heading above never does.
      let cur = el.parentElement;
      for (let depth = 0; cur && cur !== document.body && depth < 4; depth++, cur = cur.parentElement) {
        if (cur.querySelectorAll("input:not([type=hidden]), select, textarea").length > 1) break;
        const l = [...cur.querySelectorAll("label")].find((x) => text(x) && (!x.htmlFor || !byId(el, x.htmlFor)));
        if (l) { bits.push(text(l)); break; }
      }
    }
    if (!bits.join("").trim()) { const h = fieldHeading(el); if (h) bits.push(text(h)); }
    if (!bits.join("").trim()) bits.push(questionFor(el));
    if (!bits.join("").trim()) {
      // Walk up to a field container and take its first heading or label-like text.
      let cur = el.parentElement, depth = 0;
      while (cur && depth < 4) {
        const l = cur.querySelector("label, legend, [class*=label i], [class*=question i], h3, h4, h5");
        if (l && text(l)) { bits.push(text(l)); break; }
        cur = cur.parentElement; depth++;
      }
    }
    return [...new Set(bits.map((b) => b.replace(/\s*[*✱]\s*$/, "").replace(/\s*[*✱]\s+/g, " ").trim()).filter(Boolean))].join(" ").slice(0, LABEL_MAX);
  };
  // The question a checkbox or radio belongs to: the nearest label or legend above it that is not an option's own label.
  const groupQuestionFor = (el) => {
    const isOptionLabel = (l) => {
      if (l.contains(el) || (el.id && l.htmlFor === el.id)) return true;
      const target = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector("input");
      return !!target && (target.type === "checkbox" || target.type === "radio");
    };
    let cur = el.parentElement;
    for (let depth = 0; cur && cur !== document.body && depth < 5; depth++, cur = cur.parentElement) {
      // A container that holds a whole form section is too wide to say which question this option answers.
      if (cur.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea").length > 1) break;
      const before = [...cur.querySelectorAll("legend, label, [class*=question-title i]")].filter((l) => !isOptionLabel(l) && text(l) && (l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (before.length) return text(before[before.length - 1]).replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX);
    }
    return "";
  };
  // The question above a group of options on a form that writes it as plain text, with no label or legend.
  // The walk stops at another question's controls, so an option never takes the question of the group before it.
  const optionQuestionFor = (el) => {
    const sameGroup = (node) => [...node.querySelectorAll("input, select, textarea")].every((i) => i.type === el.type && !!el.name && i.name === el.name);
    let cur = el;
    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === "H1" || sib.querySelector("h1")) return "";
        const holds = sib.querySelector("input, select, textarea, [role=combobox]");
        if (holds && !sameGroup(sib)) return "";
        const t = text(sib);
        if (!holds && t && t.length <= LABEL_MAX && !GENERIC.test(t)) return t.replace(/\s*[*✱]\s*$/, "");
        sib = sib.previousElementSibling;
      }
    }
    return "";
  };
  const hintFor = (el) => {
    const by = el.getAttribute("aria-describedby");
    const bits = [];
    if (by) by.split(/\s+/).forEach((id) => { const n = byId(el, id); if (n) bits.push(text(n)); });
    // The box the control sits in, not the wrapper drawn right around the input, which holds no words of its own.
    const c = el.closest("fieldset, [class*=field-entry i], [class*=fieldEntry], [data-field-path]") || el.closest("[class*=field i], [class*=question i], [class*=form-group i], div");
    if (c) c.querySelectorAll("p, small, [class*=help i], [class*=hint i], [class*=description i]").forEach((n) => { const t = text(n); if (t && t.length < 400 && !n.querySelector("input, select, textarea")) bits.push(t); });
    return [...new Set(bits)].join(" ").slice(0, 400);
  };
  // The nearest heading or legend above the control, for context like "Education" or "Voluntary self-identification".
  const sectionFor = (el) => {
    const root = el.closest("form, [role=tabpanel], main") || document.body;
    let cur = el;
    while (cur && cur !== root && cur !== document.body) {
      let sib = cur.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$|^LEGEND$/.test(sib.tagName)) return text(sib).slice(0, 80);
        const h = sib.querySelector && sib.querySelector("h1, h2, h3, h4, legend");
        if (h && sib.querySelectorAll("input, select, textarea").length === 0) return text(h).slice(0, 80);
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  };
  // A field that says it is optional is optional, whatever the box around it is called.
  // A drawn picker keeps the real, required input out of sight in the same box (Workable's comboboxes).
  const hiddenRequiredTwin = (el) => { const box = el.closest("[data-input-type], [data-ui], [class*=field i]"); return !!box && [...box.querySelectorAll("input[required], select[required]")].some((t) => t !== el && !visible(t)); };
  const headingSaysRequired = (el) => { const h = fieldHeading(el); return !!h && (/required/i.test(String(h.className)) || /[*✱]\s*$|^\s*[*✱]/.test(text(h))); };
  // A box whose class says required. Angular's state classes on the whole form ("ng-valid-required") say nothing about one field.
  const REQUIRED_CLASS = /^(?!ng-(in)?valid-required$|not-required$|non-required$).*required/i;
  const requiredClass = (el) => {
    for (let cur = el; cur && cur.nodeType === 1 && cur.tagName !== "FORM" && cur !== document.body; cur = cur.parentElement)
      if ([...cur.classList].some((c) => REQUIRED_CLASS.test(c))) return true;
    return false;
  };
  // Some boards write the word instead of a star: "Indirizzo Obbligatorio", "Address Required".
  const isRequired = (el, label) => !/\(optional\)|\(facoltativo\)/i.test(label) && (/(^|\s)(Obbligatorio|Required|Pflichtfeld|Obligatoire|Obligatorio|Obrigatório)(\s|\.|$)/.test(label) || /^\s*(obbligatorio|required)\b/i.test(label) || el.required || el.getAttribute("aria-required") === "true" || /[*✱]\s*$|^\s*[*✱]|\(required\)/i.test(label) || requiredClass(el) || hiddenRequiredTwin(el) || headingSaysRequired(el));

  // A plain text input with a suggestion list beside it (Lever's location box) only accepts a picked suggestion.
  const hasSuggestBox = (el) => el.tagName === "INPUT" && !!el.parentElement && !!el.parentElement.querySelector('[class*="dropdown-results" i], [class*="autocomplete" i], [class*="typeahead" i], [class*="suggestions" i]');
  // A read-only input is a date box when it, or the field around it, says date, or a calendar hangs beside it.
  const DATE_WORD = /date|calendar|datepicker|\bdob\b|birthday/i;
  const looksLikeDateBox = (el) => {
    const own = `${el.className} ${el.name} ${el.id} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`;
    if (DATE_WORD.test(own)) return true;
    const item = el.closest("[variant], [class*=form-item i], [class*=field i]");
    if (item && (DATE_WORD.test(item.getAttribute("variant") || "") || item.querySelector('[class*="date-picker" i], [class*="datepicker" i], [class*="calendar" i]'))) return true;
    return !Number.isNaN(Date.parse(el.getAttribute("placeholder") || "")) && /\d{4}/.test(el.getAttribute("placeholder") || "");
  };
  // The widget that draws a control, when it is one the tool knows. Controls of one widget take values the same way.
  const widgetOf = (el, isCalendar, drawnByLabel) => {
    if (isCalendar) return "calendar";
    if (isPanel(el)) return "panel";
    if ((el.tagName === "BUTTON" || el.getAttribute("role") === "button") && el.hasAttribute("aria-haspopup")) return "menu-button";
    if (el.closest(".iti")) return "intl-tel";
    if (el.closest('[class*="select__control"]')) return "react-select";
    if (el.closest(".selectize-input, .selectize-control")) return "selectize";
    if (el.parentElement && el.parentElement.querySelector("datalist")) return "datalist";
    if (el.closest('[data-testid="select-controller"]')) return "testid-select";
    if (drawnByLabel) return "label-drawn";
    if (el.tagName === "SELECT" && /select2-hidden/.test(el.className)) return "select2";
    return "";
  };
  // A combobox drawn around a switched-off box that opens a panel of its own fields (inRecruiting's address:
  // country, then postal code or city, from which the rest is filled in). The box itself takes no typing.
  const isPanel = (el) => {
    if (el.getAttribute("role") !== "combobox" || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return false;
    const inner = el.querySelectorAll("input:not([type=hidden]), select, textarea");
    return inner.length === 1 && inner[0].disabled;
  };
  // A button that opens a list of choices (aria-haspopup, BambooHR's pickers) is a dropdown drawn without an input.
  // HiBob draws it as a labelled div with role=button; only one tied to a label counts, so page menus stay out.
  const MENU_BUTTON = 'button[aria-haspopup="true"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"], [role=button][aria-haspopup="true"][aria-labelledby]';
  const controls = deepAll(`input, select, textarea, [role=combobox], [role=listbox], ${MENU_BUTTON}`);
  // The fields inside an address panel belong to it: the panel is filled as one answer, never box by box.
  const panelRoots = [...document.querySelectorAll("[role=combobox]")].filter(isPanel).map((p) => {
    let root = p.parentElement;
    while (root && root.querySelectorAll("input:not([type=hidden])").length < 2) root = root.parentElement;
    return root;
  }).filter(Boolean);
  const inPanel = (el) => panelRoots.some((r) => r.contains(el)) && !isPanel(el);
  const containerOf = (el) => el.closest("fieldset, [class*=field i], [class*=question i], [data-field-path], [id^=question], .form-group") || el.parentElement;
  const usedContainers = new Set();
  const dumped = new Set();
  const elementOf = new Map();
  let i = 0;
  controls.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
    if (SKIP_TYPES.has(type) && !el.matches(MENU_BUTTON)) return;
    if (inPanel(el)) return;
    // One part of a date drawn as boxes per part: the whole date is read as one field below.
    if (el.getAttribute("role") === "spinbutton" && el.closest("[role=group]") && el.closest("[role=group]").querySelectorAll("input[role=spinbutton]").length >= 2) return;
    // The site's own header and menus (a language picker, the signed-in account's menu) are not questions of the form.
    if (el.closest("header, nav, [role=banner], [role=navigation], [data-automation-id=header]") && !el.closest("form")) return;
    // Workday's prompt: the list of its picks and its open list of rows belong to its search box, not questions of their own.
    if (el.getAttribute("role") === "listbox" && el.closest("[data-automation-id=multiSelectContainer], [data-automation-id=activeListContainer], [data-automation-id=selectedItemList]")) return;
    if (el.getAttribute("data-automation-id") === "activeListContainer" || el.closest("[data-automation-id=activeListContainer]")) return;
    const isControl = ["input", "select", "textarea"].includes(tag);
    // The list a combobox opens is that combobox's, not a question of its own.
    if (!isControl && el.id && rootOf(el).querySelector(`[aria-controls="${attr(el.id)}"], [aria-owns="${attr(el.id)}"]`)) return;
    // Custom widgets (react-select wrappers, live regions) are reported once, through the real input in the same question.
    if (!isControl) {
      if (el.querySelector("input, select, textarea") && !isPanel(el)) return;
      const c = containerOf(el);
      // An input kept out of sight in the same box (BambooHR's state.value) is the widget's own store, not the control.
      if (c && !isPanel(el) && (usedContainers.has(c) || [...c.querySelectorAll("input:not([type=hidden]), select, textarea")].some(visible))) return;
    }
    // A radio or a checkbox is often drawn by its label, with the real box kept out of sight behind it.
    // Recruitee names the box's words with aria-labelledby, a div beside the 1 px box.
    const namedBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => byId(el, id))[0];
    const drawnByLabel = (type === "radio" || type === "checkbox") && !visible(el) && [el.closest("label"), labelsFor(el)[0], type === "checkbox" && el.closest("[role=checkbox]"), namedBy].some((l) => l && visible(l));
    // A select2 list keeps the real <select> out of sight and draws its own box beside it.
    const drawnBySelect2 = tag === "select" && /select2-hidden/.test(el.className) && !!el.nextElementSibling && visible(el.nextElementSibling);
    if (!visible(el) && type !== "file" && !drawnByLabel && !drawnBySelect2) return;
    // A box that cannot be typed into is skipped, unless it is a date box set through a calendar
    // or a list that opens on a click (Workable draws its pickers as read-only comboboxes).
    const isCalendar = el.readOnly && isControl && tag === "input" && looksLikeDateBox(el);
    const isPicker = el.readOnly && el.getAttribute("role") === "combobox";
    // "readonly" means nothing to a checkbox or a radio: it still ticks (Cornerstone marks its required "I agree" readonly).
    const ticks = type === "checkbox" || type === "radio";
    if (el.disabled || (el.readOnly && !ticks && !isCalendar && !isPicker)) return;
    // A text box hidden from people and from the keyboard is the site's own bookkeeping (the parts of an address it fills in itself).
    if (el.getAttribute("aria-hidden") === "true" && el.tabIndex === -1 && !["radio", "checkbox", "file"].includes(type) && !drawnBySelect2) return;
    // Only a control that is read claims its question's box: a hidden store kept beside a drawn widget does not.
    if (isControl && type !== "radio") usedContainers.add(containerOf(el));
    const role = el.getAttribute("role");
    let kind;
    if (isCalendar) kind = "calendar";
    else if (tag === "select") kind = "select";
    else if (tag === "textarea") kind = "textarea";
    else if (role === "combobox" || el.getAttribute("aria-autocomplete") === "list" || role === "listbox" || hasSuggestBox(el) || el.matches(MENU_BUTTON) || el.getAttribute("data-uxi-widget-type") === "selectinput") kind = "combobox";
    else if (type === "radio") kind = "radio";
    else if (type === "checkbox") kind = "checkbox";
    else if (type === "file") kind = "file";
    else if (["email", "tel", "url", "number", "date"].includes(type)) kind = type;
    else kind = "text";

    const f = {
      id: "f" + i++,
      widget: widgetOf(el, isCalendar, drawnByLabel),
      selector: selectorFor(el),
      kind,
      name: el.name || el.id || "",
      label: labelFor(el),
      hint: hintFor(el),
      placeholder: el.getAttribute("placeholder") || "",
      required: false,
      value: "",
      options: [],
      accept: el.getAttribute("accept") || "",
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      autocomplete: el.getAttribute("autocomplete") || "",
      section: sectionFor(el),
    };
    // For an option, the question it answers says more than the page section it sits in.
    if (kind === "checkbox" || kind === "radio") f.section = groupQuestionFor(el) || optionQuestionFor(el) || f.section;
    // A site that shows its own markup as text ("RAL?<a style=…>*</a>", Cornerstone) still marks the field required with that star.
    if (/<\/?[a-z][^<>]*>/i.test(f.label)) f.label = f.label.replace(/<\/?[a-z][^<>]*>/gi, "").replace(/\s+/g, " ").trim();
    f.required = isRequired(el, f.label) || /[*✱]\s*$|^\s*[*✱]/.test(questionFor(el));
    // A lone checkbox whose own words end in a star is required ("Accetto di essere ricontattato…: *", Manatal).
    if (kind === "checkbox" && !f.required) {
      const own = el.nextElementSibling && !el.nextElementSibling.matches("input, select, textarea") ? text(el.nextElementSibling) : text(el.closest("label") || document.createElement("i"));
      if (/[*✱]\s*$/.test(own)) f.required = true;
    }
    f.label = f.label.replace(/\s*[*✱]\s*$/, "");
    if (f.widget === "panel") {
      // The form's label names the switched-off box inside, not the combobox around it ("Geolocation Combobox").
      const inner = el.querySelector("input:not([type=hidden]), select, textarea");
      const lab = inner && inner.id ? document.querySelector(`label[for="${cssEscape(inner.id)}"]`) : null;
      if (lab) {
        f.label = text(lab).slice(0, LABEL_MAX);
        f.required = f.required || lab.classList.contains("required") || /[*✱]\s*$/.test(text(lab));
      }
      f.value = inner ? inner.value : "";
    }
    if (el.matches(MENU_BUTTON)) {
      // The button's text is its current choice, or a placeholder. Its label is the form's own label for the box
      // around it, or its aria-label with that choice taken off the end ("Country United States").
      const own = text(el);
      // A placeholder, in any language and said twice (once for screen readers), is no choice.
      const shownNow = own.replace(/(select an option|select one|please select|select\.\.\.|select|choose|search|seleziona (un'opzione|una o più opzioni|una opzione)|seleziona|scegli (un'opzione)?|bitte wählen|auswählen|sélectionner une option|sélectionner|choisir|selecciona una opción|seleccionar|selecciona)/gi, "").replace(/[-–—\s]/g, "") === "" ? "" : own;
      let named = "";
      for (let cur = el, depth = 0; cur && depth < 5 && !named; cur = cur.parentElement, depth++) {
        if (cur.id) named = [...document.querySelectorAll(`label[for="${cssEscape(cur.id)}"]`)].map(text).join(" ");
      }
      // A label with no "for", alone in the box around the button (inRecruiting's bootstrap-select): that is its question.
      let box = el.parentElement;
      for (let depth = 0; box && depth < 4 && !box.querySelector("label"); depth++) box = box.parentElement;
      const lone = box && box.querySelectorAll("button, input:not([type=hidden]), textarea").length <= 2 ? [...box.querySelectorAll("label")].filter((l) => !l.htmlFor && !l.contains(el)) : [];
      if (!named && lone.length === 1 && lone[0]) {
        named = text(lone[0]);
        if (lone[0].classList.contains("required")) f.required = true;
      }
      // The question named by aria-labelledby, without the part that only repeats the current choice or a placeholder.
      if (!named && el.getAttribute("aria-labelledby")) {
        named = el.getAttribute("aria-labelledby").split(/\s+/).map((x) => byId(el, x)).filter((n) => n && !el.contains(n)).map(text)
          .filter((t) => t && t !== own && t.replace(/(select an option|select one|please select|select\.\.\.|select|choose|search|seleziona (un'opzione|una o più opzioni|una opzione)|seleziona|scegli (un'opzione)?|bitte wählen|auswählen|sélectionner une option|sélectionner|choisir|selecciona una opción|seleccionar|selecciona)/gi, "").replace(/[-–—\s]/g, "") !== "").join(" ");
      }
      const al = (el.getAttribute("aria-label") || "").trim();
      if (!named && al) named = own && al.endsWith(own) ? al.slice(0, -own.length).trim() : al;
      // A name that is only the placeholder and "Required" (Workday's "Select One Required") says nothing: the question
      // is the text block above the button.
      const bare = (t) => t.replace(/(select an option|select one|please select|select|choose|seleziona|scegli)/gi, "").replace(/\b(one|required|obbligatorio|pflichtfeld|obligatoire|obligatorio)\b/gi, "").replace(/[-–—\s*✱]/g, "");
      if (named && bare(named) === "") {
        if (/required/i.test(named)) f.required = true;
        named = questionFor(el) || "";
      }
      if (!named && bare(f.label) === "") f.label = questionFor(el) || f.label;
      f.label = (named || f.label).slice(0, LABEL_MAX);
      f.value = shownNow;
      f.required = f.required || isRequired(el, f.label);
    }
    if (kind !== "radio" && kind !== "checkbox" && kind !== "file") f.label = cleanLabel(el, f.label);
    if (kind === "file") {
      f.label = fileLabel(el, f.label);
      // A stand-in box made for an upload button already carries the button's own required mark; the words around it
      // can hold another box's star (SuccessFactors: "* CV" above "Cover letter").
      if (el.hasAttribute("data-awj-proxy")) f.required = el.hasAttribute("data-awj-required");
      else f.required = f.required || /[*✱]\s*$/.test(fileQuestion(el));
    }

    if (kind === "radio") {
      const key = el.name || f.selector;
      if (seenRadio.has(key)) { i--; return; }
      seenRadio.add(key);
      const group = el.name ? rootOf(el).querySelectorAll(`input[type=radio][name="${attr(el.name)}"]`) : [el];
      group.forEach((r) => {
        const l = labelsFor(r)[0] || r.closest("label");
        // A radio with no <label for> names its choice in its aria-label, or in a <label> right after its own wrapper
        // (SuccessFactors: "Any company recruiter worldwide").
        const next = (r.parentElement && r.parentElement.nextElementSibling) || r.nextElementSibling;
        const after = next && next.tagName === "LABEL" && !next.querySelector("input") ? text(next) : "";
        f.options.push({ value: r.value, label: text(l) || (r.getAttribute("aria-label") || "").trim() || after || r.value });
        if (r.checked) f.value = r.value;
      });
      const fs = el.closest("fieldset, [role=radiogroup]");
      const named = fs && fs.getAttribute("aria-labelledby") ? fs.getAttribute("aria-labelledby").split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(" ") : "";
      if (fs && fs.querySelector("legend")) f.label = text(fs.querySelector("legend")) || f.label;
      else if (named) f.label = named.slice(0, LABEL_MAX);
      else if (!f.label || f.options.some((o) => o.label === f.label)) {
        let cur = el.parentElement, depth = 0;
        while (cur && depth < 5) { const l = cur.querySelector("legend, label, [class*=label i], h2, h3, h4"); if (l && text(l) && !f.options.some((o) => o.label === text(l))) { f.label = text(l); break; } cur = cur.parentElement; depth++; }
      }
      // The mark that a group is required sits on its question, not on its options.
      const box = el.closest("fieldset, [role=radiogroup], [class*=field-entry i], [class*=fieldEntry]");
      const head = box && [...box.querySelectorAll("legend, label, [class*=question-title i]")].find((h) => !h.querySelector("input") && !f.options.some((o) => o.label === text(h)));
      if (head && (/required/i.test(String(head.getAttribute("class") || "")) || /[*✱]\s*$|^\s*[*✱]/.test(text(head)))) f.required = true;
      if (box && box.getAttribute("aria-required") === "true") f.required = true;
      // The question itself may carry the mark, before or after the words.
      if (/^\s*[*✱]|[*✱]\s*$/.test(f.label) || /^\s*[*✱]/.test(f.section)) f.required = true;
      f.label = f.label.replace(/^\s*[*✱]\s*|\s*[*✱]\s*$/g, "");
    } else if (kind === "select") {
      [...el.options].forEach((o) => { if (o.value !== "" || o.text.trim()) f.options.push({ value: o.value, label: o.text.trim() }); });
      f.value = el.value;
    } else if (kind === "checkbox") {
      f.checked = el.checked;
      f.value = el.value;
    } else if (kind === "combobox") {
      // Workday's prompt keeps its picks as items beside a search box that stays empty.
      const box = el.getAttribute("data-uxi-widget-type") === "selectinput" && el.closest("[data-automation-id=multiSelectContainer]");
      const picks = box ? [...box.querySelectorAll("[data-automation-id=selectedItem]")].map(text).filter(Boolean).join(", ") : "";
      if (box) f.widget = "workday-prompt";
      f.value = picks || el.value || f.value || "";
      const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      const list = listId ? byId(el, listId) : null;
      if (list) list.querySelectorAll("[role=option]").forEach((o) => f.options.push({ value: text(o), label: text(o) }));
    } else {
      f.value = el.value || f.value || "";
    }
    fields.push(f);
    dumped.add(el);
    elementOf.set(f, el);
  });

  // A group that keeps a named input of its own (Ashby's Yes/No rows do) is found by that name, which stays
  // put when a question appears above it. A path of positions would then point at another row.
  const groupSelectorFor = (c) => {
    const tag = c.tagName.toLowerCase();
    for (const inner of c.querySelectorAll(":scope > input[name]")) {
      const s = `${tag}:has(> input[name="${attr(inner.name)}"])`;
      if (unique(s)) return s;
    }
    return selectorFor(c);
  };
  // Button groups: a labelled field whose choices are plain <button>s (Ashby's Yes/No, some custom forms).
  const groupContainers = deepAll("[class*=field-entry i], [class*=fieldEntry], [class*=question i], fieldset, [role=radiogroup], [role=group]");
  const seenGroup = new Set();
  groupContainers.forEach((c) => {
    // A radiogroup drawn with role=radio rows keeps its real inputs invisible; it is read through the rows.
    const drawnRadios = c.getAttribute("role") === "radiogroup" && withSlotted(c, "[role=radio]").length > 0 && ![...c.querySelectorAll("input[type=radio]")].some((r) => seenRadio.has(r.name || ""));
    // Skip a container whose control was already read. An input nobody can see (Ashby keeps a hidden checkbox
    // behind its Yes and No buttons) does not count: the buttons are the control.
    if (!drawnRadios && [...c.querySelectorAll("input, select, textarea")].some((x) => x.type !== "hidden" && (dumped.has(x) || visible(x)))) return;
    const buttons = withSlotted(c, "button, [role=radio], [role=option]").filter((b) => visible(b) && !b.matches(MENU_BUTTON) && text(b).length > 0 && text(b).length <= 90 && !/upload|browse|remove|submit|apply|next|continue|back|invia|candid|avanti|prosegui|continua|indietro|carica/i.test(text(b)));
    if (buttons.length < 2 || buttons.length > 12) return;
    if ([...seenGroup].some((prev) => prev.contains(c) || c.contains(prev))) return;
    seenGroup.add(c);
    const labelEl = drawnRadios ? null : c.querySelector("label, legend, [class*=question-title i], [class*=label i], h2, h3, h4");
    // A group named by aria-labelledby (a web component's fieldset) says its question there.
    const namedBy = (c.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((x) => byId(c, x)).filter(Boolean).map(text).join(" ").trim();
    const label = labelEl ? text(labelEl) : namedBy || (inShadow(c) ? slotLabel(c) : "") || questionFor(c) || text(c).split("\n")[0];
    const selected = buttons.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /selected|active|checked/i.test(b.className) || b.dataset.state === "on" || b.dataset.state === "checked" || b.dataset.selected === "true");
    fields.push({
      id: "f" + i++,
      widget: drawnRadios ? "drawn-radio" : "buttons",
      selector: groupSelectorFor(c),
      kind: "radio",
      name: c.getAttribute("data-field-path") || "",
      label: label.replace(/\s*[*✱]\s*$/, "").replace(/^\s*[*✱]\s*/, "").slice(0, LABEL_MAX),
      hint: hintFor(c),
      placeholder: "",
      required: /required/i.test(labelEl?.className || "") || /[*✱]\s*$|^\s*[*✱]/.test(labelEl ? text(labelEl) : label) || c.getAttribute("aria-required") === "true" || !!c.querySelector('[aria-required="true"], input[required]'),
      value: selected ? text(selected) : "",
      options: buttons.map((b) => ({ value: text(b), label: text(b) })),
      accept: "",
      maxLength: null,
      autocomplete: "",
      section: sectionFor(c),
      buttonGroup: true,
    });
  });

  // A date drawn as one box per part (Workday's MM / DD / YYYY spin buttons, MM / YYYY for work history): one field for
  // the whole date, its parts named in order in the placeholder.
  deepAll("[role=group]").forEach((g) => {
    const spins = [...g.querySelectorAll("input[role=spinbutton]")];
    // Only the group that holds the parts itself, not a section around it.
    if (spins.length < 2 || !visible(g) || g.querySelector(":scope [role=group] input[role=spinbutton]")) return;
    const box = g.closest("fieldset");
    const legend = box && box.querySelector("legend");
    const raw = legend ? text(legend) : questionFor(g) || "";
    fields.push({
      id: "f" + i++,
      widget: "spin-date",
      selector: groupSelectorFor(g),
      kind: "date",
      name: "",
      label: raw.replace(/\s*[*✱]\s*$/, "").slice(0, LABEL_MAX),
      hint: "",
      placeholder: spins.map((s) => s.getAttribute("aria-label") || "").join(" / "),
      required: /[*✱]\s*$/.test(raw) || spins.some((s) => s.getAttribute("aria-required") === "true"),
      value: spins.every((s) => s.value) ? spins.map((s) => s.value).join("/") : "",
      options: [],
      accept: "",
      maxLength: null,
      autocomplete: "",
      section: sectionFor(g),
      buttonGroup: false,
    });
  });

  // The application is the <form> that holds the resume or the email box. A control that sits above
  // that form and outside it (a job-alert box, a site search) is not part of the application.
  // A control in a shadow root is placed by the host that holds it in the page.
  const inForm = (kind) => fields.find((f) => f.kind === kind && elementOf.get(f) && outer(elementOf.get(f)).closest("form"));
  const anchor = inForm("file") || inForm("email");
  const application = anchor ? outer(elementOf.get(anchor)).closest("form") : null;
  if (application) {
    for (let k = fields.length - 1; k >= 0; k--) {
      const el = elementOf.get(fields[k]) && outer(elementOf.get(fields[k]));
      if (el && !application.contains(el) && (application.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) fields.splice(k, 1);
    }
  }

  // Some careers sites embed the real form in an iframe (Greenhouse, Lever). Report those so the caller can navigate into one.
  out.hasPassword = deepAll("input[type=password]").some(visible);
  // Told by the frame's own host. A share widget that merely names a job board in its address is not a form.
  const hostOf = (src) => { try { return new URL(src).hostname; } catch { return ""; } };
  // A frame that loads the page itself, drawn with no size (SmartRecruiters' posting page), holds no form: following it
  // would only open the same page again.
  const bare = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname.replace(/\/+$/, "") + x.search; } catch { return u; } };
  out.frames = [...document.querySelectorAll("iframe[src]")]
    .filter((f) => bare(f.src) !== bare(location.href) && !(f.offsetWidth === 0 && f.offsetHeight === 0))
    .map((f) => f.src)
    .filter((src) => /greenhouse|lever\.co|ashbyhq|workday|smartrecruiters|jobvite|bamboohr|rippling|icims/i.test(hostOf(src)))
    // An "Apply with LinkedIn" gadget (Workday's applywithlinkedin.myworkdaygadgets.com) is a sign-in through another site, not the form.
    .filter((src) => !/linkedin|gadgets?\./i.test(src));
  // A take-home assignment the page asks for, with its link. The application still goes; the assignment is listed for the person.
  const TAKE_HOME = /take[- ]?home|coding (challenge|assessment|exercise)|technical assessment|complete the assignment/i;
  const URL_IN_TEXT = /https?:\/\/[^\s"')<>]+/;
  out.takeHome = [...document.querySelectorAll("p, li, div, label, legend, span")]
    .filter((n) => n.children.length < 8 && TAKE_HOME.test(text(n)) && text(n).length < 600 && (n.querySelector("a[href^='http']") || URL_IN_TEXT.test(text(n))))
    .filter((n, i, all) => !all.some((o) => o !== n && n.contains(o)))
    .slice(0, 3)
    .map((n) => ({ text: text(n).slice(0, 300), url: (n.querySelector("a[href^='http']") || {}).href || (URL_IN_TEXT.exec(text(n)) || [""])[0] }));
  const form = fields.length && elementOf.get(fields[0]) && outer(elementOf.get(fields[0])).closest("form");
  const headings = [...(form || document).querySelectorAll("h1, h2, h3, p")].slice(0, 8).map(text).filter(Boolean);
  out.context = headings.join(" | ").slice(0, 800);
  // Italian, German, Spanish, Portuguese and Dutch boards label Send and Next in the posting's language.
  const SUBMIT_WORD = /submit|apply|send|continue|next|review|finish|soumettre|postuler|envoyer|invia|candidati|candidatura|candidarsi|avanti|prosegui|procedi|continua|successivo|conferma|termina|completa|applica|pošalji|posalji|absenden|einreichen|abschicken|übermitteln|bewerben|senden|weiter|enviar|siguiente|continuar|verzenden|versturen|volgende|solliciteer/i;
  // JazzHR draws its Submit as a styled link.
  // A button drawn by a web component (<spl-button>) shows the words slotted into its host, not its own.
  const words = (b) => (text(b) || b.value || b.getAttribute("aria-label") || (inShadow(b) ? text(rootOf(b).host) : "") || "").trim();
  // "Apply with Indeed" and the like send the application through another site's account: never this form's Submit.
  const ELSEWHERE = /linkedin|indeed|google|facebook|xing|seek|apple|glassdoor/i;
  const submitLike = (root) => deepAll("button, input[type=submit], [role=button], a[class*=submit i], a[class*=btn i]", root).filter((b) => SUBMIT_WORD.test(words(b)) && !ELSEWHERE.test(words(b)) && visible(b));
  // The button may sit outside the form element (BambooHR draws it in a footer of its own), so the page is searched when the form has none.
  const buttons = form && submitLike(form).length ? submitLike(form) : submitLike(document);
  buttons.forEach((b) => {
    const t = words(b);
    out.submitSelectors.push(selectorFor(b) + "  /* " + t.slice(0, 40) + " */");
  });
  return JSON.stringify(out);
})();
