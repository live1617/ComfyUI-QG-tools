import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { chainCallback, keepDomWidgetWidthAuto, zhPair } from "../shared/index.mjs?v=202611141000";
import { fillNodeHeight } from "../shared/panel_layout.mjs?v=202611141000";
import { sizeFor } from "../shared/node_width.mjs?v=202611141000";
import { fitNodeToPanelHeight, unwatchVueShell, watchVueShell } from "../shared/vue_panel_fit.mjs?v=202611141000";

/* ============================================================
 * QG_OutpaintBoard —— 前端面板
 *
 * 思路：原生 widget 才是真值来源（保存、提交 prompt 都靠它），
 * 这里只把它们在画布上的显示压到 0 高，改用 DOM 面板呈现。
 * 所以面板里改的每个值都写回原生 widget，工作流兼容性不受影响。
 *
 * 面板文案一律走 zhPair(英文, 中文)：这些串汉化词典里没有，
 * zh() 查不到就只剩英文，zhPair 自带两份。
 * ============================================================ */

const NODE_CLASS = "QG_OutpaintBoard";
// 面板高度不再写死：节点拉多大，预览区就多大。
// 这里只减去标题栏和边距，剩余高度全给画布。
const CHROME_H = 34;
const PANEL_MIN_H = 220;
// Min width and the node's own floor come from SIZES in node_width.mjs, the
// same table that pins the default size - one number, not two that drift apart.
const SIZE_ENTRY = sizeFor("QG_OutpaintBoard");
const PANEL_MIN_W = SIZE_ENTRY?.minW ?? 380;
const NODE_MIN_H = SIZE_ENTRY?.minH ?? 470;
const NODE_DEFAULT_H = SIZE_ENTRY?.h ?? 645;

// 这些 widget 由面板接管显示
const MANAGED = [
  "unit", "left", "right", "top", "bottom", "max_output_side", "divisible_by", "pad_color",
];

const NUM_ROWS = [
  { name: "left", en: "Left", cn: "左", step: 1 },
  { name: "right", en: "Right", cn: "右", step: 1 },
  { name: "top", en: "Top", cn: "上", step: 1 },
  { name: "bottom", en: "Bottom", cn: "下", step: 1 },
  { name: "max_output_side", en: "Max output side", cn: "最大输出长边", step: 128 },
  { name: "divisible_by", en: "Divisible by", cn: "整除数", step: 1 },
];

const RATIO_OPTIONS = [
  { en: "Free ratio", cn: "自由比例", value: "0" },
  { label: "1:1", value: "1" },
  { label: "2:3", value: "0.6666667" },
  { label: "3:2", value: "1.5" },
  { label: "3:4", value: "0.75" },
  { label: "4:3", value: "1.3333333" },
  { label: "5:7", value: "0.7142857" },
  { label: "9:16", value: "0.5625" },
  { label: "16:9", value: "1.7777778" },
  { label: "21:9", value: "2.3333333" },
  { label: "1:2", value: "0.5" },
  { label: "2:1", value: "2" },
];

const ZOOM_OPTIONS = [
  { en: "Fit", cn: "适应", value: "fit" },
  { label: "1%", value: "1" },
  { label: "2%", value: "2" },
  { label: "5%", value: "5" },
  { label: "12.5%", value: "12.5" },
  { label: "25%", value: "25" },
  { label: "50%", value: "50" },
  { label: "100%", value: "100" },
];

// 滚轮缩放的边界（倍数）。下限放到 1%：5% 看一张两万像素的长图还是只能看到一小块，
// 想纵览整体布局就够不着了。再小只剩像素噪点，没有意义。
const ZOOM_MIN = 0.01;
const ZOOM_MAX = 8;

const CSS = `
.qgtools-obp-root {
  position: relative;
  display: flex; flex-direction: column; gap: 5px;
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  font: 12px/1.45 "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  color: var(--input-text, #dcdcdc);
  user-select: none;
}
.qgtools-obp-row {
  display: flex; align-items: center; height: 26px; flex: 0 0 auto;
  border-radius: 6px;
  background: var(--comfy-input-bg, rgba(255,255,255,0.07));
}
.qgtools-obp-arw {
  width: 22px; height: 22px; margin: 0 2px; padding: 0;
  border: 0; border-radius: 4px; background: transparent;
  color: inherit; font-size: 10px; line-height: 1;
  cursor: pointer; opacity: .7;
  display: flex; align-items: center; justify-content: center;
}
.qgtools-obp-arw:hover { background: rgba(255,255,255,0.14); opacity: 1; }
.qgtools-obp-arw:active { transform: scale(0.92); }
.qgtools-obp-lbl { padding: 0 2px 0 2px; white-space: nowrap; opacity: .92; }
.qgtools-obp-val {
  flex: 1 1 auto; text-align: right; padding-right: 4px;
  font-variant-numeric: tabular-nums; cursor: text;
}
.qgtools-obp-val:hover { color: #fff; }
.qgtools-obp-edit {
  flex: 1 1 auto; min-width: 0; height: 20px; margin-right: 4px;
  border: 1px solid rgba(140,170,255,0.8); border-radius: 4px;
  background: rgba(0,0,0,0.35); color: inherit; text-align: right;
  font: inherit; padding: 0 4px; outline: none;
}
.qgtools-obp-gap { flex: 1 1 auto; }
.qgtools-obp-sel {
  flex: 0 0 auto; width: auto; max-width: 104px;
  height: 22px; margin-right: 2px; padding: 0 4px;
  border: 0; border-radius: 4px; background: transparent;
  color: inherit; font: inherit; cursor: pointer; outline: none;
}
.qgtools-obp-sel-narrow { max-width: 70px; }
.qgtools-obp-sel option { background: #2b2b2b; color: #ddd; }
.qgtools-obp-color {
  position: relative; display: flex; align-items: center; justify-content: center;
  height: 26px; flex: 0 0 auto; border-radius: 6px; cursor: pointer;
  background: var(--comfy-input-bg, rgba(255,255,255,0.07));
  overflow: hidden;
}
.qgtools-obp-color input {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: 0; border: 0; padding: 0; cursor: pointer;
}
.qgtools-obp-color span { pointer-events: none; opacity: .92; }
.qgtools-obp-tools { display: flex; align-items: center; gap: 6px; height: 28px; flex: 0 0 auto; }
.qgtools-obp-btn {
  height: 24px; padding: 0 9px; border-radius: 6px;
  border: 1px solid rgba(140,140,140,0.45);
  background: rgba(255,255,255,0.08); color: inherit;
  font: inherit; cursor: pointer;
}
.qgtools-obp-btn:hover { background: rgba(255,255,255,0.18); }
.qgtools-obp-btn:active { transform: translateY(1px); }
.qgtools-obp-status {
  flex: 1 1 auto; min-width: 0; text-align: right; font-size: 11px; opacity: .62;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qgtools-obp-view {
  /* flex-basis 0, not auto: with auto the preview sizes itself from its
     content, and Nodes 2.0 lets that push the node taller (see
     DEVELOPMENT.md, the flex-basis rule). The floor below still stops it
     collapsing to a sliver. */
  position: relative; flex: 1 1 0; min-height: 60px;
  border-radius: 6px; overflow: hidden;
  /* 透明棋盘格：空出来的地方一眼能看出是"没有像素"，不是黑色 */
  background-color: #14161a;
  background-image:
    linear-gradient(45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,0.05) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.05) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.05) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.qgtools-obp-canvas { display: block; width: 100%; height: 100%; touch-action: none; }
/* 准星走 DOM：鼠标在画板里移动只挪这一个 1px 层，不重绘画布，
   否则每动一下就重采样一遍图像，看起来像"飘" */
.qgtools-obp-cursor {
  position: absolute; left: 0; top: 0; width: 19px; height: 19px;
  margin: -9px 0 0 -9px; pointer-events: none; display: none;
  z-index: 3; will-change: transform;
}
.qgtools-obp-cursor::before, .qgtools-obp-cursor::after {
  content: ""; position: absolute; background: #fff;
  filter: drop-shadow(0 0 0.7px rgba(0,0,0,0.9)) drop-shadow(0 0 0.7px rgba(0,0,0,0.9));
}
.qgtools-obp-cursor::before { left: 0; right: 0; top: 9px; height: 1px; }
.qgtools-obp-cursor::after { top: 0; bottom: 0; left: 9px; width: 1px; }
.qgtools-obp-dragging { cursor: ew-resize; }

/* 底部：左边尺寸，右边齿轮 */
.qgtools-obp-foot {
  display: flex; align-items: center; gap: 6px;
  height: 22px; flex: 0 0 auto;
}
.qgtools-obp-size {
  flex: 1 1 auto; min-width: 0; font-size: 11px; opacity: .7;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qgtools-obp-gear {
  width: 22px; height: 22px; flex: 0 0 auto; padding: 0;
  border: 0; border-radius: 5px; background: transparent;
  color: inherit; cursor: pointer; opacity: .62;
  display: flex; align-items: center; justify-content: center;
}
.qgtools-obp-gear:hover { background: rgba(255,255,255,0.14); opacity: 1; }
.qgtools-obp-gear.is-on { opacity: 1; color: #FFA23A; background: rgba(255,162,58,0.18); }

/* 设置面板：盖住整块面板，参数都在这里 */
/* 设置卡：浮在节点右侧，预览一点都不挡 */
.qgtools-obp-sheet {
  position: absolute; top: 0; left: calc(100% + 10px); z-index: 9;
  width: 248px; max-height: 100%;
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px 10px; box-sizing: border-box;
  border-radius: 8px;
  background: #1b1e25;
  border: 1px solid rgba(255,255,255,0.1);
  box-shadow: 0 8px 26px rgba(0,0,0,0.55);
  opacity: 0; transform: translateX(-8px); pointer-events: none;
  transition: opacity .13s ease, transform .13s ease;
}
.qgtools-obp-sheet.is-open { opacity: 1; transform: none; pointer-events: auto; }
/* 右边放不下就翻到左边 */
.qgtools-obp-sheet.is-left {
  left: auto; right: calc(100% + 10px);
  transform: translateX(8px);
}
.qgtools-obp-sheet.is-left.is-open { transform: none; }
.qgtools-obp-sheet-head { display: flex; align-items: center; gap: 6px; height: 22px; flex: 0 0 auto; }
.qgtools-obp-sheet-title { flex: 1 1 auto; font-weight: 600; opacity: .92; }
.qgtools-obp-x {
  width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px;
  background: transparent; color: inherit; cursor: pointer; opacity: .6;
  font: 15px/1 "Microsoft YaHei", system-ui, sans-serif;
  display: flex; align-items: center; justify-content: center;
}
.qgtools-obp-x:hover { background: rgba(255,255,255,0.14); opacity: 1; }
.qgtools-obp-sheet-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 5px; padding-right: 2px;
}
.qgtools-obp-sheet-body::-webkit-scrollbar { width: 6px; }
.qgtools-obp-sheet-body::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.18); border-radius: 3px;
}
`;

