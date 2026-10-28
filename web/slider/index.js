// QG 数值滑条 —— 一行：滑条 + 右端数值 + 齿轮（前端）
//
// 后端有五个控件（kind、value、min_value、max_value、step），全部藏起来：
// kind / step / min_value / max_value 走齿轮菜单，value 由那一行的滑条接管。
//
// 两种渲染模式两套画法（跟「布尔开关」同一套模板）：
//   · 经典模式 → **canvas 自绘**，节点高度常数 58（= 布尔开关那一档）。
//     DOM 卡片那条路走 addDOMWidget，节点高度 = 26（槽位行）+ 卡片声明高
//     （52）+ 12（前端余量）= 90 —— 一行 26px 的滑条怎么压也压不到 58
//     （实测：卡片压到极限、行高降到 20 仍 ≥62）。而布尔的 58 是它自己
//     computeSize 写死的，所以照它的样子画，尺寸才真能对齐。
//   · Nodes 2.0 → DOM 卡片（shared/widget_card.mjs）。那边 onDrawForeground
//     不跑，卡片走 WidgetDOM 才在。
// 切模式时 installModeWatcher 调 __qgSyncMode 就地迁移，不重载图。
//
// 范围（最小 / 最大）收进齿轮菜单：它们一次设好就不常动，摆在卡片上白占一行。
// 齿轮在行的最右端、跟读数同一水平线。
//
// 切整数 / 浮点（applyKind）只动三件事：
//   1. 滑条的步长（step 控件，整数模式固定 1）
//   2. value 控件的 precision（原生控件是藏起来的，但前端按它取整）
//   3. 切到整数时把挂着的小数四舍五入
//
// 🔴 **输出槽的类型永远是 `*`，不跟着模式改**。后端 RETURN_TYPES 是类级静态
//    声明（`*`），真正的类型由 execute 的返回值决定；前端那层只是显示 + 连线
//    校验，改成 `INT` 会**直接挡住接不出去**：litegraph 的 connect() 遇到
//    INT → FLOAT 不抛错、也不建线（静默失败），而 LoRA 的 strength 正是 FLOAT
//    —— 用户「输出连不上 LoRA 强度」就是这么来的（2026-10-23 实测四种类型：
//    `*` / `FLOAT` / `INT,FLOAT` 都通，只有 `INT` 失败）。
//    当前是整数还是小数，看右端的读数就知道（小数模式带小数位）。
//
// 范围改变时会把 value 夹回来：不然把最大值从 100 改到 50，值还停在 80，
// 滑条顶在右端、输出却是 80，看着就像坏了。

import { app } from "/scripts/app.js";
import { sizeFor } from "../shared/node_width.mjs?v=2026102706";
import { BRAND, chainCallback, chainHandler, notifyQgChange } from "../shared/index.mjs?v=2026102706";
import { mountWidgetCard } from "../shared/widget_card.mjs?v=2026102706";
import { hideWidget } from "../shared/widget_visibility.mjs?v=2026102706";
import {
  detachDomWidget,
  installModeWatcher,
  onRenderModeSwitch,
  vueNodesEnabled,
} from "../shared/vue_mode.mjs?v=2026102706";
import {
  closeSettingsMenu,
  gearIconSvg,
  openSettingsMenu,
} from "../shared/settings_menu.mjs?v=2026102706";

const NODE_CLASS = "QG_Slider";
// kind 的取值，必须和 nodes/qg_slider.py 的 KINDS 逐字一致。
const KIND_INT = "integer";
const KIND_FLOAT = "float";
// 节点宽（也是拖拽下限）。320 = 布尔开关的默认宽（那边 BASE_WIDTH 320）。
const MIN_WIDTH = sizeFor("QG_Slider").minW;
// 🔴 经典模式的节点高度，取布尔开关那一档（web/bool_toggle 的 NODE_HEIGHT 58）：
//    两个节点摆一起完全齐平。canvas 自绘才能做到 —— 走 DOM 卡片时这 58 里
//    要先扣掉 26 的槽位行和 12 的前端余量，只剩 20 给卡片，装不下一行滑条。
const NODE_HEIGHT = 58;
// 齿轮菜单里没有小数位的概念，步长一律按「格」给。
const STEP_FALLBACK = 0.1;
const MAX_DECIMALS = 6;

const GEAR_SIZE = 24;
const CORNER_RESERVE = 30; // 齿轮 24 + 与控件之间的 6px 呼吸

// ---- canvas 卡片的版式（单位 = 节点局部 px，画布缩放由 LiteGraph 自己处理）
const SLOT_ROW = 22;   // 顶部让给输出槽名的一行（槽名是 LiteGraph 原生画的）
const PAD = 8;         // 卡片距节点主体边缘
const CARD_CORNER = 8; // 卡片圆角
const TRACK_H = 12;    // 轨道厚度（跟 DOM 卡片一致）
const KNOB = 20;       // 滑块直径（跟 DOM 卡片一致）
const GEAR_BOX = 18;   // 齿轮图标方框
// 读数的宽度**按范围算**（见 readoutWidth）：拖着滑条跑来跑去时宽度不变，
// 所以数字不会左右跳；但也不需要给「999.99」这种用不上的位宽 —— 默认 0–1
// 只留 "1.0" 那点地方，省下来的全归轨道（离读数只剩 4px）。
const READOUT_MIN = 22;
const READOUT_GAP = 4;  // 轨道右端 ↔ 读数左缘
const RESIZE_HANDLE = 15;

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;

