// ============================================================
// 搬入说明（2026-11-08，用户确认后 1:1 搬运）
//   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/snaplines_v7.js
//   原文件：D://WorkBuddy//2026-10-10-13-25-05//intake//multipack-v0.1.0//
//           ComfyUI-QG-Multipack\web\snaplines_v7.js
//   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 EXT.SnapLines
//
//   只做四处必要适配，功能逻辑一行未改：
//     1) import 路径 ../../scripts/app.js -> /scripts/app.js（扩展目录层级变了，
//        也是 QG-tools 的约定：引用内置脚本一律用绝对路径）；
//     2) 控制台日志前缀 [QG-Multipack] -> [QG-tools]；
//     3) 设置面板分类首段 "QG 工具" -> "QG-tools"（两处，跟随本包命名空间）；
//     4) 文件名 snaplines_v7.js -> web/snaplines/index.js（ComfyUI 自动加载）。
//   保持不变：扩展名 QG.SnapLines / QG.Align、设置键 QG.SnapLines.Enabled /
//   QG.Align.ToolboxButton、命令 id、QYH.* 老设置迁移、CSS 的 qyh-align-* 前缀、
//   调试钩子 window.__qyh*。后两项是源插件的历史命名，不影响功能，也未与
//   QG-tools 现有类名撞车，按 1:1 口径不动。
//
//   ⚠️ 与 ComfyUI-QG-Multipack 同时安装会双份注册（同名扩展、同名设置、
//   两套 pointer 钩子）。本机未装该插件；换机器时二选一。
// ============================================================

// QG-Multipack v8 —— 拖动/缩放对齐参考线 + 多选排列（二合一）
// ===============================================================
// 本插件现在是一个文件、两个模块：
//
// 【模块一：参考线吸附】
// 拖动节点或分组时，把拖动包围盒的“左边/中线/右边”和
// “上边/中线/下边”与画布上其他节点、分组的对应线逐一比较；
// 距离小于吸附阈值时，把拖动对象整体平移到精确对齐，
// 并用橙色线标出所有共线位置。拉角缩放时移动的边同样吸附。
// 按住 Shift 拖动 = 临时关闭。
//
// 【模块二：QG 排列】
// 选中两个以上节点或分组后，选区上方工具栏出现一个图标按钮，
// 点开一个图形化浮动面板（12 个 SVG 图标工具，三段分组）；
// 面板跟随工具栏移动，Esc 或点击面板外关闭。
// 同时保留画布右键菜单入口。
//   · 六种对齐：左/垂直居中/右/顶/水平居中/底
//     —— 以选区整体包围盒为基准（最外边缘或整体中线），另一轴不动
//   · 四种统一尺寸：同最宽 / 同最窄 / 同最高 / 同最矮
//   · 两种等间距：横向分布 / 纵向分布（少于 3 个不动）
//
// 设计要点（借鉴通用做法，代码独立实现）：
// 1. litegraph 在 canvas 的 pointerdown 里 stopPropagation()，事件不冒泡，
//    因此 pointerdown 用【捕获阶段】监听并给所有对象拍快照，同时记录
//    悬停时 litegraph 已标好的缩放方向（resizeDirection）。
// 2. pointermove 在窗口【冒泡阶段】监听：此刻 litegraph 已移动/缩放完。
//    对比快照找出真正在动的对象；Alt 复制出的新副本不在快照里，
//    用选中状态识别。拖滑块/连线/框选时对象不动，自动排除。
// 3. 每一步把对象放到【绝对位置】= 起点 + 指针位移 + 吸附量，
//    吸附量不会跨帧累积；线和对象位置在同一次计算里得出，永远一致。
// 4. 【视觉矩形】本版 litegraph 把节点标题渲染在 pos 上方：
//    视觉顶边 = pos[1] - NODE_TITLE_HEIGHT。吸附、画线与排列一律用视觉轮廓。
// 5. 只吸附视口内（visible_area 外扩阈值）的对象；拖分组时跳过
//    其它分组内的节点（对齐框架本身），缩放分组时自己的节点仍是目标。
// 6. 多条线同样近时，优先吸与拖动对象同行/同列的目标（间隙更小者）。
// 7. Vue Nodes 2.0 模式：用 rAF 排在它自己的写入之后，并把参考线
//    画到 overlay 上层；经典外观画在画布前景。
// 8. 排列不经过画布鼠标手势，落地后主动补拍撤销快照（Ctrl+Z 可撤销、
//    工作流标记已修改）；并对所有移动过的节点补 updateArea 刷新
//    boundingRect 缓存（本版该字段重绘时才更新）。

import { app } from "/scripts/app.js";
// 界面文案：本包规范是 zhPair(英文, 中文)，按 ComfyUI 当前语言取值。
// 源插件只做了中文，搬进来后英文界面会看到中文按钮 —— scan_frontend_zh.py 会拦。
import { zhPair } from "../shared/zh.mjs?v=2026110902";

// ================== 可调参数（两个模块共用） ==================
const LINE_COLOR = "#fb923c"; // 参考线/强调色（橙色），两个模块同一套视觉
const BRAND = LINE_COLOR;     // 排列模块的别名
const SNAP_PX = 8;            // 吸附触发距离（屏幕像素，随缩放自适应）
const OVERHANG_PX = 6;        // 参考线两端超出对象的延长量（屏幕像素）
const MARK_PX = 2.5;          // 共线交点圆点半径（屏幕像素）
const SAME_LINE = 0.5;        // 图形单位：两条线距离小于此视为同一条
const TIE = 1e-6;             // 平局判定容差
const MIN_GAP = 20;           // 等间距分布的最小间隙（图形单位）
const PANEL_CMD = "QG.Align.Panel";

// 设置 id / 命令 id 一律用 QG.* 前缀（早期版本是 QYH.*，见下面的迁移）。
// 前缀换了以后老版本存的值读不到，等于把用户关掉的开关又打开，
// 所以注册完设置后先把老键的值搬到新键。
const SETTING_SNAPLINES = "QG.SnapLines.Enabled";
const SETTING_WITH_GRID = "QG.SnapLines.WithGridSnap";
const SETTING_TOOLBOX = "QG.Align.ToolboxButton";
const LEGACY_SETTING_IDS = [
  ["QYH.SnapLines.Enabled", SETTING_SNAPLINES],
  ["QYH.Align.ToolboxButton", SETTING_TOOLBOX],
];
const ICON_CLASS = "qyh-align-tb-icon";
// 其他扩展的吸附开启时本扩展让位，避免两套吸附打架
const OTHER_SNAPPERS = ["AusBoss.Canvas.SnapLines", "Pixaroma.Align.Enabled"];
// ==============================================================

// ---------- 共享基础工具 ----------

function dbg(...args) {
  if (window.__QYH_DEBUG) console.log("[QG-tools dbg]", ...args);
}

// ---------- 老设置 id 迁移（QYH.* → QG.*） ----------

// 新版前端把设置存在服务端：启动时全量拉进 settingStore，改动通过
// setSettingValue 写回后端。所以迁移走同一套 API，别去碰 localStorage
// （1.5x 之后那里已经没有设置数据了）。
// 规则：老键有值 + 新键没被用户设过 → 把老值写进新键；老键留着不管。

function settingRegistered(id) {
  // settingsLookup 就是 settingStore.settingsById（已注册的设置定义表）。
  // 它是前端标了 deprecated 的兼容 getter，取不到就当作没注册（跳过迁移），
  // 不要因为读它失败把整个 setup 打断。
  try {
    const lookup = app.ui?.settings?.settingsLookup;
    return !!lookup && Object.prototype.hasOwnProperty.call(lookup, id);
  } catch (err) {
    return false;
  }
}