function ensureStyle() {
  if (document.getElementById("qgtools-obp-style")) return;
  const tag = document.createElement("style");
  tag.id = "qgtools-obp-style";
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function widgetOf(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function valueOf(node, name, fallback) {
  const w = widgetOf(node, name);
  return w ? w.value : fallback;
}

function setValue(node, name, value) {
  const w = widgetOf(node, name);
  if (!w) return;
  if (w.value === value) return;
  w.value = value;
  try {
    w.callback?.(value, app.canvas, node);
  } catch (err) {
    /* 某些节点的回调签名不同，失败不影响取值 */
  }
  node.setDirtyCanvas?.(true, true);
}

// 用 widget 自己的 min/max 钳 —— 那是后端 INPUT_TYPES 定下的，唯一真相源。
// 以前面板只 Math.max(0, ...)：在数字框里敲 999999 会原样存进工作流，面板一直
// 显示 999999，而实际补边被上限（16384）截住，看着像面板在说谎。
function clampValue(node, name, value) {
  const w = widgetOf(node, name);
  const rawMin = Number(w?.options?.min);
  const rawMax = Number(w?.options?.max);
  const min = Number.isFinite(rawMin) ? rawMin : 0;
  let out = Math.round(Number(value) || 0);
  out = Math.max(min, out);
  if (Number.isFinite(rawMax) && rawMax > 0) out = Math.min(out, rawMax);
  return out;
}

function hexOf(text) {
  const s = String(text || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toUpperCase();
  }
  const parts = s.split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    const v = parts.map((n) => (n > 1 ? n : n * 255));
    return (
      "#" +
      v
        .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
        .join("")
    ).toUpperCase();
  }
  return "#808080";
}

/* ---------- 与后端完全一致的尺寸推演 ---------- */

// 和后端 nodes/qg_outpaint_board.py 里的 PAD_LIMIT 是同一个数：单边补边的上限。
// 前端不钳的话，percent 模式下 1024 宽的图填 1700% 就会预览出 17408 的边，而后端
// 只出 16384 —— 「预览即输出」的卖点先在这里破掉。改一处必须改另一处，
// tools/_check_outpaint_layout.py 会盯着。
const PAD_LIMIT = 16384;

// 后端用的是 Python 的 round()，那是银行家舍入（.5 取偶）：round(2.5) === 2。
// JS 的 Math.round 是四舍五入（2.5 -> 3）。percent 模式下 250 宽的图填 1%，
// 精确落在 2.5 上 —— 预览每边 3 像素、后端每边 2 像素，整张图差 2×2。
function roundHalfEven(x) {
  const whole = Math.floor(x);
  const rest = x - whole;
  if (rest > 0.5) return whole + 1;
  if (rest < 0.5) return whole;
  return whole % 2 === 0 ? whole : whole + 1;
}

function scalePair(a, b, allow) {
  const total = a + b;
  if (total <= allow) return [a, b];
  if (allow <= 0) return [0, 0];
  const k = allow / total;
  const na = Math.floor(a * k);
  return [Math.max(0, na), Math.max(0, allow - na)];
}

// 把 v 钳在两个边界之间，**不假设 a、b 谁大**。
// 平移的边界就有大小翻转的情况：图比预览区窄时两个边界是「贴左 / 贴右」，
// 图比预览区宽时正好反过来（上限反而更小）。用 Math.max(Math.min(v, b), a)
// 在后一种情况下会把结果锁死在 a —— 放大之后拖 40 像素，画面直接跳到最左边。
function clampBetween(v, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(hi, v));
}

function computeLayout(node, iw, ih) {
  const unit = valueOf(node, "unit", "pixels") || "pixels";
  // 与后端 _to_px + 那行 min(PAD_LIMIT, max(0, ...)) 一一对应，三步顺序不能换。
  const px = (name, base) => {
    const v = Number(valueOf(node, name, 0)) || 0;
    const raw = unit === "percent" ? (base * v) / 100 : v;
    return Math.min(PAD_LIMIT, Math.max(0, roundHalfEven(raw)));
  };

  let l = px("left", iw);
  let r = px("right", iw);
  let t = px("top", ih);
  let b = px("bottom", ih);

  const maxSide = Number(valueOf(node, "max_output_side", 0)) || 0;
  const divisor = Number(valueOf(node, "divisible_by", 0)) || 0;

  if (maxSide > 0) {
    if (iw > maxSide || ih > maxSide) {
      // 和后端同一规则：原图本身越界时整体放弃补边，避免预览与实际输出不一致
      l = r = t = b = 0;
    } else {
      [l, r] = scalePair(l, r, maxSide - iw);
      [t, b] = scalePair(t, b, maxSide - ih);
    }
  }

  let bw = iw + l + r;
  let bh = ih + t + b;

  if (divisor > 1) {
    const nw = Math.ceil(bw / divisor) * divisor;
    const nh = Math.ceil(bh / divisor) * divisor;
    r += nw - bw;
    b += nh - bh;
    bw = nw;
    bh = nh;
  }

  return { iw, ih, l, r, t, b, bw, bh };
}

/* ---------- 面板 ---------- */