// 量文字宽度用（offscreen）。读数宽度、编辑框宽度都要它。
const measureCtx = document.createElement("canvas").getContext("2d");
measureCtx.font = `600 11.5px ${FONT}`;
const textWidth = (text) => {
  try {
    return measureCtx.measureText(String(text)).width;
  } catch {
    return String(text).length * 6.5;
  }
};

const widgetOf = (node, name) => node.widgets?.find((widget) => widget.name === name);

function kindOf(node) {
  return widgetOf(node, "kind")?.value === KIND_FLOAT ? KIND_FLOAT : KIND_INT;
}

const numOf = (node, name, fallback) => {
  const value = Number(widgetOf(node, name)?.value);
  return Number.isFinite(value) ? value : fallback;
};

// 步长 → 小数位。按字面数点后位数，而不是 -log10(step)：0.25 的 -log10 是 0.6，
// 向上取整只给 1 位，0.25 这种步进会被显示成 0.3。
function decimalsFor(step) {
  const text = String(Math.abs(Number(step)) || STEP_FALLBACK);
  const exponent = text.split(/e-/i)[1];
  const digits = exponent
    ? Number(exponent) || 0
    : (text.split(".")[1] ?? "").length;
  return Math.max(0, Math.min(MAX_DECIMALS, digits));
}

// 每种模式的读数三件套。浮点模式的小数位跟着 step 控件走：步长 0.25 就该
// 显示两位、一格走 0.25，而不是固定两位一格走 0.1。
function modeOf(node, kind = kindOf(node)) {
  if (kind === KIND_FLOAT) {
    const step = Math.max(1e-6, numOf(node, "step", STEP_FALLBACK));
    return { step, fineStep: step / 10, decimals: decimalsFor(step) };
  }
  return { step: 1, fineStep: 1, decimals: 0 };
}

// 滑条的两端。最小值比最大值大的时候对调 —— 不然轨道方向是反的。
function rangeOf(node) {
  let low = numOf(node, "min_value", 0);
  let high = numOf(node, "max_value", 1);
  if (high < low) [low, high] = [high, low];
  if (high === low) high = low + 1e-9;
  return { low, high };
}

// 把值夹进 [最小, 最大]。round 是在整数模式下调用的：先取整再夹，免得
// 范围是 0.5–3.7 时四舍五入跑到 4 去。
function clampValue(node, { round = false } = {}) {
  const widget = widgetOf(node, "value");
  if (!widget) return;
  const { low, high } = rangeOf(node);
  let next = Number(widget.value);
  if (!Number.isFinite(next)) next = low;
  if (round) next = Math.round(next);
  next = Math.min(high, Math.max(low, next));
  if (next !== Number(widget.value)) {
    widget.value = next;
    widget.callback?.(next);
  }
}

// 卡片的刷新入口。经典模式没有卡片，用一个短路对象顶上：applyKind / setStep /
// setBound 里那些 `__qgCard.refresh()` 就都不用分模式判断了。
function refreshView(node) {
  if (node.__qgSliderView?.mode === "canvas") {
    node.setDirtyCanvas?.(true, false);
    return;
  }
  node.__qgCard?.refresh?.();
  node.setDirtyCanvas?.(true, true);
}

function applyKind(node, kind) {
  const isFloat = kind === KIND_FLOAT;
  const value = widgetOf(node, "value");
  const mode = modeOf(node, kind);
  // 只改 precision，不动 step：原生控件是藏起来的，step 只影响那个看不见的拖动，
  // 但前端的 value 访问器会按它取整 —— 写成 0.1 的话输入 1.25 会被吃成 1.3（踩过）。
  if (value?.options) value.options.precision = mode.decimals;
  clampValue(node, { round: !isFloat });
  // 输出槽恒 `*`（见文件头）。这里主动兜一次：老存档 / 别人写过的大小写
  // 变化都可能把类型改成 INT 或 FLOAT，改回来才接得上 FLOAT 目标。
  const out = node.outputs?.[0];
  if (out && out.type !== "*") out.type = "*";
  // 滑条的格子与读数位数都跟着模式走，得让它重算一遍。
  refreshView(node);
}

function setKind(node, kind) {
  if (kind !== KIND_INT && kind !== KIND_FLOAT) return;
  const kindWidget = widgetOf(node, "kind");
  if (kindWidget && kindWidget.value !== kind) {
    kindWidget.value = kind;
    // 控件上挂着 applyKind（installKindHook）和卡片的 refresh，走一遍
    kindWidget.callback?.(kind);
  }
  applyKind(node, kind);
  notifyQgChange();
}

// 兜一道：不管是谁改的 kind（齿轮菜单、右键把下拉转成输入再连线、扩展、脚本），
// 只要走了控件的 callback，外观就跟上。齿轮菜单的 setKind 也走这条。
function installKindHook(node) {
  const kindWidget = widgetOf(node, "kind");
  if (!kindWidget || node.__qgKindHooked) return;
  node.__qgKindHooked = true;
  const original = kindWidget.callback;
  kindWidget.callback = function (value, ...rest) {
    const result = original?.apply(this, [value, ...rest]);
    applyKind(node, value === KIND_FLOAT ? KIND_FLOAT : KIND_INT);
    return result;
  };
}

function setStep(node, value) {
  const step = Math.max(1e-6, Number(value) || STEP_FALLBACK);
  const widget = widgetOf(node, "step");
  if (widget && Number(widget.value) !== step) {
    widget.value = step;
    widget.callback?.(step);
  }
  // 滑条的格子按 step 走，改完得让它重算（读数位数也跟着变）。
  refreshView(node);
  notifyQgChange();
}

