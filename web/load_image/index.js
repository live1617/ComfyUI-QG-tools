// QG 加载图像 —— 选择行 + 大图舞台 + 遮罩编辑器（前端）
//
// 口径照孤海那支「加载图像」：三个输出（图像 / 遮罩 / 文件名），一个开关
// 「保留透明通道」。遮罩不进画面 —— 编辑器保存时另存一份原图副本，后端读的
// 时候把原图的 alpha 换回去，所以 IMAGE 永远是画之前那张图，遮罩只走 MASK。
// 这一版只求功能跑通，面板样式之后再重新设计。
//
// 为什么自己画预览：核心的 Load Image 预览按固定高度画，竖图会缩成一条；而这个
// 节点最常被问的就是「我选的到底是哪张、多大」。所以把原生 `image` 控件藏掉，
// 换成带悬浮预览的选择器（shared/media_picker），下面一行写宽 × 高。
//
// 原生 `upload` 按钮不要，我们这行里有一个；核心的 $$canvas-image-preview 必须
// 抑制，否则会和我们这张图重复（widget_visibility.suppressCoreImagePreview）。
//
// 遮罩编辑器模块是**动态加载**的：静态 import 一旦失败（文件没同步、缓存串对不
// 上），整份扩展都不会注册，节点会连面板和上传按钮一起消失 —— 现在它自己挂自己
// 倒，面板照旧在，只是「编辑遮罩」按钮灰着。
//
// 舞台高度由图片比例定死（90~420），面板高度因此是常数：Vue 的外壳和 size 不会
// 互相追，经典模式用 computeSize 把节点拉齐。拖节点下边缘不会让图变大 —— 改宽
// 度才会。

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange } from "../shared/index.mjs?v=2026102915";
import { createMediaPicker } from "../shared/media_picker.mjs?v=2026102915";
import { fillNodeHeight } from "../shared/panel_layout.mjs?v=2026102915";
import { heightFor, sizeFor } from "../shared/node_width.mjs?v=2026102915";
import { fitNodeToPanelHeight, unwatchVueShell, watchVueShell } from "../shared/vue_panel_fit.mjs?v=2026102915";
import { commitWidgetValue } from "../shared/widget_card_math.mjs?v=2026102915";
import { vueNodesEnabled } from "../shared/vue_mode.mjs?v=2026102915";
import { hideInputsInDef, hideWidget, suppressCoreImagePreview } from "../shared/widget_visibility.mjs?v=2026102915";
import { zh, zhPair } from "../shared/zh.mjs?v=2026102915";

const NODE_CLASS = "QG_LoadImage";
const CSS_ID = "qgtools-load-image-css";
const PANEL_WIDGET = "qg_load_panel";

// 输出只有两个。存档里多出来的槽（彩色叠加 / 宽 / 高 / 帧数 / 文件名）在
// beforeConfigureGraph 里截掉，连带着把从那些槽引出的线一起丢掉 —— 后端已经
// 不返回它们了，留着只会是一组牵不出值的悬空槽。
const KEPT_OUTPUTS = 2;
const LEGACY_OUTPUT_NAMES = new Set(["OVERLAY", "WIDTH", "HEIGHT", "FRAMES", "NAME", "STRING"]);

const ROW_H = 26;
const GAP = 7;
const PAD = 8;
const META_H = 21;
const BORDER_H = 2;  // 面板自己那圈 1px 边框，上下各一
// 宽度 / 最小宽 / 默认高全部取自 shared/node_width.mjs 的尺寸表。
// 表里填了 `h` 就听表的；没填按 1.5（2:3）比例由宽度算。
const MIN_WIDTH = sizeFor("QG_LoadImage").minW;
const DEFAULT_WIDTH = sizeFor("QG_LoadImage").w;
const DEFAULT_HEIGHT = heightFor("QG_LoadImage") ?? Math.round(DEFAULT_WIDTH * 1.5);
// 舞台高度是常数：节点多大由用户拖，不由图片决定。选一张 2560 x 3413 的竖图
// 不该把节点撑成一根细高条 —— 图片在框里等比缩到装得下（object-fit: contain），
// 不裁切、也不回头改节点尺寸。
const STAGE_H = 200;
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;

