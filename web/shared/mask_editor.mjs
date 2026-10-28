// QG 遮罩编辑器 —— 在加载图像节点里自己画遮罩（前端）
//
// 为什么自己写一份：官方的遮罩编辑器能用，但它的「保存」是把遮罩烧回原图、
// 覆盖 input 里那张文件（`cat.png [input]` 的 `[input]` 是路径提示，不是文件名
// 的一部分）；画错一次，原图就没了。这里改成另存一个 `-mask.png`，原图永远在，
// 想重来随时回到原图重画。
//
// 遮罩存在哪儿：烧进图片的 **alpha 通道**，所以后端一行都不用改 ——
// QG_LoadImage 的 MASK 输出本来就是 `1 - alpha`。保存后图片带 alpha，遮罩区
// 在 IMAGE 输出里按「合成白底 / 黑底 / 保留」三态照常处理，遮罩自己走 MASK。
//
// 画笔不是新写的：笔芯、软边、[ ] 键、Alt 加右键拖着调，全部共用
// shared/brush.mjs（图像对比的橡皮擦也用这一支）。笔画按原图像素记，撤销就是
// 去掉最后一笔重画一遍，所以笔迹能跟着图一起存、也能随时改。
//
// 遮罩位图的长边压到 PREVIEW_SIDE：遮罩是给局部重绘用的，边界本来就模糊，
// 2048 长边足够；不压的话 4000 × 3000 的图每笔都要在 1200 万像素上做模糊。

import { api } from "/scripts/api.js";
import { BRAND, notifyQgChange, showToast } from "./index.mjs?v=2026102706";
import {
  brushAdjusts,
  brushCore,
  brushFlips,
  brushKey,
  brushReach,
  brushSigma,
  brushWords,
  clampBrushSize,
  clampSoft,
  steppedBrushSize,
  steppedSoft,
  startAdjust,
  moveAdjust,
} from "./brush.mjs?v=2026102706";
import { defaultBrushSize } from "./compare_erase.mjs?v=2026102706";
import { encodeRgbaPng } from "./png_encode.mjs?v=2026102706";
import { zh, zhPair } from "./zh.mjs?v=2026102706";

const CSS_ID = "qgtools-mask-editor-css";

// 遮罩位图的长边上限。原图更大就等比缩，保存时按原图尺寸放大回去。
const PREVIEW_SIDE = 2048;
// 画面缩放范围，跟孤海一致的 0.05 ~ 12 倍。
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 12;
const BRUSH_RANGE = [2, 600];
// 一笔最多记多少个点：再密也看不出区别，只是拖慢重画。
const MAX_POINTS = 4000;
// 撤销最多留多少步。每一步只是几个数字，不是一张图，所以给得宽。
const MAX_UNDO = 60;
// 填出来的洞往里多吃几个像素：洞是硬边、笔迹是软边，交界会留一圈 alpha 谷。
// 软度 0 的软边实测 4px 宽（谷 3px），3 轮足够填平；软度大了本来就在渐变里，
// 多一点也看不出来。
const FILL_EDGE = 3;

const TINT_ORDER = ["white", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "gray"];
const TINT_HEX = {
  white: "#ffffff",
  red: "#ff3030",
  orange: "#ff8c20",
  yellow: "#ffe52e",
  green: "#28d66f",
  cyan: "#24d9d1",
  blue: "#347cff",
  purple: "#b04cff",
  gray: "#808080",
};
const TINT_TIP = {
  white: zh("Overlay colour: white"),
  red: zh("Overlay colour: red"),
  orange: zh("Overlay colour: orange"),
  yellow: zh("Overlay colour: yellow"),
  green: zh("Overlay colour: green"),
  cyan: zh("Overlay colour: cyan"),
  blue: zh("Overlay colour: blue"),
  purple: zh("Overlay colour: purple"),
  gray: zh("Overlay colour: gray"),
};

// 老浏览器（以及被关掉硬件加速的环境）的 canvas 没有 filter，模糊就画不出来。
// 那种情况下笔就是硬边的，比画不出东西好。
const CAN_FILTER = (() => {
  try {
    const probe = document.createElement("canvas").getContext("2d");
    probe.filter = "blur(2px)";
    return probe.filter === "blur(2px)";
  } catch {
    return false;
  }
})();

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
/* 四行：标题 / 工具 / 画布 / 底部。画布那行是 minmax(0,1fr) —— 少写一个 auto
   的话工具行会抢走它，画布高度变成 0，指针坐标也算不出来（一笔都画不上）。 */