// 范围两端（最小值 / 最大值）。卡片上不显示它们，只能从齿轮菜单改：
// 值控件本身藏起来了，写进 widget 就是写进存档，所以照样走 callback，
// 让 installRangeHooks 去夹值、让视图去刷滑条长度。
function setBound(node, name, value) {
  const widget = widgetOf(node, name);
  const next = Number(value);
  if (!widget || !Number.isFinite(next)) return;
  if (Number(widget.value) === next) return;
  widget.value = next;
  widget.callback?.(next);
  refreshView(node);
}

// 范围 / 步长被谁改了都要跟一次：夹值（滑条不能指着范围外的数）、对齐步进。
function installRangeHooks(node) {
  for (const name of ["min_value", "max_value", "step"]) {
    const widget = widgetOf(node, name);
    if (!widget) continue;
    chainCallback(widget, "callback", () => {
      clampValue(node, { round: kindOf(node) === KIND_INT });
      refreshView(node);
      notifyQgChange();
    });
  }
}

// ---------------------------------------------------------------- 齿轮
//
// 经典模式画在轨道右边（canvas 自绘）；Nodes 2.0 挂在卡片右上角（corner）——
// 那边 onDrawForeground / onMouseDown 全停，画布上画的齿轮既不显示也点不到。
function makeGearCorner(node) {
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "qgtools-card-gear";
  gear.title = "滑条设置";
  gear.innerHTML = gearIconSvg(14);
  // 告诉共享菜单「这枚按钮是开关」：见 shared/settings_menu.mjs 的关闭监听
  gear.dataset.qgtoolsMenuToggle = "";
  gear.addEventListener("click", () => toggleSliderMenu(node));
  node.__qgSliderGear = gear;
  return { element: gear, sync: () => CORNER_RESERVE };
}

// 菜单的锚点。DOM 卡片直接用齿轮按钮的 rect；经典模式按节点坐标现算屏幕位置
// （画布有缩放和偏移，见 shared 里「屏幕 = (world + offset) * scale」）。
function gearAnchor(node) {
  const gear = node.__qgSliderGear;
  if (node.__qgSliderView?.mode !== "canvas" && gear?.isConnected) {
    const rect = gear.getBoundingClientRect();
    return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
  }
  const { gearX, gearY } = layoutOf(node);
  const canvasEl = app.canvas?.canvas;
  const ds = app.canvas?.ds;
  if (!canvasEl || !ds) {
    return { left: 0, top: 0, bottom: GEAR_SIZE, width: GEAR_SIZE };
  }
  const scale = Number(ds.scale) || 1;
  const rect = canvasEl.getBoundingClientRect();
  const left = rect.left + ((node.pos?.[0] ?? 0) + gearX + (Number(ds.offset?.[0]) || 0)) * scale;
  const top = rect.top + ((node.pos?.[1] ?? 0) + gearY + (Number(ds.offset?.[1]) || 0)) * scale;
  return { left, top, bottom: top + GEAR_BOX * scale, width: GEAR_BOX * scale };
}

// ---------------------------------------------------------------- 齿轮菜单
//
// `persist: false`：类型和步长是每个节点自己的状态，不是「这类节点的默认值」，
// 存进 localStorage 会让新建的节点跟着上次那个节点的设置走。
const MENU_SCOPE = "slider";
const MENU_SCHEMA = [
  {
    key: "kind",
    label: "类型",
    hint: "输出的数是整数还是小数",
    type: "choice",
    options: [KIND_INT, KIND_FLOAT],
    optionHints: {
      [KIND_INT]: "输出整数，滑条一格走 1，小数会被四舍五入掉",
      [KIND_FLOAT]: "输出小数，滑条一格走「步长」，读数按步长给几位小数",
    },
    persist: false,
  },
  {
    key: "min_value",
    label: "最小",
    hint: "滑条左端；比最大值大时会自动对调",
    type: "number",
    min: -1e12,
    max: 1e12,
    step: 1,
    fineStep: 0.1,
    decimals: 4,
    // 范围多半是整数（0 / 100），但也可以是 0.25；去尾零让两种都不难看。
    trimZeros: true,
    scrub: true,
    persist: false,
  },
  {
    key: "max_value",
    label: "最大",
    hint: "滑条右端；比最小值小时会自动对调",
    type: "number",
    min: -1e12,
    max: 1e12,
    step: 1,
    fineStep: 0.1,
    decimals: 4,
    trimZeros: true,
    scrub: true,
    persist: false,
  },
  {
    key: "step",
    label: "步长",
    hint: "浮点模式下每格多少（整数模式固定 1，不受这里影响）",
    type: "number",
    min: 0.000001,
    max: 1000,
    step: 0.01,
    fineStep: 0.001,
    decimals: 3,
    scrub: true,
    persist: false,
  },
];

let menuNode = null;

function toggleSliderMenu(node) {
  if (menuNode === node && document.querySelector(".qgtools-set-pop")) {
    closeSettingsMenu();
    menuNode = null;
    return;
  }
  menuNode = node;
  openSettingsMenu({
    scope: MENU_SCOPE,
    schema: MENU_SCHEMA,
    anchor: gearAnchor(node),
    title: "滑条设置",
    initial: {
      kind: kindOf(node),
      min_value: numOf(node, "min_value", 0),
      max_value: numOf(node, "max_value", 1),
      step: numOf(node, "step", STEP_FALLBACK),
    },
    onChange: (values, key) => {
      // key 为 null 是「Reset」按的，persist:false 的项保持不动
      if (key === "kind") setKind(node, values.kind);
      else if (key === "step") setStep(node, values.step);
      else if (key === "min_value" || key === "max_value") setBound(node, key, values[key]);
    },
  });
}

