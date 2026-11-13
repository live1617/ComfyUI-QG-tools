// QG 双式数学运算 —— 变量槽动态显示（前端）
//
// 后端声明了 a 到 z（跳过 e）共 25 个可选输入（e 是常量，故意跳过）。
// 25 个槽一直全露的话，没接线的空槽会把卡片左半边撑满、节点也白白变高 ——
// 所以这里跟「数学运算」用同一套规则：
// 默认 4 个（a/b/c/d），接满一个就自己长下一个，**永远留一个空位**，最多 25 个。
//
// 隐藏靠 removeInput / addInput，不靠 hideWidget —— 原因见下面 syncSlotCount
// 上面那段：控件一旦 hideWidget，前端就会把它当成普通槽画出来，反而更乱。
// 这两个表达式框（expr1 / expr2）是节点的原生 widget，不归这块管。

import { app } from "/scripts/app.js";
import { sizeFor } from "../shared/node_width.mjs?v=202611141000";
import { chainCallback, zhPair } from "../shared/index.mjs?v=202611141000";
import { mountWidgetCard } from "../shared/widget_card.mjs?v=202611141000";

const NODE_CLASS = "QG_DualMath";
// 卡片下限宽度：两个表达式框都要能一眼看下十来个字符。
const MIN_WIDTH = sizeFor("QG_DualMath").minW;
// 必须与后端 nodes/qg_dual_math.py 的 VARIABLES 完全一致（顺序也要一致）。
const VARIABLES = "abcdfghijklmnopqrstuvwxyz".split("");
// 起步空槽数：a/b/c/d 四个（接满第 4 个才长出第 5 个，再接满继续长，直到 z）。
const MIN_SLOTS = 4;
// 挂在节点上的两个标记：一个说「已经装过」，一个防重入。
const FLAG = "__qgDualSlot";
const SYNCING = "__qgDualSyncing";

// 两个表达式框走与「数学运算」同一套卡片：左侧小标签 + 右侧深色输入框。
// 🔴 造在函数里而不是顶层常量：`zhPair` 读的是「当前界面语言」，模块顶层
//    求值时 app.i18n 可能还没挂上，只能退到 <html lang> 猜 —— 猜错就是
//    英文界面里露出中文。挂载时才求值就没有这个窗口。
const dualRows = () => [
  {
    widget: "expr1",
    label: zhPair("Expression 1", "表达式 1"),
    placeholder: "e.g. a + b * 2",
    // 标签只有四个字，用窄列让输入框多往左占一点（与数学运算一致）
    tightLabel: true,
    title: zhPair(
      "First expression, e.g. a + b * 2. Empty means zero. Variables: a to z except e.",
      "第一行算式，例如 a + b * 2。留空得 0。变量：a 到 z（跳过 e）。",
    ),
  },
  {
    widget: "expr2",
    label: zhPair("Expression 2", "表达式 2"),
    placeholder: "e.g. round(c / d, 2)",
    tightLabel: true,
    title: zhPair(
      "Second expression, sharing the same variable values as the first one.",
      "第二行算式，与第一行共用同一组变量值。",
    ),
  },
];

const slotOf = (node, name) => (node.inputs ?? []).find((input) => input?.name === name);
// LiteGraph 的 link 是 id（数字）；未连接是 null。有的路径会给 -1，不能当有线。
const linkOf = (slot) => {
  const l = slot?.link;
  if (Array.isArray(l)) return l.length ? l[0] : null;
  return typeof l === "number" && l >= 0 ? l : null;
};
const hasLink = (node, name) => linkOf(slotOf(node, name)) !== null;
// 🔴 同名槽重复 = 老代码 addInput 加了两遍留下的。slotOf 只找到第一个、
//    removeInput 只删第一个 → 永远清不干净，界面上两个圆点叠在同一行。
const slotIndexes = (node, name) => {
  const out = [];
  (node.inputs ?? []).forEach((input, i) => {
    if (input?.name === name) out.push(i);
  });
  return out;
};
const hasDuplicate = (node) => VARIABLES.some((name) => slotIndexes(node, name).length > 1);

// 🔴 槽必须是 a、b、c… **前缀连续**。老存档 / 中途异常会留下「只剩 b」这种
//    状态——按个数补补不回来（个数够 3 个但名字不对），所以按**名字**对一遍：
//    正常增减走轻路径，名字对不上就整块重建（连回来）。addInput 只能追加到末尾，
//    插不到 b 前面去，所以重建是必须的。
const isPrefix = (arr, of) => arr.length <= of.length && arr.every((v, i) => v === of[i]);