function buildPanel(node) {
  ensureStyle();

  const state = {
    img: null,
    imgW: 0,
    imgH: 0,
    fileName: "",
    loading: false,             // 读图中：防止上游换图时连开好几个请求
    failedFile: "",             // 上次读失败的文件，别每帧重试；点「加载」清空
    zoomPct: 0,                 // 0 = 适应（按画板自动缩放），其它值为绝对比例
    pan: { x: 0, y: 0 },        // 手动平移（只在非适应时生效）
    canvas: null,
    ctx: null,
    geo: null,
    drag: null,
    hover: null,
    hoverHandle: null,
    pending: null,
    moving: null,
    panning: null,
    pointer: null,             // 鼠标在预览里的位置（局部坐标），画准星用
    rows: [],
    raf: 0,
  };
  node.__obp = state;

  const root = el("div", "qgtools-obp-root");
  // 不写死高度：由外层 widget 容器决定，节点拉大拉小预览区跟着变
  root.style.height = "100%";
  root.style.minHeight = "0";

  /* --- 设置面板（齿轮打开）：所有参数都收在这里 --- */
  const sheet = el("div", "qgtools-obp-sheet");
  const sheetHead = el("div", "qgtools-obp-sheet-head");
  const sheetTitle = el("span", "qgtools-obp-sheet-title", zhPair("Settings", "参数设置"));
  const btnClose = el("button", "qgtools-obp-x", "×");
  btnClose.type = "button";
  btnClose.title = zhPair("Close", "关闭");
  sheetHead.append(sheetTitle, btnClose);
  const sheetBody = el("div", "qgtools-obp-sheet-body");
  sheet.append(sheetHead, sheetBody);
  state.sheet = sheet;

  /* --- 数字行 --- */
  const makeNumRow = (name, label, step) => {
    const row = el("div", "qgtools-obp-row");
    const minus = el("button", "qgtools-obp-arw", "◀");
    const lbl = el("span", "qgtools-obp-lbl", label);
    const val = el("span", "qgtools-obp-val", "0");
    const plus = el("button", "qgtools-obp-arw", "▶");
    minus.type = "button";
    plus.type = "button";
    minus.title = zhPair("Decrease (hold Shift for " + step * 10 + ") ",
    "减少（按住 Shift 一次 " + step * 10 + "）");
    plus.title = zhPair("Increase (hold Shift for " + step * 10 + ") ",
    "增加（按住 Shift 一次 " + step * 10 + "）");
    row.append(minus, lbl, val, plus);

    const nudge = (delta) => {
      const cur = Number(valueOf(node, name, 0)) || 0;
      setValue(node, name, clampValue(node, name, cur + delta));
      schedule();
    };

    minus.addEventListener("pointerdown", (e) => e.stopPropagation());
    plus.addEventListener("pointerdown", (e) => e.stopPropagation());
    minus.addEventListener("click", (e) => {
      e.stopPropagation();
      nudge(e.shiftKey ? -step * 10 : -step);
    });
    plus.addEventListener("click", (e) => {
      e.stopPropagation();
      nudge(e.shiftKey ? step * 10 : step);
    });

    // 点数值就地编辑
    val.addEventListener("pointerdown", (e) => e.stopPropagation());
    val.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.querySelector("input")) return;
      const box = el("input", "qgtools-obp-edit");
      box.type = "number";
      box.min = "0";
      box.value = String(Number(valueOf(node, name, 0)) || 0);
      val.replaceWith(box);
      box.focus();
      box.select();
      // 提交只许发生一次。按 Enter 走 keydown → commit，而 replaceWith 把 input
      // 摘下来时会同步派发 blur，blur 又调一次 commit —— 那时 box 已经不是父节点
      // 的子节点，replaceWith 抛 NotFoundError，后面的 schedule() 也就没跑
      // （面板上的数值不刷新）。isConnected 挡不住这个重入，得自己立标志。
      let committed = false;
      const commit = (ok) => {
        if (committed) return;
        committed = true;
        // 输入框已经不在文档里（节点被删）就什么都不做，和以前一样
        if (box.isConnected) {
          if (ok) setValue(node, name, clampValue(node, name, Number(box.value) || 0));
          box.replaceWith(val);
        }
        schedule();
      };
      box.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") commit(true);
        else if (ev.key === "Escape") commit(false);
      });
      box.addEventListener("blur", () => commit(true));
      box.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    });

    state.rows.push({ name, val, box: row });
    sheetBody.appendChild(row);
    return row;
  };

  /* --- 单位行 --- */
  const unitRow = el("div", "qgtools-obp-row");
  unitRow.append(el("button", "qgtools-obp-arw", "◀"));
  unitRow.append(el("span", "qgtools-obp-lbl", zhPair("Unit", "单位")));
  const unitGap = el("span", "qgtools-obp-gap");
  unitRow.append(unitGap);
  const unitSel = el("select", "qgtools-obp-sel");
  [["pixels", "Pixels", "像素"], ["percent", "Percent", "百分比"]].forEach(
    ([v, en, cn]) => {
      const opt = el("option", null, zhPair(en, cn));
      opt.value = v;
      unitSel.appendChild(opt);
    }
  );
  const unitTail = el("button", "qgtools-obp-arw", "▶");
  unitRow.append(unitSel, unitTail);
  unitRow.children[0].type = "button";
  unitTail.type = "button";
  const unitList = ["pixels", "percent"];
  const stepUnit = (d) => {
    const cur = valueOf(node, "unit", "pixels") || "pixels";
    const i = Math.max(0, unitList.indexOf(cur));
    const next = unitList[Math.min(unitList.length - 1, Math.max(0, i + d))];
    setValue(node, "unit", next);
    schedule();
  };
  unitRow.children[0].addEventListener("pointerdown", (e) => e.stopPropagation());
  unitTail.addEventListener("pointerdown", (e) => e.stopPropagation());
  unitRow.children[0].addEventListener("click", (e) => {
    e.stopPropagation();
    stepUnit(-1);
  });
  unitTail.addEventListener("click", (e) => {
    e.stopPropagation();
    stepUnit(1);
  });
  unitSel.addEventListener("pointerdown", (e) => e.stopPropagation());
  unitSel.addEventListener("change", () => {
    setValue(node, "unit", unitSel.value);
    schedule();
  });
  sheetBody.appendChild(unitRow);

  /* --- 四个方向 + 两个约束 --- */
  NUM_ROWS.forEach((cfg) => makeNumRow(cfg.name, zhPair(cfg.en, cfg.cn), cfg.step));

  /* --- 补边颜色 --- */
  const colorWrap = el("div", "qgtools-obp-color");
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorWrap.append(colorInput);
  const colorTxt = el("span", null, zhPair("Pad colour", "补边颜色") + " (#808080)");
  colorWrap.append(colorTxt);
  colorWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
  colorInput.addEventListener("input", () => {
    setValue(node, "pad_color", colorInput.value.toUpperCase());
    schedule();
  });
  sheetBody.appendChild(colorWrap);

  /* --- 工具条 --- */
  const tools = el("div", "qgtools-obp-tools");
  const btnLoad = el("button", "qgtools-obp-btn", zhPair("Load", "加载"));
  const btnReset = el("button", "qgtools-obp-btn", zhPair("Reset", "复位"));
  const ratioSel = el("select", "qgtools-obp-sel");
  // 数组项有两种写法：要翻译的给 en/cn，比例这类中英同形的只给 label。
  // 早先一律读 o.en/o.cn，没有这两个字段的项就成了空字符串 —— 下拉里一片空白。
  const optionText = (o) => (o.cn ? zhPair(o.en, o.cn) : o.label ?? String(o.value));
  RATIO_OPTIONS.forEach((o) => {
    const opt = el("option", null, optionText(o));
    opt.value = o.value;
    ratioSel.appendChild(opt);
  });
  const zoomSel = el("select", "qgtools-obp-sel qgtools-obp-sel-narrow");
  ZOOM_OPTIONS.forEach((o) => {
    const opt = el("option", null, optionText(o));
    opt.value = o.value;
    zoomSel.appendChild(opt);
  });
  // 滚轮缩放会落在任意比例上，给它一个占位项显示实际值
  const zoomCustom = el("option", null, zhPair("Custom", "自定义"));
  zoomCustom.value = "custom";
  zoomSel.appendChild(zoomCustom);
  tools.append(btnLoad, btnReset, el("span", "qgtools-obp-gap"), ratioSel, zoomSel);
  tools.title = "";
  btnLoad.type = "button";
  btnReset.type = "button";
  [btnLoad, btnReset, ratioSel, zoomSel].forEach((n) =>
    n.addEventListener("pointerdown", (e) => e.stopPropagation())
  );
  ratioSel.addEventListener("change", () => {
    const r = parseFloat(ratioSel.value) || 0;
    if (r > 0) applyRatio(r);
    else schedule();
  });
  btnLoad.addEventListener("click", (e) => {
    e.stopPropagation();
    loadSource(true);
  });
  btnReset.addEventListener("click", (e) => {
    e.stopPropagation();
    resetParams();
  });
  zoomSel.addEventListener("change", () => {
    const v = zoomSel.value;
    if (v === "custom") return;          // 占位项，不代表任何操作
    if (v === "fit") setZoom(0);
    // 选项里写的是百分数（"25" = 25%），setZoom 收的是倍数 —— 之前直接
    // parseFloat 传进去，选 25% 会变成 2500%。
    else setZoom(parseFloat(v) / 100);
  });
  root.appendChild(tools);

  /* --- 预览 --- */
  const view = el("div", "qgtools-obp-view");
  const canvas = document.createElement("canvas");
  canvas.className = "qgtools-obp-canvas";
  const cursorEl = el("div", "qgtools-obp-cursor");
  view.appendChild(canvas);
  view.appendChild(cursorEl);

  /* --- 底部：左边尺寸，右边齿轮 --- */
  const foot = el("div", "qgtools-obp-foot");
  const status = el("span", "qgtools-obp-size", zhPair("Waiting for image", "等待图像"));
  const gear = el("button", "qgtools-obp-gear");
  gear.type = "button";
  gear.title = zhPair("Settings", "参数设置");
  // 齿轮图标（feather settings），用 SVG 是为了在任何缩放/主题下都清晰
  gear.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M19.1 14.6a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    "</svg>";
  foot.append(status, gear);
  root.append(view, foot, sheet);

  /* --- 设置面板开关 --- */
  // 卡片默认浮在节点右边；右边放不下就翻到左边
  function placeSheet() {
    if (!state.sheetOpen) return;
    sheet.classList.remove("is-left");
    const r = sheet.getBoundingClientRect();
    if (r.right > window.innerWidth - 6) sheet.classList.add("is-left");
  }
  function setSheet(open) {
    state.sheetOpen = !!open;
    sheet.classList.toggle("is-open", state.sheetOpen);
    gear.classList.toggle("is-on", state.sheetOpen);
    if (state.sheetOpen) {
      document.addEventListener("keydown", onSheetKey, true);
      document.addEventListener("pointerdown", onSheetDown, true);
      window.addEventListener("resize", placeSheet);
      requestAnimationFrame(placeSheet);
    } else {
      document.removeEventListener("keydown", onSheetKey, true);
      document.removeEventListener("pointerdown", onSheetDown, true);
      window.removeEventListener("resize", placeSheet);
    }
  }
  function onSheetKey(ev) {
    if (ev.key === "Escape" && state.sheetOpen) {
      ev.stopPropagation();
      setSheet(false);
    }
  }
  // 点面板以外的地方收起。点预览不算"外面"——那样可以边看边调，点图扩边也不会把卡片关掉
  function onSheetDown(ev) {
    if (!state.sheetOpen) return;
    if (root.contains(ev.target)) return;
    setSheet(false);
  }
  state.setSheet = setSheet;
  [gear, btnClose].forEach((b) =>
    b.addEventListener("pointerdown", (e) => e.stopPropagation())
  );
  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    setSheet(!state.sheetOpen);
  });
  btnClose.addEventListener("click", (e) => {
    e.stopPropagation();
    setSheet(false);
  });
  // 面板里的点击/滚轮不要漏到图布上去（否则会拖动节点、缩放整个节点图）
  sheet.addEventListener("pointerdown", (e) => e.stopPropagation());
  sheet.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  state.canvas = canvas;
  state.ctx = canvas.getContext("2d");
  state.status = status;
  state.cursorEl = cursorEl;

  // 只挪 DOM 准星，不碰画布——这是"鼠标移动不飘"的关键
  function placeCursor(p) {
    if (!p) {
      cursorEl.style.display = "none";
      return;
    }
    cursorEl.style.display = "block";
    // 面板被整体缩放了，准星也要反向缩一次，否则节点放大到 200% 时
    // 它会变成一根大十字，缩小到 60% 时又糊成一个小点
    const k = state.uiScale || 1;
    cursorEl.style.transform =
      "translate(" + p.x + "px," + p.y + "px) scale(" + (1 / k) + ")";
  }

  /* ---------- 刷新 ---------- */
  function refreshWidgets() {
    const unit = valueOf(node, "unit", "pixels") || "pixels";
    unitSel.value = unit;
    const suffix = unit === "percent" ? "%" : "";
    state.rows.forEach(({ name, val }) => {
      const v = Number(valueOf(node, name, 0)) || 0;
      val.textContent = v + suffix;
    });
    const hex = hexOf(valueOf(node, "pad_color", "#808080"));
    if (colorInput.value.toUpperCase() !== hex) colorInput.value = hex.toLowerCase();
    colorTxt.textContent = zhPair("Pad colour", "补边颜色") + " (" + hex + ")";
    // 左侧一条实色竖条 + 极淡的色染，既能看出颜色又不会让文字看不清
    colorWrap.style.boxShadow = "inset 3px 0 0 " + hex;
    colorWrap.style.background =
      "linear-gradient(90deg, " + hex + "2E, transparent 46%)";
  }

  function schedule() {
    refreshWidgets();
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      draw();
    });
  }
  state.refresh = schedule;

  /* ---------- 缩放 ---------- */
  function syncZoomSel() {
    if (!state.zoomPct) {
      zoomSel.value = "fit";
      return;
    }
    const pct = state.zoomPct * 100;
    const hit = ZOOM_OPTIONS.find(
      (o) => o.value !== "fit" && Math.abs(parseFloat(o.value) - pct) < 0.05
    );
    if (hit) {
      zoomSel.value = hit.value;
      return;
    }
    zoomCustom.textContent = (Math.round(pct * 10) / 10) + "%";
    zoomSel.value = "custom";
  }

  // pct<=0 表示"适应"；keepPan=true 时保留平移（滚轮缩放要用）
  function setZoom(pct, keepPan) {
    const next = pct > 0 ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pct)) : 0;
    state.zoomPct = next;
    if (!next) state.pan = { x: 0, y: 0 };
    else if (!keepPan) state.pan = { x: 0, y: 0 };
    syncZoomSel();
    schedule();
  }
  state.setZoom = setZoom;

  // 从「适应」切到固定比例：扩边时缩放必须钉住不动。
  // 否则画板一变大，适应比例就重算变小，整块画面跟着缩——
  // 看起来就是"点了半天没扩出去"，也就是孤海那种"缩放到多少就按多少画"。
  function freezeZoom() {
    if (state.zoomPct > 0) return;
    const g = state.geo;
    if (!g || !g.scale) return;
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    state.zoomPct = g.scale;
    // 保持画板当前屏幕位置，切过去不能跳
    state.pan = {
      x: g.x - (cw - g.bw * g.scale) / 2,
      y: g.y - (ch - g.bh * g.scale) / 2,
    };
    syncZoomSel();
  }

  // 把内容框钉在给定的屏幕坐标上（改补边时图像不许动，只有画板往外长）
  function anchorContent(cx0, cy0) {
    const g = state.geo;
    if (!g || !state.zoomPct) return;
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    state.pan = {
      x: cx0 - g.l * g.scale - (cw - g.bw * g.scale) / 2,
      y: cy0 - g.t * g.scale - (ch - g.bh * g.scale) / 2,
    };
  }

  const BOARD_LINE = "#FFA23A";