function storedSetting(id) {
  // settingsValues 就是 settingStore.settingValues（后端返回的已存值）
  try {
    const values = app.ui?.settings?.settingsValues;
    if (!values || !Object.prototype.hasOwnProperty.call(values, id)) return undefined;
    return values[id];
  } catch (err) {
    return undefined;
  }
}

function migrateLegacySettings() {
  const settings = app.ui?.settings;
  if (!settings?.getSettingValue || !settings?.setSettingValue) return;
  for (const [oldId, newId] of LEGACY_SETTING_IDS) {
    if (!settingRegistered(newId)) continue; // 该设置还没注册，由注册它的模块再调一次
    if (storedSetting(newId) !== undefined) continue; // 新键已有用户设的值，以新值为准
    const oldValue = settings.getSettingValue(oldId);
    if (oldValue === undefined) continue; // 从没改过，用默认值就行
    try {
      // setSettingValue 内部会先同步更新内存里的值再写后端，所以这里返回后
      // 立刻读 getSettingValue 就能拿到迁移后的新值。
      settings.setSettingValue(newId, oldValue);
    } catch (err) {
      console.warn(`[QG-tools] 设置迁移 ${oldId} → ${newId} 失败:`, err);
    }
  }
}

function vueNodes() {
  return globalThis.LiteGraph?.vueNodesMode === true;
}

function getNodes(graph) {
  if (!graph) return [];
  if (Array.isArray(graph._nodes)) return graph._nodes;
  const n = graph.nodes;
  if (Array.isArray(n)) return n;
  if (n && typeof n.values === "function") return [...n.values()];
  if (n && typeof n[Symbol.iterator] === "function") return [...n];
  return [];
}

function getGroups(graph) {
  if (!graph) return [];
  if (Array.isArray(graph._groups)) return graph._groups;
  if (Array.isArray(graph.groups)) return graph.groups;
  return [];
}

function hasPos(it) {
  return !!(
    it && it.pos && it.size &&
    typeof it.pos[0] === "number" && typeof it.pos[1] === "number" &&
    typeof it.size[0] === "number" && typeof it.size[1] === "number"
  );
}

function itemsOf(graph) {
  return [...getNodes(graph), ...getGroups(graph)].filter(hasPos);
}

function isGroup(it) {
  const LG = globalThis.LiteGraph;
  return !!(LG?.LGraphGroup && it instanceof LG.LGraphGroup);
}

function isPinned(it) {
  return it.pinned === true || it.flags?.pinned === true;
}

// 标题高度偏移量：本版 litegraph 标题渲染在 pos 上方。
// 分组没有偏移；折叠节点的标题条同样悬在 pos 上方；
// 声明了“无标题”模式的节点没有偏移。
function titleOffset(it) {
  if (isGroup(it)) return 0;
  const LG = globalThis.LiteGraph;
  const t = LG?.NODE_TITLE_HEIGHT || 30;
  if (it.flags?.collapsed) return t;
  const mode = it.constructor?.title_mode;
  if (mode === (LG?.NO_TITLE ?? 1)) return 0;
  return t;
}

// 视觉矩形：pos/size + 标题偏移。pos/size 可传入快照值（画残影用）。
function vrect(it, pos, size) {
  const t = titleOffset(it);
  if (it.flags?.collapsed) {
    return { x: pos[0], y: pos[1] - t, w: size[0], h: t };
  }
  return { x: pos[0], y: pos[1] - t, w: size[0], h: size[1] + t };
}

function rectOf(it) {
  return vrect(it, it.pos, it.size);
}

function unionRects(list) {
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of list) {
    if (r.x < x1) x1 = r.x;
    if (r.y < y1) y1 = r.y;
    if (r.x + r.w > x2) x2 = r.x + r.w;
    if (r.y + r.h > y2) y2 = r.y + r.h;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// 屏幕（client）坐标 → 图形坐标
function graphPoint(canvas, e) {
  const box = canvas.canvas.getBoundingClientRect();
  const scale = canvas.ds?.scale || 1;
  const off = canvas.ds?.offset || [0, 0];
  return [
    (e.clientX - box.left) / scale - off[0],
    (e.clientY - box.top) / scale - off[1],
  ];
}

function settingOn(id) {
  try {
    return app.ui?.settings?.getSettingValue?.(id) === true;
  } catch {
    return false;
  }
}

function otherSnapperOn() {
  return OTHER_SNAPPERS.some(settingOn);
}

function overlapsRect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// 节点中心是否落在任一分组内
function insideAnyGroup(r, groupRects) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return groupRects.some((g) => cx > g.x && cx < g.x + g.w && cy > g.y && cy < g.y + g.h);
}

// ===============================================================
// 模块一：参考线吸附
// ===============================================================

let enabled = true;
// 「网格吸附开着时也显示参考线」——false 时保持原来的做法：网格吸附全权接管，
// 参考线整段让位（静默，连日志都没有，用户只会觉得功能坏了）。true 时照常进来，
// 但落点仍交给网格，本模块只画线（原因见 stepMove 里的注释）。
let withGridSnap = false;
let down = null;      // pointerdown 快照：{ map: Map(item -> {pos,size}), anchor:[gx,gy], gridSnap }
let drag = null;      // { anchor, items:[{it,start,anchor?}], moving, targets } 或 { idle:true }
let resizing = null;  // 缩放状态 { node, corner } —— corner 在首次见到 resizing_node 时懒读取
let guides = [];      // 本帧参考线 [{axis, at, middle, from, to, marks}]
let frame = 0;        // Vue 模式的 rAF 句柄
let pending = null;   // Vue 模式下等待合帧的最新事件

// ---------- 几何：三线（起边/中线/终边）模型 ----------

function lines3(r, axis) {
  return axis === "x"
    ? [r.x, r.x + r.w / 2, r.x + r.w]
    : [r.y, r.y + r.h / 2, r.y + r.h];
}

// 垂直于 axis 的方向上两个矩形的间隙（在该方向重叠时为 0）。
// 平局决胜用：把对象吸到同行/同列的目标更符合直觉。
// 注意 axis="x"（水平拖动）时要量的是 **y 方向** 的间距——量 x 只会退化成
// 「离得近的优先」，跟「同行优先」不是一回事（2026-11-06 修正）。
function gapAcross(a, b, axis) {
  if (axis === "x") return Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
}

// movingRect 沿 axis 移动 lines 这几条线时，最近的目标线及吸附量。
// targets 是节点/分组对象，先转成视觉矩形再比较。
function nearestShift(movingRect, lines, targets, axis, reach) {
  let best = null;
  for (const t of targets) {
    const r = rectOf(t);
    const gap = gapAcross(movingRect, r, axis);
    for (const to of lines3(r, axis)) {
      for (const from of lines) {
        const d = to - from;
        const size = Math.abs(d);
        if (size > reach) continue;
        const better =
          !best || size < best.size - TIE || (size <= best.size + TIE && gap < best.gap);
        if (better) best = { d, size, gap };
      }
    }
  }
  return best;
}

// 调整大小：只有 edges 里为真的边参与吸附；
// 吸附会让尺寸低于最小值时放弃那一次吸附。
function snapEdges(rect, edges, targets, reach, min) {
  let { x, y, w, h } = rect;
  const minW = min?.w ?? 0;
  const minH = min?.h ?? 0;
  const near = (value, axis) => nearestShift(rect, [value], targets, axis, reach);
  if (edges.right) {
    const s = near(x + w, "x");
    if (s && w + s.d >= minW) w += s.d;
  } else if (edges.left) {
    const s = near(x, "x");
    if (s && w - s.d >= minW) {
      x += s.d;
      w -= s.d;
    }
  }
  if (edges.bottom) {
    const s = near(y + h, "y");
    if (s && h + s.d >= minH) h += s.d;
  } else if (edges.top) {
    const s = near(y, "y");
    if (s && h - s.d >= minH) {
      y += s.d;
      h -= s.d;
    }
  }
  return { x, y, w, h };
}

