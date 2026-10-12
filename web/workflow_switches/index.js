// Workflow Switches 🆎 — switch parts of a workflow off and on from one card.
//
// The backend registers the node so a workflow that uses it can find the
// pack; this file makes it virtual, so it never enters a prompt, and gives
// it its whole face: one row per switch, a label and an off | on pill.
//
// A switch is either made from picked nodes and groups (select them, press
// + Switch) or a group listed on its own. A made switch can also change
// settings instead of turning nodes off: it remembers what chosen nodes hold
// for on and for off, and a click writes the values that differ (a faster
// LoRA row and fewer steps, say). The card has two views. The edit
// view shows everything: a frame button and a menu on each row, the bar that
// makes a switch from the selection, and the settings. Done folds all of
// that away and leaves the labels and their switches: the small view a
// shared workflow ships with.
//
// Only what the user made is stored (which nodes each switch holds, by id,
// the values it remembers and the settings, in node.properties). Every row's
// state is read from the nodes' own modes and values, so a reloaded workflow, an undo or a node bypassed by
// hand elsewhere always shows right, and a switch whose nodes are only
// partly on reads mixed. The list follows the graph on the canvas's own
// redraws, which the frontend makes whenever the graph or the selection
// changes: no work while nothing changes, at most one read per RECHECK_MS
// while the canvas is busy, and always one after the last redraw. The
// decisions live in js/shared/workflow_switches.mjs under node:test.

import { app } from "/scripts/app.js";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange, showToast } from "../shared/index.mjs?v=2026101216";
import { keepKeyInField } from "../shared/canvas_passthrough.mjs?v=2026101216";
import { holdNodeMinWidth, pinVuePanelHeight } from "../shared/panel_layout.mjs?v=2026101216";
import { cardHeight, commitWidgetValue, ensureCardCss } from "../shared/widget_card.mjs?v=2026101216";
import {
  DEFAULT_SETTINGS, SETTINGS_PROPERTY, SWITCHES_MAX, TITLE_MAX, addMembers, addSwitch, flipTo, frameBounds, groupBounds, heldCount,
  hideGroup, listedRows, modeMatters, moveSwitch, normalizeSettings, pairValue, placeNodes, readGroups, readSwitches,
  removeMembers, removeSwitch, renameSwitch, restoreGroups, rowsSignature, saveValues, snapshotNode, suggestTitle, switchAllPlan,
  switchPlan, valueAllPlan, valuePlan,
} from "../shared/workflow_switches.mjs?v=2026101216";

const NODE_CLASS = "QG_WorkflowSwitches";
const CSS_ID = "qgtools-workflow-switches-css";
const WIDGET_NAME = "qg_workflow_switches";
// The two disclosures, named like a widget card's groups: the edit view, and
// the settings inside it.
const SHOW_EDIT = "qg_show_edit";
const SHOW_SETTINGS = "qg_show_settings";
const NODE_WIDTH = 320;
// The narrowest each view still reads at: a label and a pill, or those plus
// the two row buttons.
const SMALL_MIN_WIDTH = 200;
const EDIT_MIN_WIDTH = 300;
// Same wrapper allowance as the widget cards (js/shared/widget_card.mjs).
const WRAPPER_INSET = 16;
const HINT_HEIGHT = 34;
// Where the card starts under the title bar (the node has no slots).
const WIDGETS_TOP = 2;
// LiteGraph leaves room under a node's last widget for the slots a node
// usually has above it. This one has none, so the card sat twice as far from
// the bottom edge as from the title bar. This much is given back.
const BOTTOM_TRIM = 10;
const RECHECK_MS = 150;
// How much of the view the frame button fills with a part.
const FRAME_FILL = 0.8;
// What a group with no color set is drawn with (LGraphGroup.defaultColour).
const NO_COLOR = "#335";

const live = new Set();
let hookedCanvas = null;
const groupKeys = new WeakMap();
let nextGroupKey = 1;
let openMenu = null;

