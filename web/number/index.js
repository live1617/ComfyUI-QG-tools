// QG 数值 —— 一张卡片 + 一个数字 + 右上角齿轮（前端）
//
// 后端只有两个控件（`kind` 下拉 + `value` 浮点），值照旧进 widgets_values，
// 存档 / 撤销 / API 导出都跟原生数字控件一致。外观上借 shared/widget_card.mjs
// 的卡片：左边一行小字「值」，右边一个可拖可点可滚的数字框（shared/scrub_input.mjs），
// 跟包里 LoRA 加载器等节点的数字框是同一件东西。
//
// 两个原生控件都被藏掉：
//   · `value` 由卡片那一行接管（卡片自己会 hideWidget，并把槽位画到行上）
//   · `kind` 藏得更彻底，改由卡片右上角那枚齿轮的开菜单来切换 ——
//     一个整数/浮点的二选一，占一整行下拉太浪费，也容易被动到
//
// 切模式的三件事（applyKind）：
//   1. 原生控件的 step / precision 跟着换（存档里那一闪、以及 scrub 的初值都看它）
//   2. 卡片上数字框的步进 / 细步进 / 小数位跟着换（scrub.setStep / setDecimals）
//   3. 切到整数时把挂着的小数四舍五入（不然框里显示 3.7、输出却是 4）
//
// 🔴 **输出槽类型永远 `*`，不跟着模式改**。后端 RETURN_TYPES 是类级静态声明
//    （`*`），真正的类型由 execute 的返回值决定。前端把 outputs[0].type 改成
//    `INT` 图个「一眼看出类型」，代价是**整数模式接不进 FLOAT 输入**：litegraph
//    的 connect() 遇到 INT → FLOAT 不抛错也不建线（静默失败），而 LoRA 强度正是
//    FLOAT（2026-10-23 实测：`*` / `FLOAT` / `INT,FLOAT` 都通，只有 `INT` 失败）。

import { app } from "/scripts/app.js";
import { sizeFor } from "../shared/node_width.mjs?v=2026102706";
import { chainCallback, notifyQgChange } from "../shared/index.mjs?v=2026102706";
import { mountWidgetCard } from "../shared/widget_card.mjs?v=2026102706";
import {
    closeSettingsMenu,
    gearIconSvg,
    openSettingsMenu,
} from "../shared/settings_menu.mjs?v=2026102706";

const NODE_CLASS = "QG_Number";
// kind 的两个取值，必须和 nodes/qg_number.py 的 KINDS 逐字一致。
const KIND_INT = "integer";
const KIND_FLOAT = "float";
// 每种模式的三件套：粗步进 / Shift 细步进 / 小数位。
// 整数模式的细步进也必须是 1，否则 Shift 拖出来的 0.5 会被小数位 0 吃掉。
const MODES = {
  [KIND_INT]: { step: 1, fineStep: 1, decimals: 0 },
  [KIND_FLOAT]: { step: 0.1, fineStep: 0.01, decimals: 2 },
};
// 卡片的下限宽度：够放「值」两个字加一个能看清 6 位数的框。
const MIN_WIDTH = sizeFor("QG_Number").minW;

const widgetOf = (node, name) => node.widgets?.find((widget) => widget.name === name);

function kindOf(node) {
  return widgetOf(node, "kind")?.value === KIND_FLOAT ? KIND_FLOAT : KIND_INT;
}

const modeOf = (kind) => MODES[kind] ?? MODES[KIND_INT];

// 卡片上的数字框跟着模式换步进 / 小数位。
// 🔴 不要只在一处调它：读档、撤销、别处改 kind 都会让「框还停在旧小数位」。
//    所以 bindScrub 把卡片每次 refresh 的 sync 都套上这一层 —— 谁刷新谁对齐。
function retune(node, kind) {
  const mode = modeOf(kind ?? kindOf(node));
  const scrub = node.__qgCard?.controls?.get("value");
  scrub?.setStep(mode.step, mode.fineStep);
  scrub?.setDecimals(mode.decimals);
}

// 卡片 refresh 时会对每个受管控件调 `control.set(values[name])`，
// 这里在 set 前面插一道「先对齐当前模式」，一劳永逸。
function bindScrub(node) {
  const scrub = node.__qgCard?.controls?.get("value");
  if (!scrub || scrub.__qgBound) return;
  scrub.__qgBound = true;
  const set = scrub.set;
  scrub.set = function (value) {
    retune(node);
    return set.call(this, value);
  };
}

function applyKind(node, kind) {
  const mode = modeOf(kind);
  const isFloat = kind === KIND_FLOAT;
  const value = widgetOf(node, "value");

  // 只改 precision，不动 step。原生控件是藏起来的，step 只影响那个看不见的拖动，
  // 但前端的 value 访问器会按它取整 —— 写成 0.1 的话输入 1.25 会被吃成 1.3
  // （踩过）。step 留给 Python 声明成足够细的一格。
  if (value?.options) value.options.precision = mode.decimals;

  retune(node, kind);

  if (!isFloat && value) {
    const rounded = Math.round(Number(value.value) || 0);
    if (rounded !== Number(value.value)) {
      value.value = rounded;
      value.callback?.(rounded);
    }
  }

  // 输出槽恒 `*`（见文件头）。主动兜一次：老存档里可能是 INT / FLOAT。
  const out = node.outputs?.[0];
  if (out && out.type !== "*") out.type = "*";

  node.setDirtyCanvas?.(true, true);
}

