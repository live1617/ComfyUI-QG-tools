// Workflow Switches 🆎 — switch parts of a workflow off and on from one card.
//
// The backend registers the node so a workflow that uses it can find the
// pack; this file makes it virtual, so it never enters a prompt, and gives
// it its whole face: one row per switch, a label and an off | on pill.
//
// A switch is either made from picked nodes and groups (select them, press
// + Switch) or a group listed on its own. A made switch can also take LoRA
// stack rows: pick them from the row's menu, and clicking the switch turns
// just those rows on or off, putting back the strength each row had when it
// was picked as it goes on. (Until 2026-11-22 a switch could also save what
// the picked nodes held for on and for off; that is gone from the UI — the row
// picker covers its main use and remembers strengths with it — but snapshots
// already saved in a workflow are still read and still applied.) The card has
// two views. The edit view shows everything: a frame button and a menu on each
// row, the bar that makes a switch from the selection, and the settings. Done
// folds all of that away and leaves the labels and their switches: the small
// view a shared workflow ships with.
//
// Only what the user made is stored (which nodes each switch holds, by id,
// the values it remembers and the settings, in node.properties). Every row's
// state is read from the nodes' own modes and values, so a reloaded workflow, an undo or a node bypassed by
// hand elsewhere always shows right, and a switch whose nodes are only
// partly on reads mixed. The list follows the graph on the canvas's own
// redraws, which the frontend makes whenever the graph or the selection
// changes: no work while nothing changes, at most one read per RECHECK_MS
// while the canvas is busy, and always one after the last redraw. The
// decisions live in web/shared/workflow_switches.mjs.

import { app } from "/scripts/app.js";
import { sizeFor } from "../shared/node_width.mjs?v=202611251300";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange, showToast, zhPair } from "../shared/index.mjs?v=202611251300";
import { keepKeyInField } from "../shared/canvas_passthrough.mjs?v=202611251300";
import { holdNodeMinWidth, holdVueNodeMinWidth, pinVuePanelHeight } from "../shared/panel_layout.mjs?v=202611251300";
import { cardHeight, commitWidgetValue, ensureCardCss } from "../shared/widget_card.mjs?v=202611251300";
import {
  DEFAULT_SETTINGS, SETTINGS_PROPERTY, SWITCHES_MAX, TITLE_MAX, addMembers, addOffMembers, addSwitch, dropValues,
  flipTo, frameBounds, groupBounds, hasOffSide, heldCount, hideGroup, listedRows, modeMatters, moveSwitch, normalizeSettings, offFreshCount,
  offHeldCount, pairValue, placeNodes, readGroups, readSwitches, removeMembers, removeOffMembers, removeSwitch, renameSwitch, repointSwitches,
  findRow, rowLabel, rowsSignature, saveValues, sameFile, stackRows, suggestTitle, switchAllPlan, switchPlan, valueAllPlan, valuePlan,
  valuePairs,
} from "../shared/workflow_switches.mjs?v=202611251300";
import { onPaste } from "../shared/paste_remap.mjs?v=202611251300";
// Sentences the DOM translator cannot reach: every one here is built at
// runtime (a name, a count, or a branch), or written onto a title after the
// fact. zh() looks the whole English sentence up and falls back to it.
import { zh, zhOn, zhReady, zhSep } from "../shared/zh.mjs?v=202611251300";

const NODE_CLASS = "QG_WorkflowSwitches";
const CSS_ID = "qgtools-workflow-switches-css";
const WIDGET_NAME = "qg_workflow_switches";
// The two disclosures, named like a widget card's groups: the edit view, and
// the settings inside it.
const SHOW_EDIT = "qg_show_edit";
const SHOW_SETTINGS = "qg_show_settings";
const NODE_WIDTH = sizeFor("QG_WorkflowSwitches").w;
// The narrowest each view still reads at: a label and a pill, or those plus
// the two row buttons. 两个视图的下限都取尺寸表的 minW —— 表说能拖到多窄就多窄。
// 🔴 编辑态以前是 `EDIT_MIN_WIDTH = NODE_WIDTH`（= 默认宽），而节点默认就是展开态，
// 于是「下限 == 默认宽」，表现就是**只能拖大、拖不小**。
const SMALL_MIN_WIDTH = sizeFor("QG_WorkflowSwitches").minW;
const EDIT_MIN_WIDTH = SMALL_MIN_WIDTH;
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
// The highlight the active color scheme paints "chosen" states in. The styles
// below read var(--qg-accent); this is for the one place that needs the value
// in JS — the row's chip, which is a background color rather than a rule.
// web/appearance/index.js writes the variable when the scheme changes.
function accentColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--qg-accent").trim();
  return value || BRAND;
}

const live = new Set();
// The dictionary is fetched on module load, so the first cards are built
// before it lands. Redraw them once it does.
zhReady().then(() => {
  if (zhOn()) for (const state of live) refresh(state);
});
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
/* 列必须与行里实际占位的元素逐个对齐：chip | 名字 | 节点数 | ⇄LoRA 行数 | 开/关 |
   准星 | 菜单。少写一列，后面的元素就整体左移 —— 带 ⇄N 徽章的那一行会把开关胶囊
   挤进 26px 的按钮列（文字竖着换行、菜单被顶出卡片），这正是 2026-11-23 用户
   截图里「QG LoRA堆」那一行的样子。节点数是 auto、允许为空，所以两列都得留。 */
