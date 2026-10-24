// QG 布尔开关 — 整张节点就是一枚开关（前端）
//
// 后端只有一个隐藏的 BOOLEAN 控件（`boolean`），值照旧进 widgets_values，
// 所以存档、撤销、API 导出都跟原生布尔一样；这里只负责把它画成一张卡片：
// 左边一个 开 / 关 大字，右边一枚胶囊，点胶囊切换。
//
// 为什么不用 DOM 控件：卡片要跟着节点一起缩放、要在画布缩放时保持清晰，
// 而且指针落在卡片上时还应该能拖动节点 —— canvas 直接绘制最省事。
// 只有部分区域（胶囊）吃点击，其余地方留给 LiteGraph 原生拖拽。
//
// 🔴 坐标系：onDrawForeground / onMouseDown 的局部坐标原点在**标题栏左上角**，
//    标题栏占 y ∈ [-30, 0]，节点主体是 y ∈ [0, size[1]]（size 不含标题栏）。
//    size 只算主体，别把 30 加进去。

import { app } from "/scripts/app.js";
import {
  chainCallback,
  keepDomWidgetWidthAuto,
  notifyQgChange,
  zh,
} from "../shared/index.mjs?v=2026102418";
import { holdNodeMinWidth } from "../shared/panel_layout.mjs?v=2026102418";
import {
  detachDomWidget,
  installModeWatcher,
  onRenderModeSwitch,
} from "../shared/vue_mode.mjs?v=2026102418";
import { hideInputsInDef, hideWidget } from "../shared/widget_visibility.mjs?v=2026102418";

const NODE_CLASS = "QG_BoolToggle";
const WIDGET_NAME = "qg_bool_toggle_panel";
const CSS_ID = "qgtools-bool-toggle-css";

const BASE_WIDTH = 320;
// 缩放基准（字号 / 胶囊 / 圆角都按它等比算），**不是节点高度**。
const BASE_HEIGHT = 84;
const MIN_WIDTH = 220;
const RATIO = BASE_HEIGHT / BASE_WIDTH;
// 节点高度固定在「缩到最小时的高度」：一排开关并排完全齐平，也最省地方。
// 宽度随便拉，只横向长，不加厚。
const NODE_HEIGHT = Math.round(MIN_WIDTH * RATIO);   // 58

const PAD = 8;              // 卡片相对节点主体的内缩
const SLOT_ROW = 22;        // 顶部给输出槽名留的一行（槽是原生画的，卡片别压上去）
const CORNER = 10;          // 卡片圆角
const LABEL_LEFT = 26;      // 大字距卡片左边
const LABEL_SIZE = 32;      // 大字字号（基准宽度下）
const PILL_W = 62;
const PILL_H = 30;
const PILL_RIGHT = 22;      // 胶囊距卡片右边

const ON_FILL = "#33c46e";
const ON_LABEL = "#eef7f6";
const OFF_FILL = "#4c5152";
const OFF_LABEL = "#8e9a99";
const KNOB = "#f8fafa";
const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

// Nodes 2.0 的 DOM 卡片要和经典画布「一样大」：经典所有尺寸都乘 scaleOf()，
// 节点高恒 NODE_HEIGHT(58) → 系数恒 58/84 ≈ 0.69，62×30 的胶囊画出来就是 43×21。
// 这里直接把这套结果写成**固定像素**：胶囊高度不能跟着节点高度走，
// 节点被拉高（DOM 外壳自带头部 / 徽章行）时胶囊也不许胖。
const DOM_CORNER = 7;        // 卡片圆角（CORNER 10 × 0.69）
const DOM_LABEL = 22;        // 大字（LABEL_SIZE 32 × 0.69）
const DOM_PILL_W = 43;       // 胶囊（PILL_W 62 × 0.69）
const DOM_PILL_H = 21;       // 胶囊高度固定（PILL_H 30 × 0.69）
const DOM_KNOB = 16;         // 圆钮（23 × 0.69）
const DOM_KNOB_GAP = 2.5;    // 圆钮距胶囊边（3.5 × 0.69）
const DOM_ROW_H = 24;        // 卡片就一行高，节点被拖高也不跟着长

// 🔴 缩放手柄是四角各 15x15，而 canvas 的处理顺序是「onMouseDown 返回 true」
//    优先于「找缩放手柄」—— 命中区不让开四角，右下角就再也拖不大。
const RESIZE_HANDLE = 15;