// 放置后参与“共线比对”的线：移动时是全部六条（中线带 middle 标记），
// 缩放时只有移动中的边（固定边不画线）。
function placedLines(placed, edges) {
  const lines = [];
  for (const axis of ["x", "y"]) {
    const [s, m, e2] = lines3(placed, axis);
    const first = axis === "x" ? "left" : "top";
    const last = axis === "x" ? "right" : "bottom";
    if (!edges || edges[first]) lines.push({ axis, at: s, middle: false });
    if (!edges) lines.push({ axis, at: m, middle: true });
    if (!edges || edges[last]) lines.push({ axis, at: e2, middle: false });
  }
  return lines;
}

// 参考线：placed 的每条线只要有目标共线就画一条（同轴近线去重），
// 线身贯通 placed 与所有共线目标，marks 记录每个对象的接触点。
function buildGuides(placed, targets, lines) {
  const out = [];
  if (!placed) return out;
  for (const ln of lines) {
    if (out.some((g) => g.axis === ln.axis && Math.abs(g.at - ln.at) <= SAME_LINE)) continue;
    const on = targets.filter((t) =>
      lines3(rectOf(t), ln.axis).some((v) => Math.abs(v - ln.at) <= SAME_LINE)
    );
    if (!on.length) continue;
    const lo = [];
    const hi = [];
    const span = (r) => {
      const a = ln.axis === "x" ? r.y : r.x;
      const b = ln.axis === "x" ? r.y + r.h : r.x + r.w;
      lo.push(a);
      hi.push(b);
    };
    span(placed);
    for (const t of on) span(rectOf(t));
    out.push({
      axis: ln.axis,
      at: ln.at,
      middle: ln.middle,
      from: Math.min(...lo),
      to: Math.max(...hi),
      marks: [...lo, ...hi],
    });
  }
  return out;
}

// 吸附目标：视口内（visible_area 外扩 reach）、不在拖动集合里的节点与分组。
// 视口外的对象不参与吸附——否则线会画在"看似没道理"的位置。
// 拖动分组时跳过其它分组内的节点；缩放分组时它自己的节点仍是目标
//（moving 里只有这个分组，groupRects 不含它，所以框内节点不会被跳过）。
function targetsFor(canvas, moving) {
  const reach = SNAP_PX / (canvas.ds?.scale || 1);
  const area = canvas.visible_area;
  // visible_area 是 Float32Array（非普通 Array），用 length + 宽高判断有效性
  const hasView = !!area && area.length >= 4 && area[2] > 0 && area[3] > 0;
  const view = hasView
    ? { x: area[0] - reach, y: area[1] - reach, w: area[2] + 2 * reach, h: area[3] + 2 * reach }
    : null;
  const anyGroupMoving = [...moving].some(isGroup);
  const groupRects = [];
  const targets = [];
  for (const it of itemsOf(canvas.graph)) {
    if (moving.has(it)) continue;
    if (isGroup(it)) {
      const r = rectOf(it);
      if (!view || overlapsRect(r, view)) {
        targets.push(it);
        groupRects.push(r);
      }
    }
  }
  for (const it of itemsOf(canvas.graph)) {
    if (moving.has(it) || isGroup(it)) continue;
    const r = rectOf(it);
    if (view && !overlapsRect(r, view)) continue;
    if (anyGroupMoving && insideAnyGroup(r, groupRects)) continue;
    targets.push(it);
  }
  return targets;
}

// ---------- 事件处理 ----------