// 节点被删就收掉菜单：弹层挂在 document.body 上，跟节点没有父子关系。
function hookLifecycle(node) {
  chainCallback(node, "onRemoved", function () {
    if (menuNode === this) {
      closeSettingsMenu();
      menuNode = null;
    }
    uninstall(this);
  });
}

// ---------------------------------------------------------------- 输入槽
//
// 五个控件全藏在卡片 / 齿轮里，前端给「隐藏控件」画的输入槽会全部落在
// 同一个 y（每个 widget.y 都是 26）→ 五个圆点叠成卡片左上角的一个灰点，
// 看着像个没接上的接口。这些槽本来也没有接线的意义（值走滑条，范围和类型
// 走齿轮），所以直接把 input 从节点上摘掉，画布就不再画它们。
//
// 🔴 有连线的不动：宁可多一个圆点，也不能悄悄断掉别人已经接好的线。
// 🔴 倒序删，删掉一个后面的下标就变了。
const MANAGED_INPUTS = ["kind", "value", "min_value", "max_value", "step"];

function stripInputs(node) {
  const inputs = node.inputs;
  if (!Array.isArray(inputs)) return 0;
  let removed = 0;
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const slot = inputs[index];
    if (!slot || !MANAGED_INPUTS.includes(slot.name)) continue;
    if (slot.link != null) continue;
    node.removeInput(index);
    removed += 1;
  }
  return removed;
}

// 右端那串数字：固定小数位，拖动时宽度不跳。
function formatValue(node, raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(modeOf(node).decimals);
}

// ---------------------------------------------------------------- 经典画布
//
// 版式（节点局部坐标，原点 = 主体左上角，标题栏在 y < 0）：
//
//   ┌── 22px 输出槽名（原生画） ──────────────┐
//   │ ┌──────────────────────────────────┐   │  ← 卡片：x=8, 高 28
//   │ │ ▬▬▬▬▬▬▬▬▬●        0.0   ⚙       │   │
//   │ └──────────────────────────────────┘   │
//   └────────────────────────────────────────┘
//
// 高度恒定 58，所以版式全是常数、不乘缩放系数（画布缩放由 LiteGraph 的
// transform 处理，节点内部一律按布局 px 画）。宽度可变，轨道跟着伸缩。
// 读数要占多宽：把**范围两端**都格式化一遍，取最长那个。
// 只跟范围 / 模式有关，值在区间里怎么走都不变 → 数字不会左右跳（这是当初
// 写死 44px 的目的），但也不用给「999.99」这种用不上的位宽留地方。
function readoutWidthFor(low, high, decimals) {
  let widest = 0;
  for (const edge of [low, high]) {
    const w = textWidth(Number(edge).toFixed(decimals));
    if (w > widest) widest = w;
  }
  return Math.max(READOUT_MIN, Math.ceil(widest) + 1);
}

function readoutWidth(node) {
  const { low, high } = rangeOf(node);
  return readoutWidthFor(low, high, modeOf(node).decimals);
}

function layoutOf(node) {
  const w = Math.max(MIN_WIDTH, Math.round(Number(node.size?.[0]) || MIN_WIDTH));
  const top = node.outputs?.length ? SLOT_ROW : PAD;
  const card = { x: PAD, y: top, w: w - PAD * 2, h: NODE_HEIGHT - top - PAD };
  const cy = card.y + card.h / 2;
  const gearX = card.x + card.w - 6 - GEAR_BOX;
  const readoutRight = gearX - 7;
  const readoutW = readoutWidth(node);
  const readoutLeft = readoutRight - readoutW;
  const trackX = card.x + 8;
  // 轨道一直铺到读数左缘前 4px —— 原来这里还留着「读数固定 44px」的空白，
  // 视觉上轨道末端离数字有小半个字宽，用户说「缩小间距（加长轨道）」。
  const trackW = Math.max(24, readoutLeft - READOUT_GAP - trackX);
  return {
    w, card, cy,
    gearX, gearY: cy - GEAR_BOX / 2,
    readoutLeft, readoutRight, readoutW,
    trackX, trackW,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// 齿轮：8 颗齿 + 一个描边圆环（环自己就是中间的孔，不用 destination-out 抠，
// 那样会把节点底色一起擦掉）。
function drawGear(ctx, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#c8dddd";
  for (let i = 0; i < 8; i += 1) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 4);
    ctx.fillRect(-r * 0.17, -r, r * 0.34, r * 0.55);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, r * 0.42);
  ctx.strokeStyle = "#c8dddd";
  ctx.stroke();
  ctx.restore();
}