const valueWidget = (node) => node.widgets?.find((widget) => widget.name === "boolean");
const labelWidget = (node) => node.widgets?.find((widget) => widget.name === "label");

// 卡片上的大字：填了名字就显示名字，留空就退回「开 / 关」。
function labelText(node) {
  const custom = String(labelWidget(node)?.value ?? "").trim();
  if (custom) return custom;
  return Boolean(valueWidget(node)?.value) ? "开" : "关";
}

function usesVueNodes() {
  try {
    return app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled") === true;
  } catch {
    return false;
  }
}

function scaleOf(node) {
  const [w, h] = node.size ?? [BASE_WIDTH, NODE_HEIGHT];
  // 高度是固定的，所以缩放由高度定（再乘宽度那一项兜住极窄的情况），
  // 否则同一个开关拉宽一点字就跟着长大，一排并排时大小参差不齐。
  return Math.max(0.45, Math.min(h / BASE_HEIGHT, w / BASE_WIDTH));
}

// 宽度是唯一的把手，高度恒定 —— 拉宽只为了放得下长名字，不加厚。
function keepSize(node) {
  const width = Math.max(MIN_WIDTH, Math.round(node.size?.[0] ?? BASE_WIDTH));
  if (node.size?.[0] === width && node.size?.[1] === NODE_HEIGHT) return false;
  if (typeof node.setSize === "function") node.setSize([width, NODE_HEIGHT]);
  else node.size = [width, NODE_HEIGHT];
  return true;
}

function inResizeCorner(node, pos) {
  const width = node.size?.[0] ?? 0;
  const height = node.size?.[1] ?? 0;
  const nearX = pos[0] <= RESIZE_HANDLE || pos[0] >= width - RESIZE_HANDLE;
  const nearY = pos[1] <= RESIZE_HANDLE || pos[1] >= height - RESIZE_HANDLE;
  return nearX && nearY;
}

// 卡片的位置。有输出槽时顶上让出一行：槽名是 LiteGraph 原生画的（在
// onDrawForeground 之后），卡片压上去会跟它叠在一起。
function cardRect(node, s) {
  const [w, h] = node.size;
  const pad = PAD * s;
  // 🔴 让位量不能乘 s：槽名是 LiteGraph 原生画的，字号与节点缩放无关，
  //    永远占顶部那 ~20px。节点一扁（高度固定 58）再乘 0.69 就只剩 15px，
  //    卡片会切掉槽名的下半截。顶部只让 SLOT_ROW，不再叠 pad。
  const top = node.outputs?.length ? SLOT_ROW : pad;
  return {
    x: pad,
    y: top,
    w: w - pad * 2,
    h: Math.max(6 * s, h - top - pad),
  };
}

function pillRect(node, s) {
  const card = cardRect(node, s);
  const pw = PILL_W * s;
  const ph = PILL_H * s;
  return {
    x: card.x + card.w - PILL_RIGHT * s - pw,
    y: card.y + (card.h - ph) / 2,
    w: pw,
    h: ph,
  };
}