.qgtools-mask-modal{position:fixed;inset:0;z-index:100001;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;background:#0d1012;color:#e6e8ea;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.qgtools-mask-head{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #22292c;background:#12171a}
.qgtools-mask-title{font-weight:600;color:#dfeaee}
.qgtools-mask-name{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#8ba3a1;font-size:12px}
.qgtools-mask-head .qgtools-mask-spacer{flex:1 1 0}
.qgtools-mask-bars{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #1b2124;background:#101416}
.qgtools-mask-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #22292c;background:#12171a}
.qgtools-mask-foot .qgtools-mask-spacer{flex:1 1 0}
.qgtools-mask-btn{height:28px;display:inline-flex;align-items:center;padding:0 12px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#16201f;color:#d8ecea;font:600 12px/1 inherit;cursor:pointer;white-space:nowrap}
.qgtools-mask-btn:hover{border-color:${BRAND};color:#fff}
.qgtools-mask-btn:disabled{opacity:.45;cursor:default;border-color:#2a3437;color:#8ba3a1}
.qgtools-mask-btn.on{background:${BRAND};border-color:${BRAND};color:#04201d}
.qgtools-mask-btn.primary{background:${BRAND};border-color:${BRAND};color:#04201d}
.qgtools-mask-btn.primary:disabled{background:#1d2726;border-color:#2a3437;color:#7d9896}
/* 显示方式：三选一的分段控件。以前是一个按钮循环点，想回上一种得按两下。 */
.qgtools-mask-seg{height:28px;display:inline-flex;align-items:stretch;flex:none;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;overflow:hidden;background:#16201f}
.qgtools-mask-seg>button{height:100%;margin:0;padding:0 11px;border:0;border-right:1px solid #2a3437;background:transparent;color:#9fb5b3;font:600 12px/1 inherit;cursor:pointer;white-space:nowrap}
.qgtools-mask-seg>button:last-child{border-right:0}
.qgtools-mask-seg>button:hover{background:#1d2726;color:#fff}
.qgtools-mask-seg>button.on{background:${BRAND};color:#04201d}
.qgtools-mask-seg>button.on:hover{background:${BRAND};color:#04201d}
.qgtools-mask-field{display:flex;align-items:center;gap:6px}
.qgtools-mask-field>span{color:#8ba3a1;font-size:12px;white-space:nowrap}
.qgtools-mask-range{-webkit-appearance:none;appearance:none;height:4px;margin:0;border-radius:2px;background:#28363a;outline:none;cursor:pointer;flex:none}
.qgtools-mask-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border:0;border-radius:50%;background:${BRAND};cursor:pointer;box-shadow:0 0 0 1px #0b0f10}
.qgtools-mask-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:${BRAND};cursor:pointer}
/* 焦点只画在圆点上：整根轨道套一个方框（原生 focus-visible）在深色底上很碍眼。 */
.qgtools-mask-range:focus-visible{outline:none}
.qgtools-mask-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 1px #0b0f10,0 0 0 3px ${BRAND}}
.qgtools-mask-range:focus-visible::-moz-range-thumb{box-shadow:0 0 0 1px #0b0f10,0 0 0 3px ${BRAND}}
.qgtools-mask-field>span.qgtools-mask-readout{color:#dfeaee;font-weight:600;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.qgtools-mask-swatches{display:flex;align-items:center;gap:4px}
.qgtools-mask-swatch{width:16px;height:16px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:50%;cursor:pointer;box-sizing:border-box}
.qgtools-mask-swatch:hover{transform:scale(1.15)}
.qgtools-mask-swatch.on{border-color:#fff;box-shadow:0 0 0 1px #0b0f10,0 0 0 2px rgba(255,255,255,.9)}
.qgtools-mask-stage{position:relative;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#080b0c}
/* 画面和遮罩色装在这个框里，滚轮缩放只动它；笔尖圈在外层，永远 1px。 */
.qgtools-mask-frame{position:absolute;inset:0;transform-origin:50% 50%;will-change:transform}
.qgtools-mask-stage canvas{display:block;position:absolute;inset:0;width:100%;height:100%;cursor:none}
.qgtools-mask-stage.panning,.qgtools-mask-stage.panning canvas{cursor:grab}
.qgtools-mask-stage.panning.dragging,.qgtools-mask-stage.panning.dragging canvas{cursor:grabbing}
.qgtools-mask-hint{position:absolute;left:14px;bottom:12px;padding:4px 9px;border-radius:5px;background:rgba(0,0,0,.62);color:#b9d3d0;font:11px/1.5 inherit;white-space:pre-line;pointer-events:none;max-width:min(560px,80%)}
.qgtools-mask-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,11,12,.72);color:#cfe6e3;font-size:13px;pointer-events:none}
.qgtools-mask-busy[hidden]{display:none}
`;
  document.head.appendChild(style);
}

function sized(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas.getContext("2d");
}

// 一笔画到遮罩上。`o` 是 1 画、0 擦；坐标一律是原图像素，这里按 scale 落到
// 遮罩位图上。
function paintStroke(ctx, stroke, scale, colour = "#000") {
  const soft = stroke.s / 100;
  const core = Math.max(0.01, brushCore(stroke.d, soft) * scale);
  const sigma = brushSigma(stroke.d, soft) * scale;
  const path = stroke.p;
  ctx.save();
  ctx.globalCompositeOperation = stroke.o ? "source-over" : "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = core * 2;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  if (sigma >= 0.25 && CAN_FILTER) ctx.filter = `blur(${sigma.toFixed(3)}px)`;
  ctx.beginPath();
  if (path.length === 2) {
    ctx.arc(path[0] * scale, path[1] * scale, core, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(path[0] * scale, path[1] * scale);
    for (let index = 2; index < path.length; index += 2) ctx.lineTo(path[index] * scale, path[index + 1] * scale);
    ctx.stroke();
  }
  ctx.restore();
}

// 一笔里两个点离多近就不记了：笔越粗丢得越多，反正是要被盖住的抖动。
function pointGap(size) {
  return Math.max(0.75, size / 40);
}

function pushPoint(points, x, y, gap) {
  const lastX = points[points.length - 2];
  const lastY = points[points.length - 1];
  if (points.length) {
    const dx = x - lastX;
    const dy = y - lastY;
    if (dx * dx + dy * dy < gap * gap) return false;
  }
  if (points.length / 2 >= MAX_POINTS) return false;
  points.push(x, y);
  return true;
}

// 一张图整个居中放进一个盒子时占哪块地方。
function fitRect(boxWidth, boxHeight, width, height) {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(width > 0) || !(height > 0)) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const fitWidth = width * scale;
  const fitHeight = height * scale;
  return { left: (boxWidth - fitWidth) / 2, top: (boxHeight - fitHeight) / 2, width: fitWidth, height: fitHeight, scale };
}

/**
 * 打开遮罩编辑器。
 *
 * @param {object} options
 * @param {string} options.title    顶栏标题
 * @param {string} options.name     正在编辑的文件名，存盘时拿来起新名字
 * @param {string} options.imageUrl 画面的 /view 地址（必须是看得见画面的那张）
 * @param {string} [options.maskUrl] 已有遮罩的 /view 地址，裁在它的 alpha 里
 * @param {string} [options.viewUrl] 同一份成品的**不透明**版本（qg-view），只用来取颜色
 * @param {string} options.tint     初始叠加色
 * @param {number} [options.alpha]  初始叠加透明度（0~100，默认 50）
 * @param {boolean} [options.tintOutput] 初始输出档位：成品带不带色
 * @param {(filename: string, tint?: {colour: string, alpha: number, tintOutput: boolean}) => void} options.onSaved
 *        存盘成功后回传新文件名，以及这次用的颜色、透明度和输出档位
 */
export function openMaskEditor({
  title, name, imageUrl, maskUrl = null, viewUrl = null, tint = "green", alpha = 50, tintOutput = false, onSaved,
}) {
  ensureCss();

  const modal = document.createElement("div");
  modal.className = "qgtools-mask-modal";
  const controller = new AbortController();
  const signal = controller.signal;

  const head = document.createElement("div");
  head.className = "qgtools-mask-head";
  const titleEl = document.createElement("span");
  titleEl.className = "qgtools-mask-title";
  titleEl.textContent = title || zh("Mask editor");
  const nameEl = document.createElement("span");
  nameEl.className = "qgtools-mask-name";
  nameEl.textContent = name || "";
  const spacer = document.createElement("span");
  spacer.className = "qgtools-mask-spacer";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "qgtools-mask-btn";
  close.textContent = zh("Close");
  head.append(titleEl, nameEl, spacer, close);

  const bars = document.createElement("div");
  bars.className = "qgtools-mask-bars";

  const stage = document.createElement("div");
  stage.className = "qgtools-mask-stage";
  // 三层画布：底图 / 遮罩色 / 笔尖圈。
  // 早先三层画在同一张上，指针每动一下都要把 2048 长边的遮罩整张重新缩放一遍，
  // 大图上就是 20fps、笔尖还追着指针跑。拆开以后指针一动只重画笔尖那个圈。
  const frame = document.createElement("div");
  frame.className = "qgtools-mask-frame";
  const baseLayer = document.createElement("canvas");
  const tintLayer = document.createElement("canvas");
  // 笔尖圈不进 frame —— 缩放的只是画面，圈得保持 1px 线宽、跟着指针走。
  const view = document.createElement("canvas");
  const busy = document.createElement("div");
  busy.className = "qgtools-mask-busy";
  busy.hidden = true;
  const hint = document.createElement("div");
  hint.className = "qgtools-mask-hint";
  frame.append(baseLayer, tintLayer);
  stage.append(frame, view, busy, hint);

  const foot = document.createElement("div");
  foot.className = "qgtools-mask-foot";

  modal.append(head, bars, stage, foot);
  document.body.append(modal);

  const ed = {
    modal, stage, view, busy, hint, baseLayer, tintLayer, frame,
    zoom: 1, panX: 0, panY: 0,      // 滚轮缩放 / 空格或中键平移
    spaceDown: false, panning: null,
    cursorFrame: 0,
    picture: null,
    width: 0, height: 0,
    mask: document.createElement("canvas"),
    tinted: document.createElement("canvas"),
    // 每色一层（彩色像素）：跟孤海一样，一笔一色靠「按颜色分层」实现，
    // mask 仍是单通道的 alpha，MASK 输出与配对逻辑一个字都不用改。
    colours: new Map(),        // 这一轮画出来的笔画，按颜色分层
    baseLayers: new Map(),     // 打开时那张图自带的遮罩，同样是按颜色分层
    // 🔴 填充也**按颜色分开**（跟孤海一样），不能所有色的洞合并成一张盖在最上面：
    // 那样先画的红色圈把洞填满之后，后画的绿色笔迹会被红洞整块盖掉（用户 2026-10-25
    // 报的就是这个）。每色一份洞，跟它自己的色层一起叠，谁最后落笔谁在上面。
    fillLayers: new Map(),
    layerOrder: new Map(),     // 每色最后一次落笔的序号，决定叠的先后
    strokeSeq: 0,
    maskScale: 1,
    maskW: 1, maskH: 1,        // 遮罩位图自己的尺寸（原图 × maskScale）
    base: null,                 // 图片自带的 alpha 反相，作为初始遮罩
    filled: null,               // 自动填洞之后的遮罩（视图，不改笔画）
    fillCount: 0,
    autoFill: true,             // 默认开着：抬笔就把围住的洞补上
    strokes: [], undone: [],
    tool: "paint",
    size: 64,
    // 软度默认 0（硬笔）：软边在交界处要多几像素才糊得开，画遮罩时硬边更好对准
    // 头发丝、衣领这种地方。想糊开按住 Shift+] 或拖滑条。
    soft: 0,
    tint: TINT_ORDER.includes(tint) ? tint : "green",
    alpha: Number.isFinite(Number(alpha)) ? Math.min(100, Math.max(0, Number(alpha))) : 50,
    // 🔴 显示方式就是输出方式（所见即所得，用户 2026-10-26 定的）：
    // 彩色叠加 = 存出去的成品带色；仅遮罩 / 原图 = 不带色。
    // 打开时按节点上的 `tint_output` 定初始档：带色 → 彩色叠加，不带色 → 仅遮罩。
    mode: tintOutput === true ? "tint" : "mask",
    stroke: null, adjust: null, pointer: null, flip: false, flipKey: false,
    fit: null, frame: 0, saving: false, dirty: false,
    name: String(name || ""),
  };

  // ---- 遮罩 ----------------------------------------------------------------

  // ---- 彩色层 ----------------------------------------------------------------

  const colourName = (stroke) => (stroke?.c && TINT_HEX[stroke.c] ? stroke.c : ed.tint);

  function colourLayer(name) {
    let canvas = ed.colours.get(name);
    if (!canvas) {
      canvas = document.createElement("canvas");
      ed.colours.set(name, canvas);
    }
    if (canvas.width !== ed.maskW || canvas.height !== ed.maskH) {
      sized(canvas, ed.maskW, ed.maskH);
    }
    return canvas;
  }

  function clearColourLayers() {
    for (const canvas of ed.colours.values()) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // 这一色的洞层。跟 colourLayer 一个形状，只是装的是「填出来的洞」。
  function fillLayerOf(name) {
    let canvas = ed.fillLayers.get(name);
    if (!canvas) {
      canvas = document.createElement("canvas");
      ed.fillLayers.set(name, canvas);
    }
    if (canvas.width !== ed.maskW || canvas.height !== ed.maskH) {
      sized(canvas, ed.maskW, ed.maskH);
    }
    return canvas;
  }

  function clearFillLayers() {
    for (const canvas of ed.fillLayers.values()) {
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // 叠颜色的顺序：这一色最后一次落笔越晚越靠上。没落过笔的（打开时自带的）
  // 排最前面垫底，剩下的按色板顺序，保证同一份状态每次画出来都一样。
  // 🔴 不能写死 TINT_ORDER：色板是 white→…→gray，用户先画黄再画红，红洞就会
  // 盖住黄笔（黄在红前面）。按落笔先后排才对得上「后画的上」这个直觉。
  const paintOrder = () => {
    const rank = (name) => ed.layerOrder.get(name) ?? -1;
    return [...TINT_ORDER].sort((a, b) => (rank(a) - rank(b)) || (TINT_ORDER.indexOf(a) - TINT_ORDER.indexOf(b)));
  };

  const hexRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  const blankColourLayer = () => {
    const canvas = document.createElement("canvas");
    sized(canvas, ed.maskW, ed.maskH);
    return canvas;
  };

  // 打开一张已经存过的成品：它的 RGB 是多色的，按最近邻归到九色之一，
  // 拆回各色层 —— 孤海 saveMaskImageData 之后也是这么把颜色读回来的
  // （syncColorLayersFromRawPaint）。`image` 的 RGB 是成品色、A 已经是遮罩值。
  function loadBaseColours(image, clean, strength) {
    const { width, height, data } = image;
    const clear = clean?.data ?? null;
    const ratio = Math.min(1, Math.max(0, Number(strength) || 0));
    // 先看这张成品到底有没有烧色：老版本存的成品 RGB 就是原图，硬拆只会把
    // 整张照片按最近邻归到一个颜色上，屏幕直接变灰板。
    let diff = 0;
    let inside = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 5) continue;
      if (!clear) { inside += 1; continue; }
      diff += Math.abs(data[i] - clear[i]) + Math.abs(data[i + 1] - clear[i + 1])
        + Math.abs(data[i + 2] - clear[i + 2]);
      inside += 1;
    }
    if (!inside || (clear && diff / (inside * 3) < 3)) {
      baseFallbackColour();
      return;
    }
    const palette = TINT_ORDER.map((name) => ({ name, rgb: hexRgb(TINT_HEX[name]) }));
    const images = new Map();
    for (const name of TINT_ORDER) images.set(name, new ImageData(width, height));
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha <= 5) continue;
      // 成品里的是「原图 ×(1-s) + 颜色 ×s」，先把颜色反解出来再分类 ——
      // 直接拿混合色做最近邻会跑偏（50% 绿混在土色上，最近的居然是中性灰）。
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (clear && ratio > 0.02) {
        const keep = 1 - ratio;
        r = (r - clear[i] * keep) / ratio;
        g = (g - clear[i + 1] * keep) / ratio;
        b = (b - clear[i + 2] * keep) / ratio;
      }
      let best = palette[0];
      let bestDistance = Infinity;
      for (const entry of palette) {
        const dr = r - entry.rgb[0];
        const dg = g - entry.rgb[1];
        const db = b - entry.rgb[2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          best = entry;
          bestDistance = distance;
        }
      }
      const target = images.get(best.name).data;
      target[i] = best.rgb[0];
      target[i + 1] = best.rgb[1];
      target[i + 2] = best.rgb[2];
      target[i + 3] = alpha;
    }
    for (const [name, img] of images) {
      const canvas = blankColourLayer();
      canvas.getContext("2d").putImageData(img, 0, 0);
      ed.baseLayers.set(name, canvas);
    }
  }

  // 拆不出颜色时（普通图自带的 alpha）：用当前笔色整块铺。
  function baseFallbackColour() {
    if (!ed.base) return;
    const canvas = baseColourCanvas();
    ed.baseLayers.set(ed.tint, canvas);
  }

  // 原图自带的 alpha 当初始遮罩时，也要落到某个色层上（用当前笔色），
  // 否则一打开编辑器就只剩 mask、屏幕上看不见。
  function baseColourCanvas() {
    const tmp = document.createElement("canvas");
    const ctx = sized(tmp, ed.maskW, ed.maskH);
    ctx.putImageData(ed.base, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = TINT_HEX[ed.tint];
    ctx.fillRect(0, 0, ed.maskW, ed.maskH);
    return tmp;
  }

  // 一笔落到该落的层上：画笔画到自己的色层；橡皮每层都要挖（否则换色重画时
  // 旧颜色会从别的层里透出来）。
  function replayStroke(stroke) {
    paintStroke(ed.mask.getContext("2d"), stroke, ed.maskScale);
    // 这一色自己的洞层也要跟着走，否则一下笔刚补好的洞会塌回去、抬笔又冒出来。
    // 🔴 洞层是彩色的：画上去必须用这一笔自己的颜色，用默认黑会留下黑块
    // （擦笔走 destination-out，颜色无关，给什么都行）。
    if (!stroke.o) {
      for (const canvas of ed.colours.values()) paintStroke(canvas.getContext("2d"), stroke, ed.maskScale);
      // 擦除要在**所有**洞层上挖：旧洞属于别的颜色，不挖就会从下面露出来。
      for (const canvas of ed.fillLayers.values()) {
        paintStroke(canvas.getContext("2d"), stroke, ed.maskScale);
      }
      return;
    }
    const name = colourName(stroke);
    paintStroke(colourLayer(name).getContext("2d"), stroke, ed.maskScale, TINT_HEX[name]);
    const fill = ed.fillLayers.get(name);
    if (fill) paintStroke(fill.getContext("2d"), stroke, ed.maskScale, TINT_HEX[name]);
  }

  // 把留着的每一笔重画一遍，拼出遮罩。初始那层（原图 alpha）先铺。
  // 🔴 画布必须是**缩小后**的 maskW × maskH：笔画坐标按 maskScale 落下来，
  // 画布要是按原图尺寸建，大图（长边 > PREVIEW_SIDE）上的笔迹会缩到左上角一小块
  // —— 屏幕上偏左上、存盘更偏，而且全尺寸画布每帧染色会卡成幻灯片。
  function rebuild() {
    const ctx = sized(ed.mask, ed.maskW, ed.maskH);
    ctx.clearRect(0, 0, ed.maskW, ed.maskH);
    clearColourLayers();
    // 洞层也要清：autoFill 关着的时候 refreshFill 直接 return，不清就会留着
    // 上一轮的洞，关掉开关却还看得见填出来的那块。
    clearFillLayers();
    if (ed.base) ctx.putImageData(ed.base, 0, 0);
    for (const stroke of ed.strokes) replayStroke(stroke);
    // 笔画变了，填洞的视图跟着重算（下一帧，别卡住当前这次绘制）。
    scheduleFill();
  }

  // 屏幕上看的那一层。彩色叠加时按色层一张张贴（每层本来就是自己的颜色，
  // 一笔一色就是这么来的）；只看遮罩时才统一染白。
  // 填充层叠在最上面 —— 洞用当前笔色补，跟存下去的一致。
  // 🔴 落笔期间也要跟手：新笔画在 `strokeInto()` 里同时画进色层与填充层，
  // 所以这里一直贴填充层也不会「画的时候不动」。
  // 每种颜色「自己那一片」叠成一组：底色层 → 笔画 → 这一色补出来的洞，
  // 组跟组之间按落笔先后排（`paintOrder()`）。洞跟着自己的颜色走，后画的
  // 颜色整组压在上面，所以红圈填满之后再画绿笔，绿笔不会被红洞盖掉。
  // 🔴 落笔期间也要跟手：新笔画落笔时就画进自己的色层（和已有的洞层），
  // 所以这里不需要额外的「临时层」。
  // 屏幕上看的那一层。三种显示方式共用同一份「按颜色分组」的叠法：
  // 🔴 「仅遮罩」不再涂白（以前 `source-in` 一刷全白，白底上等于什么都看不见，
  // 用户 2026-10-26 拿孤海对照才发现）。现在是「不画原图 + 遮罩按自己的颜色
  // 实色显示」，画的什么色、哪里漏了，一眼就能看出来。
  // 每种颜色「自己那一片」叠成一组：底色层 → 笔画 → 这一色补出来的洞，
  // 组跟组之间按落笔先后排（`paintOrder()`）。洞跟着自己的颜色走，后画的
  // 颜色整组压在上面，所以红圈填满之后再画绿笔，绿笔不会被红洞盖掉。
  // 🔴 落笔期间也要跟手：新笔画落笔时就画进自己的色层（和已有的洞层），
  // 所以这里不需要额外的「临时层」。
  function tintMask() {
    const ctx = sized(ed.tinted, ed.maskW, ed.maskH);
    ctx.clearRect(0, 0, ed.maskW, ed.maskH);
    for (const name of paintOrder()) {
      const base = ed.baseLayers.get(name);
      if (base) ctx.drawImage(base, 0, 0);
      const canvas = ed.colours.get(name);
      if (canvas) ctx.drawImage(canvas, 0, 0);
      const fill = ed.fillLayers.get(name);
      if (fill) ctx.drawImage(fill, 0, 0);
    }
  }

  // 一帧只画一次，染色也只在帧里做一次 —— 一帧里来十个 pointermove，
  // 也只会把遮罩重染一遍（以前是每个事件染一遍）。
  function schedule() {
    if (ed.frame || !ed.picture) return;
    ed.frame = requestAnimationFrame(() => {
      ed.frame = 0;
      tintMask();
      drawBase();
      drawTint();
      drawCursor();
    });
  }

  // 只重画笔尖那个圈：指针移动走这条，不碰底下两层。
  function scheduleCursor() {
    if (ed.cursorFrame || !ed.picture) return;
    ed.cursorFrame = requestAnimationFrame(() => {
      ed.cursorFrame = 0;
      drawCursor();
    });
  }

  // 三层用的是同一套尺寸，跟 stage 的内容盒对齐。
  function layerContext(canvas) {
    return sized(
      canvas,
      Math.max(1, Math.round(stage.clientWidth)),
      Math.max(1, Math.round(stage.clientHeight)),
    );
  }

  // 底图：换图 / 改尺寸 / 切显示方式时才重画。
  function drawBase() {
    const fit = ed.fit;
    const ctx = layerContext(baseLayer);
    ctx.clearRect(0, 0, baseLayer.width, baseLayer.height);
    ctx.fillStyle = "#080b0c";
    ctx.fillRect(0, 0, baseLayer.width, baseLayer.height);
    if (!fit || !ed.picture) return;
    ctx.imageSmoothingEnabled = true;
    // 底图只在改尺寸时缩一次，medium 已经看不出差别，high 明显更贵。
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(ed.picture, fit.left, fit.top, fit.width, fit.height);
  }

  // 遮罩色层：笔画变了才重画。缩的是软边，low 与 high 肉眼无差，速度差一截。
  function drawTint() {
    const fit = ed.fit;
    const ctx = layerContext(tintLayer);
    ctx.clearRect(0, 0, tintLayer.width, tintLayer.height);
    if (!fit || ed.mode === "plain") return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    // 预览的浓度跟「彩色叠加」完全一样（用户 2026-10-26 定的：显示永远带色，
    // 只有「原图」这一档才把遮罩藏掉）。
    ctx.globalAlpha = Math.max(0.02, ed.alpha / 100);
    ctx.drawImage(ed.tinted, fit.left, fit.top, fit.width, fit.height);
    ctx.globalAlpha = 1;
  }

  // 笔尖圈：最上面一层，指针一动就重画。
  // 🔴 只描一道白线，在白底图上整个圈看不见（用户在白底图上画时就撞上了）。
  // 先垫一道深色再描白：底图是深是浅都留得住轮廓。
  function drawCursor() {
    const fit = ed.fit;
    const ctx = layerContext(view);
    ctx.clearRect(0, 0, view.width, view.height);
    if (!ed.pointer || !fit || !ed.picture) return;
    const core = Math.max(1, brushCore(ed.size, ed.soft / 100) * fit.scale * ed.zoom);
    const reach = Math.max(core, brushReach(ed.size, ed.soft / 100) * fit.scale * ed.zoom);
    const wide = reach > core + 0.5;
    const [px, py] = ed.pointer;
    ctx.save();
    // 垫底：笔芯描粗一点的深色，软笔再加一圈更淡的深色
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, core, 0, Math.PI * 2);
    ctx.stroke();
    if (wide) {
      ctx.strokeStyle = "rgba(0,0,0,.32)";
      ctx.beginPath();
      ctx.arc(px, py, reach, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 正面：白色（按住 Ctrl / 右键反色时偏红）
    ctx.strokeStyle = ed.flip ? "rgba(255,120,120,.98)" : "rgba(255,255,255,.95)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, core, 0, Math.PI * 2);
    ctx.stroke();
    if (wide) {
      ctx.strokeStyle = ed.flip ? "rgba(255,120,120,.6)" : "rgba(255,255,255,.6)";
      ctx.beginPath();
      ctx.arc(px, py, reach, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 画面缩放：只改 frame 的 transform，canvas 一个像素都不重画。
  function applyZoom() {
    frame.style.transform = `translate(${ed.panX}px, ${ed.panY}px) scale(${ed.zoom})`;
    // 圈的大小跟着缩放走，得重画一次。
    scheduleCursor();
  }

  // 以指针为锚点缩放（跟孤海同一个公式）。
  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, ed.zoom * factor));
    if (next === ed.zoom) return;
    const mx = clientX - rect.left - rect.width / 2;
    const my = clientY - rect.top - rect.height / 2;
    const ratio = next / ed.zoom;
    ed.panX = mx + (ed.panX - mx) * ratio;
    ed.panY = my + (ed.panY - my) * ratio;
    ed.zoom = next;
    applyZoom();
  }

  // 三层一起重画（换图、改尺寸这类大动作）。
  function draw() {
    tintMask();
    drawBase();
    drawTint();
    drawCursor();
  }

  function relayout() {
    if (!ed.picture) return;
    ed.fit = fitRect(stage.clientWidth, stage.clientHeight, ed.width, ed.height);
    schedule();
  }

  // 视图坐标 → 原图像素。
  // 🔴 必须用 frame 的 rect 再除掉 zoom：画面被 CSS 缩放/平移过，用 view（不缩放那层）
  // 的 rect 等于假装没放大，笔迹会落到偏左上 —— 放大后越描越歪。
  function toPicture(event) {
    const fit = ed.fit;
    if (!fit?.scale || !ed.zoom) return null;
    const rect = frame.getBoundingClientRect();
    const x = (event.clientX - rect.left) / ed.zoom;
    const y = (event.clientY - rect.top) / ed.zoom;
    return [(x - fit.left) / fit.scale, (y - fit.top) / fit.scale];
  }

  // ---- 笔画 ----------------------------------------------------------------

  // 落笔落到哪几张画布上：遮罩、自己的色层、这一色的洞层。复用重放那条路径，
  // 免得「撤销重画」和「落笔」两套逻辑慢慢走散。
  const strokeInto = replayStroke;

  function beginStroke(event) {
    const point = toPicture(event);
    if (!point || ed.saving) return;
    ed.flip = brushFlips(event);
    const paint = ed.tool === "paint" ? !ed.flip : ed.flip;
    // 一笔一色：记下当前色点，撤销重画时才知道该落回哪一层。
    ed.stroke = { o: paint ? 1 : 0, d: ed.size, s: ed.soft, p: [point[0], point[1]], c: ed.tint };
    ed.undone.length = 0;
    // 这一色从现在起排在最后 —— 它（连同它那片洞）要压在别的颜色上面。
    // 只有画笔画才算：橡皮只挖，不改变「谁在上面」。
    if (paint) {
      ed.strokeSeq += 1;
      ed.layerOrder.set(colourName(ed.stroke), ed.strokeSeq);
    }
    // 这一笔先落到遮罩上，指针一动就接着补，所见即所得。
    strokeInto(ed.stroke);
    schedule();
    syncTools();
  }

  function extendTo(event) {
    const point = toPicture(event);
    if (!point || !ed.stroke) return;
    const points = ed.stroke.p;
    const before = points.length;
    if (!pushPoint(points, point[0], point[1], pointGap(ed.size)) && before === points.length) return;
    // 只补最后这一段，不整笔重画：粗笔在大图上重画一次看得出卡。
    const tail = points.slice(Math.max(0, points.length - 4));
    if (tail.length < 4) return;
    strokeInto({ ...ed.stroke, p: tail });
    schedule();
  }

  function endStroke(cancelled) {
    const stroke = ed.stroke;
    ed.stroke = null;
    if (!stroke) return;
    if (cancelled) {
      rebuild();
    } else {
      // 一笔只有起点（只是点了一下）也要留着：那就是一个圆点。
      ed.strokes.push(stroke);
      if (ed.strokes.length > MAX_UNDO * 4) ed.strokes.splice(0, ed.strokes.length - MAX_UNDO * 4);
      ed.dirty = true;
      // 这一笔可能把某个口子合上了，洞要重新算。
      scheduleFill();
    }
    syncTools();
  }

  function undo() {
    const stroke = ed.strokes.pop();
    if (!stroke) return;
    ed.undone.push(stroke);
    rebuild();
    syncTools();
  }

  function redo() {
    const stroke = ed.undone.pop();
    if (!stroke) return;
    ed.strokes.push(stroke);
    replayStroke(stroke);
    ed.dirty = true;
    scheduleFill();
    schedule();
    syncTools();
  }

  // 整张反过来：画的变成没画的。原图自带的那层也一起翻，翻两次回到原样。
  function invert() {
    const ctx = ed.mask.getContext("2d");
    const image = ctx.getImageData(0, 0, ed.mask.width, ed.mask.height);
    const data = image.data;
    for (let index = 3; index < data.length; index += 4) data[index] = 255 - data[index];
    ctx.putImageData(image, 0, 0);
    if (ed.base) {
      const base = ed.base;
      for (let index = 3; index < base.data.length; index += 4) base.data[index] = 255 - base.data[index];
    }
    ed.strokes.length = 0;
    ed.undone.length = 0;
    // 反色把笔画全清了，色层也得跟着重置 —— 整块用当前笔色铺一层。
    ed.baseLayers.clear();
    clearColourLayers();
    clearFillLayers();
    ed.layerOrder.clear();
    const layer = colourLayer(ed.tint);
    const lctx = sized(layer, ed.maskW, ed.maskH);
    lctx.clearRect(0, 0, ed.maskW, ed.maskH);
    lctx.drawImage(ed.mask, 0, 0);
    lctx.globalCompositeOperation = "source-in";
    lctx.fillStyle = TINT_HEX[ed.tint];
    lctx.fillRect(0, 0, ed.maskW, ed.maskH);
    lctx.globalCompositeOperation = "source-over";
    ed.dirty = true;
    scheduleFill();
    schedule();
    syncTools();
  }

  function clear() {
    ed.strokes.length = 0;
    ed.undone.length = 0;
    ed.base = null;
    ed.baseLayers.clear();
    clearFillLayers();
    ed.layerOrder.clear();
    ed.strokeSeq = 0;
    rebuild();
    ed.dirty = true;
    syncTools();
  }

  // 自动填洞：从四条边灌出去，灌不到的空白就是被遮罩围住的洞。
  // 碰得到边框的空白不是洞 —— 那是画面没被遮住的部分。
  //
  // 不膨胀、不闭运算。画笔画出的缝只要还通着外面，灌水就顺着缝流出去，那片就
  // 不算洞 —— 宁可少填，也不把用户没画的地方补上。旧版为了「点了一定有反应」
  // 先膨胀 2px 再灌，代价是每点一次外缘就胖一圈，做成自动模式会越画越肿。
  //
  // 但**算完洞之后**要把洞往笔迹里推 FILL_EDGE 像素（`growIntoWall`）：
  // 🔴 洞是按「alpha > 5 算墙」切出来的**硬边**，紧挨着的却是笔迹抗锯齿的
  // 软边（alpha 2%～90%）。255 直接掉到 6 再慢慢升回 255，50% 预览下就是
  // 一圈淡线；在白底图上特别像「一圈虚线」（用户报的就是这个）。
  // 孤海没这问题是因为 rebuildSingleColorFill 把墙一起涂成 255 了
  // （`if (!wall[index] && outside[index]) continue;`）—— 整张填好的图里
  // 除了「墙外的空白」全是实色。我们只在**洞这一侧**补实，笔迹外缘的软边
  // 照旧留着（那是我们比孤海细的地方）。
  //
  // 填出来的是一层「视图」（ed.filled），不改笔画：每次抬笔从 ed.mask 重算，
  // 擦掉一笔洞就自己回来，撤销也不用特殊照顾。
  //
  // 灌水：种子只取边框上的空白，走的每一步都要求那格不是墙。
  // 一层的洞：以**这一层自己的** alpha（> 5）为墙，从包围盒边界往外灌水，
  // 灌不到的空白就是被这层围住的洞。判据与孤海 rebuildSingleColorFill 一致。
  //
  // 🔴 必须逐层算，不能拿合并后的 mask 算一次完事 —— 洞的颜色得跟着「围住它的
  // 那一笔」走。用户用青笔围一圈、再换成红笔补别处，青圈里那片不该整块变红
  // （截图里就是这么错的：笔迹是青/蓝，填出来的却是紫/绿）。
  //
  // 包围盒外扩 1px 再灌：全图灌水在长边 4000 的图上是白白扫几百万个铁定通到
  // 外面的像素。
  function holesOfLayer(data, width, height) {
    const size = width * height;
    const wall = new Uint8Array(size);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let at = 0; at < size; at += 1) {
      if (data[at * 4 + 3] <= 5) continue;
      wall[at] = 1;
      const x = at % width;
      const y = (at - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0) return null;
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(width - 1, maxX + 1);
    maxY = Math.min(height - 1, maxY + 1);
    const outside = new Uint8Array(size);
    const queue = new Int32Array((maxX - minX + 1) * (maxY - minY + 1));
    let head = 0;
    let tail = 0;
    const visit = (x, y) => {
      if (x < minX || y < minY || x > maxX || y > maxY) return;
      const at = y * width + x;
      if (wall[at] || outside[at]) return;
      outside[at] = 1;
      queue[tail++] = at;
    };
    for (let x = minX; x <= maxX; x += 1) { visit(x, minY); visit(x, maxY); }
    for (let y = minY; y <= maxY; y += 1) { visit(minX, y); visit(maxX, y); }
    while (head < tail) {
      const at = queue[head++];
      const x = at % width;
      const y = (at - x) / width;
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    const holes = new Uint8Array(size);
    let count = 0;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const at = y * width + x;
        if (wall[at] || outside[at]) continue;
        holes[at] = 1;
        count += 1;
      }
    }
    if (!count) return null;
    count += growIntoWall(holes, data, width, height, minX, minY, maxX, maxY);
    return { holes, count };
  }

  // 把洞往墙里推 FILL_EDGE 像素。一轮只收「不是洞、但已经有颜色（alpha > 5）」
  // 的像素 —— 推到空白处会把遮罩撑胖，那正是旧版「点一下胖一圈」的毛病。
  // 先收集再标记，免得同一轮连着长出去两圈。
  function growIntoWall(holes, data, width, height, minX, minY, maxX, maxY) {
    let added = 0;
    for (let round = 0; round < FILL_EDGE; round += 1) {
      const ring = [];
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const at = y * width + x;
          if (holes[at] || data[at * 4 + 3] <= 5) continue;
          if ((x > 0 && holes[at - 1]) || (x < width - 1 && holes[at + 1])
            || (y > 0 && holes[at - width]) || (y < height - 1 && holes[at + width])) {
            ring.push(at);
          }
        }
      }
      if (!ring.length) break;
      for (const at of ring) {
        holes[at] = 1;
        added += 1;
      }
    }
    return added;
  }

  // 重算填充层：逐色灌水，洞用它自己那一层的颜色，落进**这一色自己的**洞层
  // （`fillLayers`）。autoFill 关着就清空，显示和保存都退回原始笔画。
  function refreshFill() {
    const previous = ed.filled;
    ed.filled = null;
    ed.fillCount = 0;
    clearFillLayers();
    if (!ed.autoFill) return;
    const width = ed.maskW;
    const height = ed.maskH;
    if (!width || !height) return;

    // 同色的「打开时自带」与「这一轮画的」先合成一张，再逐色灌水。
    const layers = new Map();
    for (const [name, canvas] of ed.baseLayers) layers.set(name, [canvas]);
    for (const [name, canvas] of ed.colours) {
      layers.set(name, [...(layers.get(name) ?? []), canvas]);
    }
    if (!layers.size) return;

    const flat = previous || document.createElement("canvas");
    const flatCtx = sized(flat, width, height);
    flatCtx.clearRect(0, 0, width, height);
    // 🔴 filled 是「**整张**遮罩」，不是「只有洞」：存盘用它挖 alpha、观察遮罩
    // 模式用它上白。只画洞的话笔迹从遮罩里消失（MASK 全 0、存盘整张不透明）。
    flatCtx.drawImage(ed.mask, 0, 0);

    // 打开时自带的那层遮罩（原图/成品的 alpha 反相）。它已经盖住的地方不用填。
    const baseData = ed.base && ed.base.width === width && ed.base.height === height ? ed.base.data : null;

    let total = 0;
    for (const [name, canvases] of layers) {
      const pctx = sized(document.createElement("canvas"), width, height);
      for (const canvas of canvases) pctx.drawImage(canvas, 0, 0);
      const data = pctx.getImageData(0, 0, width, height).data;
      const found = holesOfLayer(data, width, height);
      if (!found) continue;
      const [r, g, b] = hexRgb(TINT_HEX[name]);
      const image = new ImageData(width, height);
      const out = image.data;
      for (let at = 0; at < found.holes.length; at += 1) {
        if (!found.holes[at]) continue;
        const index = at * 4;
        // 🔴 只有一件事要剔：**打开时自带的遮罩已经盖住的地方，不用再填**。
        // 打开一张成品时 `baseLayers` 是按颜色拆开的**碎片**（一个像素只属于
        // 一个色），对碎片灌水会把碎片之间的小缝隙当洞，`growIntoWall` 再把缝
        // 撑成实心 —— 实测一张成品重开一次就多出 5 万多像素的假洞，颜色一轮
        // 一轮漂、越存越白。那块本来就遮住了，一个像素都不该改。
        //
        // 🔴 别的颜色画到的地方**不剔**。曾经加过「这一层的洞让给别的颜色的
        // 笔画」，结果红圈在里面套一圈绿时，红洞绕着绿笔留空、圈里露出绿色
        // （用户 2026-10-25 第二张截图）。谁在上面只由层序决定：
        //   先红填满 → 后画绿笔  ⇒ 绿组最后落笔，绿笔压在红洞上 ✓
        //   先绿填满 → 后画红圈  ⇒ 红组最后落笔，红洞连绿一起盖住 ✓
        // 两条都靠 `paintOrder()` 的落笔先后，不需要在这里特判。
        if (baseData && baseData[index + 3] > 5) continue;
        out[index] = r;
        out[index + 1] = g;
        out[index + 2] = b;
        out[index + 3] = 255;
      }
      const tmp = document.createElement("canvas");
      sized(tmp, width, height).putImageData(image, 0, 0);
      // 这一色的洞落到它自己的层上：显示与存盘都按「层序」叠，洞就跟这一色的
      // 笔画待在一起 —— 不会被后画的颜色顶掉，也不会顶掉后画的颜色。
      sized(fillLayerOf(name), width, height).drawImage(tmp, 0, 0);
      // filled 只被读 alpha（MASK 与存盘的挖洞都用它），颜色无所谓。
      flatCtx.drawImage(tmp, 0, 0);
      total += found.count;
    }
    if (!total) return;
    ed.filled = flat;
    ed.fillCount = total;
  }

  // 抬笔后才算，并且一帧只算一次 —— 拖动过程中每次都灌一遍全图太贵。
  let fillFrame = 0;
  function scheduleFill() {
    if (fillFrame) return;
    fillFrame = requestAnimationFrame(() => {
      fillFrame = 0;
      refreshFill();
      schedule();
    });
  }

  // ---- 存盘 ----------------------------------------------------------------

  // 与后端 qg_load_image.py 同一套命名，两个文件同一次保存共用同一个 13 位
  // 时间戳，靠它配对：
  //   clipspace/qg-src-<stamp>.png              原图副本，只为了留住它自己的 alpha
  //   clipspace/qg-painted-<stem>-<stamp>.png   成品：RGB 是画面，A 是遮罩
  // 分开存的好处就是孤海那套的核心：成品里的 alpha 是遮罩，不是透明，所以读的
  // 时候必须拿原图副本的 alpha 换回去，画面才不会出现白块黑块。
  const PAINTED_PATTERN = /^qg-painted-(.+)-(\d{13})\.png$/i;

  // 原始文件名（不带目录、扩展名、[input] 标注）。二次编辑的是成品名，要先剥回
  // 最初那个名字，否则会一路长成 qg-painted-qg-painted-…。
  function originalStem() {
    const raw = String(ed.name || "").split("[")[0].trim().replaceAll("\\", "/");
    const file = raw.slice(raw.lastIndexOf("/") + 1);
    let stem = file.replace(/\.[^.]+$/, "");
    for (let guard = 0; guard < 4; guard += 1) {
      const match = PAINTED_PATTERN.exec(`${stem}.png`);
      if (!match) break;
      stem = match[1];
    }
    return stem || "picture";
  }

  // upload/image 收 FormData，落到 input 下的 subfolder 里。返回存下来的相对路径。
  async function uploadPng(blob, name) {
    const body = new FormData();
    body.append("image", blob, name);
    body.append("type", "input");
    body.append("subfolder", "clipspace");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try { message = JSON.parse(text).error || text; } catch { /* 原样用文本 */ }
      throw new Error(message || `Upload failed (${response.status}).`);
    }
    let answer = {};
    try { answer = JSON.parse(text); } catch { /* 只信文件名 */ }
    const stored = String(answer.name ?? name);
    return answer.subfolder ? `${answer.subfolder}/${stored}` : stored;
  }

  // 只想留住原图的 alpha，所以颜色脏不脏无所谓 —— 后端也只读第四个通道。
  // canvas 是预乘 alpha 的，正好说明这里不能拿它当「原图副本」用来看颜色。
  function sourceBlob() {
    const out = document.createElement("canvas");
    const ctx = sized(out, ed.width, ed.height);
    ctx.drawImage(ed.picture, 0, 0, ed.width, ed.height);
    return new Promise((resolve, reject) => {
      out.toBlob((made) => (made ? resolve(made) : reject(new Error(zh("The browser could not make this image.")))), "image/png");
    });
  }

  async function save() {
    if (ed.saving || !ed.picture) return;
    ed.saving = true;
    busy.hidden = false;
    busy.textContent = zh("Saving…");
    syncTools();
    try {
      // 保存前把填充同步算一次：抬笔后那次是排在一帧之后的，用户可能紧接着
      // 就点了保存，不能存出一张还没填的图。
      refreshFill();
      const maskSource = ed.filled || ed.mask;

      // ① 画面 + 多色：全部是不透明绘制，做出来的 RGB 就是成品要留的颜色。
      //    颜色按「底栏滑条那个百分比」混，所以成品里的色和屏幕上看到的一致。
      const out = document.createElement("canvas");
      const ctx = sized(out, ed.width, ed.height);
      ctx.drawImage(ed.picture, 0, 0, ed.width, ed.height);
      const strength = Math.min(1, Math.max(0, ed.alpha / 100));
      if (strength > 0) {
        ctx.globalAlpha = strength;
        // 与屏幕同一套层序：每色的 底 → 笔画 → 洞 一组，组间按落笔先后。
        for (const name of paintOrder()) {
          const base = ed.baseLayers.get(name);
          if (base) ctx.drawImage(base, 0, 0, ed.width, ed.height);
          const layer = ed.colours.get(name);
          if (layer) ctx.drawImage(layer, 0, 0, ed.width, ed.height);
          const fill = ed.fillLayers.get(name);
          if (fill) ctx.drawImage(fill, 0, 0, ed.width, ed.height);
        }
        ctx.globalAlpha = 1;
      }
      const pixels = ctx.getImageData(0, 0, ed.width, ed.height);
      const data = pixels.data;

      // ② alpha 单独算：遮罩处归零（MASK 读的就是 1 - alpha）。
      //    🔴 不能直接 destination-out —— canvas 是预乘 alpha 存的，那样会把刚混好的
      //    RGB 一起乘暗，颜色直接废掉。所以只改 A 通道，RGB 一个字节都别碰。
      //
      // 🔴 先在这**之前**把「不透明的那一版」编出来：成品写出去以后遮罩区 alpha=0，
      //    浏览器读回 PNG 时会把透明像素的 RGB 清零，颜色就丢了 —— 二次编辑时
      //    反解只能落到灰（实测 50% 绿的圆重开变成 128,128,128）。多存一份
      //    `qg-view`，只给编辑器取颜色用，不参与 IMAGE / MASK。
      const viewBlob = (await encodeRgbaPng(ed.width, ed.height, data))
        ?? await new Promise((resolve, reject) => {
          out.toBlob((made) => (made ? resolve(made) : reject(new Error(zh("The browser could not make this image.")))), "image/png");
        });

      const cover = document.createElement("canvas");
      const coverCtx = sized(cover, ed.width, ed.height);
      coverCtx.drawImage(maskSource, 0, 0, ed.width, ed.height);
      const covered = coverCtx.getImageData(0, 0, ed.width, ed.height).data;
      for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = 255 - covered[i + 3];
      }
      ctx.putImageData(pixels, 0, 0);

      // canvas.toBlob 写不出「透明 + 带颜色」，所以自己编码；编不了就退回它。
      const blob = (await encodeRgbaPng(ed.width, ed.height, data))
        ?? await new Promise((resolve, reject) => {
          out.toBlob((made) => (made ? resolve(made) : reject(new Error(zh("The browser could not make this image.")))), "image/png");
        });

      // 先存原图副本：它是后端把 alpha 换回来的唯一依据，缺了这一步的成品会
      // 变成「整张不透明」，所以它失败就整次保存失败，不留半套文件。
      const stamp = String(Date.now());
      await uploadPng(await sourceBlob(), `qg-src-${stamp}.png`);
      await uploadPng(viewBlob, `qg-view-${stamp}.png`);
      const stored = await uploadPng(blob, `qg-painted-${originalStem()}-${stamp}.png`);

      showToast({
        severity: "success",
        summary: zh("Mask editor"),
        detail: zh("Saved as {name}.").replace("{name}", stored),
        life: 4000,
      });
      ed.dirty = false;
      // 输出档位跟着显示方式走：只有「彩色叠加」的成品带颜色。
      onSaved?.(stored, { colour: ed.tint, alpha: ed.alpha, tintOutput: ed.mode === "tint" });
      controller.abort();
    } catch (error) {
      showToast({ severity: "error", summary: zh("Mask editor"), detail: String(error?.message ?? error), life: 8000 });
    } finally {
      ed.saving = false;
      busy.hidden = true;
      syncTools();
    }
  }

  // ---- 界面 ----------------------------------------------------------------

  const button = (label, tip) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "qgtools-mask-btn";
    el.textContent = label;
    if (tip) el.title = tip;
    el.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    return el;
  };

  const toolPaint = button(zh("Paint"), zh("Paint the mask on. B"));
  const toolErase = button(zh("Erase"), zh("Rub the mask out. E"));
  const undoBtn = button(zh("Undo"), zh("Undo the last stroke. Ctrl+Z"));
  const redoBtn = button(zh("Redo"), zh("Put the last stroke back. Ctrl+Shift+Z"));
  const clearBtn = button(zh("Clear"), zh("Throw the whole mask away."));
  const invertBtn = button(zh("Invert"), zh("Swap what is masked and what is not."));
  const holesBtn = button(zh("Auto fill holes"), zh("Fill the gaps the mask closes all the way round, after every stroke. On by default."));

  // 🔴 这三段决定的是**存出去长什么样**，不是屏幕上长什么样（用户 2026-10-26 定的，
  // 照孤海的做法）：除了「原图」这一档把遮罩藏起来看原样，另外两档屏幕上一模一样
  // —— 都是「画面 + 彩色遮罩」，只有存出去的成品不同。
  // 「原图」留着是为了临时看原样（查哪里漏了），存出去仍然只存遮罩。
  const MODES = [
    {
      key: "tint",
      en: "Colour overlay",
      cn: "彩色叠加",
      tipEn: "Saved picture carries the colours. The screen looks the same as Mask only.",
      tipCn: "存出去的成品带颜色。屏幕上跟「仅遮罩」一模一样。",
    },
    {
      key: "mask",
      en: "Mask only",
      cn: "仅遮罩",
      tipEn: "Saved picture is the mask only — no colour. The screen still shows the coloured picture.",
      tipCn: "存出去的成品只有遮罩、不带颜色。屏幕上照样是带色的图。",
    },
    {
      key: "plain",
      en: "Picture only",
      cn: "原图",
      tipEn: "Hide the colours and look at the plain picture. Saving is still mask only.",
      tipCn: "把颜色藏起来看原样。存出去仍然只存遮罩。",
    },
  ];
  const modeSeg = document.createElement("div");
  modeSeg.className = "qgtools-mask-seg";
  modeSeg.title = zhPair(
    "What gets saved: Colour overlay bakes the colours in; the other two save the mask only. The screen always shows the coloured picture except in Picture only.",
    "存出去的成品长什么样：彩色叠加带颜色，另两个只存遮罩。屏幕上除了「原图」那一档，看到的都是带色的图。",
  );
  const modeButtons = MODES.map((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.mode = entry.key;
    btn.textContent = zhPair(entry.en, entry.cn);
    btn.title = zhPair(entry.tipEn, entry.tipCn);
    btn.addEventListener("click", () => {
      if (ed.mode === entry.key) return;
      ed.mode = entry.key;
      syncTools();
      schedule();
    }, { signal });
    modeSeg.append(btn);
    return btn;
  });

  toolPaint.addEventListener("click", () => { ed.tool = "paint"; syncTools(); }, { signal });
  toolErase.addEventListener("click", () => { ed.tool = "erase"; syncTools(); }, { signal });
  undoBtn.addEventListener("click", () => undo(), { signal });
  redoBtn.addEventListener("click", () => redo(), { signal });
  clearBtn.addEventListener("click", () => clear(), { signal });
  invertBtn.addEventListener("click", () => invert(), { signal });
  holesBtn.addEventListener("click", () => {
    ed.autoFill = !ed.autoFill;
    // 打开时立刻算一次，不用等下一笔；关掉就把填充层撤掉，回到原始笔画。
    if (ed.autoFill) {
      refreshFill();
      schedule();
    } else {
      scheduleFill();
    }
    if (ed.fillCount) {
      showToast({
        severity: "info",
        summary: zh("Mask editor"),
        detail: zh("Filled {count} pixels of holes.").replace("{count}", String(ed.fillCount)),
        life: 2500,
      });
    }
    syncTools();
  }, { signal });

  bars.append(toolPaint, toolErase, undoBtn, redoBtn, clearBtn, invertBtn, holesBtn, modeSeg);

  // 底栏三件（笔宽 / 软度 / 透明度）用滑条，不用数字框。
  // 数字框看着像输入框，得先把指针按上去左右拖才知道能拖；滑条一眼就能看出
  // 「现在在范围里的哪儿」，还能直接拖、点轨道、按方向键。读数留在右边，
  // 单位也带上，精确值一点没少。
  const makeSlider = ({
    label, min, max, step, value,
    width = 100, unit = "", title = "", onChange, onSettle,
  }) => {
    const wrap = document.createElement("div");
    wrap.className = "qgtools-mask-field";
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.className = "qgtools-mask-range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.style.width = `${width}px`;
    if (title) input.title = title;
    const readout = document.createElement("span");
    readout.className = "qgtools-mask-readout";
    // 落到步长上再夹一次：range 自己会 snap，但从别处（Alt 拖拽、[ ] 键）走进来
    // 的值不一定在格点上。
    const snap = (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return min;
      const stepped = Math.round((n - min) / step) * step + min;
      return Math.min(max, Math.max(min, Math.round(stepped * 1000) / 1000));
    };
    const paint = (n) => {
      readout.textContent = unit ? `${n} ${unit}` : String(n);
    };
    const set = (next) => {
      const n = snap(next);
      input.value = String(n);
      paint(n);
      return n;
    };
    set(value);
    input.addEventListener("input", () => {
      const n = snap(input.value);
      paint(n);
      onChange?.(n);
    });
    input.addEventListener("change", () => onSettle?.(snap(input.value)));
    // 方向键自己算：Chromium 对 range 的原生键盘步进在画布上会被更早的
    // capture 监听吞掉（实测按 ↑ 值纹丝不动），索性自己按 step 加减，
    // 顺带保证「一步就是一个步长」，不受浏览器实现影响。
    input.addEventListener("keydown", (event) => {
      const up = event.key === "ArrowUp" || event.key === "ArrowRight";
      const down = event.key === "ArrowDown" || event.key === "ArrowLeft";
      if (!up && !down) return;
      event.preventDefault();
      event.stopPropagation();
      const next = Math.min(max, Math.max(min, snap(input.value) + (up ? step : -step)));
      input.value = String(next);
      paint(next);
      onChange?.(next);
      onSettle?.(next);
    });
    // 滑条自己吃掉指针事件：别让底下的画布顺手画上一笔。
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    wrap.append(text, input, readout);
    return { root: wrap, set };
  };

  const sizeBox = makeSlider({
    label: zh("Brush size"),
    min: BRUSH_RANGE[0],
    max: BRUSH_RANGE[1],
    step: 2,
    value: ed.size,
    width: 110,
    unit: "px",
    title: zh("How wide the brush is, in picture pixels."),
    onChange: (value) => { ed.size = clampBrushSize(value, BRUSH_RANGE); schedule(); },
    onSettle: () => schedule(),
  });
  const softBox = makeSlider({
    label: zh("Brush soft"),
    min: 0,
    max: 100,
    step: 5,
    value: ed.soft,
    width: 92,
    unit: "%",
    title: zh("How soft the brush edge is: 0 is hard, 100 fades from the middle."),
    onChange: (value) => { ed.soft = clampSoft(value); schedule(); },
    onSettle: () => schedule(),
  });
  // 叠加色有多实。画完随时能拖着看，存盘时带给节点，带色图按它混。
  const alphaBox = makeSlider({
    label: zh("Opacity"),
    min: 0,
    max: 100,
    step: 5,
    value: ed.alpha,
    width: 92,
    unit: "%",
    title: zh("How strong the colour overlay is. Also the strength the tinted output uses."),
    onChange: (value) => {
      ed.alpha = Math.min(100, Math.max(0, Number(value) || 0));
      schedule();
    },
    onSettle: () => schedule(),
  });


  const swatches = document.createElement("div");
  swatches.className = "qgtools-mask-swatches";
  const dots = new Map();
  for (const name of TINT_ORDER) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "qgtools-mask-swatch";
    dot.style.background = TINT_HEX[name];
    dot.title = TINT_TIP[name];
    dot.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    dot.addEventListener("click", () => {
      ed.tint = name;
      for (const [key, el] of dots) el.classList.toggle("on", key === name);
      // 洞是用「当前笔色」补的：换色要重算一次填充层，否则洞还挂着旧颜色。
      refreshFill();
      schedule();
    }, { signal });
    swatches.append(dot);
    dots.set(name, dot);
  }

  const cancel = button(zh("Cancel"));
  const saveBtn = button(zh("Save"), zh("Write the mask into a new file and use it."));
  saveBtn.classList.add("primary");
  cancel.addEventListener("click", () => controller.abort(), { signal });
  saveBtn.addEventListener("click", () => save(), { signal });

  const footSpacer = document.createElement("span");
  footSpacer.className = "qgtools-mask-spacer";
  foot.append(
    sizeBox.root,
    softBox.root,
    alphaBox.root,
    swatches,
    footSpacer,
    cancel,
    saveBtn,
  );

  function syncTools() {
    toolPaint.classList.toggle("on", ed.tool === "paint");
    toolErase.classList.toggle("on", ed.tool === "erase");
    undoBtn.disabled = !ed.strokes.length;
    redoBtn.disabled = !ed.undone.length;
    saveBtn.disabled = ed.saving || !ed.picture;
    cancel.disabled = ed.saving;
    holesBtn.classList.toggle("on", ed.autoFill);
    for (const btn of modeButtons) btn.classList.toggle("on", btn.dataset.mode === ed.mode);
    // 笔画、[ ] 键、Alt 拖拽都会改笔，滑条得跟着回到新位置。
    sizeBox.set(ed.size);
    softBox.set(ed.soft);
    alphaBox.set(ed.alpha);
    for (const [key, el] of dots) el.classList.toggle("on", key === ed.tint);
    const [sizeWord, softWord] = brushWords(ed.size, ed.soft);
    const zoomWord = ed.zoom === 1 ? "" : ` · ${Math.round(ed.zoom * 100)}%`;
    hint.textContent = ed.pointer
      ? `${sizeWord} · ${softWord}${zoomWord}\n${zh("Right button or Ctrl does the opposite tool. Alt + right drag resizes. Wheel zooms, Space or middle drag pans.")}`
      : zh("Drag to paint. [ and ] resize, Shift + [ ] soften. Alt + right drag adjusts. Ctrl+Z undoes. Wheel zooms, Space or middle drag pans.");
  }

  // ---- 指针与键盘 -----------------------------------------------------------

  view.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (ed.saving) return;
    // 中键，或按住空格：拖画面（跟孤海一样）。
    if (event.button === 1 || (event.button === 0 && ed.spaceDown)) {
      ed.panning = { x: event.clientX, y: event.clientY, px: ed.panX, py: ed.panY };
      view.setPointerCapture?.(event.pointerId);
      stage.classList.add("dragging");
      return;
    }
    if (brushAdjusts(event)) {
      const rect = view.getBoundingClientRect();
      ed.adjust = startAdjust(event.clientX - rect.left, event.clientY - rect.top, { size: ed.size, soft: ed.soft }, BRUSH_RANGE);
      view.setPointerCapture?.(event.pointerId);
      return;
    }
    view.setPointerCapture?.(event.pointerId);
    beginStroke(event);
  }, { signal });

  view.addEventListener("pointermove", (event) => {
    const rect = view.getBoundingClientRect();
    ed.pointer = [event.clientX - rect.left, event.clientY - rect.top];
    // 悬停时也认 Ctrl / 右键：按住 Ctrl 笔尖圈就变红，不用等落笔才知道自己在擦。
    // pointermove 的 button 恒为 -1（没按键），所以这里只可能读到 ctrlKey。
    ed.flip = brushFlips(event);
    if (ed.panning) {
      ed.panX = ed.panning.px + (event.clientX - ed.panning.x);
      ed.panY = ed.panning.py + (event.clientY - ed.panning.y);
      applyZoom();
      syncTools();
      return;
    }
    if (ed.adjust) {
      const next = moveAdjust(ed.adjust, ed.pointer[0], ed.pointer[1], 1);
      ed.adjust = next;
      ed.size = next.brush.size;
      ed.soft = next.brush.soft;
      sizeBox.set(next.brush.size);
      softBox.set(next.brush.soft);
      // 只是圈在变大变小，底下两层一个像素都没变。
      scheduleCursor();
      syncTools();
      return;
    }
    if (ed.stroke) extendTo(event);
    else scheduleCursor();
  }, { signal });

  const finish = (cancelled) => {
    if (ed.adjust) {
      ed.adjust = null;
      syncTools();
      return;
    }
    endStroke(cancelled);
  };
  const endPan = () => {
    if (!ed.panning) return false;
    ed.panning = null;
    stage.classList.remove("dragging");
    return true;
  };
  view.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    if (endPan()) return;
    finish(false);
  }, { signal });
  view.addEventListener("pointercancel", () => {
    if (endPan()) return;
    finish(true);
  }, { signal });
  view.addEventListener("pointerleave", () => {
    if (ed.stroke || ed.adjust || ed.panning) return;
    ed.pointer = null;
    ed.flipKey = false;
    scheduleCursor();
    syncTools();
  }, { signal });
  // 滚轮缩放，以指针为锚点。放大到能抠细节，缩到能看全图。
  stage.addEventListener("wheel", (event) => {
    if (ed.saving) return;
    event.preventDefault();
    event.stopPropagation();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 0.89);
  }, { passive: false, signal });

  view.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { signal });

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      controller.abort();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key?.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      save();
      return;
    }
    if (event.code === "Space" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (!ed.spaceDown) {
        ed.spaceDown = true;
        stage.classList.add("panning");
      }
      return;
    }
    if (event.key?.toLowerCase() === "b" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      ed.tool = "paint";
      syncTools();
      return;
    }
    if (event.key?.toLowerCase() === "e" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      ed.tool = "erase";
      syncTools();
      return;
    }
    const change = brushKey(event);
    if (!change) return;
    event.preventDefault();
    event.stopPropagation();
    if (change.what === "size") ed.size = steppedBrushSize(ed.size, change.up, BRUSH_RANGE);
    else ed.soft = steppedSoft(ed.soft, !change.up);
    sizeBox.set(ed.size);
    softBox.set(ed.soft);
    schedule();
    syncTools();
  };
  // 键盘挂在文档上：画布不会自己拿到焦点。用 capture 抢在 ComfyUI 前面，
  // 不然空格、Delete 这些会被画布吃掉。
  document.addEventListener("keydown", onKey, { signal, capture: true });
  document.addEventListener("keyup", (event) => {
    if (event.code !== "Space" && event.key !== " ") return;
    ed.spaceDown = false;
    stage.classList.remove("panning");
    syncTools();
  }, { signal, capture: true });


  const resizeObserver = new ResizeObserver(() => relayout());
  resizeObserver.observe(stage);
  signal.addEventListener("abort", () => resizeObserver.disconnect());

  close.addEventListener("click", () => controller.abort(), { signal });

  signal.addEventListener("abort", () => {
    if (ed.frame) cancelAnimationFrame(ed.frame);
    modal.remove();
    if (ed.dirty) notifyQgChange();
  });

  // ---- 打开图片 ------------------------------------------------------------

  busy.hidden = false;
  busy.textContent = zh("Loading…");

  const loadImage = (url) =>
    new Promise((resolve) => {
      if (!url) {
        resolve(null);
        return;
      }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });

  const picture = new Image();
  picture.onload = async () => {
    ed.picture = picture;
    ed.width = picture.naturalWidth;
    ed.height = picture.naturalHeight;
    // 遮罩位图：长边压到 PREVIEW_SIDE，笔画坐标仍是原图像素。
    ed.maskScale = Math.min(1, PREVIEW_SIDE / Math.max(ed.width, ed.height));
    // 共用「图像对比」那个默认值（长边的二十四分之一），但夹进这个编辑器
    // 自己的范围：那边能到 2000，这边 600 就够画遮罩了。
    ed.size = clampBrushSize(defaultBrushSize(ed.width, ed.height), BRUSH_RANGE);
    sizeBox.set(ed.size);
    softBox.set(ed.soft);
    // 遮罩从哪来：存盘的成品把遮罩放在 alpha 里，画面那张是不透明的，所以
    // 二次编辑要单独读它；普通图片（比如官方遮罩编辑器存的图）自带的 alpha
    // 就是现成的遮罩，直接铺上接着改。
    const carried = maskUrl ? await loadImage(maskUrl) : picture;
    const maskW = Math.max(1, Math.round(ed.width * ed.maskScale));
    const maskH = Math.max(1, Math.round(ed.height * ed.maskScale));
    ed.maskW = maskW;
    ed.maskH = maskH;
    const probe = sized(document.createElement("canvas"), maskW, maskH);
    probe.clearRect(0, 0, maskW, maskH);
    probe.drawImage(carried ?? picture, 0, 0, maskW, maskH);
    const data = probe.getImageData(0, 0, maskW, maskH);
    let hasAlpha = false;
    // 只翻 alpha，RGB 留着 —— 成品里那层颜色要靠它拆回各色层。
    for (let index = 3; index < data.data.length; index += 4) {
      const alpha = data.data[index];
      if (alpha < 255) hasAlpha = true;
      data.data[index] = 255 - alpha;
    }
    // 🔴 成品那张的遮罩区是**全透明**的（alpha = 255 - 遮罩），浏览器把透明像素的
    // RGB 一律清零 —— 读回来遮罩区就是 (0,0,0)，反解颜色只能落到灰。
    // 所以存盘时另外留了一份不透明的「带色画面」（qg-view），这里把 RGB 抄回来。
    // 老存档没有这份，退化成原来的行为（颜色会偏，但形状和遮罩都对）。
    let viewMissing = false;
    if (maskUrl && viewUrl) {
      const view = await loadImage(viewUrl);
      if (view) {
        const viewCtx = sized(document.createElement("canvas"), maskW, maskH);
        viewCtx.drawImage(view, 0, 0, maskW, maskH);
        const vd = viewCtx.getImageData(0, 0, maskW, maskH).data;
        for (let index = 0; index < data.data.length; index += 4) {
          data.data[index] = vd[index];
          data.data[index + 1] = vd[index + 1];
          data.data[index + 2] = vd[index + 2];
        }
      } else {
        viewMissing = true;
      }
    }
    ed.base = hasAlpha ? data : null;
    ed.baseLayers.clear();
    if (ed.base) {
      if (maskUrl) {
        // 🔴 sized() 返回的是 2d context，不是 canvas —— 名字骗人，别直接 .getContext。
        const cleanCtx = sized(document.createElement("canvas"), maskW, maskH);
        cleanCtx.drawImage(picture, 0, 0, maskW, maskH);
        loadBaseColours(data, cleanCtx.getImageData(0, 0, maskW, maskH), ed.alpha / 100);
      }
      // 没有成品（普通图自带 alpha，比如官方遮罩编辑器存的）：RGB 是原图，
      // 拆不出颜色，就整块铺当前笔色。
      else baseFallbackColour();
    }
    if (viewMissing) {
      console.warn("[QG-tools] 遮罩编辑器：缺少 qg-view 副本，颜色只能按混合色猜，可能偏灰");
    }
    rebuild();
    ed.fit = fitRect(stage.clientWidth, stage.clientHeight, ed.width, ed.height);
    busy.hidden = true;
    schedule();
    syncTools();
  };
  picture.onerror = () => {
    busy.hidden = false;
    busy.textContent = zh("Could not load this image.");
  };
  picture.src = imageUrl;

  return () => controller.abort();
}
