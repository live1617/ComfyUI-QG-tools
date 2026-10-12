// The gear menu: a floating settings popup shared by QG-tools panel nodes.
// Values persist per scope in localStorage, so a preference set once applies
// to every instance of that node in every workflow on this browser.
//
//   const values = loadSettings("lora_loader", SCHEMA);
//   button.onclick = () =>
//     openSettingsMenu({ scope: "lora_loader", schema: SCHEMA, anchor: rect,
//                        title: "LoRA Loader settings",
//                        onChange: (values, key) => rerender(values) });

import { makeScrubInput } from "./scrub_input.mjs?v=2026101216";
import { BRAND } from "./index.mjs?v=2026101216";
import { isAppShortcut, keepKeyInField } from "./canvas_passthrough.mjs?v=2026101216";
import {
  isOverrideActive,
  isOverrideEntry,
  mergeSettings,
  overrideEnableValue,
  overrideIsCustom,
  schemaDefaults,
} from "./node_settings.mjs?v=2026101216";

const CSS_ID = "qgtools-settings-css";

function storageKey(scope) {
  return `qg.settings.${scope}`;
}

function readStored(scope) {
  try {
    const raw = window.localStorage?.getItem(storageKey(scope));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeStored(scope, values) {
  try {
    window.localStorage?.setItem(storageKey(scope), JSON.stringify(values));
  } catch (_error) {
    // Storage full or blocked: the menu still works for this session.
  }
}

export function loadSettings(scope, schema) {
  return mergeSettings(schema, readStored(scope));
}

export function saveSetting(scope, schema, key, value, { persist = true } = {}) {
  const stored = readStored(scope);
  stored[key] = value;
  // persist:false coerces and applies the value without recording it as the
  // default new nodes start from - for entries that mirror per-node state.
  if (persist) writeStored(scope, stored);
  return mergeSettings(schema, stored);
}

export function resetSettings(scope) {
  try {
    window.localStorage?.removeItem(storageKey(scope));
  } catch (_error) {
    // Ignore: defaults apply either way.
  }
}

// A small hand-drawn gear so panels get a crisp icon without any asset file.
export function gearIconSvg(size = 13) {
  const teeth = [];
  for (let i = 0; i < 8; i += 1) {
    teeth.push(`<rect x="-1.4" y="-8" width="2.8" height="4.4" rx="1" transform="rotate(${i * 45})"/>`);
  }
  return (
    `<svg width="${size}" height="${size}" viewBox="-8 -8 16 16" ` +
    `fill="currentColor" aria-hidden="true"><g>${teeth.join("")}</g>` +
    `<circle r="4.6"/><circle r="2.1" fill="#1c1f23"/></svg>`
  );
}

function ensureSettingsCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
  .qgtools-set-pop { position: fixed; z-index: 10000; width: 300px; background: #1c1f23;
    border: 1px solid #3a4047; border-radius: 7px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
    font: 12px system-ui; color: #d7dde2; display: flex; flex-direction: column; }
  .qgtools-set-pop * { box-sizing: border-box; }
  .qgtools-set-head { display: flex; align-items: center; gap: 7px; padding: 9px 10px;
    border-bottom: 1px solid #2c3238; color: ${BRAND}; font-weight: 600; }
  .qgtools-set-head svg { flex: none; }
  .qgtools-set-close { margin-left: auto; width: 22px; height: 22px; border: none;
    border-radius: 5px; background: transparent; color: #9ba2aa; cursor: pointer;
    font-size: 14px; line-height: 1; }
  .qgtools-set-close:hover { background: #2c3238; color: #fff; }
  .qgtools-set-body { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 10px;
    max-height: 60vh; overflow-y: auto; }
  /* Rows keep their full height and the body scrolls: a shrinking row in a
     short window lets its wrapped hint spill over the next row. */
  .qgtools-set-body > * { flex-shrink: 0; }
  .qgtools-set-section { padding: 10px 0 3px; color: #9ba2aa; font-size: 10px;
    font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .qgtools-set-row { display: flex; align-items: center; gap: 10px; min-height: 32px;
    padding: 2px 0; }
  .qgtools-set-label { flex: 1 1 auto; min-width: 0; }
  .qgtools-set-label .hint { display: block; color: #9ba2aa; font-size: 10.5px;
    line-height: 1.35; margin-top: 1px; }
  .qgtools-set-toggle { width: 30px; height: 16px; border-radius: 8px; border: none;
    background: #3a4047; cursor: pointer; position: relative; flex: none; padding: 0; }
  .qgtools-set-toggle::after { content: ""; position: absolute; top: 2px; left: 2px;
    width: 12px; height: 12px; border-radius: 50%; background: #9ba2aa; transition: left .12s; }
  .qgtools-set-toggle.on { background: ${BRAND}; }
  .qgtools-set-toggle.on::after { left: 16px; background: #fff; }
  .qgtools-set-input { width: 72px; height: 24px; border: 1px solid #3a4047; border-radius: 5px;
    background: #23272c; color: inherit; text-align: center; outline: none; flex: none; }
  .qgtools-set-input.wide { width: 110px; text-align: left; padding: 0 8px; }
  .qgtools-set-input:focus { border-color: ${BRAND}; }
  .qgtools-set-seg { display: flex; flex: none; border: 1px solid #3a4047; border-radius: 5px;
    overflow: hidden; }
  .qgtools-set-seg button { height: 24px; border: none; background: #23272c; color: #9ba2aa;
    cursor: pointer; padding: 0 9px; font: inherit; white-space: nowrap; }
  .qgtools-set-seg button + button { border-left: 1px solid #3a4047; }
  .qgtools-set-seg button.on { background: ${BRAND}; color: #08211f; font-weight: 600; }
  .qgtools-set-foot { display: flex; align-items: center; gap: 8px; padding: 9px 10px;
    border-top: 1px solid #2c3238; }
  .qgtools-set-gearrow { display: flex; align-items: center; justify-content: flex-end;
    width: 100%; height: 24px; padding: 0 2px; box-sizing: border-box; }
  .qgtools-set-gearbtn { width: 24px; height: 24px; border: 1px solid #3a4047;
    border-radius: 5px; background: #23272c; color: #9ba2aa; cursor: pointer;
    display: grid; place-items: center; flex: none; padding: 0; }
  .qgtools-set-gearbtn:hover { border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-set-text { color: #b9c2c9; font-size: 12px; line-height: 1.45;
    padding: 4px 0 2px; }
  .qgtools-set-dl { display: flex; flex-direction: column; gap: 5px; padding: 2px 0 4px; }
  .qgtools-set-dl .term { color: ${BRAND}; font-weight: 600; }
  .qgtools-set-dl .detail { color: #9ba2aa; line-height: 1.4; }
  .qgtools-set-btn { height: 24px; border: 1px solid #3a4047; border-radius: 5px;
    background: #23272c; color: #d7dde2; cursor: pointer; padding: 0 12px; font: inherit;
    flex: none; white-space: nowrap; }
  .qgtools-set-btn:hover { border-color: ${BRAND}; }
  .qgtools-set-btn.primary { margin-left: auto; border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-set-btn.primary:hover { background: ${BRAND}; color: #08211f; }
  .qgtools-set-check { flex: none; width: 14px; height: 14px; margin: 0; accent-color: ${BRAND};
    cursor: pointer; }
  .qgtools-set-labeltop { display: flex; align-items: center; gap: 7px; }
  .qgtools-set-row.off .qgtools-set-label { color: #7e868e; }
  .qgtools-set-row.off .qgtools-set-label .hint { color: #6a727a; }
  .qgtools-set-ctl { display: flex; align-items: center; gap: 6px; flex: none; }
  .qgtools-set-ctl.off { opacity: .38; }
  .qgtools-set-slider { flex: none; width: 76px; height: 14px; accent-color: ${BRAND};
    cursor: pointer; margin: 0; }
  .qgtools-set-ctl.off .qgtools-set-slider, .qgtools-set-ctl.off .qgtools-set-input {
    pointer-events: none; }
  .qgtools-set-trash { flex: none; width: 20px; height: 20px; border: none; border-radius: 4px;
    background: transparent; color: #9ba2aa; cursor: pointer; padding: 0; display: grid;
    place-items: center; }
  .qgtools-set-trash:hover { background: #2c3238; color: #ff8a80; }
  .qgtools-set-trash.hidden { visibility: hidden; pointer-events: none; }
  .qgtools-set-moddot { flex: none; width: 5px; height: 5px; border-radius: 50%;
    background: ${BRAND}; }
  .qgtools-set-moddot.hidden { visibility: hidden; }
  `;
  document.head.append(style);
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// One popup at a time, every listener on one AbortController — the same
// discipline the LoRA picker popups use, so teardown cannot leak.
let activeMenu = null;

export function closeSettingsMenu() {
  if (!activeMenu) return;
  activeMenu.abort.abort();
  activeMenu.element.remove();
  activeMenu = null;
}

function buildControl(entry, values, commit) {
  if (entry.type === "action") {
    // A one-shot command living among the settings: no value, no storage,
    // just a button. { key, label, hint, type: "action", button, onAction }.
    const button = el("button", "qgtools-set-btn", entry.button ?? "Run");
    button.type = "button";
    button.addEventListener("click", () => entry.onAction?.());
    return button;
  }
  if (entry.type === "toggle") {
    const toggle = el("button", `qgtools-set-toggle${values[entry.key] ? " on" : ""}`);
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      const next = !toggle.classList.contains("on");
      toggle.classList.toggle("on", next);
      commit(entry, next);
    });
    return toggle;
  }
  if (entry.type === "choice") {
    const seg = el("div", "qgtools-set-seg");
    for (const option of entry.options ?? []) {
      const button = el("button", values[entry.key] === option ? "on" : "", option);
      button.type = "button";
      button.addEventListener("click", () => {
        for (const sibling of seg.children) sibling.classList.remove("on");
        button.classList.add("on");
        commit(entry, option);
      });
      seg.append(button);
    }
    return seg;
  }
  if (entry.type === "number" && entry.scrub) {
    // Whole numbers unless the entry asks for decimals (a strength).
    const control = makeScrubInput({
      value: values[entry.key], min: entry.min, max: entry.max,
      step: entry.step ?? 1, fineStep: entry.fineStep ?? entry.step ?? 1, decimals: entry.decimals ?? 0,
      title: entry.hint ?? entry.label,
      onChange: (value) => commit(entry, value),
    });
    return control.root;
  }
  const input = el("input", `qgtools-set-input${entry.type === "text" ? " wide" : ""}`);
  input.type = "text";
  if (entry.type === "number") input.inputMode = "decimal";
  if (entry.placeholder) input.placeholder = entry.placeholder;
  input.value = String(values[entry.key]);
  const commitInput = () => {
    const coerced = commit(entry, input.value);
    input.value = String(coerced);
  };
  input.addEventListener("change", commitInput);
  input.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key !== "Enter") return;
    // Ctrl + Enter keeps the typed value and goes on to ComfyUI to run.
    if (!isAppShortcut(event)) event.preventDefault();
    commitInput();
  });
  if (!entry.slider) return input;

  // Slider + box drive one value: the range is the coarse gesture, the box is
  // the exact one, so neither is authoritative and both mirror each other.
  const wrap = el("div", "qgtools-set-ctl");
  const slider = el("input", "qgtools-set-slider");
  slider.type = "range";
  slider.min = String(entry.min ?? 0);
  slider.max = String(entry.max ?? 1);
  slider.step = String(entry.step ?? 0.01);
  slider.value = String(values[entry.key]);
  slider.addEventListener("input", () => {
    const coerced = commit(entry, slider.value);
    input.value = String(coerced);
  });
  input.addEventListener("change", () => { slider.value = input.value; });
  wrap.append(slider, input);
  return wrap;
}

function trashIconSvg() {
  return (
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4"/></svg>'
  );
}

// A right-aligned gear row for panels that have no other chrome to hang the
// gear on. Returns the row element; wire the click yourself.
export function makeGearRow(titleText) {
  ensureSettingsCss();
  const row = el("div", "qgtools-set-gearrow");
  const button = el("button", "qgtools-set-gearbtn");
  button.type = "button";
  button.title = titleText ?? "Settings";
  button.innerHTML = gearIconSvg();
  row.append(button);
  return { row, button };
}

// A read-only help card in the same popup slot as the settings menu — the
// title-bar "?" badge opens one. `sections` mixes prose and term lists:
//   { text: "..." } | { heading: "Inputs", items: [{ term, detail }] }
export function openInfoCard({ anchor, title, sections }) {
  ensureSettingsCss();
  closeSettingsMenu();

  const pop = el("div", "qgtools-set-pop");
  const head = el("div", "qgtools-set-head");
  const close = el("button", "qgtools-set-close", "×");
  close.type = "button";
  close.addEventListener("click", () => closeSettingsMenu());
  head.append(el("span", "", title ?? "About this node"), close);

  const body = el("div", "qgtools-set-body");
  for (const section of sections ?? []) {
    if (section.text) body.append(el("div", "qgtools-set-text", section.text));
    if (!section.items?.length) continue;
    if (section.heading) body.append(el("div", "qgtools-set-section", section.heading));
    const list = el("div", "qgtools-set-dl");
    for (const item of section.items) {
      const row = el("div");
      row.append(el("span", "term", item.term));
      if (item.detail) row.append(el("span", "detail", ` — ${item.detail}`));
      list.append(row);
    }
    body.append(list);
  }
  pop.append(head, body);
  document.body.append(pop);

  const abort = new AbortController();
  const place = () => {
    const rect = pop.getBoundingClientRect();
    let left = Math.min(anchor.left, window.innerWidth - rect.width - 8);
    let top = anchor.bottom + 4;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - rect.height - 4);
    }
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;
  };
  place();
  requestAnimationFrame(place);
  document.addEventListener(
    "pointerdown",
    (event) => { if (!pop.contains(event.target)) closeSettingsMenu(); },
    { capture: true, signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") { event.stopPropagation(); closeSettingsMenu(); }
    },
    { capture: true, signal: abort.signal },
  );
  activeMenu = { element: pop, abort };
  return { close: closeSettingsMenu };
}

// `initial` (when given) seeds the menu from the caller's live values — a
// node's own widgets — instead of the stored defaults; edits still persist
// to storage so future nodes start there.
export function openSettingsMenu({ scope, schema, anchor, title, onChange, initial }) {
  ensureSettingsCss();
  closeSettingsMenu();

  let values = initial
    ? mergeSettings(schema, initial)
    : loadSettings(scope, schema);
  const pop = el("div", "qgtools-set-pop");

  const head = el("div", "qgtools-set-head");
  const icon = el("span");
  icon.innerHTML = gearIconSvg();
  const close = el("button", "qgtools-set-close", "×");
  close.type = "button";
  close.addEventListener("click", () => closeSettingsMenu());
  head.append(icon, el("span", "", title ?? "Settings"), close);

  const body = el("div", "qgtools-set-body");
  // What each override held before it was switched off, so ticking it back on
  // returns the user's own value rather than a canned one.
  const lastActive = {};
  const commit = (entry, raw) => {
    // Saving also records the value as the default new nodes start from
    // (unless the entry opts out with persist: false), but the menu is
    // showing THIS node: merge back only the key that changed. Taking
    // saveSetting's whole return would rebuild every other row from
    // storage and silently revert values the open node actually holds.
    const saved = saveSetting(scope, schema, entry.key, raw,
      { persist: entry.persist !== false });
    values = { ...values, [entry.key]: saved[entry.key] };
    onChange?.(values, entry.key);
    return values[entry.key];
  };
  const renderRows = () => {
    body.textContent = "";
    for (const entry of schema) {
      if (entry.key === undefined) {
        body.append(el("div", "qgtools-set-section", entry.section));
        continue;
      }
      const row = el("div", "qgtools-set-row");

      if (!isOverrideEntry(entry)) {
        const label = el("div", "qgtools-set-label", entry.label);
        if (entry.hint) label.append(el("span", "hint", entry.hint));
        row.append(label, buildControl(entry, values, commit));
        body.append(row);
        // A choice can say what each option does, one plain line apiece:
        // { ..., type: "choice", optionHints: { option: "what it does" } }.
        if (entry.optionHints) {
          const list = el("div", "qgtools-set-dl");
          for (const option of entry.options ?? []) {
            if (!entry.optionHints[option]) continue;
            const line = el("div");
            line.append(el("span", "term", option), el("span", "detail", ` — ${entry.optionHints[option]}`));
            list.append(line);
          }
          body.append(list);
        }
        continue;
      }

      // Override row: an explicit on/off box, so "off" reads as off instead
      // of relying on the user knowing the neutral value by heart.
      const check = el("input", "qgtools-set-check");
      check.type = "checkbox";
      check.title = `Send ${entry.label} with the request; off leaves it to the server`;
      const dot = el("span", "qgtools-set-moddot hidden");
      dot.title = "Changed from the suggested value";
      const trash = el("button", "qgtools-set-trash hidden");
      trash.type = "button";
      trash.innerHTML = trashIconSvg();
      trash.title = `Reset ${entry.label} to ${overrideEnableValue(entry, undefined)}`;

      const syncRow = () => {
        const on = isOverrideActive(entry, values[entry.key]);
        const custom = overrideIsCustom(entry, values[entry.key]);
        check.checked = on;
        row.classList.toggle("off", !on);
        wrap.classList.toggle("off", !on);
        dot.classList.toggle("hidden", !custom);
        trash.classList.toggle("hidden", !custom);
      };
      // Typing the neutral value by hand must uncheck the box, so the row
      // re-syncs after every edit the control itself makes.
      const control = buildControl(entry, values, (rowEntry, raw) => {
        const out = commit(rowEntry, raw);
        syncRow();
        return out;
      });
      const wrap = control.classList.contains("qgtools-set-ctl")
        ? control
        : el("div", "qgtools-set-ctl");
      if (wrap !== control) wrap.append(control);

      check.addEventListener("change", () => {
        if (!check.checked) lastActive[entry.key] = values[entry.key];
        commit(entry, check.checked
          ? overrideEnableValue(entry, lastActive[entry.key])
          : entry.neutral);
        renderRows();
      });
      trash.addEventListener("click", () => {
        commit(entry, overrideEnableValue(entry, undefined));
        renderRows();
      });

      const labelBox = el("div", "qgtools-set-label");
      const labelTop = el("div", "qgtools-set-labeltop");
      labelTop.append(check, el("span", "", entry.label));
      labelBox.append(labelTop);
      if (entry.hint) labelBox.append(el("span", "hint", entry.hint));
      row.append(labelBox, dot, trash, wrap);
      syncRow();
      body.append(row);
    }
  };
  renderRows();

  const foot = el("div", "qgtools-set-foot");
  const reset = el("button", "qgtools-set-btn", "Reset");
  reset.type = "button";
  reset.title = "Back to defaults for this node type";
  reset.addEventListener("click", () => {
    resetSettings(scope);
    // persist:false entries mirror the open node, not a stored default, so
    // a reset leaves them as they are: resetting the LoRA Loader's gear must
    // not fold a node's separate CLIP strengths into its model strengths.
    const kept = {};
    for (const entry of schema) {
      if (entry.key !== undefined && entry.persist === false) kept[entry.key] = values[entry.key];
    }
    values = { ...schemaDefaults(schema), ...kept };
    renderRows();
    onChange?.(values, null);
  });
  const done = el("button", "qgtools-set-btn primary", "Done");
  done.type = "button";
  done.addEventListener("click", () => closeSettingsMenu());
  foot.append(reset, done);

  pop.append(head, body, foot);
  document.body.append(pop);

  const abort = new AbortController();
  const place = () => {
    const rect = pop.getBoundingClientRect();
    let left = Math.min(anchor.left, window.innerWidth - rect.width - 8);
    let top = anchor.bottom + 4;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - rect.height - 4);
    }
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;
  };
  place();
  requestAnimationFrame(place);
  document.addEventListener(
    "pointerdown",
    (event) => { if (!pop.contains(event.target)) closeSettingsMenu(); },
    { capture: true, signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") { event.stopPropagation(); closeSettingsMenu(); }
    },
    { capture: true, signal: abort.signal },
  );
  activeMenu = { element: pop, abort };
  return { close: closeSettingsMenu };
}