// 指针按下：给所有可移动对象拍快照（此时 litegraph 还没开始处理）。
// 注意：缩放方向（resizeDirection）是 litegraph 在它自己的 pointerdown
// 处理里才写入的，这里读不到——改在首次见到 resizing_node 时懒读取。
function onPointerDown(e) {
  endDrag();
  if (e.button !== 0 || !enabled) return;
  // 网格吸附开着时默认让位（两套都在改拖动落点）。设置里可以放开，
  // 放开后照常进来看，但只画线、不改位置（见 stepMove 里 gridSnap 分支）。
  const gridOn = globalThis.LiteGraph?.alwaysSnapToGrid === true;
  if (gridOn && !withGridSnap) return;
  if (otherSnapperOn()) return;                        // 其他吸附扩展开启时让位
  const canvas = app.canvas;
  const graph = app.graph;
  if (!canvas?.graph || !canvas.canvas || !canvas.ds) return;
  // 只认「指针落在画布区域内」。原来只看 e.target.tagName === "CANVAS" 太脆：
  // 同一位置换个渲染层、或者开着网格吸附时，目标会变成 DIV，整个模块就静默失效。
  // 真正判定「有没有在拖东西」的是 startMove（比对位置是否真的变了），这里放宽没有副作用。
  const box = canvas.canvas.getBoundingClientRect();
  if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return;
  const tag = (e.target?.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  const snap = new Map();
  for (const it of itemsOf(graph)) {
    if (it.pinned) continue;
    snap.set(it, { pos: [it.pos[0], it.pos[1]], size: [it.size[0], it.size[1]] });
  }
  // anchor 记在按下时刻：travel = 指针相对按下的位移，与快照同基准，零滞后
  down = { map: snap, anchor: graphPoint(canvas, e), gridSnap: gridOn && withGridSnap };
  dbg("pointerdown 快照:", snap.size, "个对象", down.gridSnap ? "(网格模式，只画线)" : "");
}

// 第一次移动：对比快照找出真正在动的对象，建立拖动状态
function startMove(canvas, e) {
  const movers = [];
  for (const [it, was] of down.map) {
    if (it.pos[0] !== was.pos[0] || it.pos[1] !== was.pos[1]) {
      // 尺寸也变了说明在拖角调整大小，不参与吸附
      if (it.size[0] !== was.size[0] || it.size[1] !== was.size[1]) return { idle: true };
      movers.push(it);
    }
  }
  // Alt 拖动复制：新副本不在快照里，选中状态是它的标志
  const copies = [];
  for (const it of itemsOf(canvas.graph)) {
    if (!down.map.has(it) && it.selected && !it.pinned) copies.push(it);
  }
  if (!movers.length && !copies.length) return null;   // 拖滑块/拖连线/框选：什么都没动
  const outlines = [];
  const items = [];
  const pt = graphPoint(canvas, e);
  for (const it of movers) {
    const was = down.map.get(it);
    outlines.push(vrect(it, was.pos, was.size));       // 残影画在起点的视觉位置
    items.push({ it, start: [was.pos[0], was.pos[1]] });
  }
  for (const it of copies) {
    if (!it.size) continue;                            // 极小对象（如转发点）随行但不参与对齐
    outlines.push(rectOf(it));                         // 副本还没画过，就地测量
    // 副本的位置从本次移动算起，锚点也用此刻的指针，避免首帧位移被计两次
    items.push({ it, start: [it.pos[0], it.pos[1]], anchor: pt });
  }
  const box = unionRects(outlines);
  if (!box) return { idle: true };
  const moving = new Set([...movers, ...copies]);
  // 吸附目标：视口内、不在拖动集合里的节点和分组
  const targets = targetsFor(canvas, moving);
  return {
    anchor: down.anchor,
    box,
    items,
    moving,
    targets,
    gridSnap: down.gridSnap,   // true 时落点归网格，本模块只画线
  };
}

// 每次移动：把对象放到绝对位置 = 起点 + 位移，再按实际包围盒吸附并生成参考线
function stepMove(canvas, e) {
  const point = graphPoint(canvas, e);
  const dx = point[0] - drag.anchor[0];
  const dy = point[1] - drag.anchor[1];

  // 网格吸附同时开着（用户放开了叠加）：落点完全交给网格，本模块只画线。
  // 为什么不在这里做节点吸附：对齐位移多半不是网格倍数（节点宽度不是网格的整数倍，
  // 中线必然落在半格上），写入后松开鼠标时 litegraph 会再吸一次把它拽走 ——
  // 实测 305 被拽到 310，参考线画的位置和最终位置对不上，比不吸更糟。
  if (drag.gridSnap) {
    const liveBox = unionRects(drag.items.map(({ it }) => rectOf(it)));
    setGuides(liveBox ? buildGuides(liveBox, drag.targets, placedLines(liveBox, null)) : []);
    canvas.setDirty?.(true, true);
    dbgOnce("网格模式：只画线（落点由网格决定）");
    return;
  }

  // 第一步：绝对定位到"起点 + 位移"（覆盖 litegraph 的写入，吸附量永不累积）
  for (const item of drag.items) {
    const a = item.anchor || drag.anchor;
    const nx = item.start[0] + (point[0] - a[0]);
    const ny = item.start[1] + (point[1] - a[1]);
    if (item.it.pos[0] !== nx || item.it.pos[1] !== ny) item.it.pos = [nx, ny];
  }

  // 第二步：从放置后的【实际视觉包围盒】算吸附——吸附基准与放置基准永远一致
  const reach = SNAP_PX / (canvas.ds?.scale || 1);
  let shift = { dx: 0, dy: 0 };
  const bbox = unionRects(drag.items.map(({ it }) => rectOf(it)));
  if (!e.shiftKey && bbox && drag.targets.length) {
    const cx = nearestShift(bbox, lines3(bbox, "x"), drag.targets, "x", reach);
    const cy = nearestShift(bbox, lines3(bbox, "y"), drag.targets, "y", reach);
    shift = { dx: cx ? cx.d : 0, dy: cy ? cy.d : 0 };
    if (shift.dx || shift.dy) {
      for (const { it } of drag.items) {
        if (shift.dx) it.pos[0] += shift.dx;
        if (shift.dy) it.pos[1] += shift.dy;
      }
    }
  }

  // 第三步：参考线按最终实际位置生成（所有共线都画，不只吸附触发的那条）
  const finalBox = unionRects(drag.items.map(({ it }) => rectOf(it)));
  setGuides(buildGuides(finalBox || bbox, drag.targets, placedLines(finalBox || bbox, null)));
  canvas.setDirty?.(true, true);
  dbgOnce("位移:", dx.toFixed(1), dy.toFixed(1), "吸附:", shift.dx.toFixed(1), shift.dy.toFixed(1));
}

// 拉节点角缩放：litegraph 已按指针改好尺寸，我们把移动中的边吸到线上。
// 移动中的边从快照推断（比读 litegraph 的 resizeDirection 可靠）：
// pos 变了 = 左/上边在动；pos 没变而 size 变了 = 右/下边在动。
function stepNodeResize(canvas, e) {
  const node = canvas.resizing_node;
  const was = down?.map.get(node);
  if (!node || !was || e.shiftKey) return setGuides([]);
  if (!resizing || resizing.node !== node) {
    const EPS = 1e-6;
    const movedX = Math.abs(node.pos[0] - was.pos[0]) > EPS;
    const movedY = Math.abs(node.pos[1] - was.pos[1]) > EPS;
    resizing = {
      node,
      edges: {
        left: movedX,
        right: !movedX && Math.abs(node.size[0] - was.size[0]) > EPS,
        top: movedY,
        bottom: !movedY && Math.abs(node.size[1] - was.size[1]) > EPS,
      },
    };
  }
  const title = titleOffset(node);
  const rect = rectOf(node);
  const edges = resizing.edges;
  const least = node.computeSize?.() ?? [0, 0];
  const targets = targetsFor(canvas, new Set([node]));
  const reach = SNAP_PX / (canvas.ds?.scale || 1);
  const placed = snapEdges(rect, edges, targets, reach, { w: least[0], h: least[1] + title });
  if (placed.x !== rect.x || placed.y !== rect.y || placed.w !== rect.w || placed.h !== rect.h) {
    node.pos = [placed.x, placed.y + title];
    if (node.setSize) node.setSize([placed.w, placed.h - title]);
    else node.size = [placed.w, placed.h - title];
  }
  setGuides(buildGuides(placed, targets, placedLines(placed, edges)));
  canvas.setDirty?.(true, true);
}

// 拉分组角缩放：分组自己的节点仍是目标，框可以贴合内容
function stepGroupResize(canvas, e) {
  const group = canvas.resizingGroup;
  if (!group || e.shiftKey) return setGuides([]);
  const rect = { x: group.pos[0], y: group.pos[1], w: group.size[0], h: group.size[1] };
  const targets = targetsFor(canvas, new Set([group]));
  const LG = globalThis.LiteGraph;
  const least = { w: LG?.LGraphGroup?.minWidth ?? 0, h: LG?.LGraphGroup?.minHeight ?? 0 };
  const reach = SNAP_PX / (canvas.ds?.scale || 1);
  const placed = snapEdges(rect, { right: true, bottom: true }, targets, reach, least);
  if (placed.w !== rect.w || placed.h !== rect.h) group.resize(placed.w, placed.h);
  setGuides(buildGuides(placed, targets, placedLines(placed, { right: true, bottom: true })));
  canvas.setDirty?.(true, true);
}

function setGuides(next) {
  if (!next.length && !guides.length) return;
  guides = next;
  window.__qyhGuides = guides;
  app.canvas?.setDirty?.(true, false);
}

function endDrag() {
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  pending = null;
  if (drag && !drag.idle) dbg("拖动结束");
  const had = guides.length > 0;
  down = null;
  drag = null;
  resizing = null;
  guides = [];
  window.__qyhGuides = guides;
  if (had) app.canvas?.setDirty?.(true, false);
}

let lastDbgKey = "";
function dbgOnce(...args) {
  const key = args.join(" ");
  if (key !== lastDbgKey) { lastDbgKey = key; dbg(...args); }
}

function step(e) {
  const canvas = app.canvas;
  if (!down || !canvas?.graph || !canvas.canvas || !canvas.ds) return;
  if (canvas.resizing_node) return stepNodeResize(canvas, e);
  if (canvas.resizingGroup) return stepGroupResize(canvas, e);
  if (!drag) {
    drag = startMove(canvas, e);
    if (!drag) return;
    if (drag.idle) return;
    dbg("拖动开始:", drag.items.length, "个对象");
  }
  if (drag.idle) return;
  stepMove(canvas, e);
}

// pointermove 用冒泡阶段：litegraph 的 canvas 处理器先跑完（它只拦 pointerdown），
// 我们拿到的是它移动完之后的事件；随后同步写入最终位置，本帧渲染必然一致。
// Vue Nodes 2.0 在同一事件排队的 rAF 里写位置，所以再排一个 rAF 跟在它后面，
// 且只保留最新事件。
function onPointerMove(e) {
  if (!down) return;
  if (!(e.buttons & 1)) { endDrag(); return; }   // 漏收 up 的兜底
  if (vueNodes()) {
    pending = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const latest = pending;
      pending = null;
      if (latest) step(latest);
    });
    return;
  }
  step(e);
}