function drawCanvasSlider(node, ctx) {
  const view = node.__qgSliderView;
  if (!view || view.mode !== "canvas") return;
  const { card, cy, gearX, gearY, readoutRight, trackX, trackW } = layoutOf(node);
  const { low, high } = rangeOf(node);
  const value = Math.min(high, Math.max(low, Number(widgetOf(node, "value")?.value) || 0));
  const frac = Math.min(1, Math.max(0, (value - low) / (high - low)));
  const left = trackX + KNOB / 2;
  const right = trackX + trackW - KNOB / 2;
  const knobX = left + frac * (right - left);
  const trackY = cy - TRACK_H / 2;

  ctx.save();
  // LiteGraph 画节点主体时留下的阴影会跟着后面的描边一起偏移，先清掉。
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // 卡片底
  roundRect(ctx, card.x, card.y, card.w, card.h, CARD_CORNER);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,180,170,0.22)";
  ctx.stroke();

  // 轨道（未填充）
  roundRect(ctx, trackX, trackY, trackW, TRACK_H, TRACK_H / 2);
  ctx.fillStyle = "#2e3d3c";
  ctx.fill();

  // 已填充段：至少一个圆头宽度，否则滑块很靠左时看着像没有填充
  const fillW = Math.max(0, knobX - trackX);
  if (fillW > 0.5) {
    roundRect(ctx, trackX, trackY, Math.max(TRACK_H, fillW), TRACK_H, TRACK_H / 2);
    ctx.fillStyle = BRAND;
    ctx.fill();
  }

  // 滑块
  ctx.beginPath();
  ctx.arc(knobX, cy, KNOB / 2 - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = view.dragging ? "#ffffff" : "#d8ecea";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,180,170,0.55)";
  ctx.stroke();

  // 读数（右对齐到齿轮左边，固定不跳）
  ctx.font = `600 11.5px ${FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#d8ecea";
  ctx.fillText(formatValue(node, value), readoutRight, cy);

  // 齿轮
  drawGear(ctx, gearX + GEAR_BOX / 2, gearY + GEAR_BOX / 2, GEAR_BOX / 2);
  ctx.restore();
}

// 命中区比画出来的大一圈，鼠标不用瞄得那么准。
function hitGear(node, pos) {
  if (!pos) return false;
  const { gearX, gearY } = layoutOf(node);
  return (
    pos[0] >= gearX - 5 && pos[0] <= gearX + GEAR_BOX + 5 &&
    pos[1] >= gearY - 7 && pos[1] <= gearY + GEAR_BOX + 7
  );
}

function hitTrack(node, pos) {
  if (!pos) return false;
  const { trackX, trackW, cy } = layoutOf(node);
  return (
    pos[0] >= trackX - 6 && pos[0] <= trackX + trackW + 6 &&
    Math.abs(pos[1] - cy) <= TRACK_H + 4
  );
}

// 读数槽：点它就地输入（不是拖）
function hitReadout(node, pos) {
  if (!pos) return false;
  const { readoutLeft, readoutRight, cy } = layoutOf(node);
  return (
    pos[0] >= readoutLeft - 3 && pos[0] <= readoutRight + 3 &&
    Math.abs(pos[1] - cy) <= 13
  );
}

function inResizeCorner(node, pos) {
  if (!pos) return false;
  const width = node.size?.[0] ?? 0;
  const nearX = pos[0] <= RESIZE_HANDLE || pos[0] >= width - RESIZE_HANDLE;
  const nearY = pos[1] <= RESIZE_HANDLE || pos[1] >= NODE_HEIGHT - RESIZE_HANDLE;
  return nearX && nearY;
}

// 屏幕 clientX → 节点局部 x。画布有缩放和偏移：graph = 屏幕/scale − offset。
function localX(node, clientX) {
  const canvasEl = app.canvas?.canvas;
  const ds = app.canvas?.ds;
  if (!canvasEl || !ds || !Number.isFinite(clientX)) return null;
  const scale = Number(ds.scale) || 1;
  const rect = canvasEl.getBoundingClientRect();
  return (
    (clientX - rect.left) / scale -
    (Number(ds.offset?.[0]) || 0) -
    (Number(node.pos?.[0]) || 0)
  );
}

function commitValue(node, next) {
  const widget = widgetOf(node, "value");
  const value = Number(next);
  if (!widget || !Number.isFinite(value)) return;
  if (Number(widget.value) === value) return;
  widget.value = value;
  widget.callback?.(value);
  node.setDirtyCanvas?.(true, false);
}

// 按 x 定位：先算比例，再对齐步长（浮点）/ 四舍五入（整数），最后夹进范围。
function setFromLocalX(node, x) {
  const { trackX, trackW } = layoutOf(node);
  const left = trackX + KNOB / 2;
  const right = trackX + trackW - KNOB / 2;
  const frac = Math.min(1, Math.max(0, (x - left) / Math.max(1, right - left)));
  const { low, high } = rangeOf(node);
  const mode = modeOf(node);
  const raw = low + frac * (high - low);
  const next = kindOf(node) === KIND_FLOAT
    ? Number((Math.round(raw / mode.step) * mode.step).toFixed(MAX_DECIMALS))
    : Math.floor(raw + 0.5);
  commitValue(node, Math.min(high, Math.max(low, next)));
}

// ---------------------------------------------------------------- 读数可编辑
//
// 点右端那串数字 → 就地弹一个输入框（跟布尔开关的标签编辑同一套做法）：
// 回车 / 失焦提交，Esc 取消，中文输入法选词时的回车不算提交。
// 两种渲染模式共用同一个框：canvas 模式按节点坐标现算屏幕位置，Nodes 2.0
// 直接用读数元素的 rect（都是屏幕 CSS px，框跟着走）。
const EDITOR_CLASS = "qgtools-slider-edit";
const EDITOR_CSS = `
.qgtools-slider-edit{position:fixed;z-index:10000;box-sizing:border-box;
  border:1px solid rgba(0,180,170,.85);border-radius:5px;background:rgba(6,20,19,.96);
  color:#eef7f6;outline:none;text-align:right;font-weight:600;
  font-variant-numeric:tabular-nums;padding:0 5px;
  box-shadow:0 6px 22px rgba(0,0,0,.55);}