// 命中区比画出来的胶囊大一圈，鼠标不用瞄得那么准。
function hitPill(node, pos) {
  if (!pos) return false;
  if (inResizeCorner(node, pos)) return false;
  const box = pillRect(node, scaleOf(node));
  const slack = 10 * scaleOf(node);
  return (
    pos[0] >= box.x - slack &&
    pos[0] <= box.x + box.w + slack &&
    pos[1] >= box.y - slack &&
    pos[1] <= box.y + box.h + slack
  );
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

function drawCard(node, ctx) {
  const state = node.__qgBoolToggle;
  const on = Boolean(valueWidget(node)?.value);
  const s = scaleOf(node);
  ctx.save();
  // LiteGraph 画节点主体时留下的阴影会跟着后面的描边一起偏移，先清掉。
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  const card = cardRect(node, s);
  roundRect(ctx, card.x, card.y, card.w, card.h, CORNER * s);
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.strokeStyle = on ? "rgba(0,180,170,0.55)" : "rgba(255,255,255,0.10)";
  ctx.stroke();

  // 胶囊（先算，文字要按它左边的剩余宽度缩字号）
  const box = pillRect(node, s);

  // 大字：标签优先，留空回退「开 / 关」。名字长了就缩字号，别顶到胶囊上。
  const text = labelText(node);
  const leftX = card.x + LABEL_LEFT * s;
  const avail = Math.max(24 * s, box.x - 14 * s - leftX);
  let fontSize = LABEL_SIZE * s;
  ctx.font = `700 ${Math.round(fontSize)}px ${FONT}`;
  const measured = ctx.measureText(text).width;
  if (measured > avail) {
    fontSize = Math.max(11 * s, fontSize * (avail / measured));
    ctx.font = `700 ${Math.round(fontSize)}px ${FONT}`;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = on ? ON_LABEL : OFF_LABEL;
  const lineY = card.y + card.h / 2 + s;
  ctx.fillText(text, leftX, lineY);
  // 就地改名要用这块几何（节点局部坐标），见 openCanvasLabelEditor。
  // fontSize 是缩过之后的实际字号，输入框照着它摆才不会跳一下。
  if (state) state.textBox = { x: leftX, cy: lineY, w: avail, size: fontSize };

  // 胶囊
  roundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2);
  ctx.fillStyle = on ? ON_FILL : OFF_FILL;
  ctx.fill();
  if (state?.hover) {
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke();
  }

  // 圆钮
  const knobR = Math.max(2, box.h / 2 - 3.5 * s);
  const knobX = on ? box.x + box.w - box.h / 2 : box.x + box.h / 2;
  ctx.beginPath();
  ctx.arc(knobX, box.y + box.h / 2, knobR, 0, Math.PI * 2);
  ctx.fillStyle = KNOB;
  ctx.fill();
  ctx.restore();
}

function flip(node) {
  const widget = valueWidget(node);
  if (!widget) return;
  widget.value = !widget.value;
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  notifyQgChange();
}

// ------------------------------------------------------------ 标签就地编辑
//
// 标签控件是隐藏的（卡片把整块地方盖住了），所以名字得另外给一个入口：
// 双击卡片 / 右键菜单里选「重命名标签」。
//
// 不用居中弹窗 —— 改个名字先盖一层遮罩、再去找框在哪，太重了。改成
// **就地编辑**：框直接浮在卡片那几个大字上面，大小跟字一样，回车 / 失焦
// 生效，Esc 放弃。跟孤海布尔节点双击标签同一个手感。
//
// 🔴 坐标换算：节点局部 → 世界是 `node.pos + local`，世界 → 画布像素是
//    `(world + offset) * scale`（不是 `world * scale + offset`），画布像素 → 视口
//    还要加 canvas 自己的 getBoundingClientRect()。一律走 convertOffsetToCanvas
//    + rect，见 web/number/index.js 的 gearAnchor。

const EDITOR_CLASS = "qgtools-bool-toggle-edit";

// 同一时刻只留一个编辑框（换节点双击、右键菜单重复触发都要先关掉旧的）。
let openEditor = null;

function closeLabelEditor() {
  openEditor?.remove();
  openEditor = null;
}

function canvasToScreen(node, lx, ly) {
  const canvas = app.canvas;
  const ds = canvas?.ds;
  const world = [node.pos[0] + lx, node.pos[1] + ly];
  let point;
  if (ds?.convertOffsetToCanvas) {
    point = ds.convertOffsetToCanvas([world[0], world[1]]);
  } else {
    const scale = ds?.scale ?? 1;
    const offset = ds?.offset ?? [0, 0];
    point = [(world[0] + offset[0]) * scale, (world[1] + offset[1]) * scale];
  }
  const box = canvas?.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  return [box.left + point[0], box.top + point[1]];
}

function commitLabel(node, next) {
  const widget = labelWidget(node);
  if (!widget) return;
  const value = String(next ?? "").trim();
  if (value === String(widget.value ?? "").trim()) return;
  widget.value = value;
  widget.callback?.(value);
  node.__qgBoolToggle?.render?.();
  node.setDirtyCanvas?.(true, true);
  notifyQgChange();
}

// 编辑框的按键口径，canvas / dom 两种模式共用。
// 🔴 中文输入法选词时的回车（isComposing / keyCode 229）不能当提交。
function wireEditorKeys(input, commit, cancel) {
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  });
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.placeholder = zh("Leave empty to show on / off");
  input.spellcheck = false;
  input.type = "text";
}