// 画板四周留白：既要放得下四边数字，也要留出可以点"画板外面"的空隙。
// draw 的 fit 和 applyPlan 判断"装不装得下"必须用同一个数，否则两边打架。
const VIEW_MARGIN = 30;
  const BOARD_LINE_HOT = "#FFD08A";

  function labelPaint(ctx, text, cx, cy, vertical, hot) {
    ctx.save();
    ctx.translate(cx, cy);
    if (vertical) ctx.rotate(-Math.PI / 2);
    ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = hot ? BOARD_LINE_HOT : "rgba(255,238,218,0.95)";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function draw() {
    state.drawCount = (state.drawCount || 0) + 1;
    const cvs = state.canvas;
    const ctx = state.ctx;
    if (!cvs || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(60, cvs.clientWidth || 0);
    const ch = Math.max(60, cvs.clientHeight || 0);
    if (cvs.width !== Math.round(cw * dpr) || cvs.height !== Math.round(ch * dpr)) {
      cvs.width = Math.round(cw * dpr);
      cvs.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    if (!state.img) {
      state.geo = null;
      ctx.fillStyle = "rgba(170,170,170,0.75)";
      ctx.font = '12px "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
      zhPair(
        "Waiting for an image upstream: connect a Load Image node and it shows up here, or press Load above.",
        "等待上游图像：接入加载图像节点后自动载入，也可点上方「加载」。"
      ),
      cw / 2,
      ch / 2
    );
      return;
    }

    const img = state.img;
    const geo = computeLayout(node, state.imgW || img.width, state.imgH || img.height);

    // 四边要放数值，也要留出可点的空隙
    const margin = VIEW_MARGIN;
    const fit = Math.min((cw - margin * 2) / geo.bw, (ch - margin * 2) / geo.bh);

    const drag = state.drag;
    const scale = drag
      ? drag.anchor.scale
      : Math.max(0.002, state.zoomPct > 0 ? state.zoomPct : fit);

    // 居中基准是「画板」，不是内容框。
    // 之前的写法让内容框居中，补边一多，补得多的那一侧（常见是右/下）
    // 就被推出画布外：看不见、也抓不到边框，于是"上和左能拖，右和下拖不动"。
    // 改成画板居中后，四条边永远在可视区内。
    const panX = state.zoomPct > 0 && !drag ? state.pan.x : 0;
    const panY = state.zoomPct > 0 && !drag ? state.pan.y : 0;
    const x = drag ? drag.anchor.cx - geo.l * scale : (cw - geo.bw * scale) / 2 + panX;
    const y = drag ? drag.anchor.cy - geo.t * scale : (ch - geo.bh * scale) / 2 + panY;

    const bw = geo.bw * scale;
    const bh = geo.bh * scale;
    const cbox = {
      x0: x + geo.l * scale,
      y0: y + geo.t * scale,
      x1: x + (geo.l + geo.iw) * scale,
      y1: y + (geo.t + geo.ih) * scale,
    };

    ctx.fillStyle = hexOf(valueOf(node, "pad_color", "#808080"));
    ctx.fillRect(x, y, bw, bh);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, cbox.x0, cbox.y0, geo.iw * scale, geo.ih * scale);

    const hot = drag ? drag.handle : "";

    // 画板外框：琥珀色实线。这一圈就是可以拖的把手，
    // 之前只认内容框边界，补边一大就拖不到了。
    ctx.strokeStyle = BOARD_LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, bw, bh);

    if (hot) {
      ctx.strokeStyle = BOARD_LINE_HOT;
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (hot.indexOf("top") >= 0) { ctx.moveTo(x, y); ctx.lineTo(x + bw, y); }
      if (hot.indexOf("bottom") >= 0) { ctx.moveTo(x, y + bh); ctx.lineTo(x + bw, y + bh); }
      if (hot.indexOf("left") >= 0) { ctx.moveTo(x, y); ctx.lineTo(x, y + bh); }
      if (hot.indexOf("right") >= 0) { ctx.moveTo(x + bw, y); ctx.lineTo(x + bw, y + bh); }
      ctx.stroke();
    }

    // 悬停时的"将要变成什么样"：边界吸到鼠标处，虚线框就是新画板
    const cur = {
      ...geo, x, y, scale,
      box: { x0: x, y0: y, x1: x + bw, y1: y + bh },
    };
    let plan = (!drag && state.hover) ? planAt(cur, state.hover.x, state.hover.y) : null;
    // 悬停 + Shift：对侧也画出虚线（孤海的交互）。鼠标在边框上时用 handle 推对侧，
    // 在条带/外侧时按"plan 改了哪侧"推对侧；补边为 0 导致 planAt 无结果时也用 handle 兜底。
    if (!drag && state.shiftHeld) {
      if (plan) {
        plan = symmetricPlan(plan, state.hoverHandle, geo);
      } else if (state.hoverHandle) {
        plan = symmetricPlan({ l: geo.l, r: geo.r, t: geo.t, b: geo.b }, state.hoverHandle, geo);
      }
    }
    if (plan) {
      const nx = x + (geo.l - plan.l) * scale;
      const ny = y + (geo.t - plan.t) * scale;
      const nw = (plan.l + geo.iw + plan.r) * scale;
      const nh = (plan.t + geo.ih + plan.b) * scale;
      ctx.save();
      ctx.strokeStyle = "rgba(255,208,138,0.95)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(nx + 0.5, ny + 0.5, nw, nh);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 内容框：虚线，标出图像本身占的范围
    ctx.strokeStyle = "rgba(255,255,255,0.62)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(cbox.x0 + 0.5, cbox.y0 + 0.5, cbox.x1 - cbox.x0, cbox.y1 - cbox.y0);
    ctx.setLineDash([]);

    // 中心准心：先黑描边再白线，浅色画面上也看得见
    const ccx = (cbox.x0 + cbox.x1) / 2;
    const ccy = (cbox.y0 + cbox.y1) / 2;
    ctx.save();
    ctx.lineCap = "round";
    [
      ["rgba(0,0,0,0.5)", 3],
      ["rgba(255,255,255,0.88)", 1.2],
    ].forEach(([color, w]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(ccx - 9, ccy);
      ctx.lineTo(ccx + 9, ccy);
      ctx.moveTo(ccx, ccy - 9);
      ctx.lineTo(ccx, ccy + 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ccx, ccy, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();

    // 四边数值：悬停时直接显示"点下去会变成多少"，这才是实时的含义
    const unit = valueOf(node, "unit", "pixels") || "pixels";
    const fmt = (v) => (unit === "percent" ? Math.round(v) + "%" : String(Math.round(v)));
    const vT = plan ? plan.t : geo.t;
    const vB = plan ? plan.b : geo.b;
    const vL = plan ? plan.l : geo.l;
    const vR = plan ? plan.r : geo.r;
    const above = y - 9 >= 8;
    const below = y + bh + 9 <= ch - 6;
    const leftRoom = x - 10 >= 14;
    const rightRoom = x + bw + 10 <= cw - 14;

    labelPaint(ctx, fmt(vT), (cbox.x0 + cbox.x1) / 2,
      above ? y - 9 : y + 11, false, hot.indexOf("top") >= 0 || (plan && vT !== geo.t));
    labelPaint(ctx, fmt(vB), (cbox.x0 + cbox.x1) / 2,
      below ? y + bh + 9 : y + bh - 11, false, hot.indexOf("bottom") >= 0 || (plan && vB !== geo.b));
    labelPaint(ctx, fmt(vL), leftRoom ? x - 11 : x + 13, (cbox.y0 + cbox.y1) / 2,
      true, hot.indexOf("left") >= 0 || (plan && vL !== geo.l));
    labelPaint(ctx, fmt(vR), rightRoom ? x + bw + 11 : x + bw - 13, (cbox.y0 + cbox.y1) / 2,
      true, hot.indexOf("right") >= 0 || (plan && vR !== geo.r));

    state.geo = { ...cur, cbox };

    const pct = Math.round(scale * 1000) / 10;
    state.pctLabel = pct + "%";
    status.textContent = footprintText();
    if (state.fileName) status.title = state.fileName + " · " + state.pctLabel;

    // 手改了补边后比例就不再成立，下拉回到自由，别骗人
    if (ratioSel.value !== "0") {
      const target = parseFloat(ratioSel.value) || 0;
      if (target > 0 && Math.abs(geo.bw / geo.bh / target - 1) > 0.02) {
        ratioSel.value = "0";
      }
    }
  }

  /* ---------- 取上游图像 ---------- */
  // 找到「上游把图片文件名存在哪个控件里」。返回控件本身（要挂 callback 监听换图），
  // 不只是值 —— 早先只返回值，所以上游换图后画板一直停在旧图上。
  function pickSourceWidget(srcNode) {
    const keys = ["image", "image_name", "file", "filename"];
    for (const k of keys) {
      const w = (srcNode.widgets || []).find(
        (x) => x.name === k && typeof x.value === "string" && x.value.trim()
      );
      if (w) return w;
    }
    return (
      (srcNode.widgets || []).find(
        (x) =>
          typeof x.value === "string" &&
          /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(x.value)
      ) || null
    );
  }

  // 监听上游控件的后续变化。上游可能是任意节点，所以每次换连线都要重挂；
  // 原 callback 必须原样转出去，不然会顶掉上游自己的行为。
  const bind = { srcNode: null, widget: null, original: null };

  function unbindSource() {
    if (bind.widget) {
      try {
        bind.widget.callback = bind.original;
      } catch (err) {
        /* 控件已被重建，改不回去也无所谓 */
      }
    }
    bind.srcNode = null;
    bind.widget = null;
    bind.original = null;
  }

  function bindSource(srcNode, widget) {
    if (!widget) {
      unbindSource();
      return;
    }
    if (bind.widget === widget && bind.srcNode === srcNode) return;
    unbindSource();
    const prev = widget.callback;
    bind.srcNode = srcNode;
    bind.widget = widget;
    bind.original = prev;
    widget.callback = function () {
      const out = prev?.apply(this, arguments);
      state.fileName = "";
      state.failedFile = "";
      loadSource(false);
      return out;
    };
  }

  function upstreamNode() {
    const idx = (node.inputs || []).findIndex((i) => i.name === "image");
    if (idx < 0) return null;
    try {
      return node.getInputNode(idx) || null;
    } catch (err) {
      return null;
    }
  }

  function makeThumb(img, maxSide) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    if (k >= 1) return { el: img, w, h };
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(img, 0, 0, c.width, c.height);
    return { el: c, w, h };
  }

  // 底栏左边的文案：画板尺寸 + 缩放。没有画板时给一句状态话。
  function footprintText() {
    const g = state.geo;
    if (!g) return state.pctLabel || "";
    const pct = state.pctLabel ? "   " + state.pctLabel : "";
    return g.bw + " × " + g.bh + pct;
  }

  function loadSource(manual) {
    const src = upstreamNode();
    if (!src) {
      unbindSource();
      status.textContent = zhPair("Waiting for image", "等待图像");
      if (manual) draw();
      return;
    }
    // 每次读都顺手把监听挂到「当前」那个控件上：上游换节点、控件被重建都能自愈。
    const widget = pickSourceWidget(src);
    bindSource(src, widget);
    const file = widget ? widget.value.trim() : null;
    if (!file) {
      status.textContent = zhPair("No image files upstream", "上游无图像文件");
      return;
    }
    if (manual) state.failedFile = "";   // 点「加载」＝ 明确要求重试
    if (state.loading) return;
    if (file === state.failedFile) return;   // 读失败过的，别每帧重试
    if (file === state.fileName && state.img) {
      // 这里以前只写百分比，会把底栏里的"宽 × 高"顶掉
      status.textContent = footprintText() || zhPair("Loaded", "已加载");
      return;
    }

    const parts = String(file).split("/");
    const name = parts.pop();
    const sub = parts.join("/");
    const url = api.apiURL(
      "/view?filename=" +
        encodeURIComponent(name) +
        "&type=input&subfolder=" +
        encodeURIComponent(sub) +
        "&rand=" +
        Date.now()
    );

    state.loading = true;
    status.textContent = zhPair("Reading...", "读取中…");
    const img = new Image();
    img.onload = () => {
      state.loading = false;
      // 只留一份长边 1600 的副本：拖边时每帧都要重绘，直接用原图会明显发涩
      const thumb = makeThumb(img, 1600);
      state.img = thumb.el;
      state.imgW = thumb.w;
      state.imgH = thumb.h;
      state.fileName = file;
      schedule();
    };
    img.onerror = () => {
      state.loading = false;
      state.failedFile = file;
      status.textContent = zhPair("Read failed", "读取失败");
      schedule();
    };
    img.src = url;
  }

  function resetParams() {
    ["left", "right", "top", "bottom", "max_output_side", "divisible_by"].forEach((n) =>
      setValue(node, n, 0)
    );
    setValue(node, "unit", "pixels");
    state.hover = null;
    state.hoverHandle = null;
    setZoom(0);      // 复位也把视野恢复到"适应"
    schedule();
  }

  // 所有写回都经过这里（拖边框、点击吸附、移动图像、按比例重排），所以上限钳
  // 在这一点上就够。拖动的屏幕上限是 `(内容框边 - 3) / 缩放`，缩到 5% 时能算出
  // 两万多的补边，而 widget 的 max 是 PAD_LIMIT —— 不钳的话工作流里存 20480、
  // 后端只补 16384，和数字框那条是同一个毛病。
  function toUnit(v, base) {
    const unit = valueOf(node, "unit", "pixels") || "pixels";
    const px = Math.max(0, Math.round(v));
    const out = unit === "percent" ? Math.round((px / base) * 100) : px;
    return Math.min(PAD_LIMIT, out);
  }

  // 按目标宽高比重排四边：保持当前画板面积，向外补到比例成立。
  // 只扩不裁，所以原图一个像素都不会少。
  function applyRatio(ratio) {
    const g = state.geo;
    if (!g || ratio <= 0) return;
    const iw = g.iw;
    const ih = g.ih;
    const area = Math.max(1, g.bw * g.bh);

    let W = Math.sqrt(area * ratio);
    let H = W / ratio;
    const grow = Math.max(1, iw / W, ih / H);   // 必须包得住原图
    W = Math.round(W * grow);
    H = Math.round(H * grow);
    if (W < iw) W = iw;
    if (H < ih) H = ih;

    const l = Math.floor((W - iw) / 2);
    const t = Math.floor((H - ih) / 2);
    setValue(node, "left", toUnit(l, iw));
    setValue(node, "right", toUnit(W - iw - l, iw));
    setValue(node, "top", toUnit(t, ih));
    setValue(node, "bottom", toUnit(H - ih - t, ih));
    state.pan = { x: 0, y: 0 };      // 尺寸重排了，把视野拉回居中
    schedule();
  }

  // 鼠标能扩出什么：只改"鼠标落在图像外侧"的那几个方向，
  // 边界直接吸到鼠标处——这就是"点哪，外扩就到哪"。
  // 画板不许长到预览区外面去。
  // 这条是照孤海的实测行为定的：扩到画布边缘就停住，再点也不会更大。
  // 源图在扩展时位置固定，所以上限直接用内容框的屏幕坐标反推。
  // 每侧还能扩多少（图像像素）：画板不许长到预览区外面去。
  // 上限不能低于当前值——画板已经超出预览区时（比如手动调过大补边），
  // 上限反而比现值小，一刀切下去会变成"点一下就猛缩"，很难受。
  function planCaps(g) {
    if (!g || !g.cbox) return null;
    const s = g.scale || 1;
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    const pad = 3;
    return {
      l: Math.max(g.l, Math.max(0, Math.floor((g.cbox.x0 - pad) / s))),
      t: Math.max(g.t, Math.max(0, Math.floor((g.cbox.y0 - pad) / s))),
      r: Math.max(g.r, Math.max(0, Math.floor((cw - pad - g.cbox.x1) / s))),
      b: Math.max(g.b, Math.max(0, Math.floor((ch - pad - g.cbox.y1) / s))),
    };
  }

  function clampPlan(plan, g) {
    const caps = planCaps(g);
    if (!caps) return plan;
    return {
      l: Math.min(plan.l, caps.l),
      t: Math.min(plan.t, caps.t),
      r: Math.min(plan.r, caps.r),
      b: Math.min(plan.b, caps.b),
    };
  }

  function planAt(g, px, py) {
    if (!g || !g.box) return null;
    const s = g.scale || 1;
    const mx = (px - g.x) / s;
    const my = (py - g.y) / s;
    const iw = g.iw;
    const ih = g.ih;
    const x0 = g.l;
    const y0 = g.t;
    const x1 = g.l + iw;
    const y1 = g.t + ih;

    const insideX = mx > x0 && mx < x1;
    const insideY = my > y0 && my < y1;
    if (insideX && insideY) return null;   // 点在图上，说不清要往哪边扩

    const plan = { l: g.l, r: g.r, t: g.t, b: g.b };
    if (!insideX) {
      if (mx <= x0) plan.l = Math.max(0, Math.round(x0 - mx));
      else plan.r = Math.max(0, Math.round(mx - x1));
    }
    if (!insideY) {
      if (my <= y0) plan.t = Math.max(0, Math.round(y0 - my));
      else plan.b = Math.max(0, Math.round(my - y1));
    }
    // 点哪吸哪：点在画板外侧就是把补边扩到鼠标，点在补边条带里就是把补边收回来。
    return clampPlan(plan, g);
  }

  // Shift 对称预览：把"被操作的那一侧"复制到对边（拖左→右等量），
  // 与拖拽时的 applyDrag 同一套口径。handle 为空时按 plan 相对当前值的变化判断哪侧在动。
  function symmetricPlan(plan, handle, g) {
    const out = { ...plan };
    const caps = planCaps(g) || {};
    const capOf = (key) => (typeof caps[key] === "number" ? caps[key] : Infinity);
    const pairs = [
      ["left", "l", "right", "r"],
      ["top", "t", "bottom", "b"],
    ];
    for (const [startName, startKey, endName, endKey] of pairs) {
      const onStart = handle ? handle.indexOf(startName) >= 0 : out[startKey] !== g[startKey];
      const onEnd = handle ? handle.indexOf(endName) >= 0 : out[endKey] !== g[endKey];
      if (onStart === onEnd) continue;      // 两侧都在动（角拖）或都不动：不用复制
      const base = onStart ? out[startKey] : out[endKey];
      // 共同值必须落在两侧都能容下的范围里。只压对侧（clampPlan 的老行为）会出现
      // 「被拖那侧 72、对侧被压回 32」——看着就是没对称（percent 下尤其明显）。
      const v = Math.max(0, Math.round(Math.min(base, capOf(startKey), capOf(endKey))));
      out[startKey] = v;
      out[endKey] = v;
    }
    return clampPlan(out, g);
  }

  // 「点哪吸哪」的统一出口：悬停预览、画板外侧按住拖、单击抬起三处都走这里，
  // 保证"看得见的虚线"和"松手/拖动后的真实结果"完全一致（含 Shift 对称）。
  // 之前外侧拖动只调 planAt，没走对称，于是出现"有预览但对侧不动、只扩一侧"。
  function placePlan(g, x, y, shiftKey) {
    const plan = planAt(g, x, y);
    if (!plan) return null;
    if (!shiftKey) return plan;
    return symmetricPlan(plan, null, g);
  }

  function applyPlan(plan) {
    const g = state.geo;
    if (!g || !plan) return;
    const iw = g.iw;
    const ih = g.ih;

    // 扩展时比例必须钉死：画板只往外长，画面整体不跟着缩放。
    // 想缩小视野只有一条路——滚轮（或下拉里的百分比）。
    freezeZoom();

    const cx0 = g.cbox.x0;
    const cy0 = g.cbox.y0;
    setValue(node, "left", toUnit(plan.l, iw));
    setValue(node, "right", toUnit(plan.r, iw));
    setValue(node, "top", toUnit(plan.t, ih));
    setValue(node, "bottom", toUnit(plan.b, ih));

    // 用新参数反推 pan：图像（内容框）在屏幕上一动不动，
    // 画板只朝被点的那一侧长，所以"点在哪、边界就落在哪"。
    const ng = computeLayout(node, iw, ih);
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    const s = state.zoomPct || g.scale || 1;
    state.pan = {
      x: cx0 - ng.l * s - (cw - ng.bw * s) / 2,
      y: cy0 - ng.t * s - (ch - ng.bh * s) / 2,
    };
    schedule();
  }

  function cursorOf(handle) {
    if (!handle) return "default";
    if (handle.length === 2) {
      return handle === "topleft" || handle === "bottomright" ? "nwse-resize" : "nesw-resize";
    }
    return handle === "left" || handle === "right" ? "ew-resize" : "ns-resize";
  }

  // 命中判定贴着画板外框（青色那条），不是内容框。
  // 补边越大两者离得越远，贴着内容框判会导致外圈完全拖不动。
  function hitHandle(px, py) {
    const g = state.geo;
    if (!g || !g.box) return null;
    const b = g.box;
    // 容差别太大：补边为 0 时画板框贴着图像边界，容差一大就把
    // 图像边缘 9px 内的点击全吃成"拖边框"，点哪儿都没反应
    const tol = 6;
    const nearL = Math.abs(px - b.x0) <= tol;
    const nearR = Math.abs(px - b.x1) <= tol;
    const nearT = Math.abs(py - b.y0) <= tol;
    const nearB = Math.abs(py - b.y1) <= tol;
    const inX = px >= b.x0 - tol && px <= b.x1 + tol;
    const inY = py >= b.y0 - tol && py <= b.y1 + tol;
    if (nearL && nearT) return "topleft";
    if (nearR && nearT) return "topright";
    if (nearL && nearB) return "bottomleft";
    if (nearR && nearB) return "bottomright";
    if (nearT && inX) return "top";
    if (nearB && inX) return "bottom";
    if (nearL && inY) return "left";
    if (nearR && inY) return "right";
    return null;
  }

  function localPos(ev) {
    const c = state.canvas;
    const rect = c.getBoundingClientRect();
    // ComfyUI 会把整块节点（含 DOM 面板）按画布缩放一起做 CSS transform。
    // getBoundingClientRect() 拿到的是**缩放后的视觉尺寸**，而 canvas 内部绘制
    // 用的是**布局像素**（clientWidth）。不除掉这个比例，算出来的坐标就差
    // 一个缩放倍数——离面板左上角越远偏得越多，表现就是：
    //   · 准星跟着鼠标走，走着走着飘到节点外面去了
    //   · 在画板外侧点一下，扩出来的位置跟鼠标对不上
    // 节点缩到 86% 时偏差正好 14%，缩得越小飘得越离谱。
    const k = rect.width > 0 ? rect.width / Math.max(1, c.clientWidth) : 1;
    state.uiScale = k || 1;
    return { x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k };
  }

  // 调试口：把内部判定函数挂出来，探针（_probe_*.js / .py）可以直接调，
  // 不用靠猜事件有没有到。只读，不参与逻辑。
  state.shiftHeld = false;
  state.debug = { planAt, applyPlan, hitHandle, localPos, computeLayout };

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;      // 中键平移在 document 捕获阶段处理
    const p = localPos(ev);
    state.pointer = p;
    state.shiftHeld = !!ev.shiftKey;
    const gg = state.geo;
    // 画板外侧一律按"点击吸附"处理，不能让边框容差抢走：
    // 某方向补边为 0 时画板框和图像边界重合，hitHandle 的 ±9px 会把
    // 图像外那 9px 全判成"拖边框"，于是单击什么都不会发生——
    // 这就是"左右补边为 0 时，往右/下扩不了"的真正原因。
    const outside = !!(gg && gg.box && (
      p.x < gg.box.x0 || p.x > gg.box.x1 || p.y < gg.box.y0 || p.y > gg.box.y1));
    const handle = outside ? null : hitHandle(p.x, p.y);
    if (!handle) {
      // 只要这个位置能算出"往哪扩"，就记账：抬起时落下去。
      // 判定必须和悬停预览同一套（planAt），否则会出现"看得见虚线却点不动"。
      const plan = planAt(state.geo, p.x, p.y);
      if (plan) {
        ev.stopPropagation();
        // 记下按下瞬间的画板位置，拖动时按它算，画面不跟着重算而抖
        state.pending = { down: p, kind: "place", geo: gg ? { ...gg } : null };
        return;
      }
      // 图像内部按下：拖动可以在画板里挪位置（画板尺寸不变）
      if (gg && p.x >= gg.cbox.x0 && p.x <= gg.cbox.x1 &&
          p.y >= gg.cbox.y0 && p.y <= gg.cbox.y1 &&
          (gg.bw > gg.iw || gg.bh > gg.ih)) {
        ev.stopPropagation();
        state.pending = { down: p, kind: "move" };
      }
      return;
    }
    ev.stopPropagation();
    ev.preventDefault();
    try {
      canvas.setPointerCapture?.(ev.pointerId);
    } catch (err) {
      /* 合成事件没有真实 pointerId，忽略即可 */
    }

    const g = state.geo;
    // 拖边框也把缩放钉住，否则每拖一下画板就重新适应一次，手感是"越拖越小"
    freezeZoom();
    state.drag = {
      handle,
      down: p,
      start: {
        left: Number(valueOf(node, "left", 0)) || 0,
        right: Number(valueOf(node, "right", 0)) || 0,
        top: Number(valueOf(node, "top", 0)) || 0,
        bottom: Number(valueOf(node, "bottom", 0)) || 0,
      },
      // 冻结缩放与内容框位置：整段拖动里图像不许动，只有画板边界动
      anchor: {
        scale: g.scale || 1,
        cx: g.x + (g.l || 0) * g.scale,
        cy: g.y + (g.t || 0) * g.scale,
      },
    };
    canvas.style.cursor = cursorOf(handle);
    schedule();
  });

  // 拖边框：pointermove 与「拖拽中按/松 Shift」共用同一段计算。
  // 按住 Shift 时，被拖的那条边会把对边一起带成相同的值 —— 对称扩图。
  // 这是孤海「外补画板（可视化）」里 shiftKey 的行为（对边等量）；
  // 本节点把「比例约束」交给比例下拉框，Shift 只负责两侧等量。
  function applyDrag(p, shiftKey) {
    const drag = state.drag;
    const g = state.geo;
    if (!drag || !g) return;
    // 可见反馈：对称模式给画布描一圈青色，用户一眼能确认 Shift 是否被识别
    canvas.style.boxShadow = shiftKey ? "inset 0 0 0 2px #35d0c0" : "";
    placeCursor(null);              // 拖边框时不显示准星

    const s = drag.anchor.scale || 1;
    const dxImg = (p.x - drag.down.x) / s;
    const dyImg = (p.y - drag.down.y) / s;

    const h = drag.handle;
    // 画板不能拖出预览区：源图在这次拖动里是钉住的，直接反推每侧上限
    const cwPx = Math.max(60, canvas.clientWidth || 0);
    const chPx = Math.max(60, canvas.clientHeight || 0);
    const cboxX1 = drag.anchor.cx + g.iw * s;
    const cboxY1 = drag.anchor.cy + g.ih * s;
    // 上限是"扩到预览区边缘"，但它不能低于按下时的手里值——
    // 画板本来就贴边时，上限会小于当前值，一拖就把补边打到 0，
    // 看起来就是"想缩一点，结果整块塌了 / 拖不动"。
    const capL = Math.max(drag.start.left, toUnit((drag.anchor.cx - 3) / s, g.iw));
    const capT = Math.max(drag.start.top, toUnit((drag.anchor.cy - 3) / s, g.ih));
    const capR = Math.max(drag.start.right, toUnit((cwPx - 3 - cboxX1) / s, g.iw));
    const capB = Math.max(drag.start.bottom, toUnit((chPx - 3 - cboxY1) / s, g.ih));

    // 先按"只动被拖的那条边"算（普通拖拽的老行为），再决定要不要对称。
    const next = {
      left: drag.start.left,
      right: drag.start.right,
      top: drag.start.top,
      bottom: drag.start.bottom,
    };
    const clampTo = (v, cap) => Math.max(0, Math.min(Math.round(v), cap));
    if (h.indexOf("left") >= 0) next.left = clampTo(drag.start.left + toUnit(-dxImg, g.iw), capL);
    if (h.indexOf("right") >= 0) next.right = clampTo(drag.start.right + toUnit(dxImg, g.iw), capR);
    if (h.indexOf("top") >= 0) next.top = clampTo(drag.start.top + toUnit(-dyImg, g.ih), capT);
    if (h.indexOf("bottom") >= 0) next.bottom = clampTo(drag.start.bottom + toUnit(dyImg, g.ih), capB);

    // 按住 Shift：拖哪边，对边跟着走同样的量（两侧取同一个值）。
    // 角拖（topleft 等）同时命中水平+垂直两对，于是四边各自成对。
    // 取 min 时把两侧各自的上限都算进去，对称后不会有一侧顶出预览区。
    if (shiftKey) {
      const equalize = (startName, endName, capStart, capEnd) => {
        const onStart = h.indexOf(startName) >= 0;
        const onEnd = h.indexOf(endName) >= 0;
        if (!onStart && !onEnd) return;
        const base = onStart ? next[startName] : next[endName];
        const v = Math.max(0, Math.min(base, capStart, capEnd));
        next[startName] = v;
        next[endName] = v;
      };
      equalize("left", "right", capL, capR);
      equalize("top", "bottom", capT, capB);
    }

    setValue(node, "left", next.left);
    setValue(node, "right", next.right);
    setValue(node, "top", next.top);
    setValue(node, "bottom", next.bottom);
    schedule();
  }

  canvas.addEventListener("pointermove", (ev) => {
    const p = localPos(ev);
    state.pointer = p;
    if (state.panning) return;      // 中键平移在 document 捕获阶段处理

    const drag = state.drag;
    if (!drag) {
      const g0 = state.geo;

      // 先判"该不该进入移动"，再执行移动——否则第一次位移会被吞掉
      if (!state.moving && state.pending && state.pending.kind === "move" &&
          Math.hypot(p.x - state.pending.down.x, p.y - state.pending.down.y) > 3) {
        state.moving = {
          down: state.pending.down,
          startL: g0.l,
          startT: g0.t,
          bw: g0.bw,
          bh: g0.bh,
        };
        state.pending = null;
        canvas.style.cursor = "move";
        placeCursor(null);
      }

      if (state.moving) {
        const s0 = g0.scale || 1;
        const dx = (p.x - state.moving.down.x) / s0;
        const dy = (p.y - state.moving.down.y) / s0;
        const maxL = Math.max(0, state.moving.bw - g0.iw);
        const maxT = Math.max(0, state.moving.bh - g0.ih);
        const l = Math.max(0, Math.min(maxL, Math.round(state.moving.startL + dx)));
        const t = Math.max(0, Math.min(maxT, Math.round(state.moving.startT + dy)));
        setValue(node, "left", toUnit(l, g0.iw));
        setValue(node, "right", toUnit(state.moving.bw - g0.iw - l, g0.iw));
        setValue(node, "top", toUnit(t, g0.ih));
        setValue(node, "bottom", toUnit(state.moving.bh - g0.ih - t, g0.ih));
        schedule();
        return;
      }

      // 在画板外侧按住拖：连续吸附，手感等于"拖着边框走"
      // 用按下瞬间的画板快照算，否则画板每帧重新居中会把鼠标映射带偏
      if (state.pending && state.pending.kind === "place" &&
          Math.hypot(p.x - state.pending.down.x, p.y - state.pending.down.y) > 3) {
        const gStart = state.pending.geo || g0;
        // 按住 Shift 时和拖边框同一套对称口径：对侧跟着等量走
        const p2 = placePlan(gStart, p.x, p.y, ev.shiftKey || state.shiftHeld);
        if (p2) {
          applyPlan(p2);
          return;
        }
      }

      const handle = hitHandle(p.x, p.y);
      // 边框上也给预览：孤海是"鼠标移到边框按住 Shift，对侧虚线跟着走"，
      // 所以这里不再用 !handle 把边框排掉。
      const plan = g0 ? planAt(g0, p.x, p.y) : null;
      const next = plan ? { x: p.x, y: p.y } : null;
      const changed = (!!next !== !!state.hover) ||
        (next && state.hover && (next.x !== state.hover.x || next.y !== state.hover.y)) ||
        handle !== state.hoverHandle;
      state.hover = next;
      state.hoverHandle = handle;
      const inImage = !!(g0 && !plan && !handle &&
        p.x >= g0.cbox.x0 && p.x <= g0.cbox.x1 &&
        p.y >= g0.cbox.y0 && p.y <= g0.cbox.y1 &&
        (g0.bw > g0.iw || g0.bh > g0.ih));
      // 光标交给自绘准星，系统光标只在能拖的边框上出现（提示方向）
      canvas.style.cursor = handle
        ? cursorOf(handle)
        : (state.moving ? "move" : "none");
      placeCursor(p);
      // 鼠标在画板里移动时 changed 一直是 false，画布完全不重绘——
      // 只有准星这一层在动，所以不会抖（这就是"飘"的根因）
      if (changed) schedule();
      return;
    }

    applyDrag(p, ev.shiftKey || state.shiftHeld);
  });

  const endDrag = (ev) => {
    if (!state.drag) return;
    const g = state.geo;
    state.drag = null;
    canvas.style.cursor = "default";
    canvas.style.boxShadow = "";
    try {
      canvas.releasePointerCapture?.(ev.pointerId);
    } catch (err) {
      /* 指针已释放 */
    }
    // 松手后用最新参数重算 pan，源图停在拖动时的位置，不要跳一下
    if (g && g.cbox) {
      const ng = computeLayout(node, g.iw, g.ih);
      const s = state.zoomPct || g.scale || 1;
      const cw = Math.max(60, canvas.clientWidth || 0);
      const ch = Math.max(60, canvas.clientHeight || 0);
      state.pan = {
        x: g.cbox.x0 - ng.l * s - (cw - ng.bw * s) / 2,
        y: g.cbox.y0 - ng.t * s - (ch - ng.bh * s) / 2,
      };
    }
    schedule();
  };
  canvas.addEventListener("pointerup", (ev) => {
    if (state.drag) {
      // 只点一下边框、没拖动：按"点哪吸哪"处理。
      // 不然点在补边区域靠边框的位置会被判成拖边框，单击什么都不发生，
      // 表现就是"扩出来了，想缩小一点却点不动"。
      const dd = state.drag.down;
      const pNow = localPos(ev);
      const moved = Math.hypot(pNow.x - dd.x, pNow.y - dd.y);
      endDrag(ev);
      if (moved <= 4) {
        const plan = placePlan(state.geo, pNow.x, pNow.y, ev.shiftKey || state.shiftHeld);
        if (plan) applyPlan(plan);
      }
      return;
    }
    if (state.moving) {
      state.moving = null;
      state.pending = null;
      canvas.style.cursor = "default";
      schedule();
      return;
    }
    const pend = state.pending;
    state.pending = null;
    if (!pend) return;
    const p = localPos(ev);
    // 位移超过 4px 算拖拽，不当点击，避免手抖就挪图
    if (Math.hypot(p.x - pend.down.x, p.y - pend.down.y) > 4) return;
    const plan = placePlan(state.geo, p.x, p.y, ev.shiftKey || state.shiftHeld);
    if (plan) applyPlan(plan);
  });

  canvas.addEventListener("pointercancel", (ev) => {
    state.pending = null;
    state.panning = null;
    endDrag(ev);
  });

  /* ---------- 滚轮缩放 / 中键平移 ----------
   * 必须绑在 document 的捕获阶段：LiteGraph 会在捕获阶段先把滚轮（缩放画布）
   * 和中键（平移画布）吃掉，绑在 canvas 上的监听器根本轮不到，
   * 表现就是"滚轮在预览里没反应，整个节点图被缩小了"。
   * 孤海也是这么干的：document.addEventListener(..., { capture: true })。
   * ---------------------------------------------------------- */
  function zoomAt(ev) {
    const g = state.geo;
    if (!g || !state.img) return;
    const p = localPos(ev);
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    const s0 = g.scale || 1;
    const step = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const s1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s0 * step));
    if (Math.abs(s1 - s0) < 1e-9) return;

    // 让鼠标下面这个点缩放前后停在原地
    const wx = (p.x - g.x) / s0;
    const wy = (p.y - g.y) / s0;
    state.pan = {
      x: p.x - wx * s1 - (cw - g.bw * s1) / 2,
      y: p.y - wy * s1 - (ch - g.bh * s1) / 2,
    };
    state.zoomPct = s1;
    state.pointer = p;
    syncZoomSel();
    schedule();
  }

  function startPan(ev) {
    const g = state.geo;
    if (!g) return;
    freezeZoom();                    // 平移只在固定比例下生效（适应模式忽略 pan）
    state.panning = { start: localPos(ev), pan: { ...state.pan }, geo: { ...g } };
    state.pointer = null;
    placeCursor(null);
    canvas.style.cursor = "grabbing";
  }

  function movePan(ev) {
    const pn = state.panning;
    if (!pn || !pn.geo) return;
    const g = pn.geo;
    const p = localPos(ev);
    const cw = Math.max(60, canvas.clientWidth || 0);
    const ch = Math.max(60, canvas.clientHeight || 0);
    const s = state.zoomPct || g.scale || 1;
    let dx = p.x - pn.start.x;
    let dy = p.y - pn.start.y;

    // 和孤海一样：源图不许被拖出预览区
    const baseX = (cw - g.bw * s) / 2;
    const baseY = (ch - g.bh * s) / 2;
    const cx0 = baseX + pn.pan.x + g.l * s;
    const cy0 = baseY + pn.pan.y + g.t * s;
    dx = clampBetween(dx, -cx0, cw - (cx0 + g.iw * s));
    dy = clampBetween(dy, -cy0, ch - (cy0 + g.ih * s));

    state.pan = { x: pn.pan.x + dx, y: pn.pan.y + dy };
    schedule();
  }

  function endPan() {
    if (!state.panning) return;
    state.panning = null;
    canvas.style.cursor = "none";
    schedule();
  }

  const NAV_EVENTS = ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel"];
  const navGuard = (ev) => {
    if (!canvas.isConnected) return;
    const path = typeof ev.composedPath === "function" ? ev.composedPath() : null;
    const inside = path ? path.includes(canvas) : ev.target === canvas;

    if (ev.type === "wheel") {
      if (!inside) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      zoomAt(ev);
      return;
    }
    if (ev.type === "pointerdown") {
      if (!inside || ev.button !== 1) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      startPan(ev);
      return;
    }
    if (state.panning) {
      if (ev.type === "pointermove") movePan(ev);
      else if (ev.type === "pointerup" || ev.type === "pointercancel") endPan();
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  for (const type of NAV_EVENTS) {
    document.addEventListener(type, navGuard, { capture: true, passive: false });
  }
  state.navGuard = navGuard;
  state.navEvents = NAV_EVENTS;

  // 拖拽过程中按/松 Shift 要立刻重算：只靠 pointermove 的 ev.shiftKey 得等鼠标
  // 动一下才生效；想"按住 Shift 对边立刻跟上"，就得监听键盘（孤海也是这么做的）。
  function onShiftKey(ev) {
    if (ev.key !== "Shift") return;
    state.shiftHeld = ev.type === "keydown";
    if (state.drag && state.pointer) {
      applyDrag(state.pointer, state.shiftHeld);
      return;
    }
    // 悬停阶段：Shift 只影响预览虚线，重绘一帧即可
    schedule();
  }
  function onShiftBlur() {
    if (state.drag && state.pointer) applyDrag(state.pointer, false);
  }
  window.addEventListener("keydown", onShiftKey);
  window.addEventListener("keyup", onShiftKey);
  window.addEventListener("blur", onShiftBlur);
  state.onShiftKey = onShiftKey;
  state.onShiftBlur = onShiftBlur;

  canvas.addEventListener("pointerleave", () => {
    let dirty = false;
    if (state.hover) { state.hover = null; state.hoverHandle = null; dirty = true; }
    if (state.pointer && !state.panning) { state.pointer = null; dirty = true; }
    placeCursor(null);
    if (dirty) schedule();
  });

  /* ---------- 挂到节点 ---------- */
  // 面板高度 = 节点高度 - 已用高度。这是「现在量出来多高」，只给读数用，
  // 绝不能拿去当 floor —— 那是一条自反馈：floor 报给前端后，拖动缩放时
  // 每一帧都会拿 computeSize() 把尺寸往上抬，而 computeSize 又由这个 floor
  // 算出「当前高度 - 已用高度」，于是每帧恒定多出几像素，拖着不放就一路长高。
  // 填满剩余空间本来不需要声明：computeLayoutSize 只报下限不报上限，
  // distributeSpace 会把节点剩下的高度全给面板（见 panel_layout.mjs 顶部）。
  function panelHeight() {
    const total = Number(node.size?.[1]) || NODE_DEFAULT_H;
    const used = panel && typeof panel.y === "number" && panel.y > 0 ? panel.y : CHROME_H;
    return Math.max(PANEL_MIN_H, Math.round(total - used - 4));
  }

  const panel = node.addDOMWidget("qg_outpaint_board", "QG_OUTPAINT_BOARD", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => PANEL_MIN_H,
  });
  keepDomWidgetWidthAuto(panel);
  // The preview carries a floor (a canvas squeezed to a sliver cannot be worked
  // in), so this panel cannot be clamped the pinPanelToNodeHeight way: a
  // min-height beats max-height, and the clamp silently does nothing. Declaring
  // only a floor and no ceiling is enough - distributeSpace then hands the panel
  // every pixel the node has left, so the preview grows with the node and this
  // node never has to touch node.size on the classic renderer.
  fillNodeHeight(panel, {
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    minNodeSize: [PANEL_MIN_W, NODE_MIN_H],
    exactMinWidth: true,
  });
  const panelOf = () => node.widgets?.find((w) => w.name === "qg_outpaint_board")?.element ?? root;
  watchVueShell(node, panelOf, () =>
    fitNodeToPanelHeight(node, panelOf(), (node.__qgObpFit ??= {}))
  );
  state.panel = panel;
  state.view = view;
  state.panelHeight = panelHeight;

  // 原生 widget 只留值，不留脸
  MANAGED.forEach((name) => {
    const w = widgetOf(node, name);
    if (!w) return;
    w.computeSize = () => [0, -4];
    w.hidden = true;
    if (w.element) w.element.style.display = "none";
    if (w.inputEl) w.inputEl.style.display = "none";
  });

  refreshWidgets();
  requestAnimationFrame(() => {
    draw();
    loadSource(false);
  });

  // 视图尺寸变了（节点被拉大拉小、面板重排）就重绘，画板跟着容器走
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => schedule());
    ro.observe(view);
    ro.observe(root);
    state.ro = ro;
  }

  // Default size lives in web/shared/node_width.mjs (SIZES). This node used to
  // call setSize itself; two owners of node.size means they overwrite each
  // other, so the local one is gone and the table is the single source.
  setTimeout(schedule, 0);

  const prevConn = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected) {
    prevConn?.apply(this, arguments);
    // 连线变了：上游可能整个换成另一个节点，旧监听先摘掉再按需重挂。
    unbindSource();
    if (connected) {
      state.fileName = "";
      state.failedFile = "";
      setTimeout(() => loadSource(false), 120);
    }
  };

  // 兜底：有的上游（Vue 渲染器重建控件、上传组件直接改 widgets_values）不走我们
  // 包住的那个 callback。每帧比一次「控件引用 + 值」，不一样就重读 —— 只做字符串
  // 比较，开销可忽略，但能保证换图一定会跟上。
  const prevForeground = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    prevForeground?.apply(this, arguments);
    const src = upstreamNode();
    if (!src) return;
    const widget = pickSourceWidget(src);
    if (!widget) return;
    if (widget !== bind.widget || src !== bind.srcNode) {
      bindSource(src, widget);
      state.fileName = "";
      loadSource(false);
      return;
    }
    const now = widget.value.trim();
    if (now && now !== state.fileName && now !== state.failedFile) {
      state.fileName = "";
      loadSource(false);
    }
  };

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    try {
      unbindSource();
      if (state.navGuard) {
        for (const t of state.navEvents || []) {
          document.removeEventListener(t, state.navGuard, { capture: true });
        }
      }
      if (state.onShiftKey) {
        window.removeEventListener("keydown", state.onShiftKey);
        window.removeEventListener("keyup", state.onShiftKey);
        window.removeEventListener("blur", state.onShiftBlur);
      }
      state.ro?.disconnect?.();
      unwatchVueShell(node);
    } catch (err) {
      /* 清理失败不影响节点删除 */
    }
    prevRemoved?.apply(this, arguments);
  };

  const prevResize = node.onResize;
  node.onResize = function () {
    prevResize?.apply(this, arguments);
    // 节点被拉着改尺寸：重绘时 draw() 会重新读画布的实际尺寸
    schedule();
  };
}

app.registerExtension({
  name: "QG.OutpaintBoard",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      try {
        buildPanel(this);
      } catch (err) {
        console.error("[QG-tools] Outpaint Board: panel build failed", err);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const st = this.__obp;
      if (st) {
        st.fileName = "";
        setTimeout(() => st.refresh?.(), 60);
        setTimeout(() => {
          const idx = (this.inputs || []).findIndex((i) => i.name === "image");
          if (idx >= 0 && this.getInputNode?.(idx)) {
            this.onConnectionsChange?.("input", idx, true);
          }
        }, 300);
      }
      return r;
    };
  },
});