.qgtools-slider-edit::selection{background:rgba(0,180,170,.38);color:#fff;}
`;

let openEditor = null;

function ensureEditorCss() {
  if (document.getElementById("qgtools-slider-edit-css")) return;
  const style = document.createElement("style");
  style.id = "qgtools-slider-edit-css";
  style.textContent = EDITOR_CSS;
  document.head.append(style);
}

function closeValueEditor() {
  const input = openEditor;
  openEditor = null;
  input?.remove();
}

// 节点局部坐标 → 屏幕 client 坐标。画布：`(world + offset) * scale` + canvas rect。
function canvasToScreen(node, lx, ly) {
  const canvas = app.canvas;
  const ds = canvas?.ds;
  const world = [(node.pos?.[0] ?? 0) + lx, (node.pos?.[1] ?? 0) + ly];
  let point;
  if (ds?.convertOffsetToCanvas) {
    point = ds.convertOffsetToCanvas([world[0], world[1]]);
  } else {
    const scale = Number(ds?.scale) || 1;
    const offset = ds?.offset ?? [0, 0];
    point = [(world[0] + offset[0]) * scale, (world[1] + offset[1]) * scale];
  }
  const box = canvas?.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  return [box.left + point[0], box.top + point[1]];
}

// 输入框里的字 → 世界里的值：整数四舍五入，浮点按步长对齐，最后夹进范围。
// 跟 setFromLocalX 用同一套规则，免得「拖到 0.3」和「打 0.3」出来不一样。
function applyEditedText(node, text) {
  const raw = Number(String(text ?? "").trim());
  if (!Number.isFinite(raw)) {
    // 输入的是乱七八糟的东西（空、字母）：不改值，只把画面刷回原样。
    refreshView(node);
    return;
  }
  const { low, high } = rangeOf(node);
  const mode = modeOf(node);
  const next = kindOf(node) === KIND_FLOAT
    ? Number((Math.round(raw / mode.step) * mode.step).toFixed(MAX_DECIMALS))
    : Math.floor(raw + 0.5);
  commitValue(node, Math.min(high, Math.max(low, next)));
  refreshView(node);
  notifyQgChange();
}

// anchor() 返回屏幕矩形 { left, top, width, height }，每帧重算 —— 编辑期间
// 缩放画布、拖动画布甚至拖动节点都要对得上。
function openValueEditor(node, anchor) {
  const widget = widgetOf(node, "value");
  if (!widget || typeof anchor !== "function") return;
  ensureEditorCss();
  closeValueEditor();

  const input = document.createElement("input");
  input.className = EDITOR_CLASS;
  input.type = "text";
  input.inputMode = "decimal";
  input.spellcheck = false;
  input.value = String(widget.value ?? "");
  document.body.append(input);
  openEditor = input;

  let frame = 0;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    // 🔴 先清引用再 remove：remove() 会同步触发 blur，顺序反了 Esc 会变成提交
    //    （bool_toggle 里踩过一样的坑）。
    if (openEditor === input) openEditor = null;
    input.remove();
  };
  const commit = () => {
    if (done) return;
    const text = input.value;
    close();
    applyEditedText(node, text);
  };

  const place = () => {
    const box = anchor();
    if (!box) return;
    const scale = Number(app.canvas?.ds?.scale) || 1;
    const height = Math.max(18, Math.round(20 * scale));
    const fontPx = Math.max(10, 11.5 * scale);
    input.style.font = `600 ${fontPx.toFixed(1)}px ${FONT}`;
    input.style.fontVariantNumeric = "tabular-nums";
    input.style.height = `${height}px`;
    input.style.lineHeight = `${height - 2}px`;
    input.style.width = `${Math.round(box.width + 10 * scale)}px`;
    input.style.left = `${Math.round(box.left - 4)}px`;
    input.style.top = `${Math.round(box.top + (box.height - height) / 2)}px`;
  };
  place();

  const tick = () => {
    if (done) return;
    if (node.__qgSliderView == null || node.flags?.collapsed) {
      close();
      return;
    }
    place();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    // 中文输入法选词时的回车（isComposing / keyCode 229）不能当提交
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  });
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("blur", () => {
    if (!done && openEditor === input) commit();
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// canvas 模式下读数的屏幕矩形（读数槽，居中留一点边）。
function readoutAnchor(node) {
  return () => {
    const L = layoutOf(node);
    if (node.flags?.collapsed) return null;
    const scale = Number(app.canvas?.ds?.scale) || 1;
    const [cx, cy] = canvasToScreen(node, L.readoutLeft + L.readoutW / 2, L.cy);
    return {
      left: cx - (L.readoutW * scale) / 2,
      top: cy - 10 * scale,
      width: L.readoutW * scale,
      height: 20 * scale,
    };
  };
}

// 拖拽走原生 pointer 事件：onMouseDown 只负责「这一下按在轨道上」，
// 之后 window 上的 pointermove 才跟得住 —— LiteGraph 的 onMouseMove 只在
// 指针还压在节点上时回调，拖到节点外面就断了。
//
// 🔴 必须挂**捕获阶段**（`{ capture: true }`）。LiteGraph 在 canvas 的
//    pointerup 里会 stopPropagation，冒泡阶段根本到不了 window —— 实测
//    window 冒泡只收到 pointermove，pointerup 一个都没有，于是 finish 永远
//    不跑、view.dragging 一直是 true：用户「松开鼠标没释放」就是这个
//    （2026-10-23，tools/probe_slider_release.py 记录的三层计数）。
//    捕获阶段在事件下行时就先拿到，谁也拦不住。
const CAPTURE = { capture: true };

function beginDrag(node, event) {
  const view = node.__qgSliderView;
  if (!view || view.mode !== "canvas") return;
  const move = (ev) => {
    ev.preventDefault();
    const x = localX(node, ev.clientX);
    if (x !== null) setFromLocalX(node, x);
  };
  const finish = () => {
    window.removeEventListener("pointermove", move, CAPTURE);
    window.removeEventListener("pointerup", finish, CAPTURE);
    window.removeEventListener("pointercancel", finish, CAPTURE);
    window.removeEventListener("blur", finish);
    view.dragging = false;
    node.setDirtyCanvas?.(true, false);
    notifyQgChange();
  };
  view.dragging = true;
  window.addEventListener("pointermove", move, CAPTURE);
  window.addEventListener("pointerup", finish, CAPTURE);
  window.addEventListener("pointercancel", finish, CAPTURE);
  // 切窗口 / 拔掉鼠标时 pointerup 可能压根不来，兜一道。
  window.addEventListener("blur", finish);
  const x = localX(node, event?.clientX);
  if (x !== null) setFromLocalX(node, x);
}

// 宽度是唯一的把手，高度恒定 —— 拉宽只为了轨道更长。
function keepSize(node) {
  const width = Math.max(MIN_WIDTH, Math.round(Number(node.size?.[0]) || MIN_WIDTH));
  if (node.size?.[0] === width && node.size?.[1] === NODE_HEIGHT) return false;
  if (typeof node.setSize === "function") node.setSize([width, NODE_HEIGHT]);
  else node.size = [width, NODE_HEIGHT];
  return true;
}

// 🔴 画布钩子一辈子只装一次。chainCallback 是链式包装、摘不掉，而切渲染模式
//    会反复走 install/uninstall；每切一次再包一层的话，onMouseDown 里开菜单
//    会走两遍、onDrawForeground 也会画两遍。所以钩子挂在节点上，靠
//    canvasMode() 短路决定听不听。
function installCanvasHooks(node) {
  if (node.__qgCanvasHooks) return;
  node.__qgCanvasHooks = true;

  const canvasMode = (n) => n.__qgSliderView?.mode === "canvas";

  chainCallback(node, "onResize", function () {
    if (canvasMode(this)) keepSize(this);
  });

  chainCallback(node, "onDrawForeground", function (ctx) {
    if (!canvasMode(this) || this.flags?.collapsed) return;
    // 拖拽时 LiteGraph 直接写 size，onResize 很少回调 —— 顺手按回去。
    if (keepSize(this)) this.setDirtyCanvas?.(true, false);
    drawCanvasSlider(this, ctx);
  });

  // 🔴 必须用 chainHandler（不是 chainCallback）：LiteGraph 只有在 onMouseDown
  //    返回 true 时才不拖节点。chainCallback 会把我们的返回值丢掉（它返回的是
  //    上一个处理器的结果），于是「按住滑条拖动」= 节点和滑块一起跑，而节点
  //    坐标跟着指针走 → 换算出来的局部 x 不变 → 值一点不动（实测 dragged 到
  //    88，值还停在 20，node.pos 从 220 跑到 351）。
  chainHandler(node, "onMouseDown", function (event, pos) {
    if (!canvasMode(this) || inResizeCorner(this, pos)) return false;
    if (hitGear(this, pos)) {
      toggleSliderMenu(this);
      return true; // 吃掉这一下，别让它变成拖节点
    }
    // 读数比轨道窄，先判它：轨道的命中区往右多放了 6px，会骑到读数左边。
    if (hitReadout(this, pos)) {
      openValueEditor(this, readoutAnchor(this));
      return true;
    }
    if (hitTrack(this, pos)) {
      beginDrag(this, event);
      return true;
    }
    return false;
  });
}

function installCanvas(node) {
  // 五个控件在画布上没有外观，留着会被 LiteGraph 画成一排空行。
  for (const name of MANAGED_INPUTS) hideWidget(widgetOf(node, name));
  stripInputs(node);
  node.resizable = true;
  // computeSize 是「拖拽能达到的最小尺寸」，不能回声当前尺寸，否则拉不宽。
  // 原来那个存一份：切回 Nodes 2.0 时还回去，DOM 卡片那条路不能被常数压着。
  node.__qgOrigComputeSize ??= node.computeSize;
  node.computeSize = () => [MIN_WIDTH, NODE_HEIGHT];
  installCanvasHooks(node);
  keepSize(node);
  // 让 refreshView 有地方去：经典模式没有卡片对象。
  node.__qgCard = null;
  // 探针用：画布上的版式是算出来的，测试得能拿到同一份数字（见 tools/probe_slider.py）。
  node.__qgSliderProbe = {
    layout: () => layoutOf(node),
    readout: () => formatValue(node, widgetOf(node, "value")?.value),
  };
  return { mode: "canvas", dragging: false };
}

// ---------------------------------------------------------------- Nodes 2.0 卡片

function installDom(node) {
  mountWidgetCard(node, {
    rows: [
      // 唯一一行：滑条。它不占控件，只借用 value 的值与范围控件的两端；
      // 右端读数显示当前值，齿轮（corner）紧挨在它右边。
      {
        slider: {
          value: "value",
          min: "min_value",
          max: "max_value",
          step: (vals) => {
            if (String(vals.kind) !== KIND_FLOAT) return 1;
            return Math.max(1e-6, Number(vals.step) || STEP_FALLBACK);
          },
          format: (raw) => formatValue(node, raw),
          // 读数只占「范围里最长的那个数」那么宽，剩下的全给轨道。
          readoutWidth: (vals) => {
            const mode = modeOf(node, String(vals.kind) === KIND_FLOAT ? KIND_FLOAT : KIND_INT);
            const low = Number(vals.min_value);
            const high = Number(vals.max_value);
            return readoutWidthFor(
              Number.isFinite(low) ? low : 0,
              Number.isFinite(high) ? high : 1,
              mode.decimals,
            );
          },
          // 点数字就地改（跟经典模式同一个编辑框）。
          onEdit: (readout) => openValueEditor(node, () => readout.getBoundingClientRect()),
        },
        title: "拖动调整数值；范围和步长在右边的齿轮里改",
        editTitle: "点击直接输入数值（回车确认，Esc 取消）",
      },
    ],
    minWidth: MIN_WIDTH,
    // 五个控件全部收起：值走滑条，范围 / 类型 / 步长走齿轮。
    hide: MANAGED_INPUTS,
    corner: makeGearCorner,
    // 卡片只有一行，不移上去的话标题栏和卡片之间会留一条明显的空带。
    topPad: 6,
  });
  // 从经典模式切过来时节点还停在 58 —— DOM 卡片装不下（槽位行 + 卡片 + 前端
  // 余量 = 90），得让它自己长到卡片要的高度。只长不缩，用户拖高过的不动。
  try {
    const need = Number(node.computeSize?.()?.[1]);
    const now = Number(node.size?.[1]);
    if (Number.isFinite(need) && Number.isFinite(now) && now < need) {
      if (typeof node.setSize === "function") node.setSize([node.size[0], need]);
      else node.size = [node.size[0], need];
    }
  } catch { /* 忽略：下一帧前端自己也会补 */ }
  return { mode: "dom" };
}

// ---------------------------------------------------------------- 挂载 / 迁移

function install(node) {
  const view = vueNodesEnabled() ? installDom(node) : installCanvas(node);
  if (!view) return null;
  node.__qgSliderView = view;
  node.__qgSyncMode = () => syncMode(node);
  // 换了一套画法，当前类型 / 范围要重新套一遍（顺带夹值）。
  applyKind(node, kindOf(node));
  return view;
}

function uninstall(node) {
  const view = node.__qgSliderView;
  if (!view) return;
  node.__qgSliderView = null;
  node.__qgSliderProbe = null;
  if (view.mode === "dom") {
    const card = node.__qgCard;
    if (card && !card.canvas) {
      detachDomWidget(node, card.widget, card.root);
      if (node.__qgCard === card) node.__qgCard = null;
    }
  }
  // 被改过的实例字段还回去 —— computeSize 一旦常量化，DOM 卡片那条路就长不开了。
  if (node.__qgOrigComputeSize) node.computeSize = node.__qgOrigComputeSize;
}

function syncMode(node) {
  const want = vueNodesEnabled() ? "dom" : "canvas";
  if (node.__qgSliderView?.mode !== want) {
    uninstall(node);
    install(node);
    node.setDirtyCanvas?.(true, true);
  }
  return node.__qgSliderView;
}

function mount(node) {
  if (node.__qgSlider) return;
  node.__qgSlider = true;

  // 先摘槽：五个控件的槽叠成一个灰点，没有接线的意义。
  stripInputs(node);
  installKindHook(node);
  installRangeHooks(node);
  hookLifecycle(node);
  install(node);

  // 🔴 读档时 kind 是直接写进 widget 的，不走 callback，所以这里必须补一次。
  //    等 microtask 是因为 widgets_values 要等这一轮 configure 结束才填完。
  //    顺手夹一次值：存档里可能有超出新范围的老数据。
  chainCallback(node, "onConfigure", function () {
    queueMicrotask(() => {
      // 读档时 inputs 由 nodeData 重建，槽会跟着回来，所以这里得再摘一次。
      stripInputs(this);
      // 存档里的尺寸也在这一刻落地：经典模式要按回 320×58。
      // 🔴 syncMode 只在模式变了才重装；老存档（存的是 320×90）会原样留着，
      //    所以这里必须再 keepSize 一次，不然「高度没变」的老节点刷完还是 90。
      const view = syncMode(this);
      if (view?.mode === "canvas") keepSize(this);
      applyKind(this, kindOf(this));
      clampValue(this);
      this.setDirtyCanvas?.(true, true);
    });
  });
}

app.registerExtension({
  name: "QG.Slider",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      mount(this);
    });
  },

  async setup() {
    // 切模式前先收掉菜单：它是 position:fixed、按旧模式的位置摆的，切完必然错位。
    onRenderModeSwitch(() => {
      try {
        closeSettingsMenu();
        menuNode = null;
      } catch { /* 忽略 */ }
    });
    installModeWatcher((node) => {
      if (String(node?.comfyClass ?? node?.type ?? "") !== NODE_CLASS) return null;
      if (typeof node.__qgSyncMode !== "function") {
        node.__qgSyncMode = () => syncMode(node);
      }
      return node.__qgSyncMode;
    });
  },
});

console.log("[QG-tools] slider node ready");
