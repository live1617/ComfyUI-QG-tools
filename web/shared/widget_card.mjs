// The widget card: one compact DOM panel that stands in for a node's classic
// canvas widgets - the full-width rounded rows with an arrow at each end.
//
// The widgets stay the single source of truth. Every row mirrors one hidden
// standard widget (or a pair of them): numbers become the pack's scrub
// control, short combos a segmented pill, long combos a select, booleans an
// off | on pill, strings a text field, a multiline string a textarea, and a hex
// string named like a color gets a swatch. Rows can depend on other values
// (`when`) and sit behind a disclosure (`group`), so a node with a dozen
// inputs shows the three that matter and keeps the rest one click away,
// with their values untouched.
//
// Save/load, undo, API format and widget-to-input links all keep working
// through the widgets: the card writes `widget.value`, runs the widget's own
// callback, and re-reads everything on configure, on connection changes and
// after any callback. A row whose widget is driven by a link dims out.
//
// Links still land on rows. The frontend draws a widget's input socket at
// the widget's own `y` and only while it matters (a link is being dragged
// or the socket is connected), so each hidden widget reports the y of the
// row standing in for it: drag a link over the card and a socket appears on
// every row that can take it, drop it on the row and the widget is driven
// by the link, exactly as it was with the classic widget. One socket per
// row, so a row never holds two linkable widgets: a pair either splits into
// rows or declares `top: true`, which moves its widgets' sockets up among
// the node's real inputs (the widget stays; its slot just stops being a
// "widget input" and is laid out with the others), where a link greys the
// field out like the classic converted input did.
//
// Pure decisions (which rows show, how tall the card is, how a number
// scrubs, where a socket sits) live in widget_card_math.mjs for node:test;
// this file is the DOM.
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange } from "./index.mjs?v=2026101403";
import { zh } from "./zh.mjs?v=2026101403";
import { keepKeyInField } from "./canvas_passthrough.mjs?v=2026101403";
import { createMediaPicker } from "./media_picker.mjs?v=2026101403";
import { ensureNodeMinHeight, fillNodeHeight, holdNodeMinWidth, nodeHeightAfterCardChange, pinVuePanelHeight } from "./panel_layout.mjs?v=2026101403";
import { makeScrubInput } from "./scrub_input.mjs?v=2026101403";
import { hideWidget } from "./widget_visibility.mjs?v=2026101403";
import {
  CARD_PADDING, GROUP_HEIGHT, ROW_GAP, ROW_HEIGHT, SECTION_HEIGHT, SLOT_OFFSET, UNIT_SLOT_WIDTH,
  cardHeight, commitWidgetValue, comboValues, rowHeight, rowKind, rowMuted, rowTops, scrubSteps, socketWidgetY, visibleRows,
  widgetTooltip,
} from "./widget_card_math.mjs?v=2026101403";

export * from "./widget_card_math.mjs?v=2026101403";

const CSS_ID = "qgtools-widget-card-css";
export const CARD_WIDGET = "qg_widget_card";
// The frontend's DOM-widget wrapper eats this much of the declared height
// in insets, so the widget declares content plus this and the card's rows
// get exactly the room they were measured for.
const WRAPPER_INSET = 16;
// The wrapper's top inset: where the card's element starts below the
// widget's layout y (DomWidgets: margin 10 per side).
const WRAPPER_TOP = 10;

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
// A boolean pill's state labels must fit half a control; longer text is a
// tooltip, and the pill says on / off.
const SWITCH_LABEL_MAX = 16;