.qgtools-ws .qgtools-ws-row{grid-template-columns:10px minmax(0,1fr) auto auto 84px;gap:7px}
.qgtools-ws.edit .qgtools-ws-row{grid-template-columns:10px minmax(0,1fr) auto auto 84px 26px 26px}
.qgtools-ws-chip{width:10px;height:10px;border-radius:3px;background:var(--chip);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16)}
.qgtools-ws-row.off .qgtools-ws-chip{background:transparent;box-shadow:inset 0 0 0 2px var(--chip),0 0 0 1px rgba(255,255,255,.1)}
.qgtools-ws-row.mixed .qgtools-ws-chip{background:linear-gradient(90deg,var(--chip) 50%,transparent 50%);box-shadow:inset 0 0 0 2px var(--chip),0 0 0 1px rgba(255,255,255,.1)}
.qgtools-ws-row.empty .qgtools-ws-chip{opacity:.4}
.qgtools-ws-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#d8ecea;user-select:none;cursor:pointer}
.qgtools-ws-row.off .qgtools-ws-title,.qgtools-ws-row.empty .qgtools-ws-title{color:#6f8886}
.qgtools-ws-row.empty .qgtools-ws-title{cursor:default}
.qgtools-ws-title[hidden],.qgtools-ws-name[hidden]{display:none}
.qgtools-ws-count{color:#78908e;font-size:10px;font-variant-numeric:tabular-nums;user-select:none}
.qgtools-ws-pill.mixed{background:repeating-linear-gradient(135deg,var(--qg-accent-fade, rgba(0,180,170,.2)) 0 3px,transparent 3px 7px),#0f1516}
.qgtools-ws-pill.mixed button{color:#bfe6e2}
.qgtools-ws-row.empty .qgtools-ws-pill{opacity:.35;pointer-events:none}
.qgtools-ws-sides{display:none;place-items:center;width:14px;color:#6f8a88}
.qgtools-ws-sides svg{display:block}
.qgtools-ws.edit .qgtools-ws-row.sided{grid-template-columns:10px minmax(0,1fr) 14px auto auto 84px 26px 26px}
.qgtools-ws.edit .qgtools-ws-row.sided .qgtools-ws-sides{display:grid}
.qgtools-ws-row.sided .qgtools-ws-sides:hover{color:#d8ecea}
.qgtools-ws-tool{display:none;place-items:center;width:26px;height:26px;padding:0;border:1px solid #2a3437;border-radius:6px;background:#0f1516;color:#8ba3a1;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws.edit .qgtools-ws-tool{display:grid}
.qgtools-ws-tool:hover,.qgtools-ws-tool.open{border-color:var(--qg-accent, ${BRAND});color:#fff}
.qgtools-ws-restore{height:26px;padding:0 12px;border:1px solid #2a3437;border-radius:6px;background:#0f1516;color:#8ba3a1;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws-restore:hover{border-color:var(--qg-accent, ${BRAND});color:#fff}
.qgtools-ws-tool svg{display:block}
.qgtools-ws-hint{height:${HINT_HEIGHT}px;flex:none;display:flex;align-items:center;padding:0;border:none;background:transparent;color:#78908e;font:inherit;font-size:11px;line-height:1.35;text-align:left;user-select:none;pointer-events:auto}
.qgtools-ws-hint.link{cursor:pointer}
.qgtools-ws-hint.link:hover{color:#d8ecea}
.qgtools-ws-hint.hidden,.qgtools-ws-bar.hidden{display:none}
.qgtools-ws .qgtools-ws-bar{grid-template-columns:minmax(0,1fr) auto;gap:7px}
.qgtools-ws-add{min-width:0;height:100%;padding:0 10px;border:1px dashed #33514f;border-radius:6px;background:transparent;color:#78908e;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;cursor:pointer}
.qgtools-ws-add.ready{border-style:solid;border-color:var(--qg-accent-soft, rgba(0,180,170,.55));background:var(--qg-accent-fade, rgba(0,180,170,.14));color:#d8ecea}
.qgtools-ws-add:hover{border-color:var(--qg-accent, ${BRAND});color:#fff}
.qgtools-ws-done{height:100%;padding:0 14px;border:1px solid var(--qg-accent, ${BRAND});border-radius:6px;background:var(--qg-accent, ${BRAND});color:var(--qg-on-accent, #04201d);font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-ws-done:hover{background:var(--qg-accent-hover, #19c9bf);border-color:var(--qg-accent-hover, #19c9bf)}
/* 菜单配色跟 ComfyUI 主题走（2026-11-23）：以前是一整套写死的深色，切到浅色
   主题就剩一块黑方块。变量都带原值兜底，老前端缺变量时观感不变。 */
.qgtools-ws-menu{position:fixed;z-index:10000;min-width:200px;max-width:min(380px,calc(100vw - 24px));padding:4px;border:1px solid var(--border-color, #2a3437);border-radius:8px;background:var(--comfy-menu-bg, #11181a);box-shadow:0 8px 28px rgba(0,0,0,.5);font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg-color, #d8ecea)}
.qgtools-ws-menu-head{padding:5px 8px 6px;border-bottom:1px solid var(--border-color, #223033);margin-bottom:3px;color:var(--descrip-text, #78908e);font-size:10px;line-height:1;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
.qgtools-ws-menu-head.sub{border-bottom:none;margin-bottom:0;padding-bottom:3px}
.qgtools-ws-menu-item{display:block;width:100%;padding:6px 8px;border:none;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.qgtools-ws-menu-item:hover{background:var(--comfy-menu-secondary-bg, #1d2a2c);color:var(--fg-color, #fff)}
.qgtools-ws-menu-item:disabled{color:var(--descrip-text, #566b69);cursor:default;background:transparent}
.qgtools-ws-menu-item.danger:hover{background:rgba(150, 40, 46, .28);color:#ffb4b4}
.qgtools-ws-menu-rule{height:1px;margin:3px 4px;background:var(--border-color, #223033)}
/* 选 LoRA 行的多选列表。行多时菜单自己滚，别顶出屏幕。 */
.qgtools-ws-menu.scroll{max-height:min(70vh,460px);overflow:auto}
/* 筛选框：堆有 24 行、图上又可能有多个堆，滚动找行太慢。 */
.qgtools-ws-menu-filter{display:block;width:100%;box-sizing:border-box;margin:2px 0 5px;padding:5px 8px;border:1px solid var(--border-color, #2a3437);border-radius:5px;background:var(--comfy-input-bg, #1e2429);color:var(--fg-color, #d8ecea);font:inherit;outline:none}
.qgtools-ws-menu-filter:focus{border-color:var(--qg-accent, #00b4aa)}
.qgtools-ws-menu-item.row{display:flex;align-items:center;gap:7px;cursor:pointer}
.qgtools-ws-menu-item.row input{accent-color:var(--qg-accent, #00b4aa);margin:0;flex:none;width:13px;height:13px}
.qgtools-ws-menu-item.row .nm{overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
/* 这行此刻的状态（开/关 + 强度），跟着勾选框一起看。 */
.qgtools-ws-menu-item.row .st{flex:none;margin-left:auto;color:var(--descrip-text, #8a979c);font-size:10px;font-variant-numeric:tabular-nums}
/* 已被别的开关管着：不阻止，但要说出来 —— 后按的那个赢。
   文字用 inherit 而不是固定浅青：浅色主题下白底浅青字几乎看不见。 */
.qgtools-ws-menu-item.row .own{flex:none;max-width:110px;padding:0 4px;border-radius:3px;background:rgba(0, 180, 170, .14);color:inherit;font-size:10px;overflow:hidden;text-overflow:ellipsis}
.qgtools-ws-menu-item.row.wired{opacity:.5;cursor:default}
.qgtools-ws-menu-note{padding:4px 8px;color:var(--descrip-text, #8a979c);font-size:11px;line-height:1.45;max-width:330px}
.qgtools-ws-menu-item.primary{color:var(--qg-accent, #7fe3d6);font-weight:600}
.qgtools-ws-menu-foot{display:flex;gap:4px;justify-content:flex-end;padding-top:4px;margin-top:4px;border-top:1px solid var(--border-color, #223033)}
/* 卡片上「管着几行 LoRA」，紧挨节点数。没有行时是空的，但必须继续占一个
   grid 格（不要写 [hidden]{display:none}，那会让后面所有元素左移一列）。 */
.qgtools-ws-rowcount{flex:none;color:var(--qg-accent, #7fe3d6);font-size:10px;font-variant-numeric:tabular-nums;user-select:none}
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
  if (title) node.title = zh(title);
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

// Two solid-headed arrows pointing opposite ways, one over the other: this
// switch hands over to its other side when it flips.
function sidesIcon() {
  const line = { fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" };
  return svgIcon((add) => {
    add("path", { d: "M2.5 5.2H12", ...line });
    add("path", { d: "M14 5.2l-2.8-1.9v3.8z", fill: "currentColor" });
    add("path", { d: "M13.5 10.8H4", ...line });
    add("path", { d: "M2 10.8l2.8 1.9v-3.8z", fill: "currentColor" });
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

// 卡片最窄能到多少：只看编辑态还是浏览态。单选药丸删掉后，节点宽度不再由名字
// 长度决定（以前药丸要塞下所有名字，现在超长的行名自己截断）。
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

// "Click: <what the next click does>". The tail is a whole sentence built
// elsewhere, so only the "Click: " head is looked up here.
function zhClick(what) {
  return zh("Click: {a}").replace("{a}", what);
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
    // LoRA 堆的行走专线：它的行状态活在自己的前端 state 里，只改 widget 值
    // 会被下一帧覆盖回去（见 writeStackRow）。别的节点照旧走控件值。
    if (pair.row !== undefined && writeStackRow(state, pair.live, pair, side)) continue;
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
  // 这份设置决定「哪些 LoRA 行归这个开关管」，LoRA 堆的行徽章读的就是它。
  // 堆那边有自己的时间节流与重绘时机，不通知的话改完开关要等下一次重绘
  // （拖节点/缩放）才看到徽章（2026-11-23 徽章探针实测：第一次设管行时是空的）。
  try { window.dispatchEvent(new CustomEvent("qg-owner-changed")); } catch (_) { /* 非浏览器 */ }
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
  // Titles are written after insertion, which the zh plugin's DOM pass
  // (childList only) never revisits — so they go through zh() here.
  caption.title = zh(title);
  const control = el("div", "qgtools-card-control");
  row.append(caption, control);
  return { row, control };
}

// Put one setting to a value. Nothing is written when it already holds that
// value: a write means one more undo step and one more redraw of the card,
// and clicking the half that is already lit changes nothing.
function setSetting(state, key, value) {
  if (settingsOf(state.node)[key] === value) return;
  patchSettings(state, { [key]: value });
}

// One row and one control. The control answers two things: how to tell this
// row a new value was picked (`commit`), and how to show the value it holds
// now (`sync`). The pill and the drop-down differ only in the control they
// draw, so the row around them is built here once.
function controlRow(state, key, label, title, make) {
  const { row, control } = settingsRow(label, title);
  const { element, sync } = make((value) => setSetting(state, key, value));
  control.append(element);
  return { row, sync };
}

// A segmented pill over one setting; `labels` maps values to what the pill
// says. Each half stands for its own value: a click on "off" puts the setting
// off. (It used to flip whatever was there, which made the left half switch
// the setting to the right half's value and the right half do the opposite -
// the two halves were crossed.)
function segmentRow(state, key, label, title, values, labels = {}) {
  return controlRow(state, key, label, title, (commit) => {
    const seg = el("div", "qgtools-card-seg");
    const buttons = new Map();
    for (const value of values) {
      const choice = button("", labels[value] ?? String(value), title);
      choice.addEventListener("click", () => commit(value));
      seg.append(choice);
      buttons.set(value, choice);
    }
    return {
      element: seg,
      sync: (settings) => {
        for (const [value, choice] of buttons) choice.classList.toggle("on", settings[key] === value);
      },
    };
  });
}

// A select over one setting, for choices too long to sit side by side.
function selectRow(state, key, label, title, labels) {
  return controlRow(state, key, label, title, (commit) => {
    const select = el("select", "qgtools-card-select");
    select.title = zh(title);
    for (const [value, text] of Object.entries(labels)) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.addEventListener("change", () => commit(select.value));
    return {
      element: select,
      sync: (settings) => {
        if (select.value !== settings[key]) select.value = settings[key];
      },
    };
  });
}

// Every setting the card has, as data: what it is called, what it explains,
// and when it shows. `on` is the only place a row's condition is written -
// both the drawing and the height the card asks for read it from here, so a
// new row can never be added to one and forgotten in the other.
const SETTING_SPECS = [
  {
    key: "off",
    kind: "segment",
    label: "When off",
    title: "What a switched-off part does. Bypass: its nodes hand their inputs straight through, so the rest of the workflow still runs. Mute: its nodes do not run, and nor does anything that needs their output.",
    values: ["bypass", "mute"],
  },
  {
    key: "groups",
    kind: "select",
    label: "Groups",
    title: "Which groups get a switch of their own, listed under the switches you made: none, every group, the numbered ones (titles starting with a digit, like 1 · Load), or titles matching text.",
    options: { none: "No groups", all: "Every group", numbered: "Numbered groups", matching: "Titles matching…" },
  },
  {
    key: "match",
    kind: "text",
    label: "Match",
    title: "Comma-separated text; a group is listed when its title contains any of it",
    placeholder: "upscale, face",
    on: (settings) => settings.groups === "matching",
  },
  {
    key: "order",
    kind: "segment",
    label: "Group order",
    title: "The order of the group rows. Canvas: the way the workflow reads, column by column from the left and top to bottom within a column. Title: by title, with numbers in numeric order.",
    values: ["canvas", "title"],
    on: (settings) => settings.groups !== "none",
  },
  {
    key: "exclusive",
    kind: "toggle",
    label: "One at a time",
    title: "Switching a row on switches the other rows off - for alternatives such as two upscalers.",
  },
  {
    key: "hidden",
    kind: "restore",
    label: "Hidden groups",
    title: "Group rows removed with their delete button. Restore puts every one back on the card.",
    on: (settings) => Boolean(settings.hidden?.length),
  },
];

// Whether a setting is on the card at all, for these settings.
function settingShown(spec, settings) {
  return spec.on ? Boolean(spec.on(settings)) : true;
}

// One setting's row, built from its description. Every kind answers the same
// way - a row to hang on the card, and a function that brings it up to date -
// so the caller never has to know which kind it got.
function buildSettingRow(state, spec) {
  if (spec.kind === "segment" || spec.kind === "toggle") {
    const toggle = spec.kind === "toggle";
    const built = segmentRow(
      state,
      spec.key,
      spec.label,
      spec.title,
      toggle ? [false, true] : spec.values,
      toggle ? { false: "off", true: "on" } : (spec.labels ?? {}),
    );
    if (toggle) built.row.querySelector(".qgtools-card-seg")?.classList.add("qgtools-card-bool");
    return built;
  }
  if (spec.kind === "select") {
    return selectRow(state, spec.key, spec.label, spec.title, spec.options);
  }
  const { row, control } = settingsRow(spec.label, spec.title);
  if (spec.kind === "restore") {
    // The rows taken off the card with a row's delete button, and the way back.
    const restore = button("qgtools-ws-restore", "Restore", "Restore every removed group row");
    restore.addEventListener("click", () => patchSettings(state, { hidden: [] }));
    control.append(restore);
    return { row, sync: () => {} };
  }
  // A text setting.
  const text = el("input", "qgtools-card-text");
  text.type = "text";
  text.spellcheck = false;
  text.placeholder = spec.placeholder ?? "";
  text.title = zh(spec.title);
  text.addEventListener("input", () => patchSettings(state, { [spec.key]: text.value }, { settle: false }));
  text.addEventListener("change", () => notifyQgChange());
  text.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter" || event.key === "Escape") text.blur();
  });
  control.append(text);
  // Never written over while it is being typed into.
  const sync = (settings) => {
    if (document.activeElement !== text) text.value = settings[spec.key];
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

  const built = SETTING_SPECS.map((spec) => ({ spec, ...buildSettingRow(state, spec) }));
  const sync = (settings, edit, open) => {
    header.classList.toggle("open", open);
    header.style.display = edit ? "" : "none";
    for (const item of built) {
      item.row.classList.toggle("hidden", !edit || !open || !settingShown(item.spec, settings));
      item.sync(settings);
    }
  };
  return { header, rows: built.map((item) => item.row), sync };
}

// How many setting rows are showing, for the card's height. Read from the
// same descriptions the rows are built from, so the two cannot drift.
function settingsRowCount(settings) {
  return SETTING_SPECS.filter((spec) => settingShown(spec, settings)).length;
}

// ---------- making and changing switches ----------

function newSwitch(state) {
  const pick = picked(state);
  if (!pick.count) {
    showToast({
      summary: "Workflow Switches",
      // toast 是 PrimeVue、挂在 app root 外面，汉化插件的 DOM 翻译器看不到它。
      detail: zhPair(
        "Select the nodes this switch should turn off and on first, then press it again. A box and its Save, for example.",
        "先选中这个开关要关掉/打开的节点，再按一次它。比如一个盒子连同它里面的 Save。",
      ),
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
    showToast({ summary: zh("Workflow Switches"), severity: "warn", detail: zh("One card holds up to {n} switches.").replace("{n}", String(SWITCHES_MAX)) });
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
  // Both sides and the nodes it changes settings on: everything a click on
  // this row is about.
  const nodes = [...row.members, ...(row.offMembers ?? []), ...(row.valueNodes ?? [])];
  canvas.deselectAll?.();
  if (typeof canvas.select === "function") for (const node of nodes) canvas.select(node);
  else canvas.selectNodes?.(nodes);
  canvas.setDirty?.(true, true);
}

// 一个开关直接管 LoRA 行的若干行，点开/关就把这一组行切开或合上。
// 2026-11-23：行宿主从「只有 LoRA 堆」扩到 LoRA 加载器（QG_LoraLoader）。
//
// 存储**不新增字段**：选行时按当前整栈生成两份快照（选中行 on / 选中行 off），
// 写进开关两侧快照。于是「按行比较、只改有差异的行、强度保持、行名按文件匹配、
// 加载器认出这几行归谁管」全部沿用现成逻辑。这里只补两件事：选行的界面，以及
// 把结果写回宿主自己的前端 state。
//
// 🔴 两种宿主的行状态活在不同地方，寻址键也必须和各自认领行时用的完全一致：
//   - LoRA 堆   QG_LoraSwitchStack：state = node.__qgSwitchStack，widget = rows_data，
//     宿主就是节点自己；它的绘制不读 widget，写入必须改 state（writeStackRow）。
//   - LoRA 加载器 QG_LoraLoader：state = node.__qgLoraState，widget/宿主是
//     state.owner.node + state.owner.name（盒子里的行宿主可能是一整个 box）；
//     它的 syncRows 从 widget 读回 state，所以写入走通用控件值路径即可。
const STACK_CLASSES = ["QG_LoraSwitchStack"];
const LOADER_CLASS = "QG_LoraLoader";
const STACK_WIDGET = "rows_data";

function nodeClass(node) {
  return node?.comfyClass || node?.type;
}

function isStackNode(node) {
  if (!node) return false;
  const cls = nodeClass(node);
  return STACK_CLASSES.includes(cls) || cls === LOADER_CLASS;
}

// 把两种宿主归一成同一个形状。ownerNode / ownerWidget 是开关快照的寻址键，
// 必须与加载器 rowOwners → stackRowOwners 用的键一模一样，否则行首的锁显示不出来。
function stackStateOf(node) {
  if (nodeClass(node) === LOADER_CLASS) {
    const state = node?.__qgLoraState;
    // readOnly（行由某个 box 喂进来的只读卡）没有自己的行可写，别列进选行界面。
    if (!state || !Array.isArray(state.rows) || !state.widget || state.readOnly) return null;
    const owner = state.owner ?? { node, name: "loras" };
    return {
      ...state,
      kind: "loader",
      hostNode: node,
      ownerNode: owner.node ?? node,
      ownerWidget: owner.name ?? "loras",
      // 别名只给堆那条专线用；loader 不会进那条路（见 writeStackRow）。
      dataWidget: state.widget,
    };
  }
  const state = node?.__qgSwitchStack;
  if (!state || !Array.isArray(state.rows) || !state.dataWidget) return null;
  return {
    ...state,
    kind: "stack",
    hostNode: node,
    ownerNode: node,
    ownerWidget: STACK_WIDGET,
  };
}

function stackNodesOf(state) {
  // node.graph 在子图重建早期会是空的，退回根图 —— 与堆里 refreshOwners 同一套兜底。
  const graph = state.node.graph ?? app.rootGraph ?? app.graph;
  const list = graph?.nodes ?? graph?._nodes ?? [];
  return [...list].filter(isStackNode);
}

function rowNameOnly(name) {
  return String(name ?? "").split(/[\\/]/).pop();
}

// 这个开关此刻管着哪些行：valuePairs 已经把 on/off 快照按行拆开了。
function heldRowNames(entry) {
  const held = new Map();
  for (const pair of valuePairs(entry)) {
    if (pair.row === undefined) continue;
    const key = String(pair.node);
    if (!held.has(key)) held.set(key, []);
    held.get(key).push(pair.row);
  }
  return held;
}

function holdsRow(held, nodeId, name) {
  return (held.get(String(nodeId)) ?? []).some((other) => sameFile(other, name));
}

// 把一行改成目标值，并让堆自己重画。
//
// 🔴 不能只改 dataWidget.value：堆的行状态在它自己的 state.rows 里，dataWidget
// 只是镜像；它的 onDrawForeground 明确**不读** widgets_values，所以外部改值
// 既不会显示，也会在下一次 writeRows 时被 state 覆盖回去。这里直接改
// state.rows，再照 writeRows 的顺序走一遍值/回调/撤销/重画（含 Nodes 2.0 的
// 独立 canvas）。堆那边改了 writeRows 的话，这里要跟着改。
// 选行那一刻记下的强度：开关「开」侧快照里那一行的值。快照两侧的强度相同，
// 所以 valuePairs 不会把它当成差异 —— 行的开/关判定完全不受影响，这里只是
// 把那个值取出来，在打开时恢复一次。
function presetStrength(settings, pair) {
  // 🔴 只查这个 pair 所属的开关。以前遍历全部开关，同一行被两个卡片管着时
  // 会取到别张卡片的旧强度，打开时把用户刚调好的值恢复成别人的（2026-11-23 排查）。
  const entry = settings.switches.find((item) => item.id === pair.entryId);
  if (!entry) return undefined;
  // 🔴 按 pair.widget 查：堆是 rows_data，加载器是 loras（或盒子的输入名）。
  // 以前写死 STACK_WIDGET，加载器的强度就永远读不到。
  const rows = stackRows(entry.on?.[String(pair.node)]?.[pair.widget]);
  const row = rows && findRow(rows, pair.row);
  // 🔴 空串 / null 不是 0：Number("") 会得到 0，老快照里空强度会被当成
  // 「恢复到 0」（整行失活）。与 lora_stack.mjs 的 keptStrength 同一口径。
  if (row && row.strength !== undefined && row.strength !== null && row.strength !== "") {
    const strength = Number(row.strength);
    if (Number.isFinite(strength)) return strength;
  }
  return undefined;
}

function writeStackRow(board, node, pair, side) {
  const stack = stackStateOf(node);
  // 只有 LoRA 堆走这条专线：它的行状态活在自己的前端 state 里，dataWidget 只是
  // 镜像，绘制不读 widgets_values，只改 widget 会被下一帧覆盖回去（见上文）。
  // LoRA 加载器恰好相反 —— 它的 syncRows 从 widget 读回 state，所以交回调用方
  // 走原来的控件值写入即可，别在这里直接改它的 state，那会绕过它自己的重画与连线重映射。
  if (!stack || stack.kind !== "stack") return false;
  const row = stack.rows?.find((item) => item?.name && sameFile(item.name, pair.row)) ?? null;
  if (!row) return true; // 行已不在：什么都不写，也不要退回改 widget
  // 🔴 OFF 侧只切 enabled，不写强度。注释承诺「关闭时不动强度」，但 want 直接取
  // pair.off —— 老存档里两侧强度不同的快照会让关掉时也把强度写成 OFF 那份（2026-
  // 11-23 排查实测：ON=0.9 / OFF=0.2 的快照，按关把强度改成了 0.2）。强度归 ON 侧
  // 的 presetStrength 管；正常选行两侧强度相同，这里剔除也不影响判定。
  const want = side === "on" ? { ...pair.on } : { enabled: pair.off.enabled };
  // 打开时把强度恢复到选行那一刻的值；关闭时不动强度（强度不属于开/关两态）。
  if (side === "on") {
    const preset = presetStrength(settingsOf(board.node), pair);
    if (Number.isFinite(preset)) want.strength = preset;
  }
  let changed = false;
  for (const [key, value] of Object.entries(want)) {
    if (row[key] === value) continue;
    row[key] = value;
    changed = true;
  }
  if (!changed) return true;
  stack.dataWidget.value = JSON.stringify(stack.rows.map((item) => ({ ...item })));
  stack.dataWidget.callback?.(stack.dataWidget.value);
  node.graph?.change?.();
  node.setDirtyCanvas?.(true, true);
  const paint = () => {
    for (const widget of [...(stack.rowWidgets || []), stack.addWidget]) {
      try { widget?.triggerDraw?.(); } catch (_) { /* 经典模式没有这个钩子 */ }
    }
  };
  paint();
  try { requestAnimationFrame(paint); } catch (_) { /* 非浏览器环境 */ }
  return true;
}

// 用勾选结果重写这个开关管的行：只有选中的行在两侧不同，其余行两侧一致，
// 于是它们既不会被这个开关碰，也不会把这一行读成「已改动」。
function applyRowPick(state, key, pickedRows) {
  const id = Number(key.slice(1));
  const settings = settingsOf(state.node);
  const entry = settings.switches.find((item) => item.id === id);
  if (!entry) return;
  const byNode = new Map();
  for (const item of pickedRows) {
    // 键必须是节点 id：选行界面交上来的是节点对象，直接 String(node) 会得到
    // "[object Object]"，下面按 id 查堆就永远查不到（2026-11-22 探针踩过）。
    const nodeId = String(item?.node?.id ?? item?.node);
    if (!byNode.has(nodeId)) byNode.set(nodeId, { node: item.node, names: [] });
    byNode.get(nodeId).names.push(item.name);
  }
  const stacks = new Map(stackNodesOf(state).map((node) => [String(node.id), node]));
  let next = settings;
  let rows = 0;
  const touched = new Set();
  for (const [nodeId, group] of byNode) {
    const stack = stackStateOf(stacks.get(nodeId));
    if (!stack) continue;
    const live = stack.rows.filter((row) => row?.name);
    const pickedHere = (row) => group.names.some((name) => sameFile(name, row.name));
    const count = live.filter(pickedHere).length;
    if (!count) continue;
    rows += count;
    // 🔴 touched 记的是快照真正写到的那个节点（owner），堆是自己、加载器可能是
    // 装它的 box。下面 letGo 按 owner 的键比对，取消勾选才放得掉。
    const ownerId = String(stack.ownerNode.id);
    touched.add(ownerId);
    // 只留比较用得上的字段：开关按下时写回用的是**当前**整栈（pairValue），
    // 所以快照里不需要 triggers 这类长文本，也就不用担心撞上 20000 字符上限。
    const snapshot = stack.rows.map((row) => ({
      name: row?.name ?? "",
      enabled: Boolean(row?.enabled),
      strength: row?.strength,
      strength_clip: row?.strength_clip,
    }));
    const side = (enabled) => snapshot.map((row) => (
      row.name && pickedHere(row) ? { ...row, enabled } : { ...row }
    ));
    next = saveValues(next, id, "on", [{ id: stack.ownerNode.id, values: { [stack.ownerWidget]: JSON.stringify(side(true)) } }]);
    next = saveValues(next, id, "off", [{ id: stack.ownerNode.id, values: { [stack.ownerWidget]: JSON.stringify(side(false)) } }]);
  }
  // 🔴 以前管着、这次一行都没勾的宿主，要把快照整个交出去。
  //
  // 只写「勾上的行」是不够的：一行都不勾时上面的循环整个跳过，旧快照原地不动，
  // 于是行首的 ⇄N 永远挂着、开关继续翻那些行 —— 用户看到的就是「取消不了」
  // （2026-11-23 报的）。判据直接看两侧有没有这个宿主的**行数组**快照，而不是看
  // heldRowNames：宿主被清空成零行时它产不出行，但快照仍在，那同样要放手。
  // 用 stackRows（值能解析成行数组）而不是写死 rows_data，这样加载器的 loras /
  // box 输入名同样认得，也不会误删同一节点上别的控件快照。
  const heldBefore = new Set();
  for (const side of ["on", "off"]) {
    for (const [nodeId, values] of Object.entries(entry[side] ?? {})) {
      if (values && Object.values(values).some((value) => stackRows(value))) heldBefore.add(String(nodeId));
    }
  }
  const letGo = [...heldBefore].filter((nodeId) => !touched.has(nodeId));
  next = dropValues(next, id, letGo);
  writeSettings(state, next);
  const title = settings.switches.find((item) => item.id === id)?.title ?? "";
  showToast({
    summary: zh("Workflow Switches"),
    detail: rows === 0
      ? (letGo.length
        ? zh("This switch no longer sets any LoRA row.")
        : zh("No LoRA row picked, so this switch changes only its other settings."))
      : rows === 1
        ? zh('"{a}" now switches {n} LoRA row.').replace("{a}", title).replace("{n}", String(rows))
        : zh('"{a}" now switches {n} LoRA rows.').replace("{a}", title).replace("{n}", String(rows)),
  });
}

// 这一行是不是由图上的线在控制：堆的 on_N 接了线时，后端用线值覆盖 enabled，
// 改行数组不会生效，所以选行界面要把这种行列出来但勾不上（静态工具无法判断是否
// 被连线驱动，开放勾选也需要额外提示；先看 input 是否已有连线）。
// 加载器的 strength_N 线只覆盖**强度**，而选行快照两侧强度始终相同、开关只切
// enabled，所以接线不影响它，照常可选 —— 这点与堆不同。
function rowIsWired(host, index) {
  if (host.kind !== "stack") return false;
  const slot = (host.hostNode?.inputs ?? []).find((input) => input?.name === `on_${index + 1}`);
  return Boolean(slot?.link);
}

// 选行界面：列出图上每个 LoRA 堆的每一行，勾完按确定。点击外部 = 取消。
function openRowPicker(state, key, anchor) {
  const id = Number(key.slice(1));
  const settings = settingsOf(state.node);
  const entry = settings.switches.find((item) => item.id === id);
  if (!entry) return;
  const held = heldRowNames(entry);
  const hosts = stackNodesOf(state)
    .map((node) => stackStateOf(node))
    .filter((host) => host?.rows?.some((row) => row?.name));
  if (!hosts.length) {
    showToast({
      summary: zh("Workflow Switches"),
      severity: "warn",
      detail: zh("No LoRA stack or LoRA loader with a row to switch: add rows to a LoRA stack or loader first."),
    });
    return;
  }
  // 别的开关各管着哪些行，先算一张表：逐行查时不再重复解析整栈快照。
  const others = settings.switches
    .filter((item) => item.id !== id)
    .map((item) => ({ title: item.title, held: heldRowNames(item) }));

  const menu = el("div", "qgtools-ws-menu scroll");
  menu.append(el("div", "qgtools-ws-menu-head", zh("LoRA rows")));
  // 筛选框：堆有 24 行、图上又可能有好几个堆，靠滚动找一行太慢。
  const filter = document.createElement("input");
  filter.className = "qgtools-ws-menu-filter";
  filter.type = "search";
  filter.placeholder = zh("Filter rows");
  // 占位符是我们自己的文案（已经过 zh），别让 DOM 翻译器再翻一遍。
  filter.setAttribute("translate", "no");
  menu.append(filter);

  const boxes = [];
  const groups = [];
  for (const host of hosts) {
    // 分组标题仍显示宿主节点（堆 / 加载器 / 装行的 box 都由它呈现），但「已被谁
    // 控制」一律按快照的 owner id 查 —— 加载器的行可能记在 box 名下。
    const stackNode = host.hostNode;
    const ownerId = String(host.ownerNode.id);
    const head = el("div", "qgtools-ws-menu-head sub", nodeTitle(stackNode));
    // 节点标题是用户的东西（他可能改过名），别让 DOM 翻译器去碰。
    head.setAttribute("translate", "no");
    menu.append(head);
    const group = { head, items: [] };
    groups.push(group);
    const rows = host.rows;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row?.name) continue;
      const label = el("label", "qgtools-ws-menu-item row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = holdsRow(held, ownerId, row.name);
      if (rowIsWired(host, index)) {
        input.disabled = true;
        input.checked = false;
        label.classList.add("wired");
        label.title = zh("This row is driven by a wire, so this switch cannot change it.");
      }
      // 这行此刻是什么样：勾选时能直接看到按下去会发生什么，不用凭记忆。
      const strength = Number(row.strength);
      const stateText = Number.isFinite(strength)
        ? `${row.enabled ? zh("On") : zh("Off")} ${strength.toFixed(2)}`
        : (row.enabled ? zh("On") : zh("Off"));
      const bits = [
        input,
        el("span", "nm", rowNameOnly(row.name)),
        el("span", "st", stateText),
      ];
      // 已被别的开关管着：不阻止（两个开关可以管同一行），但必须说出来 ——
      // 后按的那个赢，不说用户会以为开关坏了。
      const also = others.filter((other) => holdsRow(other.held, ownerId, row.name));
      if (also.length) {
        const tag = el("span", "own", `⇄ ${also.map((item) => item.title).join(zhPair(", ", "、"))}`);
        tag.title = zh("Another switch also sets this row. Whichever you press last wins.");
        bits.push(tag);
      }
      label.append(...bits);
      menu.append(label);
      const item = { node: stackNode, name: row.name, input, label };
      boxes.push(item);
      group.items.push(item);
    }
  }
  // 按文件名实时过滤；一个都不剩的分组连标题一起收起来，别留一排空标题。
  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    for (const group of groups) {
      let shown = 0;
      for (const item of group.items) {
        const hit = !q || item.name.toLowerCase().includes(q);
        item.label.style.display = hit ? "" : "none";
        if (hit) shown += 1;
      }
      group.head.style.display = shown ? "" : "none";
    }
  });
  menu.append(el("div", "qgtools-ws-menu-rule"));
  // 打开时恢复强度、关闭时不动 —— 这条不对称规则必须写在界面上，否则用户会
  // 以为关掉也会改强度。快照是在按「完成」那一刻拍的，也一并说清楚，否则
  // 用户不知道该怎么更新记忆。
  // 🔴 2026-11-23：这条只对 LoRA 堆成立（堆走 writeStackRow 专线、有 presetStrength）。
  // LoRA 加载器的强度由它自己的面板 / strength_N 连线管着，开关只切 enabled、
  // 不碰强度。给加载器显示「会恢复强度」是错误承诺，分开措辞。
  const onlyLoaderRows = hosts.length > 0 && hosts.every((host) => host.kind === "loader");
  menu.append(el("div", "qgtools-ws-menu-note", onlyLoaderRows
    ? zh("This switch only turns the picked rows on and off. A LoRA loader keeps each row's strength as set on the loader itself.")
    : zh("Turning this switch on restores the strength each picked row has now. Turning it off leaves strength alone. Done saves the strength the rows hold at that moment, so open this list and press Done again to refresh it.")));
  const foot = el("div", "qgtools-ws-menu-foot");
  const cancel = button("qgtools-ws-menu-item", zh("Cancel"));
  const ok = button("qgtools-ws-menu-item primary", zh("Done"));
  foot.append(cancel, ok);
  menu.append(foot);
  cancel.addEventListener("click", () => closeMenu());
  ok.addEventListener("click", () => {
    const pickedRows = boxes.filter((box) => box.input.checked).map((box) => ({ node: box.node, name: box.name }));
    closeMenu();
    applyRowPick(state, key, pickedRows);
  });
  positionMenu(menu, anchor);
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.abort.abort();
  openMenu.element.remove();
  openMenu.anchor.classList.remove("open");
  openMenu = null;
}

// A rule between groups of choices. Shared, since a rule carries nothing of
// its own and every menu can name the same one.
const SEP = Object.freeze({ rule: true });

// One menu at a time, hung under the button that asked for it. A second
// click on the same button closes it instead of opening another.
//
// The caller hands over the menu as a list of parts - a heading, a rule, or
// a choice - and nothing else: when a choice is dimmed, what it looks like
// when it is the dangerous one, and the fact that picking anything closes the
// menu first all live here, so no menu can forget one of them.
function openRowMenu(anchor, parts) {
  const wasOpen = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpen) return;
  const menu = el("div", "qgtools-ws-menu");
  for (const part of parts) {
    if (part.head !== undefined) {
      // A heading is a name the user gave or a sentence of ours: whatever
      // arrives here is already the text to show, as it is.
      const heading = el("div", `qgtools-ws-menu-head${part.sub ? " sub" : ""}`, part.head);
      // The switch's own name (not a sub-heading of ours) is the user's text.
      if (!part.sub) heading.setAttribute("translate", "no");
      menu.append(heading);
      continue;
    }
    if (part.rule) {
      menu.append(el("div", "qgtools-ws-menu-rule"));
      continue;
    }
    const choice = button(`qgtools-ws-menu-item${part.danger ? " danger" : ""}`, part.label, part.title);
    choice.disabled = Boolean(part.disabled);
    choice.addEventListener("click", () => {
      closeMenu();
      part.run();
    });
    menu.append(choice);
  }
  positionMenu(menu, anchor);
}

// What "add the N selected" says: the counted sentence when there is a
// count, the plain one otherwise. Both arrive already translated - a
// dictionary lookup cannot follow a variable, so the literals stay at the
// call site where the audit tools can see them.
function counted(one, many, count) {
  return count > 0 ? many.replace("{n}", String(count)) : one;
}

// The three-dot menu of a made switch.
function showMenu(state, key, anchor) {
  const id = Number(key.slice(1));
  const settings = settingsOf(state.node);
  const index = settings.switches.findIndex((item) => item.id === id);
  const entry = settings.switches[index];
  // The switch is already gone - an undo, another card saving over it, a row
  // whose settings have not been redrawn yet. Asking for its menu would hang
  // an empty box under the button, so there is nothing to open.
  if (!entry) return;
  const pick = picked(state);
  const ids = pickedIds(pick);
  const held = heldCount(entry, ids);
  const fresh = pick.count - held;
  // A node on the other side is already part of the switch: "take out" has
  // to see it, or it would look like nothing of the selection is in here.
  const offHeld = offHeldCount(entry, ids);
  const offFresh = offFreshCount(entry, ids);
  const inside = held + offHeld;
  const holdHow = "Select nodes or groups on the canvas first, then add them to this switch";
  const outHow = "Select nodes this switch holds first, then take them out of it";
  const sideHow = "Select nodes or groups on the canvas first. They run only while this switch is off, and are bypassed (or muted, per Settings) while it is on.";
  const offOutHow = "Select nodes that run only while this is off, then take them off that side. They stay as they are.";

  openRowMenu(anchor, [
    { head: entry.title },
    { label: zh("Rename"), run: () => startRename(state, key) },
    { label: zh("Select its nodes"), run: () => selectMembers(state, key), title: "Select every node this switch turns off and on" },
    SEP,
    {
      label: counted(zh("Add the selected"), zh("Add the {n} selected"), fresh),
      run: () => writeSettings(state, addMembers(settings, id, ids)),
      disabled: fresh < 1,
      title: holdHow,
    },
    {
      label: counted(zh("Take out the selected"), zh("Take out the {n} selected"), inside),
      run: () => writeSettings(state, removeMembers(settings, id, ids)),
      disabled: inside < 1,
      title: outHow,
    },
    SEP,
    // The other side: what runs only while this switch is off. Two paths
    // that take turns, one click each way.
    { head: zh("Its other side"), sub: true },
    {
      label: counted(zh("The selected run only while this is off"), zh("{n} of the selected run only while this is off"), offFresh),
      run: () => writeSettings(state, addOffMembers(settings, id, ids)),
      disabled: offFresh < 1,
      title: sideHow,
    },
    {
      label: counted(zh("Take the selected off that side"), zh("Take the {n} selected off that side"), offHeld),
      run: () => writeSettings(state, removeOffMembers(settings, id, ids)),
      disabled: offHeld < 1,
      title: offOutHow,
    },
    SEP,
    // 一个开关直接管 LoRA 堆的若干行，不必再存整套设置。
    // 原来的「改为改设置 / 保存为开 / 保存为关」已移除（2026-11-22 用户决定）：
    // 那一组的主要用途是绕出「只管一行」，而选行现在直接做到，还顺手把强度
    // 一并记住。老存档里已经存下的 on/off 快照仍然被读取、仍然生效，只是界面
    // 上不再提供新建与修改。
    { head: zh("LoRA rows"), sub: true },
    {
      label: zh("Choose LoRA rows"),
      run: () => openRowPicker(state, key, anchor),
      disabled: !stackNodesOf(state).some((node) => stackStateOf(node)?.rows?.some((row) => row?.name)),
      title: "Pick rows of a LoRA stack or a LoRA loader. This switch turns those rows on and off and leaves the rest alone.",
    },
    SEP,
    { label: zh("Move up"), run: () => writeSettings(state, moveSwitch(settings, id, -1)), disabled: index < 1 },
    { label: zh("Move down"), run: () => writeSettings(state, moveSwitch(settings, id, 1)), disabled: index >= settings.switches.length - 1 },
    SEP,
    {
      label: zh("Delete this switch"),
      run: () => writeSettings(state, removeSwitch(settings, id)),
      danger: true,
      title: "Removes the switch. Its nodes stay as they are.",
    },
  ]);
}

// The three-dot menu of a group row: select what the group holds, or take
// its row off the card (nothing on the canvas is touched).
function showGroupMenu(state, key, anchor) {
  const row = read(state).rows.find((candidate) => rowKey(candidate) === key);
  // The group is gone from under this row (renamed away, undone): there is
  // no row to describe, and an empty menu box helps nobody.
  if (!row) return;
  openRowMenu(anchor, [
    { head: row.title },
    { label: zh("Select its nodes"), run: () => selectMembers(state, key), title: "Select every node this group holds" },
    SEP,
    {
      label: zh("Delete this switch"),
      run: () => writeSettings(state, hideGroup(settingsOf(state.node), { id: row.group?.id, title: row.title })),
      danger: true,
      title: "Remove this group's row from this card. Nothing on the canvas changes, and Restore in Settings brings the row back.",
    },
  ]);
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

// All the wording one row carries, worked out before anything is written to
// the page: the label, the hover text of each part, the count and the two
// hints. Kept apart from the DOM so the sentences live in one place and can
// be read without a browser in the way.
function describeRow(data, settings, made) {
  const label = rowLabel(data);
  const pairs = data.pairs ?? [];
  const offNodes = data.offMembers ?? [];
  // The "and N more" tail is a sentence of its own so it can be translated;
  // the names it follows are node titles and stay as they are.
  const more = (total) => zh(" and {n} more").replace("{n}", String(total - 6));
  const named = (list) => list.slice(0, 6).map(nodeTitle).join(", ") + (list.length > 6 ? more(list.length) : "");
  const sets = pairs.slice(0, 6).map((pair) => `${nodeTitle(pair.live)} (${pair.row ?? pair.widget})`).join(", ");
  const parts = [];
  if (data.members.length) parts.push(zh("turns off and on {a}").replace("{a}", named(data.members)));
  if (offNodes.length) parts.push(zh("runs only while it is off: {a}").replace("{a}", named(offNodes)));
  if (pairs.length) parts.push(zh("changes {a}").replace("{a}", sets + (pairs.length > 6 ? more(pairs.length) : "")));
  const hover = made
    ? parts.length ? zh("{a}: {b}").replace("{a}", label).replace("{b}", parts.join(zhSep()))
      : data.half ? zh("{a}: set for one side only").replace("{a}", label)
        : zh("{a}: its nodes are gone").replace("{a}", label)
    : zh("{a}: every node inside this group").replace("{a}", label);

  // What stops running while the row is on, said on the mark itself, since
  // the row's label has no room for it.
  // 🔴 两个词先取好再交给 zh()：审计工具按「zh( 之后第一个字符串字面量」取键，
  // 写成 zh(a ? "muted" : "bypassed") 会把 muted 当成一个键。
  const quiet = settings.off === "mute" ? "muted" : "bypassed";
  const sided = hasOffSide(data.entry);
  const sideHint = offNodes.length
    ? zh("Runs only while this is off: {a} ({b} while it is on)").replace("{a}", named(offNodes)).replace("{b}", zh(quiet))
    : zh("Nothing is on its other side now: the nodes or groups put there are gone or empty.");

  // A row saved for one side only, with nothing else to show for itself.
  const waiting = data.half && !pairs.length && !data.members.length && !offNodes.length;
  // A setting changed by hand to a third value is neither on nor off.
  const changed = data.state === "mixed" && pairs.some((pair) => pair.now === "other");
  // Three of the four are words, and they go through zh() like every other
  // sentence here: they are written on every redraw, so a translator that only
  // reads a node when it is inserted would never get a second look at them.
  // The fourth is "2/3", which is a number and reads the same everywhere.
  const count = changed ? zh("changed")
    : data.state === "mixed" ? `${data.on}/${data.total}`
      : waiting ? zh("half set")
        : data.state === "empty" ? zh("empty") : "";
  // These were fragments bolted onto a counted start ("3 of its 5 " + X); a
  // whole-string dictionary can never match that, so each is a sentence.
  // Four of them, since a row with an off side counts its nodes the other way.
  const countedTitle = offNodes.length
    ? (pairs.length ? zh("{a} of its {b} nodes and settings are set for on") : zh("{a} of its {b} nodes are set for on"))
    : (pairs.length ? zh("{a} of its {b} nodes and settings are on") : zh("{a} of its {b} nodes run"));
  const countHint = changed
    ? zh("A setting this switch changes was set by hand to something else. Click off or on to set it again.")
    : data.state === "mixed" ? countedTitle.replace("{a}", String(data.on)).replace("{b}", String(data.total))
      : waiting ? zh("Set for one side only: the other side is empty, so the switch acts one way.")
        : data.state !== "empty" ? ""
          : made ? zh("Its nodes are gone. Add some from its menu in the edit view, or delete the switch.") : zh("No nodes inside this group yet");

  // A switch with nothing of its own to stop is spoken of as "switch", not
  // "run"; a switch with a second side says so, because the click moves two
  // sets of nodes, not one.
  const nothingOwn = pairs.length > 0 && !data.members.length;
  const offLead = nothingOwn ? zh('Switch "{a}" off') : settings.off === "mute" ? zh('Mute "{a}"') : zh('Bypass "{a}"');
  const onLead = nothingOwn ? zh('Switch "{a}" on') : zh('Run "{a}"');
  const offTails = [];
  if (offNodes.length) offTails.push(zh("its other side starts running"));
  const onTails = [];
  // One sentence per wording rather than one built from a verb: the
  // dictionary matches whole strings only.
  if (offNodes.length) onTails.push(settings.off === "mute" ? zh("its other side is muted") : zh("its other side is bypassed"));
  // One at a time only ever quiets the other rows on the way on: turning a
  // row off leaves them exactly as they are.
  if (settings.exclusive) onTails.push(zh("the other rows are switched off"));
  const say = (lead, tails) => [lead.replace("{a}", label), ...tails].join(zhSep());
  return { label, hover, count, countHint, sided, sideHint, turnOff: say(offLead, offTails), turnOn: say(onLead, onTails) };
}

// The off | on pill of one row: two halves of one switch, either click flips
// it. The halves come back with the pill so the row's sync can light the right
// one and say what the next click does.
function buildToggle(state, key) {
  const pill = el("div", "qgtools-card-seg qgtools-card-bool qgtools-ws-pill");
  pill.setAttribute("role", "group");
  const off = button("", "off");
  const on = button("", "on");
  off.addEventListener("click", () => switchRow(state, key, false));
  on.addEventListener("click", () => switchRow(state, key, true));
  pill.append(off, on);
  return { pill, off, on };
}

// The name box of a made switch: it sits where the label is while renaming and
// is hidden the rest of the time. Enter keeps what was typed, Escape puts the
// old name back, and leaving the box keeps it too.
function buildName(state, key) {
  const input = el("input", "qgtools-card-text qgtools-ws-name");
  input.type = "text";
  input.maxLength = TITLE_MAX;
  input.spellcheck = false;
  input.hidden = true;
  input.title = zh("Name this switch, then press Enter");
  input.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter") input.blur();
    else if (event.key === "Escape") stopRename(state, { keep: false });
  });
  input.addEventListener("blur", () => {
    // Only this row's own rename ends here: a name box can lose focus because
    // another row took it, and that must not write this one down.
    if (state.renaming === key) stopRename(state, { keep: true });
  });
  return input;
}

// A quiet mark that this switch hands the run to another set of nodes when it
// flips. CSS shows it in the edit view only, so it never clutters the card.
function buildSides() {
  const mark = el("span", "qgtools-ws-sides");
  mark.append(sidesIcon());
  return mark;
}

function buildRow(state, key, made) {
  const row = el("div", "qgtools-card-row qgtools-ws-row");
  const chip = el("span", "qgtools-ws-chip");
  const title = el("span", "qgtools-ws-title");
  // The name is the user's own words, so it is marked as not-for-translation.
  // Measured, not assumed: the page translator in use walks text nodes and
  // rewrites any whose whole text matches a dictionary key, without looking at
  // this attribute - a switch called "Fast" does show as the local word for
  // fast. The attribute stays because it is the standard way to say it, and
  // because a translator that reads it will then do the right thing.
  title.setAttribute("translate", "no");
  const count = el("span", "qgtools-ws-count");
  // 这个开关管着几个 LoRA 行。放在节点数旁边：配完行不用再打开菜单确认。
  const rowCount = el("span", "qgtools-ws-rowcount");
  const toggle = buildToggle(state, key);
  const go = button("qgtools-ws-tool", undefined, "Bring this part into view");
  go.append(frameIcon());
  go.addEventListener("click", () => frameRow(state, key));
  const more = button("qgtools-ws-tool", undefined, made
    ? "Rename, change or delete this switch"
    : "Select the group's nodes, or remove its row from this card");
  more.append(moreIcon());
  more.addEventListener("click", () => (made ? showMenu : showGroupMenu)(state, key, more));

  // A made switch has a name box and the other-side mark; a group row is read
  // only, so it gets neither.
  const name = made ? buildName(state, key) : null;
  const sides = made ? buildSides() : null;
  row.append(chip, title, ...(made ? [name, sides] : []), count, rowCount, toggle.pill, go, more);

  // 点名字：把画布视野移到这一行管的节点上（跟行尾准星按钮同一个入口）。
  //
  // 🔴 必须延迟一拍再定位：双击名字是「进编辑 / 改名」，而双击的第一下也会
  // 先发一个 click。立刻定位会把卡片甩出视野，用户正要在输入框里打字，卡片
  // 却跑没了。所以单击先挂一个定时器，300ms 内来了第二下就由 dblclick 取消。
  // 拖动不会触发 click（浏览器要 pointerdown/up 在同一处才发）。
  let frameTimer = null;
  title.addEventListener("click", () => {
    if (frameTimer) return; // 已经是双击的第二下，交给 dblclick 取消
    frameTimer = setTimeout(() => {
      frameTimer = null;
      frameRow(state, key);
    }, 300);
  });
  // A double-click on a label opens the edit view; there, it renames.
  title.addEventListener("dblclick", () => {
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
    if (!editOpen(state.node)) setEdit(state, true);
    else if (made) startRename(state, key);
  });

  const sync = (data, settings) => {
    const text = describeRow(data, settings, made);
    // What the row is: three exclusive states, set as classes so the CSS owns
    // the look of each.
    for (const state of ["off", "mixed", "empty"]) row.classList.toggle(state, data.state === state);
    chip.style.setProperty("--chip", data.color ?? (made ? accentColor() : NO_COLOR));
    title.textContent = text.label;
    // 悬停说明后面加一句「可以点」，否则「名字能点」这件事没人会发现。
    // 空行点了没反应，就不加这一句，也不显示手型光标（见 CSS）。
    title.title = data.state === "empty"
      ? text.hover
      : `${text.hover}\n${zh("Click the name to bring its nodes into view")}`;
    count.textContent = text.count;
    count.title = text.countHint;
    // 这个开关管着几行 LoRA —— 选行是它的核心能力，配完不该只有打开菜单才看得到。
    // 顺带标出其中几行落在正式堆里（那些行在画布上没有徽章，见 README）。
    const bound = settings.switches.find((item) => item.id === Number(String(key).slice(1)));
    const heldRows = bound ? heldRowNames(bound) : new Map();
    const stackNodes = stackNodesOf(state);
    let rowTotal = 0;
    let shippingRows = 0;
    for (const [nodeId, names] of heldRows) {
      rowTotal += names.length;
      const target = stackNodes.find((item) => String(item.id) === String(nodeId));
      if (String(target?.type) === "QG_LoraSwitchStack") shippingRows += names.length;
    }
    rowCount.textContent = rowTotal ? `⇄${rowTotal}` : "";
    // 🔴 不能 display:none。列模板是固定列数，这里少一个 grid item，它后面的
    // 开关胶囊就会整体左移一格（落到 26px 的按钮列里被压扁）。空着即可：
    // auto 列宽 0，肉眼看不见，但占住自己的位置。
    rowCount.title = rowTotal
      ? (shippingRows
        ? zh("Sets {n} LoRA rows, {m} of them in the shipping stack.")
          .replace("{n}", String(rowTotal)).replace("{m}", String(shippingRows))
        : zh("Sets {n} LoRA rows.").replace("{n}", String(rowTotal)))
      : "";
    // The mark only exists on a made switch, and only shows in the edit view.
    if (sides) {
      row.classList.toggle("sided", text.sided);
      sides.title = text.sideHint;
    }
    toggle.pill.classList.toggle("mixed", data.state === "mixed");
    toggle.off.classList.toggle("on", data.state === "off");
    toggle.on.classList.toggle("on", data.state === "on");
    toggle.off.setAttribute("aria-pressed", String(data.state === "off"));
    toggle.on.setAttribute("aria-pressed", String(data.state === "on"));
    // From a settled row both halves do the same thing - the click that
    // changes it - so both carry the same sentence; from a mixed row each half
    // says what picking it would give.
    const flip = data.state === "off" ? zhClick(text.turnOn) : data.state === "on" ? zhClick(text.turnOff) : null;
    toggle.off.title = flip ?? text.turnOff;
    toggle.on.title = flip ?? text.turnOn;
  };
  return { row, title, name, sync };
}

// ---------- the panel ----------

function declaredHeight(state) {
  return state.height + WRAPPER_INSET;
}

// 卡片要放哪些行：空卡片的提示、编辑栏、设置块。单选药丸删掉后，这里不再有
// 「一行药丸代替所有行」的分支。
function measureCard(listed, edit, open, settings) {
  const rows = [];
  if (!listed) rows.push({ widget: "hint", height: HINT_HEIGHT });
  for (let index = 0; index < listed; index += 1) rows.push({ widget: "switch" });
  if (edit) {
    rows.push({ widget: "bar" }, { group: "settings" });
    if (open) for (let index = 0; index < settingsRowCount(settings); index += 1) rows.push({ widget: "setting" });
  }
  return cardHeight(rows);
}

// The line under an empty card: what to do next, from where the card stands.
// Every branch is a whole sentence, so the dictionary can match it. It cannot
// be left in English: the card rewrites this text on every redraw, and a
// sentence written onto an element that is already in the document is only
// translated if the translator happens to have a moment to see it (C17) - the
// "no group matches" line was showing English on a 中文界面 because of it,
// and it was not in the dictionary either.
function hintText(edit, groupCount, settings) {
  if (!edit) return zh("No switches yet. Click here to make one.");
  if (groupCount && settings.groups !== "none") {
    return zh("No group matches the Groups setting. Select nodes and press + Switch.");
  }
  return zh("Select the nodes of one part, such as a box and its Save, then press + Switch.");
}

// The rows themselves: an element is reused for a key that is still listed, so
// a rename in progress keeps its cursor; it is moved only when it is out of
// place, since moving the row being renamed would take the cursor out of its
// name box; and a row whose part is gone is dropped.
// Keep a column of elements in step with a list of rows: one element per
// row, found by its key, reused for as long as the row is there, moved when
// the order changed, and taken away when the row is gone.
//
// 按 key 复用行、顺序变了就移动、没了就带走。选中的节点面板与卡片的行本来
// 共用这一段；单选药丸（pill / list）2026-11-22 删掉后只剩 `syncRows` 一个
// 调用方，但它仍然是「原地更新 DOM」的唯一实现，不要另写一份。
// Everything that differs (what an element is, how it is brought up to date,
// what has to be tidied when one goes) arrives as an argument.
function syncChildren(container, store, rows, { make, update, forget, elementOf = (entry) => entry }) {
  const seen = new Set();
  let cursor = container.firstElementChild;
  for (const row of rows) {
    const key = rowKey(row);
    let entry = store.get(key);
    if (!entry) {
      entry = make(row, key);
      store.set(key, entry);
    }
    update(entry, row);
    // Only an element out of place is moved: moving the one being renamed
    // would take the cursor out of its name box.
    const element = elementOf(entry);
    if (cursor === element) cursor = cursor.nextElementSibling;
    else container.insertBefore(element, cursor);
    seen.add(key);
  }
  for (const [key, entry] of store) {
    if (seen.has(key)) continue;
    forget?.(entry, key);
    elementOf(entry).remove();
    store.delete(key);
  }
}

function syncRows(state, rows, settings) {
  syncChildren(state.list, state.rows, rows, {
    make: (data, key) => buildRow(state, key, data.kind === "switch"),
    update: (entry, data) => entry.sync(data, settings),
    elementOf: (entry) => entry.row,
    // A row that is gone cannot be the one being renamed.
    forget: (entry, key) => {
      if (state.renaming === key) state.renaming = null;
    },
  });
}

// Everything around the rows: the hint line an empty card shows, the edit bar
// and its button, and the settings block.
function syncChrome(state, { edit, open, settings, rows, groupCount, pick }) {
  state.hint.classList.toggle("hidden", rows.length > 0);
  state.hint.textContent = hintText(edit, groupCount, settings);
  state.hint.classList.toggle("link", !edit);
  state.bar.classList.toggle("hidden", !edit);
  state.done.title = zh("Show only the labels and their switches. Double-click a label, or right-click the node, to edit again.");
  state.add.classList.toggle("ready", pick.count > 0);
  state.add.textContent = pick.count > 0
    ? zh("+ Switch from {n} selected").replace("{n}", String(pick.count))
    : zh("Select nodes, then add a switch");
  state.settings.sync(settings, edit, open);
}

// 把节点长到能装下卡片现在显示的内容。只有在真的变了才写尺寸：每次重绘都写
// 一次，会和画布对着干，也会把撤销历史塞满。
function fitCard(state, { edit, open, settings, listed }) {
  const height = measureCard(listed, edit, open, settings);
  const floor = minWidth(state.node);
  // Nodes 2.0 把最小宽度挂在节点的元素上：这里告诉它，因为宽度下限随编辑态变，
  // 而节点本身未必跟着变。
  holdVueNodeMinWidth(state.root, floor);
  if (height === state.height && (state.node.size?.[0] ?? 0) >= floor) return;
  state.height = height;
  const width = Math.max(floor, state.node.size?.[0] || NODE_WIDTH);
  state.node.setSize?.([width, state.node.computeSize?.()[1] || declaredHeight(state)]);
  state.node.graph?.setDirtyCanvas?.(true, true);
}

function render(state, settings, rows, groupCount, pick) {
  const edit = editOpen(state.node);
  const open = settingsOpen(state.node);
  state.root.classList.toggle("edit", edit);
  syncRows(state, rows, settings);
  syncChrome(state, { edit, open, settings, rows, groupCount, pick });
  fitCard(state, { edit, open, settings, listed: rows.length });
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

// The card's own parts, before anything is wired up: the frame, the hint, the
// edit bar, one empty list for the rows, the pick row, and the settings block.
// Nothing here listens to anything yet - that is wireCard's job.
function createCard(node) {
  ensureCss();
  const root = el("div", "qgtools-ws");
  const card = el("div", "qgtools-card");
  const list = el("div", "qgtools-ws-list");
  const hint = button("qgtools-ws-hint hidden");
  const bar = el("div", "qgtools-card-row qgtools-ws-bar hidden");
  const add = button("qgtools-ws-add", zh("+ Switch"), "Select the nodes of one part on the canvas, then press this: they get one switch");
  const done = button("qgtools-ws-done", zh("Done"));
  bar.append(add, done);
  root.append(card);

  const state = {
    node, root, list, hint, bar, add, done, rows: new Map(), settings: null, renaming: null,
    height: 0, signature: "", checkedAt: 0, timer: null, disposed: false,
  };
  node.__qgWorkflowSwitches = state;
  card.append(list, hint, bar);
  state.settings = buildSettings(state);
  card.append(state.settings.header, ...state.settings.rows);
  return state;
}

// What the three fixed parts of the card do, and how the card keeps events to
// itself. A click on a control stays out of the graph's drag and leaves the
// canvas selection alone; empty card space falls through, so the node still
// drags from its body like any other.
function wireCard(state) {
  state.add.addEventListener("click", () => newSwitch(state));
  state.done.addEventListener("click", () => setEdit(state, false));
  state.hint.addEventListener("click", () => setEdit(state, true));
  state.root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,input,select")) event.stopPropagation();
  });
  state.root.addEventListener("dblclick", (event) => event.stopPropagation());
}

// The DOM widget, and every rule about how big the card around it may be.
// A list is sized to its rows and nothing else: the width may grow, the
// height snaps back to what the rows need. Each line here was a bug once, so
// the notes say why it is there rather than what it does.
function attachCard(node, state) {
  const widget = node.addDOMWidget(WIDGET_NAME, "qg_workflow_switches", state.root, {
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
  // 🔴 litegraph 拖拽缩放时调的是 `node.computeSize()`（**不带参数**），并把
  // 「返回值宽度」当成节点的最小宽度：`if (l.width < u[0]) l.width = u[0]`。
  // 以前这里回落到 `node.size[0]`，于是下限恒等于当前宽度 —— 节点只能拖大、拖不小。
  // 下限必须是 minWidth(node)（收起态 = 表里的 minW），传入宽度只作为「想多宽」。
  widget.computeSize = (width) => {
    const floor = minWidth(node);
    const wanted = Number(width);
    return [Math.max(floor, Number.isFinite(wanted) && wanted > 0 ? wanted : floor), declaredHeight(state)];
  };
  // Pinned in Nodes 2.0 as well, where a node can be made taller than its list.
  pinVuePanelHeight(widget);
  widget.options.minNodeSize = [SMALL_MIN_WIDTH, 60];
  // The frontend skips a pinned card's width, so its floor is held here.
  holdNodeMinWidth(widget, () => minWidth(node));
  trimNodeBottom(node);
  state.widget = widget;
  return widget;
}

function buildPanel(node) {
  if (node.__qgWorkflowSwitches) return node.__qgWorkflowSwitches;
  const state = createCard(node);
  wireCard(state);
  attachCard(node, state);
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
    // A card copied together with its parts follows the copies. Without this
    // a whole workflow pasted into a new tab shows "empty" on every row and
    // none of them can be turned on: the copy keeps naming the ids it was
    // saved with, and those now belong to nothing (or, pasted into another
    // workflow, to something unrelated).
    onPaste(({ nodes, groups, created }) => {
      for (const node of created) {
        if (!isSwitches(node)) continue;
        const moved = repointSwitches(node.properties?.[SETTINGS_PROPERTY], nodes, groups);
        if (!moved) continue;
        node.properties ??= {};
        node.properties[SETTINGS_PROPERTY] = moved;
        const state = node.__qgWorkflowSwitches;
        // The signature decides whether anything is redrawn: a card whose
        // settings just changed has to be redrawn even if its rows read the
        // same, so it is cleared rather than trusted.
        if (state) {
          state.signature = "";
          refresh(state);
        }
      }
    });
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
        content: edit ? zh("Show only the switches") : zh("Edit switches"),
        callback: () => setEdit(state, !edit),
      }];
      if (!settings.exclusive) items.push({ content: zh("Switch everything on"), callback: () => switchAll(state, true) });
      items.push({ content: zh("Switch everything off"), callback: () => switchAll(state, false) });
      items.push(null);
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