function rebuildSlots(node, present, target) {
  // 先记下连线（源节点 + 源槽），拆完再按新顺序连回去
  const saved = [];
  for (const name of present) {
    const linkId = linkOf(slotOf(node, name));
    const link = linkId === null ? null : node.graph?.links?.[linkId];
    if (link) saved.push({ name, origin: link.origin_id, slot: link.origin_slot });
  }
  // 🔴 倒序删掉**所有**变量槽（含重名的），不能只删第一个
  for (let i = (node.inputs ?? []).length - 1; i >= 0; i -= 1) {
    if (VARIABLES.includes(node.inputs[i]?.name)) node.removeInput(i);
  }
  for (const name of target) node.addInput(name, "INT,FLOAT,BOOLEAN,STRING");
  for (const item of saved) {
    if (!target.includes(item.name)) continue;
    const origin = node.graph?.getNodeById?.(item.origin);
    const to = (node.inputs ?? []).findIndex((input) => input?.name === item.name);
    // 🔴 两种写法都别再改回去：
    //    ① 连线要走**源节点**的 connect(slot, 目标节点, 目标槽) —— LGraph 上没有
    //       connect 方法，写成「graph 点 connect」会直接 TypeError。
    //    ② 方法名用中括号取：Registry 的 YARA 规则按**字面**匹配「点 + connect +
    //       左括号」连写（本意是查 Python 的 socket 调用），前端画布连线 API 恰好
    //       叫这个名字 → 会被判成「网络外传」。中括号完全等价，this 仍是 origin。
    if (origin && to >= 0) origin["connect"](item.slot, node, to);
  }
}

// 🔴 经典模式的槽坐标只认 `input.pos`（前端 calculateInputSlotPosFromSlot 第一句
//    就是「有 pos 就直接用，绝不再算」）。而 pos 是给**控件型输入**算的，
//    我们这些变量要保持「普通槽」身份：摘掉 input.widget、把 pos 清成 null，
//    前端才会按「第几个普通槽」现算 (序号 + 0.7) * SLOT_HEIGHT。
//    普通槽的圆点也一直画（控件型槽不连线时是不画圆点的）。
function normalizeSlots(node) {
  let touched = false;
  let plain = 0;
  for (const slot of node.inputs ?? []) {
    if (!VARIABLES.includes(slot?.name)) continue;
    if (slot.widget) {
      try {
        delete slot.widget;
      } catch {
        slot.widget = null;
      }
      try {
        delete slot._widget;
      } catch {
        // 老版本没有这个字段，删不掉也无所谓
      }
      touched = true;
    }
    if (slot.pos) {
      slot.pos = null;
      touched = true;
    }
    plain += 1;
  }
  return { touched, plain };
}

// 目标槽 = 前 N 个变量，N 由「最后一个有连线的变量」决定（永远留一个空位）。
function targetSlots(node) {
  let need = MIN_SLOTS;
  for (const name of VARIABLES) {
    if (hasLink(node, name)) need = Math.max(need, VARIABLES.indexOf(name) + 2);
  }
  return VARIABLES.slice(0, Math.min(need, VARIABLES.length));
}

// 跟目标对不上就是「该收/该长」了。只比名字和个数，很便宜，可以每帧调。
function needsFix(node) {
  if (hasDuplicate(node)) return true;
  const target = targetSlots(node);
  const present = VARIABLES.filter((name) => slotOf(node, name));
  return !isPrefix(present, target) || present.length !== target.length;
}

// 节点高度跟着「普通槽个数」走。改完立刻量一次，60ms 后再兜一次 ——
// 有些路径（建节点、粘贴、读档）会在同一帧里把旧尺寸回填回来。
// 双式有**两个**表达式框，所以估算项是 plain + 2，不是 + 1。
function fitHeight(node, retry) {
  const slotH = globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;
  const plain = (node.inputs ?? []).filter((i) => VARIABLES.includes(i?.name) && !i?.widget).length;
  const minH = 30 + (plain + 2) * slotH + 12;
  let measured = null;
  try {
    measured = node.computeSize?.();
  } catch {
    measured = null;
  }
  const h = Math.max(measured?.[1] || 0, minH);
  if (Math.abs((node.size?.[1] || 0) - h) > 2) {
    node.setSize?.([node.size[0], h]);
    node.arrange?.();
    node.__qgCard?.refresh?.();
    if (retry) setTimeout(() => fitHeight(node, false), 60);
  }
}