function setKind(node, kind) {
  if (kind !== KIND_INT && kind !== KIND_FLOAT) return;
  const kindWidget = widgetOf(node, "kind");
  if (kindWidget && kindWidget.value !== kind) {
    kindWidget.value = kind;
    // 控件上挂着 applyKind（见 installKindHook）和卡片的 refresh，走一遍
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

// ---------------------------------------------------------------- 齿轮（卡片右上角）
//
// 以前画在标题栏上（`?` 左边 22px）：靠 onDrawForeground 画、onMouseDown 接点击。
// Nodes 2.0 下这两个钩子全停 —— 齿轮既不显示也点不到，等于「数值设置」菜单
// 直接没了入口。改挂到 mountWidgetCard 的 corner：卡片右上角、跟第一行齐平，
// 两种渲染模式下都在（卡片本身走 addDOMWidget，两条路都通）。
//
// corner 的约定：返回 { element, sync(values) }，sync 返回值 = 每行控件右侧
// 要给这枚齿轮让出的像素（卡片据此设 --qgtools-card-corner）。
const GEAR_SIZE = 24;
const CORNER_RESERVE = 30; // 齿轮 24 + 与控件之间的 6px 呼吸

function makeGearCorner(node) {
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "qgtools-card-gear";
  gear.title = "数值设置";
  gear.innerHTML = gearIconSvg(14);
  // 告诉共享菜单「这枚按钮是开关」：它点下去时不要先把菜单关掉，否则我们的
  // toggleKindMenu 会以为菜单本来是关的、再开一次 —— 表现是点第二次关不掉。
  gear.dataset.qgtoolsMenuToggle = "";
  gear.addEventListener("click", () => toggleKindMenu(node));
  // 菜单要按屏幕坐标定位，所以点击时按这枚按钮的 rect 现算（见 gearAnchor）。
  // 卡片重建会换掉元素，所以每次挂载都重新记一遍。
  node.__qgNumberGear = gear;
  return { element: gear, sync: () => CORNER_RESERVE };
}

// 齿轮的屏幕矩形 → 菜单锚点。点开时才量一次：缩放 / 拖动之后缓存的坐标会过期，
// 菜单就会飘到别的角落去（以前按 canvas 世界坐标换算，DOM 元素用不上那套）。
function gearAnchor(node) {
  const gear = node.__qgNumberGear;
  const rect =
    gear?.isConnected
      ? gear.getBoundingClientRect()
      : { left: 0, top: 0, bottom: GEAR_SIZE, width: GEAR_SIZE };
  return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width };
}

// ---------------------------------------------------------------- 齿轮菜单
//
// 用包里统一的设置弹层（跟 LoRA 加载器、变换编辑器同一套）。
// `persist: false` 很关键：kind 是每个节点自己的状态，不是「这类节点的默认值」，
// 存进 localStorage 会让新建的节点跟着上次那个节点的模式走。
const MENU_SCOPE = "number";
const MENU_SCHEMA = [
  {
    key: "kind",
    label: "类型",
    hint: "输出的数是整数还是小数",
    type: "choice",
    options: [KIND_INT, KIND_FLOAT],
    optionHints: {
      [KIND_INT]: "输出整数，步进 1，框里不显示小数",
      [KIND_FLOAT]: "输出小数，步进 0.1（按住 Shift 是 0.01），两位小数",
    },
    persist: false,
  },
];

// 菜单挂在 document.body 上，跟节点没有父子关系，所以「这一枚齿轮点第二次＝关」
// 只能自己记：再查一遍 DOM，弹层还在就是开着。
let menuNode = null;

function toggleKindMenu(node) {
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
    title: "数值设置",
    initial: { kind: kindOf(node) },
    onChange: (values, key) => {
      // key 为 null 是「Reset」按的，persist:false 的项保持不动
      if (key === "kind") setKind(node, values.kind);
    },
  });
}

// 节点被删就收掉菜单：弹层挂在 document.body 上，跟节点没有父子关系，
// 不主动关就会留一个孤零零的浮层在画布上。
function hookLifecycle(node) {
  chainCallback(node, "onRemoved", function () {
    if (menuNode === this) {
      closeSettingsMenu();
      menuNode = null;
    }
  });
}

// ---------------------------------------------------------------- 挂载

function mount(node) {
  if (node.__qgNumber) return;
  node.__qgNumber = true;

  // `value` 由卡片那一行接管；`kind` 直接藏起来，交给右上角齿轮的菜单。
  mountWidgetCard(node, {
    rows: [{ widget: "value", label: "值", trimZeros: true }],
    minWidth: MIN_WIDTH,
    hide: ["kind"],
    corner: makeGearCorner,
  });
  // 卡片建好之后：先挂 kind 的回调与数字框的模式对齐，再校一次外观。
  // 建卡片的时候只看到 Python 声明的默认步进，存档里是浮点的话要在这里才对得上。
  installKindHook(node);
  bindScrub(node);
  applyKind(node, kindOf(node));
  hookLifecycle(node);

  // 🔴 读档时 kind 是直接写进 widget 的，不走 callback，所以这里必须补一次。
  //    等 microtask 是因为 widgets_values 要等这一轮 configure 结束才填完。
  chainCallback(node, "onConfigure", function () {
    queueMicrotask(() => applyKind(this, kindOf(this)));
  });
}

app.registerExtension({
  name: "QG.Number",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      mount(this);
    });
  },
});

console.log("[QG-tools] number node ready");
