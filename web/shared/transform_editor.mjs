import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";
import { zh, zhOn, zhReady, zhSep } from "./zh.mjs?v=2026101316";
import { hideInputsInDef, hideWidget } from "./widget_visibility.mjs?v=2026101316";
import { mountTransformTrim } from "./transform_trim.mjs?v=2026101316";
import { clipOutputRate, inputNumber } from "./clip_rate.mjs?v=2026101316";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange, showToast } from "./index.mjs?v=2026101316";
import { WIDGET_FRAME, fillNodeHeight, holdVueNodeMinWidth } from "./panel_layout.mjs?v=2026101316";
import { mediaViewQuery } from "./media_list.mjs?v=2026101316";
import { createMediaPicker } from "./media_picker.mjs?v=2026101316";
import { normalizeFillColor } from "./fill_color.mjs?v=2026101316";
import { makeScrubInput } from "./scrub_input.mjs?v=2026101316";
import { confirmDiscard } from "./discard_prompt.mjs?v=2026101316";
import { keepKeyInField } from "./canvas_passthrough.mjs?v=2026101316";
import { featherGeneratedMask, generatedAreaMask, overlayPlan, seeThroughMap, stitchBlendFromMask } from "./stitch_preview.mjs?v=2026101316";
import { suppressCoreVideoPreview } from "./core_preview.mjs?v=2026101316";
import { gearIconSvg, loadSettings, openSettingsMenu } from "./settings_menu.mjs?v=2026101316";
import {
  INPUT_FOLDER_MODE,
  LOCAL_PATH_MODE,
  normalizeVideoOptions,
  mediaSourceState,
  videoSourceState,
} from "./video_source_card.mjs?v=2026101316";
import {
  alignChanges,
  aspectMatches,
  axisBands,
  canvasCornerCenters,
  canvasLocalPoint,
  canvasSize,
  centredPadding,
  clamp,
  cornerScale,
  cropForRotation,
  declaredTransformDefaults,
  fitSourceToAspect,
  cropHandleCenters,
  isUntouched,
  evenOutPadding,
  keptCrop,
  knobAt,
  knobOffset,
  knobStep,
  lockPadding,
  lockedPadMinimum,
  moveCursor,
  moveRoom,
  nearestHandle,
  padAround,
  paddingAxis,
  KNOB_CLEARANCE,
  paddingHandleCenters,
  paddingRingGaps,
  parseAspectRatio,
  placeKnob,
  ratioLabel,
  rememberedSource,
  resetTransformValues,
  resizeCrop,
  resolveCrop,
  resolvePadding,
  rotatedSize,
  scaleCanvasPadding,
  scaleToMegapixels,
  sizeChain,
  sizeChainTokens,
  slidePadding,
  sourceChanged,
  sourceResetValues,
  stageHandleLayout,
  stageHeightForWidth,
  stepWithoutStretch,
  tightLockPadding,
  turnAspect,
  turnedCrop,
  wrapDegrees,
  zoomAround,
} from "./transform_geometry.mjs?v=2026101316";
import { clampFrame, clipInfo, frameTime } from "./timeline_math.mjs?v=2026101316";
import { liftSocket } from "./widget_card.mjs?v=2026101316";

const HIDDEN_WIDGETS = [
  "image", "upload",
  "video", "source_mode", "local_path",
  "rotation_degrees", "crop_aspect_ratio", "crop_x", "crop_y", "crop_width", "crop_height",
  "pad_left", "pad_top", "pad_right", "pad_bottom", "feather", "canvas_multiple", "fill_color",
  "seek_mode", "frame_index", "frame_time",
  "start_seconds", "end_seconds", "every_nth", "max_frames", "frame_snap", "fixed_frames",
  // Stitch settings (clip and image nodes), driven by the editor's Inpaint & Stitch section.
  "stitch_blend", "stitch_grow",
  // Image node: what a painted part is handed on as, set in the same section.
  "painted_area",
  // Image-node resize block; hideWidget on a missing widget is a no-op, so
  // the video node sharing this list is unaffected.
  "resize_to_megapixels", "megapixels", "resize_method", "resolution_steps",
];
const trimInputDriven = (node, name) => node.inputs?.some(
  (input) => (input.name === name || input.widget?.name === name) && input.link != null,
) ?? false;

const RESIZE_METHODS = ["lanczos", "area", "bicubic", "bilinear", "nearest-exact"];
// The widest the control rows get on a big node; the picture takes the rest.
const CONTROL_MAX_WIDTH = 460;
const TRANSFORM_DEFAULTS = resetTransformValues(false);
const CORE_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";

// The gear on the image node's source card. Display choices only, kept for
// every image node on this browser (settings_menu.mjs stores them).
const SETTINGS_SCOPE = "image_crop_rotate_pad";
const SETTINGS_SCHEMA = [
  {
    key: "show_mask", label: "Show the mask on the picture", type: "toggle", default: true,
    hint: "Teal over the parts of your picture the model paints: a mask drawn in the MaskEditor, or see-through parts of a PNG.",
  },
];
let transformSettings = null;
function settings() {
  transformSettings ??= loadSettings(SETTINGS_SCOPE, SETTINGS_SCHEMA);
  return transformSettings;
}
// Every installed node, so a changed setting redraws them all at once.
const liveStates = new Set();

// Titles and readout lines composed at build time go through zh(): the zh
// plugin's DOM translator whole-string-matches and never observes attribute
// writes after insertion, so a reassigned English title would stay English
// forever. The dictionary arrives asynchronously; once it lands, redraw the
// live panels so faces built before it was ready catch up.
zhReady().then(() => {
  if (zhOn()) for (const live of liveStates) draw(live);
});

function installStyles() {
  if (document.getElementById("qgtools-transform-styles")) return;
  const style = document.createElement("style");
  style.id = "qgtools-transform-styles";
  style.textContent = `
    .qgtools-transform-panel{display:flex;flex-direction:column;gap:8px;padding:8px;color:#ddd;font:12px system-ui;box-sizing:border-box;width:100%;height:100%;overflow:hidden}
    .qgtools-transform-panel>:not(.qgtools-transform-preview){width:100%;max-width:${CONTROL_MAX_WIDTH}px;align-self:center;box-sizing:border-box}
    .qgtools-transform-preview{width:100%;flex:1 1 180px;min-height:0;border:1px solid #50555b;border-radius:8px;background:#111;display:block;touch-action:none}
    .qgtools-transform-source{display:flex;flex-direction:column;gap:7px;flex:0 0 auto;padding:8px;border:1px solid rgba(0,184,174,.28);border-radius:8px;background:rgba(0,0,0,.24)}
    .qgtools-transform-source-heading{color:${BRAND};font:600 10px system-ui;letter-spacing:.08em;text-transform:uppercase}
    .qgtools-transform-source-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
    .qgtools-transform-gear{flex:none;width:20px;height:20px;margin:-4px 0;display:grid;place-items:center;padding:0;border:1px solid #2a3437;border-radius:5px;background:#0f1516;color:#8ba3a1;cursor:pointer}
    .qgtools-transform-gear:hover{border-color:${BRAND};color:${BRAND}}
    .qgtools-transform-source-mode{display:grid;grid-template-columns:1fr 1fr;height:30px;padding:3px;border:1px solid #2a3437;border-radius:7px;background:#0f1516}
    .qgtools-transform-source-mode button{border:0;border-radius:5px;background:transparent;color:#8ba3a1;font:600 12px system-ui;cursor:pointer}
    .qgtools-transform-source-mode button:hover{color:#fff}.qgtools-transform-source-mode button.on{background:${BRAND};color:#04201d}
    .qgtools-transform-source-field{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}
    .qgtools-transform-source-field select,.qgtools-transform-source-field input{box-sizing:border-box;width:100%;height:34px;min-width:0;padding:0 10px;border:1px solid #2a3437;border-radius:7px;outline:0;background:#0b0f10;color:#dce9e8;font:12px ui-monospace,"SF Mono",Menlo,Consolas,monospace}
    .qgtools-transform-source-field select:focus,.qgtools-transform-source-field input:focus{border-color:${BRAND}}
    .qgtools-transform-source-field .qgtools-media-pick{box-sizing:border-box;width:100%;height:34px;min-width:0;padding:0 28px 0 10px;border:1px solid #2a3437;border-radius:7px;background:#0b0f10 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238ba3a1' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center;color:#dce9e8;font:12px ui-monospace,"SF Mono",Menlo,Consolas,monospace}
    .qgtools-transform-source-field .qgtools-media-pick:hover,.qgtools-transform-source-field .qgtools-media-pick:focus-visible{border-color:${BRAND};outline:0}
    .qgtools-transform-source-action{height:34px;box-sizing:border-box;white-space:nowrap}
    .qgtools-transform-source-field:has(input[type=text]){grid-template-columns:minmax(0,1fr)}
    .qgtools-transform-source-hint{overflow:hidden;color:#6f8886;font-size:10.5px;line-height:1.25;white-space:nowrap;text-overflow:ellipsis}
    .lg-node:has(.qgtools-transform-panel) .image-preview{display:none!important}
    .qgtools-transform-row{display:flex;gap:7px;align-items:center;flex:0 0 auto}.qgtools-transform-row>*{min-width:0;flex:1}
    .qgtools-transform-canvas-row{justify-content:space-between;flex-wrap:wrap;row-gap:6px}
    .qgtools-transform-canvas-row>label{flex:0 0 auto;display:flex;align-items:center;gap:6px;color:#aeb4ba;font-size:11px;white-space:nowrap;cursor:default;user-select:none}
    .qgtools-transform-canvas-row>label>span{color:#8ca8a5;font-size:11px}
    .qgtools-transform-canvas-row>.qgtools-transform-centre-label{flex:0 0 auto;display:flex;align-items:center;gap:6px;color:#8ca8a5;font-size:11px;white-space:nowrap;cursor:default;user-select:none}
    .qgtools-transform-swatch{width:30px;height:22px;padding:1px;border:1px solid #555b63;border-radius:5px;background:#23272c;cursor:pointer}
    .qgtools-transform-swatch::-webkit-color-swatch-wrapper{padding:1px}.qgtools-transform-swatch::-webkit-color-swatch{border:0;border-radius:3px}
    .qgtools-transform-canvas-row input[type=checkbox]{accent-color:${BRAND};margin:0;cursor:pointer}
    .qgtools-transform-resize-row{justify-content:flex-start;gap:14px}
    .qgtools-transform-readout{flex:0 0 auto;margin-top:-3px;color:#c9d0d6;font:11px/14px system-ui;font-variant-numeric:tabular-nums;text-align:center;overflow:hidden;max-height:56px;cursor:default;user-select:none}
    .qgtools-transform-readout:empty{display:none}
    .qgtools-transform-readout span{color:#8ca8a5}.qgtools-transform-readout b{color:#fff;font-weight:600}
    .qgtools-transform-readout i{display:block;color:#ffc46b;font-style:normal}
    .qgtools-transform-readout em{color:#8ca8a5;font-style:normal}
    .qgtools-transform-readout em.note{color:#ffc46b}
    .qgtools-transform-readout button{margin:0 0 0 6px;height:14px;padding:0 6px;border:1px solid #6b5a33;border-radius:3px;background:#2a2417;color:#ffd79a;font:600 9.5px/12px system-ui;cursor:pointer;vertical-align:0}
    .qgtools-transform-readout button:hover{border-color:#ffc46b;color:#fff}
    .qgtools-transform-aspects{display:flex;gap:5px;align-items:center;flex:0 0 auto}
    .qgtools-transform-aspects>span{flex:0 0 auto;color:#8ca8a5;font-size:10px;padding:0 3px;user-select:none}
    .qgtools-transform-aspect{flex:1 1 0;min-width:0;background:#262a30;color:#cfd6dc;border:1px solid #4a5058;border-radius:4px;height:28px;padding:3px 2px;font:600 10px system-ui;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;text-align:center}
    .qgtools-transform-aspect-flip{flex:0 0 30px;display:flex;align-items:center;justify-content:center;margin-right:3px}
    .qgtools-transform-aspect-glyph{display:block;border:1px solid currentColor;border-radius:1px;box-sizing:border-box}
    .qgtools-transform-aspect:hover{border-color:#9aa5ad;color:#fff}
    .qgtools-transform-aspect.active,.qgtools-transform-aspect-hold.on{background:${BRAND};border-color:${BRAND};color:#04201d}
    .qgtools-transform-aspect.active:hover,.qgtools-transform-aspect-hold.on:hover{border-color:#e5fffc;color:#04201d}
    .qgtools-transform-aspects>.qgtools-transform-aspect-caption{min-width:34px;text-align:center}
    .qgtools-transform-aspects>.qgtools-transform-aspect-caption.custom{color:#e3e8ec}
    .qgtools-transform-aspects>.qgtools-transform-aspect-caption.held{color:${BRAND};font-weight:600}
    .qgtools-transform-aspect-hold{flex:0 0 28px;display:flex;align-items:center;justify-content:center;color:#8d9aa2}
    .qgtools-transform-aspect-hold.idle{opacity:.4;cursor:default}
    .qgtools-transform-aspect-hold.idle:hover{border-color:#4a5058;color:#8d9aa2}
    .qgtools-transform-aspect-lock{display:inline-block;line-height:0}
    .qgtools-transform-centre{display:inline-flex;gap:4px;flex:0 0 auto;align-items:center}
    .qgtools-transform-centre>.qgtools-transform-centre-button{flex:0 0 28px;width:28px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;color:#cfd6dc}
    .qgtools-transform-centre>.qgtools-transform-centre-button.idle{opacity:.4;cursor:default}
    .qgtools-transform-centre>.qgtools-transform-centre-button.idle:hover{border-color:#4a5058;color:#cfd6dc}
    .qgtools-transform-centre-glyph{display:inline-block;line-height:0}
    .qgtools-transform-section .qgtools-transform-centre-row{display:grid;grid-template-columns:108px minmax(0,1fr);gap:7px;align-items:center;margin:7px 0}
    .qgtools-transform-fit-label{display:flex;align-items:center;gap:6px;color:#aeb4ba;font-size:11px;cursor:default;user-select:none}
    .qgtools-transform-fit{display:grid;grid-template-columns:1fr 1fr;flex:1 1 auto;height:26px;padding:2px;border:1px solid #2a3437;border-radius:6px;background:#0f1516;box-sizing:border-box}
    .qgtools-transform-fit button{border:0;border-radius:4px;background:transparent;color:#8ba3a1;font:600 11px system-ui;cursor:pointer;white-space:nowrap}
    .qgtools-transform-fit button:hover{color:#fff}.qgtools-transform-fit button.on{background:${BRAND};color:#04201d}
    .qgtools-transform-fit.idle{opacity:.45}
    .qgtools-transform-fit-hint{flex:0 1 auto;min-width:0;color:#6f8886;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .qgtools-transform-aspect-modes{flex-wrap:wrap;row-gap:6px}
    .qgtools-transform-aspect-modes>.qgtools-transform-fit-label{flex:1 0 auto}
    .qgtools-transform-aspect-modes .qgtools-transform-fit{min-width:96px}
    .qgtools-transform-aspect-modes>.qgtools-transform-alignment{margin-left:auto}
    .qgtools-transform-switch{flex:0 0 76px;height:24px}
    .qgtools-transform-canvas-row .qgtools-transform-switch{width:76px}
    .qgtools-transform-button,.qgtools-transform-modal button:not(.qgtools-scrub-step>button):not(.qgtools-transform-aspect):not(.qgtools-transform-fit>button):not(.qgtools-transform-trim-reset):not(.qgtools-transform-trim-pill>button):not(.qgtools-transform-trim-handle){background:#30343a;color:#eee;border:1px solid #555b63;border-radius:5px;padding:7px 10px;cursor:pointer}
    .qgtools-transform-button:hover,.qgtools-transform-modal button:not(.qgtools-scrub-step>button):not(.qgtools-transform-aspect):not(.qgtools-transform-fit>button):not(.qgtools-transform-trim-reset):not(.qgtools-transform-trim-pill>button):not(.qgtools-transform-trim-handle):hover{border-color:${BRAND};background:#383e44}
    .qgtools-transform-file{position:relative;text-align:center;overflow:hidden}.qgtools-transform-file input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
    .qgtools-transform-modal{position:fixed;inset:0;z-index:100000;background:#101214;color:#e6e8ea;font:13px system-ui;display:grid;grid-template-rows:42px minmax(0,1fr) auto}
    .qgtools-transform-header{display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid #30343a;background:#17191c}
    .qgtools-transform-header strong{color:#fff}.qgtools-transform-header .spacer{flex:1}
    .qgtools-transform-close{background:${BRAND}!important;border-color:${BRAND}!important;color:#06231f!important;font-weight:600}
    .qgtools-transform-close:hover{filter:brightness(1.15)}
    .qgtools-transform-danger{background:#4a1717!important;border-color:#a13a3a!important;color:#ffd9d9!important}
    .qgtools-transform-danger:hover{background:#6b1f1f!important;border-color:#c74e4e!important}
    .qgtools-transform-body{display:grid;grid-template-columns:304px minmax(320px,1fr) 250px;min-height:0}
    .qgtools-transform-sidebar{padding:12px;border-right:1px solid #30343a;overflow:auto;background:#181b1e}
    .qgtools-transform-sidebar.right{border-right:0;border-left:1px solid #30343a}
    .qgtools-transform-section{border-bottom:1px solid #34383d;padding:0 0 13px;margin:0 0 13px}
    .qgtools-transform-section h3{font-size:11px;color:${BRAND};text-transform:uppercase;margin:0 0 8px;display:flex;align-items:center;gap:7px}
    .qgtools-legend{display:inline-block;flex:0 0 auto;width:10px;height:10px}
    canvas.qgtools-legend{width:16px;height:16px}
    .qgtools-legend-crop{background:#4bd8ef;border:1px solid #08272d}
    .qgtools-legend-pad{background:#ff9d42;border:1px solid #3b2108;width:9px;height:9px;transform:rotate(45deg)}
    .qgtools-final-preview{display:block;max-width:100%;margin:2px auto 0;border:1px solid #34383d;border-radius:6px;background:#0c0e10}
    .qgtools-transform-section label{display:grid;grid-template-columns:88px 1fr 58px;gap:7px;align-items:center;margin:7px 0}
    .qgtools-transform-section label>.qgtools-scrub:last-child{width:58px}
    .qgtools-transform-section label.qgtools-transform-field{grid-template-columns:108px minmax(0,1fr)}
    .qgtools-transform-section label.qgtools-transform-field>.qgtools-scrub{width:100%}
    /* No-suffix label rows (Show blend / Painted area): the spare 58px suffix
       column would otherwise squeeze the pill, forcing two-character labels
       like the localized Fill/Keep to wrap one character per line. */
    .qgtools-transform-section label.qgtools-transform-nosuffix{grid-template-columns:88px minmax(0,1fr)}
    .qgtools-transform-section .qgtools-transform-aspects{margin:4px 0 8px}
    .qgtools-transform-section .qgtools-transform-aspect-modes{margin:0 0 8px}
    .qgtools-transform-section .qgtools-transform-aspects{gap:4px}
    .qgtools-transform-section .qgtools-transform-aspect{padding:3px 0}
    .qgtools-transform-section label>*{min-width:0}
    .qgtools-transform-section input:not(.qgtools-scrub-input):not(.qgtools-transform-swatch),.qgtools-transform-section select{box-sizing:border-box;width:100%;background:#0e1012;color:#eee;border:1px solid #454b52;border-radius:4px;padding:5px}
    .qgtools-transform-stage{position:relative;min-width:0;min-height:0;background-color:#0c0e10;background-image:radial-gradient(#292d31 1px,transparent 1px);background-size:18px 18px;overflow:hidden}
    .qgtools-transform-canvas{width:100%;height:100%;display:block;touch-action:none}
    .qgtools-transform-status{line-height:1.55;color:#b8bec5;white-space:pre-wrap}.qgtools-transform-help{line-height:1.55;color:#aeb4ba}
    .qgtools-transform-sidebar.right .qgtools-transform-section{margin-top:13px}
    .qgtools-transform-section details{margin:8px 0 0}.qgtools-transform-section summary{cursor:pointer;color:#8de0da;font-size:11px;text-transform:uppercase;letter-spacing:.06em;list-style:none;user-select:none}
    .qgtools-transform-section summary::before{content:"▸";display:inline-block;width:12px;transition:transform .12s}.qgtools-transform-section details[open] summary::before{transform:rotate(90deg)}
    .qgtools-transform-section input[type=checkbox]{width:auto;justify-self:start;accent-color:${BRAND}}
    .qgtools-transform-timeline{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid #30343a;background:#17191c}
    .qgtools-transform-timeline>.qgtools-transform-trim{flex-basis:100%}
    .qgtools-transform-transport{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex-basis:100%}
    .qgtools-transform-steps{display:flex;gap:4px;flex-wrap:wrap}.qgtools-transform-steps button{padding:5px 7px}
    .qgtools-transform-badge{padding:3px 7px;border-radius:99px;background:#263034;color:#8de0da;font-size:11px}
    @media(max-width:900px){.qgtools-transform-body{grid-template-columns:290px minmax(260px,1fr)}.qgtools-transform-sidebar.right{display:none}}
  `;
  document.head.appendChild(style);
}

