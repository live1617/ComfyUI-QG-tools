/**
 * QG 种子 — 一张卡片管住一个种子（前端）
 *
 * 界面与交互移植自 ComfyUI-AusBoss（MIT，js/seed/index.js），节点 ID 仍是
 * QG_Seed：老工作流里用「三个按钮」那版的节点，打开后自动换成这张卡片，
 * 连线不用重接。
 *
 * 卡片盖在两个隐藏但仍存在的控件上：
 *   seed（INT）+ control_after_generate（ComfyUI 给名为 seed 的 INT 自动附加）——
 * 所以存档、撤销、API 格式都不变。分段按钮（随机值 / 固定 / Step）只去写那个
 * 隐藏控件，队列之后的抽值交给 ComfyUI 自己的「生成后控制」逻辑。
 *
 * 后端每次运行会把实际用的种子通过 ui.seed 回传：随机值模式下框里已经是
 * 下一枚种子了，底部「上次运行」和「用上次」读的是回传值，才准。
 */

import { app } from "/scripts/app.js";
import {
  BRAND,
  chainCallback,
  keepDomWidgetWidthAuto,
  notifyQgChange,
} from "../shared/index.mjs?v=2026102420";
import { keepKeyInField } from "../shared/canvas_passthrough.mjs?v=2026102420";
import { copyToClipboard } from "../shared/clipboard.mjs?v=2026102420";
import { hideInputsInDef, hideWidget } from "../shared/widget_visibility.mjs?v=2026102420";
import { holdNodeMinWidth, pinVuePanelHeight } from "../shared/panel_layout.mjs?v=2026102420";
import { fitNodeToPanelHeight, unwatchVueShell, watchVueShell } from "../shared/vue_panel_fit.mjs?v=2026102420";
import { formatSeed, pushSeed, seedFromExecuted } from "../shared/seed_history.mjs?v=2026102420";

const NODE_CLASS = "QG_Seed";
const CSS_ID = "qgtools-seed-css";
const WIDGET_NAME = "qgtools_seed_panel";
const PROPERTY = "qg_seed_history"; // [seed, 最新的在最前]
// ComfyUI 自己的随机上限压在 2^50 以内（double 精确整数边界），这里跟着来。
const ROLL_MAX = 0x4000000000000;
const CARD_HEIGHT = 158;
const PANEL_DECLARED_HEIGHT = CARD_HEIGHT + 20; // + 前端套在 DOM 控件外面的内边距
const NODE_WIDTH = 300;

const COPY_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 12.5 9.5 18 20 6.5"/></svg>';

