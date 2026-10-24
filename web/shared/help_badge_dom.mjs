// Nodes 2.0（Vue 渲染）下标题栏那颗「?」。
//
// 经典模式下 appearance 用 onDrawForeground 自己画圆、用 onMouseDown 收点击；
// Vue 模式整块画布自绘都不跑（见 PLAYBOOK 十三章），所以这里改成往节点外壳的
// 标题栏里塞一个真按钮：
//
//   div.lg-node[data-node-id]
//     └ [data-testid=node-inner-wrapper]
//         └ div.relative.flex.flex-col          ← 标题区
//             └ div.lg-node-header
//                 └ div.flex.items-center.justify-between   ← 塞这里，落在右端
//
// 为什么塞进这一行 flex 而不是绝对定位：这一行本来就是「左侧折叠钮+标题、右侧
// 各种徽章」的横排，多一个 flex 项就自动左移标题、跟原生徽章排队，不用自己算
// 12px 内边距和缩放。实测改标题、切 bypass（NodeBadge 的 v-if 翻面）都不会被
// Vue 冲掉，所以只要防它在极端情况下掉线即可（见 SWEEP_MS）。
//
// 本模块只管 DOM 生命周期，帮助卡内容与打开方式由调用方传入（onOpen），
// 这样 help_badge.mjs 能继续保持纯函数、可被 node:test 直接跑。

import { vueNodesEnabled } from "./vue_mode.mjs?v=2026102420";

const BADGE_CLASS = "qgtools-help-badge";
const STYLE_ID = "qgtools-help-badge-style";
/** Vue 重排后徽章掉线时的兜底重挂间隔。每个节点一次 isConnected，可忽略不计。 */
const SWEEP_MS = 800;

// node -> { node, el, onOpen, label }
const tracked = new Map();
let timer = null;
let styled = false;

// 视觉与经典模式那颗画出来的圆尽量一致：同色系、9px 粗体、描边不填色。
// 尺寸给到 14px，比画布的 7px 半径略小一点——DOM 里带 1px 边框，视觉半径正好。
//
// 🔴 位置与命中的关系（2026-10-23 按用户要求调到贴右上角）：
//    Vue 节点四角各有一个 `absolute h-5 w-5 opacity-0 pointer-events-auto` 的
//    缩放手柄（20×20），平时完全透明但一直占着命中区，右上角那个正好压在标题
//    栏右端。想让徽章站到那个角落，就必须自己压上去（`position:relative` +
//    `z-index`），否则真实鼠标点下去命中的是手柄 → 变成拉节点尺寸，click 根本
//    落不到徽章上（合成 badge.click() 却能过，极易误判成「逻辑没问题」）。
//    代价是手柄有约 8×12px 落在徽章下面，左边那半仍然能拉尺寸。
//
//    margin-right 7px 是量出来的：行内边距 p-1 是 4px（已在布局里），再留 7px，
//    徽章右缘距节点右缘约 10 CSS px、圆心约 16.5 —— 正好落在用户圈的位置。
//    改这个数请跑 tools/probe_badge_geo.py 看 badgeCenterFromShellRight。
const CSS = `
.${BADGE_CLASS}{
  flex:none;width:14px;height:14px;box-sizing:border-box;margin:0 7px 0 1px;
  position:relative;z-index:2;
  display:inline-flex;align-items:center;justify-content:center;padding:0;
  border:1px solid rgba(155,162,170,.55);border-radius:50%;background:transparent;
  color:rgba(155,162,170,.8);font:bold 9px/1 system-ui,sans-serif;
  cursor:pointer;opacity:.7;transition:opacity .12s,border-color .12s,color .12s;
}
.${BADGE_CLASS}:hover{opacity:1;border-color:rgba(196,204,212,.85);color:rgba(214,221,228,.95)}
`;