function widget(node, name) { return node.widgets?.find((item) => item.name === name); }
function value(node, name, fallback = 0) { return widget(node, name)?.value ?? fallback; }
function setValue(node, name, next) {
  const target = widget(node, name);
  if (!target) return;
  target.value = next;
  target.callback?.(next);
}
function values(node) {
  return Object.fromEntries(Object.keys(TRANSFORM_DEFAULTS).map((name) => [name, value(node, name, TRANSFORM_DEFAULTS[name])]));
}

function suppressCoreImagePreview(node) {
  const previewIndex = node.widgets?.findIndex((item) => item.name === CORE_IMAGE_PREVIEW_WIDGET) ?? -1;
  if (previewIndex >= 0) {
    node.widgets[previewIndex].onRemove?.();
    node.widgets.splice(previewIndex, 1);
  }
  if (node.__qgImgsSuppressed) return;
  node.__qgImgsSuppressed = true;
  node.__qgAddCustomWidget = node.addCustomWidget;
  if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget = function (customWidget) {
      if (customWidget?.name === CORE_IMAGE_PREVIEW_WIDGET) hideWidget(customWidget);
      return node.__qgAddCustomWidget.call(this, customWidget);
    };
  }
  node.__qgImgsDescriptor = Object.getOwnPropertyDescriptor(node, "imgs");
  Object.defineProperty(node, "imgs", {
    configurable: true,
    enumerable: true,
    get() { return undefined; },
    // The MaskEditor sets this right after it writes the picture it saved.
    set() {
      const state = node.__qgTransformState;
      if (state) queueMicrotask(() => followSource(state));
    },
  });
}

// The MaskEditor saves its picture (the mask is the picture's alpha) into
// the image widget's stored value without calling the widget back, so the
// stage never heard of it and kept the old picture. A source changed that
// way is followed here, keeping the framing, as a workflow load does: the
// mask was drawn on the same picture.
function followSource(state) {
  if (state.disposed || !state.ready || state.kind !== "image") return;
  const key = sourceKey(state.node, "image");
  if (!key || key === state.source) return;
  state.syncSourceCard?.();
  void onSourceChanged(state, false);
}

function sourceKey(node, kind) {
  if (kind === "image") return String(value(node, "image", ""));
  return videoSourceState(
    value(node, "source_mode", INPUT_FOLDER_MODE),
    value(node, "video", ""),
    value(node, "local_path", ""),
  ).key;
}

function parseInputReference(selection) {
  const normalized = String(selection || "").replaceAll("\\", "/");
  const parts = normalized.split("/");
  const filename = parts.pop() || "";
  return { filename, subfolder: parts.join("/"), type: "input" };
}

function imageSourceUrl(selection) {
  const reference = parseInputReference(selection);
  return api.apiURL(`/view?${new URLSearchParams(reference)}`);
}

function videoParams(node, maxSize = 1600) {
  return new URLSearchParams({
    source_mode: String(value(node, "source_mode", "input folder")),
    video: String(value(node, "video", "")),
    local_path: String(value(node, "local_path", "")),
    seek_mode: String(value(node, "seek_mode", "frame index")),
    frame_index: String(Math.max(0, Math.round(Number(value(node, "frame_index", 0)) || 0))),
    frame_time: String(Math.max(0, Number(value(node, "frame_time", 0)) || 0)),
    max_width: String(maxSize),
    max_height: String(maxSize),
  });
}

async function uploadMedia(node, kind, file) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "input");
  const route = kind === "video" ? "/qg/transform/video/upload" : "/upload/image";
  const response = await api.fetchApi(route, { method: "POST", body });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message || "Upload failed.");
  }
  const result = await response.json();
  const selection = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  const target = widget(node, kind);
  if (Array.isArray(target?.options?.values) && !target.options.values.includes(selection)) target.options.values.push(selection);
  if (kind === "video") setValue(node, "source_mode", "input folder");
  setValue(node, kind, selection);
  return selection;
}

function resetTransform(node, includeTimeline = false) {
  if (node.properties) { delete node.properties.qg_fit_aspect; node.properties.qg_aspect_lock = false; }
  for (const [name, next] of Object.entries(declaredTransformDefaults(node.constructor?.nodeData, includeTimeline))) setValue(node, name, next);
  node.setDirtyCanvas?.(true, true);
}

// The node face's Reset: only the shape - rotation, crop, padding. Fill,
// feather and Align stay, as they do when the source changes.
function resetGeometry(node) {
  if (node.properties) { delete node.properties.qg_fit_aspect; node.properties.qg_aspect_lock = false; }
  for (const [name, next] of Object.entries(sourceResetValues(false))) setValue(node, name, next);
  node.setDirtyCanvas?.(true, true);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function addLabeledControl(section, title, control, suffix = "") {
  const label = createElement("label");
  label.append(createElement("span", "", title), control);
  // No suffix, no third cell: an empty span would spill onto a second grid
  // row once the nosuffix class narrows the template to two columns.
  if (suffix) label.append(createElement("span", "", suffix));
  section.append(label);
  return label;
}

function buildMediaSourceCard(state) {
  const { node, kind } = state;
  const root = createElement("div", "qgtools-transform-source");
  const modes = createElement("div", "qgtools-transform-source-mode");
  const uploadsMode = createElement("button", "", "Uploads");
  const localMode = createElement("button", "", "Server file");
  uploadsMode.type = localMode.type = "button";
  uploadsMode.title = "Choose a video already in ComfyUI's input folder or upload another.";
  localMode.title = "A video already on the ComfyUI server, inside its input, output or temp folder, read in place without copying it.";
  modes.append(uploadsMode, localMode);

  const field = createElement("div", "qgtools-transform-source-field");
  // The media picker previews the hovered file, which a native <select> cannot.
  const picker = createMediaPicker({
    kind: kind === "video" ? "video" : "image",
    placeholder: zh(kind === "video" ? "Choose an uploaded video…" : "Choose an uploaded image…"),
    label: zh(kind === "video" ? "Uploaded video" : "Uploaded image"),
    viewUrl: (name) => api.apiURL(`/view?${mediaViewQuery(name)}`),
    getOptions: () => currentOptions(),
    getValue: () => value(node, kind, ""),
    onChange: (name) => {
      setValue(node, kind, name);
      sync();
      notifyQgChange();
    },
  });
  const localPath = createElement("input");
  localPath.type = "text";
  localPath.spellcheck = false;
  localPath.placeholder = "/absolute/path/to/video.mp4";
  localPath.setAttribute("aria-label", "Server file path");
  const upload = createElement("label", "qgtools-transform-button qgtools-transform-file qgtools-transform-source-action");
  const uploadText = createElement("span", "", "Upload");
  upload.append(uploadText);
  const fileInput = createElement("input");
  fileInput.type = "file";
  fileInput.accept = `${kind}/*`;
  fileInput.setAttribute("aria-label", zh(kind === "video" ? "Upload video" : "Upload image"));
  upload.append(fileInput);
  const hint = createElement("div", "qgtools-transform-source-hint");
  field.append(picker.element, upload);
  root.append(kind === "image" ? sourceHeading() : modes, field, hint);

  const currentOptions = () => {
    const target = widget(node, kind);
    let options = target?.options?.values;
    if (typeof options === "function") options = options(target, node);
    return normalizeVideoOptions(options, target?.value);
  };
  const sync = () => {
    const source = mediaSourceState(
      kind,
      value(node, "source_mode", INPUT_FOLDER_MODE),
      value(node, kind, ""),
      value(node, "local_path", ""),
    );
    uploadsMode.classList.toggle("on", source.mode === INPUT_FOLDER_MODE);
    localMode.classList.toggle("on", source.mode === LOCAL_PATH_MODE);
    picker.refresh(value(node, kind, ""));
    localPath.value = String(value(node, "local_path", ""));
    field.replaceChildren();
    if (source.mode === LOCAL_PATH_MODE) field.append(localPath);
    else field.append(picker.element, upload);
    hint.textContent = source.hint;
    hint.title = source.mode === LOCAL_PATH_MODE
      ? `${source.hint} Only videos inside ComfyUI's input, output or temp folder can be read.`
      : source.hint;
    // "Choose an uploaded video" has done its job once one is chosen; its
    // line goes to the picture. The Server file note stays while you type.
    hint.style.display = source.mode !== LOCAL_PATH_MODE && source.selection ? "none" : "";
  };
  const chooseMode = (mode) => {
    if (value(node, "source_mode", INPUT_FOLDER_MODE) === mode) return;
    setValue(node, "source_mode", mode);
    sync();
    notifyQgChange();
  };
  uploadsMode.addEventListener("click", () => chooseMode(INPUT_FOLDER_MODE));
  localMode.addEventListener("click", () => chooseMode(LOCAL_PATH_MODE));
  const commitLocalPath = () => {
    const next = localPath.value.trim();
    if (next !== String(value(node, "local_path", ""))) {
      setValue(node, "local_path", next);
      notifyQgChange();
    }
    sync();
  };
  localPath.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter") localPath.blur();
    if (event.key === "Escape") { localPath.value = String(value(node, "local_path", "")); localPath.blur(); }
  });
  localPath.addEventListener("blur", commitLocalPath);
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files?.[0]) return;
    fileInput.disabled = true;
    uploadText.textContent = "Uploading…";
    upload.setAttribute("aria-busy", "true");
    try {
      await uploadMedia(node, kind, fileInput.files[0]);
      sync();
      notifyQgChange();
    } catch (error) {
      showToast({ severity: "error", summary: "QG Image Crop + Rotate + Pad", detail: error.message, life: 8000 });
    } finally {
      fileInput.value = "";
      fileInput.disabled = false;
      uploadText.textContent = "Upload";
      upload.removeAttribute("aria-busy");
    }
  });
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,select,input,label")) event.stopPropagation();
  });
  state.syncSourceCard = sync;
  sync();
  return root;
}

// "Image source" with the node's gear at the other end of the line.
function sourceHeading() {
  const head = createElement("div", "qgtools-transform-source-head");
  const gear = createElement("button", "qgtools-transform-gear");
  gear.type = "button";
  gear.title = "Image Crop + Rotate + Pad settings";
  gear.innerHTML = gearIconSvg(11);
  gear.addEventListener("click", () => openSettingsMenu({
    scope: SETTINGS_SCOPE,
    schema: SETTINGS_SCHEMA,
    anchor: gear.getBoundingClientRect(),
    title: "Image Crop + Rotate + Pad settings",
    onChange: (values) => {
      transformSettings = values;
      for (const live of liveStates) draw(live);
    },
  }));
  head.append(createElement("div", "qgtools-transform-source-heading", "Image source"), gear);
  return head;
}

export function installTransformNode(node, kind, mountPanel = null) {
  installStyles();
  const state = {
    node, kind, image: null, sourceWidth: 0, sourceHeight: 0, metadata: null,
    modal: null, canvas: null, previewCanvas: null, render: null, panelRender: null, drag: null,
    view: { zoom: 1, panX: 0, panY: 0 }, grid: false, ready: false,
    source: sourceKey(node, kind), frameController: null, frameObjectUrl: null,
    playbackTimer: null, playing: false, playbackSession: 0, disposed: false, loadSerial: 0,
    imageIndex: null, imageTime: null,
  };
  node.__qgTransformState = state;
  liveStates.add(state);
  state.isClip = Boolean(widget(node, "start_seconds") && widget(node, "end_seconds"));
  state.trimViews = new Set();
  if (state.isClip) {
    // The executor includes every input in its cache key, even when
    // IS_CHANGED ignores it. Preview position is UI state, not clip input.
    for (const [name, constant] of [["seek_mode", "frame index"], ["frame_index", 0], ["frame_time", 0]]) {
      widget(node, name).serializeValue = () => constant;
    }
  }
  // No transform node sends a picture of its own, so a ComfyUI preview on
  // one is always somebody else's: outputs are filed by node id, and a run
  // queued in another workflow tab lands on the node with the same id here.
  // The stage is the node's only picture, in both renderers (the video
  // suppression also sets Nodes 2.0's hideOutputImages).
  suppressCoreImagePreview(node);
  suppressCoreVideoPreview(node);
  if (kind === "video") installVideoDrop(state);
  for (const name of HIDDEN_WIDGETS) hideWidget(widget(node, name));
  liftSocket(node, "fixed_frames");

  const panel = createElement("div", "qgtools-transform-panel");
  const preview = createElement("canvas", "qgtools-transform-preview");
  const row = createElement("div", "qgtools-transform-row");
  const open = createElement("button", "qgtools-transform-button", "Open editor");
  const resetCrop = createElement("button", "qgtools-transform-button", "Reset crop");
  resetCrop.title = "Show the whole picture again; rotation, padding and the timeline stay. With the padlock on, the bands it added to keep the shape go too.";
  resetCrop.addEventListener("click", () => resetCropKeepingShape(state));
  const reset = createElement("button", "qgtools-transform-button", "Reset");
  reset.title = "Reset rotation, crop and padding, and turn the padlock off. Fill, feather, Divisible by and the timeline stay.";
  reset.addEventListener("click", () => {
    resetGeometry(node);
    fitCrop(state); updateModalInfo(state); notifyQgChange();
  });
  row.append(open, resetCrop, reset);
  state.editorSyncs = [];
  panel.append(buildMediaSourceCard(state));
  const readout = createElement("div", "qgtools-transform-readout");
  state.readout = readout;
  // Its Even out button is a click, not a node drag.
  readout.addEventListener("pointerdown", (event) => { if (event.target.closest("button")) event.stopPropagation(); });
  panel.append(preview, readout);
  const chipRow = buildAspectChipRow(state);
  const modeRow = buildAspectModeRow(state);
  state.syncAspectChips = chipRow.sync;
  state.syncAspectMode = modeRow.sync;
  panel.append(chipRow.row, modeRow.row);
  // Every transform node shows its canvas on the face - fill, feather and,
  // where the node has it, the resize budget and step - so a wrong value is
  // seen on the node, not discovered in the render. Both video nodes also
  // get the timeline: the clip node trims with it, the frame picker scrubs.
  panel.append(...buildCanvasRow(state));
  if (kind === "video") panel.append(buildTrim(state));
  panel.append(row);
  state.previewCanvas = preview;
  open.addEventListener("click", () => openEditor(state));

  if (typeof node.addDOMWidget === "function" && mountPanel) {
    mountPanel(node, panel);
  } else if (typeof node.addDOMWidget === "function") {
    const domWidget = node.addDOMWidget("qg_transform_preview", "qg_transform_preview", panel, {
      serialize: false,
      hideOnZoom: false,
    });
    keepDomWidgetWidthAuto(domWidget);
    // Not saved with the workflow either: options.serialize only keeps it out
    // of the prompt, and saved values come back by position.
    domWidget.serialize = false;
    // exactMinWidth: 330 is the node's real floor, without the frontend's
    // number-widget padding that made the first corner drag jump to 434.
    fillNodeHeight(domWidget, { minWidth: TRANSFORM_MIN_WIDTH, minHeight: () => transformPanelFloor(node), minNodeSize: [TRANSFORM_MIN_WIDTH, state.isClip ? 802 : kind === "video" ? 570 : 456], exactMinWidth: true });
  } else {
    node.addWidget?.("button", "Open editor", null, () => openEditor(state), { serialize: false });
  }
  // A fresh node opens at its floor: the stage as tall as its width asks.
  node.setSize?.([
    Math.max(TRANSFORM_MIN_WIDTH, Math.min(520, node.size?.[0] || TRANSFORM_MIN_WIDTH)),
    node.computeSize?.()[1] || (state.isClip ? 842 : kind === "video" ? 635 : 511),
  ]);
  if (typeof node.addDOMWidget === "function") {
    // Redraw on wrapper size changes (node resize, zoom relayout);
    // node.onResize is unreliable across frontends.
    //
    // This is not only about hit-testing. prepareCanvas() sizes the backing
    // store from the element at DRAW time, and the canvas is CSS-stretched to
    // its box, so a box that changes shape without a redraw displays the last
    // frame at the wrong aspect. Both kinds need it: the video panel is a
    // passive preview and has no other reason to redraw, which is exactly why
    // it was the one that came out stretched.
    state.panelResizeObserver = new ResizeObserver(() => draw(state));
    state.panelResizeObserver.observe(preview);
    // The graph scales the DOM widget with its zoom, so the backing store
    // sized at one zoom turns to mush at another: redraw when it changes.
    chainCallback(node, "onDrawForeground", function () {
      // Also where a picture saved by the MaskEditor is noticed.
      followSource(state);
      if (state.isClip && !state.disposed) {
        const rate = clipOutputRate(node, state.metadata?.fps, value(node, "every_nth", 1));
        const linked = ["fixed_frames", "frame_load_cap", "max_frames", "start_frame", "end_frame", "start_seconds", "end_seconds", "every_nth"];
        const signature = JSON.stringify([rate, ...linked.map(name => inputNumber(node, name, value(node, name, 0)))]);
        if (signature !== state.trimRate) {
          state.trimRate = signature;
          for (const trim of state.trimViews) trim.sync();
        }
      }
      if (state.disposed || state.zoomRedraw || Math.abs(panelOversample() - (state.panelOversample ?? 1)) < 0.01) return;
      state.zoomRedraw = requestAnimationFrame(() => { state.zoomRedraw = null; if (!state.disposed) draw(state); });
    });
  }
  if (typeof node.addDOMWidget === "function") {
    // All transform nodes share inline handles. Wheel/middle-drag still
    // belong to the graph; only direct handle gestures are captured.
    state.panelInteractive = true;
    state.panelAbort = new AbortController();
    attachStageHandlers(state, preview, state.panelAbort.signal);
  }

  const watched = kind === "image" ? ["image"] : ["video", "source_mode", "local_path"];
  for (const name of watched) {
    const target = widget(node, name);
    if (!target) continue;
    chainCallback(target, "callback", function () {
      state.syncSourceCard?.();
      if (state.ready) onSourceChanged(state, true);
    });
  }
  chainCallback(node, "onConnectionsChange", () => queueMicrotask(() => {
    for (const trim of state.trimViews) trim.sync();
  }));
  chainCallback(node, "onConfigure", () => queueMicrotask(() => {
    if (state.disposed) return;
    for (const name of HIDDEN_WIDGETS) hideWidget(widget(node, name));
    liftSocket(node, "fixed_frames");
    state.syncSourceCard?.();
    for (const trim of state.trimViews) trim.sync();
    if (state.ready) onSourceChanged(state, false);
  }));
  queueMicrotask(async () => {
    // Core's upload helper can add its button after our creation hook.
    for (const name of HIDDEN_WIDGETS) hideWidget(widget(node, name));
    liftSocket(node, "fixed_frames");
    state.ready = true;
    await onSourceChanged(state, false);
  });
  return state;
}

// Dropping a video file on the node uploads it and makes it the source,
// as core's upload widgets do for their own nodes. Core's canvas drop
// handler asks the node under the cursor first; a handled drop keeps it
// from spawning a separate Load Video node for the file.
const VIDEO_FILE_PATTERN = /\.(avi|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|webm)$/i;

function installVideoDrop(state) {
  const node = state.node;
  node.onDragOver = (event) => {
    const items = event?.dataTransfer?.items;
    return Boolean(items && Array.from(items).some((item) => item.kind === "file"));
  };
  node.onDragDrop = async (event) => {
    const file = Array.from(event?.dataTransfer?.files ?? []).find(
      (candidate) => String(candidate.type).startsWith("video/") || VIDEO_FILE_PATTERN.test(candidate.name),
    );
    if (!file) return false;
    try {
      await uploadMedia(node, "video", file);
      state.syncSourceCard?.();
      if (state.ready) await onSourceChanged(state, true);
      notifyQgChange();
    } catch (error) {
      showToast({ severity: "error", summary: "QG Image Crop + Rotate + Pad", detail: error.message, life: 8000 });
    }
    return true;
  };
}

// Ratio chips right under the preview, one state each: a chip is lit while
// the canvas has its shape. Tap one to pad the picture to it (crop, with
// Fit on crop), centred; tap the lit one to go back to the whole picture.
// The padlock at the end of the row holds the shape while you drag a
// handle, and the orientation button at the start turns the shape on its
// side. A drag that leaves the lit shape turns the chip off, and the row
// says Custom with the real ratio on the size line. The same row is built
// again in the full editor, so both places work the same way.
const ASPECT_CHIP_ORDER = ["1:1", "4:3", "3:2", "16:9", "21:9"];

function sourceSize(state) {
  return rotatedSize(state.sourceWidth, state.sourceHeight, value(state.node, "rotation_degrees", 0));
}