function onPointerUp() {
  endDrag();
}

// ---------- 绘制（经典外观画前景层；Vue 模式画 overlay，位于节点上层） ----------

function drawGuides(canvas, ctx) {
  if (!guides.length || !canvas?.ds) return;
  let pen = ctx;
  const overlay = vueNodes() ? canvas.overlayCtx : null;
  if (overlay && canvas.overlayCanvas) {
    pen = overlay;
    pen.save();
    const ratio = canvas.overlayCanvas.width / (canvas.overlayCanvas.clientWidth || 1);
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    canvas.ds.toCanvasContext(pen);
  } else {
    pen.save();
  }
  const unit = 1 / (canvas.ds.scale || 1);
  const overhang = OVERHANG_PX * unit;
  pen.strokeStyle = LINE_COLOR;
  pen.fillStyle = LINE_COLOR;
  pen.lineWidth = unit;
  for (const g of guides) {
    pen.setLineDash(g.middle ? [4 * unit, 3 * unit] : []);   // 中线用虚线区分
    pen.beginPath();
    if (g.axis === "x") {
      pen.moveTo(g.at, g.from - overhang);
      pen.lineTo(g.at, g.to + overhang);
    } else {
      pen.moveTo(g.from - overhang, g.at);
      pen.lineTo(g.to + overhang, g.at);
    }
    pen.stroke();
    pen.beginPath();
    for (const m of g.marks) {
      const [x, y] = g.axis === "x" ? [g.at, m] : [m, g.at];
      pen.moveTo(x + MARK_PX * unit, y);
      pen.arc(x, y, MARK_PX * unit, 0, Math.PI * 2);
    }
    pen.fill();
  }
  pen.restore();
}

function hookDraw(canvas) {
  if (!canvas || canvas.__qyhSnapLines) return;
  canvas.__qyhSnapLines = true;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function (ctx) {
    if (prev) prev.call(this, ctx);
    drawGuides(this, ctx);
  };
}

// ===============================================================
// 模块二：QG 排列
// ===============================================================

// 视觉轮廓矩形：人们看到的占位（含标题栏）。
// 节点先 updateArea 刷新（本帧改过尺寸时 boundingRect 才是新的），
// 再优先用 litegraph 自带的 boundingRect（它已含标题偏移），异常时手动补。
function outlineOf(it) {
  if (!isGroup(it)) it.updateArea?.(app.canvas?.ctx);
  const b = it.boundingRect;
  if (Array.isArray(b) && b.length >= 4 && b[2] > 0 && b[3] > 0) {
    return { x: b[0], y: b[1], w: b[2], h: b[3] };
  }
  const t = titleOffset(it);
  if (it.flags?.collapsed) {
    return { x: it.pos[0], y: it.pos[1] - t, w: it.size[0], h: t };
  }
  return { x: it.pos[0], y: it.pos[1] - t, w: it.size[0], h: it.size[1] + t };
}

// ---------- 选中集合 ----------

// 选中并参与排列的单元。分组选中的话，组内节点「随组走」不单独出现；
// 每个单元记录自己的轮廓 rect 和移动/缩放方法需要的元数据。
function selectionUnits() {
  const canvas = app.canvas;
  const picked = [...(canvas?.selectedItems ?? [])];
  if (!picked.length) return [];
  const carried = new Set();
  for (const item of picked) {
    if (!isGroup(item)) continue;
    item.recomputeInsideNodes?.();
    const children = item.children ?? item._children ?? [];
    for (const child of children) carried.add(child);
  }
  const units = [];
  for (const item of picked) {
    if (carried.has(item)) continue;
    if (!item?.pos || !item?.size) continue;
    units.push({ item, group: isGroup(item), rect: outlineOf(item) });
  }
  return units;
}

// ---------- 移动与缩放 ----------

function moveUnit(unit, target) {
  const { item, group, rect } = unit;
  const dx = target.x - rect.x;
  const dy = target.y - rect.y;
  if ((!dx && !dy) || isPinned(item)) return;
  if (group) item.move?.(dx, dy);            // 分组用 move，子节点跟着走
  else item.pos = [item.pos[0] + dx, item.pos[1] + dy];
}

function resizeUnit(unit, target) {
  const { item, group, rect } = unit;
  if (isPinned(item) || item.flags?.collapsed) return;
  if (target.w === rect.w && target.h === rect.h) return;
  if (group) {
    item.resize?.(target.w, target.h);
    return;
  }
  // 节点的轮廓含标题栏（可能还有边框），size 不含——反推需要设置的 size。
  const extraW = rect.w - item.size[0];
  const extraH = rect.h - item.size[1];
  const least = item.computeSize?.() ?? [0, 0];
  const w = Math.max(target.w - extraW, least[0]);
  const h = Math.max(target.h - extraH, least[1]);
  if (item.setSize) item.setSize([w, h]);
  else item.size = [w, h];
}

// ---------- 三类排列的几何（每个函数返回与输入等长的结果数组） ----------

// 六种对齐：基准是选区整体包围盒——边对齐用最外边缘，中线对齐用整体中线
function alignRects(rects, how) {
  const bounds = unionRects(rects);
  if (!bounds) return rects.map((r) => ({ x: r.x, y: r.y }));
  return rects.map((r) => {
    switch (how) {
      case "left":     return { x: bounds.x, y: r.y };
      case "middleX":  return { x: bounds.x + bounds.w / 2 - r.w / 2, y: r.y };
      case "right":    return { x: bounds.x + bounds.w - r.w, y: r.y };
      case "top":      return { x: r.x, y: bounds.y };
      case "middleY":  return { x: r.x, y: bounds.y + bounds.h / 2 - r.h / 2 };
      case "bottom":   return { x: r.x, y: bounds.y + bounds.h - r.h };
      default:         return { x: r.x, y: r.y };
    }
  });
}

// 统一尺寸：取最值，另一维保持不变
function sizeRects(rects, how) {
  if (!rects.length) return [];
  const ws = rects.map((r) => r.w);
  const hs = rects.map((r) => r.h);
  const w = how === "widest" ? Math.max(...ws) : how === "narrowest" ? Math.min(...ws) : null;
  const h = how === "tallest" ? Math.max(...hs) : how === "shortest" ? Math.min(...hs) : null;
  return rects.map((r) => ({ w: w ?? r.w, h: h ?? r.h }));
}

// 等间距：按中线排序，选区外缘保持不动；间距不足 MIN_GAP 时抬到 MIN_GAP
//（此时选区会从首端向下/右扩展）。少于 3 个不动。
function spreadRects(rects, axis) {
  const [start, size] = axis === "across" ? ["x", "w"] : ["y", "h"];
  const out = rects.map((r) => ({ x: r.x, y: r.y }));
  if (rects.length < 3) return out;
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => {
      const mid = (r) => r[start] + r[size] / 2;
      return mid(rects[a]) - mid(rects[b]) || rects[a][start] - rects[b][start];
    });
  const first = Math.min(...rects.map((r) => r[start]));
  const last = Math.max(...rects.map((r) => r[start] + r[size]));
  const filled = rects.reduce((sum, r) => sum + r[size], 0);
  const gap = Math.max(MIN_GAP, (last - first - filled) / (rects.length - 1));
  let at = first;
  for (const i of order) {
    out[i][start] = at;
    at += rects[i][size] + gap;
  }
  return out;
}

// ---------- 工具定义与执行 ----------