function ensureStyle() {
  if (styled) return;
  styled = true;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/**
 * 节点的 Vue 外壳。同名 id 在子图里会带图层前缀（"3:12"），所以先按整串比，
 * 整串都不中时才认后缀，且要求全图唯一——有歧义宁可这次不挂，也不要挂错节点。
 */
function shellOf(node) {
  const id = node?.id;
  if (id === undefined || id === null) return null;
  const want = String(id);
  let suffix = null;
  let suffixHits = 0;
  for (const el of document.querySelectorAll(".lg-node")) {
    if (el.dataset?.ghost) continue; // 拖拽残影，别往它上面挂
    const raw = el.dataset?.nodeId;
    if (!raw) continue;
    if (raw === want) return el;
    if (raw.endsWith(":" + want)) {
      suffixHits++;
      suffix = el;
    }
  }
  return suffixHits === 1 ? suffix : null;
}

function headerRow(node) {
  const shell = shellOf(node);
  // 直接子级选择器：`.lg-node-header > div` 就是那一行 flex，别误伤标题内部结构
  return shell?.querySelector(".lg-node-header > div") ?? null;
}

function createBadge(entry) {
  ensureStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BADGE_CLASS;
  btn.textContent = "?";
  // 帮助卡的「点别处关闭」监听在 document 的 capture 阶段，按钮上 stopPropagation
  // 拦不住；这个属性是 openInfoCard 认的豁免标记（settings_menu.mjs 里写明）。
  btn.dataset.qgtoolsMenuToggle = "1";
  if (entry.label) btn.setAttribute("aria-label", entry.label);
  // Vue 节点外壳整块挂在拖拽处理器下面：不拦指针，点一下徽章就变成拖动节点
  btn.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
  });
  btn.addEventListener("pointerup", (event) => event.stopPropagation());
  // 标题栏双击是「改标题」，别让这一下冒泡到 lg-node-header
  btn.addEventListener("dblclick", (event) => event.stopPropagation());
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    try {
      entry.onOpen?.(event);
    } catch (error) {
      console.error("[QG-tools] 帮助卡打开失败：", error);
    }
  });
  return btn;
}

function attach(entry) {
  const el = entry.el;
  if (el?.isConnected) return;
  const row = headerRow(entry.node);
  if (!row) return; // Vue 还没渲染出来，下一次扫到再挂
  row.append(el ?? (entry.el = createBadge(entry)));
}

function detach(entry) {
  try {
    entry.el?.remove();
  } catch {
    /* 忽略 */
  }
}

// 经典模式下 DOM 徽章必须摘掉，否则跟画布画的那颗并排出现两个「?」。
function sweep() {
  const vue = vueNodesEnabled();
  for (const entry of [...tracked.values()]) {
    if (!vue || entry.node?.flags?.collapsed) {
      detach(entry);
      continue;
    }
    attach(entry);
  }
  if (!tracked.size) stopTimer();
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      console.error("[QG-tools] 帮助徽章巡检出错：", error);
    }
  }, SWEEP_MS);
}

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 给一个节点登记 Vue 模式下的标题栏徽章。
 *
 * @param {any} node
 * @param {{ onOpen?: (event: MouseEvent) => void, label?: string }} [options]
 *        onOpen 由调用方实现（要开哪张卡、怎么定位都由它决定）。
 */
export function mountHelpBadge(node, options = {}) {
  if (!node) return;
  let entry = tracked.get(node);
  if (!entry) {
    entry = { node, el: null, onOpen: null, label: null };
    tracked.set(node, entry);
  }
  if (typeof options.onOpen === "function") entry.onOpen = options.onOpen;
  if (options.label) entry.label = options.label;
  if (entry.el && options.label) entry.el.setAttribute("aria-label", options.label);
  sweep();
  if (tracked.size) startTimer();
}

/** 节点删除时调用：摘元素、停跟踪（否则 Map 会一直攥着这个节点）。 */
export function unmountHelpBadge(node) {
  const entry = node ? tracked.get(node) : null;
  if (!entry) return;
  detach(entry);
  tracked.delete(node);
  if (!tracked.size) stopTimer();
}

/** 控制台自救 / 探针用：立刻巡检一遍，不用等 800ms。 */
export function syncHelpBadges() {
  sweep();
  return tracked.size;
}