function hasPicture(state) {
  return Boolean(state.image && state.sourceWidth && state.sourceHeight);
}

function currentCanvas(state) {
  return canvasSize(values(state.node), sourceSize(state));
}

// The ratio you picked (properties.qg_fit_aspect) while the canvas
// still has it, or while there is no picture yet to have it: the lit chip,
// and the shape a new source is fitted to.
function liveRequest(state) {
  const request = String(state.node.properties?.qg_fit_aspect ?? "");
  if (!/^\d+:\d+$/.test(request)) return null;
  if (!hasPicture(state)) return request;
  const canvas = currentCanvas(state);
  return aspectMatches(canvas.width, canvas.height, request) ? request : null;
}

// The row says Source: a picture nothing has been done to, with no ratio
// lit. There is no shape to hold then, so the padlock has nothing to do.
function sourceState(state) {
  return hasPicture(state) && !liveRequest(state) && isUntouched(values(state.node), sourceSize(state));
}

// After a gesture, a pick the canvas no longer has is dropped, so the next
// clip is not fitted to a shape you dragged away from. A lock left on a
// picture that is back to its own shape goes off with it: it would hold
// nothing, and a hidden mode waiting for the next drag is what surprised
// people.
function settleRequest(state) {
  const properties = state.node.properties;
  if (properties?.qg_fit_aspect && hasPicture(state) && !liveRequest(state)) delete properties.qg_fit_aspect;
  if (properties?.qg_aspect_lock && sourceState(state)) properties.qg_aspect_lock = false;
}

function lockOn(state) {
  return Boolean(state.node.properties?.qg_aspect_lock);
}

// The lock does something only while there is a shape to hold.
function lockActive(state) {
  return lockOn(state) && hasPicture(state) && !sourceState(state);
}

// Which way the chips read: the lit shape's own way, then the canvas's
// once you have changed it, then the way you last turned them.
function chipsPortrait(state) {
  const request = liveRequest(state);
  if (request) {
    const [width, height] = request.split(":").map(Number);
    if (width !== height) return height > width;
  }
  if (hasPicture(state) && !isUntouched(values(state.node), sourceSize(state))) {
    const canvas = currentCanvas(state);
    if (canvas.width !== canvas.height) return canvas.height > canvas.width;
  }
  return Boolean(state.node.properties?.qg_pad_portrait);
}

// Tap a ratio: pad (or crop) to it, or back to the whole picture when it is
// the lit one. The chip row, the editor's copy of it and its extra-ratio
// list all come through here.
function tapRatio(state, ratio) {
  const node = state.node;
  node.properties ??= {};
  if (!hasPicture(state)) {
    // No picture yet: the pick waits, and the first one is fitted to it.
    if (liveRequest(state) === ratio) delete node.properties.qg_fit_aspect;
    else node.properties.qg_fit_aspect = ratio;
    draw(state); notifyQgChange();
  } else if (liveRequest(state) === ratio) clearAspect(state);
  else fitAspect(state, ratio, aspectMode(state));
}

function buildAspectChipRow(state) {
  const node = state.node;
  const row = createElement("div", "qgtools-transform-aspects");
  const flip = createElement("button", "qgtools-transform-aspect qgtools-transform-aspect-flip");
  flip.type = "button";
  const glyph = createElement("span", "qgtools-transform-aspect-glyph");
  flip.append(glyph);
  row.append(flip);
  const caption = createElement("span", "qgtools-transform-aspect-caption", "Ratio");
  row.append(caption);
  const oriented = (aspect) => chipsPortrait(state) ? turnAspect(aspect) : aspect;
  flip.addEventListener("click", () => { turnCanvas(state); draw(state); });
  const chips = [];
  for (const aspect of ASPECT_CHIP_ORDER) {
    const chip = createElement("button", "qgtools-transform-aspect", aspect);
    chip.type = "button";
    chip.addEventListener("click", () => {
      node.properties ??= {};
      const ratio = oriented(aspect);
      node.properties.qg_pad_portrait = chipsPortrait(state);
      tapRatio(state, ratio);
      draw(state);
    });
    chips.push({ chip, aspect }); row.append(chip);
  }
  const hold = createElement("button", "qgtools-transform-aspect qgtools-transform-aspect-hold");
  hold.type = "button";
  hold.append(lockGlyph());
  hold.addEventListener("click", () => {
    // Nothing to hold on the untouched picture: the lock stays off.
    if (!lockOn(state) && hasPicture(state) && sourceState(state)) return;
    setAspectLock(state, !lockOn(state)); draw(state);
  });
  row.append(hold);
  const sync = () => {
    const request = liveRequest(state);
    const portrait = chipsPortrait(state);
    const picture = hasPicture(state);
    const canvas = picture ? currentCanvas(state) : null;
    const untouched = picture && isUntouched(values(node), sourceSize(state));
    const square = request ? turnAspect(request) === request : canvas ? canvas.width === canvas.height : false;
    const pad = aspectMode(state) === "pad";
    const held = lockActive(state);
    flip.title = request && !square
      ? zh("Turn {a} into {b}").replace("{a}", request).replace("{b}", turnAspect(request))
      : picture && !untouched && !square
        ? zh("Turn this shape on its side")
        : zh(portrait ? "Show the landscape ratios" : "Show the portrait ratios");
    flip.setAttribute("aria-label", flip.title);
    flip.setAttribute("aria-pressed", String(portrait));
    glyph.style.width = portrait ? "10px" : "16px";
    glyph.style.height = portrait ? "16px" : "10px";
    if (held) {
      caption.textContent = zh("Held");
      caption.title = zh("The padlock holds this shape ({n}) while you drag a handle.")
        .replace("{n}", request ?? ratioLabel(canvas.width, canvas.height));
    } else if (request || !picture) {
      caption.textContent = zh("Ratio");
      caption.title = zh("Tap a ratio to pad the picture to it (or crop it, with Fit on crop). Tap the lit one to go back to the whole picture.");
    } else {
      caption.textContent = zh(untouched ? "Source" : "Custom");
      caption.title = zh(untouched
          ? "The picture's own shape: {n}. Tap a ratio to use one."
          : "No ratio button has this shape: {n}. Tap a ratio to use one.")
        .replace("{n}", `${canvas.width}×${canvas.height} (${ratioLabel(canvas.width, canvas.height)})`);
    }
    caption.classList.toggle("custom", Boolean(picture && !request && !untouched && !held));
    caption.classList.toggle("held", held);
    for (const { chip, aspect } of chips) {
      const ratio = oriented(aspect);
      const lit = ratio === request;
      chip.textContent = ratio;
      chip.title = lit && !picture
        ? zh(pad
            ? "{a} is picked: the picture you choose is padded to it. Tap again to unpick it."
            : "{a} is picked: the picture you choose is cropped to it. Tap again to unpick it.")
          .replace("{a}", ratio)
        : lit
          ? zh(pad
              ? "Padded to {a}. Tap again to go back to the whole picture."
              : "Cropped to {a}. Tap again to go back to the whole picture.")
            .replace("{a}", ratio)
          : pad
            ? zh("Pad to {a}: keep every pixel and add fill around it.").replace("{a}", ratio)
            : zh("Crop to {a}: trim the picture to that shape.").replace("{a}", ratio);
      chip.classList.toggle("active", lit);
      chip.setAttribute("aria-pressed", String(lit));
    }
    const idle = picture && sourceState(state);
    hold.classList.toggle("on", held);
    hold.classList.toggle("idle", idle);
    hold.setAttribute("aria-pressed", String(held));
    hold.setAttribute("aria-disabled", String(idle));
    hold.title = held
      ? zh(request
          ? "Shape held at {a}: dragging a handle keeps this shape, and the padding on the other side follows, split evenly. Tap to drag freely."
          : "Shape held: dragging a handle keeps this shape, and the padding on the other side follows, split evenly. Tap to drag freely.")
        .replace("{a}", request ?? "")
      : idle
        ? zh("Nothing to hold yet: pick a ratio, or change the shape, then lock it here.")
        : zh("The diamonds and crop squares drag freely; the orange corners always keep the shape. Tap to hold this shape whatever you drag.");
    hold.setAttribute("aria-label", zh(held ? "Shape held" : "Hold the shape"));
  };
  sync();
  return { row, sync };
}

function aspectMode(state) {
  return state.node.properties?.qg_aspect_mode === "crop" ? "crop" : "pad";
}

// A two-part pill (off | on, crop | pad): the pack's one "on" look.
function segmentedPill(options, onPick, { className = "" } = {}) {
  const pill = createElement("div", `qgtools-transform-fit ${className}`.trim());
  const buttons = new Map();
  for (const [key, text, title] of options) {
    const button = createElement("button", "", text);
    button.type = "button";
    if (title) button.title = title;
    button.addEventListener("click", () => onPick(key));
    buttons.set(key, button); pill.append(button);
  }
  const set = (key) => {
    for (const [name, button] of buttons) {
      button.classList.toggle("on", name === key);
      button.setAttribute("aria-pressed", String(name === key));
    }
  };
  return { pill, set };
}

// Fit: how a ratio chip gets its shape. It only acts on a lit ratio, so it
// dims (and says so) until one is lit; picking a side still sets how the
// next ratio is reached. Divisible by sits at the end of the row on the
// node face.
function buildAspectModeRow(state, { alignment: withAlignment = true } = {}) {
  const row = createElement("div", "qgtools-transform-row qgtools-transform-aspect-modes");
  const fit = createElement("div", "qgtools-transform-fit-label");
  const { pill, set } = segmentedPill([
    ["crop", "crop", "Ratio buttons crop the picture to their shape."],
    ["pad", "pad", "Ratio buttons pad the picture to their shape and keep every pixel."],
  ], (mode) => {
    if (aspectMode(state) === mode) return;
    state.node.properties ??= {};
    // A lit ratio is reached again the new way; otherwise only the next
    // tap changes.
    const request = liveRequest(state);
    state.node.properties.qg_aspect_mode = mode;
    if (request && hasPicture(state)) fitAspect(state, request, mode);
    draw(state); notifyQgChange();
  });
  const hint = createElement("span", "qgtools-transform-fit-hint", "pick a ratio first");
  fit.append(createElement("span", "", "Fit"), pill, hint);
  row.append(fit);
  let multiple = null;
  if (withAlignment) {
    const alignment = createElement("label", "qgtools-transform-alignment");
    alignment.style.cssText = "display:flex;align-items:center;gap:5px;flex:0 0 auto";
    multiple = makeScrubInput({ value: value(state.node, "canvas_multiple", 1),
      min: 1, max: 4096, step: 8, fineStep: 1, decimals: 0, width: 72, unit: "px", snap: true,
      title: "Makes the width and height divide evenly by this number: padding grows by a few pixels, and a side with no padding is trimmed by a few instead. Some models need sizes divisible by 8, 16 or 32; 1 = off.",
      onChange: (amount) => { setValue(state.node, "canvas_multiple", amount); draw(state); updateModalInfo(state); },
      onSettle: notifyQgChange });
    alignment.append(createElement("span", "", "Divisible by"), multiple.root);
    row.append(alignment);
  }
  const sync = () => {
    multiple?.set(value(state.node, "canvas_multiple", 1));
    set(aspectMode(state));
    const idle = !liveRequest(state);
    pill.classList.toggle("idle", idle);
    hint.style.display = idle ? "" : "none";
    pill.title = idle
      ? zh("Pick a ratio first: Fit decides how a ratio button gets its shape (crop trims the picture, pad adds fill around it).")
      : zh("How the lit ratio gets its shape: crop trims the picture, pad adds fill around it and keeps every pixel.");
  };
  sync();
  return { row, sync };
}

// --- Centring the picture ----------------------------------------------------
// Two small buttons put the picture in the middle of the canvas, side to side
// and top to bottom. They only move padding from one side to the other
// (centredPadding), so the canvas keeps its size and a lit ratio stays lit.
// The node face and the editor's Padding section each get a pair.
const CENTRE_AXES = [
  ["x", "Center side to side", "left and right"],
  ["y", "Center top to bottom", "top and bottom"],
];

function centrePicture(state, axis) {
  if (!hasPicture(state)) return;
  const current = values(state.node);
  const pads = centredPadding(current, resolveCrop(current, sourceSize(state)), axis);
  if (!pads) return;
  for (const [name, next] of Object.entries(pads)) setValue(state.node, name, next);
  settleRequest(state); draw(state); updateModalInfo(state); notifyQgChange();
}

// What a centre button would do now, for its look and its tooltip.
function centreStatus(state, axis) {
  const [, action, sides] = CENTRE_AXES.find(([name]) => name === axis);
  // Composed at composition time (the zh plugin only whole-string-matches, and
  // never observes a title written after insertion), so every place it is
  // spliced into gets its own template.
  const plain = zh("{a}: moves padding so the {b} bands are even. The canvas keeps its size.")
    .replace("{a}", zh(action)).replace("{b}", zh(sides));
  if (!hasPicture(state)) return { ready: false, title: plain };
  const current = values(state.node);
  const crop = resolveCrop(current, sourceSize(state));
  if (centredPadding(current, crop, axis)) return { ready: true, title: plain };
  const bands = axisBands(current, crop, axis);
  if (!bands.near && !bands.far) return { ready: false, title: zh("No padding on the {a} to move. {b}").replace("{a}", zh(sides)).replace("{b}", plain) };
  if (Math.abs(bands.near - bands.far) <= 1) return { ready: false, title: zh("The picture is already in the middle. {a}").replace("{a}", plain) };
  return { ready: false, title: zh("As close to the middle as this padding allows: Divisible by adds its fill on one side. {a}").replace("{a}", plain) };
}

function buildCentreButtons(state) {
  const root = createElement("span", "qgtools-transform-centre");
  const buttons = CENTRE_AXES.map(([axis, action]) => {
    const button = createElement("button", "qgtools-transform-aspect qgtools-transform-centre-button");
    button.type = "button";
    button.setAttribute("aria-label", action);
    button.append(centreGlyph(axis));
    button.addEventListener("click", () => centrePicture(state, axis));
    root.append(button);
    return { axis, button };
  });
  const sync = () => {
    for (const { axis, button } of buttons) {
      const { ready, title } = centreStatus(state, axis);
      button.title = title;
      button.classList.toggle("idle", !ready);
      button.setAttribute("aria-disabled", String(!ready));
    }
  };
  sync();
  return { root, sync };
}

// Two arrows pushing a block into the middle: across for side to side, up
// and down for top to bottom.
function centreGlyph(axis) {
  const glyph = createElement("span", "qgtools-transform-centre-glyph");
  const turn = axis === "y" ? ' transform="rotate(90 8 8)"' : "";
  glyph.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><g${turn} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8h3.6M2.8 5.8 4.9 8l-2.1 2.2M15 8h-3.6M13.2 5.8 11.1 8l2.1 2.2"/><rect x="6.4" y="4.6" width="3.2" height="6.8" rx=".6" fill="currentColor" stroke="none"/></g></svg>`;
  return glyph;
}

// A padlock drawn by hand: shackle arc over a filled body.
function lockGlyph() {
  const glyph = createElement("span", "qgtools-transform-aspect-lock");
  glyph.innerHTML = '<svg width="9" height="11" viewBox="0 0 9 11" aria-hidden="true"><path d="M2.2 5V3.4a2.3 2.3 0 0 1 4.6 0V5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="4.8" width="7" height="5.4" rx="1.2" fill="currentColor"/></svg>';
  return glyph;
}

// --- Holding the shape -----------------------------------------------------
// With the padlock on (properties.qg_aspect_lock), a handle drag keeps
// the canvas at the ratio it had when you grabbed it: the lit chip's, or the
// canvas's own when no chip is lit. Padding drags and crop drags in pad
// mode re-solve the padding (lockPadding, transform_geometry.mjs) from the
// padding the drag started with, so new bands split evenly; crop drags in
// crop mode keep the crop box's own ratio. On the untouched picture there
// is no shape to hold and the lock does nothing.
function heldRatio(state) {
  if (!lockActive(state)) return null;
  const request = liveRequest(state);
  if (request) return parseAspectRatio(request, sourceSize(state));
  const canvas = currentCanvas(state);
  return canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : null;
}

function heldCropRatio(state) {
  if (!lockActive(state) || aspectMode(state) !== "crop") return null;
  const crop = resolveCrop(values(state.node), sourceSize(state));
  return crop.width / crop.height;
}

// `base` is the padding a gesture started with: solving from it every move,
// instead of from the last move's result, keeps the split even.
function applyLock(state, ratio, driver = "x", base = null) {
  if (!ratio || !hasPicture(state)) return false;
  const current = { ...values(state.node), ...(base ?? {}) };
  const pads = lockPadding(current, resolveCrop(current, sourceSize(state)), ratio, driver);
  if (!pads) return false;
  for (const [name, next] of Object.entries(pads)) setValue(state.node, name, next);
  return true;
}

// The crop as the plain box it resolves to, for a crop that should drag
// freely: a chip crop leaves one side open for the backend to fill in.
function explicitCrop(current, source) {
  const crop = resolveCrop(current, source);
  return { crop_aspect_ratio: "free", crop_x: crop.x, crop_y: crop.y, crop_width: crop.width, crop_height: crop.height };
}

function setAspectLock(state, on) {
  state.node.properties ??= {};
  state.node.properties.qg_aspect_lock = Boolean(on);
  // In crop mode a lit ratio goes onto the crop itself, so the run keeps it
  // too; unlocked, the crop is a plain box again.
  if (aspectMode(state) === "crop" && hasPicture(state)) {
    const request = liveRequest(state);
    if (on && request) setValue(state.node, "crop_aspect_ratio", request);
    else if (!on) for (const [name, next] of Object.entries(explicitCrop(values(state.node), sourceSize(state)))) setValue(state.node, name, next);
  }
  draw(state); updateModalInfo(state); notifyQgChange();
}

// Tapping the lit ratio: back to the whole picture, and the lock goes off
// with the shape it was holding.
function clearAspect(state) {
  state.node.properties ??= {};
  state.node.properties.qg_aspect_lock = false;
  fitAspect(state, "free", aspectMode(state));
  delete state.node.properties.qg_fit_aspect;
  draw(state); updateModalInfo(state); notifyQgChange();
}

// Reset crop: the whole picture again. Rotation and padding stay, except
// that with the padlock on, the bands it added while the crop was trimmed
// go too - the canvas holds its shape around the whole picture in the
// smallest size that does, instead of growing taller than the picture.
function resetCropKeepingShape(state) {
  const node = state.node;
  const ratio = hasPicture(state) ? heldRatio(state) : null;
  const request = liveRequest(state);
  setValue(node, "crop_aspect_ratio", "free");
  fitCrop(state);
  if (ratio && hasPicture(state)) {
    if (request && aspectMode(state) === "crop") {
      fitAspect(state, request, "crop");
    } else {
      const current = values(node);
      const pads = tightLockPadding(current, resolveCrop(current, sourceSize(state)), ratio);
      if (pads) for (const [name, next] of Object.entries(pads)) setValue(node, name, next);
    }
  }
  settleRequest(state); draw(state); updateModalInfo(state); notifyQgChange();
}

// The orientation button: the lit or custom shape turned on its side. Pad
// mode pads the current crop to the turned ratio, centred; crop mode turns
// the crop box about its own centre, shrinking it evenly if it would leave
// the picture. The pixels never rotate. With nothing to turn (no picture
// yet, the untouched picture, a square) only the chips turn, so the next
// tap goes that way; a pick made before a picture arrived turns with them.
function turnCanvas(state) {
  const node = state.node;
  node.properties ??= {};
  const portrait = chipsPortrait(state);
  const request = liveRequest(state);
  node.properties.qg_pad_portrait = !portrait;
  if (!hasPicture(state)) {
    if (request) node.properties.qg_fit_aspect = turnAspect(request);
    draw(state); notifyQgChange();
    return;
  }
  const source = sourceSize(state);
  const current = values(node);
  const canvas = currentCanvas(state);
  if ((!request && isUntouched(current, source)) || canvas.width === canvas.height) {
    draw(state); notifyQgChange();
    return;
  }
  const crop = resolveCrop(current, source);
  if (aspectMode(state) === "crop") {
    const box = turnedCrop(crop, source);
    const turned = request ? turnAspect(request) : null;
    const keep = lockActive(state) && turned ? turned : "free";
    setValue(node, "crop_aspect_ratio", keep);
    setCrop(node, box);
    if (turned) node.properties.qg_fit_aspect = turned;
  } else {
    const ratio = request ? parseAspectRatio(turnAspect(request), source) : canvas.height / canvas.width;
    for (const [name, next] of Object.entries(padAround(crop, ratio))) setValue(node, name, next);
    if (request) node.properties.qg_fit_aspect = turnAspect(request);
  }
  settleRequest(state);
  resetView(state); draw(state); updateModalInfo(state); notifyQgChange();
}