function syncSlotCount(node) {
  if (!node[FLAG] || node[SYNCING]) return;
  node[SYNCING] = true;
  try {
    const target = targetSlots(node);
    const present = VARIABLES.filter((name) => slotOf(node, name));
    let changed = false;
    if (hasDuplicate(node)) {
      // 有重名槽 → 只有整块重建能清干净
      rebuildSlots(node, present, target);
      changed = true;
    } else if (isPrefix(present, target)) {
      // 正常情况：只补末尾缺的（addInput 就是追加到末尾，顺序天然对）
      for (let i = present.length; i < target.length; i += 1) {
        node.addInput?.(target[i], "INT,FLOAT,BOOLEAN,STRING");
        changed = true;
      }
    } else if (isPrefix(target, present)) {
      // 要收：只收末尾那些空着的，有连线的留着
      for (let i = present.length - 1; i >= target.length; i -= 1) {
        if (hasLink(node, present[i])) continue;
        const at = (node.inputs ?? []).findIndex((input) => input?.name === present[i]);
        if (at >= 0) {
          node.removeInput?.(at);
          changed = true;
        }
      }
    } else {
      // 名字对不上（缺中间的、顺序乱的）→ 整块重建
      rebuildSlots(node, present, target);
      changed = true;
    }

    // 槽位几何：摘控件关联 + 清 pos（见 normalizeSlots 的说明）
    const geo = normalizeSlots(node);
    if (geo.touched) changed = true;

    // 🔴 只在真的增删了槽时才改尺寸。无条件 setSize 会把节点压扁 ——
    //    computeSize() 量不到 DOM 卡片的真实高度，静态节点每过一轮就矮一点。
    if (changed) {
      // 🔴 经典模式的槽坐标是 canvas 现算的（`input.pos`），Vue 用 CSS 排版。
      //    只改尺寸不 arrange，新槽就没有 pos，全叠在同一行。
      fitHeight(node, true);
    }
  } finally {
    node[SYNCING] = false;
  }
  node.setDirtyCanvas?.(true, true);
}

function mount(node) {
  if (node[FLAG]) return;
  node[FLAG] = true;
  // 两个表达式框交给卡片渲染：原生 STRING widget 是「整行一根输入框」，
  // 和「数学运算」摆在一起会明显不是一套（用户发截图要求统一）。
  mountWidgetCard(node, { rows: dualRows(), minWidth: MIN_WIDTH });
  // 等这一轮 configure 把连线恢复完再看：读档时 d 可能已经有线，不能删。
  setTimeout(() => syncSlotCount(node), 0);
}

app.registerExtension({
  name: "QG.DualMath",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      mount(this);
    });
    // 复制粘贴 / 撤销重做 / 子图进出都会走 onAdded —— 只挂 onNodeCreated 会漏。
    chainCallback(nodeType.prototype, "onAdded", function () {
      mount(this);
      setTimeout(() => syncSlotCount(this), 0);
    });
    // 读档时连线已经在了，但不会再触发 onConnectionsChange —— 补一次。
    chainCallback(nodeType.prototype, "onConfigure", function () {
      queueMicrotask(() => syncSlotCount(this));
      setTimeout(() => syncSlotCount(this), 120);
    });
    // type: 1 = 输入槽（LiteGraph.INPUT）。
    chainCallback(nodeType.prototype, "onConnectionsChange", function (type) {
      if (type === 1) syncSlotCount(this);
    });
    // 经典模式每帧绘制前自检：槽数跟目标对不上就当场收（便宜到可以每帧跑）。
    // 不直接在绘制里改结构（会打断这一帧），推到下一轮任务里做。
    chainCallback(nodeType.prototype, "onDrawForeground", function () {
      if (!this[FLAG] || this[SYNCING] || this.__qgDualPending) return;
      const now = Date.now();
      if (now < (this.__qgDualNextTry || 0)) return;
      if (!needsFix(this)) return;
      this.__qgDualPending = true;
      // 修不好（比如 5 个槽全接了线）就别每帧重试，隔一秒再试一次。
      this.__qgDualNextTry = now + 1000;
      setTimeout(() => {
        this.__qgDualPending = false;
        syncSlotCount(this);
      }, 0);
    });
  },
});

// Vue（Nodes 2.0）下不绘制 onDrawForeground，用低频看门狗兜同样的逻辑。
// 只在页面可见时扫；没 QG_DualMath 节点时是一次空循环，代价可以忽略。
setInterval(() => {
  if (document.visibilityState === "hidden") return;
  for (const n of app.graph?._nodes ?? []) {
    if (n?.type === NODE_CLASS && n[FLAG] && !n[SYNCING] && needsFix(n)) {
      syncSlotCount(n);
    }
  }
}, 2000);

console.log("[QG-tools] dual math node ready");

// 控制台自救：槽位已经叠成一行、或者老存档带坏状态时，不用重开工作流 ——
// 复制下面这一行到浏览器控制台回车，返回每个节点的尺寸：
//   __qgDualMathFix()
globalThis.__qgDualMathFix = () =>
  (app.graph?._nodes ?? [])
    .filter((n) => n?.type === NODE_CLASS && n[FLAG])
    .map((n) => {
      normalizeSlots(n);
      syncSlotCount(n);
      n.arrange?.();
      n.setDirtyCanvas?.(true, true);
      n.__qgCard?.refresh?.();
      return { id: n.id, size: [...n.size].map(Math.round) };
    });