export function ensureCardCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-card{position:relative;box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;gap:${ROW_GAP}px;padding:${CARD_PADDING}px 8px;overflow:hidden;border:1px solid rgba(0,180,170,.22);border-radius:8px;background:rgba(0,0,0,.28);font:12px/1.3 ${FONT};color:#c8dddd;pointer-events:none}
.qgtools-card-row{display:grid;grid-template-columns:minmax(56px,30%) 1fr;align-items:center;gap:8px;height:${ROW_HEIGHT}px;flex:none;pointer-events:auto}
.qgtools-card-row.hidden{display:none}
.qgtools-card-row.linked{opacity:.5}
.qgtools-card-row.linked .qgtools-card-control{pointer-events:none}
.qgtools-card-row.muted .qgtools-card-control{opacity:.35;pointer-events:none}
.qgtools-card-row.muted .qgtools-card-label{color:#566b69}
.qgtools-card.has-corner .qgtools-card-control{margin-right:var(--qgtools-card-corner,0px)}
.qgtools-card-corner{position:absolute;top:${CARD_PADDING}px;right:8px;height:${ROW_HEIGHT}px;display:flex;align-items:center;justify-content:flex-end;gap:5px;pointer-events:auto}
.qgtools-card-gear{width:24px;height:24px;flex:none;display:grid;place-items:center;padding:0;border:1px solid #2a3437;border-radius:6px;background:#0f1516;color:#8ba3a1;cursor:pointer}
.qgtools-card-gear:hover{border-color:${BRAND};color:${BRAND}}
.qgtools-card-chip{height:20px;flex:none;padding:0 8px;border:1px solid rgba(0,180,170,.5);border-radius:10px;background:rgba(0,180,170,.14);color:${BRAND};font:600 10px/1 ${FONT};letter-spacing:.02em;white-space:nowrap;cursor:pointer}
.qgtools-card-chip:hover{background:rgba(0,180,170,.24);color:#fff}
.qgtools-card-chip[hidden]{display:none}
.qgtools-card-row.area{display:block}
.qgtools-card-row.area.grow{flex:1 1 auto;height:auto}
.qgtools-card-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#8ba3a1;font-size:11px;user-select:none}
.qgtools-card-control{display:flex;align-items:center;gap:6px;min-width:0;height:100%}
.qgtools-card-field{display:flex;align-items:center;gap:6px;flex:1 1 0;min-width:0;height:100%}
.qgtools-card-field.linked{opacity:.5;pointer-events:none}
.qgtools-card-field>.qgtools-scrub{flex:1 1 0;width:auto;min-width:0}
.qgtools-card-field>.qgtools-scrub .qgtools-scrub-input{width:100%}
.qgtools-card-sep{flex:none;color:#5f7674;font-size:11px}
.qgtools-card-suffix{flex:none;color:#5f7674;font-size:10px;letter-spacing:.06em;text-transform:uppercase;user-select:none}
.qgtools-card-section{height:${SECTION_HEIGHT}px;flex:none;display:flex;align-items:flex-end;color:#5f7674;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;user-select:none}
.qgtools-card-section.hidden{display:none}
.qgtools-card-group{height:${GROUP_HEIGHT}px;flex:none;display:flex;align-items:center;gap:6px;padding:0 4px;border:1px solid transparent;border-radius:6px;background:transparent;color:#78908e;font:600 10.5px/1 ${FONT};letter-spacing:.06em;text-transform:uppercase;cursor:pointer;text-align:left;pointer-events:auto}
.qgtools-card-group:hover{color:#fff;border-color:#2a3437}
.qgtools-card-group .glyph{display:inline-block;width:10px;transition:transform .12s}
.qgtools-card-group.open .glyph{transform:rotate(90deg)}
.qgtools-card-seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;width:100%;height:${ROW_HEIGHT}px;padding:2px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#0f1516}
.qgtools-card-seg button{min-width:0;border:none;border-radius:4px;padding:0 2px;background:transparent;color:#8ba3a1;font:600 10.5px/1 ${FONT};cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qgtools-card-seg button:hover{color:#fff}
.qgtools-card-seg button.on{background:${BRAND};color:#04201d}
.qgtools-card-select{width:100%;height:${ROW_HEIGHT}px;padding:0 24px 0 8px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#0b0f10 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238ba3a1' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 8px center;color:#d8ecea;font:600 11.5px ${FONT};appearance:none;-webkit-appearance:none;cursor:pointer;overflow:hidden;text-overflow:ellipsis}
.qgtools-card-select:hover{border-color:${BRAND}}
.qgtools-card-select:focus-visible{outline:2px solid ${BRAND};outline-offset:1px}
.qgtools-card-text{width:100%;height:${ROW_HEIGHT}px;padding:0 8px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#0b0f10;color:#d8ecea;font:12px ${FONT};min-width:0}
.qgtools-card-text:focus{outline:none;border-color:${BRAND}}
.qgtools-card-text::placeholder{color:#4f6462}
.qgtools-card-area{display:block;width:100%;height:100%;padding:5px 8px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#0b0f10;color:#d8ecea;font:12px/1.4 ${FONT};resize:none;overflow:auto;min-width:0}
.qgtools-card-area:focus{outline:none;border-color:${BRAND}}
.qgtools-card-area::placeholder{color:#4f6462}
.qgtools-card-swatch{flex:none;width:${ROW_HEIGHT}px;height:${ROW_HEIGHT}px;padding:0;border:1px solid #2a3437;border-radius:6px;background:#0b0f10;cursor:pointer}
.qgtools-card-swatch::-webkit-color-swatch-wrapper{padding:3px}
.qgtools-card-swatch::-webkit-color-swatch{border:none;border-radius:3px}
.qgtools-card-btn{flex:none;height:${ROW_HEIGHT}px;padding:0 10px;border:1px solid #2a3437;border-radius:6px;background:#16201f;color:#d8ecea;font:600 11px/1 ${FONT};cursor:pointer;white-space:nowrap}
.qgtools-card-btn:hover{border-color:${BRAND};color:#fff}
`;
  document.head.append(style);
}

// ---------- DOM ----------

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name) ?? null;
}

function widgetSlot(node, name) {
  return node.inputs?.find((input) => input?.widget?.name === name || input?.name === name) ?? null;
}

// A `top: true` row's widgets keep their input slots but the slots stop
// being widget inputs: the frontend then measures and draws them in the
// node's slot column, and a link into one is resolved by input name.
export function liftSocket(node, name) {
  const slot = node.inputs?.find((input) => input?.widget?.name === name);
  if (!slot) return false;
  delete slot.widget;
  slot._widget = undefined;
  return true;
}

function widgetLinked(node, name) {
  const slot = widgetSlot(node, name);
  return Boolean(slot && slot.link !== null && slot.link !== undefined);
}

function isFloatWidget(widget) {
  const precision = widget?.options?.precision;
  if (precision !== undefined) return Number(precision) > 0;
  const step = widget?.options?.step2 ?? widget?.options?.round;
  return step !== undefined ? !Number.isInteger(Number(step)) : !Number.isInteger(Number(widget?.value));
}

// Mount a card on `node`. Rows:
//   { widget, label?, kind?, labels?, suffix?, title?, when?, group?, linkedBy?, snap?, pixels?, step? }
//                                          - `linkedBy` names other inputs
//                                            whose link also dims the row
//                                            (a wired source replacing a
//                                            file picker); `snap` steps a
//                                            number on multiples of its
//                                            step (1, 8, 16, not 1, 9, 17);
//                                            a whole number steps by 1
//                                            unless the row is a pixel size
//                                            (`suffix: "px"` or `pixels`),
//                                            which steps by 8, or names
//                                            its own `step`
//   { widget, kind: "textarea", placeholder?, height, grow? }  - a multiline
//                                             string; `grow` takes the node's
//                                             spare height
//   { pair: [name, name, ...], label, sep?, when?, group?, suffix?, top? }
//                                          - `top` lifts the widgets' sockets
//                                            into the node's slot column
//   { section: "Caption" }
//   { group: "advanced", label: "More" }   - a disclosure; later rows with
//                                             group: "advanced" sit under it
// Rows may also carry `mute: (values) => boolean` and `muteTitle`: a muted
// row stays in place but dims and stops taking input, with the title as its
// hover hint (a setting the current mode does not use).
// Options: minWidth (node floor), first (place the card ahead of the node's
// other DOM widgets), hide (extra widgets to hide), corner (small tools in
// the card's top-right corner, see below).
export function mountWidgetCard(node, { rows, minWidth = 300, first = false, hide = [], corner = null } = {}) {
  ensureCardCss();
  const root = el("div", "qgtools-card");
  const managed = [];
  const state = { node, root, rows: [], groups: {}, height: 0, widget: null, rowTop: new Map(), rowSpan: new Map(), socketed: [], pickers: [] };
  node.__qgCard = state;

  const values = () => Object.fromEntries((node.widgets ?? []).map((widget) => [widget.name, widget.value]));
  const groupProperty = (name) => `qg_show_${name}`;
  const groupOpen = (name) => Boolean(node.properties?.[groupProperty(name)]);
  // What the person changes on the card itself. A row it brings in or takes
  // out moves the node's height with it (nodeHeightAfterCardChange).
  const byHand = (run) => {
    state.byHand = true;
    try { return run(); } finally { state.byHand = false; }
  };
  const setGroupOpen = (name, open) => {
    node.properties ??= {};
    node.properties[groupProperty(name)] = Boolean(open);
    byHand(refresh);
  };

  const setWidget = (name, value, { settle = true } = {}) => {
    const widget = findWidget(node, name);
    if (!widget || widget.value === value) return;
    byHand(() => commitWidgetValue(node, widget, value, globalThis.app?.canvas));
    node.graph?.setDirtyCanvas?.(true, true);
    if (settle) notifyQgChange();
  };

  // Every row keeps a `sync(values, linked)` that writes the widget's value
  // into its control, so a refresh is one loop.
  const buildScrub = (name, row, into) => {
    const widget = findWidget(node, name);
    const isFloat = isFloatWidget(widget);
    const steps = scrubSteps(widget?.options, isFloat, row.pixels ?? row.suffix === "px");
    const control = makeScrubInput({
      value: Number(widget?.value) || 0,
      min: Number(widget?.options?.min ?? -Infinity),
      max: Number(widget?.options?.max ?? Infinity),
      step: row.step ?? steps.step,
      fineStep: steps.fineStep,
      decimals: row.decimals ?? steps.decimals,
      title: row.title ?? widgetTooltip(node, name, widget),
      unit: row.suffix ?? "",
      // Single fields share one unit slot so their numbers line up down
      // the card; the fields of a pair sit side by side and keep the room.
      unitWidth: row.pair ? 0 : UNIT_SLOT_WIDTH,
      snap: Boolean(row.snap),
      onChange: (next) => setWidget(name, isFloat ? next : Math.round(next), { settle: false }),
      onSettle: () => notifyQgChange(),
    });
    into.append(control.root);
    return (vals) => control.set(Number(vals[name]) || 0);
  };

  const buildSegment = (name, row, into) => {
    const widget = findWidget(node, name);
    const seg = el("div", "qgtools-card-seg");
    const buttons = new Map();
    for (const value of comboValues(widget)) {
      const button = el("button", "", row.labels?.[value] ?? String(value));
      button.type = "button"; button.title = row.titles?.[value] ?? String(value);
      button.addEventListener("click", () => setWidget(name, value));
      seg.append(button); buttons.set(value, button);
    }
    into.append(seg);
    return (vals) => { for (const [value, button] of buttons) button.classList.toggle("on", vals[name] === value); };
  };

  const buildSelect = (name, row, into) => {
    const widget = findWidget(node, name);
    // A file source (`preview: { kind, url }`) gets the media picker: a list
    // that previews the hovered file, which a native <select> cannot do.
    if (row.preview) {
      const noun = row.preview.kind === "video" ? "video" : "image";
      const picker = createMediaPicker({
        kind: noun,
        className: "qgtools-card-select",
        placeholder: row.preview.placeholder ?? `Choose an uploaded ${noun}…`,
        viewUrl: row.preview.url,
        label: row.label,
        getOptions: () => comboValues(widget),
        getValue: () => widget?.value,
        onChange: (value) => setWidget(name, value),
      });
      state.pickers.push(picker);
      into.append(picker.element);
      return (vals) => picker.refresh(vals[name]);
    }
    const select = el("select", "qgtools-card-select");
    select.title = row.title ?? widgetTooltip(node, name, widget);
    const fill = (current) => {
      select.textContent = "";
      const options = comboValues(widget);
      const list = options.includes(current) || current === undefined || current === "" ? options : [...options, current];
      for (const value of list) {
        const option = el("option", "", row.labels?.[value] ?? String(value)); option.value = String(value); select.append(option);
      }
      select.value = String(current ?? "");
    };
    select.addEventListener("change", () => setWidget(name, select.value));
    into.append(select);
    return (vals) => fill(vals[name]);
  };

  // A boolean is a two-segment pill, off on the left and on on the right,
  // as wide as any other control on the card; the short `offText` /
  // `onText` name the states ("off | embed workflow"), longer descriptions
  // ride on the tooltip.
  const buildSwitch = (name, row, into) => {
    const widget = findWidget(node, name);
    const seg = el("div", "qgtools-card-seg qgtools-card-bool");
    seg.setAttribute("role", "radiogroup");
    const label = (text, fallback) => (typeof text === "string" && text.length <= SWITCH_LABEL_MAX ? text : fallback);
    const buttons = new Map();
    for (const [value, text] of [[false, label(row.offText, "off")], [true, label(row.onText, "on")]]) {
      const button = el("button", "", text);
      button.type = "button";
      button.title = row.title ?? (widgetTooltip(node, name, widget) || (value ? row.onText ?? "" : row.offText ?? ""));
      button.addEventListener("click", () => setWidget(name, value));
      seg.append(button); buttons.set(value, button);
    }
    into.append(seg);
    return (vals) => {
      const on = Boolean(vals[name]);
      for (const [value, button] of buttons) {
        button.classList.toggle("on", value === on);
        button.setAttribute("aria-checked", String(value === on));
      }
    };
  };

  const buildText = (name, row, into) => {
    const widget = findWidget(node, name);
    const input = el("input", "qgtools-card-text");
    input.type = "text"; input.placeholder = row.placeholder ?? ""; input.title = row.title ?? widgetTooltip(node, name, widget);
    input.spellcheck = false;
    const commit = () => { if (input.value !== String(findWidget(node, name)?.value ?? "")) setWidget(name, input.value); };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      keepKeyInField(event);
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") { input.value = String(findWidget(node, name)?.value ?? ""); input.blur(); }
    });
    into.append(input);
    return (vals) => { if (document.activeElement !== input) input.value = String(vals[name] ?? ""); };
  };

  // A multiline string. The frontend's own textarea for the widget stays
  // mounted (hidden) underneath, so dynamic prompts, serialization and the
  // widget's input socket are all still its business; this box only edits
  // the same value.
  const buildTextarea = (name, row, into) => {
    const widget = findWidget(node, name);
    if (widget?.element) widget.element.style.display = "none";
    const area = el("textarea", "qgtools-card-area");
    area.placeholder = row.placeholder ?? row.label ?? name;
    area.title = row.title ?? widgetTooltip(node, name, widget);
    area.spellcheck = false;
    let typing = false;
    area.addEventListener("input", () => { typing = true; setWidget(name, area.value, { settle: false }); typing = false; });
    area.addEventListener("change", () => notifyQgChange());
    area.addEventListener("keydown", (event) => {
      keepKeyInField(event);
      if (event.key === "Escape") area.blur();
    });
    // The box scrolls its own overflow; the canvas only zooms once it is
    // at an end.
    area.addEventListener("wheel", (event) => {
      const down = event.deltaY > 0;
      const atEnd = down ? area.scrollTop + area.clientHeight >= area.scrollHeight - 1 : area.scrollTop <= 0;
      if (!atEnd) event.stopPropagation();
    }, { passive: true });
    into.append(area);
    return (vals) => { if (!typing && document.activeElement !== area) area.value = String(vals[name] ?? ""); };
  };

  const buildColor = (name, row, into) => {
    const widget = findWidget(node, name);
    const swatch = el("input", "qgtools-card-swatch"); swatch.type = "color";
    swatch.title = zh("Pick a color");
    const input = el("input", "qgtools-card-text"); input.type = "text"; input.spellcheck = false;
    input.title = row.title ?? widgetTooltip(node, name, widget);
    const commit = () => { if (input.value !== String(findWidget(node, name)?.value ?? "")) setWidget(name, input.value.trim()); };
    swatch.addEventListener("input", () => { input.value = swatch.value; setWidget(name, swatch.value, { settle: false }); });
    swatch.addEventListener("change", () => notifyQgChange());
    input.addEventListener("change", commit); input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => { keepKeyInField(event); if (event.key === "Enter") input.blur(); });
    into.append(swatch, input);
    return (vals) => {
      const text = String(vals[name] ?? "");
      if (document.activeElement !== input) input.value = text;
      if (/^#[0-9a-f]{6}$/i.test(text)) swatch.value = text.toLowerCase();
    };
  };

  const buildButton = (row, into) => {
    const button = el("button", "qgtools-card-btn", row.text ?? "Go");
    button.type = "button"; button.title = row.title ?? "";
    button.addEventListener("click", () => row.onClick?.(node, state));
    into.append(button);
  };

  const builders = { scrub: buildScrub, segment: buildSegment, select: buildSelect, switch: buildSwitch, text: buildText, textarea: buildTextarea, color: buildColor };

  for (const name of hide) { const widget = findWidget(node, name); if (widget) { hideWidget(widget); managed.push(name); } }
  const topNames = new Set(rows.filter((row) => row.top).flatMap((row) => row.pair ?? (row.widget ? [row.widget] : [])));
  for (const name of topNames) liftSocket(node, name);
  let currentGroup = null;
  for (const row of rows) {
    if (row.section !== undefined) {
      const caption = el("div", "qgtools-card-section", row.section);
      state.rows.push({ row: { ...row, inGroup: currentGroup }, element: caption, syncs: [] });
      root.append(caption); continue;
    }
    if (row.group !== undefined && row.widget === undefined && row.pair === undefined) {
      currentGroup = row.group;
      const header = el("button", "qgtools-card-group");
      header.type = "button"; header.title = row.title ?? "";
      header.append(el("span", "glyph", "▸"), el("span", "", row.label ?? row.group));
      header.addEventListener("click", () => setGroupOpen(row.group, !groupOpen(row.group)));
      state.rows.push({ row, element: header, header: true, syncs: [] });
      root.append(header); continue;
    }
    const names = row.pair ?? [row.widget];
    for (const name of names) { const widget = findWidget(node, name); if (widget) { hideWidget(widget); managed.push(name); } }
    const line = el("div", "qgtools-card-row");
    const control = el("div", "qgtools-card-control");
    const syncs = [];
    const isArea = row.kind === "textarea";
    if (isArea) {
      line.classList.add("area");
      if (row.grow) { line.classList.add("grow"); line.style.minHeight = `${rowHeight(row)}px`; }
      else line.style.height = `${rowHeight(row)}px`;
    } else {
      const label = el("span", "qgtools-card-label", row.label ?? names[0]);
      label.title = row.title ?? widgetTooltip(node, names[0], findWidget(node, names[0]));
      line.append(label);
    }
    const fields = new Map();
    names.forEach((name, index) => {
      if (index > 0) control.append(el("span", "qgtools-card-sep", row.sep ?? "·"));
      const widget = findWidget(node, name);
      const kind = rowKind(row, widget);
      if (kind === "skip" || !widget) return;
      if (row.prefixes?.[index]) control.append(el("span", "qgtools-card-sep", row.prefixes[index]));
      const field = el("div", "qgtools-card-field");
      syncs.push(builders[kind](name, row, field));
      control.append(field);
      fields.set(name, field);
    });
    if (row.button) buildButton(row.button, control);
    line.append(control);
    state.rows.push({ row: { ...row, inGroup: row.group ?? null }, element: line, names, syncs, fields });
    root.append(line);
  }

  // ---------- corner tools ----------
  // `corner(node, { values, setWidget })` returns { element, sync(values) }:
  // tools that sit in the card's top-right corner, level with the first row
  // (a gear, a mode chip). sync returns how many pixels they need, and every
  // row's control keeps that much clear, so the controls down the card still
  // share one right edge.
  const tools = typeof corner === "function" ? corner(node, { values, setWidget }) : null;
  if (tools?.element) {
    const holder = el("div", "qgtools-card-corner");
    holder.append(tools.element);
    root.classList.add("has-corner");
    root.append(holder);
  }

  // Clicks on controls stay out of the graph's drag; empty card space falls through.
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,input,select,textarea,.qgtools-scrub")) event.stopPropagation();
  });

  const grows = rows.some((row) => row.grow);
  const widget = node.addDOMWidget(CARD_WIDGET, CARD_WIDGET, root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => state.height + WRAPPER_INSET,
  });
  keepDomWidgetWidthAuto(widget);
  // The card is not a value, so it is not saved with the workflow either.
  // options.serialize only keeps it out of the prompt; saves skip a widget
  // whose own serialize is false. Saved values come back by position, and
  // the "" a card saved before this lands on any input appended after it,
  // which is why cards still carry resetUnknown for older workflows.
  widget.serialize = false;
  state.widget = widget;
  if (grows) {
    // A card with a growing textarea is a viewport: it declares a floor and
    // takes the node's spare height, the textarea flexing to fill it.
    fillNodeHeight(widget, {
      minWidth,
      minHeight: () => state.height + WRAPPER_INSET,
      minNodeSize: [minWidth, 60],
      exactMinWidth: true,
    });
  } else {
    // A constant-height card, pinned on purpose (tests/panel_guards.test.mjs,
    // fixedByDesign): its height is the sum of its rows, not a viewport.
    widget.computeSize = (width) => [Math.max(minWidth, Number(width || node.size?.[0] || minWidth)), state.height + WRAPPER_INSET];
    // Pinned in Nodes 2.0 as well, so a picture panel under the card takes
    // the node's spare height there too.
    pinVuePanelHeight(widget);
    widget.options.minNodeSize = [minWidth, 60];
    // The frontend never reads that width for a pinned widget: the card's
    // number has to be made the node's floor by hand.
    holdNodeMinWidth(widget, minWidth);
  }
  if (first && Array.isArray(node.widgets)) {
    const index = node.widgets.indexOf(widget);
    const firstDom = node.widgets.findIndex((item) => item !== widget && item.element);
    if (index >= 0 && firstDom >= 0 && firstDom < index) {
      node.widgets.splice(index, 1); node.widgets.splice(firstDom, 0, widget);
    }
  }

  // ---------- sockets ----------
  // Each hidden widget with an input slot reports the y of its row, so the
  // frontend draws (and hit-tests) its socket there. A row folded away
  // hands its socket to its group header, or to the card's top edge.
  const socketY = (name) => {
    if (state.disposed) return null;
    const target = findWidget(node, name);
    if (!target?.hidden) return null;
    const cardY = Number(state.widget?.y);
    if (!Number.isFinite(cardY)) return null;
    const top = state.rowTop.get(name);
    const span = state.rowSpan.get(name);
    if (top === undefined) return cardY + WRAPPER_TOP - SLOT_OFFSET;
    return socketWidgetY(cardY, WRAPPER_TOP, top, span ?? ROW_HEIGHT);
  };
  for (const name of new Set(managed)) {
    if (topNames.has(name)) continue;
    const target = findWidget(node, name);
    if (!target || !widgetSlot(node, name)) continue;
    const own = Object.getOwnPropertyDescriptor(target, "y");
    if (own?.get) continue;
    let stored = target.y;
    try {
      Object.defineProperty(target, "y", {
        configurable: true, enumerable: true,
        get: () => socketY(name) ?? stored,
        set: (value) => { stored = value; },
      });
      state.socketed.push({ widget: target, restore: () => { delete target.y; target.y = stored; } });
    } catch { /* sealed widget: its socket stays wherever the frontend leaves it */ }
  }

  // While a link is being dragged, the row under the pointer stands in for
  // its widget, so a drop anywhere on the row lands on that widget's input.
  // Outside a drag the card is one widget to the canvas, as before.
  const rowWidgetAt = (canvasX, canvasY, { lifted = false } = {}) => {
    const cardY = Number(state.widget?.y);
    if (!Number.isFinite(cardY)) return null;
    const localY = canvasY - node.pos[1] - cardY - WRAPPER_TOP;
    for (const entry of state.rows) {
      if (!entry.names?.length || Boolean(entry.row.top) !== lifted) continue;
      const top = state.rowTop.get(entry.names[0]);
      if (top === undefined) continue;
      const span = state.rowSpan.get(entry.names[0]) ?? ROW_HEIGHT;
      if (localY < top || localY > top + span) continue;
      if (entry.names.length === 1) return entry.names[0];
      // A pair: the field under the pointer, by its on-screen box.
      const canvas = globalThis.app?.canvas;
      const rect = canvas?.canvas?.getBoundingClientRect?.();
      const scale = canvas?.ds?.scale || 1;
      const offset = canvas?.ds?.offset || [0, 0];
      const clientX = rect ? rect.left + (canvasX + offset[0]) * scale : null;
      const boxes = [...entry.element.querySelectorAll(".qgtools-scrub, .qgtools-card-text, .qgtools-card-select")];
      const hit = clientX === null ? -1 : boxes.findIndex((box) => { const r = box.getBoundingClientRect(); return clientX >= r.left && clientX <= r.right; });
      return entry.names[Math.max(0, Math.min(entry.names.length - 1, hit))];
    }
    return null;
  };
  const originalGetWidgetOnPos = node.getWidgetOnPos;
  if (typeof originalGetWidgetOnPos === "function") {
    node.getWidgetOnPos = function (canvasX, canvasY, includeDisabled) {
      const found = originalGetWidgetOnPos.call(this, canvasX, canvasY, includeDisabled);
      if (state.disposed || found !== state.widget) return found;
      if (!globalThis.app?.canvas?.linkConnector?.isConnecting) return found;
      const name = rowWidgetAt(canvasX, canvasY);
      return (name && findWidget(this, name)) || found;
    };
  }
  // The fields of a pair share one socket on their row's left edge. A drop
  // on that socket goes to the first field of the pair still free, so a
  // second link does not silently replace the first; to aim at one field,
  // drop on the field itself.
  // A `top` row's fields have their sockets up in the slot column, but a
  // drop on the field itself still means that field.
  const originalGetInputOnPos = node.getInputOnPos;
  if (typeof originalGetInputOnPos === "function") {
    node.getInputOnPos = function (pos) {
      const input = originalGetInputOnPos.call(this, pos);
      if (state.disposed) return input;
      if (!input && globalThis.app?.canvas?.linkConnector?.isConnecting) {
        const topName = rowWidgetAt(pos[0], pos[1], { lifted: true });
        if (topName) return widgetSlot(this, topName) ?? input;
      }
      const name = input?.widget?.name;
      if (!name || input.link === null || input.link === undefined) return input;
      const entry = state.rows.find((item) => item.names?.length > 1 && !item.row.top && item.names.includes(name));
      if (!entry) return input;
      const free = entry.names.find((other) => { const slot = widgetSlot(this, other); return slot && (slot.link === null || slot.link === undefined); });
      return free ? widgetSlot(this, free) : input;
    };
  }

  function refresh() {
    if (state.disposed) return;
    const vals = values();
    const groups = {};
    for (const entry of state.rows) if (entry.header) groups[entry.row.group] = groupOpen(entry.row.group);
    const visible = visibleRows(state.rows.map((entry) => entry.row), vals, groups);
    const visibleSet = new Set(visible);
    const tops = rowTops(visible);
    state.rowTop = new Map();
    state.rowSpan = new Map();
    visible.forEach((row, index) => {
      const entry = state.rows.find((item) => item.row === row);
      for (const name of entry?.names ?? []) { state.rowTop.set(name, tops[index]); state.rowSpan.set(name, rowHeight(row)); }
      if (entry?.header) { state.rowTop.set(`group:${row.group}`, tops[index]); }
    });
    // A row folded under a closed group: its socket rides the header.
    for (const entry of state.rows) {
      if (!entry.names || visibleSet.has(entry.row) || !entry.row.inGroup) continue;
      const headerTop = state.rowTop.get(`group:${entry.row.inGroup}`);
      if (headerTop === undefined) continue;
      for (const name of entry.names) { state.rowTop.set(name, headerTop); state.rowSpan.set(name, GROUP_HEIGHT); }
    }
    for (const entry of state.rows) {
      const show = visibleSet.has(entry.row);
      entry.element.classList.toggle("hidden", !show);
      if (entry.header) entry.element.classList.toggle("open", groups[entry.row.group]);
      if (!show) continue;
      // A single field dims with its row; in a pair only the linked field
      // dims, the others stay editable.
      const linkedNames = (entry.names ?? []).filter((name) => widgetLinked(node, name));
      const linked = (linkedNames.length > 0 && linkedNames.length === (entry.names ?? []).length)
        || (entry.row.linkedBy ?? []).some((name) => widgetLinked(node, name));
      entry.element.classList.toggle("linked", linked);
      for (const [name, field] of entry.fields ?? []) field.classList.toggle("linked", linkedNames.includes(name));
      if (entry.row.mute) {
        const muted = rowMuted(entry.row, vals);
        entry.element.classList.toggle("muted", muted);
        const label = entry.element.querySelector(".qgtools-card-label");
        entry.baseTitle ??= label?.title ?? "";
        const hint = muted ? (entry.row.muteTitle ?? "") : "";
        entry.element.title = hint;
        if (label) label.title = hint || entry.baseTitle;
      }
      for (const sync of entry.syncs) sync(vals, linked);
    }
    if (tools?.sync) root.style.setProperty("--qgtools-card-corner", `${Math.max(0, Number(tools.sync(vals)) || 0)}px`);
    const height = cardHeight(visible);
    if (height !== state.height) {
      const first = !state.height;
      const change = first ? 0 : height - state.height;
      state.height = height;
      const width = Math.max(minWidth, node.size?.[0] || minWidth);
      const floor = node.computeSize?.()[1] || height;
      node.setSize?.([width, nodeHeightAfterCardChange({
        floor, current: node.size?.[1], saved: state.savedHeight, change, first, restoring: state.restoring, byHand: state.byHand,
      })]);
      node.graph?.setDirtyCanvas?.(true, true);
    }
    node._widgetSlotsDirty = true;
  }

  for (const name of new Set(managed)) {
    const target = findWidget(node, name);
    if (target) chainCallback(target, "callback", () => refresh());
  }
  chainCallback(node, "onConfigure", (info) => {
    // The node now has its saved size, and that size already holds every row
    // the saved values show. Marked here, not in the microtask below: a
    // refresh queued earlier in the load (a restored link) runs before it.
    // The height is kept too: before that microtask the frontend grows the
    // node to fit the card as it still is, with the rows of a new node.
    state.restoring = true;
    state.savedHeight = Number(info?.size?.[1]);
    queueMicrotask(() => {
      try {
        for (const name of managed) {
          const target = findWidget(node, name);
          hideWidget(target);
          if (target?.element && state.rows.some((entry) => entry.row.kind === "textarea" && entry.names?.includes(name))) target.element.style.display = "none";
        }
        for (const name of topNames) liftSocket(node, name);
        refresh();
      } finally {
        state.restoring = false;
        state.savedHeight = undefined;
      }
      // A workflow saved before this card existed sized the node for the
      // classic widgets; give the card and any panel below it their floors.
      ensureNodeMinHeight(node);
    });
  });
  chainCallback(node, "onConnectionsChange", () => queueMicrotask(refresh));
  chainCallback(node, "onRemoved", () => {
    state.disposed = true;
    for (const picker of state.pickers) picker.dispose();
    for (const entry of state.socketed) entry.restore();
    if (typeof originalGetWidgetOnPos === "function") delete node.getWidgetOnPos;
    if (typeof originalGetInputOnPos === "function") delete node.getInputOnPos;
  });

  refresh();
  state.refresh = refresh; state.setGroupOpen = setGroupOpen; state.groupOpen = groupOpen;
  return state;
}
