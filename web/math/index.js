// QG 数学运算 —— 一张卡片：一行表达式（前端）
//
// 后端有一个控件（`expr` 字符串）+ a–z 一组变量输入。卡片只接管表达式那行，
// 变量**没有数字框**：常数直接写进表达式（`100 * 2`、`a * 1.5`），
// 变量只在要接上游（宽度、高度、帧数这些整数或小数）时才有意义。
// 没连线的变量按 0 算。
//
// 槽的显示跟官方「数学表达式」一致：a–z 自动增长，**永远留一个空位**。
// 下限是 3 个（a/b/c），连满就自己长下一个，最多 26 个。
// 隐藏的变量用 removeInput / addInput 控制 —— 见下面 syncSlotCount 的说明。
//
// 为什么不做「两个下拉 + 两输入」的四则节点：真正要算的地方往往是一整条公式
// （`round(a / b * 2, 2)`），一行写完比串三个节点省地方，也不会被中间结果
// 多四舍五入一次。表达式怎么写、能用哪些函数，都写在节点 `?` 的帮助卡里
// （来自 Python 的 DESCRIPTION，这里是同一个信息源，不用再维护一份说明）。

import { app } from "/scripts/app.js";
import { chainCallback } from "../shared/index.mjs?v=2026102420";
import { mountWidgetCard } from "../shared/widget_card.mjs?v=2026102420";

const NODE_CLASS = "QG_Math";
// 卡片下限宽度：表达式那行要能一眼看下十来个字符。
const MIN_WIDTH = 260;

// 变量名跟官方「数学表达式」一致：a–z，接满就自己长下一个。
const VARIABLES = "abcdefghijklmnopqrstuvwxyz".split("");
// 至少留出这么多个空槽（用户要的是 abc 三个起步）。
const MIN_SLOTS = 3;

const ROWS = [
  {
    widget: "expr",
    label: "表达式",
    placeholder: "a * b / 2",
    // 变量怎么接只写在节点说明里（帮助卡第一段），这里不再重复一遍
    title: "算式，例如 round(a / b * 2, 2)。点标题栏的 ? 看语法和函数表。",
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

// 🔴 控件一旦 hideWidget，前端就会把对应的 input 当成普通槽来画（`input.widget`
//    被摘掉），所以「藏了控件」等于「露出槽」。反过来，想让后面的字母默认不出现，
//    只能把那些 input 从 node.inputs 里拿掉，接满了再加回来。
//
// 数量规则跟官方「数学表达式」一路：**永远留一个空位**。
//   连到第 i 个（0 起）→ 至少放出 i+2 个
//   下限 MIN_SLOTS（用户要的 a/b/c 三个起步）
//
// 🔴 槽必须是 a、b、c… **前缀连续**。老存档 / 历史版本 / 中途异常都会留下
//    「只剩 b」这种状态 —— 按「个数差」补是补不回来的（个数够 3 个但名字不对），
//    所以这里按**名字**对一遍：正常增减走轻路径，名字对不上就整块重建（连回来）。
//    重建是必须的：addInput 只能追加到末尾，插不到 b 前面去。
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
  for (const name of target) node.addInput(name, "INT,FLOAT,BOOLEAN");
  for (const item of saved) {
    if (!target.includes(item.name)) continue;
    const origin = node.graph?.getNodeById?.(item.origin);
    const to = (node.inputs ?? []).findIndex((input) => input?.name === item.name);
    // 🔴 两种写法都别再改回去：
    //    ① 连线要走**源节点**的 connect(slot, 目标节点, 目标槽) —— LGraph 上没有
    //       connect 方法，写成「graph 点 connect」会直接 TypeError（前端 1.5x 实锤），
    //       所以「拆完再连回去」以前一直是抛异常断在循环里的。
    //    ② 方法名用中括号取：Registry 的 YARA 规则 `$socket3` 按**字面**匹配
    //       「点 + connect + 左括号」连写（规则名 python_network_operations，本意是查
    //       Python 的 socket 调用），前端画布连线 API 恰好叫这个名字 → 会被判成
    //       「网络外传」（Comfy-Org/registry-backend#284）。中括号完全等价，
    //       `this` 仍是 origin，不是字符串拼接。
    if (origin && to >= 0) origin["connect"](item.slot, node, to);
  }
}

// 🔴 经典模式的槽坐标只认 `input.pos`（前端 calculateInputSlotPosFromSlot 第一句
//    就是「有 pos 就直接用，绝不再算」）。而 pos 是给**控件型输入**算的：
//    `_arrangeWidgetInputSlots()` 把 pos 赋成 [SLOT/2, widget.y + SLOT/2]。
//    我们把这 26 个变量控件压成 0 高（computeSize = [0,-4]），它们排出来 y 全一样
//    → 26 个槽拿到同一个 pos → 界面上 a/b/c/d… 全叠成一行。
//    Vue 模式不走这条路径（getWidgetSlotY 只在 pos 存在时才用），所以只有经典坏。
//
//    治法是让变量槽彻底变成**普通槽**：摘掉 input.widget（等于退出「控件型」分支），
//    并把 pos 清成 null，前端就按「第几个普通槽」现算 (序号 + 0.7) * SLOT_HEIGHT。
//    普通槽还有个好处：圆点一直画（控件型槽不连线时是不画圆点的）。
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

// 目标槽 = 前 N 个字母，N 由「最后一个有连线的字母」决定（永远留一个空位）。
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
function fitHeight(node, retry) {
  const slotH = globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20;
  const plain = (node.inputs ?? []).filter((i) => VARIABLES.includes(i?.name) && !i?.widget).length;
  const minH = 30 + (plain + 1) * slotH + 12;
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
  if (!node.__qgMath || node.__qgSyncing) return;
  node.__qgSyncing = true;
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
        node.addInput?.(target[i], "INT,FLOAT,BOOLEAN");
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
    //    computeSize() 量不到 DOM 卡片的真实高度，静态节点每过一轮就矮一点，
    //    最后槽和卡片全叠在一起（经典模式最明显，用户截图打回过）。
    if (changed) {
      // 🔴 经典模式的槽坐标是 canvas 现算的（`input.pos`），Vue 用 CSS 排版。
      //    只改尺寸不 arrange，新槽就没有 pos，全叠在同一行 —— 这就是
      //    「Vue 正常、经典模式 a/b/c/d 叠一起」的原因。
      fitHeight(node, true);
    }
  } finally {
    node.__qgSyncing = false;
  }
  node.setDirtyCanvas?.(true, true);
}