// Which axis a crop drag drove, for the lock: the one that changed more,
// the handle's own axis on a tie.
function cropDriver(before, after, handle) {
  const dx = Math.abs(after.width - before.width);
  const dy = Math.abs(after.height - before.height);
  if (dx !== dy) return dx > dy ? "x" : "y";
  return /[ns]/.test(handle) && !/[ew]/.test(handle) ? "y" : "x";
}

// The video nodes' canvas row under the format chips: fill swatch, feather
// amount and the resize budget - the three values a video outpaint model
// keys on (LTX's IC-LoRA wants pure black, a hard edge and 32-px sizes),
// editable on the face and mirrored from the hidden widgets on every draw.
function buildCanvasRow(state) {
  const node = state.node;
  const video = state.kind === "video";
  const row = createElement("div", "qgtools-transform-row qgtools-transform-canvas-row");
  const fillLabel = createElement("label");
  const fill = createElement("input"); fill.type = "color"; fill.className = "qgtools-transform-swatch";
  // Kept as the English source string: sync() rebuilds the title from it every
  // draw (append " Now #rrggbb."), so the pieces have to stay separable - and
  // a title reassigned after insertion is never seen by the zh plugin.
  const fillBase = video
    ? "Fill colour of the padding and rotation corners. Video outpaint models key on it: the LTX IC-LoRA paints pure black (#000000) and leaves other colours alone."
    : "Fill colour of the padding and rotation corners.";
  fill.title = fillBase;
  fill.addEventListener("input", () => { setValue(node, "fill_color", fill.value); draw(state); });
  fill.addEventListener("change", () => notifyQgChange());
  fillLabel.append(createElement("span", "", "Fill"), fill);
  const featherLabel = createElement("label");
  const feather = makeScrubInput({ value: value(node, "feather", 0), min: 0, max: 4096, step: 1, decimals: 0, width: 62, unit: "px",
    title: video
      ? "Feather of the mask into the kept frames, in pixels. The frames keep a hard edge against the fill whatever the feather, so a black-band outpaint still sees its bars."
      : "Feather of the mask into the kept pixels; the image keeps a hard edge against the fill.",
    onChange: (amount) => { setValue(node, "feather", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  featherLabel.append(createElement("span", "", "Feather"), feather.root);
  const resizeLabel = createElement("label");
  const resize = resizeSwitch(state);
  resizeLabel.title = "Resize the output to a megapixel budget, each side rounded to the step (32 for LTX and Wan). The budget and step open in a row below.";
  resizeLabel.append(createElement("span", "", "Resize"), resize.pill);
  row.append(fillLabel, featherLabel);
  // The resize budget and its step share a row that only shows while
  // Resize is on: the step decides the final size as much as the budget
  // (LTX wants 32), so it belongs on the face, not only in the editor.
  const resizeRow = createElement("div", "qgtools-transform-row qgtools-transform-canvas-row qgtools-transform-resize-row");
  const budgetLabel = createElement("label");
  const budget = makeScrubInput({ value: value(node, "megapixels", 1), min: 0.01, max: 16, step: 0.05, fineStep: 0.01, decimals: 2, width: 72, unit: "MP",
    title: "Output budget in megapixels (x 1024x1024). The size readout under the picture shows where it lands.",
    onChange: (amount) => { setValue(node, "megapixels", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  budgetLabel.append(createElement("span", "", "Megapixels"), budget.root);
  const stepLabel = createElement("label");
  const steps = makeScrubInput({ value: value(node, "resolution_steps", 1), min: 1, max: 256, step: 8, fineStep: 1, decimals: 0, width: 66, unit: "px", snap: true,
    title: "Rounds each resized side to a multiple of this (32 for LTX and Wan, 8 or 64 for image models). Each side rounds on its own, so a large step can stretch the picture slightly; the readout warns above 1%.",
    onChange: (amount) => { setValue(node, "resolution_steps", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  stepLabel.append(createElement("span", "", "Step"), steps.root);
  resizeRow.append(budgetLabel, stepLabel);
  const hasResize = Boolean(widget(node, "resize_to_megapixels"));
  if (hasResize) row.append(resizeLabel);
  // The centre pair ends the row, and drops under it on a narrow node. A
  // span, not a label: a label passes a click on its text to the first button.
  const centre = buildCentreButtons(state);
  const centreLabel = createElement("span", "qgtools-transform-centre-label");
  centreLabel.append(createElement("span", "", "Center"), centre.root);
  row.append(centreLabel);
  const sync = () => {
    fill.value = normalizeColor(value(node, "fill_color", "#808080"));
    fill.title = zh("{a} Now {b}.").replace("{a}", zh(fillBase)).replace("{b}", fill.value);
    feather.set(value(node, "feather", 0));
    centre.sync();
    resize.sync();
    budget.set(value(node, "megapixels", 1));
    steps.set(value(node, "resolution_steps", 1));
    resizeRow.style.display = hasResize && value(node, "resize_to_megapixels", false) ? "" : "none";
  };
  sync();
  state.syncCanvasRow = sync;
  chainCallback(node, "onConfigure", () => queueMicrotask(sync));
  for (const element of [row, resizeRow]) {
    element.addEventListener("pointerdown", (event) => { if (event.target.closest("input,label,button")) event.stopPropagation(); });
  }
  return [row, resizeRow];
}

// Resize as an off | on pill, on the node face and in the editor.
function resizeSwitch(state) {
  const node = state.node;
  const { pill, set } = segmentedPill([
    ["off", "off", "Keep the canvas size."],
    ["on", "on", "Resize the output to the megapixel budget, each side rounded to the step."],
  ], (key) => {
    const on = key === "on";
    if (Boolean(value(node, "resize_to_megapixels", false)) === on) return;
    setValue(node, "resize_to_megapixels", on);
    draw(state); updateModalInfo(state); notifyQgChange();
  }, { className: "qgtools-transform-switch" });
  const sync = () => set(value(node, "resize_to_megapixels", false) ? "on" : "off");
  sync();
  return { pill, sync };
}

// The size chain in words under the stage: every step that sets the output
// size, the one the run emits last and brightest, and an amber line when the
// steps stretch the picture or the resize undoes Align. Its tooltip spells
// the whole chain out. A DOM line rather than canvas text, so it wraps on a
// narrow node and never covers the picture being judged.
function syncReadout(state) {
  const readout = state.readout;
  if (!readout) return;
  if (!state.image || !state.sourceWidth || !state.sourceHeight) { readout.replaceChildren(); state.readoutKey = ""; readout.title = ""; return; }
  const current = values(state.node);
  const source = rotatedSize(state.sourceWidth, state.sourceHeight, current.rotation_degrees);
  const { tokens, warnings } = litTokens(state, sizeChainTokens(sizeChain(current, source, resizeRequest(state.node))));
  const parts = [];
  tokens.forEach((token, index) => {
    if (index) parts.push(" → ");
    if (token.label) parts.push(createElement("span", "", `${token.label} `));
    parts.push(index === tokens.length - 1 ? createElement("b", "", token.text) : token.text);
  });
  // No chip names this shape: say what it is (the chip row says Custom).
  if (!liveRequest(state) && !isUntouched(current, source)) {
    const canvas = canvasSize(current, source);
    parts.push(createElement("span", "", ` · ${ratioLabel(canvas.width, canvas.height)}`));
  }
  // A lit ratio that had nothing to do says so, on the same line when it
  // fits, so the node does not grow for it.
  const note = ratioNote(state);
  if (note) {
    parts.push(createElement("span", "", " · "));
    parts.push(createElement("em", "note", note.text));
  }
  if (warnings.length) {
    const line = createElement("i", "", `⚠ ${warnings.join(" · ")}`);
    const fix = stretchFix(state);
    line.title = fix.tip;
    if (fix.pads) {
      const even = createElement("button", "", "Even out");
      even.type = "button";
      even.title = "Add a few pixels of padding so the rounding stretches nothing.";
      even.addEventListener("click", () => {
        for (const [name, next] of Object.entries(fix.pads)) setValue(state.node, name, next);
        settleRequest(state); draw(state); updateModalInfo(state); notifyQgChange();
      });
      line.append(even);
    }
    parts.push(line);
  }
  // Rebuilt only when it says something new, so a redraw between the press
  // and the click on Even out never swaps the button out from under it.
  const key = parts.map((part) => (typeof part === "string" ? part : part.outerHTML)).join("");
  if (key !== state.readoutKey) {
    state.readoutKey = key;
    readout.replaceChildren(...parts);
  }
  readout.title = [note?.tip, ...sizeLines(state)].filter(Boolean).join("\n");
}

// A lit ratio re-applies to every new picture, so the size chain names it
// where it acted: "pad to 16:9 1821×1024" (or "crop to 16:9" with Fit on
// crop).
function litTokens(state, chain) {
  const request = liveRequest(state);
  if (!request || !hasPicture(state)) return chain;
  const step = aspectMode(state) === "pad" ? "pad" : "crop";
  const tokens = chain.tokens.map((token) => (token.label === step ? { ...token, label: `${step} to ${request}` } : token));
  return { ...chain, tokens };
}

// The line under the size chain when the lit ratio had nothing to do: the
// picture already has that shape, and a render would paint nothing new.
function ratioNote(state) {
  const request = liveRequest(state);
  if (!request || !hasPicture(state)) return null;
  const pad = aspectMode(state) === "pad";
  if (!isUntouched(values(state.node), sourceSize(state))) return null;
  return { warn: true,
    text: zh("already {a}: pick another ratio or turn it").replace("{a}", request),
    tip: zh(pad
        ? "The picture is already {a}, so there is nothing to add and a render would paint nothing new. Pick another ratio, or turn this one with the button at the start of the row."
        : "The picture is already {a}, so there is nothing to trim and a render would paint nothing new. Pick another ratio, or turn this one with the button at the start of the row.")
      .replace("{a}", request) };
}

// What to do about the resize stretching the picture: the step that would
// not, and in pad mode the padding that takes the rounding instead.
function stretchFix(state) {
  const current = values(state.node);
  const source = sourceSize(state);
  const resize = resizeRequest(state.node);
  const chain = sizeChain(current, source, resize);
  const amount = (Math.abs(chain.stretch) * 100).toFixed(1);
  const step = stepWithoutStretch(current, source, resize);
  const pads = aspectMode(state) === "pad" ? evenOutPadding(current, source, resize) : null;
  const tip = [
    zh(chain.stretch > 0
        ? "The resize rounds the width and the height to a multiple of the Step ({a} px) separately, so the picture comes out {b}% wider than it is."
        : "The resize rounds the width and the height to a multiple of the Step ({a} px) separately, so the picture comes out {b}% taller than it is.")
      .replace("{a}", String(resize?.steps ?? 1)).replace("{b}", amount),
    step ? zh("Step {a} keeps it under 1%.").replace("{a}", String(step)) : "",
    pads ? zh("Or press Even out: it adds a few pixels of padding so the rounding stretches nothing.") : "",
  ].filter(Boolean).join(" ");
  return { tip, pads };
}

async function onSourceChanged(state, reset) {
  const key = sourceKey(state.node, state.kind);
  const changed = reset && sourceChanged(state.source, key, state.ready);
  // The pick the old picture still had (or the one waiting for a first
  // picture) is fitted to the new one; a shape dragged away from is not.
  if (changed) state.refitTo = liveRequest(state);
  if (changed) {
    // Geometry measured against the old pixels goes; fill, feather, the
    // resize budget and the lit format chip stay - swapping the clip in an
    // outpaint workflow used to reset the fill to grey and the feather to
    // 24, which is exactly what the model cannot work with.
    for (const [name, next] of Object.entries(sourceResetValues(state.kind === "video"))) setValue(state.node, name, next);
    if (state.isClip) { setValue(state.node, "start_seconds", 0); setValue(state.node, "end_seconds", 0); }
    resetView(state);
  }
  state.source = rememberedSource(state.source, key, reset);
  await loadSource(state);
  if (changed && state.image) { refitAspect(state); fitStageToPicture(state); }
}

// A new picture gets a picture area of its own shape: a wide photo swapped
// into a node sized for a tall one no longer sits small in a tall empty
// box. It only ever shrinks the node, and never under the stage's floor,
// so nodes below are never covered; a taller picture keeps the height you
// gave the node.
function fitStageToPicture(state) {
  const stage = state.previewCanvas;
  const node = state.node;
  if (state.disposed || !stage?.isConnected || !node.size || !hasPicture(state)) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!(width > 0) || !(height > 0)) return;
  const current = values(node);
  const source = sourceSize(state);
  const crop = resolveCrop(current, source);
  const padding = resolvePadding(current, crop);
  const kept = keptCrop(crop, padding);
  const unionWidth = Math.max(source.width, kept.x - padding.left + padding.outputWidth) - Math.min(0, kept.x - padding.left);
  const unionHeight = Math.max(source.height, kept.y - padding.top + padding.outputHeight) - Math.min(0, kept.y - padding.top);
  const margin = stageHandleLayout(width, height).margin;
  const ideal = Math.round((width - margin * 2) * unionHeight / Math.max(1, unionWidth) + margin * 2);
  const target = Math.max(ideal, stageHeightForWidth(width));
  if (target > height - 6) return;
  node.setSize?.([node.size[0], node.size[1] + (target - height)]);
  node.setDirtyCanvas?.(true, true);
}

// A lit chip is a standing request: the new source gets padded (or
// cropped) to it as well, so the canvas keeps its format across clips.
function refitAspect(state) {
  const aspect = state.refitTo;
  state.refitTo = null;
  if (aspect) fitAspect(state, aspect, aspectMode(state));
  else if (state.node.properties) delete state.node.properties.qg_fit_aspect;
  // A new picture with no ratio lit is back to Source: a lock left from the
  // old one would hold nothing.
  settleRequest(state);
}

async function loadSource(state) {
  const serial = ++state.loadSerial;
  try {
    if (state.kind === "image") {
      const selection = value(state.node, "image", "");
      if (!selection) {
        state.image = null; state.sourceWidth = state.sourceHeight = 0;
        drawEmpty(state, "Choose a source to begin"); return;
      }
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = () => reject(new Error("Could not load image preview."));
        image.src = imageSourceUrl(selection);
      });
      if (serial !== state.loadSerial || state.disposed) return;
      state.image = image; state.sourceWidth = image.naturalWidth; state.sourceHeight = image.naturalHeight;
      // Core's image-upload helper also installs a source preview. This node has
      // its own transformed preview, so keep only the useful one.
      suppressCoreImagePreview(state.node);
      state.node.imageIndex = null;
    } else {
      const key = sourceKey(state.node, "video");
      if (!key) { state.image = null; state.metadata = null; state.metadataKey = null; drawEmpty(state, "Choose a source to begin"); return; }
      if (state.metadataKey !== key) {
        const metaResponse = await api.fetchApi(`/qg/transform/video/metadata?${videoParams(state.node)}`);
        const metadata = await metaResponse.json();
        if (!metaResponse.ok) throw new Error(metadata.error || "Could not read video metadata.");
        if (serial !== state.loadSerial) return;
        state.metadata = metadata; state.metadataKey = key;
        state.sourceWidth = metadata.width; state.sourceHeight = metadata.height;
        state.storyboard = null; state.scrubPreviewTile = null; state.imageIndex = null; state.imageTime = null;
        syncTimelineRange(state);
        requestStoryboard(state, key);
      }
      await loadVideoFrame(state, serial);
    }
    draw(state); updateModalInfo(state);
  } catch (error) {
    if (serial !== state.loadSerial || state.disposed) return;
    if (error?.name === "AbortError") return;
    state.image = null;
    drawEmpty(state, error.message);
  }
}

function syncTimelineRange(state) {
  for (const trim of state.trimViews) trim.sync();
  if (!state.timelineLabel) return;
  const info = clipInfo(state.metadata);
  state.timelineLabel.textContent = `${clampFrame(value(state.node, "frame_index", 0), info)} / ${Math.max(0, info.count - 1)}`;
}

// Storyboard: a keyframe thumbnail strip the server builds once per file in
// the background. While it exists, dragging shows the nearest tile with zero
// network latency and the exact decoded frame replaces it a beat later.
// Best-effort — scrubbing works without it, just without the instant ghost.
async function requestStoryboard(state, key, attempt = 0) {
  if (state.disposed || state.kind !== "video") return;
  try {
    const response = await api.fetchApi(`/qg/transform/video/storyboard?${videoParams(state.node)}`);
    const payload = await response.json();
    if (!response.ok || state.disposed || sourceKey(state.node, "video") !== key) return;
    if (payload.status === "building") {
      if (attempt < 40) setTimeout(() => requestStoryboard(state, key, attempt + 1), 1200);
      return;
    }
    if (payload.status !== "ready") return;
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = payload.sprite; });
    if (state.disposed || sourceKey(state.node, "video") !== key) return;
    state.storyboard = {
      image, times: payload.times, count: payload.count,
      tileWidth: payload.tile_width, tileHeight: payload.tile_height,
    };
  } catch { /* storyboard is an enhancement, never an error */ }
}

function showScrubGhost(state, frameIndex) {
  const storyboard = state.storyboard;
  if (!storyboard) return;
  const info = clipInfo(state.metadata);
  const moment = frameTime(frameIndex, info);
  let tile = 0;
  for (let index = 0; index < storyboard.times.length; index += 1) {
    if (Math.abs(storyboard.times[index] - moment) < Math.abs(storyboard.times[tile] - moment)) tile = index;
  }
  // The tile stands in only while it is nearer the target than the frame
  // already on the stage. A keyframe seconds away is worse than a slightly
  // stale picture, and swapping between the two on every pointer move was
  // the flicker: with one keyframe per clip the ghost was always frame 0.
  const tileGap = Math.abs(storyboard.times[tile] - moment);
  const imageGap = Number.isFinite(state.imageTime) ? Math.abs(state.imageTime - moment) : Infinity;
  const next = tileGap + 0.5 / Math.max(1, info.fps || 30) < imageGap ? tile : null;
  if (next === state.scrubPreviewTile) return;
  state.scrubPreviewTile = next;
  draw(state);
}

// Frame-only refresh for discrete jumps (step buttons, drag release):
// full-resolution fetch that also snaps the widgets to the decoded frame.
async function seekFrame(state) {
  try {
    await loadVideoFrame(state);
    draw(state); updateModalInfo(state);
  } catch (error) {
    if (error?.name === "AbortError") return;
    drawEmpty(state, error.message);
  }
}

// Live scrubbing pump. Video players feel responsive because they always
// render *something* for the newest position instead of waiting for quiet.
// This keeps exactly one request in flight, fires the first one immediately
// (no debounce delay), and when a response lands it re-reads the widgets so
// the next fetch always targets the latest slider position — intermediate
// positions are skipped, never queued. Scrub frames are fetched at reduced
// size for fast decode+encode; the drag-release handler does one full-size
// fetch at the end.
const SCRUB_PREVIEW_SIZE = 640;

function requestScrubFrame(state) {
  state.scrubPending = true;
  if (state.scrubActive) return;
  state.scrubActive = true;
  (async () => {
    while (state.scrubPending && !state.disposed) {
      state.scrubPending = false;
      try {
        await loadVideoFrame(state, ++state.loadSerial, { maxSize: SCRUB_PREVIEW_SIZE, syncWidgets: false });
        draw(state); updateModalInfo(state);
      } catch (error) {
        if (error?.name !== "AbortError") { drawEmpty(state, error.message); break; }
      }
    }
    state.scrubActive = false;
  })();
}

async function loadVideoFrame(state, serial = ++state.loadSerial, options = {}) {
  const { maxSize = 1600, syncWidgets = true } = options;
  state.frameController?.abort();
  const controller = new AbortController();
  state.frameController = controller;
  const response = await api.fetchApi(`/qg/transform/video/frame?${videoParams(state.node, maxSize)}`, { signal: controller.signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not decode video preview frame.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve; image.onerror = () => reject(new Error("Could not display video frame.")); image.src = objectUrl;
    });
    if (serial !== state.loadSerial) return;
    if (state.frameObjectUrl) URL.revokeObjectURL(state.frameObjectUrl);
    state.frameObjectUrl = objectUrl; state.image = image;
    state.scrubPreviewTile = null; // real frame arrived; drop the ghost tile
    const actualIndex = Number(response.headers.get("X-QG-Frame-Index"));
    const actualTime = Number(response.headers.get("X-QG-Frame-Time"));
    // Where the picture on the stage comes from: the ghost rule compares
    // storyboard tiles against it.
    state.imageIndex = Number.isFinite(actualIndex) ? actualIndex : null;
    state.imageTime = Number.isFinite(actualTime) ? actualTime : null;
    // Writing the decoded position back is only safe when the user is not
    // mid-scrub: a stale response overwriting frame_index would rubber-band
    // the playhead to an older frame.
    if (syncWidgets) {
      if (Number.isFinite(actualIndex)) setValue(state.node, "frame_index", actualIndex);
      if (Number.isFinite(actualTime)) setValue(state.node, "frame_time", actualTime);
      syncTimelineRange(state);
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function openEditor(state) {
  if (state.modal) return;
  const modal = createElement("div", "qgtools-transform-modal");
  const header = createElement("div", "qgtools-transform-header");
  header.append(createElement("strong", "", `${state.kind === "video" ? "Video" : "Image"} Crop + Rotate + Pad`), createElement("span", "qgtools-transform-badge", "QG-tools"));
  header.append(createElement("span", "spacer"));
  const cancel = createElement("button", "", "Cancel");
  cancel.title = "Close without saving: puts back everything as it was when the editor opened (Esc)";
  const close = createElement("button", "qgtools-transform-close", "Save & close"); header.append(cancel, close);
  const body = createElement("div", "qgtools-transform-body");
  const left = createElement("aside", "qgtools-transform-sidebar");
  const stage = createElement("main", "qgtools-transform-stage");
  const canvas = createElement("canvas", "qgtools-transform-canvas"); stage.append(canvas);
  const right = createElement("aside", "qgtools-transform-sidebar right");
  body.append(left, stage, right); modal.append(header, body);
  state.modal = modal; state.canvas = canvas; state.openSnapshot = editorSnapshot(state.node);
  buildControls(state, left);
  const status = createElement("div", "qgtools-transform-status"); status.dataset.qgStatus = ""; right.append(status);
  right.append(createElement("div", "qgtools-transform-help", "Drag cyan squares to crop. Drag inside the crop to move it. Orange diamonds add padding on one side. Orange corners make the canvas bigger or smaller and keep its shape; hold Alt (Option on a Mac) to change all four sides at once. The green knob near the top-right corner rotates; hold Shift to snap to 15 degrees. Wheel zooms. Middle mouse or Alt-drag on an empty spot pans."));
  if (widget(state.node, "stitch_blend")) right.append(buildStitchSection(state));
  if (state.kind === "video") modal.append(buildTimeline(state));
  document.body.append(modal);

  const abort = new AbortController(); state.modalAbort = abort;
  close.addEventListener("click", () => closeEditor(state), { signal: abort.signal });
  cancel.addEventListener("click", () => void cancelEditor(state), { signal: abort.signal });
  attachStageHandlers(state, canvas, abort.signal);
  canvas.addEventListener("wheel", (event) => wheelZoom(state, event), { signal: abort.signal, passive: false });
  window.addEventListener("keydown", (event) => keyDown(state, event), { signal: abort.signal });
  window.addEventListener("keyup", (event) => keyUp(state, event), { signal: abort.signal });
  state.resizeObserver = new ResizeObserver(() => draw(state)); state.resizeObserver.observe(stage);
  requestAnimationFrame(() => { resetView(state); draw(state); updateModalInfo(state); });
}

function closeEditor(state) {
  const hadModal = Boolean(state.modal);
  stopPlayback(state);
  state.drag?.keys?.abort();
  state.scrubPending = false;
  state.modalAbort?.abort(); state.resizeObserver?.disconnect(); state.modal?.remove();
  if (state.modalTrim) state.trimViews.delete(state.modalTrim);
  state.modalTrim = null; state.timelineLabel = null;
  state.modal = null; state.openSnapshot = null; state.canvas = null; state.finalPreviewCanvas = null; state.drag = null; state.grid = false; state.syncEditorControls = null; state.syncStitchControls = null; state.blendOverlay = null; state.editorSyncs = [];
  draw(state); state.node.setDirtyCanvas?.(true, true);
  // Sidebar and timeline controls write widgets without a canvas drag, so a
  // closing editor is their commit point. The disposal path (node removed,
  // possibly mid-load teardown) must never trigger a capture.
  if (hadModal && !state.disposed) notifyQgChange();
}

// Cancel is the editor's undo-everything: the controls write the node's
// widgets live, so the snapshot taken at open is what a cancel puts back.
// Properties carry the aspect lock and pad/crop mode; the preview DOM widget
// is display only.
function editorSnapshot(node) {
  const widgets = {};
  for (const item of node.widgets ?? []) {
    if (!item.name || item.name === "qg_transform_preview") continue;
    const current = item.value;
    if (current === null || ["string", "number", "boolean"].includes(typeof current)) widgets[item.name] = current;
  }
  const properties = {};
  for (const [key, current] of Object.entries(node.properties ?? {})) {
    if (key.startsWith("qg_")) properties[key] = JSON.stringify(current);
  }
  return { widgets, properties };
}

// The clip node's playhead never reaches its output, so looking around the
// clip alone is not an edit worth a prompt. A discard still puts it back.
const CLIP_PLAYHEAD_WIDGETS = new Set(["seek_mode", "frame_index", "frame_time"]);

function editorChanged(state) {
  const before = state.openSnapshot; if (!before) return false;
  const now = editorSnapshot(state.node);
  const keys = (a, b) => new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of keys(before.widgets, now.widgets)) {
    if (state.isClip && CLIP_PLAYHEAD_WIDGETS.has(name)) continue;
    if (!Object.is(before.widgets[name], now.widgets[name])) return true;
  }
  for (const key of keys(before.properties, now.properties)) if (before.properties[key] !== now.properties[key]) return true;
  return false;
}

function restoreSnapshot(state, snapshot) {
  const node = state.node;
  node.properties ??= {};
  for (const key of Object.keys(node.properties)) {
    if (key.startsWith("qg_") && !(key in snapshot.properties)) delete node.properties[key];
  }
  for (const [key, text] of Object.entries(snapshot.properties)) node.properties[key] = JSON.parse(text);
  // Only changed widgets go back, through their callbacks, so a source that
  // never changed is not reloaded.
  for (const [name, previous] of Object.entries(snapshot.widgets)) {
    if (!Object.is(value(node, name, undefined), previous)) setValue(node, name, previous);
  }
}

async function cancelEditor(state) {
  if (!state.modal || state.discardPending) return;
  if (editorChanged(state)) {
    state.discardPending = true;
    stopPlayback(state);
    const discard = await confirmDiscard();
    state.discardPending = false;
    if (!discard || !state.modal) return;
    restoreSnapshot(state, state.openSnapshot);
  }
  closeEditor(state);
}

// Inpaint & Stitch (clip and image nodes): the stitcher this node emits pastes
// the source back over the generated result. Blend is the ramp where generated
// pixels take over; it is deliberately separate from the padding feather,
// which shapes the mask the model sees. Grow moves the paste boundary and
// sits behind a disclosure - most outpaints never touch it.
function buildStitchSection(state) {
  const node = state.node;
  const section = createElement("section", "qgtools-transform-section");
  section.append(sectionHeading("Inpaint & Stitch"));
  section.append(createElement("div", "qgtools-transform-help", "Outside the paste mask the stitcher puts the source back bit-for-bit. Inside it - the padded and rotated-in area plus the blend ramp - the generation takes over."));
  const blend = makeScrubInput({ value: value(node, "stitch_blend", 32), min: 0, max: 512, step: 1, decimals: 0,
    title: "Ramp where generated pixels fade over the source, in pixels of the output. Separate from the padding feather.",
    onChange: (amount) => { setValue(node, "stitch_blend", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  addLabeledControl(section, "Blend", blend.root, "px");
  const show = segmentedPill([["off", "off"], ["on", "on"]], (key) => { state.showBlend = key === "on"; show.set(key); draw(state); }, { className: "qgtools-transform-switch" });
  show.set(state.showBlend ? "on" : "off");
  show.pill.title = "Tint the paste mask the stitcher will use - the same mask math as the backend, at preview resolution.";
  // nosuffix: let the pill span the control column, matching the Blend field
  // above and the Painted area pill below (user request 2026-10-13).
  addLabeledControl(section, "Show blend", show.pill).classList.add("qgtools-transform-nosuffix");
  // Image node only: a part painted in the MaskEditor is filled like the
  // padding, or the picture stays under it and only the mask marks it.
  let painted = null;
  if (widget(node, "painted_area")) {
    painted = segmentedPill([
      ["fill", "fill", "The painted part is handed on as flat fill. The model never sees what was there."],
      ["keep picture", "keep", "Your picture stays under the paint and only the mask marks it. For a step that needs what was there, like a denoise under 1."],
    ], (key) => {
      if (value(node, "painted_area", "fill") === key) return;
      setValue(node, "painted_area", key); painted.set(key);
      draw(state); updateModalInfo(state); notifyQgChange();
    }, { className: "qgtools-transform-switch" });
    painted.set(value(node, "painted_area", "fill"));
    // nosuffix: the localized pill labels (填充 | 保留) need the full control
    // column to sit on one line (user request 2026-10-13).
    addLabeledControl(section, "Painted area", painted.pill).classList.add("qgtools-transform-nosuffix");
  }
  const advanced = createElement("details"); advanced.append(createElement("summary", "", "Advanced"));
  const grow = makeScrubInput({ value: value(node, "stitch_grow", 0), min: -256, max: 256, step: 1, decimals: 0,
    title: "Moves the paste boundary before the ramp. Positive lets the generation replace a strip of the source next to the seam; negative keeps more source.",
    onChange: (amount) => { setValue(node, "stitch_grow", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  addLabeledControl(advanced, "Grow paste", grow.root, "px");
  advanced.append(createElement("div", "qgtools-transform-help", "Use a few pixels of grow when a seam still shows: the generation then repaints the source edge too."));
  section.append(advanced);
  state.syncStitchControls = () => { blend.set(value(node, "stitch_blend", 32)); grow.set(value(node, "stitch_grow", 0)); painted?.set(value(node, "painted_area", "fill")); };
  return section;
}

// Show blend: the stitcher's paste mask, computed the way the backend
// computes it, at preview resolution. The generated-area mask (padding and
// rotation voids, everything the rotated source does not cover inside the
// crop) is rasterised on the pre-resize canvas, feathered like the
// transform, then grown and blurred by the stitch settings converted from
// output pixels through any resize - the same steps as
// stitch_blend_from_mask, mirrored in stitch_preview.mjs and tested against
// the Python helper. Cached on its inputs: a drag that changes geometry
// rebuilds it, a pan or zoom does not.
function blendOverlayCanvas(state, render) {
  const node = state.node;
  const { source, kept: crop, padding } = render;
  const rotation = Number(value(node, "rotation_degrees", 0)) || 0;
  const feather = Math.max(0, Number(value(node, "feather", 0)) || 0);
  const blend = Math.max(0, Number(value(node, "stitch_blend", 32)) || 0);
  const grow = Number(value(node, "stitch_grow", 0)) || 0;
  const resize = value(node, "resize_to_megapixels", false)
    ? scaleToMegapixels(padding.outputWidth, padding.outputHeight, value(node, "megapixels", 1), value(node, "resolution_steps", 1))
    : null;
  const layer = maskLayer(state);
  const key = JSON.stringify([state.sourceWidth, state.sourceHeight, rotation, crop, padding, feather, blend, grow, resize, layer ? state.image.src : null]);
  if (state.blendOverlay?.key === key) return state.blendOverlay.canvas;
  const plan = overlayPlan(padding.outputWidth, padding.outputHeight, resize);
  const { width, height, k } = plan;
  let mask = generatedAreaMask(width, height, { source, crop, padding, sourceWidth: state.sourceWidth, sourceHeight: state.sourceHeight, rotation });
  // The see-through parts of the picture, a painted mask among them, are
  // generated area as well. They are drawn from the picture, on a raster
  // that is the whole canvas as the mask's is: each axis by its own scale.
  if (layer) {
    const raster = document.createElement("canvas"); raster.width = width; raster.height = height;
    const rc = raster.getContext("2d", { willReadFrequently: true });
    rc.scale(width / padding.outputWidth, height / padding.outputHeight);
    rc.beginPath(); rc.rect(padding.left, padding.top, crop.width, crop.height); rc.clip();
    rc.translate(padding.left - crop.x + source.width / 2, padding.top - crop.y + source.height / 2);
    rc.rotate(rotation * Math.PI / 180);
    rc.drawImage(maskStencil(layer), -state.sourceWidth / 2, -state.sourceHeight / 2, state.sourceWidth, state.sourceHeight);
    const pixels = rc.getImageData(0, 0, width, height).data;
    for (let i = 0; i < mask.length; i++) mask[i] += (1 - mask[i]) * pixels[i * 4 + 3] / 255;
  }
  mask = featherGeneratedMask(mask, width, height, feather * k);
  mask = stitchBlendFromMask(mask, width, height, blend * plan.unit, grow * plan.unit);
  const overlay = document.createElement("canvas"); overlay.width = width; overlay.height = height;
  const oc = overlay.getContext("2d"); const image = oc.createImageData(width, height); const data = image.data;
  for (let i = 0; i < mask.length; i++) { data[i * 4] = 0; data[i * 4 + 1] = 184; data[i * 4 + 2] = 174; data[i * 4 + 3] = Math.round(mask[i] * 150); }
  oc.putImageData(image, 0, 0);
  state.blendOverlay = { key, canvas: overlay, mask, width, height };
  return overlay;
}

function drawBlendOverlay(context, state, render) {
  const overlay = blendOverlayCanvas(state, render);
  const { outputRect } = render;
  context.save(); context.imageSmoothingEnabled = true;
  context.drawImage(overlay, outputRect.x, outputRect.y, outputRect.width, outputRect.height);
  context.restore();
}

// Section headers carry a small marker matching the on-canvas handle for
// that group (cyan square = crop, green knob = rotate, orange diamond =
// padding), teaching the editor's color language without a word of text.
function legendMarker(kind) {
  if (kind === "rotate") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32; // drawn 2x, displayed at 16px for crispness
    canvas.className = "qgtools-legend";
    const context = canvas.getContext("2d");
    context.fillStyle = "#73e36a";
    context.beginPath(); context.arc(16, 16, 15, 0, Math.PI * 2); context.fill();
    drawRotateGlyph(context, 16, 16, 7, "#0c2210");
    return canvas;
  }
  return createElement("span", `qgtools-legend qgtools-legend-${kind}`);
}

function sectionHeading(title, markerKind = null) {
  const heading = createElement("h3");
  if (markerKind) heading.append(legendMarker(markerKind));
  heading.append(createElement("span", "", title));
  return heading;
}

// A sidebar row with one of the pack's number boxes, the unit inside it as
// on the node face.
function addScrubField(section, title, control) {
  const label = createElement("label", "qgtools-transform-field");
  label.append(createElement("span", "", title), control);
  section.append(label);
  return label;
}

// The editor's sidebar is built from the node's own controls: the same
// ratio row with its turn button and padlock, the same Fit pill, the same
// number boxes (Shift is the fine step everywhere, 0.1 of a degree for the
// rotation) and the same off | on switches.
function buildControls(state, sidebar) {
  const node = state.node;
  const cropSection = createElement("section", "qgtools-transform-section"); cropSection.append(sectionHeading("Crop & shape", "crop"));
  const chipRow = buildAspectChipRow(state);
  const modeRow = buildAspectModeRow(state, { alignment: false });
  state.editorSyncs.push(chipRow.sync, modeRow.sync);
  cropSection.append(chipRow.row, modeRow.row);
  // Ratios from qg_presets.json that no button shows, in either
  // orientation, stay one pick away.
  const ratioWidget = widget(node, "crop_aspect_ratio");
  let ratioValues = ratioWidget?.options?.values;
  if (typeof ratioValues === "function") ratioValues = ratioValues(ratioWidget, node);
  const shown = new Set(ASPECT_CHIP_ORDER.flatMap((aspect) => [aspect, turnAspect(aspect)]));
  const extra = (Array.isArray(ratioValues) ? ratioValues : []).filter((item) => /^\d+:\d+$/.test(item) && !shown.has(item));
  let more = null;
  if (extra.length) {
    more = createElement("select");
    more.setAttribute("aria-label", "More ratios");
    const first = createElement("option", "", "More ratios…"); first.value = ""; more.append(first);
    for (const item of extra) { const option = createElement("option", "", item); option.value = item; more.append(option); }
    more.title = "Your own ratios from qg_presets.json. Picking one works like a ratio button.";
    more.addEventListener("change", () => { if (more.value) tapRatio(state, more.value); draw(state); updateModalInfo(state); });
    addLabeledControl(cropSection, "More", more);
  }
  cropSection.append(createElement("div", "qgtools-transform-help", "Tap a ratio to pad the picture to it (or crop it, with Fit on crop); tap the lit one to go back to the whole picture. The padlock holds the shape while you drag. Drag the picture itself to move it inside its padding."));

  const rotateSection = createElement("section", "qgtools-transform-section"); rotateSection.append(sectionHeading("Rotate", "rotate"));
  const rotationNumber = makeScrubInput({ value: Number(value(node, "rotation_degrees", 0)) || 0, min: -180, max: 180, step: 1, fineStep: 0.1, decimals: 1, unit: "°", unitWidth: 22,
    title: "Rotation in degrees: 1° per step, Shift for 0.1°. The crop stays over the same part of the picture.",
    onChange: (degrees) => setRotation(state, degrees), onSettle: () => { settleRotation(state); notifyQgChange(); } });
  addScrubField(rotateSection, "Degrees", rotationNumber.root);
  const zeroRotation = createElement("button", "", "Reset rotation");
  zeroRotation.addEventListener("click", () => { setRotation(state, 0); settleRotation(state); notifyQgChange(); });
  rotateSection.append(zeroRotation);

  const padSection = createElement("section", "qgtools-transform-section"); padSection.append(sectionHeading("Padding & mask", "pad"));
  const color = createElement("input"); color.type = "color"; color.className = "qgtools-transform-swatch";
  color.value = normalizeColor(value(node, "fill_color", "#808080"));
  color.addEventListener("input", () => { setValue(node, "fill_color", color.value); draw(state); });
  color.addEventListener("change", () => notifyQgChange());
  addLabeledControl(padSection, "Fill", color);
  const featherNumber = makeScrubInput({ value: value(node, "feather", 24), min: 0, max: 4096, step: 1, decimals: 0, unit: "px", unitWidth: 22,
    title: "Mask feather in pixels.", onChange: (amount) => { setValue(node, "feather", amount); draw(state); }, onSettle: notifyQgChange });
  addScrubField(padSection, "Feather", featherNumber.root);
  const multiple = makeScrubInput({ value: value(node, "canvas_multiple", 1), min: 1, max: 4096, step: 8, fineStep: 1, decimals: 0, unit: "px", unitWidth: 22, snap: true,
    title: "Makes the width and height divide evenly by this number: padding grows by a few pixels, and a side with no padding is trimmed by a few instead. Some models need sizes divisible by 8, 16 or 32; 1 = off.",
    onChange: (amount) => { setValue(node, "canvas_multiple", amount); draw(state); updateModalInfo(state); }, onSettle: notifyQgChange });
  addScrubField(padSection, "Divisible by", multiple.root);
  // A div, not a label: a label would pass a click on its text to the first button.
  const centre = buildCentreButtons(state);
  const centreRow = createElement("div", "qgtools-transform-centre-row");
  centreRow.append(createElement("span", "", "Center"), centre.root);
  padSection.append(centreRow);
  state.editorSyncs.push(centre.sync);
  const resetPad = createElement("button", "", "Reset padding"); resetPad.title = "Remove all padding.";
  resetPad.addEventListener("click", () => { for (const name of ["pad_left", "pad_top", "pad_right", "pad_bottom"]) setValue(node, name, 0); settleRequest(state); draw(state); updateModalInfo(state); notifyQgChange(); }); padSection.append(resetPad);

  // Resize to a pixel budget (image and clip nodes): mirrors the core Scale
  // Image to Total Pixels trio - megapixels, method, resolution steps -
  // so the output lands render-ready without another node.
  let resizeSection = null;
  let resize = null;
  let budget = null;
  let steps = null;
  let method = null;
  if (widget(node, "resize_to_megapixels")) {
    resizeSection = createElement("section", "qgtools-transform-section");
    resizeSection.append(sectionHeading("Resize output"));
    resize = resizeSwitch(state);
    addLabeledControl(resizeSection, "Resize", resize.pill);
    budget = makeScrubInput({
      value: value(node, "megapixels", 1),
      min: 0.01, max: 16, step: 0.05, fineStep: 0.01, decimals: 2, unit: "MP", unitWidth: 22,
      title: "Output budget in megapixels (x 1024x1024).",
      onChange: (amount) => { setValue(node, "megapixels", amount); draw(state); updateModalInfo(state); },
      onSettle: notifyQgChange,
    });
    addScrubField(resizeSection, "Megapixels", budget.root);
    method = createElement("select");
    for (const name of RESIZE_METHODS) {
      const option = createElement("option", "", name); option.value = name; method.append(option);
    }
    method.value = String(value(node, "resize_method", "lanczos"));
    if (!RESIZE_METHODS.includes(method.value)) method.value = "lanczos";
    method.addEventListener("change", () => { setValue(node, "resize_method", method.value); notifyQgChange(); });
    // Field layout (108px label + full-width control): the select used to sit
    // in the generic 88px/1fr/58px row, so it ended ~65px narrower than the
    // Megapixels and Step boxes above and below it (user request 2026-10-13).
    addScrubField(resizeSection, "Method", method);
    steps = makeScrubInput({
      value: value(node, "resolution_steps", 1),
      min: 1, max: 256, step: 8, fineStep: 1, decimals: 0, unit: "px", unitWidth: 22, snap: true,
      title: "Rounds each resized side to a multiple of this (32 for LTX and Wan).",
      onChange: (step) => { setValue(node, "resolution_steps", step); draw(state); updateModalInfo(state); },
      onSettle: notifyQgChange,
    });
    addScrubField(resizeSection, "Step", steps.root);
  }

  const actions = createElement("section", "qgtools-transform-section"); actions.append(sectionHeading("View & reset"));
  const resetViewButton = createElement("button", "", "Reset view"); resetViewButton.addEventListener("click", () => { resetView(state); draw(state); });
  const resetAll = createElement("button", "qgtools-transform-danger", "Reset transform");
  resetAll.title = "Reset rotation, crop, padding, fill, feather and Divisible by. Keep the source, current frame, trim window, fixed length, resize and stitch settings.";
  resetAll.addEventListener("click", () => { resetTransform(node); resetView(state); draw(state); updateModalInfo(state); });
  actions.append(resetViewButton, resetAll);

  // Live preview of the actual output composite (no overlays), so the final
  // result is always visible while adjusting handles.
  const previewSection = createElement("section", "qgtools-transform-section");
  previewSection.append(sectionHeading("Preview"));
  const finalPreview = createElement("canvas", "qgtools-final-preview");
  previewSection.append(finalPreview);
  state.finalPreviewCanvas = finalPreview;

  sidebar.append(cropSection, rotateSection, padSection);
  if (resizeSection) sidebar.append(resizeSection);
  sidebar.append(actions, previewSection);
  sidebar.addEventListener("pointerdown", (event) => event.stopPropagation());
  state.syncEditorControls = () => {
    rotationNumber.set(Number(value(node, "rotation_degrees", 0)) || 0);
    featherNumber.set(value(node, "feather", 24));
    multiple.set(value(node, "canvas_multiple", 1)); color.value = normalizeColor(value(node, "fill_color", "#808080"));
    resize?.sync(); budget?.set(value(node, "megapixels", 1)); steps?.set(value(node, "resolution_steps", 1));
    if (more) more.value = extra.includes(liveRequest(state) ?? "") ? liveRequest(state) : "";
  };
}

// Renders what the node will actually output: fill background, the rotated
// source clipped to the crop, placed inside the padded canvas. No handles,
// no dashes - the composite itself.
function drawFinalPreview(state) {
  const canvas = state.finalPreviewCanvas;
  if (!canvas || !state.image || !state.sourceWidth || !state.sourceHeight) return;
  const current = values(state.node);
  const source = rotatedSize(state.sourceWidth, state.sourceHeight, current.rotation_degrees);
  const whole = resolveCrop(current, source);
  const padding = resolvePadding(current, whole);
  const crop = keptCrop(whole, padding);
  const scale = Math.min(226 / padding.outputWidth, 260 / padding.outputHeight);
  const width = Math.max(1, Math.round(padding.outputWidth * scale));
  const height = Math.max(1, Math.round(padding.outputHeight * scale));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const pixelWidth = Math.round(width * dpr); const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = normalizeColor(current.fill_color);
  context.fillRect(0, 0, width, height);
  context.save();
  context.beginPath();
  context.rect(padding.left * scale, padding.top * scale, crop.width * scale, crop.height * scale);
  context.clip();
  context.translate(
    (padding.left - crop.x) * scale + source.width * scale / 2,
    (padding.top - crop.y) * scale + source.height * scale / 2
  );
  context.rotate((Number(current.rotation_degrees) || 0) * Math.PI / 180);
  drawSourceImage(context, state, scale);
  context.restore();
}

function buildTimeline(state) {
  const timeline = createElement("div", "qgtools-transform-timeline");
  const transport = createElement("div", "qgtools-transform-transport");
  const label = createElement("span", "qgtools-transform-badge", "0 / 0");
  label.title = "Playhead frame / last frame";
  const steps = createElement("div", "qgtools-transform-steps");
  const commands = [["|<", "first"], ["-100", -100], ["-50", -50], ["-25", -25], ["-1", -1], ["Play", "play"], ["+1", 1], ["+25", 25], ["+50", 50], ["+100", 100], [">|", "last"]];
  for (const [text, command] of commands) {
    const button = createElement("button", "", text); if (command === "play") state.playButton = button;
    button.title = command === "play" ? "Play / pause (Space)" : typeof command === "number" ? `Step ${command > 0 ? "+" : ""}${command} frames (Arrow keys step 1, Shift 10)` : command === "first" ? "First frame (Home)" : "Last frame (End)";
    button.addEventListener("click", () => timelineCommand(state, command)); steps.append(button);
  }
  transport.append(label, steps);
  if (state.isClip) {
    const marks = createElement("div", "qgtools-transform-steps");
    for (const [text, command, tip] of [["Set IN", "setIn", "Put IN at the playhead (I)"], ["Set OUT", "setOut", "Put OUT at the playhead (O)"]]) {
      const button = createElement("button", "", text); button.title = tip;
      button.addEventListener("click", () => timelineCommand(state, command)); marks.append(button);
    }
    transport.append(marks);
  }
  timeline.append(transport, buildTrim(state));
  state.timelineLabel = label;
  state.modalTrim = [...state.trimViews].at(-1);
  syncTimelineRange(state);
  return timeline;
}

// One timeline component on every surface (node face, editor): the clip
// node's with IN/OUT handles, the frame picker's with the playhead alone.
function buildTrim(state) {
  const control = mountTransformTrim({
    get: (name, fallback) => value(state.node, name, fallback),
    set: (name, next) => {
      setValue(state.node, name, next);
      for (const view of state.trimViews) if (view !== control) view.sync();
    },
    has: (name) => Boolean(widget(state.node, name)),
    driven: (name) => trimInputDriven(state.node, name),
    number: (name, fallback) => inputNumber(state.node, name, value(state.node, name, fallback)),
    outputRate: () => clipOutputRate(state.node, state.metadata?.fps, value(state.node, "every_nth", 1)),
    metadata: () => state.metadata,
    trim: state.isClip,
    onSeek: (frame, settled) => scrubTo(state, frame, settled),
    onCommit: notifyQgChange,
  });
  state.trimViews.add(control);
  return control.root;
}

function setPlayhead(state, index) {
  const info = clipInfo(state.metadata);
  const frame = clampFrame(index, info);
  setValue(state.node, "seek_mode", "frame index");
  setValue(state.node, "frame_index", frame);
  setValue(state.node, "frame_time", frameTime(frame, info));
  return frame;
}

// The playhead moved. While a gesture is live the pump fetches a reduced
// frame (one request in flight, the latest position wins) and a storyboard
// tile stands in when it is nearer; on release, one full-size fetch that
// also snaps the widgets to the decoded frame.
function scrubTo(state, index, settled) {
  const frame = setPlayhead(state, index);
  syncTimelineRange(state);
  if (settled) { void seekFrame(state); return; }
  showScrubGhost(state, frame);
  requestScrubFrame(state);
}

// Light variant for continuous motion (playback, held arrow keys): reduced
// preview size, widgets still snapped since only the caller writes position.
async function seekFrameLight(state) {
  try {
    await loadVideoFrame(state, ++state.loadSerial, { maxSize: SCRUB_PREVIEW_SIZE });
    draw(state); updateModalInfo(state);
  } catch (error) {
    if (error?.name === "AbortError") return;
    drawEmpty(state, error.message);
  }
}

async function timelineCommand(state, command, light = false) {
  if (command === "play") { state.playing ? stopPlayback(state) : startPlayback(state); return; }
  const info = clipInfo(state.metadata);
  if (!info.count) return;
  const current = clampFrame(value(state.node, "frame_index", 0), info);
  if (command === "setIn" || command === "setOut") {
    if (!state.isClip) return;
    // The rail knows which way the length is set (OUT, a Length, a
    // connected input) and what that edge may do.
    const trim = [...state.trimViews][0];
    if (!trim) return;
    const edge = command === "setIn" ? "start" : "end";
    const window = trim.window();
    // In free trim a mark past the other edge takes that edge along.
    if (trim.plan()?.mode === "free") {
      if (edge === "start" && current > window.last) trim.moveEdge("end", current, false);
      if (edge === "end" && current < window.first) trim.moveEdge("start", current, false);
    }
    trim.moveEdge(edge, current, true);
    syncTimelineRange(state);
    return;
  }
  let next = current;
  if (command === "first") next = 0; else if (command === "last") next = info.count - 1; else next += Number(command);
  setPlayhead(state, next);
  syncTimelineRange(state);
  await (light ? seekFrameLight(state) : seekFrame(state));
}

// Playback correctness note: each tick awaits a frame fetch, and a Pause
// press usually lands during that await. The tick must therefore re-check
// after the await — against a session counter, not just a boolean — so a
// paused (or paused-then-restarted) loop's in-flight tick dies instead of
// re-scheduling itself as a zombie that can no longer be stopped.
function startPlayback(state) {
  state.playButton.textContent = "Pause";
  state.playing = true;
  const session = (state.playbackSession = (state.playbackSession || 0) + 1);
  const delay = Math.max(20, Math.round(1000 / Math.max(1, state.metadata?.fps || 30)));
  const tick = async () => {
    if (!state.playing || state.playbackSession !== session) return;
    const before = Number(value(state.node, "frame_index", 0));
    await timelineCommand(state, 1, true);
    if (!state.playing || state.playbackSession !== session) return;
    if (Number(value(state.node, "frame_index", 0)) === before) { stopPlayback(state); return; }
    state.playbackTimer = window.setTimeout(tick, delay);
  };
  state.playbackTimer = window.setTimeout(tick, delay);
}
function stopPlayback(state) {
  const wasPlaying = Boolean(state.playing);
  state.playing = false;
  state.playbackSession = (state.playbackSession || 0) + 1; // orphan in-flight ticks
  if (state.playbackTimer) clearTimeout(state.playbackTimer);
  state.playbackTimer = null;
  if (state.playButton) state.playButton.textContent = "Play";
  // Land on a full-resolution frame after light playback previews.
  if (wasPlaying) void seekFrame(state);
}

function keyDown(state, event) {
  if (!state.modal || ["INPUT", "SELECT", "TEXTAREA"].includes(event.target?.tagName)) return;
  if (state.discardPending) return;
  if (event.key === "Escape") { void cancelEditor(state); return; }
  if (state.kind === "video" && event.code === "Space") { event.preventDefault(); timelineCommand(state, "play"); }
  if (state.kind === "video" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    // Light fetches while the key repeats; keyup lands a full-size frame.
    event.preventDefault(); timelineCommand(state, (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" ? -1 : 1), true);
  }
  if (state.kind === "video" && (event.key === "Home" || event.key === "End")) {
    event.preventDefault(); timelineCommand(state, event.key === "Home" ? "first" : "last");
  }
  if (state.isClip && (event.key === "i" || event.key === "I" || event.key === "o" || event.key === "O") && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); timelineCommand(state, event.key.toLowerCase() === "i" ? "setIn" : "setOut");
  }
}

function keyUp(state, event) {
  if (!state.modal || state.kind !== "video") return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") void seekFrame(state);
}

function fitCrop(state) {
  setValue(state.node, "crop_x", 0); setValue(state.node, "crop_y", 0); setValue(state.node, "crop_width", 0); setValue(state.node, "crop_height", 0); draw(state);
}
function fitAspect(state, aspect, mode) {
  if (!hasPicture(state)) return;
  const source = sourceSize(state);
  const patch = fitSourceToAspect(source, aspect, mode);
  // A crop reached by a chip keeps its ratio through drags only while the
  // padlock is on; otherwise it is a plain box, free to drag anywhere.
  if (mode === "crop" && aspect !== "free" && !lockOn(state)) Object.assign(patch, explicitCrop(patch, source));
  for (const [name, next] of Object.entries(patch)) setValue(state.node, name, next);
  state.node.properties ??= {};
  if (aspect === "free" || aspect === "source") delete state.node.properties.qg_fit_aspect;
  else state.node.properties.qg_fit_aspect = aspect;
  state.node.properties.qg_aspect_mode = mode;
  resetView(state); draw(state); updateModalInfo(state); notifyQgChange();
}
// Every rotation control (slider, number box, Reset rotation, the knob)
// comes through rotateTo, so they all keep the crop the same way
// (cropForRotation). The crop is carried from where the gesture began, not
// step by step: a sweep out and back returns the same crop, and a crop
// squeezed at a canvas edge mid-sweep grows back. The start is re-taken
// whenever anything but rotateTo changed the geometry since its last write.
const ROTATION_KEYS = [
  "rotation_degrees", "crop_aspect_ratio", "crop_x", "crop_y", "crop_width", "crop_height",
  "pad_left", "pad_top", "pad_right", "pad_bottom",
];
function rotationBase(state) {
  const now = values(state.node);
  const base = state.rotationBase;
  if (base?.written && ROTATION_KEYS.every((name) => now[name] === base.written[name])) return base;
  // Rotation turns the picture, not the ratio you picked: a lit chip's shape
  // is kept through the turn, and with the padlock on so is a custom one.
  const request = liveRequest(state);
  const hold = aspectMode(state) === "pad" && hasPicture(state)
    ? request ? parseAspectRatio(request, sourceSize(state)) : heldRatio(state)
    : null;
  state.rotationBase = { rotation: Number(now.rotation_degrees) || 0, values: now, written: null, hold };
  return state.rotationBase;
}
function settleRotation(state) { state.rotationBase = null; settleRequest(state); }
function rotateTo(state, degrees) {
  const base = rotationBase(state);
  // Past 180 the rotation carries on from -180, and the other way round.
  const next = Math.round(wrapDegrees(degrees) * 10) / 10;
  setValue(state.node, "rotation_degrees", next);
  if (state.sourceWidth && state.sourceHeight) {
    const crop = cropForRotation(base.values, state.sourceWidth, state.sourceHeight, base.rotation, next);
    for (const [name, amount] of Object.entries(crop)) setValue(state.node, name, amount);
    // The held shape re-solves padding from the gesture's starting pads.
    for (const name of ["pad_left", "pad_top", "pad_right", "pad_bottom"]) setValue(state.node, name, base.values[name]);
  }
  if (base.hold) applyLock(state, base.hold, "x");
  base.written = values(state.node);
}
function setRotation(state, degrees) {
  rotateTo(state, degrees); draw(state); updateModalInfo(state);
}
function resetView(state) { state.view = { zoom: 1, panX: 0, panY: 0 }; }

// Resolve CSS color names with the browser's own parser. An invalid
// assignment leaves fillStyle unchanged, so probing twice from different
// starting values separates "parsed" from "ignored".
let colorProbeContext = null;
function resolveCssColorName(name) {
  try {
    colorProbeContext ??= document.createElement("canvas").getContext("2d");
    const context = colorProbeContext;
    context.fillStyle = "#000000"; context.fillStyle = name;
    const first = String(context.fillStyle);
    context.fillStyle = "#ffffff"; context.fillStyle = name;
    return first === String(context.fillStyle) && /^#[0-9a-f]{6}$/i.test(first) ? first : null;
  } catch { return null; }
}
function normalizeColor(value) { return normalizeFillColor(value, resolveCssColorName); }

// The panel never zooms or pans: fit-only, so it cannot fight graph zoom.
const PANEL_VIEW = Object.freeze({ zoom: 1, panX: 0, panY: 0 });

// Geometry (source, crop, padding) is always read live from the widgets;
// the screen mapping is either fitted fresh or, mid-drag, the frozen map
// captured at pointerdown — a live refit would change the scale under the
// pointer and make the grabbed handle slip.
function renderGeometry(state, width, height, view, map = null) {
  const source = rotatedSize(state.sourceWidth, state.sourceHeight, value(state.node, "rotation_degrees", 0));
  const crop = resolveCrop(values(state.node), source); const padding = resolvePadding(values(state.node), crop);
  // What reaches the output: the crop, less what Divisible by trims off it.
  const kept = keptCrop(crop, padding);
  const layout = map?.layout ?? stageHandleLayout(width, height);
  let scale, originX, originY;
  if (map) {
    ({ scale, originX, originY } = map);
  } else {
    const margin = layout.margin; const union = { x: Math.min(0, kept.x - padding.left), y: Math.min(0, kept.y - padding.top) };
    union.width = Math.max(source.width, kept.x - padding.left + padding.outputWidth) - union.x;
    union.height = Math.max(source.height, kept.y - padding.top + padding.outputHeight) - union.y;
    const fit = Math.max(0.01, Math.min((width - margin * 2) / union.width, (height - margin * 2) / union.height));
    scale = fit * view.zoom;
    originX = (width - union.width * fit) / 2 - union.x * fit + view.panX;
    originY = (height - union.height * fit) / 2 - union.y * fit + view.panY;
  }
  const rect = (x, y, w, h) => ({ x: originX + x * scale, y: originY + y * scale, width: w * scale, height: h * scale });
  const sourceRect = rect(0, 0, source.width, source.height);
  const cropRect = rect(crop.x, crop.y, crop.width, crop.height);
  const keptRect = rect(kept.x, kept.y, kept.width, kept.height);
  const outputRect = rect(kept.x - padding.left, kept.y - padding.top, padding.outputWidth, padding.outputHeight);
  return { source, crop, kept, padding, scale, originX, originY, layout, sourceRect, cropRect, keptRect, outputRect, view: { x: 0, y: 0, width, height } };
}

// The node preview sits in a DOM widget the graph scales with its zoom, so
// its backing store is sized for the zoom in play (capped) - the same
// sharpness core's canvas-drawn image previews get for free.
const PREVIEW_MAX_OVERSAMPLE = 4;
function panelOversample() {
  const zoom = Number(app.canvas?.ds?.scale) || 1;
  return clamp(zoom, 1, PREVIEW_MAX_OVERSAMPLE);
}

function prepareCanvas(canvas, oversample = 1) {
  const width = Math.max(1, canvas.clientWidth || 1); const height = Math.max(1, canvas.clientHeight || 1); const dpr = (window.devicePixelRatio || 1) * oversample;
  const pixelWidth = Math.round(width * dpr); const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const context = canvas.getContext("2d"); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height); return { context, width, height };
}

function draw(state) {
  syncReadout(state);
  state.syncCanvasRow?.();
  state.syncAspectChips?.();
  state.syncAspectMode?.();
  for (const sync of state.editorSyncs ?? []) sync();
  state.syncEditorControls?.();
  state.syncStitchControls?.();
  for (const canvas of [state.canvas, state.previewCanvas]) {
    if (!canvas) continue;
    const compact = canvas === state.previewCanvas;
    if (compact) state.panelOversample = panelOversample();
    const { context, width, height } = prepareCanvas(canvas, compact ? state.panelOversample : 1);
    if (!state.image || !state.sourceWidth || !state.sourceHeight) {
      if (compact) state.panelRender = null; else state.render = null;
      drawEmptyCanvas(context, width, height, "Choose a source to begin"); continue;
    }
    const frozen = state.drag?.canvas === canvas ? state.drag.map : null;
    const render = renderGeometry(state, width, height, compact ? PANEL_VIEW : state.view, frozen);
    render.canvas = canvas;
    if (compact) state.panelRender = render; else state.render = render;
    drawScene(context, state, render, compact, !compact || Boolean(state.panelInteractive));
  }
  drawFinalPreview(state);
  keepStageRoom(state);
}

// The picture is what the node face is for, so the stage never gets shorter
// than stageHeightForWidth for its width: the panel's floor is the rows
// around the stage plus that, and a corner drag stops there. The rows are
// measured on every draw; before the panel is on screen, these stand in:
// the rows of a node with no file picked yet, as the examples open (the
// canvas row's Resize adds the budget row under it).
const PANEL_CHROME_ESTIMATE = { image: 262, video: 365, clip: 451 };
const RESIZE_ROW = 30;
// Node width minus stage width: the DOM widget frame, panel padding, borders.
const PANEL_SIDE_INSET = 38;
// The narrowest face the chip row and the button rows fit on.
export const TRANSFORM_MIN_WIDTH = 330;

function stageWidth(state) {
  return state.previewCanvas?.clientWidth || Math.max(0, (Number(state.node.size?.[0]) || TRANSFORM_MIN_WIDTH) - PANEL_SIDE_INSET);
}

// Everything in the panel but the stage: rows, the gaps between the shown
// ones, and the panel's own padding. Null while the panel is not laid out.
function measureChrome(state) {
  const stage = state.previewCanvas;
  const panel = stage?.parentElement;
  if (!panel?.isConnected || !panel.offsetHeight) return state.chromeHeight ?? null;
  const style = getComputedStyle(panel);
  const gap = parseFloat(style.rowGap) || 0;
  let height = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  let shown = 0;
  for (const child of panel.children) {
    if (getComputedStyle(child).display === "none") continue;
    shown += 1;
    if (child !== stage) height += child.offsetHeight;
  }
  state.chromeHeight = Math.round(height + Math.max(0, shown - 1) * gap);
  return state.chromeHeight;
}

// The panel's minimum height: its rows, the stage floor with the stage's
// border, and the frame the frontend insets a DOM widget by.
export function transformPanelFloor(node) {
  const state = node?.__qgTransformState;
  if (!state) return 0;
  const estimate = PANEL_CHROME_ESTIMATE[state.isClip ? "clip" : state.kind] + (value(node, "resize_to_megapixels", false) ? RESIZE_ROW : 0);
  return (state.chromeHeight ?? estimate) + stageHeightForWidth(stageWidth(state)) + 2 + WIDGET_FRAME;
}

// A row that appears later (Resize on, a readout that wraps) would squeeze
// the stage under its floor: the node grows by the difference instead, so
// it costs node height, not picture. Never shrinks a node.
function keepStageRoom(state) {
  const height = state.previewCanvas?.clientHeight ?? 0;
  const node = state.node;
  if (state.disposed || !height || !node.size) return;
  // Nodes 2.0 has no layout floor for width: lend it the face's own, or a
  // corner drag squeezes the chips and buttons down to 225px.
  holdVueNodeMinWidth(state.previewCanvas.parentElement, TRANSFORM_MIN_WIDTH);
  measureChrome(state);
  const floor = stageHeightForWidth(stageWidth(state));
  // Nodes 2.0 sizes a node from its content, so the floor also has to be
  // the stage's own minimum there; in the classic view the layout floor
  // already keeps the panel this tall.
  const minimum = `${floor}px`;
  if (state.previewCanvas.style.minHeight !== minimum) state.previewCanvas.style.minHeight = minimum;
  if (height >= floor - 1) { state.stageGrowth = null; return; }
  // The DOM follows a new node size a frame later, so a second draw before
  // then reads the same short stage: wait for it instead of growing twice.
  const pending = state.stageGrowth;
  if (pending && pending.height === height && node.size[1] >= pending.target) return;
  const target = node.size[1] + (floor - height);
  state.stageGrowth = { height, target };
  node.setSize?.([node.size[0], target]);
  node.setDirtyCanvas?.(true, true);
}

// The stage shows the output as it will be: the kept picture inside the
// crop, and all added space - padding and the corners a turn opens - in the
// real fill colour under a faint hatch, so black bands on a black stage
// still read as bands. Only the picture the crop cuts away is darkened.
function drawScene(context, state, render, compact, interactive) {
  const { sourceRect, cropRect, keptRect, outputRect } = render; context.save();
  const fill = normalizeColor(value(state.node, "fill_color", "#808080"));
  // Show blend's tint already holds the painted parts: one teal at a time.
  const blend = !compact && state.showBlend && widget(state.node, "stitch_blend");
  const tint = !blend && settings().show_mask ? maskLayer(state)?.tint : null;
  const picture = () => {
    context.save(); context.translate(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2); context.rotate((Number(value(state.node, "rotation_degrees", 0)) || 0) * Math.PI / 180);
    drawSourceImage(context, state, render.scale);
    // The mask rides on the picture it was drawn on: turned, cropped and
    // padded with it, and dimmed with it where the crop cuts it away.
    if (tint) {
      const width = state.sourceWidth * render.scale; const height = state.sourceHeight * render.scale;
      context.globalAlpha = MASK_TINT_ALPHA; context.drawImage(tint, -width / 2, -height / 2, width, height);
    }
    context.restore();
  };
  picture();
  context.save(); context.fillStyle = "rgba(8,10,12,.66)";
  context.beginPath(); context.rect(0, 0, context.canvas.width, context.canvas.height); context.rect(outputRect.x, outputRect.y, outputRect.width, outputRect.height); context.fill("evenodd"); context.restore();
  context.fillStyle = fill; context.fillRect(outputRect.x, outputRect.y, outputRect.width, outputRect.height);
  drawHatch(context, outputRect, fill);
  context.save(); context.beginPath(); context.rect(keptRect.x, keptRect.y, keptRect.width, keptRect.height); context.clip(); picture(); context.restore();
  if (blend) drawBlendOverlay(context, state, render);
  context.strokeStyle = "#4bd8ef"; context.lineWidth = compact ? 1 : 2; context.setLineDash([7, 5]); context.strokeRect(cropRect.x, cropRect.y, cropRect.width, cropRect.height);
  context.strokeStyle = "#ff9d42"; context.setLineDash([5, 5]); context.strokeRect(outputRect.x, outputRect.y, outputRect.width, outputRect.height); context.setLineDash([]);
  if (interactive) {
    if (state.grid) drawGrid(context, cropRect);
    const moving = state.drag?.kind === "move" && state.drag.canvas === context.canvas;
    const hover = state.hoverMove?.canvas === context.canvas ? state.hoverMove.room : null;
    if (moving || (hover && !state.drag)) drawMoveArrows(context, cropRect, moving ? moveRoomFor(state, render) : hover);
    drawCropHandles(context, cropRect, state.drag?.kind === "crop" ? state.drag.name : null);
    drawPaddingHandles(context, outputRect, render.layout.padOffset, state.drag?.kind === "padding" ? state.drag.name : null);
    drawCornerHandles(context, outputRect, render.layout.padOffset, state.drag?.kind === "corner" ? state.drag.name : null);
    drawRotationHandle(context, state, render, state.drag?.kind === "rotation");
    // The face has its readout line under the stage (syncReadout).
    if (!compact) drawOutputSize(context, state, render);
  }
  context.restore();
}

function resizeRequest(node) {
  return value(node, "resize_to_megapixels", false)
    ? { megapixels: value(node, "megapixels", 1), steps: value(node, "resolution_steps", 1) }
    : null;
}

// The size readout, drawn OUTSIDE the image: under the output rect, above
// it when the bottom would run off the stage, so it never sits on the
// pixels being judged. It names every step that sets the size - crop,
// padding, the Align rounding, the resize - wrapping at the arrows on a
// narrow stage, with the size the run emits last and brightest, and an
// amber line when the steps stretch the picture or the resize undoes Align.
const READOUT_LINE = 15;
function drawOutputSize(context, state, render) {
  const { tokens, warnings } = litTokens(state, sizeChainTokens(sizeChain(values(state.node), render.source, resizeRequest(state.node))));
  const { outputRect } = render;
  context.save();
  const viewWidth = context.canvas.clientWidth || context.canvas.width;
  const viewHeight = context.canvas.clientHeight || context.canvas.height;
  const maxWidth = Math.max(80, viewWidth - 24);
  const muted = "11px system-ui";
  const strong = "600 12px system-ui";
  const measure = (font, text) => { context.font = font; return context.measureText(text).width; };
  // Every piece after the first starts with its arrow, also at the start of
  // a wrapped line, so a line's width is the sum of its pieces.
  const arrow = "→ ";
  const pieces = tokens.map((token, index) => {
    const last = index === tokens.length - 1;
    const lead = index ? arrow : "";
    const label = token.label ? `${token.label} ` : "";
    const gap = last ? 0 : measure(muted, "  ");
    return { lead, label, text: token.text, last, width: measure(muted, lead + label) + measure(last ? strong : muted, token.text) + gap };
  });
  const lines = [[]];
  let lineWidth = 0;
  for (const piece of pieces) {
    if (lines.at(-1).length && lineWidth + piece.width > maxWidth) { lines.push([]); lineWidth = 0; }
    lines.at(-1).push(piece);
    lineWidth += piece.width;
  }
  const warningText = warnings.length ? `⚠ ${warnings.join(" · ")}` : "";
  const note = ratioNote(state);
  // Canvas text is invisible to the zh plugin's DOM translator, so the box
  // has to translate itself. Two whole templates rather than one with an
  // "add"/"trim" hole: a bare one-word key would match stray text nodes.
  const noteText = note
    ? zh(aspectMode(state) === "pad"
        ? "Already {a}: nothing to add. Pick another ratio or turn it."
        : "Already {a}: nothing to trim. Pick another ratio or turn it.")
      .replace("{a}", liveRequest(state))
    : "";
  const widths = lines.map((line) => line.reduce((sum, piece) => sum + piece.width, 0));
  if (warningText) widths.push(measure(muted, warningText));
  if (noteText) widths.push(measure(muted, noteText));
  const boxWidth = Math.min(viewWidth - 8, Math.max(...widths) + 12);
  const boxHeight = (lines.length + (warningText ? 1 : 0) + (noteText ? 1 : 0)) * READOUT_LINE + 5;
  const { x, top } = sizeBoxPlace(state, render, boxWidth, boxHeight, viewWidth, viewHeight);
  context.fillStyle = "rgba(8,10,12,0.82)";
  context.beginPath(); context.roundRect(x, top, boxWidth, boxHeight, 6); context.fill();
  const write = (font, color, text, cursor, baseline) => {
    context.font = font; context.fillStyle = color; context.fillText(text, cursor, baseline);
    return cursor + context.measureText(text).width;
  };
  lines.forEach((line, row) => {
    const baseline = top + 1 + (row + 1) * READOUT_LINE;
    let cursor = x + 6;
    for (const piece of line) {
      cursor = write(muted, "#7f8b93", piece.lead, cursor, baseline);
      cursor = write(muted, "#8ca8a5", piece.label, cursor, baseline);
      cursor = write(piece.last ? strong : muted, piece.last ? "#ffffff" : "#c9d0d6", piece.text, cursor, baseline);
      cursor += piece.last ? 0 : measure(muted, "  ");
    }
  });
  let extra = lines.length;
  if (noteText) { extra += 1; write(muted, note.warn ? "#ffc46b" : "#8ca8a5", noteText, x + 6, top + 1 + extra * READOUT_LINE); }
  if (warningText) { extra += 1; write(muted, "#ffc46b", warningText, x + 6, top + 1 + extra * READOUT_LINE); }
  context.restore();
}

// Where the editor's size box goes: under the bottom diamond, else over the
// top one, else a corner of the stage - the first spot that covers no
// handle and stays on the stage.
function sizeBoxPlace(state, render, width, height, viewWidth, viewHeight) {
  const { outputRect } = render;
  const offset = render.layout?.padOffset ?? 38;
  const centred = clamp(outputRect.x + outputRect.width / 2 - width / 2, 4, Math.max(4, viewWidth - width - 4));
  const handles = [
    ...paddingHandleCenters(outputRect, offset).map((point) => ({ ...point, r: 13 })),
    ...canvasCornerCenters(outputRect, offset).map((point) => ({ ...point, r: 13 })),
    ...cropHandleCenters(render.cropRect).map((point) => ({ ...point, r: 8 })),
    { ...rotationHandle(state, render), r: 15 },
  ];
  const candidates = [
    { x: centred, top: outputRect.y + outputRect.height + offset + 14 },
    { x: centred, top: outputRect.y - offset - 14 - height },
    { x: 6, top: viewHeight - height - 6 },
    { x: viewWidth - width - 6, top: viewHeight - height - 6 },
    { x: 6, top: 6 },
    { x: centred, top: outputRect.y + outputRect.height + 6 },
  ];
  const fits = ({ x, top }) => x >= 2 && top >= 2 && x + width <= viewWidth - 2 && top + height <= viewHeight - 2
    && handles.every((handle) => handle.x + handle.r < x || handle.x - handle.r > x + width || handle.y + handle.r < top || handle.y - handle.r > top + height);
  const spot = candidates.find(fits) ?? candidates[0];
  return { x: spot.x, top: clamp(spot.top, 4, Math.max(4, viewHeight - height - 4)) };
}

// The picture's see-through parts, read once per picture from its alpha by
// the run's rule (seeThroughMap). A mask drawn in the MaskEditor is saved
// as exactly that. `picture` is the picture as the run uses it: kept pixels
// fully solid, the rest empty so the fill shows through, where the browser
// would let a half-strength stroke show half the picture. `tint` is solid
// teal over the rest, drawn at Show blend's strength. Null for video frames
// and for a picture the run leaves as it is. Pictures over 2048 px are read
// at that size.
const MASK_LAYER_SIDE = 2048;
const MASK_TEAL = [0, 184, 174, 255];
const MASK_TINT_ALPHA = 150 / 255;
function maskLayer(state) {
  if (state.kind !== "image" || !state.image || !state.sourceWidth || !state.sourceHeight) return null;
  if (state.seeThrough?.image === state.image) return state.seeThrough.layer;
  let layer = null;
  try {
    const k = Math.min(1, MASK_LAYER_SIDE / Math.max(state.sourceWidth, state.sourceHeight));
    const width = Math.max(1, Math.round(state.sourceWidth * k));
    const height = Math.max(1, Math.round(state.sourceHeight * k));
    const picture = document.createElement("canvas"); picture.width = width; picture.height = height;
    const context = picture.getContext("2d");
    context.drawImage(state.image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const map = seeThroughMap(pixels.data);
    if (map) {
      const tint = document.createElement("canvas"); tint.width = width; tint.height = height;
      const tintContext = tint.getContext("2d");
      const teal = tintContext.createImageData(width, height);
      for (let i = 0; i < map.length; i++) {
        pixels.data[i * 4 + 3] = map[i] ? 0 : 255;
        if (map[i]) teal.data.set(MASK_TEAL, i * 4);
      }
      context.putImageData(pixels, 0, 0);
      tintContext.putImageData(teal, 0, 0);
      layer = { picture, tint, stencil: null };
    }
  } catch {
    // A picture the browser will not let us read is drawn as it is.
  }
  state.seeThrough = { image: state.image, layer };
  return layer;
}

// White where the tint is, for Show blend's raster.
function maskStencil(layer) {
  if (!layer.stencil) {
    const stencil = document.createElement("canvas"); stencil.width = layer.tint.width; stencil.height = layer.tint.height;
    const context = stencil.getContext("2d");
    context.drawImage(layer.tint, 0, 0);
    context.globalCompositeOperation = "source-in"; context.fillStyle = "#fff"; context.fillRect(0, 0, stencil.width, stencil.height);
    layer.stencil = stencil;
  }
  return layer.stencil;
}

// Draws the current source frame centered on the (already translated and
// rotated) origin. During a scrub, the nearest storyboard tile stands in for
// the real frame until its decode lands.
function drawSourceImage(context, state, scale) {
  const width = state.sourceWidth * scale;
  const height = state.sourceHeight * scale;
  const storyboard = state.storyboard;
  if (state.scrubPreviewTile != null && storyboard) {
    context.drawImage(
      storyboard.image,
      state.scrubPreviewTile * storyboard.tileWidth, 0, storyboard.tileWidth, storyboard.tileHeight,
      -width / 2, -height / 2, width, height
    );
    return;
  }
  context.drawImage(maskLayer(state)?.picture ?? state.image, -width / 2, -height / 2, width, height);
}

// Faint diagonal lines over added space: light on a dark fill, dark on a
// light one.
function drawHatch(context, rect, fill) {
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  const hex = /^#([0-9a-f]{6})$/i.exec(fill)?.[1] ?? "808080";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.45;
  context.save();
  context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip();
  context.strokeStyle = light ? "rgba(0,0,0,.17)" : "rgba(255,255,255,.14)";
  context.lineWidth = 1;
  context.beginPath();
  const step = 9;
  for (let d = -rect.height; d < rect.width; d += step) {
    context.moveTo(rect.x + d, rect.y + rect.height);
    context.lineTo(rect.x + d + rect.height, rect.y);
  }
  context.stroke();
  context.restore();
}

// Small arrows inside the picture's edges, toward each side it can move.
function drawMoveArrows(context, rect, room) {
  if (!room) return;
  const inset = Math.min(24, rect.width / 4, rect.height / 4);
  const size = 6;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const arrows = [
    [room.left, rect.x + inset, cy, -1, 0],
    [room.right, rect.x + rect.width - inset, cy, 1, 0],
    [room.up, cx, rect.y + inset, 0, -1],
    [room.down, cx, rect.y + rect.height - inset, 0, 1],
  ];
  context.save();
  context.lineWidth = 2.5; context.lineCap = "round"; context.lineJoin = "round";
  for (const [on, x, y, dx, dy] of arrows) {
    if (!on) continue;
    const tip = { x: x + dx * size, y: y + dy * size };
    const a = { x: x - dx * size + dy * size, y: y - dy * size + dx * size };
    const b = { x: x - dx * size - dy * size, y: y - dy * size - dx * size };
    for (const [color, width] of [["rgba(0,0,0,.65)", 4.5], ["#ffffff", 2.2]]) {
      context.strokeStyle = color; context.lineWidth = width;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(tip.x, tip.y); context.lineTo(b.x, b.y); context.stroke();
    }
  }
  context.restore();
}

function drawGrid(context, rect) {
  context.save(); context.strokeStyle = "rgba(255,255,255,.35)"; context.lineWidth = 1;
  for (const fraction of [1 / 3, 1 / 2, 2 / 3]) {
    context.beginPath(); context.moveTo(rect.x + rect.width * fraction, rect.y); context.lineTo(rect.x + rect.width * fraction, rect.y + rect.height); context.stroke();
    context.beginPath(); context.moveTo(rect.x, rect.y + rect.height * fraction); context.lineTo(rect.x + rect.width, rect.y + rect.height * fraction); context.stroke();
  }
  context.restore();
}
function drawCropHandles(context, rect, active) {
  for (const handle of cropHandleCenters(rect)) { context.fillStyle = handle.name === active ? "#fff" : "#4bd8ef"; context.fillRect(handle.x - 6, handle.y - 6, 12, 12); context.strokeStyle = "#08272d"; context.strokeRect(handle.x - 6, handle.y - 6, 12, 12); }
}
function drawPaddingHandles(context, rect, offset, active) {
  for (const handle of paddingHandleCenters(rect, offset)) { context.save(); context.translate(handle.x, handle.y); context.rotate(Math.PI / 4); context.fillStyle = handle.name === active ? "#fff" : "#ff9d42"; context.fillRect(-8, -8, 16, 16); context.strokeStyle = "#3b2108"; context.strokeRect(-8, -8, 16, 16); context.restore(); }
}
// The corner handles are orange like the side diamonds (padding), drawn as a
// corner bracket that points away from the canvas: the shape of the corner
// they scale.
function drawCornerHandles(context, rect, offset, active) {
  const arm = 15;
  const thick = 5;
  for (const handle of canvasCornerCenters(rect, offset)) {
    const sx = handle.corner.includes("e") ? 1 : -1;
    const sy = handle.corner.includes("s") ? 1 : -1;
    const vx = handle.x + sx * 5;
    const vy = handle.y + sy * 5;
    context.save();
    context.beginPath();
    context.moveTo(vx, vy);
    context.lineTo(vx - sx * arm, vy);
    context.lineTo(vx - sx * arm, vy - sy * thick);
    context.lineTo(vx - sx * thick, vy - sy * thick);
    context.lineTo(vx - sx * thick, vy - sy * arm);
    context.lineTo(vx, vy - sy * arm);
    context.closePath();
    context.fillStyle = handle.name === active ? "#fff" : "#ff9d42";
    context.fill();
    context.strokeStyle = "#3b2108";
    context.lineWidth = 1;
    context.lineJoin = "miter";
    context.stroke();
    context.restore();
  }
}
// The knob rides the actual top-right corner of the image being rotated
// (the rotated quad's corner, not any bounding box), so it stays physically
// attached and orbits with the image as the angle changes - the same mental
// model as grabbing an object's corner in a design tool.
function rotationAnchor(state, render) {
  const angle = (Number(value(state.node, "rotation_degrees", 0)) || 0) * Math.PI / 180;
  const centerX = render.sourceRect.x + render.sourceRect.width / 2;
  const centerY = render.sourceRect.y + render.sourceRect.height / 2;
  const halfWidth = state.sourceWidth * render.scale / 2;
  const halfHeight = state.sourceHeight * render.scale / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Unrotated top-right corner (+hw, -hh) rotated about the image center.
  const corner = {
    x: centerX + halfWidth * cos + halfHeight * sin,
    y: centerY + halfWidth * sin - halfHeight * cos,
  };
  const arm = render.layout?.rotateArm ?? 34;
  const center = { x: centerX, y: centerY };
  // While you turn it, the knob keeps the spot on its arm it had when you
  // grabbed it, so it turns with the picture; at rest it keeps clear of the
  // padding handles and crop squares, or the nearer one would take every
  // press.
  if (state.drag?.kind === "rotation") {
    const held = state.drag.canvas === render.canvas ? state.drag.knob : null;
    return { corner, handle: held ? knobAt(corner, center, held) : placeKnob(corner, center, arm) };
  }
  const offset = render.layout?.padOffset;
  const obstacles = [
    ...paddingHandleCenters(render.outputRect, offset).map((point) => ({ ...point, clearance: KNOB_CLEARANCE.padding })),
    ...canvasCornerCenters(render.outputRect, offset).map((point) => ({ ...point, clearance: KNOB_CLEARANCE.padding })),
    ...cropHandleCenters(render.cropRect).map((point) => ({ ...point, clearance: KNOB_CLEARANCE.crop })),
  ];
  return { corner, handle: placeKnob(corner, center, arm, obstacles, render.view, paddingRingGaps(render.outputRect, offset)) };
}
function rotationHandle(state, render) {
  return rotationAnchor(state, render).handle;
}
function drawRotationHandle(context, state, render, active) {
  const { corner, handle } = rotationAnchor(state, render);
  render.knob = handle;
  context.strokeStyle = "#73e36a";
  context.beginPath(); context.moveTo(corner.x, corner.y); context.lineTo(handle.x, handle.y); context.stroke();
  context.fillStyle = active ? "#fff" : "#73e36a";
  context.beginPath(); context.arc(handle.x, handle.y, 13, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "#173516"; context.stroke();
  drawRotateGlyph(context, handle.x, handle.y, 6, "#0c2210");
  if (!active) return;
  // Live readout while the knob is held, nudged to stay inside the stage.
  const degrees = Number(value(state.node, "rotation_degrees", 0)) || 0;
  const text = `${degrees.toFixed(1)}°`;
  context.save();
  context.font = "12px system-ui";
  const textWidth = context.measureText(text).width;
  const viewWidth = context.canvas.clientWidth || context.canvas.width;
  const viewHeight = context.canvas.clientHeight || context.canvas.height;
  const x = clamp(handle.x + 20, 8, Math.max(8, viewWidth - textWidth - 10));
  const y = clamp(handle.y - 20, 18, Math.max(18, viewHeight - 8));
  context.fillStyle = "rgba(8,10,12,0.85)";
  context.beginPath(); context.roundRect(x - 5, y - 13, textWidth + 10, 18, 6); context.fill();
  context.fillStyle = "#c9f2c4";
  context.fillText(text, x, y);
  context.restore();
}

// Vector rotate-arrow glyph (circular arc + arrowhead), crisp at any zoom
// and identical on every platform — no emoji font involved.
function drawRotateGlyph(context, x, y, radius, color) {
  const startAngle = -0.4 * Math.PI;
  const endAngle = 1.1 * Math.PI;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  context.lineCap = "round";
  context.beginPath();
  context.arc(x, y, radius, startAngle, endAngle);
  context.stroke();
  // Arrowhead at the arc's end, pointing along the direction of travel.
  const tipBase = { x: x + radius * Math.cos(endAngle), y: y + radius * Math.sin(endAngle) };
  const tangent = { x: -Math.sin(endAngle), y: Math.cos(endAngle) };
  const normal = { x: Math.cos(endAngle), y: Math.sin(endAngle) };
  context.beginPath();
  context.moveTo(tipBase.x + tangent.x * 4.6, tipBase.y + tangent.y * 4.6);
  context.lineTo(tipBase.x - tangent.x * 1.2 + normal.x * 3.1, tipBase.y - tangent.y * 1.2 + normal.y * 3.1);
  context.lineTo(tipBase.x - tangent.x * 1.2 - normal.x * 3.1, tipBase.y - tangent.y * 1.2 - normal.y * 3.1);
  context.closePath();
  context.fill();
  context.restore();
}

// One wiring for both stages (editor canvas and compact panel): pointer
// capture starts on handle hits only, empty presses fall through so the
// node itself can still drag, and pointercancel plus mouseleave both end a
// gesture in case the capture was refused.
function attachStageHandlers(state, canvas, signal) {
  canvas.addEventListener("pointerdown", (event) => pointerDown(state, canvas, event), { signal });
  canvas.addEventListener("pointermove", (event) => pointerMove(state, canvas, event), { signal });
  canvas.addEventListener("pointerup", (event) => pointerUp(state, canvas, event), { signal });
  canvas.addEventListener("pointercancel", (event) => pointerUp(state, canvas, event), { signal });
  canvas.addEventListener("mouseleave", (event) => {
    if (state.drag?.canvas === canvas) pointerUp(state, canvas, event);
    else canvas.style.cursor = "default";
    if (state.hoverMove?.canvas === canvas) { state.hoverMove = null; draw(state); }
  }, { signal });
}

function surfaceRender(state, canvas) {
  return canvas === state.previewCanvas ? state.panelRender : state.render;
}

// The single hit-test order both surfaces share; hit radii are ~2-3x the
// drawn handle so handles stay grabbable on the compact panel. The nearest
// handle wins; the order only settles an exact tie, corners before edges.
function handleGroups(state, render) {
  return [
    { kind: "rotation", priority: 0, radius: 24, handles: [{ name: "rotation", ...rotationHandle(state, render) }] },
    { kind: "corner", priority: 1, radius: 24, handles: canvasCornerCenters(render.outputRect, render.layout.padOffset) },
    { kind: "padding", priority: 2, radius: 24, handles: paddingHandleCenters(render.outputRect, render.layout.padOffset) },
    { kind: "crop", priority: 3, radius: 22, handles: cropHandleCenters(render.cropRect) },
  ];
}

// Alt-drag pans the editor, except on a corner handle: there Alt means
// "about the centre", as in drawing apps.
function pressOnCorner(state, canvas, event) {
  const render = surfaceRender(state, canvas);
  if (!render || event.button !== 0) return false;
  return nearestHandle(canvasLocalPoint(canvas, event), handleGroups(state, render))?.kind === "corner";
}

function pointerDown(state, canvas, event) {
  if (state.drag) return;
  const render = surfaceRender(state, canvas);
  if (canvas === state.canvas && (event.button === 1 || (event.altKey && !pressOnCorner(state, canvas, event)))) {
    state.drag = { kind: "pan", canvas, start: canvasLocalPoint(canvas, event), view: { ...state.view } };
  } else if (event.button === 0 && render) {
    const point = canvasLocalPoint(canvas, event);
    const selected = nearestHandle(point, handleGroups(state, render));
    const base = {
      canvas, start: point,
      // Everything a drag computes against, frozen at grab time (map plus
      // world snapshots) so a mid-gesture refit cannot move the target.
      map: { scale: render.scale, originX: render.originX, originY: render.originY, layout: render.layout },
      source: { ...render.source },
      center: { x: render.sourceRect.x + render.sourceRect.width / 2, y: render.sourceRect.y + render.sourceRect.height / 2 },
      crop: { ...render.crop },
      padding: { ...render.padding },
      pads: Object.fromEntries(["pad_left", "pad_top", "pad_right", "pad_bottom"].map((name) => [name, value(state.node, name, 0)])),
      rotation: Number(value(state.node, "rotation_degrees", 0)),
      // The shape the padlock holds for this gesture, taken as you grab.
      hold: heldRatio(state),
      cropHold: heldCropRatio(state),
    };
    // The knob's spot on its arm, kept while it turns.
    if (selected?.kind === "rotation") base.knob = knobOffset(rotationAnchor(state, render).corner, base.center, selected);
    if (selected) state.drag = { ...selected, ...base };
    else if (inside(point, render.cropRect) && anyRoom(moveRoomFor(state, render))) state.drag = { kind: "move", ...base };
  }
  // No hit: no capture and no preventDefault, so an empty press on the
  // panel falls through and the node drags as usual.
  if (!state.drag) return;
  if (state.drag.kind === "rotation") settleRotation(state);
  if (state.drag.kind === "corner") watchCornerKeys(state, state.drag);
  event.preventDefault(); event.stopPropagation();
  try { canvas.setPointerCapture(event.pointerId); } catch { /* mouse fallback */ }
  state.grid = state.drag.kind === "rotation";
  draw(state);
}

function pointerMove(state, canvas, event) {
  const point = canvasLocalPoint(canvas, event);
  const drag = state.drag;
  if (!drag || drag.canvas !== canvas) { updateCursor(state, canvas, point); return; }
  event.preventDefault();
  const dxScreen = point.x - drag.start.x; const dyScreen = point.y - drag.start.y;
  if (drag.kind === "pan") { state.view.panX = drag.view.panX + dxScreen; state.view.panY = drag.view.panY + dyScreen; }
  else if (drag.kind === "rotation") {
    // Followed move by move the short way round (knobStep), so the pointer
    // crossing the line left of the centre turns a step, not a whole turn.
    const angle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
    const previous = drag.angle ?? Math.atan2(drag.start.y - drag.center.y, drag.start.x - drag.center.x);
    drag.turned = (drag.turned ?? 0) + knobStep(previous, angle);
    drag.angle = angle;
    let degrees = drag.rotation + drag.turned * 180 / Math.PI;
    if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
    rotateTo(state, degrees);
  } else if (drag.kind === "crop") {
    const ratio = drag.cropHold ?? parseAspectRatio(value(state.node, "crop_aspect_ratio", "free"), drag.source);
    const next = resizeCrop(drag.crop, drag.name, dxScreen / drag.map.scale, dyScreen / drag.map.scale, drag.source, ratio);
    setCrop(state.node, next);
    if (aspectMode(state) === "pad") applyLock(state, drag.hold, cropDriver(drag.crop, next, drag.name), drag.pads);
  } else if (drag.kind === "move") {
    const crop = drag.crop;
    const dx = dxScreen / drag.map.scale; const dy = dyScreen / drag.map.scale;
    setCrop(state.node, { ...crop, x: Math.round(clamp(crop.x + dx, 0, drag.source.width - crop.width)), y: Math.round(clamp(crop.y + dy, 0, drag.source.height - crop.height)) });
    // Where the crop spans the whole picture it has nowhere to go: the
    // picture slides inside its padding instead, in a canvas that keeps
    // its size.
    const spans = { x: crop.width >= drag.source.width, y: crop.height >= drag.source.height };
    if (spans.x || spans.y) for (const [name, next] of Object.entries(slidePadding(drag.pads, dx, dy, spans))) setValue(state.node, name, next);
  } else if (drag.kind === "padding") {
    const delta = (drag.name === "pad_left" || drag.name === "pad_right" ? dxScreen : dyScreen) / drag.map.scale;
    const sign = drag.name === "pad_left" || drag.name === "pad_top" ? -1 : 1;
    let next = Math.max(0, Math.round(drag.padding[drag.name.replace("pad_", "")] + delta * sign));
    // Holding the shape, the handle stops where the other axis would need
    // negative padding; the other axis then follows.
    const ratio = drag.hold;
    // Solved from the padding the drag started with, so the other axis's
    // new bands split evenly however many moves the drag takes.
    const start = { ...values(state.node), ...drag.pads };
    if (ratio) next = Math.max(next, lockedPadMinimum(start, resolveCrop(start, drag.source), ratio, drag.name));
    setValue(state.node, drag.name, next);
    if (ratio) applyLock(state, ratio, paddingAxis(drag.name), { ...drag.pads, [drag.name]: next });
  } else if (drag.kind === "corner") {
    drag.moved = { x: dxScreen, y: dyScreen };
    applyCornerDrag(state, drag, event.altKey);
  }
  draw(state); updateModalInfo(state);
}

// A corner handle scales the canvas and keeps its shape, solved every move
// from the padding the drag began with (scaleCanvasPadding). The grabbed
// corner's two sides change; with Alt, all four do, about the centre.
function applyCornerDrag(state, drag, centre) {
  const moved = drag.moved ?? { x: 0, y: 0 };
  const width = drag.crop.width + nonNegative(drag.pads.pad_left) + nonNegative(drag.pads.pad_right);
  const height = drag.crop.height + nonNegative(drag.pads.pad_top) + nonNegative(drag.pads.pad_bottom);
  const scale = cornerScale(drag.corner, moved.x / drag.map.scale, moved.y / drag.map.scale, width, height, centre);
  drag.centre = Boolean(centre);
  for (const [name, next] of Object.entries(scaleCanvasPadding(drag.pads, drag.crop, drag.corner, scale, { centre }))) setValue(state.node, name, next);
}
function nonNegative(amount) { return Math.max(0, Math.round(Number(amount) || 0)); }

// Alt can be pressed or let go mid-drag, as in drawing apps: the corner
// switches between its two sides and all four without waiting for the
// pointer to move.
function watchCornerKeys(state, drag) {
  drag.keys = new AbortController();
  const toggle = (event) => {
    if (event.key !== "Alt" || state.drag !== drag) return;
    event.preventDefault();
    const centre = event.type === "keydown";
    if (drag.centre === centre) return;
    applyCornerDrag(state, drag, centre);
    draw(state); updateModalInfo(state);
  };
  window.addEventListener("keydown", toggle, { signal: drag.keys.signal, capture: true });
  window.addEventListener("keyup", toggle, { signal: drag.keys.signal, capture: true });
}

function pointerUp(state, canvas, event) {
  const drag = state.drag;
  if (!drag || drag.canvas !== canvas) return;
  const kind = drag.kind;
  drag.keys?.abort();
  state.drag = null; state.grid = false;
  if (kind === "rotation") settleRotation(state);
  // A shape the drag left is no longer the pick (the chip went dark).
  if (kind !== "pan") settleRequest(state);
  try { canvas.releasePointerCapture(event.pointerId); } catch {}
  draw(state); state.node.setDirtyCanvas?.(true, true);
  // Widgets were written throughout the drag; tell the tracker once, on
  // release. A pan only moves the view and serializes nothing.
  if (kind !== "pan") notifyQgChange();
}
function inside(point, rect) { return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height; }
function setCrop(node, crop) { setValue(node, "crop_x", crop.x); setValue(node, "crop_y", crop.y); setValue(node, "crop_width", crop.width); setValue(node, "crop_height", crop.height); }
function updateCursor(state, canvas, point) {
  const render = surfaceRender(state, canvas);
  if (!render) return;
  const selected = nearestHandle(point, handleGroups(state, render));
  const room = !selected && inside(point, render.cropRect) ? moveRoomFor(state, render) : null;
  // A corner shows the diagonal it scales along.
  const diagonal = selected?.kind === "corner" ? (selected.corner === "nw" || selected.corner === "se" ? "nwse-resize" : "nesw-resize") : null;
  canvas.style.cursor = selected?.kind === "rotation" ? "crosshair" : diagonal ?? (selected ? "grab" : room ? moveCursor(room) : "default");
  // Over the picture, small arrows point to the sides it can move toward.
  const hover = room && anyRoom(room) ? { canvas, room } : null;
  if (JSON.stringify(hover?.room ?? null) !== JSON.stringify(state.hoverMove?.room ?? null) || hover?.canvas !== state.hoverMove?.canvas) {
    state.hoverMove = hover;
    draw(state);
  }
}
function moveRoomFor(state, render) {
  return moveRoom(render.crop, render.source, values(state.node));
}
function anyRoom(room) { return Boolean(room && (room.left || room.right || room.up || room.down)); }
function wheelZoom(state, event) { event.preventDefault(); const point = canvasLocalPoint(state.canvas, event); state.view = zoomAround(state.view, state.view.zoom * Math.exp(-event.deltaY * 0.0015), point); draw(state); }

function updateModalInfo(state) {
  // The marker is written as dataset.qgStatus (= data-qg-status) further down;
  // the selector used to ask for data-qgtools-status, so the panel never filled.
  if (!state.modal || !state.sourceWidth) return; const status = state.modal.querySelector("[data-qg-status]"); if (!status) return;
  const frame = state.kind === "video" ? `\nFrame ${value(state.node, "frame_index", 0)} at ${Number(value(state.node, "frame_time", 0)).toFixed(3)}s` : "";
  // The newline stays outside the template: the zh plugin matches whole
  // strings, so a key with a leading \n could never be looked up.
  const grow = Number(value(state.node, "stitch_grow", 0));
  const stitch = widget(state.node, "stitch_blend")
    ? `\n${zh("Stitch blend {a} px").replace("{a}", String(value(state.node, "stitch_blend", 32)))}`
      + (grow ? zh(", grow {a} px").replace("{a}", String(grow)) : "")
    : "";
  status.textContent = `${sizeLines(state).join("\n")}${stitch}${frame}`;
}

// The output size in the order the run builds it, one step per line: the
// editor's status panel and the face readout's tooltip.
function sizeLines(state) {
  const current = values(state.node);
  const source = rotatedSize(state.sourceWidth, state.sourceHeight, current.rotation_degrees);
  const resize = resizeRequest(state.node);
  const chain = sizeChain(current, source, resize);
  const { added, trimmed } = alignChanges(chain);
  // One joined string in two places (the modal's status block and the face
  // readout's title), so the zh plugin can never match it line by line:
  // every line is composed through a zh() template instead.
  const lines = [
    zh("Source {a} x {b}").replace("{a}", String(state.sourceWidth)).replace("{b}", String(state.sourceHeight)),
    zh("Rotated {a} x {b}").replace("{a}", String(source.width)).replace("{b}", String(source.height)),
    zh("Crop {a}, {b}, {c} x {d}")
      .replace("{a}", String(chain.crop.x)).replace("{b}", String(chain.crop.y))
      .replace("{c}", String(chain.crop.width)).replace("{d}", String(chain.crop.height)),
    zh("Padding {a} / {b} / {c} / {d} → {e} x {f}")
      .replace("{a}", String(current.pad_left)).replace("{b}", String(current.pad_top))
      .replace("{c}", String(current.pad_right)).replace("{d}", String(current.pad_bottom))
      .replace("{e}", String(chain.padded.width)).replace("{f}", String(chain.padded.height)),
  ];
  const changes = [...added.map((text) => `+${text}`), ...trimmed.map((text) => `-${text}`)];
  lines.push(changes.length
    ? zh("Divisible by {a} → {b} x {c} ({d})")
      .replace("{a}", String(chain.multiple)).replace("{b}", String(chain.canvas.width))
      .replace("{c}", String(chain.canvas.height)).replace("{d}", changes.join(zhSep()))
    : zh("Canvas {a} x {b}").replace("{a}", String(chain.canvas.width)).replace("{b}", String(chain.canvas.height)));
  if (chain.resized) {
    const megapixels = (chain.resized.width * chain.resized.height / 1048576).toFixed(2);
    lines.push(zh("Resize {a} MP, steps {b} → {c} x {d} ({e} MP)")
      .replace("{a}", Number(resize.megapixels).toFixed(2)).replace("{b}", String(resize.steps))
      .replace("{c}", String(chain.resized.width)).replace("{d}", String(chain.resized.height))
      .replace("{e}", megapixels));
  }
  for (const warning of sizeChainTokens(chain).warnings) lines.push(`⚠ ${warning}`);
  if (chain.resized && changes.length) {
    lines.push(zh("With Resize on, Step already rounds the size: Divisible by 1 adds no fill and trims nothing."));
  }
  return lines;
}
function drawEmpty(state, text) { state.render = null; state.panelRender = null; syncReadout(state); for (const canvas of [state.canvas, state.previewCanvas]) { if (!canvas) continue; const prepared = prepareCanvas(canvas); drawEmptyCanvas(prepared.context, prepared.width, prepared.height, text); } }
// Canvas text never reaches the zh plugin's DOM translator, so the words are
// looked up here; a miss (an error message off the network, say) paints as-is.
function drawEmptyCanvas(context, width, height, text) { context.fillStyle = "#111"; context.fillRect(0, 0, width, height); context.fillStyle = "#9ba2aa"; context.font = "13px system-ui"; context.textAlign = "center"; context.fillText(zh(text), width / 2, height / 2); context.textAlign = "left"; }

// True when the node is an QG-tools transform node whose editor can open
// (installed by installTransformNode). Used by the pack-wide command.
export function openTransformEditorForNode(node) {
  const state = node?.__qgTransformState;
  if (!state) return false;
  openEditor(state);
  return true;
}

export function disposeTransformNode(node) {
  const state = node.__qgTransformState; if (!state) return; state.disposed = true; liveStates.delete(state); closeEditor(state); state.panelAbort?.abort(); state.panelResizeObserver?.disconnect(); state.frameController?.abort(); if (state.frameObjectUrl) URL.revokeObjectURL(state.frameObjectUrl);
  if (node.__qgImgsSuppressed) {
    const descriptor = node.__qgImgsDescriptor;
    if (descriptor) Object.defineProperty(node, "imgs", descriptor); else delete node.imgs;
    if (node.__qgAddCustomWidget) node.addCustomWidget = node.__qgAddCustomWidget;
    delete node.__qgImgsSuppressed;
    delete node.__qgImgsDescriptor;
    delete node.__qgAddCustomWidget;
  }
  delete node.__qgTransformState;
}

export function registerTransformExtension(nodeClass, kind, mountPanel = null) {
  app.registerExtension({
    // Frontend-only identifier; every extension this pack registers sits on
    // the `QG.` namespace so they list together. The prefix lives here rather
    // than in each node's entry file because this helper does the registering.
    name: `QG.transform.${nodeClass}`,
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== nodeClass) return;
      hideInputsInDef(nodeData, HIDDEN_WIDGETS);
      chainCallback(nodeType.prototype, "onNodeCreated", function () { installTransformNode(this, kind, mountPanel); });
      chainCallback(nodeType.prototype, "onRemoved", function () { disposeTransformNode(this); });
    },
  });
}