// 遮罩编辑器：动态加载，见文件头。预热一次，点按钮时通常已经就绪。
let maskEditor = null;
function loadMaskEditor() {
  if (maskEditor) return Promise.resolve(maskEditor);
  return import("../shared/mask_editor.mjs?v=2026102915").then(
    (module) => (maskEditor = module),
    (error) => {
      console.error("[QG-tools] mask editor failed to load", error);
      return null;
    },
  );
}
void loadMaskEditor();

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-load-panel{position:relative;box-sizing:border-box;display:flex;flex-direction:column;gap:${GAP}px;width:100%;height:100%;padding:${PAD}px;border:1px solid rgba(0,180,170,.22);border-radius:8px;background:rgba(0,0,0,.28);font:12px/1.3 ${FONT};color:#c8dddd;overflow:hidden}
.qgtools-load-row{display:flex;align-items:center;gap:6px;height:${ROW_H}px;flex:none;min-width:0}
.qgtools-load-row>.qgtools-card-select,.qgtools-load-row>.qgtools-media-pick{flex:1 1 0;min-width:0}
.qgtools-load-upload{flex:none;height:${ROW_H}px;display:flex;align-items:center;padding:0 10px;box-sizing:border-box;border:1px solid #2a3437;border-radius:6px;background:#16201f;color:#d8ecea;font:600 11px/1 ${FONT};cursor:pointer;white-space:nowrap}
.qgtools-load-upload:hover{border-color:${BRAND};color:#fff}
.qgtools-load-upload[aria-busy="true"]{opacity:.6;pointer-events:none}
.qgtools-load-upload input{display:none}
.qgtools-load-chip{flex:none;height:22px;display:flex;align-items:center;padding:0 9px;box-sizing:border-box;border:1px solid #2a3437;border-radius:11px;background:#11181a;color:#8ba3a1;font:600 10.5px/1 ${FONT};cursor:pointer;white-space:nowrap}
.qgtools-load-chip:hover{border-color:${BRAND};color:#fff}
.qgtools-load-chip.on{background:${BRAND};border-color:${BRAND};color:#04201d}
.qgtools-load-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#6f8886;font:10.5px/1.2 ${FONT};white-space:nowrap}
.qgtools-load-stage{position:relative;flex:1 1 auto;min-height:${STAGE_H}px;display:grid;place-items:center;overflow:hidden;border:1px solid #2a3437;border-radius:6px;background:#0b0f10 repeating-conic-gradient(#151a1c 0 25%,#0b0f10 0 50%) 0 0/16px 16px}
/* 画面和遮罩色是两层叠在同一个格子里：img 画原图，canvas 只画刷过的那块半透明绿。
   两层都是替换元素、同一套 max-width/max-height（等比约束），盒子必然重合。 */
.qgtools-load-stage>*{grid-area:1/1;min-width:0;min-height:0}
.qgtools-load-stage img,.qgtools-load-stage canvas{display:block;max-width:100%;max-height:100%;object-fit:contain;image-rendering:auto}
.qgtools-load-stage canvas{pointer-events:none}
.qgtools-load-stage img[hidden],.qgtools-load-stage canvas[hidden]{display:none}
.qgtools-load-empty{padding:0 12px;color:#6f8886;font-size:11px;text-align:center}
.qgtools-load-empty[hidden]{display:none}
.qgtools-load-edit{width:100%;justify-content:center;height:${ROW_H}px;border-radius:6px;font:600 11px/1 ${FONT}}
.qgtools-load-edit:disabled{opacity:.45;cursor:default;border-color:#2a3437;color:#8ba3a1}
.qgtools-load-meta{height:${META_H}px;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;color:#7d9896;font:11px ${FONT};white-space:nowrap;overflow:hidden}
.qgtools-load-meta .qgtools-load-size{color:#9fb8b6}
.qgtools-load-meta .qgtools-load-note{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;color:#8f5f5f}
/* 右下角那颗齿轮：带色图 / 保留透明通道这些「调一次就不动」的开关都收进它弹的浮层里，
   面板只留图、文件名、编辑遮罩三样。 */
.qgtools-load-gear{flex:none;width:19px;height:19px;display:grid;place-items:center;padding:0;box-sizing:border-box;border:1px solid #2a3437;border-radius:5px;background:#11181a;color:#8ba3a1;cursor:pointer;transition:color .12s,border-color .12s}
.qgtools-load-gear:hover{border-color:${BRAND};color:#fff}
.qgtools-load-gear.on{border-color:${BRAND};color:${BRAND}}
.qgtools-load-gear svg{display:block;width:12px;height:12px;fill:currentColor;pointer-events:none}
/* 浮层挂在 body 上（面板是 overflow:hidden，放里面会被裁掉），fixed 定位贴齿轮上方。 */
.qgtools-load-pop{position:fixed;z-index:100000;box-sizing:border-box;width:236px;padding:10px;display:flex;flex-direction:column;gap:9px;border:1px solid rgba(0,180,170,.34);border-radius:8px;background:#121a1b;box-shadow:0 12px 30px rgba(0,0,0,.6);color:#c8dddd;font:11px/1.45 ${FONT}}
.qgtools-load-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.qgtools-load-pop-name{font-weight:600;color:#d8ecea}
/* 浮层里的开关只写状态（开 / 关），名字交给左边那行 —— 两边都写全名太吵。 */
.qgtools-load-pop-row .qgtools-load-chip{min-width:38px;justify-content:center;padding:0 6px}
.qgtools-load-pop-hint{color:#6f8886;font:10.5px/1.35 ${FONT};margin-top:-3px}
/* Nodes 2.0 的 NodeContent（.lg-node-content）是核心按 node.images 画的那张图：
   分辨率、品牌水印都它带。我们的舞台已经画了同一张，留着就是两张。
   它读的是执行缓存，node.images 按住也没用（右键的遮罩编辑器还靠它判断「有图」，
   不能真清掉），所以在带本面板的节点上直接不显示。 */
.lg-node:has(.qgtools-load-panel) .lg-node-content{display:none}
`;

  document.head.appendChild(style);
}

const widgetOf = (node, name) => node.widgets?.find((widget) => widget.name === name);
const valueOf = (node, name, fallback = "") => widgetOf(node, name)?.value ?? fallback;

// 存盘的成品（clipspace/qg-painted-<原名>-<13位时间戳>.png）把遮罩存在 alpha
// 里，直接拿来显示会看到一片透明（遮罩那块被当成了透明）。所以画面一律看同一次
// 保存写下的原图副本 —— 那是画之前那张图，alpha 也是它自己的。
// 遮罩范围另画一层半透明绿，这一层是节点面板里的一张 canvas，和原图叠在一起显示，
// 源文件一个字节都不动。（官方核心的遮罩编辑器也是这个路子：maskCanvas 是独立一层，
// 靠 CSS opacity/mixBlendMode 叠在 imgCanvas 上，改颜色只改 RGB 三字节，从不编码。）
const PAINTED_RE = /^clipspace\/qg-painted-.+-(\d{13})\.png$/i;

// 画面用哪个文件：成品换成配对的副本，其它原样返回。
function pictureOf(selection) {
  const text = String(selection || "").split("[")[0].trim().replaceAll("\\", "/");
  const match = PAINTED_RE.exec(text);
  return match ? `clipspace/qg-src-${match[1]}.png` : text;
}

// 🔴 同一批还写了一份**不透明**的「带色画面」（qg-view-<时间戳>）。成品那张
// 遮罩区 alpha=0，浏览器读 PNG 时会把透明像素的 RGB 清零 —— 编辑器二次进来
// 想按成品颜色反解，只能拿到一片灰。这份只给编辑器取颜色，不参与任何输出。
function viewOf(selection) {
  const text = String(selection || "").split("[")[0].trim().replaceAll("\\", "/");
  const match = PAINTED_RE.exec(text);
  return match ? `clipspace/qg-view-${match[1]}.png` : null;
}

// 选中值可能是 "sub/a.png"，也可能是编辑器存的 "clipspace/qg-painted-x-123.png"。
// `bust` 每次存盘后加一：文件名不同也照样加，省得浏览器拿缓存。
function imageUrl(selection, bust) {
  const text = String(selection || "").split("[")[0].trim().replaceAll("\\", "/");
  const parts = text.split("/");
  const filename = parts.pop() || "";
  const subfolder = parts.join("/");
  const query = { filename, subfolder, type: "input" };
  if (bust) query.t = String(bust);
  return api.apiURL(`/view?${new URLSearchParams(query)}`);
}

// ── 预览上那层半透明绿 ────────────────────────────────────────────────
// 成品的 alpha 就是遮罩（刷过的地方 alpha→0，没刷的地方还是原图的 alpha）。
// 把「1 − alpha」当成绿色的不透明度盖到画面上，羽化边缘自然跟着渐隐，跟
// MASK 输出看到的是同一块区域。只在内存里的 canvas 上合成，源文件一个字节都不动。
const OVERLAY_RGB = [42, 210, 112];
const OVERLAY_ALPHA = 128;

function loadPicture(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

// 把遮罩色画进一层透明的 canvas：只有刷过的地方有色，其余全透明，原图从底下透出来。
// 用 destination-out 让浏览器做反相 —— 色层整块铺满，再拿成品「挖掉」。成品的 alpha
// 在刷过的地方是 0（挖不动，绿色留着），没刷的地方是 255（整块挖掉，透明），正好就是
// 遮罩。实测和逐像素循环的结果逐点相同，但不用碰 JS 主循环。
//
// 关键是「画完就在屏幕上」：canvas 直接当显示层，不 toBlob、不 encode、不进 blob URL。
// 以前那版要把合成结果编码成 PNG 再让浏览器解码回来，1 兆像素的图光编码就 700~800ms，
// 白等一秒只是为了显示已经躺在显存里的像素。
function paintVeil(canvas, maskImage, natural) {
  const width = natural?.width || maskImage.naturalWidth || maskImage.width;
  const height = natural?.height || maskImage.naturalHeight || maskImage.height;
  if (!width || !height) return false;
  try {
    // 设 width/height 会顺带重置整份绘图状态，所以每次都从这里重新开始。
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = `rgba(${OVERLAY_RGB[0]},${OVERLAY_RGB[1]},${OVERLAY_RGB[2]},${OVERLAY_ALPHA / 255})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "destination-out";
    // 成品只用来取 alpha；缩放到副本尺寸，防两张尺寸不一时错位。
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(maskImage, 0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    return true;
  } catch (error) {
    // 画布被跨域污染之类：宁可不叠色，也别把预览整没了。
    return false;
  }
}

// 面板的「内容高度」：两行（选择 + 编辑遮罩）+ 舞台 + 底栏 + 内边距 + 自己的边框。
// 🔴 这里必须和 `root.append(row, stage, editRow, meta)` 一一对应：
// 开关搬进齿轮浮层之后只有 **2 行 + 3 个 gap**，以前按 3 行 4 gap 算，
// 多出来 33px —— 面板比节点高出一截，底栏直接溢出到节点边框外面（用户 2026-10-26 报的）。
function panelFloor() {
  return PAD * 2 + ROW_H * 2 + GAP * 3 + STAGE_H + META_H + BORDER_H;
}

// 舞台一旦按比例定高，面板高度就是常数（行 + 舞台 + 说明），不再随节点高度变。
// 这一点很重要：面板高度跟着节点走的话，Vue 的外壳和 size 会互相追（自激）。
// 现在是反过来 —— 面板长高了，节点跟着长。
// 量的是面板本体而不是 widget 容器：Vue 的容器会被网格拉伸，量它等于量节点自己，
// 拖高之后就再也收不回来。
const panelOf = (node) => node.__qgLoadRoot ?? node.__qgLoadWidget?.element ?? null;

// 🔴 面板现在是**弹性**的（节点给多少高就长多少，预览区跟着长、底栏贴底），
// 所以这里再也不能反过来 `setSize(内容高度)` —— 那样用户一拖高就被拽回去，
// 预览区和底栏永远停在内容高度（用户 2026-10-26 两张红框圈的就是这个）。
function relayout(node) {
  const panelEl = () => panelOf(node) ?? node.__qgLoadStage?.parentElement;
  if (vueNodesEnabled()) {
    // Vue 下舞台是固定高的（Nodes 2.0 用内容推外壳），所以这里仍是「固定面板」：
    // 让 size 跟上外壳。弹性那套只在经典画布开。
    fitNodeToPanelHeight(node, panelEl(), (node.__qgLoadFit ??= {}));
    return;
  }
  // 经典画布也不动 size：ComfyUI-AusBoss 那支从头到尾只在创建时设一次初始高度，
  // 之后节点多大就是多大。高度分配全交给 CSS。
  node.setDirtyCanvas?.(true, true);
}

// 面板高度显式钉成内容高度：Vue 的 .lg-node-widgets 是网格，子项默认被拉伸，
// 于是节点被拖高时面板跟着拉长，底下就空出一大块带边框的荒地。
// 面板高度 = 节点给的空间：节点拖高，预览区跟着长，底栏自然贴到底。
// 🔴 以前是写死 `panelFloor`（内容高），节点一拖高下面就空一大块，底栏（尺寸 + 齿轮）
// 停在半截 —— 用户 2026-10-26 两张红框圈的就是这个。

function mountPanel(node) {
  ensureCss();

  const root = document.createElement("div");
  root.className = "qgtools-load-panel";
  node.__qgLoadRoot = root;

  // 第一行：带悬浮预览的选择器 + 上传
  const row = document.createElement("div");
  row.className = "qgtools-load-row";
  const picker = createMediaPicker({
    kind: "image",
    className: "qgtools-card-select",
    placeholder: zh("Choose an uploaded image…"),
    label: zh("Uploaded image"),
    viewUrl: (value) => imageUrl(pictureOf(value), node.__qgLoadBust),
    getOptions: () => {
      const target = widgetOf(node, "image");
      const list = target?.options?.values;
      const values = typeof list === "function" ? list(target, node) : list;
      return Array.isArray(values) ? values : [];
    },
    getValue: () => valueOf(node, "image"),
    onChange: (selection) => {
      const target = widgetOf(node, "image");
      if (target) commitWidgetValue(node, target, selection, app.canvas);
      notifyQgChange();
      sync();
    },
  });
  const upload = document.createElement("label");
  upload.className = "qgtools-load-upload";
  upload.title = zh("Upload an image into ComfyUI's input folder.");
  upload.append(document.createTextNode(zh("Upload")));
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  upload.append(fileInput);
  row.append(picker.element, upload);

  // 「保留透明通道」的开关本体。它现在住在齿轮弹层里（面板上不再占一行），
  // 点击照样写回 keep_alpha —— 视觉和值都还是同一个控件。
  const keepAlpha = document.createElement("button");
  keepAlpha.type = "button";
  keepAlpha.className = "qgtools-load-chip";
  // 开关胶囊只写「开 / 关」：左边的名字已经说清是什么了，两边都写全名反而看不清状态。
  const setChip = (chip, on) => {
    chip.textContent = on ? zhPair("On", "开") : zhPair("Off", "关");
    chip.classList.toggle("on", on);
  };
  keepAlpha.textContent = zhPair("Off", "关");
  keepAlpha.title = zhPair(
    "Keep four channels instead of compositing over white.",
    "保留四个通道，不合成到白底上。",
  );
  keepAlpha.addEventListener("click", () => {
    const target = widgetOf(node, "keep_alpha");
    if (!target) return;
    commitWidgetValue(node, target, !target.value, app.canvas);
    notifyQgChange();
    sync();
  });

  // 第三行：图
  const stage = document.createElement("div");
  stage.className = "qgtools-load-stage";
  node.__qgLoadStage = stage;
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = true;
  image.draggable = false;
  // 遮罩色单独一层，压在原图上。它只画刷过的地方，其余透明 —— 两层叠出来的效果和
  // 合成一整张图一样，但省掉了编码：画完立刻就在屏幕上。
  const veil = document.createElement("canvas");
  veil.className = "qgtools-load-veil";
  veil.hidden = true;
  const empty = document.createElement("div");
  empty.className = "qgtools-load-empty";
  empty.textContent = zh("Choose an image to begin");
  stage.append(image, veil, empty);

  // 舞台下面那行：打开遮罩编辑器。自己画遮罩，不用另外接一个编辑器节点。
  const editRow = document.createElement("div");
  editRow.className = "qgtools-load-row";
  const editMask = document.createElement("button");
  editMask.type = "button";
  editMask.className = "qgtools-load-chip qgtools-load-edit";
  editMask.textContent = zh("Edit mask");
  editMask.title = zh("Paint the mask straight onto this picture.");
  editMask.addEventListener("click", () => openEditor());
  editRow.append(editMask);

  const meta = document.createElement("div");
  meta.className = "qgtools-load-meta";
  const size = document.createElement("span");
  size.className = "qgtools-load-size";
  const note = document.createElement("span");
  note.className = "qgtools-load-note";
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "qgtools-load-gear";
  gear.title = zhPair("Panel settings", "面板设置");
  // 齿轮用 SVG 画：字体里的 ⚙ 各个系统渲染不一样，尺寸也对不齐。
  gear.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.7 7.7 0 0 0 .05-1 7.7 7.7 0 0 0-.05-1l2.1-1.6a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.5 1a7.3 7.3 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 13.9 2h-4a.5.5 0 0 0-.5.42l-.37 2.65c-.63.26-1.2.6-1.74 1l-2.5-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.4 11a7.7 7.7 0 0 0 0 2L2.3 14.6a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.5-1c.53.42 1.11.75 1.74 1l.37 2.65a.5.5 0 0 0 .5.42h4a.5.5 0 0 0 .5-.42l.38-2.65c.63-.25 1.2-.59 1.72-1l2.5 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64ZM11.9 15.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z"/></svg>';
  meta.append(size, note, gear);

  root.append(row, stage, editRow, meta);

  // ---- 齿轮弹层 ----------------------------------------------------------
  // 🔴 「输出带色图」不在这里了：它跟编辑器顶栏那三段合并成一个决定（所见即所得，
  // 用户 2026-10-26 定的），改由编辑器存盘时回写 tint_output。面板上再放一颗开关
  // 就是两个地方改同一个值，必然打架。这里只留跟输出格式有关的「保留透明通道」。
  // 挂 body + fixed：面板 overflow:hidden，放里面会被裁掉一半。

  let pop = null;
  const onPopDismiss = () => closePop();
  const closePop = () => {
    if (!pop) return;
    pop.remove();
    pop = null;
    gear.classList.remove("on");
    document.removeEventListener("pointerdown", onDocumentDown, true);
    window.removeEventListener("keydown", onPopKey, true);
    // 画布一滚、窗口一改尺寸，浮层就飘到别处去了 —— 直接收起来，别留个错位的框。
    window.removeEventListener("wheel", onPopDismiss, true);
    window.removeEventListener("resize", onPopDismiss, true);
  };
  const onDocumentDown = (event) => {
    if (!pop) return;
    if (pop.contains(event.target) || gear.contains(event.target)) return;
    closePop();
  };
  const onPopKey = (event) => {
    if (event.key === "Escape") closePop();
  };
  const openPop = () => {
    if (pop) {
      closePop();
      return;
    }
    const box = document.createElement("div");
    box.className = "qgtools-load-pop";
    const line = (name, control, hint) => {
      const top = document.createElement("div");
      top.className = "qgtools-load-pop-row";
      const label = document.createElement("span");
      label.className = "qgtools-load-pop-name";
      label.textContent = name;
      top.append(label, control);
      box.append(top);
      const small = document.createElement("div");
      small.className = "qgtools-load-pop-hint";
      small.textContent = hint;
      box.append(small);
    };
    line(
      zhPair("Keep alpha channel", "保留透明通道"),
      keepAlpha,
      zhPair("Off: see-through pixels turn white.", "关：透明处变白。"),
    );
    box.style.visibility = "hidden";
    box.style.left = "0px";
    box.style.top = "0px";
    document.body.append(box);
    // 先量再摆：右边缘对齐齿轮右边，底边压在齿轮上方 6px。
    const gearRect = gear.getBoundingClientRect();
    const popRect = box.getBoundingClientRect();
    const left = Math.max(6, Math.min(gearRect.right - popRect.width, window.innerWidth - popRect.width - 6));
    const top = Math.max(6, gearRect.top - popRect.height - 6);
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
    box.style.visibility = "visible";
    pop = box;
    gear.classList.add("on");
    // capture 阶段听：ComfyUI 的画布会 stopPropagation，冒泡阶段收不到。
    document.addEventListener("pointerdown", onDocumentDown, true);
    window.addEventListener("keydown", onPopKey, true);
    window.addEventListener("wheel", onPopDismiss, { capture: true, passive: true });
    window.addEventListener("resize", onPopDismiss, true);
  };
  gear.addEventListener("click", (event) => {
    event.stopPropagation();
    openPop();
  });

  let serial = 0;

  const showPicture = (src, key, natural) => {
    node.__qgLoadNatural = natural;
    image.src = src;
    image.dataset.key = key;
    image.hidden = false;
    // 换图先把旧绿层收起来，等新的合成好再露出来，免得错位一格；同一张重进就别闪。
    veil.hidden = node.__qgLoadVeilKey !== key;
    empty.hidden = true;
    drawMeta();
    relayout(node);
  };

  // 遮罩色那一层。按 key 去重，不跟 sync 的 serial 走 —— sync 一次加载会被连调
  // 好几遍（挂载一次、onConfigure 一次），跟着 serial 走的话第一遍的异步结果就被
  // 第二遍判废，第二遍又因为「同一张图」直接返回，绿层永远出不来。
  //
  // 收的是「已经开跑的下载」而不是地址：成品和副本是两张独立的图，谁都等不着谁，
  // 串着下等于白等一个来回（首轮实测成品那张要 500ms 上下）。
  const overlayMask = (maskReady, key, natural) => {
    if (node.__qgLoadOverlayKey === key) return;
    node.__qgLoadOverlayKey = key;
    maskReady
      .then((maskImage) => {
        if (!maskImage) {
          // 下载失败。清掉占位，下次 sync 还能再试。
          if (node.__qgLoadOverlayKey === key) node.__qgLoadOverlayKey = "";
          return;
        }
        if (node.__qgLoadOverlayKey !== key) return;
        if (!paintVeil(veil, maskImage, natural)) {
          node.__qgLoadOverlayKey = "";
          return;
        }
        node.__qgLoadVeilKey = key;
        // 并行下载时遮罩可能先到、画面还没露面，那就先藏着，等画面到了再一起亮。
        if (image.dataset.key === key) veil.hidden = false;
      })
      .catch(() => {
        // 叠不上（成品读不到、canvas 被污染）：纯画面照常显示，不影响使用。
        if (node.__qgLoadOverlayKey === key) node.__qgLoadOverlayKey = "";
      });
  };

  // 成品那张（只用来取 alpha）。失败吞成 null，让调用方按「没有遮罩」处理。
  const loadMask = (src) => loadPicture(src).catch(() => null);

  const sync = () => {
    const selection = String(valueOf(node, "image") ?? "");
    picker.refresh(selection);
    setChip(keepAlpha, valueOf(node, "keep_alpha", false) === true);
    editMask.disabled = !selection;
    const mine = ++serial;
    if (!selection) {
      image.hidden = true;
      image.removeAttribute("src");
      image.dataset.key = "";
      veil.hidden = true;
      empty.hidden = false;
      empty.textContent = zh("Choose an image to begin");
      note.textContent = "";
      size.textContent = "";
      node.__qgLoadNatural = null;
      node.__qgLoadVeilKey = "";
      return;
    }
    const url = imageUrl(pictureOf(selection), node.__qgLoadBust);
    const key = `${selection}@@${node.__qgLoadBust ?? 0}`;
    // 先试画面那张（成品的原图副本），副本不在（老存档、手工删了）再看原文件。
    const sources = [url];
    const raw = imageUrl(selection, node.__qgLoadBust);
    if (raw !== url) sources.push(raw);
    // 选中的就是成品时，画面底下还有一块遮罩要叠上去。
    const painted = raw !== url;
    if (image.dataset.key === key && image.complete && image.naturalWidth) {
      // 同一张图：不重新下载；绿层要是还没叠上（上一轮被打断），这里补一次。
      drawMeta();
      if (painted) overlayMask(loadMask(raw), key, node.__qgLoadNatural);
      return;
    }
    empty.textContent = zh("Loading…");
    note.textContent = "";
    // 画面和遮罩同时开下：两张图互不依赖，串着下等于白等一个来回。
    const maskReady = painted ? loadMask(raw) : null;
    const attempt = (index) => {
      if (mine !== serial) return;
      if (index >= sources.length) {
        image.hidden = true;
        image.dataset.key = "";
        empty.hidden = false;
        empty.textContent = zh("Could not load this image.");
        note.textContent = "";
        size.textContent = "";
        node.__qgLoadNatural = null;
        return;
      }
      const probe = new Image();
      probe.onload = () => {
        if (mine !== serial) return;
        const natural = { width: probe.naturalWidth, height: probe.naturalHeight };
        showPicture(sources[index], key, natural);
        if (!painted) {
          node.__qgLoadOverlayKey = "";
          node.__qgLoadVeilKey = "";
          return;
        }
        overlayMask(maskReady, key, natural);
      };
      probe.onerror = () => attempt(index + 1);
      probe.src = sources[index];
    };
    attempt(0);
  };

  // 存盘回来的是新文件名（clipspace/qg-painted-…）：塞进下拉、选中它，并换掉
  // 预览的版本号，否则浏览器拿缓存里的旧图，看起来像没保存。
  // 预览会自动换成配对的原图副本：成品自己的 alpha 是遮罩，直接显示是透明的。
  // 编辑器里选的颜色、透明度、输出档位一并带回来（前两个给带色图用，第三个
  // 直接就是 tint_output）。
  const adoptSaved = (filename, tint) => {
    const target = widgetOf(node, "image");
    if (target) {
      const list = target.options?.values;
      if (Array.isArray(list) && !list.includes(filename)) list.push(filename);
      commitWidgetValue(node, target, filename, app.canvas);
    }
    if (tint?.colour) {
      const colour = widgetOf(node, "tint_color");
      if (colour && colour.value !== tint.colour) commitWidgetValue(node, colour, tint.colour, app.canvas);
    }
    if (Number.isFinite(tint?.alpha)) {
      const alpha = widgetOf(node, "tint_alpha");
      const value = Math.round(tint.alpha);
      if (alpha && alpha.value !== value) commitWidgetValue(node, alpha, value, app.canvas);
    }
    // 输出档位是画的时候定的，编辑器存盘就统一到节点上（面板上已经没有这个开关了）。
    if (typeof tint?.tintOutput === "boolean") {
      const output = widgetOf(node, "tint_output");
      if (output && output.value !== tint.tintOutput) {
        commitWidgetValue(node, output, tint.tintOutput, app.canvas);
      }
    }
    node.__qgLoadBust = (node.__qgLoadBust ?? 0) + 1;
    notifyQgChange();
    sync();
  };

  async function openEditor() {
    const selection = String(valueOf(node, "image") ?? "");
    if (!selection) return;
    const module = maskEditor ?? (await loadMaskEditor());
    if (!module) {
      note.textContent = "Mask editor is not available.";
      return;
    }
    // 画面用副本（不透明），遮罩另从成品自己的 alpha 里读回来 —— 这样二次编辑
    // 既能看见画面，又接着上次的遮罩改。
    const flat = pictureOf(selection);
    const view = flat === selection ? null : viewOf(selection);
    module.openMaskEditor({
      title: zh("Edit mask"),
      name: selection,
      imageUrl: imageUrl(flat, node.__qgLoadBust),
      maskUrl: flat === selection ? null : imageUrl(selection, node.__qgLoadBust),
      viewUrl: view ? imageUrl(view, node.__qgLoadBust) : null,
      // 上次选的颜色、透明度和输出档位跟着打开，别每次都回到绿色 50% 仅遮罩。
      tint: valueOf(node, "tint_color", "green"),
      alpha: Number(valueOf(node, "tint_alpha", 50)),
      tintOutput: valueOf(node, "tint_output", false) === true,
      onSaved: adoptSaved,
    });
  }

  function drawMeta() {
    const natural = node.__qgLoadNatural;
    if (!natural) return;
    size.textContent = `${natural.width} × ${natural.height}`;
    note.textContent = "";
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    upload.setAttribute("aria-busy", "true");
    try {
      await uploadImage(node, file);
      notifyQgChange();
      sync();
    } catch (error) {
      note.textContent = error?.message || String(error);
    } finally {
      fileInput.value = "";
      upload.removeAttribute("aria-busy");
    }
  });

  // 拖一张图到节点上就上传，跟核心的上传控件一致。返回 true 让画布的落点
  // 处理不再新建一个 Load Image 节点。
  node.onDragOver = (event) => {
    const items = event?.dataTransfer?.items;
    return Boolean(items && Array.from(items).some((item) => item.kind === "file"));
  };
  node.onDragDrop = async (event) => {
    const file = Array.from(event?.dataTransfer?.files ?? []).find(
      (candidate) => String(candidate.type).startsWith("image/"),
    );
    if (!file) return false;
    try {
      await uploadImage(node, file);
      notifyQgChange();
      sync();
    } catch (error) {
      note.textContent = error?.message || String(error);
    }
    return true;
  };
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,select,input,label")) event.stopPropagation();
  });
  // 双击图打开编辑器：图就在那里，点它比找按钮快。
  stage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (valueOf(node, "image")) openEditor();
  });

  // 原生控件：`image` 换成选择器，`upload` 换成我们这一行里的按钮（两者都只
  // 是外观；widget 还在、还在 widgets_values 里，所以存档和右键遮罩编辑器不变）。
  // 🔴 `tint_output` / `tint_color` / `tint_alpha` 一起藏：颜色和浓度在编辑器底栏
  // 改，带色图开关收进右下角齿轮的浮层里（用户 2026-10-26 要求）。四个 widget 的
  // 值一个都没删 —— 后端照样收得到，编辑器存盘也照样回写。
  const hideNative = () => {
    hideWidget(widgetOf(node, "image"));
    hideWidget(widgetOf(node, "keep_alpha"));
    hideWidget(widgetOf(node, "upload"));
    hideWidget(widgetOf(node, "tint_output"));
    hideWidget(widgetOf(node, "tint_color"));
    hideWidget(widgetOf(node, "tint_alpha"));
  };

  // 老存档的 widgets_values 是按位置排的：上一版的 `alpha`（combobox 字符串）会
  // 正好落在这一版 `keep_alpha` 的位置上。把字符串换算成布尔，别让「keep alpha」
  // 这种值被当成布尔真真假假地传进后端。
  const migrateLegacyValue = () => {
    const target = widgetOf(node, "keep_alpha");
    if (!target || typeof target.value === "boolean") return;
    const text = String(target.value ?? "").trim();
    const next = text === "true" || text === "keep alpha" || text === "keep picture";
    target.value = next;
    target.callback?.(next);
  };

  const widget = node.addDOMWidget(PANEL_WIDGET, PANEL_WIDGET, root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => panelFloor(node),
  });
  keepDomWidgetWidthAuto(widget);
  widget.serialize = false;
  node.__qgLoadWidget = widget;
  fillNodeHeight(widget, {
    minWidth: MIN_WIDTH,
    minHeight: () => panelFloor(node),
    // 高度地板＝内容真实最小（面板不溢出所需），不是初始高度 —— 把初始的 405
    // 写在这里会让节点永远拖不矮。
    minNodeSize: [MIN_WIDTH, panelFloor(node)],
    exactMinWidth: true,
  });

  queueMicrotask(() => {
    // 核心的上传助手可能在我们之后才加控件。
    hideNative();
    suppressCoreImagePreview(node, () => sync());
    sync();
  });
  chainCallback(node, "onConfigure", function () {
    queueMicrotask(() => {
      migrateLegacyValue();
      hideNative();
      suppressCoreImagePreview(node, () => sync());
      sync();
    });
  });
  chainCallback(node, "onRemoved", () => {
    // 浮层挂在 body 上，节点没了得自己收（不然留一个孤儿框在屏幕上）。
    closePop();
    picker.dispose();
    unwatchVueShell(node);
  });

  watchVueShell(node, () => panelOf(node) ?? root, () => relayout(node));

  // 照 ComfyUI-AusBoss：只在创建时给一个初始尺寸，之后节点多大就是多大，
  // 谁都不再动 size —— 动一下就自激。
  // 初始 = 270 宽（同「导出图像」）× 405 高（2:3），内容地板比它矮时才抬到地板。
  node.setSize?.([
    Math.max(DEFAULT_WIDTH, Math.round(node.size?.[0] || 0)),
    Math.max(panelFloor(node), DEFAULT_HEIGHT),
  ]);
  sync();
}

async function uploadImage(node, file) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "input");
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).error || text; } catch { /* 原样用文本 */ }
    throw new Error(message || "Upload failed.");
  }
  let result = {};
  try { result = JSON.parse(text); } catch { /* 只信 selection 的回退 */ }
  const selection = result.subfolder ? `${result.subfolder}/${result.name}` : String(result.name ?? file.name);
  const target = widgetOf(node, "image");
  if (target) {
    const list = target.options?.values;
    if (Array.isArray(list) && !list.includes(selection)) list.push(selection);
    commitWidgetValue(node, target, selection, app.canvas);
  }
  return selection;
}

// 面板接管了这两个控件的外观，所以在定义层就标 hidden：Nodes 2.0 会照着
// nodeData 重建控件和它自带的图片预览，只在活控件上藏不够（同 CropRotatePad）。
const HIDDEN_INPUTS = ["image", "keep_alpha", "tint_output", "tint_color", "tint_alpha"];

app.registerExtension({
  name: "QG.LoadImage",
  // 旧存档里这个节点有 7 个输出槽（彩色叠加 / 宽 / 高 / 帧数）。litegraph 在
  // configure 时会把存档里的槽补回来，光刷新页面修不掉 —— 所以趁图还没建起来
  // 先截断数据，并把从那些槽引出的线一起删掉（后端已经不返回它们，留着也是死线）。
  beforeConfigureGraph(graphData) {
    const nodes = graphData?.nodes;
    if (!Array.isArray(nodes)) return;
    const dropped = new Set();
    let trimmed = 0;
    for (const entry of nodes) {
      if (!entry || entry.type !== NODE_CLASS) continue;
      if (!Array.isArray(entry.outputs) || entry.outputs.length <= KEPT_OUTPUTS) continue;
      for (let index = KEPT_OUTPUTS; index < entry.outputs.length; index += 1) {
        const links = entry.outputs[index]?.links;
        if (Array.isArray(links)) links.forEach((id) => dropped.add(id));
      }
      entry.outputs = entry.outputs.slice(0, KEPT_OUTPUTS);
      trimmed += 1;
    }
    if (trimmed) {
      if (dropped.size && Array.isArray(graphData.links)) {
        graphData.links = graphData.links.filter((link) => {
          const id = Array.isArray(link) ? link[0] : link?.id;
          return !dropped.has(id);
        });
      }
      console.info("[QG-tools] 加载图像：%d 个节点带旧版多余输出槽，已截到两个", trimmed);
    }
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    hideInputsInDef(nodeData, HIDDEN_INPUTS);
    // 兜底：万一别的路径还在补旧槽（存档里 links 引用到的槽），这里直接拒绝。
    const addOutput = nodeType.prototype.addOutput;
    nodeType.prototype.addOutput = function (name) {
      if (Array.isArray(this.outputs) && this.outputs.length >= KEPT_OUTPUTS
          && LEGACY_OUTPUT_NAMES.has(String(name))) {
        return null;
      }
      return addOutput.apply(this, arguments);
    };
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      if (this.__qgLoadMounted) return;
      this.__qgLoadMounted = true;
      // 面板挂载失败也要在控制台喊一声：静默失败的样子是「原生控件全回来、
      // 按钮没了」，看起来像插件没装，实际是一行异常。
      try {
        mountPanel(this);
      } catch (error) {
        console.error("[QG-tools] load image panel failed to mount", error);
      }
    });
  },
});

console.log("[QG-tools] load image node ready");