let openMenu = null;

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-seed{box-sizing:border-box;width:100%;height:100%;padding:0 6px 6px;pointer-events:none;overflow:hidden;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#c8dddd;}
.qgtools-seed *{box-sizing:border-box;}
.qgtools-seed-card{display:flex;flex-direction:column;gap:7px;height:100%;padding:8px;overflow:hidden;border:1px solid rgba(0,180,170,.22);border-radius:8px;background:rgba(0,0,0,.28);}
.qgtools-seed-field{display:flex;align-items:center;gap:6px;height:38px;padding:0 6px 0 12px;border:1px solid #2a3437;border-radius:7px;background:#0b0f10;pointer-events:auto;}
.qgtools-seed-field:focus-within{border-color:${BRAND};}
.qgtools-seed-field.linked{opacity:.55;}
.qgtools-seed-field input{flex:1 1 auto;min-width:0;height:100%;border:none;outline:none;background:transparent;color:#eef7f6;font:600 17px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.01em;}
.qgtools-seed-field input:disabled{color:#8ba3a1;}
.qgtools-seed-tag{flex:none;color:#5f7674;font-size:9.5px;letter-spacing:.12em;}
.qgtools-seed-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid transparent;border-radius:5px;background:transparent;color:#8ba3a1;cursor:pointer;pointer-events:auto;}
.qgtools-seed-icon:hover{border-color:#3a4a4d;background:#1a2224;color:#fff;}
.qgtools-seed-seg{display:grid;grid-template-columns:1fr 1fr 1fr;height:30px;padding:3px;border:1px solid #2a3437;border-radius:7px;background:#0f1516;pointer-events:auto;}
.qgtools-seed-seg button{border:none;border-radius:5px;background:transparent;color:#8ba3a1;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;}
.qgtools-seed-seg button:hover{color:#fff;}
.qgtools-seed-seg button.on{background:${BRAND};color:#04201d;}
.qgtools-seed-row{display:grid;grid-template-columns:1fr 1fr 30px;gap:6px;height:32px;}
.qgtools-seed-btn{height:100%;border:1px solid #2a3437;border-radius:7px;background:#16201f;color:#d8ecea;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;pointer-events:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qgtools-seed-btn:hover{border-color:${BRAND};color:#fff;}
.qgtools-seed-btn:disabled{opacity:.4;cursor:default;pointer-events:none;}
.qgtools-seed-hint{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#6f8886;font-size:10.5px;text-align:center;}
.qgtools-seed-hint b{color:#9fe3dc;font-weight:600;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
.qgtools-seed-menu{position:fixed;z-index:10000;min-width:230px;padding:4px;border:1px solid #3a4047;border-radius:7px;background:#1c1f23;box-shadow:0 8px 28px rgba(0,0,0,.5);font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d7dde2;}
.qgtools-seed-menu-head{padding:5px 8px 6px;border-bottom:1px solid #2c3238;color:#78908e;font:10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;letter-spacing:.08em;}
.qgtools-seed-menu-item{display:block;width:100%;padding:6px 8px;border:none;border-radius:5px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}
.qgtools-seed-menu-item:hover{background:#2c3238;color:#fff;}
.qgtools-seed-menu-item.current{color:${BRAND};}
`;
  document.head.appendChild(style);
}

function closeMenu() {
  if (!openMenu) return;
  openMenu.abort.abort();
  openMenu.element.remove();
  openMenu = null;
}

function history(node) {
  const stored = node.properties?.[PROPERTY];
  return Array.isArray(stored) ? stored : [];
}

function seedWidget(node) {
  return node.widgets?.find((widget) => widget.name === "seed");
}

// ComfyUI 把「生成后控制」挂成 seed 的联动控件（linkedWidgets），老前端则是
// 一个独立控件；两种都认，拿不到就不动它。
function controlWidget(node) {
  const seed = seedWidget(node);
  const linked = seed?.linkedWidgets?.find?.((widget) => Array.isArray(widget.options?.values));
  return linked ?? node.widgets?.find((widget) => widget.name === "control_after_generate");
}

function seedLinked(node) {
  return Boolean(node.inputs?.some((input) => input?.name === "seed" && input.link != null));
}

function setControl(node, value) {
  const control = controlWidget(node);
  if (!control || !Array.isArray(control.options?.values)) return;
  if (!control.options.values.includes(value)) return;
  control.value = value;
  control.callback?.(value);
}

function setSeed(node, seed, { pin = true } = {}) {
  const widget = seedWidget(node);
  if (!widget) return;
  widget.value = seed;
  widget.callback?.(seed);
  if (pin) setControl(node, "fixed");
  node.setDirtyCanvas?.(true, true);
  notifyQgChange();
}

function rollSeed() {
  return Math.floor(Math.random() * ROLL_MAX);
}

function render(state) {
  const { node } = state;
  const seeds = history(node);
  const last = seeds[0];
  const control = controlWidget(node)?.value ?? "fixed";
  const linked = seedLinked(node);
  const value = seedWidget(node)?.value;
  if (document.activeElement !== state.input) state.input.value = formatSeed(Number(value));
  state.input.disabled = linked;
  state.field.classList.toggle("linked", linked);
  state.field.title = linked ? "种子来自输入连线" : "点一下直接输入种子";
  const stepping = control === "increment" || control === "decrement";
  state.tag.textContent = control === "randomize" ? "下一枚"
    : control === "fixed" ? "种子"
      : control === "decrement" ? "递减" : "递增";
  state.segRandom.classList.toggle("on", control === "randomize");
  state.segFixed.classList.toggle("on", control === "fixed");
  state.segStep.classList.toggle("on", stepping);
  state.segStep.textContent = control === "decrement" ? "Step −1" : "Step +1";
  state.segStep.title = stepping
    ? "再点一下换方向（递增 / 递减）"
    : "每次排队之后种子 +1（再点一下换 -1）";
  state.useLast.disabled = !seeds.length;
  state.more.disabled = seeds.length < 2;
  state.hint.textContent = "";
  if (seeds.length) {
    state.hint.append("上次运行 ");
    const b = document.createElement("b");
    b.textContent = formatSeed(last);
    state.hint.append(b);
    if (control === "randomize") state.hint.append(" · 每次排队重新抽一个");
  } else {
    state.hint.textContent = control === "randomize"
      ? "每次排队重新抽一个种子"
      : control === "fixed" ? "每次都跑这一个种子" : "每次排队后自动 ±1";
  }
}

function showMenu(state) {
  closeMenu();
  const seeds = history(state.node);
  if (!seeds.length) return;
  const menu = document.createElement("div");
  menu.className = "qgtools-seed-menu";
  const head = document.createElement("div");
  head.className = "qgtools-seed-menu-head";
  head.textContent = "这个节点跑过的种子";
  menu.append(head);
  const current = seedWidget(state.node)?.value;
  for (const seed of seeds) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "qgtools-seed-menu-item";
    if (seed === current) item.classList.add("current");
    item.textContent = formatSeed(seed);
    item.title = "填回这个种子并固定";
    item.addEventListener("click", () => {
      setSeed(state.node, seed);
      render(state);
      closeMenu();
    });
    menu.append(item);
  }
  document.body.append(menu);
  const anchor = state.more.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  const left = Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8);
  let top = anchor.bottom + 4;
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, anchor.top - rect.height - 4);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  const abort = new AbortController();
  document.addEventListener(
    "pointerdown",
    (event) => { if (!menu.contains(event.target)) closeMenu(); },
    { capture: true, signal: abort.signal },
  );
  window.addEventListener(
    "keydown",
    (event) => { if (event.key === "Escape") { event.stopPropagation(); closeMenu(); } },
    { capture: true, signal: abort.signal },
  );
  openMenu = { element: menu, abort };
}

async function copySeed(state) {
  const value = seedWidget(state.node)?.value;
  const copied = await copyToClipboard(formatSeed(Number(value)));
  // 被浏览器拦下就如实显示 ✕ —— 数字还在框里，手抄也能抄。
  state.copy.innerHTML = copied ? CHECK_SVG : "✕";
  state.copy.title = copied ? "已复制" : "复制失败";
  setTimeout(() => {
    state.copy.innerHTML = COPY_SVG;
    state.copy.title = "复制种子";
  }, copied ? 700 : 1400);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, title) {
  const b = el("button", className, text);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("pointerdown", (event) => event.stopPropagation());
  return b;
}

// v0.8.4 及更早用的是哨兵值（-1 随机 / -2 递增 / -3 递减），这个模型已经没有
// 负数的位置了，加载老工作流时把它们翻译成「模式 + 一个具体种子」。
function migrateLegacy(node, savedValues) {
  const widget = seedWidget(node);
  if (!widget) return;
  const value = Number(widget.value);
  const savedMode = Array.isArray(savedValues) && typeof savedValues[1] === "string"
    ? savedValues[1] : null;
  if (Number.isFinite(value) && value < 0) {
    const mode = value === -2 ? "increment" : value === -3 ? "decrement" : "randomize";
    widget.value = rollSeed();
    setControl(node, mode);
    return;
  }
  // 老存档只存了一个种子、没有模式：当固定处理，否则会被默认的「随机」抽走。
  if (!savedMode) setControl(node, "fixed");
  if (!Number.isFinite(value) || value < 0) widget.value = 0;
}

function buildPanel(node) {
  if (node.__qgSeedPanel) return node.__qgSeedPanel;
  const seed = seedWidget(node);
  if (!seed) return null;
  ensureCss();
  const control = controlWidget(node);
  hideWidget(seed);
  if (control) hideWidget(control);

  const root = el("div", "qgtools-seed");
  const card = el("div", "qgtools-seed-card");

  const field = el("div", "qgtools-seed-field");
  const tag = el("span", "qgtools-seed-tag", "种子");
  const input = el("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.spellcheck = false;
  const copy = el("button", "qgtools-seed-icon");
  copy.type = "button";
  copy.innerHTML = COPY_SVG;
  copy.title = "复制种子";
  copy.setAttribute("aria-label", "复制种子");
  field.append(tag, input, copy);
  field.addEventListener("pointerdown", (event) => event.stopPropagation());

  const seg = el("div", "qgtools-seed-seg");
  const segRandom = button("", "随机值", "每次排队之后重新抽一个种子");
  const segFixed = button("", "固定", "每次排队都用这一个种子");
  const segStep = button("", "Step +1", "每次排队之后种子 +1");
  seg.append(segRandom, segFixed, segStep);

  const row = el("div", "qgtools-seed-row");
  const newSeed = button("qgtools-seed-btn", "新种子", "抽一个新种子并固定");
  const useLast = button("qgtools-seed-btn", "用上次", "把上次运行的种子填回并固定");
  const more = button("qgtools-seed-btn", "▾", "之前跑过的种子");
  row.append(newSeed, useLast, more);

  const hint = el("div", "qgtools-seed-hint");
  card.append(field, seg, row, hint);
  root.append(card);

  const state = (node.__qgSeedPanel = {
    node, root, card, field, tag, input, copy, segRandom, segFixed, segStep, newSeed, useLast, more, hint,
  });

  const commitTyped = () => {
    const text = input.value.trim().replace(/[\s,_]/g, "");
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      if (Number.isFinite(number) && number >= 0 && number !== seed.value) setSeed(node, number, { pin: false });
    }
    render(state);
  };
  input.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") { input.value = formatSeed(Number(seed.value)); input.blur(); }
  });
  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", commitTyped);
  copy.addEventListener("click", () => copySeed(state));

  // 模式只影响「下次排队之后」，光切换不改当前值，下一次排队还是同一个种子、
  // ComfyUI 会直接吃缓存。所以切到随机值就当场抽一枚，从固定切到 Step 就当场
  // 先走一步 —— 下一次排队一定是一次新运行。
  segRandom.addEventListener("click", () => {
    const wasRandom = controlWidget(node)?.value === "randomize";
    setControl(node, "randomize");
    if (!wasRandom && !seedLinked(node)) setSeed(node, rollSeed(), { pin: false });
    render(state);
    notifyQgChange();
  });
  segFixed.addEventListener("click", () => {
    setControl(node, "fixed");
    render(state);
    notifyQgChange();
  });
  segStep.addEventListener("click", () => {
    const current = controlWidget(node)?.value;
    const next = current === "increment" ? "decrement" : "increment";
    setControl(node, next);
    if (current === "fixed" && !seedLinked(node)) {
      const value = Number(seed.value) || 0;
      setSeed(node, next === "increment" ? value + 1 : Math.max(0, value - 1), { pin: false });
    }
    render(state);
    notifyQgChange();
  });
  newSeed.addEventListener("click", () => { setSeed(node, rollSeed()); render(state); });
  useLast.addEventListener("click", () => {
    const seeds = history(node);
    if (seeds.length) { setSeed(node, seeds[0]); render(state); }
  });
  more.addEventListener("click", () => (openMenu ? closeMenu() : showMenu(state)));

  // 隐藏控件的值在排队之后会被 ComfyUI 改写；顺着它的 callback 立即重画，
  // 不用等下一次重绘。
  chainCallback(seed, "callback", () => render(state));
  if (control) chainCallback(control, "callback", () => render(state));

  const widget = node.addDOMWidget(WIDGET_NAME, "qgtools_seed", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => PANEL_DECLARED_HEIGHT,
  });
  keepDomWidgetWidthAuto(widget);
  // 面板值本来就不进工作流（隐藏的 seed 控件才是真身），这里再关一次序列化，
  // 免得前端按位置把面板值也存进去。
  widget.serialize = false;
  widget.computeSize = (width) => [
    Math.max(NODE_WIDTH, Number(width || node.size?.[0] || NODE_WIDTH)),
    PANEL_DECLARED_HEIGHT,
  ];
  // 固定高度的卡片：Nodes 2.0 里也钉住，别让节点被拉出卡片外的空白。
  pinVuePanelHeight(widget);
  widget.options.minNodeSize = [NODE_WIDTH, 120];
  holdNodeMinWidth(widget, NODE_WIDTH);

  render(state);
  node.setSize?.([
    Math.max(node.size?.[0] ?? 0, NODE_WIDTH),
    node.computeSize?.()[1] ?? node.size?.[1],
  ]);
  // Nodes 2.0：卡片固定高、压不动，而 Vue 的空外壳会加槽行与内边距，外壳比
  // size[1] + 30 高一点（实测 5px）。让 size 跟上外壳，画布几何才对得上。
  watchVueShell(node, () => node.__qgSeedPanel?.root,
    () => fitNodeToPanelHeight(node, node.__qgSeedPanel?.root, (node.__qgSeedPanel.vueFit ??= {})));

  // 卡片高度固定：拖角落把节点拉高只会在卡片下面开一块死区，所以下一帧就
  // 把高度按回天然高度（LiteGraph 拖拽时直接写 size，很少回调 onResize）。
  chainCallback(node, "onDrawForeground", function () {
    if (this.flags?.collapsed) return;
    const natural = this.computeSize?.()[1];
    if (natural && this.size[1] !== natural) {
      this.setSize?.([this.size[0], natural]);
      this.setDirtyCanvas?.(true, false);
    }
  });
  return state;
}

app.registerExtension({
  name: "QG.Seed",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    // seed 是卡片自己管的，别在节点左边留一个输入点（也能防止别人把种子
    // 从外面接进来又把卡片绕过去）。
    hideInputsInDef(nodeData, ["seed"]);

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      const state = buildPanel(this);
      // 新节点默认就是「随机值」：第一枚种子当场抽掉，否则第一次排队会跑 0 号
      // 种子（ComfyUI 的生成后控制是在排队「之后」才改值的）。加载工作流时
      // 紧接着的 onConfigure 会用存档值覆盖，不受影响。
      const seed = seedWidget(this);
      if (state && seed && controlWidget(this)?.value === "randomize") {
        seed.value = rollSeed();
        render(state);
      }
    });

    chainCallback(nodeType.prototype, "onConfigure", function (config) {
      const saved = Array.isArray(config?.widgets_values) ? config.widgets_values : [];
      queueMicrotask(() => {
        const state = buildPanel(this);
        if (!state) return;
        migrateLegacy(this, saved);
        render(state);
      });
    });

    chainCallback(nodeType.prototype, "onConnectionsChange", function () {
      const state = this.__qgSeedPanel;
      if (state) requestAnimationFrame(() => render(state));
    });

    chainCallback(nodeType.prototype, "onExecuted", function (message) {
      const state = buildPanel(this);
      const seed = seedFromExecuted(message);
      if (!state || seed === null) return;
      this.properties ??= {};
      this.properties[PROPERTY] = pushSeed(history(this), seed);
      render(state);
    });

    chainCallback(nodeType.prototype, "onRemoved", function () {
      closeMenu();
      unwatchVueShell(this);
      this.__qgSeedPanel = null;
    });
  },
});

console.log("[QG-tools] seed front end ready");
