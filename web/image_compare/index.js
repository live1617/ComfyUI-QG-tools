/**
 * QG 图像对比 — 一块面板同时看 A 和 B（前端）
 *
 * 界面移植自 ComfyUI-AusBoss（MIT，js/compare/index.js）。四种用法：滑动
 * （竖线跟着指针走，左边 A 右边 B）、只看 A、只看 B、擦除（画笔把上面那张
 * 擦掉一块，露出底下那张，还能把混合图存下来）。
 *
 * 后端每次运行把两张预览写进 temp，通过 ui.a_images / ui.b_images 回传，这里
 * 直接当图片 URL 用；image_a 原样从节点送出，所以夹在流程中间不影响下游。
 */

import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";
import {
  BRAND,
  chainCallback,
  keepDomWidgetWidthAuto,
  notifyQgChange,
} from "../shared/index.mjs?v=2026102002";
import { isForeignRun, outputKey } from "../shared/prompt_scope.mjs?v=2026102002";
import { WIDGET_FRAME, fillNodeHeight } from "../shared/panel_layout.mjs?v=2026102002";
import { mediaViewQuery, responsivePreviewHeight } from "../shared/video_preview.mjs?v=2026102002";
import { makeSlideSwitch } from "../shared/slide_switch.mjs?v=2026102002";
import { savedLinks } from "../shared/compare_erase.mjs?v=2026102002";
import { ERASE_CSS, makeEraser } from "../shared/compare_erase_stage.mjs?v=2026102002";
import {
  compareBadges,
  compareClip,
  compareResultSide,
  compareSizeLabel,
  compareSwitchValue,
  findCompareImages,
  normalizeCompareMode,
  slideFraction,
} from "../shared/compare.mjs?v=2026102002";

const NODE_NAME = "QG_ImageCompare";
const PANEL_WIDGET = "qgtools_compare_panel";
const PANEL_CHROME = 12;
// 台面下限 + 台面下面那行说明。
const CAPTION_HEIGHT = 24;
const PANEL_MIN_HEIGHT = 144 + CAPTION_HEIGHT;
// 节点打开时的高度。面板可以自己长高，所以默认值要写死在这；16:9 上下是
// 大多数 A/B 图对想要的形状。
const DEFAULT_NODE_SIZE = [
  420,
  responsivePreviewHeight(420, 132, 520) + PANEL_CHROME + CAPTION_HEIGHT + 60,
];
const NODE_MIN_WIDTH = 220;
const CSS_ID = "qgtools-compare-css";
const ROOT_GAP = 6;
const BADGE_WIDTH = 22;
const REST_SETTING = "QG.ImageCompare.RestOnResult";
let restOnResult = true;

function ensureCompareCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-compare-root{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;gap:${ROOT_GAP}px;padding:2px 6px 6px;color:#d8eeee;font:11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;}
.qgtools-compare-stage{position:relative;flex:1 1 auto;min-height:112px;overflow:hidden;border:1px solid rgba(0,180,170,.34);border-radius:6px;background:#000;box-shadow:inset 0 0 0 1px rgba(255,255,255,.025);touch-action:none;}
.qgtools-compare-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;}
.qgtools-compare-stage.is-empty img{visibility:hidden;}
.qgtools-compare-seam{position:absolute;top:0;bottom:0;z-index:2;width:1px;margin-left:-0.5px;background:${BRAND};box-shadow:0 0 4px rgba(0,180,170,.55);opacity:0;pointer-events:none;}
.qgtools-compare-status{position:absolute;left:7px;top:7px;z-index:3;max-width:calc(100% - 112px);padding:3px 6px;border-radius:4px;background:rgba(0,0,0,.7);color:#b8d3d1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;backdrop-filter:blur(4px);}
/* 预览上来之后状态条没话可说，空框压在画面角上只是挡东西。 */
.qgtools-compare-status:empty{display:none;}
.qgtools-compare-stage.is-empty .qgtools-compare-status{left:50%;top:50%;max-width:82%;transform:translate(-50%,-50%);color:#78908e;text-align:center;white-space:normal;}
.qgtools-compare-footer{display:flex;align-items:center;gap:8px;flex:none;height:24px;}
.qgtools-compare-identity{position:absolute;left:0;right:0;top:7px;height:22px;z-index:3;pointer-events:none;}
.qgtools-compare-identity span{position:absolute;top:0;width:${BADGE_WIDTH}px;height:22px;border-radius:4px;background:rgba(0,0,0,.7);color:#d8eeee;font-weight:600;text-align:center;line-height:22px;}
.qgtools-compare-identity span[hidden]{display:none;}
.qgtools-compare-stage.is-empty .qgtools-compare-identity{display:none;}
.qgtools-compare-caption{flex:1;min-width:0;height:${CAPTION_HEIGHT}px;overflow:hidden;color:#8ba3a1;font-size:10px;line-height:${CAPTION_HEIGHT}px;text-align:center;white-space:nowrap;text-overflow:ellipsis;}
/* 保存之后，说明行把文件名做成链接：ComfyUI 常常跑在另一台机器上，
   这是把混合图拿回本地编辑器最省事的办法。 */
.qgtools-compare-caption a{color:${BRAND};font-weight:700;text-decoration:none;cursor:pointer;}
.qgtools-compare-caption a:hover{text-decoration:underline;}
${ERASE_CSS}
`;
  document.head.appendChild(style);
}

function getMode(node) {
  node.properties ??= {};
  node.properties.qg_compare_mode = normalizeCompareMode(node.properties.qg_compare_mode);
  return node.properties.qg_compare_mode;
}

const PANEL_FLOOR = PANEL_MIN_HEIGHT + WIDGET_FRAME;

// A 和 B 的标签骑在分界线两侧，所以线走到哪，名字就贴在自己那张图上。
function applyClip(state) {
  const { clipPath, seamLeft, seamVisible, showA, showB } = compareClip(state.fraction);
  state.imageA.style.clipPath = clipPath;
  // "" 把图交回样式表，台面空着时样式表把两张都藏起来。
  state.imageA.style.visibility = showA ? "" : "hidden";
  state.imageB.style.visibility = showB ? "" : "hidden";
  state.seam.style.left = seamLeft;
  state.seam.style.opacity = seamVisible ? "1" : "0";
  const places = compareBadges(state.fraction, state.stage.clientWidth || 0, BADGE_WIDTH);
  for (const [badge, left] of [[state.identityLeft, places.a], [state.identityRight, places.b]]) {
    badge.hidden = left == null;
    if (left != null) badge.style.left = `${left}px`;
  }
  // 整条各写，不拿单词槽拼句子（也避开 `正在看 ${}` 这种拼接串）。
  state.identity.title = seamVisible
    ? "线左边是 A，右边是 B"
    : (state.fraction === 0 ? "正在看 B" : "正在看 A");
  state.identity.setAttribute("aria-label", state.identity.title);
}

function setEmpty(state, text) {
  state.stage.classList.add("is-empty");
  state.status.textContent = text;
  state.caption.textContent = "";
}

function setReady(state) {
  state.stage.classList.remove("is-empty");
  // 加载中／出错的提示和图的尺寸说明是两件事，别混在一条里。
  state.status.textContent = "";
  state.caption.textContent = compareSizeLabel(state.refs);
}

// 保存之后，说明行把文件写成链接：ComfyUI 常常跑在别的电脑上，这是把混合图
// 拿回本地编辑器的路。下一对图上来时尺寸会把它盖回去。
function showSaved(state, files) {
  const links = savedLinks(files);
  if (!links.length) return;
  state.caption.textContent = "已保存 ";
  links.forEach(({ label, file }, index) => {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = api.apiURL(`/view?${mediaViewQuery(file, "output")}`);
    link.download = file.filename;
    link.title = `下载 ${file.filename}`;
    link.addEventListener("pointerdown", (event) => event.stopPropagation());
    state.caption.append(index ? " · " : "", link);
  });
}

function updateModeButtons(state) {
  state.modeSwitch.set(compareSwitchValue(getMode(state.node), state.showingB));
}

// 只看 A / 只看 B 时，露出是全有或全无。
function applyToggle(state) {
  state.fraction = state.showingB ? 0 : 1;
  applyClip(state);
  updateModeButtons(state);
  state.node.setDirtyCanvas?.(true, true);
}

// 模式说要用画笔，就把台面交给画笔；说不用，就收回来。工具行宁可折行也不撑
// 宽节点，地方从图上出，所以节点的边不会压到旁边的节点。
function syncErase(state) {
  if (!state.eraser) return;
  const on = getMode(state.node) === "erase";
  if (state.eraser.active === on) return;
  state.eraser.setActive(on);
}

// graph.links 在旧前端是普通对象，新前端是 Map。
function lookupLink(graph, linkId) {
  if (linkId == null) return null;
  return graph?.links?.get?.(linkId) ?? graph?.links?.[linkId] ?? null;
}

// 一张图里的连线，整成 compareResultSide 认得的形状。
function linkView(graph) {
  const origin = (linkId) => {
    const link = lookupLink(graph, linkId);
    return link ? { id: String(link.origin_id), slot: link.origin_slot } : null;
  };
  return {
    origin,
    feeds: (id) => (graph?.getNodeById?.(id)?.inputs ?? []).map((input) => origin(input?.link)?.id),
    inside(id) {
      const subgraph = graph?.getNodeById?.(id)?.subgraph;
      if (!subgraph) return null;
      const view = linkView(subgraph);
      return { ...view, output: (slot) => view.origin(subgraph.outputs?.[slot]?.linkIds?.[0]) };
    },
  };
}

// 哪一路是「结果」，从面板所在的那张图上读。
function resultSide(node) {
  const view = linkView(node.graph);
  const source = (name) => view.origin(node.inputs?.find((input) => input?.name === name)?.link);
  return compareResultSide(source("image_a"), source("image_b"), view);
}

// 滑动模式下，指针离开后停在结果那张图上。
function showResult(state) {
  state.fraction = resultSide(state.node) === "B" ? 0 : 1;
  applyClip(state);
}

// 点一下模式切换条。模式跟着工作流存；在 A/B 之间翻也存，存在它记的那一侧。
function pickMode(state, value) {
  const node = state.node;
  const before = compareSwitchValue(getMode(node), state.showingB);
  if (value === "slide") {
    node.properties.qg_compare_mode = "slide";
    state.showingB = false;
    state.fraction = 1;
    syncErase(state);
    if (restOnResult) showResult(state);
    else applyClip(state);
  } else if (value === "erase") {
    node.properties.qg_compare_mode = "erase";
    syncErase(state);
  } else {
    // 保留旧键名，另一侧记在单独的属性里，新的锁定状态才恢复得回来。
    node.properties.qg_compare_mode = "toggle";
    node.properties.qg_compare_side = value === "b" ? "B" : "A";
    state.showingB = value === "b";
    syncErase(state);
    applyToggle(state);
  }
  updateModeButtons(state);
  node.setDirtyCanvas?.(true, true);
  if (value !== before) notifyQgChange();
}

function loadPreviews(state, refs) {
  state.refs = refs;
  state.loaded = 0;
  state.eraser.setPictures(null);
  setEmpty(state, "正在载入预览…");
  // 新的一对图先停在结果上，除非指针正压着面板。
  if (restOnResult && getMode(state.node) === "slide" && !state.stage.matches(":hover")) showResult(state);
  state.imageA.src = api.apiURL(`/view?${mediaViewQuery(refs.a, "temp")}`);
  state.imageB.src = api.apiURL(`/view?${mediaViewQuery(refs.b, "temp")}`);
}

// 对齐把 B 换成对齐后的 B（或者换回原来那张）：面板上这一对变了，
// 之后的保存和复制用的也就是这一对。笔迹留在原地不动。
function showAligned(state, refs) {
  if (!refs) return;
  loadPreviews(state, refs);
}

function buildPanel(node) {
  if (node.__qgCompare) return node.__qgCompare;
  ensureCompareCss();

  const root = document.createElement("div");
  root.className = "qgtools-compare-root";
  const stage = document.createElement("div");
  stage.className = "qgtools-compare-stage is-empty";
  const imageA = document.createElement("img");
  const imageB = document.createElement("img");
  const seam = document.createElement("div");
  seam.className = "qgtools-compare-seam";
  const status = document.createElement("div");
  status.className = "qgtools-compare-status";
  status.textContent = "运行一次，载入 A / B 预览";
  const identity = document.createElement("div");
  identity.className = "qgtools-compare-identity";
  const identityLeft = document.createElement("span");
  const identityRight = document.createElement("span");
  identityLeft.textContent = "A";
  identityRight.textContent = "B";
  identity.append(identityLeft, identityRight);
  const abort = new AbortController();
  const signal = abort.signal;
  // 面板干什么就这一个开关：滑过整对、只看 A、只看 B、用画笔画。标记会滑到
  // 选中项。
  const modeSwitch = makeSlideSwitch({
    label: "面板显示方式",
    // 每个选项按自己的字宽，节点窄了也放得下。
    fit: true,
    options: [
      { value: "slide", label: "滑动", title: "滑动：竖线跟着指针走，左边 A、右边 B" },
      { value: "a", label: "A", title: "只看 A，并停住" },
      { value: "b", label: "B", title: "只看 B，并停住" },
      { value: "erase", label: "擦除", title: "擦除：用画笔把上面那张擦掉一块、露出底下那张，还能把混合图存下来" },
    ],
    value: "slide",
    signal,
    onChange: (value) => node.__qgCompare && pickMode(node.__qgCompare, value),
  });
  stage.append(imageB, imageA, seam, status, identity);
  const caption = document.createElement("div");
  caption.className = "qgtools-compare-caption";
  const eraser = makeEraser({
    node, root, stage, imageA, imageB, signal,
    onSaved: (files) => showSaved(node.__qgCompare, files),
    onAligned: (refs) => node.__qgCompare && showAligned(node.__qgCompare, refs),
  });
  const footer = document.createElement("div");
  footer.className = "qgtools-compare-footer";
  footer.append(caption, modeSwitch.root);
  root.append(eraser.bar, stage, footer, eraser.saveRow);

  const widget = node.addDOMWidget(PANEL_WIDGET, "qgtools_compare", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => PANEL_FLOOR,
  });
  keepDomWidgetWidthAuto(widget);
  // 也不进工作流存档：options.serialize 只是把它挡在 prompt 外面，存下来的值
  // 是按位置读的。
  widget.serialize = false;
  // + WIDGET_FRAME：前端会给元素再套一层内边距，光给台面的下限会让面板拿到的
  // CSS 像素比台面 + 说明行的最小值还少，节点最矮时说明行会被削。
  fillNodeHeight(widget, {
    minWidth: NODE_MIN_WIDTH,
    minHeight: PANEL_FLOOR,
    minNodeSize: [NODE_MIN_WIDTH, 220],
    exactMinWidth: true,
  });

  const state = (node.__qgCompare = {
    node, root, stage, imageA, imageB, seam, status, caption, identity, identityLeft, identityRight,
    modeSwitch, eraser,
    widget, abort, refs: null, fraction: 1, loaded: 0, showingB: false,
  });
  applyClip(state);
  updateModeButtons(state);

  // 标签是按像素摆的，宽度一变就得重算。
  const resized = new ResizeObserver(() => applyClip(state));
  resized.observe(stage);
  signal.addEventListener("abort", () => resized.disconnect());
  // 只在预览里跟指针，图例拖动和画布平移不受影响。
  stage.addEventListener("pointermove", (event) => {
    if (!state.refs || getMode(node) !== "slide") return;
    const rect = stage.getBoundingClientRect();
    state.fraction = slideFraction(event.clientX, rect.left, rect.width);
    applyClip(state);
  }, { signal });

  // 离开就回到结果上，从上下出去也一样。关掉那个设置时，就近吸到整张。
  stage.addEventListener("pointerleave", (event) => {
    if (!state.refs || getMode(node) !== "slide") return;
    if (restOnResult) return showResult(state);
    const rect = stage.getBoundingClientRect();
    state.fraction = slideFraction(event.clientX, rect.left, rect.width, true);
    applyClip(state);
  }, { signal });

  const onImageLoad = () => {
    state.loaded += 1;
    if (state.loaded >= 2) {
      setReady(state);
      eraser.setPictures(state.refs);
      node.setDirtyCanvas?.(true, true);
    }
  };
  imageA.addEventListener("load", onImageLoad, { signal });
  imageB.addEventListener("load", onImageLoad, { signal });
  const onImageError = () => {
    eraser.setPictures(null);
    setEmpty(state, "对比预览没能载入");
  };
  imageA.addEventListener("error", onImageError, { signal });
  imageB.addEventListener("error", onImageError, { signal });

  return state;
}

// 切回某个工作流标签页时，它的结果会回到 ComfyUI 的存储里，但面板只在
// onExecuted 时填过。这里把存着的那一对补上。
function showStoredResult(node) {
  const state = node.__qgCompare;
  if (!state || state.refs) return;
  const refs = findCompareImages(app.nodeOutputs?.[outputKey(node, app.rootGraph ?? app.graph)]);
  if (refs) loadPreviews(state, refs);
}

app.registerExtension({
  name: "QG.ImageCompare",
  settings: [
    {
      id: REST_SETTING,
      name: "停在结果上",
      type: "boolean",
      defaultValue: true,
      category: ["QG-tools", "图像对比"],
      tooltip:
        "指针不在图上时，图像对比显示结果：每次运行之后，以及每次指针离开画面。"
        + "关掉：就停在指针离开时最近的那张，新的一次运行也不改变它。",
      onChange(value) {
        restOnResult = value !== false;
      },
    },
  ],
  setup() {
    // onChange 只在之后改动时触发，这里先读一次存着的值。
    restOnResult = app.ui?.settings?.getSettingValue?.(REST_SETTING) !== false;
  },
  onNodeOutputsUpdated() {
    setTimeout(() => {
      for (const node of app.graph?._nodes ?? []) if (node?.comfyClass === NODE_NAME) showStoredResult(node);
    }, 0);
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      buildPanel(this);
      // 只针对真正新建的节点：onConfigure 在这之后恢复存档里的尺寸，工作流自己
      // 记下的宽高仍然赢。
      this.setSize?.([
        Math.max(DEFAULT_NODE_SIZE[0], this.size?.[0] ?? 0),
        Math.max(DEFAULT_NODE_SIZE[1], this.size?.[1] ?? 0),
      ]);
    });
    chainCallback(nodeType.prototype, "onConfigure", function () {
      queueMicrotask(() => {
        const state = buildPanel(this);
        state.showingB = this.properties?.qg_compare_side === "B";
        syncErase(state);
        // 存档时如果两张图已经在了，把存着的笔迹也读回来。
        if (state.refs && state.loaded >= 2) state.eraser.setPictures(state.refs);
        if (getMode(this) === "toggle") applyToggle(state);
        else updateModeButtons(state);
      });
    });
    chainCallback(nodeType.prototype, "onExecuted", function (message) {
      // 别的标签页排队的那次运行，结果不归这里。
      if (isForeignRun()) return;
      const state = buildPanel(this);
      const refs = findCompareImages(message);
      if (refs) loadPreviews(state, refs);
      else setEmpty(state, "运行结束，但没有拿到对比预览");
      app.canvas?.setDirty?.(true, true);
    });
    // filename 输入上接没接线，决定名字是打的还是显示运行给的。
    chainCallback(nodeType.prototype, "onConnectionsChange", function () {
      this.__qgCompare?.eraser?.refresh();
    });
    chainCallback(nodeType.prototype, "onRemoved", function () {
      this.__qgCompare?.abort?.abort();
      this.__qgCompare = null;
    });
  },
});