function ensureCss() {
  ensureCardCss();
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-ws{box-sizing:border-box;width:100%;height:100%;overflow:hidden;pointer-events:none}
.qgtools-ws .qgtools-ws-list{display:contents}
.qgtools-ws .qgtools-ws-row{grid-template-columns:10px minmax(0,1fr) auto 84px;gap:7px}
.qgtools-ws.edit .qgtools-ws-row{grid-template-columns:10px minmax(0,1fr) auto 84px 26px 26px}
.qgtools-ws-chip{width:10px;height:10px;border-radius:3px;background:var(--chip);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}
.qgtools-ws-row.off .qgtools-ws-chip{background:transparent;box-shadow:inset 0 0 0 2px var(--chip),0 0 0 1px rgba(255,255,255,.1)}
.qgtools-ws-row.mixed .qgtools-ws-chip{background:linear-gradient(90deg,var(--chip) 50%,transparent 50%);box-shadow:inset 0 0 0 2px var(--chip),0 0 0 1px rgba(255,255,255,.1)}
.qgtools-ws-row.empty .qgtools-ws-chip{opacity:.4}
.qgtools-ws-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#d8ecea;user-select:none}
.qgtools-ws-row.off .qgtools-ws-title,.qgtools-ws-row.empty .qgtools-ws-title{color:#6f8886}
.qgtools-ws-title[hidden],.qgtools-ws-name[hidden]{display:none}
.qgtools-ws-count{color:#78908e;font-size:10px;font-variant-numeric:tabular-nums;user-select:none}
.qgtools-ws-pill.mixed{background:repeating-linear-gradient(135deg,rgba(0,180,170,.2) 0 3px,transparent 3px 7px),#0f1516}
.qgtools-ws-pill.mixed button{color:#bfe6e2}
.qgtools-ws-row.empty .qgtools-ws-pill{opacity:.35;pointer-events:none}
.qgtools-ws-tool{display:none;place-items:center;width:26px;height:26px;padding:0;border:1px solid #2a3437;border-radius:6px;background:#0f1516;color:#8ba3a1;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws.edit .qgtools-ws-tool{display:grid}
.qgtools-ws-tool:hover,.qgtools-ws-tool.open{border-color:${BRAND};color:#fff}
.qgtools-ws-restore{height:26px;padding:0 12px;border:1px solid #2a3437;border-radius:6px;background:#0f1516;color:#8ba3a1;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws-restore:hover{border-color:${BRAND};color:#fff}
.qgtools-ws-tool svg{display:block}
.qgtools-ws-hint{height:${HINT_HEIGHT}px;flex:none;display:flex;align-items:center;padding:0;border:none;background:transparent;color:#78908e;font:inherit;font-size:11px;line-height:1.35;text-align:left;user-select:none;pointer-events:auto}
.qgtools-ws-hint.link{cursor:pointer}
.qgtools-ws-hint.link:hover{color:#d8ecea}
.qgtools-ws-hint.hidden,.qgtools-ws-bar.hidden{display:none}
.qgtools-ws .qgtools-ws-bar{grid-template-columns:minmax(0,1fr) auto;gap:7px}
.qgtools-ws-add{min-width:0;height:100%;padding:0 10px;border:1px dashed #33514f;border-radius:6px;background:transparent;color:#78908e;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;cursor:pointer}
.qgtools-ws-add.ready{border-style:solid;border-color:rgba(0,180,170,.55);background:rgba(0,180,170,.14);color:#d8ecea}
.qgtools-ws-add:hover{border-color:${BRAND};color:#fff}
.qgtools-ws-done{height:100%;padding:0 14px;border:1px solid ${BRAND};border-radius:6px;background:${BRAND};color:#04201d;font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws-done:hover{background:#19c9bf;border-color:#19c9bf}
.qgtools-ws-menu{position:fixed;z-index:10000;min-width:200px;padding:4px;border:1px solid #2a3437;border-radius:8px;background:#11181a;box-shadow:0 8px 28px rgba(0,0,0,.5);font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#d8ecea}
.qgtools-ws-menu-head{padding:5px 8px 6px;border-bottom:1px solid #223033;margin-bottom:3px;color:#78908e;font-size:10px;line-height:1;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.qgtools-ws-menu-head.sub{border-bottom:none;margin-bottom:0;padding-bottom:3px}
.qgtools-ws-menu-item{display:block;width:100%;padding:6px 8px;border:none;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.qgtools-ws-menu-item:hover{background:#1d2a2c;color:#fff}
.qgtools-ws-menu-item:disabled{color:#566b69;cursor:default;background:transparent}
.qgtools-ws-menu-item.danger:hover{background:#3a1f22;color:#ffb4b4}
.qgtools-ws-menu-rule{height:1px;margin:3px 4px;background:#223033}
`;
  document.head.append(style);
}

// ---------- DOM helpers ----------

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, title) {
  const node = el("button", className, text);
  node.type = "button";
  if (title) node.title = title;
  return node;
}

function svgIcon(build) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  build((tag, attributes) => {
    const shape = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  });
  return svg;
}

// Four corners around a dot: bring this part into view.
function frameIcon() {
  return svgIcon((add) => {
    add("path", {
      d: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4", fill: "none", stroke: "currentColor",
      "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round",
    });
    add("circle", { cx: "8", cy: "8", r: "1.7", fill: "currentColor" });
  });
}

// Three dots: what else this switch can do.
function moreIcon() {
  return svgIcon((add) => {
    for (const cx of ["3", "8", "13"]) add("circle", { cx, cy: "8", r: "1.5", fill: "currentColor" });
  });
}

// ---------- reading ----------

function isSwitches(node) {
  return node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS;
}

function groupKey(group) {
  let key = groupKeys.get(group);
  if (!key) {
    key = nextGroupKey++;
    groupKeys.set(group, key);
  }
  return key;
}

function rowKey(row) {
  return row.kind === "switch" ? `s${row.entry.id}` : `g${groupKey(row.group)}`;
}

function settingsOf(node) {
  return normalizeSettings(node.properties?.[SETTINGS_PROPERTY]);
}

function editOpen(node) {
  return Boolean(node.properties?.[SHOW_EDIT]);
}

function settingsOpen(node) {
  return Boolean(node.properties?.[SHOW_SETTINGS]);
}

function minWidth(node) {
  return editOpen(node) ? EDIT_MIN_WIDTH : SMALL_MIN_WIDTH;
}

function read(state) {
  const graph = state.node.graph;
  const settings = settingsOf(state.node);
  if (!graph) return { settings, groups: [], rows: [] };
  const lite = globalThis.LiteGraph;
  const placed = placeNodes(graph.nodes ?? graph._nodes ?? [], {
    skip: isSwitches,
    measure: { titleHeight: lite?.NODE_TITLE_HEIGHT ?? 30, collapsedWidth: lite?.NODE_COLLAPSED_WIDTH ?? 80 },
  });
  const groups = readGroups(graph.groups ?? graph._groups ?? [], placed, { counts: modeMatters });
  const made = readSwitches(settings.switches, placed, groups, { counts: modeMatters });
  return { settings, groups, rows: listedRows(made, groups, settings) };
}

function nodeTitle(node) {
  const title = node?.title || node?.constructor?.title || node?.type || "Node";
  return String(title).replace(/\s*🆎\s*$/u, "");
}

function isGroupItem(item) {
  const Group = globalThis.LiteGraph?.LGraphGroup;
  return Boolean(Group && item instanceof Group);
}

function isNodeItem(item) {
  const Node = globalThis.LiteGraph?.LGraphNode;
  return Boolean(Node && item instanceof Node);
}

// What is selected on this node's graph right now, apart from Workflow
// Switches nodes: the nodes and groups a new switch would hold.
function picked(state) {
  const canvas = app.canvas;
  const items = canvas?.selectedItems ? [...canvas.selectedItems] : Object.values(canvas?.selected_nodes ?? {});
  const graph = state.node.graph;
  const nodes = [];
  const groups = [];
  for (const item of items) {
    if (!item || (item.graph && graph && item.graph !== graph)) continue;
    if (isGroupItem(item)) {
      // A switch finds a group again by its id.
      if (Number.isInteger(item.id) && item.id >= 0) groups.push(item);
    }
    else if (isNodeItem(item) && !isSwitches(item)) nodes.push(item);
  }
  return { nodes, groups, count: nodes.length + groups.length };
}

function pickedIds(pick) {
  return { nodes: pick.nodes.map((node) => node.id), groups: pick.groups.map((group) => group.id) };
}

// ---------- switching ----------

// Mode changes go straight onto the nodes, the way the frontend's own group
// menu and Ctrl+B make them. A setting is written to its control the way a
// hand edit writes it (value, the control's callback, then the node is
// told), so the node's own card or panel follows in both renderers. Then one
// graph change and one undo step.
function applyPlan(state, plan, values = []) {
  if (!plan.length && !values.length) return;
  for (const [node, mode] of plan) node.mode = mode;
  for (const [pair, side] of values) {
    const control = pair.control;
    const next = pairValue(pair, side, control.value);
    if (next === control.value) continue;
    try {
      commitWidgetValue(pair.live, control, next, app.canvas);
    } catch (_error) {
      // A callback that expects a mouse event must not stop the others: the
      // value itself is what the run reads.
      control.value = next;
    }
    pair.live.setDirtyCanvas?.(true, true);
  }
  const graph = state.node.graph;
  if (typeof graph?.change === "function") graph.change();
  else graph?.setDirtyCanvas?.(true, true);
  notifyQgChange();
}

// A click on a row's pill. The pill is one switch, so either half flips it;
// `side` (true for the on half) only decides while the row reads mixed.
function switchRow(state, key, side) {
  const { settings, rows } = read(state);
  const target = rows.find((row) => rowKey(row) === key);
  if (!target) return;
  const on = flipTo(target.state, side);
  applyPlan(state, switchPlan(rows, target, on, settings), valuePlan(rows, target, on, settings));
  refresh(state);
}

function switchAll(state, on) {
  const { settings, rows } = read(state);
  applyPlan(state, switchAllPlan(rows, on, settings), valueAllPlan(rows, on));
  refresh(state);
}

function frameRow(state, key) {
  const row = read(state).rows.find((candidate) => rowKey(candidate) === key);
  const found = row?.kind === "group" ? groupBounds(row.group) : row?.rect;
  if (!found) return;
  const canvas = app.canvas;
  const view = canvas?.canvas?.getBoundingClientRect?.();
  const rect = frameBounds(found, [view?.width, view?.height], FRAME_FILL);
  if (typeof canvas?.animateToBounds === "function") {
    canvas.animateToBounds(rect, { zoom: FRAME_FILL });
    return;
  }
  if (typeof canvas?.ds?.fitToBounds === "function") {
    canvas.ds.fitToBounds(rect, { zoom: FRAME_FILL });
    canvas.setDirty?.(true, true);
  }
}

// ---------- settings and views ----------

function writeSettings(state, next, { settle = true } = {}) {
  const node = state.node;
  node.properties ??= {};
  node.properties[SETTINGS_PROPERTY] = normalizeSettings(next);
  if (settle) notifyQgChange();
  refresh(state);
}

function patchSettings(state, patch, options) {
  writeSettings(state, { ...settingsOf(state.node), ...patch }, options);
}

// Open the edit view, or fold it down to the labels and their switches.
function setEdit(state, open) {
  const node = state.node;
  if (editOpen(node) === open) return;
  closeMenu();
  if (!open) stopRename(state, { keep: true });
  node.properties ??= {};
  node.properties[SHOW_EDIT] = open;
  notifyQgChange();
  refresh(state);
}

function settingsRow(label, title) {
  const row = el("div", "qgtools-card-row");
  const caption = el("span", "qgtools-card-label", label);
  caption.title = title;
  const control = el("div", "qgtools-card-control");
  row.append(caption, control);
  return { row, control };
}

// A segmented pill over one setting; `labels` maps values to what the pill
// says. An off | on pill (`flips`) is one switch like the rows above it: a
// click on either half flips it.
function segmentRow(state, key, label, title, values, labels = {}, { flips = false } = {}) {
  const { row, control } = settingsRow(label, title);
  const seg = el("div", "qgtools-card-seg");
  const buttons = new Map();
  for (const value of values) {
    const choice = button("", labels[value] ?? String(value), title);
    choice.addEventListener("click", () => patchSettings(state, { [key]: flips ? !settingsOf(state.node)[key] : value }));
    seg.append(choice);
    buttons.set(value, choice);
  }
  control.append(seg);
  const sync = (settings) => {
    for (const [value, choice] of buttons) choice.classList.toggle("on", settings[key] === value);
  };
  return { row, sync };
}

// A select over one setting, for choices too long to sit side by side.
function selectRow(state, key, label, title, labels) {
  const { row, control } = settingsRow(label, title);
  const select = el("select", "qgtools-card-select");
  select.title = title;
  for (const [value, text] of Object.entries(labels)) {
    const option = el("option", "", text);
    option.value = value;
    select.append(option);
  }
  select.addEventListener("change", () => patchSettings(state, { [key]: select.value }));
  control.append(select);
  const sync = (settings) => {
    if (select.value !== settings[key]) select.value = settings[key];
  };
  return { row, sync };
}

function buildSettings(state) {
  const header = button("qgtools-card-group", undefined, "What off means, which groups get a switch of their own, and their order");
  header.append(el("span", "glyph", "▸"), el("span", "", "Settings"));
  header.addEventListener("click", () => {
    const node = state.node;
    node.properties ??= {};
    node.properties[SHOW_SETTINGS] = !settingsOpen(node);
    refresh(state);
  });

  const off = segmentRow(
    state, "off", "When off",
    "What a switched-off part does. Bypass: its nodes hand their inputs straight through, so the rest of the workflow still runs. Mute: its nodes do not run, and nor does anything that needs their output.",
    ["bypass", "mute"],
  );
  const groups = selectRow(
    state, "groups", "Groups",
    "Which groups get a switch of their own, listed under the switches you made: none, every group, the numbered ones (titles starting with a digit, like 1 · Load), or titles matching text.",
    { none: "No groups", all: "Every group", numbered: "Numbered groups", matching: "Titles matching…" },
  );

  const match = settingsRow("Match", "Comma-separated text; a group is listed when its title contains any of it");
  const text = el("input", "qgtools-card-text");
  text.type = "text";
  text.spellcheck = false;
  text.placeholder = "upscale, face";
  text.title = "Comma-separated text; a group is listed when its title contains any of it";
  text.addEventListener("input", () => patchSettings(state, { match: text.value }, { settle: false }));
  text.addEventListener("change", () => notifyQgChange());
  text.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter" || event.key === "Escape") text.blur();
  });
  match.control.append(text);

  const order = segmentRow(
    state, "order", "Group order",
    "The order of the group rows. Canvas: the way the workflow reads, column by column from the left and top to bottom within a column. Title: by title, with numbers in numeric order.",
    ["canvas", "title"],
  );
  const exclusive = segmentRow(
    state, "exclusive", "One at a time",
    "Switching a row on switches the other rows off - for alternatives such as two upscalers.",
    [false, true],
    { false: "off", true: "on" },
    { flips: true },
  );
  exclusive.row.querySelector(".qgtools-card-seg")?.classList.add("qgtools-card-bool");

  // The rows taken off the card with a row's delete button, and the way back.
  const hiddenRow = settingsRow("Hidden groups", "Group rows removed with their delete button. Restore puts every one back on the card.");
  const restore = button("qgtools-ws-restore", "Restore", "Restore every removed group row");
  restore.addEventListener("click", () => patchSettings(state, { hidden: [] }));
  hiddenRow.control.append(restore);

  const rows = { off, groups, match: { row: match.row }, order, hidden: { row: hiddenRow.row }, exclusive };
  const sync = (settings, edit, open) => {
    header.classList.toggle("open", open);
    header.style.display = edit ? "" : "none";
    const listing = settings.groups !== "none";
    for (const entry of Object.values(rows)) entry.row.classList.toggle("hidden", !edit || !open);
    match.row.classList.toggle("hidden", !edit || !open || settings.groups !== "matching");
    order.row.classList.toggle("hidden", !edit || !open || !listing);
    hiddenRow.row.classList.toggle("hidden", !edit || !open || !settings.hidden?.length);
    for (const entry of [off, groups, order, exclusive]) entry.sync(settings);
    if (document.activeElement !== text) text.value = settings.match;
  };
  return { header, rows: Object.values(rows).map((entry) => entry.row), sync };
}

// How many setting rows are showing, for the card's height.
function settingsRowCount(settings) {
  let count = 3; // when off, groups, one at a time
  if (settings.groups !== "none") count += 1; // group order
  if (settings.groups === "matching") count += 1; // match
  if (settings.hidden?.length) count += 1; // removed group rows and Restore
  return count;
}

// ---------- making and changing switches ----------

function newSwitch(state) {
  const pick = picked(state);
  if (!pick.count) {
    showToast({
      summary: "Workflow Switches",
      detail: "Select the nodes this switch should turn off and on first, then press it again. A box and its Save, for example.",
    });
    return;
  }
  const settings = settingsOf(state.node);
  const title = suggestTitle(
    {
      nodes: pick.nodes.map((node) => ({ title: nodeTitle(node), box: node.isSubgraphNode?.() === true })),
      groups: pick.groups.map((group) => ({ title: group.title })),
    },
    settings.switches.map((entry) => entry.title),
  );
  const made = addSwitch(settings, { title, ...pickedIds(pick) });
  if (made.id === null) {
    showToast({ summary: "Workflow Switches", severity: "warn", detail: `One card holds up to ${SWITCHES_MAX} switches.` });
    return;
  }
  writeSettings(state, made.settings);
  startRename(state, `s${made.id}`);
}

function startRename(state, key) {
  const entry = state.rows.get(key);
  if (!entry?.name) return;
  stopRename(state, { keep: true });
  state.renaming = key;
  entry.name.value = entry.title.textContent ?? "";
  entry.title.hidden = true;
  entry.name.hidden = false;
  entry.name.focus();
  entry.name.select();
}

// Leave the name box. `keep` writes what was typed; without it the old name
// stays.
function stopRename(state, { keep }) {
  const key = state.renaming;
  if (!key) return;
  state.renaming = null;
  const entry = state.rows.get(key);
  if (!entry?.name) return;
  const typed = entry.name.value;
  entry.name.hidden = true;
  entry.title.hidden = false;
  if (!keep) return;
  const id = Number(key.slice(1));
  const settings = settingsOf(state.node);
  const before = settings.switches.find((item) => item.id === id)?.title;
  const next = renameSwitch(settings, id, typed);
  if (next.switches.find((item) => item.id === id)?.title !== before) writeSettings(state, next);
}

function selectMembers(state, key) {
  const row = read(state).rows.find((candidate) => rowKey(candidate) === key);
  const canvas = app.canvas;
  if (!row || !canvas) return;
  const nodes = [...row.members, ...(row.valueNodes ?? [])];
  canvas.deselectAll?.();
  if (typeof canvas.select === "function") for (const node of nodes) canvas.select(node);
  else canvas.selectNodes?.(nodes);
  canvas.setDirty?.(true, true);
}

// Remember what the selected nodes hold right now as this switch's on or
// off, and say what that leaves to do.
function saveSide(state, key, side, pick) {
  const id = Number(key.slice(1));
  const snapshots = pick.nodes.map((node) => ({ id: node.id, values: snapshotNode(node) })).filter((item) => Object.keys(item.values).length);
  if (!snapshots.length) {
    showToast({ summary: "Workflow Switches", severity: "warn", detail: "The selected nodes have no settings to remember." });
    return;
  }
  writeSettings(state, saveValues(settingsOf(state.node), id, side, snapshots));
  const row = read(state).rows.find((candidate) => rowKey(candidate) === key);
  if (!row) return;
  const other = side === "on" ? "off" : "on";
  let detail = `"${row.title}" now changes ${row.pairs.length} setting${row.pairs.length === 1 ? "" : "s"}.`;
  if (row.half) detail = `Saved as ${side}. Now set those nodes the way they should be for ${other}, select them, and save that side too.`;
  else if (!row.pairs.length) detail = `Those nodes hold the same values for on and off. Change them, then save ${other} again.`;
  showToast({ summary: "Workflow Switches", detail });
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.abort.abort();
  openMenu.element.remove();
  openMenu.anchor.classList.remove("open");
  openMenu = null;
}

// The three-dot menu of a made switch.
function showMenu(state, key, anchor) {
  const wasOpen = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpen) return;
  const id = Number(key.slice(1));
  const settings = settingsOf(state.node);
  const index = settings.switches.findIndex((entry) => entry.id === id);
  const entry = settings.switches[index];
  if (!entry) return;
  const pick = picked(state);
  const ids = pickedIds(pick);
  const held = heldCount(entry, ids);
  const fresh = pick.count - held;
  const menu = el("div", "qgtools-ws-menu");
  menu.append(el("div", "qgtools-ws-menu-head", entry.title));
  const item = (label, run, { disabled = false, danger = false, title = "" } = {}) => {
    const choice = button(`qgtools-ws-menu-item${danger ? " danger" : ""}`, label, title);
    choice.disabled = disabled;
    choice.addEventListener("click", () => {
      closeMenu();
      run();
    });
    menu.append(choice);
  };
  const rule = () => menu.append(el("div", "qgtools-ws-menu-rule"));
  item("Rename", () => startRename(state, key));
  item("Select its nodes", () => selectMembers(state, key), { title: "Select every node this switch turns off and on" });
  rule();
  item(
    fresh > 0 ? `Add the ${fresh} selected` : "Add the selected",
    () => writeSettings(state, addMembers(settings, id, ids)),
    { disabled: fresh < 1, title: "Select nodes or groups on the canvas first, then add them to this switch" },
  );
  item(
    held > 0 ? `Take out the ${held} selected` : "Take out the selected",
    () => writeSettings(state, removeMembers(settings, id, ids)),
    { disabled: held < 1, title: "Select nodes this switch holds first, then take them out of it" },
  );
  rule();
  // A switch that changes settings instead of turning nodes off.
  menu.append(el("div", "qgtools-ws-menu-head sub", "Change settings instead"));
  const count = pick.nodes.length;
  const how = "Makes this a switch that changes settings instead of turning nodes off. Set the selected nodes the way they should be for this side, then save it. Do both sides: the switch changes the values that differ.";
  item(count ? `Save the ${count} selected as on` : "Save the selected as on", () => saveSide(state, key, "on", pick), { disabled: !count, title: how });
  item(count ? `Save the ${count} selected as off` : "Save the selected as off", () => saveSide(state, key, "off", pick), { disabled: !count, title: how });
  rule();
  item("Move up", () => writeSettings(state, moveSwitch(settings, id, -1)), { disabled: index < 1 });
  item("Move down", () => writeSettings(state, moveSwitch(settings, id, 1)), { disabled: index >= settings.switches.length - 1 });
  rule();
  item("Delete this switch", () => writeSettings(state, removeSwitch(settings, id)), {
    danger: true, title: "Removes the switch. Its nodes stay as they are.",
  });

  positionMenu(menu, anchor);
}

// The three-dot menu of a group row: select what the group holds, or take
// its row off the card (nothing on the canvas is touched).
function showGroupMenu(state, key, anchor) {
  const wasOpen = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpen) return;
  const row = read(state).rows.find((candidate) => rowKey(candidate) === key);
  if (!row) return;
  const menu = el("div", "qgtools-ws-menu");
  menu.append(el("div", "qgtools-ws-menu-head", row.title));
  const item = (label, run, { disabled = false, danger = false, title = "" } = {}) => {
    const choice = button(`qgtools-ws-menu-item${danger ? " danger" : ""}`, label, title);
    choice.disabled = disabled;
    choice.addEventListener("click", () => {
      closeMenu();
      run();
    });
    menu.append(choice);
  };
  item("Select its nodes", () => selectMembers(state, key), { title: "Select every node this group holds" });
  menu.append(el("div", "qgtools-ws-menu-rule"));
  item("Delete this switch", () => writeSettings(state, hideGroup(settingsOf(state.node), { id: row.group?.id, title: row.title })), {
    danger: true, title: "Remove this group's row from this card. Nothing on the canvas changes, and Restore in Settings brings the row back.",
  });

  positionMenu(menu, anchor);
}

// Hangs a menu by its anchor: on screen edge aware, closed by a click
// outside or Escape.
function positionMenu(menu, anchor) {
  document.body.append(menu);
  const at = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const left = Math.min(at.right - box.width, window.innerWidth - box.width - 8);
  let top = at.bottom + 4;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, at.top - box.height - 4);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  const abort = new AbortController();
  document.addEventListener(
    "pointerdown",
    (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu(); },
    { capture: true, signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => { if (event.key === "Escape") { event.stopPropagation(); closeMenu(); } },
    { capture: true, signal: abort.signal },
  );
  anchor.classList.add("open");
  openMenu = { element: menu, abort, anchor };
}

// ---------- rows ----------

function buildRow(state, key, made) {
  const row = el("div", "qgtools-card-row qgtools-ws-row");
  const chip = el("span", "qgtools-ws-chip");
  const title = el("span", "qgtools-ws-title");
  const count = el("span", "qgtools-ws-count");
  // One switch drawn as two halves: a click on either half flips it.
  const pill = el("div", "qgtools-card-seg qgtools-card-bool qgtools-ws-pill");
  pill.setAttribute("role", "group");
  const offButton = button("", "off");
  const onButton = button("", "on");
  offButton.addEventListener("click", () => switchRow(state, key, false));
  onButton.addEventListener("click", () => switchRow(state, key, true));
  pill.append(offButton, onButton);
  const go = button("qgtools-ws-tool", undefined, "Bring this part into view");
  go.append(frameIcon());
  go.addEventListener("click", () => frameRow(state, key));
  const more = button("qgtools-ws-tool", undefined, made
    ? "Rename, change or delete this switch"
    : "Select the group's nodes, or remove its row from this card");
  more.append(moreIcon());
  more.addEventListener("click", () => (made ? showMenu : showGroupMenu)(state, key, more));

  let name = null;
  if (made) {
    name = el("input", "qgtools-card-text qgtools-ws-name");
    name.type = "text";
    name.maxLength = TITLE_MAX;
    name.spellcheck = false;
    name.hidden = true;
    name.title = "Name this switch, then press Enter";
    name.addEventListener("keydown", (event) => {
      keepKeyInField(event);
      if (event.key === "Enter") name.blur();
      else if (event.key === "Escape") stopRename(state, { keep: false });
    });
    name.addEventListener("blur", () => {
      if (state.renaming === key) stopRename(state, { keep: true });
    });
    row.append(chip, title, name, count, pill, go, more);
  } else {
    row.append(chip, title, count, pill, go, more);
  }
  // A double-click on a label opens the edit view; there, it renames.
  title.addEventListener("dblclick", () => {
    if (!editOpen(state.node)) setEdit(state, true);
    else if (made) startRename(state, key);
  });

  const sync = (data, settings) => {
    const label = data.title || (made ? "Switch" : "Group");
    row.classList.toggle("off", data.state === "off");
    row.classList.toggle("mixed", data.state === "mixed");
    row.classList.toggle("empty", data.state === "empty");
    chip.style.setProperty("--chip", data.color ?? (made ? BRAND : NO_COLOR));
    title.textContent = label;
    const pairs = data.pairs ?? [];
    const names = data.members.slice(0, 6).map(nodeTitle).join(", ");
    const tail = data.members.length > 6 ? ` and ${data.members.length - 6} more` : "";
    const sets = pairs.slice(0, 6).map((pair) => `${nodeTitle(pair.live)} (${pair.row ?? pair.widget})`).join(", ");
    const parts = [];
    if (data.members.length) parts.push(`turns off and on ${names}${tail}`);
    if (pairs.length) parts.push(`changes ${sets}${pairs.length > 6 ? ` and ${pairs.length - 6} more` : ""}`);
    title.title = made
      ? parts.length ? `${label}: ${parts.join("; ")}` : data.half ? `${label}: saved for one side only` : `${label}: its nodes are gone`
      : `${label}: every node inside this group`;
    const waiting = data.half && !pairs.length && !data.members.length;
    // A setting changed by hand to a third value is neither on nor off.
    const changed = data.state === "mixed" && pairs.some((pair) => pair.now === "other");
    count.textContent = changed ? "changed" : data.state === "mixed" ? `${data.on}/${data.total}` : waiting ? "half set" : data.state === "empty" ? "empty" : "";
    count.title = changed
      ? "A setting this switch changes was set by hand to something else. Click off or on to set it again."
      : data.state === "mixed" ? `${data.on} of its ${data.total} ${pairs.length ? "nodes and settings are on" : "nodes run"}`
      : waiting ? "Saved for one side only. Set its nodes the other way, select them, and save that side from its menu."
        : data.state !== "empty" ? ""
          : made ? "Its nodes are gone. Add some from its menu in the edit view, or delete the switch." : "No nodes inside this group yet";
    pill.classList.toggle("mixed", data.state === "mixed");
    offButton.classList.toggle("on", data.state === "off");
    onButton.classList.toggle("on", data.state === "on");
    offButton.setAttribute("aria-pressed", String(data.state === "off"));
    onButton.setAttribute("aria-pressed", String(data.state === "on"));
    const valuesOnly = pairs.length > 0 && !data.members.length;
    const turnOff = valuesOnly ? `Switch "${label}" off` : `${settings.off === "mute" ? "Mute" : "Bypass"} "${label}"`;
    const turnOn = `${valuesOnly ? "Switch" : "Run"} "${label}"${valuesOnly ? " on" : ""}${settings.exclusive ? " and switch the other rows off" : ""}`;
    // Either half flips the switch, so both say what the next click does;
    // a mixed row goes to the half that is clicked.
    offButton.title = data.state === "off" ? `Click: ${turnOn}` : data.state === "on" ? `Click: ${turnOff}` : turnOff;
    onButton.title = data.state === "off" ? `Click: ${turnOn}` : data.state === "on" ? `Click: ${turnOff}` : turnOn;
  };
  return { row, title, name, sync };
}

// ---------- the panel ----------

function declaredHeight(state) {
  return state.height + WRAPPER_INSET;
}

function measureCard(listed, edit, open, settings) {
  const rows = listed ? Array.from({ length: listed }, () => ({ widget: "switch" })) : [{ widget: "hint", height: HINT_HEIGHT }];
  if (edit) {
    rows.push({ widget: "bar" }, { group: "settings" });
    if (open) for (let index = 0; index < settingsRowCount(settings); index += 1) rows.push({ widget: "setting" });
  }
  return cardHeight(rows);
}

function hintText(edit, groupCount, settings) {
  if (!edit) return "No switches yet. Click here to make one.";
  if (groupCount && settings.groups !== "none") return "No group matches the Groups setting. Select nodes and press + Switch.";
  return "Select the nodes of one part, such as a box and its Save, then press + Switch.";
}

function render(state, settings, rows, groupCount, pick) {
  const node = state.node;
  const edit = editOpen(node);
  const open = settingsOpen(node);
  state.root.classList.toggle("edit", edit);

  const seen = new Set();
  let cursor = state.list.firstElementChild;
  for (const data of rows) {
    const key = rowKey(data);
    let entry = state.rows.get(key);
    if (!entry) {
      entry = buildRow(state, key, data.kind === "switch");
      state.rows.set(key, entry);
    }
    entry.sync(data, settings);
    // Only a row out of place is moved: moving the row being renamed would
    // take the cursor out of its name box.
    if (cursor === entry.row) cursor = cursor.nextElementSibling;
    else state.list.insertBefore(entry.row, cursor);
    seen.add(key);
  }
  for (const [key, entry] of state.rows) {
    if (seen.has(key)) continue;
    if (state.renaming === key) state.renaming = null;
    entry.row.remove();
    state.rows.delete(key);
  }

  state.hint.classList.toggle("hidden", rows.length > 0);
  state.hint.textContent = hintText(edit, groupCount, settings);
  state.hint.classList.toggle("link", !edit);
  state.bar.classList.toggle("hidden", !edit);
  state.add.classList.toggle("ready", pick.count > 0);
  state.add.textContent = pick.count > 0 ? `+ Switch from ${pick.count} selected` : "Select nodes, then add a switch";
  state.settings.sync(settings, edit, open);

  const height = measureCard(rows.length, edit, open, settings);
  const floor = minWidth(node);
  if (height !== state.height || (node.size?.[0] ?? 0) < floor) {
    state.height = height;
    const width = Math.max(floor, node.size?.[0] || NODE_WIDTH);
    node.setSize?.([width, node.computeSize?.()[1] || declaredHeight(state)]);
    node.graph?.setDirtyCanvas?.(true, true);
  }
}

function refresh(state) {
  if (state.disposed) return;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.checkedAt = performance.now();
  const { settings, groups, rows } = read(state);
  const node = state.node;
  const edit = editOpen(node);
  // The selection only shows in the edit view (the + Switch bar).
  const pick = edit ? picked(state) : { nodes: [], groups: [], count: 0 };
  const signature = [
    rowsSignature(rows, settings, rowKey), groups.length, edit, settingsOpen(node), pick.count,
  ].join("|");
  if (signature === state.signature) return;
  state.signature = signature;
  render(state, settings, rows, groups.length, pick);
}

// Called on every canvas redraw: read the graph again at most every
// RECHECK_MS, and always once after the last redraw.
function scheduleCheck(state) {
  if (state.disposed || state.timer !== null) return;
  const shown = app.canvas?.getCurrentGraph?.() ?? app.canvas?.graph;
  if (state.node.graph && shown && state.node.graph !== shown) return;
  const wait = Math.max(0, state.checkedAt + RECHECK_MS - performance.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    refresh(state);
  }, wait);
}

function ensureRedrawHook() {
  const canvas = app.canvas;
  if (!canvas || canvas === hookedCanvas) return;
  hookedCanvas = canvas;
  chainCallback(canvas, "onDrawForeground", () => {
    for (const state of live) scheduleCheck(state);
  });
}

// Wraps the node's own computeSize (not the prototype's), like the floors in
// js/shared/panel_layout.mjs.
function trimNodeBottom(node) {
  const inherited = node.computeSize;
  if (typeof inherited !== "function") return;
  node.computeSize = function (out) {
    const size = inherited.call(this, out);
    if (size && size[1] > BOTTOM_TRIM * 4) size[1] -= BOTTOM_TRIM;
    return size;
  };
}

function buildPanel(node) {
  if (node.__qgWorkflowSwitches) return node.__qgWorkflowSwitches;
  ensureCss();
  const root = el("div", "qgtools-ws");
  const card = el("div", "qgtools-card");
  const list = el("div", "qgtools-ws-list");
  const hint = button("qgtools-ws-hint hidden");
  const bar = el("div", "qgtools-card-row qgtools-ws-bar hidden");
  const add = button("qgtools-ws-add", "+ Switch", "Select the nodes of one part on the canvas, then press this: they get one switch");
  const done = button("qgtools-ws-done", "Done", "Show only the labels and their switches. Double-click a label, or right-click the node, to edit again.");
  bar.append(add, done);
  card.append(list, hint, bar);
  root.append(card);

  const state = {
    node, root, list, hint, bar, add, rows: new Map(), settings: null, renaming: null,
    height: 0, signature: "", checkedAt: 0, timer: null, disposed: false,
  };
  node.__qgWorkflowSwitches = state;
  state.settings = buildSettings(state);
  card.append(state.settings.header, ...state.settings.rows);

  add.addEventListener("click", () => newSwitch(state));
  done.addEventListener("click", () => setEdit(state, false));
  hint.addEventListener("click", () => setEdit(state, true));

  // Clicks on controls stay out of the graph's drag and leave the selection
  // alone; empty card space falls through, so the node still drags from its
  // body.
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,input,select")) event.stopPropagation();
  });
  root.addEventListener("dblclick", (event) => event.stopPropagation());

  const widget = node.addDOMWidget(WIDGET_NAME, "qg_workflow_switches", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => declaredHeight(state),
  });
  keepDomWidgetWidthAuto(widget);
  // Not saved with the workflow either: options.serialize only keeps it out
  // of the prompt, and saved values come back by position.
  widget.serialize = false;
  // A list sized to its rows, pinned on purpose (tests/panel_guards.test.mjs,
  // fixedByDesign): the rows are the content, there is no viewport to grow.
  widget.computeSize = (width) => [Math.max(minWidth(node), Number(width || node.size?.[0] || NODE_WIDTH)), declaredHeight(state)];
  // Pinned in Nodes 2.0 as well, where a node can be made taller than its list.
  pinVuePanelHeight(widget);
  widget.options.minNodeSize = [SMALL_MIN_WIDTH, 60];
  // The frontend skips a pinned card's width, so its floor is held here.
  holdNodeMinWidth(widget, () => minWidth(node));
  trimNodeBottom(node);
  state.widget = widget;

  live.add(state);
  ensureRedrawHook();
  return state;
}

// A removed node stops reading the graph; the state stays on the node so
// a node added back (undoing a delete in place) picks up where it was.
function dispose(node) {
  const state = node.__qgWorkflowSwitches;
  if (!state) return;
  state.disposed = true;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  if (openMenu && state.root.contains(openMenu.anchor)) closeMenu();
  live.delete(state);
}

app.registerExtension({
  name: "QG.WorkflowSwitches",
  setup() {
    ensureRedrawHook();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    // Never part of a prompt: the frontend leaves virtual nodes out.
    nodeType.prototype.isVirtualNode = true;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      this.isVirtualNode = true;
      // No slots: without a start the frontend reserves an empty slot row
      // above the card and leaves it as dead space under it.
      this.widgets_start_y = WIDGETS_TOP;
      this.properties ??= {};
      this.properties[SETTINGS_PROPERTY] ??= { ...DEFAULT_SETTINGS, switches: [] };
      // A new node opens in the edit view; a loaded one keeps what was saved.
      this.properties[SHOW_EDIT] ??= true;
      buildPanel(this);
      this.setSize?.([Math.max(this.size?.[0] || 0, NODE_WIDTH), this.size?.[1] || 0]);
    });
    chainCallback(nodeType.prototype, "onAdded", function () {
      const state = buildPanel(this);
      state.disposed = false;
      state.signature = "";
      live.add(state);
      queueMicrotask(() => refresh(state));
    });
    // A workflow's groups are configured after its nodes: read once the
    // whole graph is in.
    chainCallback(nodeType.prototype, "onConfigure", function () {
      const state = buildPanel(this);
      state.signature = "";
      queueMicrotask(() => refresh(state));
    });
    chainCallback(nodeType.prototype, "getExtraMenuOptions", function (_canvas, options) {
      const state = this.__qgWorkflowSwitches;
      if (!state || !Array.isArray(options)) return;
      const { settings } = read(state);
      const edit = editOpen(this);
      const items = [{
        content: edit ? "Show only the switches" : "Edit switches",
        callback: () => setEdit(state, !edit),
      }];
      if (!settings.exclusive) items.push({ content: "Switch everything on", callback: () => switchAll(state, true) });
      items.push({ content: "Switch everything off", callback: () => switchAll(state, false) }, null);
      options.unshift(...items);
    });
    // The card is a list sized to its rows: width may grow, but a corner
    // drag that pulls the node taller only opens dead space under it, so the
    // height snaps back on the next frame (LiteGraph writes size directly
    // during a drag).
    chainCallback(nodeType.prototype, "onDrawForeground", function () {
      if (this.flags?.collapsed || !this.__qgWorkflowSwitches) return;
      const natural = this.computeSize?.()[1];
      if (natural && this.size[1] !== natural) {
        this.setSize?.([this.size[0], natural]);
        this.setDirtyCanvas?.(true, false);
      }
    });
    chainCallback(nodeType.prototype, "onRemoved", function () {
      dispose(this);
    });
  },
});