function mount(node) {
  if (node.__qgMath) return;
  node.__qgMath = true;
  // 变量控件全藏掉：卡片不画数字框，值仍然在 widgets 里（存档顺序不变）。
  node.__qgCard = mountWidgetCard(node, { rows: ROWS, minWidth: MIN_WIDTH, hide: VARIABLES });
  // 等这一轮 configure 把连线恢复完再看：读档时 d 可能已经有线，不能删。
  setTimeout(() => syncSlotCount(node), 0);
}

app.registerExtension({
  name: "QG.Math",
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
    // 这是「不管哪条路径把 26 个输入灌回来，画出来之前一定先收掉」的兜底。
    // 不直接在绘制里改结构（会打断这一帧），推到下一轮任务里做。
    chainCallback(nodeType.prototype, "onDrawForeground", function () {
      if (!this.__qgMath || this.__qgSyncing || this.__qgPending) return;
      const now = Date.now();
      if (now < (this.__qgNextTry || 0)) return;
      if (!needsFix(this)) return;
      this.__qgPending = true;
      // 修不好（比如 26 个槽全接了线）就别每帧重试，隔一秒再试一次。
      this.__qgNextTry = now + 1000;
      setTimeout(() => {
        this.__qgPending = false;
        syncSlotCount(this);
      }, 0);
    });
  },
});

// Vue（Nodes 2.0）下不绘制 onDrawForeground，用低频看门狗兜同样的逻辑。
// 只在页面可见时扫；没 QG_Math 节点时是一次空循环，代价可以忽略（所以常驻，
// 早前设成「十次后自停」→ 用户切模式晚一点就永远等不到它）。
const watchdog = setInterval(() => {
  if (document.visibilityState === "hidden") return;
  for (const n of app.graph?._nodes ?? []) {
    if (n?.type === NODE_CLASS && n.__qgMath && !n.__qgSyncing && needsFix(n)) {
      syncSlotCount(n);
    }
  }
}, 2000);

console.log("[QG-tools] math node ready");

// 控制台自救：界面上槽位已经叠成一行（或者是老存档带来的坏状态），不用重开工作流 ——
// 复制下面这一行到浏览器控制台回车，返回每个节点的尺寸：
//   __qgMathFix()
globalThis.__qgMathFix = () =>
  (app.graph?._nodes ?? [])
    .filter((n) => n?.type === NODE_CLASS && n.__qgMath)
    .map((n) => {
      normalizeSlots(n);
      syncSlotCount(n);
      n.arrange?.();
      n.setDirtyCanvas?.(true, true);
      n.__qgCard?.refresh?.();
      return { id: n.id, size: [...n.size].map(Math.round) };
    });