const TOOLS = [
  { kind: "align",   how: "left",     en: "Align left",           zh: "左对齐" },
  { kind: "align",   how: "middleX",  en: "Center horizontally",  zh: "垂直居中" },
  { kind: "align",   how: "right",    en: "Align right",          zh: "右对齐" },
  { kind: "align",   how: "top",      en: "Align top",            zh: "顶对齐" },
  { kind: "align",   how: "middleY",  en: "Center vertically",    zh: "水平居中" },
  { kind: "align",   how: "bottom",   en: "Align bottom",         zh: "底对齐" },
  { kind: "size",    how: "widest",   en: "Match widest",         zh: "同最宽" },
  { kind: "size",    how: "narrowest",en: "Match narrowest",      zh: "同最窄" },
  { kind: "size",    how: "tallest",  en: "Match tallest",        zh: "同最高" },
  { kind: "size",    how: "shortest", en: "Match shortest",       zh: "同最矮" },
  { kind: "spacing", how: "across",   en: "Distribute horizontally", zh: "横向等距" },
  { kind: "spacing", how: "down",     en: "Distribute vertically",   zh: "纵向等距" },
];

/** 工具名按当前界面语言取。原来是写死的中文 label，英文界面上全是中文。 */
const toolLabel = (tool) => zhPair(tool.en, tool.zh);

function enoughFor(kind, count) {
  return kind === "spacing" ? count >= 3 : count >= 2;
}

function runTool(tool) {
  const canvas = app.canvas;
  if (!canvas?.graph) return;
  const units = selectionUnits();
  if (!enoughFor(tool.kind, units.length)) {
    app.extensionManager?.toast?.add?.({
      severity: "info",
      summary: zhPair("QG Align", "QG 对齐"),
      detail: tool.kind === "spacing"
        ? zhPair("Select at least three nodes or groups first", "请先选中三个以上节点或分组")
        : zhPair("Select at least two nodes or groups first", "请先选中两个以上节点或分组"),
      life: 3000,
    });
    return;
  }
  const rects = units.map((u) => u.rect);
  if (tool.kind === "size") {
    sizeRects(rects, tool.how).forEach((t, i) => resizeUnit(units[i], t));
  } else {
    const places = tool.kind === "align" ? alignRects(rects, tool.how) : spreadRects(rects, tool.how);
    places.forEach((t, i) => moveUnit(units[i], t));
  }
  // 本版 boundingRect 是缓存（重绘时才刷新）：移动/缩放后立即补一次
  // updateArea，否则随后任何读取（连续排列、原生 Align、其他扩展）都拿到旧值
  for (const u of units) {
    if (!u.group) u.item.updateArea?.(canvas.ctx);
  }
  canvas.setDirty?.(true, true);
  notifyGraphChange();
  refreshPanelButtons();
}

// ---------- 撤销历史与脏标记 ----------

// ComfyUI 的撤销/脏标记跟踪器在画布 mouse-up 时快照图；我们从 DOM 面板或
// 右键菜单改节点位置不走 mouse-up，若不主动补一拍，改动既不会标记工作流
// 已修改，也进不了 Ctrl+Z 的撤销历史。写入落地后调用一次（防抖合并同一次
// 手势的多次写入；跟踪器发现无变化时本身是空操作）。
let changeTimer = null;

function notifyGraphChange() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    try {
      const workflow =
        app?.extensionManager?.workflow?.activeWorkflow ??
        app?.workflowManager?.activeWorkflow;
      const tracker = workflow?.changeTracker;
      if (!tracker) return;
      if (typeof tracker.captureCanvasState === "function") tracker.captureCanvasState();
      else tracker.checkState?.();
    } catch (_error) {
      // 尽力而为：改动本身已生效，不能让历史记录打断排列
    }
  }, 120);
}

// ---------- 图标：24x24 几何图形，盒子用前景色、基准线用强调色 ----------

const ibox = (x, y, w, h) => ({ x, y, w, h });
// 转置：把横向图标变纵向（坐标 x/y 互换，箭头方向也换）
const iturn = (p) => ({
  boxes: p.boxes.map(({ x, y, w, h }) => ibox(y, x, h, w)),
  lines: p.lines.map(([x1, y1, x2, y2]) => [y1, x1, y2, x2]),
  heads: p.heads.map(([x, y, d]) => [y, x, { l: "u", r: "d", u: "l", d: "r" }[d]]),
});

const I_LEFT = {
  boxes: [ibox(8, 4, 12, 5), ibox(8, 13, 10, 5)],
  lines: [[4, 3, 4, 21]],
  heads: [],
};
const I_MIDX = {
  boxes: [ibox(5, 4, 14, 5), ibox(8, 13, 8, 5)],
  lines: [[12, 3, 12, 21]],
  heads: [],
};
const I_RIGHT = {
  boxes: [ibox(4, 4, 12, 5), ibox(6, 13, 10, 5)],
  lines: [[20, 3, 20, 21]],
  heads: [],
};
// 统一尺寸：宽盒子做参照，双向箭头示意拉伸/收缩方向
const I_WIDEST = {
  boxes: [ibox(3, 4, 18, 5), ibox(8, 15, 8, 5)],
  lines: [[8, 12, 4, 12], [16, 12, 20, 12]],
  heads: [[4, 12, "l"], [20, 12, "r"]],
};
const I_NARROW = {
  boxes: [ibox(8, 4, 8, 5), ibox(3, 15, 18, 5)],
  lines: [[4, 12, 8, 12], [20, 12, 16, 12]],
  heads: [[8, 12, "r"], [16, 12, "l"]],
};
// 等间距：三个盒子，间隙里一道刻度线
const I_ACROSS = {
  boxes: [ibox(2, 7, 4, 10), ibox(10, 7, 4, 10), ibox(18, 7, 4, 10)],
  lines: [[8, 9, 8, 15], [16, 9, 16, 15]],
  heads: [],
};

const ICONS = {
  left: I_LEFT,
  middleX: I_MIDX,
  right: I_RIGHT,
  top: iturn(I_LEFT),
  middleY: iturn(I_MIDX),
  bottom: iturn(I_RIGHT),
  widest: I_WIDEST,
  narrowest: I_NARROW,
  tallest: iturn(I_WIDEST),
  shortest: iturn(I_NARROW),
  across: I_ACROSS,
  down: iturn(I_ACROSS),
};

// 箭头：在 (x,y) 处、朝 dir 方向的 V 形
function headPath([x, y, dir]) {
  const s = 2.6;
  const pts = {
    l: [[x + s, y - s], [x, y], [x + s, y + s]],
    r: [[x - s, y - s], [x, y], [x - s, y + s]],
    u: [[x - s, y + s], [x, y], [x + s, y + s]],
    d: [[x - s, y - s], [x, y], [x + s, y - s]],
  }[dir];
  return `M${pts.map((p) => p.join(" ")).join(" L")}`;
}

function iconSvg(how, size = 18) {
  const p = ICONS[how];
  const rects = p.boxes
    .map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="1.4" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.5"/>`)
    .join("");
  const lines = p.lines
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join("");
  const heads = p.heads
    .map((h) => `<path d="${headPath(h)}" fill="none"/>`)
    .join("");
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${rects}<g stroke="${BRAND}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${lines}${heads}</g></svg>`;
}