function openCanvasLabelEditor(node, state) {
  const widget = labelWidget(node);
  if (!widget) return;
  // textBox 是上一次绘制记下的；万一还没画过（刚建好就双击），按卡片几何兜一份。
  let box = state?.textBox;
  if (!box) {
    const s = scaleOf(node);
    const card = cardRect(node, s);
    const pill = pillRect(node, s);
    const x = card.x + LABEL_LEFT * s;
    box = {
      x,
      cy: card.y + card.h / 2 + s,
      w: Math.max(24 * s, pill.x - 14 * s - x),
      size: LABEL_SIZE * s,
    };
  }
  ensureCss();
  closeLabelEditor();

  const input = document.createElement("input");
  input.className = EDITOR_CLASS;
  input.value = String(widget.value ?? "");
  document.body.append(input);
  openEditor = input;

  let frame = 0;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    // 🔴 先清 openEditor 再 remove：remove() 会同步触发 blur，
    //    顺序反了 blur 会把它当成「移开焦点」而提交（Esc 取消不掉）。
    if (openEditor === input) openEditor = null;
    input.remove();
  };
  const commit = () => {
    const next = input.value;
    close();
    commitLabel(node, next);
  };

  // 框跟着卡片走：编辑期间滚轮缩放、拖画布、拖节点都要对得上，所以每帧重算。
  const place = () => {
    const scale = app.canvas?.ds?.scale ?? 1;
    const live = state.textBox ?? box;
    const [cx, cy] = canvasToScreen(node, live.x, live.cy);
    const fontPx = Math.max(11, live.size * scale);
    // 高度按字号算：1.4 倍刚好一行字加一点边，再高就显得比大字厚一截。
    const height = Math.round(fontPx * 1.4);
    const pad = Math.round(fontPx * 0.2);
    input.style.font = `700 ${fontPx.toFixed(1)}px ${FONT}`;
    input.style.height = `${height}px`;
    input.style.lineHeight = `${height}px`;
    input.style.padding = `0 ${pad}px`;
    input.style.left = `${Math.round(cx - pad)}px`;
    input.style.top = `${Math.round(cy - height / 2)}px`;
    input.style.width = `${Math.round(Math.max(90, live.w * scale + pad * 2))}px`;
  };
  place();

  const tick = () => {
    if (done) return;
    // 节点被折叠 / 被删，编辑框就没地方待了。
    if (!node.__qgBoolToggle || node.flags?.collapsed) {
      close();
      return;
    }
    place();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  wireEditorKeys(input, commit, close);
  input.addEventListener("blur", () => {
    // 已经关掉（Esc / 又开了一个）就不再提交
    if (!done && openEditor === input) commit();
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// Nodes 2.0 下标签是真实 DOM，直接照孤海那套：把 span 换成 input，改完换回来。
function openDomLabelEditor(node, state) {
  const widget = labelWidget(node);
  const label = state?.labelEl;
  if (!widget || !label || !label.isConnected) return;
  ensureCss();
  closeLabelEditor();

  const input = document.createElement("input");
  input.className = `${EDITOR_CLASS} qgtools-bool-toggle-inline`;
  input.value = String(widget.value ?? "");

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    input.replaceWith(label);
  };
  const commit = () => {
    const next = input.value;
    close();
    commitLabel(node, next);
  };
  wireEditorKeys(input, commit, close);
  // 输入框在 <button> 里：点它一下会冒泡成 button 的 click → 顺手把开关也翻了。
  // 改文字的时候开关自己跳一下，太像 bug，两头都拦住。
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  // 同上：replaceWith 会同步触发 blur，Esc 关掉的那一次不能算提交。
  input.addEventListener("blur", () => {
    if (!done) commit();
  });

  label.replaceWith(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function openLabelEditor(node) {
  const state = node.__qgBoolToggle;
  if (!state) return;
  if (state.mode === "dom") openDomLabelEditor(node, state);
  else openCanvasLabelEditor(node, state);
}

function installMenu(node) {
  if (node.__qgBoolMenu) return;
  node.__qgBoolMenu = true;
  chainCallback(node, "getExtraMenuOptions", function (_canvas, options) {
    if (!Array.isArray(options)) return;
    const on = Boolean(valueWidget(this)?.value);
    options.unshift(
      {
        content: on ? zh("Turn off") : zh("Turn on"),
        callback: () => flip(this),
      },
      {
        content: zh("Rename label..."),
        callback: () => openLabelEditor(this),
      },
      null,
    );
  });
}

// ---------------------------------------------------------------- 经典画布

function installCanvas(node) {
  if (node.__qgBoolToggle) return node.__qgBoolToggle;
  const widget = valueWidget(node);
  if (!widget) return null;
  hideWidget(widget);
  hideWidget(labelWidget(node));
  installCanvasHooks(node);

  const state = (node.__qgBoolToggle = { node, mode: "canvas", hover: false });

  node.resizable = true;
  // computeSize 是「拖拽能到达的最小尺寸」，不能回声当前尺寸，否则拉不大。
  // 原来那个（多半是原型上的）存一份：切回 Nodes 2.0 时要还回去，
  // 否则 DOM 卡片那条路永远被这个常量尺寸压着。
  node.__qgOrigComputeSize ??= node.computeSize;
  node.computeSize = () => [MIN_WIDTH, NODE_HEIGHT];
  node.size = [BASE_WIDTH, NODE_HEIGHT];
  return state;
}

// 🔴 画布钩子一辈子只装一次。
//    chainCallback 是链式包装、摘不掉，而切渲染模式会反复走 install/uninstall。
//    每切一次就再包一层的话，onMouseDown 里 flip 会跑两遍（翻过去又翻回来，
//    看着像「点了没反应」），onDrawForeground 也会把卡片画两遍。
//    所以钩子只跟「节点」挂钩，装完靠 canvasMode() 短路来决定听不听。
function installCanvasHooks(node) {
  if (node.__qgCanvasHooks) return;
  node.__qgCanvasHooks = true;

  // 切到 Nodes 2.0 之后这些钩子还在，必须自己让路：不短路的话
  // onDrawForeground 会继续在 Vue 节点上画一张旧卡片（跟 DOM 卡片叠在一起），
  // onMouseDown 也会继续吃掉点击。
  const canvasMode = (n) => n.__qgBoolToggle?.mode === "canvas";

  chainCallback(node, "onResize", function () {
    if (!canvasMode(this)) return;
    keepSize(this);
  });

  chainCallback(node, "onDrawForeground", function (ctx) {
    if (!canvasMode(this) || this.flags?.collapsed) return;
    // 拖拽时 LiteGraph 直接写 size，onResize 很少回调 —— 顺手按回去。
    if (keepSize(this)) this.setDirtyCanvas?.(true, false);
    drawCard(this, ctx);
  });

  chainCallback(node, "onMouseDown", function (event, pos) {
    if (!canvasMode(this) || !hitPill(this, pos)) return;
    flip(this);
    return true; // 吃掉这一下，别让它变成拖节点
  });

  // hover 状态放在「当前的」state 上：钩子只有一份，state 会随模式重建，
  // 所以不能闭包捕获 —— 每次现取 this.__qgBoolToggle。
  chainCallback(node, "onMouseMove", function (event, pos) {
    const state = canvasMode(this) ? this.__qgBoolToggle : null;
    if (!state) return;
    const hover = hitPill(this, pos);
    if (hover !== state.hover) {
      state.hover = hover;
      this.setDirtyCanvas?.(true, false);
    }
  });

  chainCallback(node, "onMouseLeave", function () {
    const state = canvasMode(this) ? this.__qgBoolToggle : null;
    if (!state || !state.hover) return;
    state.hover = false;
    this.setDirtyCanvas?.(true, false);
  });

  // 双击卡片改标签。返回 true 把这一下吃掉，否则 LiteGraph 会去改节点标题。
  chainCallback(node, "onDblClick", function (event, pos) {
    if (!canvasMode(this)) return;
    if (!pos || pos[0] < 0 || pos[0] > (this.size?.[0] ?? 0)) return;
    openLabelEditor(this);
    return true;
  });
}

// ---------------------------------------------------------- Nodes 2.0 回退

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
/* 卡片固定一行高（DOM_ROW_H），节点被拖高时不跟着拉长 —— 否则整块糊成一个大黑方块、
   胶囊孤零零飘在正中。root 必须 flex:none：上游 WidgetDOM 的包装 div 带 *:flex-1，
   不写就会被拉伸。高度交给上游（内容区自带 pt-1/pb-3），不做负 margin 补偿。 */
.qgtools-bool-toggle{box-sizing:border-box;flex:none;width:100%;height:auto;padding:2px;margin:0;}
.qgtools-bool-toggle button{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;height:${DOM_ROW_H}px;padding:0 16px 0 22px;border:1px solid rgba(255,255,255,.10);border-radius:${DOM_CORNER}px;background:rgba(0,0,0,.30);color:${OFF_LABEL};font:700 ${DOM_LABEL}px/1 ${FONT.replace(/"/g, "'")};cursor:pointer;user-select:none;}
.qgtools-bool-toggle button.on{border-color:rgba(0,180,170,.55);color:${ON_LABEL};}
/* margin-left:auto：编辑时 label 被换成绝对定位的输入框，button 只剩胶囊一个
   子元素，space-between 会让它靠左 —— 正好被输入框盖住。auto 把它推回右边。
   胶囊尺寸写死成固定像素（高度不跟节点走）。 */
.qgtools-bool-toggle .pill{position:relative;flex:none;margin-left:auto;width:${DOM_PILL_W}px;height:${DOM_PILL_H}px;border-radius:${DOM_PILL_H / 2}px;background:${OFF_FILL};transition:background .16s ease;}
.qgtools-bool-toggle button.on .pill{background:${ON_FILL};}
.qgtools-bool-toggle .pill::after{content:"";position:absolute;top:${DOM_KNOB_GAP}px;left:${DOM_KNOB_GAP}px;width:${DOM_KNOB}px;height:${DOM_KNOB}px;border-radius:50%;background:${KNOB};transition:left .16s ease;}
.qgtools-bool-toggle button.on .pill::after{left:${DOM_PILL_W - DOM_KNOB - DOM_KNOB_GAP}px;}
.qgtools-bool-toggle-edit{position:fixed;z-index:10000;box-sizing:border-box;border:1px solid rgba(0,180,170,.85);border-radius:6px;background:rgba(6,20,19,.92);color:#eef7f6;outline:none;text-align:left;box-shadow:0 6px 22px rgba(0,0,0,.55);}
.qgtools-bool-toggle-edit::placeholder{color:rgba(255,255,255,.32);font-size:.62em;font-weight:400;}
/* 全选底色跟着品牌色走 —— 默认的系统蓝盖住整块字，太扎眼 */
.qgtools-bool-toggle-edit::selection{background:rgba(0,180,170,.38);color:#fff;}
/* 就地编辑框：绝对定位盖在名字那一块上（left 对齐文字起点、right 让开胶囊）。
   以前是 flex 里的普通子元素，输入框的固有高度会把这一行撑高 → 一进编辑态
   整个节点长高 15px，Esc 又缩回去。改成 absolute 后完全脱离布局，
   节点高度一点都不动；height:calc(100% + 4px) 让框比胶囊略高，靠 root 的
   2px 内边距吃掉溢出，看着还是原来那个饱满的框。 */
.qgtools-bool-toggle-inline{position:absolute;left:22px;right:67px;top:50%;height:calc(100% + 4px);transform:translateY(-50%);box-sizing:border-box;min-width:0;padding:0 10px;border-radius:7px;background:rgba(6,20,19,.94);color:#eef7f6;font:inherit;line-height:1;outline:none;box-shadow:none;text-align:left;}
`;
  document.head.appendChild(style);
}

function installDom(node) {
  if (node.__qgBoolToggle) return node.__qgBoolToggle;
  const widget = valueWidget(node);
  if (!widget) return null;
  hideWidget(widget);
  hideWidget(labelWidget(node));
  ensureCss();

  const root = document.createElement("div");
  root.className = "qgtools-bool-toggle";
  const button = document.createElement("button");
  button.type = "button";
  const label = document.createElement("span");
  label.className = "label";
  const pill = document.createElement("span");
  pill.className = "pill";
  button.append(label, pill);
  root.append(button);

  const state = (node.__qgBoolToggle = {
    node, mode: "dom", labelEl: label, root,
    render: () => {
      const on = Boolean(valueWidget(node)?.value);
      label.textContent = labelText(node);
      button.classList.toggle("on", on);
      button.title = on ? zh("Currently on, click to turn off") : zh("Currently off, click to turn on");
      label.title = zh("Double-click to rename the label");
    },
  });
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", () => {
    flip(node);
    state.render();
  });
  // 双击名字改标签 —— 跟经典模式（卡片上 onDblClick）保持一致。
  // 以前是单击就进编辑态，手一抖点到名字就进编辑框，太容易误触。
  // ⚠️ 判次数用 click 的 event.detail，别挂 dblclick：label 在 <button> 里，
  //    浏览器会把这一串算成两次 click（第一次已被 stopPropagation 拦住，不会切开关）。
  label.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.detail >= 2) openLabelEditor(node);
  });
  state.render();

  const domWidget = node.addDOMWidget(WIDGET_NAME, "qg_bool_toggle", root, {
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => NODE_HEIGHT,
  });
  keepDomWidgetWidthAuto(domWidget);
  domWidget.serialize = false;
  // uninstall 要用它把 DOM 一并摘掉（只 splice node.widgets 会留下包装层）
  state.widget = domWidget;
  domWidget.computeSize = (width) => [
    Math.max(MIN_WIDTH, Number(width || node.size?.[0] || BASE_WIDTH)),
    NODE_HEIGHT,
  ];
  domWidget.options.minNodeSize = [MIN_WIDTH, NODE_HEIGHT];
  holdNodeMinWidth(domWidget, MIN_WIDTH);
  return state;
}

function install(node) {
  const state = usesVueNodes() ? installDom(node) : installCanvas(node);
  if (state) {
    ensureCss();
    installMenu(node);
    // installModeWatcher 的迁移入口（切渲染模式时就地换卡片）
    node.__qgSyncMode = () => syncBoolMode(node);
  }
  return state;
}

// ---------------------------------------------------------------- 渲染模式迁移
//
// install 只在新建 / 读档时按当时模式装一次。切渲染模式（不重载图）时
// usesVueNodes() 变了，卡片不会跟着换 —— 表现是「切到 Nodes 2.0 之后还印着
// canvas 画的旧卡片」或者「切回经典后残留一块 DOM」。所以给每个节点挂
// __qgSyncMode，由 installModeWatcher 在切模式后调它就地迁移。
function uninstall(node) {
  const state = node.__qgBoolToggle;
  if (!state) return;
  node.__qgBoolToggle = null;
  if (state.mode === "dom") {
    detachDomWidget(node, state.widget, state.root);
    state.widget = null;
    state.root = null;
  }
  // canvas 模式的钩子摘不掉（见 installCanvas 里的短路说明），这里只把被它
  // 改过的实例字段还回去 —— computeSize 一旦常量化，DOM 卡片那条路就长不开了。
  if (node.__qgOrigComputeSize) node.computeSize = node.__qgOrigComputeSize;
}

function syncBoolMode(node) {
  const want = usesVueNodes() ? "dom" : "canvas";
  if (node.__qgBoolToggle?.mode !== want) {
    uninstall(node);
    install(node);
  }
  return node.__qgBoolToggle;
}

app.registerExtension({
  name: "QG.BoolToggle",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    // 开关自己就是源头，别在左边留一个输入点。
    hideInputsInDef(nodeData, ["boolean"]);

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      install(this);
    });

    chainCallback(nodeType.prototype, "onConfigure", function () {
      // 存档里的尺寸 / 值都在 onNodeCreated 之后才落地。
      queueMicrotask(() => {
        // syncBoolMode 而不是 install：读档时渲染模式可能跟建节点那一刻不同
        // （同一个工作流在两种模式下打开过），顺手校正到当前模式。
        const state = syncBoolMode(this);
        if (!state) return;
        if (state.mode === "canvas") keepSize(this);
        else state.render?.();
        this.setDirtyCanvas?.(true, true);
      });
    });

    chainCallback(nodeType.prototype, "onRemoved", function () {
      // 走 uninstall 而不是直接把 state 置空：DOM 分支的徽章上浮是 800ms
      // 轮询，不清定时器的话节点删了它还在跑。
      uninstall(this);
      this.__qgBoolToggle = null;
    });
  },

  async setup() {
    // 切模式前先收掉可能开着的标签编辑框：它是 position:fixed、按旧模式的
    // 定位基准摆的，切完必然错位。
    onRenderModeSwitch(() => { try { closeLabelEditor(); } catch { /* 忽略 */ } });
    installModeWatcher((node) => {
      if (String(node?.comfyClass ?? node?.type ?? "") !== NODE_CLASS) return null;
      if (typeof node.__qgSyncMode !== "function") {
        node.__qgSyncMode = () => syncBoolMode(node);
      }
      return node.__qgSyncMode;
    });
  },
});

console.log("[QG-tools] bool toggle front end ready");