// 工具栏按钮是 <i class="qyh-align-tb-icon">，图标用 CSS mask 画：
// 盒子层取按钮文字色，基准线层固定强调色
function maskUrl(body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function styleSheet() {
  const boxesMask = maskUrl(
    ICONS.left.boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="1.4" fill="black" fill-opacity="0.25" stroke="black" stroke-width="1.5"/>`).join("")
  );
  const marksMask = maskUrl(
    `<g stroke="black" stroke-width="1.8" stroke-linecap="round">${ICONS.left.lines.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`).join("")}</g>`
  );
  return `
.${ICON_CLASS} { position: relative; display: inline-block; width: 1rem; height: 1rem; }
.${ICON_CLASS}::before, .${ICON_CLASS}::after {
  content: ""; position: absolute; inset: 0;
  -webkit-mask: var(--qyh-align-mask) center / contain no-repeat;
  mask: var(--qyh-align-mask) center / contain no-repeat;
}
.${ICON_CLASS}::before { --qyh-align-mask: ${boxesMask}; background: currentColor; }
.${ICON_CLASS}::after  { --qyh-align-mask: ${marksMask}; background: ${BRAND}; }

.qyh-align-panel {
  position: fixed; z-index: 10000; padding: 6px 6px 4px; border-radius: 10px;
  background: var(--comfy-menu-bg, #1f2225); color: var(--input-text, #e6edf3);
  border: 1px solid var(--border-color, #3a3f44); box-shadow: 0 8px 24px rgba(0,0,0,.35);
  font-size: 11px; line-height: 1.2; user-select: none;
}
.qyh-align-panel-title { margin: 2px 6px 3px; color: ${BRAND}; font-weight: 600; }
.qyh-align-panel-row { display: flex; gap: 2px; }
.qyh-align-panel-rule { height: 1px; margin: 5px 2px; background: var(--border-color, #30363d); }
.qyh-align-panel button {
  display: grid; place-items: center; width: 30px; height: 30px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
}
.qyh-align-panel button:hover:not(:disabled) { background: color-mix(in srgb, ${BRAND} 18%, transparent); }
.qyh-align-panel button:focus-visible { outline: 1px solid ${BRAND}; }
.qyh-align-panel button:disabled { opacity: 0.35; cursor: default; }
.qyh-align-menu-title { opacity: .6; font-size: 11px; }
`;
}

// ---------- 入口一：画布右键菜单 ----------

// 选中两个以上节点/分组时，在右键菜单插入「QG 对齐」子菜单。
function extraMenuOptions(canvas) {
  const count = selectionUnits().length;
  if (count < 2) return [];
  const options = [];
  const alignItems = TOOLS.filter((t) => t.kind === "align");
  const sizeItems = TOOLS.filter((t) => t.kind === "size");
  const spacingItems = TOOLS.filter((t) => t.kind === "spacing");
  const pushGroup = (title, items) => {
    options.push(null); // 分隔线
    options.push({ content: title, disabled: true, className: "qyh-align-menu-title" });
    for (const t of items) options.push({ content: toolLabel(t), callback: () => runTool(t) });
  };
  options.push({ content: zhPair("Open arrange panel…", "排列面板…"), callback: () => togglePanel() });
  pushGroup(zhPair("── QG Align ──", "── QG 对齐 ──"), alignItems);
  pushGroup(zhPair("Match size", "统一尺寸"), sizeItems);
  options.push(null);
  options.push({ content: zhPair("Distribute spacing", "等间距分布"), disabled: true, className: "qyh-align-menu-title" });
  for (const t of spacingItems) {
    if (count >= 3) options.push({ content: toolLabel(t), callback: () => runTool(t) });
  }
  return options;
}

function hookContextMenu() {
  const canvas = app.canvas;
  if (!canvas || canvas.__qyhAlignMenu) return;
  canvas.__qyhAlignMenu = true;
  const prev = canvas.getExtraMenuOptions;
  canvas.getExtraMenuOptions = function (node, options) {
    const prevResult = prev ? prev.call(this, node, options) : undefined;
    const extra = extraMenuOptions(this);
    if (Array.isArray(options)) options.push(...extra);
    return Array.isArray(prevResult) ? [...prevResult, ...extra] : extra;
  };
}

// ---------- 入口二：选区工具栏按钮 + 图形化浮动面板 ----------

const panel = { el: null, frame: 0, buttons: [], count: -1 };

// 轻量计数：只数画布选中集，不做几何测量——rAF 跟随循环每帧都调它，
// 全量测量（updateArea/boundingRect）在节点多时每秒白跑几十次
function pickedCount() {
  let n = 0;
  for (const item of app.canvas?.selectedItems ?? []) {
    if (item?.pos && item?.size) n++;
  }
  return n;
}

// 工具栏里我们的那个按钮（命令 icon 挂的 class）
function anchorButton() {
  return document.querySelector(`.selection-toolbox .${ICON_CLASS}`)?.closest("button") ?? null;
}

// 前端用自家翻译表命名工具栏按钮，表里没有我们的条目；
// 等按钮渲染出来后补一次 title / aria-label
function labelAnchor() {
  const button = anchorButton();
  if (!button || button.title) return;
  button.title = zhPair("QG Arrange: align / size / spacing", "QG 排列：对齐 / 统一尺寸 / 等间距");
  button.setAttribute("aria-label", button.title);
}

function buildPanel() {
  const el = document.createElement("div");
  el.className = "qyh-align-panel";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", zhPair("QG Arrange", "QG 排列"));
  panel.buttons = [];
  const title = document.createElement("div");
  title.className = "qyh-align-panel-title";
  title.textContent = zhPair("QG Arrange", "QG 排列");
  el.append(title);
  const sections = [
    { name: zhPair("Align", "对齐"), kind: "align" },
    { name: zhPair("Match size", "统一尺寸"), kind: "size" },
    { name: zhPair("Distribute", "等间距"), kind: "spacing" },
  ];
  sections.forEach((sec, index) => {
    if (index) el.append(Object.assign(document.createElement("div"), { className: "qyh-align-panel-rule" }));
    const row = document.createElement("div");
    row.className = "qyh-align-panel-row";
    for (const tool of TOOLS.filter((t) => t.kind === sec.kind)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = toolLabel(tool);
      btn.setAttribute("aria-label", toolLabel(tool));
      btn.innerHTML = iconSvg(tool.how);
      btn.addEventListener("click", () => runTool(tool));
      panel.buttons.push({ btn, tool });
      row.append(btn);
    }
    el.append(row);
  });
  return el;
}

function refreshPanelButtons() {
  if (!panel.el) return;
  const count = pickedCount();           // 便宜：每帧只数集合
  if (count === panel.count) return;     // 没变就早退，省掉每帧的几何测量
  panel.count = count;
  const units = selectionUnits().length; // 贵：只在选中集真变了时算一次（含分组随动排除）
  for (const { btn, tool } of panel.buttons) btn.disabled = !enoughFor(tool.kind, units);
}

// 面板定位：优先锚定在工具栏里我们的按钮下方；按钮不可用时（比如设置里
// 关掉了选区工具箱）只要仍有两个以上选中，就贴屏幕上方居中兜底；
// 选中数掉到不足时面板自动关闭。
function placePanel() {
  if (!panel.el) return;
  const anchor = anchorButton();
  if (!anchor) {
    if (pickedCount() < 2) return closePanel();
    const size = panel.el.getBoundingClientRect();
    const left = Math.max(8, (window.innerWidth - size.width) / 2);
    panel.el.style.left = `${Math.round(left)}px`;
    panel.el.style.top = "64px";
    refreshPanelButtons();
    return;
  }
  const bar = (anchor.closest(".selection-toolbox") ?? anchor).getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  const size = panel.el.getBoundingClientRect();
  let left = Math.min(Math.max(8, at.left + at.width / 2 - size.width / 2), window.innerWidth - size.width - 8);
  let top = bar.bottom + 6;
  if (top + size.height > window.innerHeight - 8) top = Math.max(8, bar.top - size.height - 6);
  panel.el.style.left = `${Math.round(left)}px`;
  panel.el.style.top = `${Math.round(top)}px`;
  refreshPanelButtons();
}

function follow() {
  panel.frame = 0;
  if (!panel.el) return;
  placePanel();
  if (panel.el) panel.frame = requestAnimationFrame(follow);
}

// 打开条件看选中数而不是按钮是否存在：右键菜单入口在选区工具箱被设置的
// Comfy.Canvas.SelectionToolbox 关掉时也能用（面板走兜底位置）
function openPanel() {
  if (panel.el || pickedCount() < 2) return;
  panel.el = buildPanel();
  panel.count = -1;
  document.body.append(panel.el);
  window.addEventListener("pointerdown", onOutsideClick, true);
  window.addEventListener("keydown", onPanelKey, true);
  follow();
}

function closePanel() {
  if (!panel.el) return;
  panel.el.remove();
  panel.el = null;
  panel.buttons = [];
  if (panel.frame) cancelAnimationFrame(panel.frame);
  panel.frame = 0;
  window.removeEventListener("pointerdown", onOutsideClick, true);
  window.removeEventListener("keydown", onPanelKey, true);
}

function onOutsideClick(e) {
  if (!panel.el || panel.el.contains(e.target)) return;
  if (anchorButton()?.contains(e.target)) return; // 点自己的按钮走 toggle 关闭
  closePanel();
}

function onPanelKey(e) {
  if (e.key === "Escape") closePanel();
}

function togglePanel() {
  if (panel.el) closePanel();
  else openPanel();
}

// 选区工具栏集成：选中两个以上时给出面板开关按钮（可在设置里关掉）
function buttonOn() {
  return app.ui?.settings?.getSettingValue?.(SETTING_TOOLBOX) !== false;
}

function toolboxCommands() {
  if (!app.canvas || !buttonOn()) return [];
  return pickedCount() >= 2 ? [PANEL_CMD] : [];
}

// ---------- 注册 ----------

// 模块一注册：参考线吸附（设置项 + 指针事件 + 绘制钩子）
app.registerExtension({
  name: "QG.SnapLines",
  setup() {
    console.log("[QG-tools] v8 已加载（参考线 + 排列 二合一）");

    try {
      app.ui.settings.addSetting({
        id: SETTING_SNAPLINES,
        category: ["QG-tools", "Canvas", "Snap into line"],
        name: zhPair("Snap into line while dragging (QG)", "拖动时对齐参考线（QG）"),
        tooltip: zhPair(
          "Show orange alignment guides while dragging or resizing nodes and groups, " +
            "and snap to them (centre lines are dashed). Hold Shift to disable it for one " +
            "drag; Alt-dragged copies take part as well.",
          "拖动或缩放节点/分组时显示橙色对齐参考线并自动吸附（中线为虚线）；" +
            "按住 Shift 拖动可临时关闭；Alt 拖动复制出的副本同样参与吸附。",
        ),
        type: "boolean",
        defaultValue: true,
        onChange: (v) => {
          enabled = !!v;
          if (!enabled) endDrag();
        },
      });

      app.ui.settings.addSetting({
        id: SETTING_WITH_GRID,
        category: ["QG-tools", "Canvas", "Snap into line"],
        name: zhPair(
          "Show alignment guides while grid snapping is on (QG)",
          "网格吸附开启时也显示参考线（QG）",
        ),
        tooltip: zhPair(
          "ComfyUI-Custom-Scripts' \"Always snap to grid\" otherwise takes over dragging " +
            "completely and the guides never appear, with no warning. Turn this on to keep " +
            "the guides visible in that mode. Note the landing position stays grid-controlled: " +
            "snapping to node edges would land off-grid and get pulled back when you release, " +
            "so this mode only shows the lines.",
          "默认情况下，ComfyUI-Custom-Scripts 的「始终对齐网格」会完全接管拖动，参考线不会出现，" +
            "而且不给任何提示。打开本项后该模式下也照常显示参考线。" +
            "注意落点仍由网格决定：节点边缘对齐多半会落在网格之外，松开鼠标时又会被网格拽回去，" +
            "所以这个模式只画线、不改位置。",
        ),
        type: "boolean",
        defaultValue: false,
        onChange: (v) => {
          withGridSnap = !!v;
        },
      });
    } catch (err) {
      console.warn("[QG-tools] 注册设置失败:", err);
    }

    // 老版本存的是 QYH.*，注册完设置就把老值搬过来，否则用户关掉的开关会被重置。
    // 下一帧再补一次：万一排列模块的设置这轮还没注册完，那次会补上。
    migrateLegacySettings();
    setTimeout(migrateLegacySettings, 0);

    // 部分前端 onChange 只在用户手动修改时触发，这里先读一次值。
    // 注意第二个参数（默认值）在前端 1.5x 已弃用，传了会被 console 警告并
    // 直接忽略，所以默认值只写在设置定义里，这里只读、只判 false。
    enabled = app.ui?.settings?.getSettingValue?.(SETTING_SNAPLINES) !== false;
    withGridSnap = app.ui?.settings?.getSettingValue?.(SETTING_WITH_GRID) === true;

    // pointerdown/up 用捕获阶段（litegraph 在 canvas 上 stopPropagation），
    // pointermove 用冒泡阶段（排在 litegraph 移动节点之后）
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", endDrag);

    if (app.canvas) hookDraw(app.canvas);
  },
});

// 模块二注册：排列面板（命令 + 选区工具栏 + 设置项 + 右键菜单）
app.registerExtension({
  name: "QG.Align",
  commands: [
    { id: PANEL_CMD, icon: ICON_CLASS, function: togglePanel,
      label: zhPair("QG Arrange: align / size / spacing", "QG 排列：对齐 / 统一尺寸 / 等间距") },
    ...TOOLS.map((t) => ({
      id: `QG.Align.${t.how}`,
      label: zhPair(`QG Arrange: ${t.en}`, `QG 排列：${t.zh}`),
      function: () => runTool(t),
    })),
  ],
  getSelectionToolboxCommands() {
    const cmds = toolboxCommands();
    if (cmds.length) requestAnimationFrame(labelAnchor);
    return cmds;
  },
  settings: [
    {
      id: SETTING_TOOLBOX,
      name: zhPair("Show QG arrange button in the selection toolbar", "选区工具栏显示 QG 排列按钮"),
      type: "boolean",
      defaultValue: true,
      category: ["QG-tools", "Canvas", "排列按钮"],
      tooltip: zhPair(
        "With two or more nodes or groups selected, an arrange button appears in the " +
          "toolbar above the selection (align / match size / distribute). Turning it off " +
          "keeps the canvas context menu entries.",
        "选中两个以上节点或分组时，选区上方的工具栏出现一个排列按钮" +
          "（对齐 / 统一尺寸 / 等间距）。关掉后仍可用画布右键菜单排列。",
      ),
      onChange(value) {
        if (value === false) closePanel();
      },
    },
  ],
  setup() {
    // 幂等：只搬「还没搬过」的键，模块一已经处理过 SnapLines 那次会跳过
    migrateLegacySettings();
    console.log("[QG-tools] 排列模块已加载 —— 选中两个以上节点后用选区工具栏按钮或右键菜单排列");
    const style = document.createElement("style");
    style.id = "qyh-align-style";
    style.textContent = styleSheet();
    document.head.append(style);
    hookContextMenu();
  },
});

// 调试钩子：测试脚本可直接驱动
window.__qyhAlignRun = runTool;
window.__qyhAlignUnits = selectionUnits;
window.__qyhAlignToggle = togglePanel;
