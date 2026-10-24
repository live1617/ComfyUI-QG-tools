// Run Timer 🆎 — a stopwatch for the whole queue, drawn as one black readout.
//
// The node IS the display: no title bar, no slots, no padding. On the
// classic canvas the readout is painted by the node itself (onDrawForeground)
// - no DOM widget, so the pointer lands on the canvas everywhere (drag from
// anywhere, native resize, right-click) and the box is exactly the node.
// The Nodes 2.0 renderer does not run canvas paint, so there the same
// readout mounts as a DOM widget instead.
//
// It listens to the api's execution events; a run starts the clock, ticks
// it, and the total holds when the run ends. Completed totals go into
// node.properties so a saved workflow reopens showing its author's time.
// Decision logic lives in web/shared/run_timer.mjs under node:test.

import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, zh } from "../shared/index.mjs?v=2026102418";
import { holdNodeMinWidth } from "../shared/panel_layout.mjs?v=2026102418";
import {
  detachDomWidget,
  installModeWatcher,
} from "../shared/vue_mode.mjs?v=2026102418";
import {
  cachedLayer,
  createTimer,
  formatElapsed,
  layerScale,
  startTimer,
  stopTimer,
  tickTimer,
} from "../shared/run_timer.mjs?v=2026102418";

const NODE_CLASS = "QG_RunTimer";
const CSS_ID = "qgtools-run-timer-css";
const WIDGET_NAME = "qg_run_timer_panel";
const PROPERTY = "qg_run_timer"; // { history: [seconds, newest first] }
const BASE_WIDTH = 176;
const BASE_HEIGHT = 56;
const MIN_WIDTH = 110;
const TICK_MS = 100;
const NO_TITLE = globalThis.LiteGraph?.NO_TITLE ?? 1;
const READOUT_COLOR = "#07090a";
const TEAL = "#2ee8dc";
const AMBER = "#ffd166";
const RED = "#ff5c4d";
const DIM = "#3d5a58";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// ---------------------------------------------------------------------------
// Shared state and events
// ---------------------------------------------------------------------------

function savedHistory(node) {
  const stored = node.properties?.[PROPERTY];
  return Array.isArray(stored?.history) ? stored.history : [];
}

// "1:05" + ".3", or "12" + ".3" + "s": the whole seconds carry the weight,
// the tenths ride small beside them, hours fold in as h:mm:ss.
function splitDigits(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return { main: "0", tenths: ".0", unit: "s" };
  const whole = Math.floor(seconds);
  const tenths = `.${Math.floor((seconds - whole) * 10)}`;
  if (whole < 60) return { main: String(whole), tenths, unit: "s" };
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  if (hours) return { main: `${hours}:${String(minutes).padStart(2, "0")}:${rest}`, tenths: "", unit: "" };
  return { main: `${minutes}:${rest}`, tenths, unit: "" };
}

// What the readout shows right now: the digits, the LED status and the
// digit color - one place, shared by the canvas paint and the DOM panel.
function readout(state) {
  const { timer } = state;
  const hasRun = timer.running || timer.outcome !== null || timer.history.length > 0;
  const shown = timer.running || timer.outcome ? timer.elapsed : timer.history[0];
  const parts = splitDigits(hasRun ? shown : 0);
  let led = "idle";
  if (timer.running) led = "running";
  else if (timer.outcome) led = timer.outcome;
  else if (hasRun) led = "done";
  const failed = timer.outcome === "error" || timer.outcome === "interrupted";
  return { ...parts, led, color: failed ? "#ff8a7d" : hasRun ? TEAL : DIM, hasRun };
}

function stopTicking(state) {
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}

function finish(state, outcome) {
  if (!state.timer.running) return;
  stopTicking(state);
  state.timer = stopTimer(state.timer, performance.now(), outcome);
  if (outcome === "done") {
    state.node.properties ??= {};
    state.node.properties[PROPERTY] = { history: state.timer.history };
  }
  state.render();
}

function begin(state) {
  stopTicking(state);
  state.timer = startTimer(state.timer, performance.now());
  state.render();
  state.interval = setInterval(() => {
    state.timer = tickTimer(state.timer, performance.now());
    state.render();
  }, TICK_MS);
}

function listen(state) {
  const { signal } = state.abort;
  api.addEventListener("execution_start", () => begin(state), { signal });
  api.addEventListener("execution_success", () => finish(state, "done"), { signal });
  api.addEventListener("execution_error", () => finish(state, "error"), { signal });
  api.addEventListener("execution_interrupted", () => finish(state, "interrupted"), { signal });
}

// 切渲染模式会换掉 state（连同它的 interval），但计时本身不能断：
// 把 timer 搬过去、把心跳接上就行 —— timer 是纯数据，startedAt 还有效。
function resumeTicking(state) {
  if (!state.timer.running || state.interval) return;
  state.interval = setInterval(() => {
    state.timer = tickTimer(state.timer, performance.now());
    state.render();
  }, TICK_MS);
}

// The frontend hangs a "which pack" badge above every custom node; on a
// title-less readout it floats in space. An empty badges list draws none.
function suppressBadges(node) {
  try {
    Object.defineProperty(node, "badges", {
      configurable: true,
      get: () => [],
      set: () => {},
    });
  } catch {
    node.badges = [];
  }
}

function paintBlack(node) {
  node.color = READOUT_COLOR;
  node.bgcolor = READOUT_COLOR;
}

function usesVueNodes() {
  try {
    return app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled") === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Classic canvas: the node paints its own readout
// ---------------------------------------------------------------------------

function ledColor(status) {
  if (status === "running") return AMBER;
  if (status === "done") return TEAL;
  if (status === "error" || status === "interrupted") return RED;
  return "#2b3336";
}

// Glow as a blurred underlay pass, not a canvas shadow: LiteGraph leaves
// shadow offsets set from painting the node body, and a shadow drawn on
// top of that lands as a displaced copy of every glyph.
function glowText(ctx, text, x, y, color, radius) {
  if (radius <= 0 || !("filter" in ctx)) return;
  ctx.save();
  ctx.filter = `blur(${radius}px)`;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Every blurred pass - the LED halo and the digit glow - painted into the
// small cached layer (cachedLayer), never onto the graph canvas itself.
// A filter blur works in device pixels, so the radii are not scaled.
function paintGlow(ctx, view, layout, led, pulse) {
  const { s, ledX, ledY, x0, baseline, mainW, fontBig, fontSmall, glow } = layout;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if (view.led !== "idle") {
    ctx.save();
    ctx.filter = `blur(${4 * s}px)`;
    ctx.globalAlpha = 0.9 * pulse;
    ctx.fillStyle = led;
    ctx.beginPath();
    ctx.arc(ledX, ledY, 4.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.font = fontBig;
  glowText(ctx, view.main, x0, baseline, view.color, glow);
  if (view.tenths) {
    ctx.font = fontSmall;
    glowText(ctx, view.tenths, x0 + mainW, baseline, view.color, glow * 0.8);
  }
}

function drawGlow(ctx, state, view, layout, led, pulse) {
  if (view.led === "idle" && !layout.glow) return;
  const [w, h] = layout.size;
  const m = ctx.getTransform?.();
  const scale = layerScale(m ? Math.hypot(m.a, m.b) : 1, w);
  const pad = Math.ceil(15 * layout.s); // three blur radii of spill room
  const key = [view.main, view.tenths, view.unit, view.color, view.led, pulse, w, h, scale].join("|");
  const layer = cachedLayer(state.glow, key, w * scale + 2 * pad, h * scale + 2 * pad, (g) => {
    g.setTransform(scale, 0, 0, scale, pad, pad);
    paintGlow(g, view, layout, led, pulse);
  }, () => document.createElement("canvas"));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer, -pad / scale, -pad / scale, layer.width / scale, layer.height / scale);
}

function drawReadout(node, ctx, state) {
  const [w, h] = node.size;
  const s = h / BASE_HEIGHT;
  const view = readout(state);
  const big = Math.max(10, Math.round(28 * s));
  const small = Math.max(7, Math.round(15 * s));
  const tiny = Math.max(6, Math.round(10 * s));
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // digits, measured then centred in the space right of the LED
  const fontBig = `700 ${big}px ${MONO}`;
  const fontSmall = `600 ${small}px ${MONO}`;
  const fontTiny = `500 ${tiny}px ${MONO}`;
  ctx.font = fontBig;
  const mainW = ctx.measureText(view.main).width;
  ctx.font = fontSmall;
  const tenthsW = view.tenths ? ctx.measureText(view.tenths).width : 0;
  ctx.font = fontTiny;
  const unitW = view.unit ? ctx.measureText(view.unit).width + 3 * s : 0;
  const total = mainW + tenthsW + unitW;
  const left = 22 * s;
  const x0 = left + Math.max(0, (w - left - 8 * s - total) / 2);
  const baseline = h / 2 + big * 0.36;
  const glow = view.hasRun ? 5 * s : 0;

  // LED and digit glow from the cached layer, then the crisp LED dot. The
  // pulse is quantised so a held LED reuses the layer frame after frame.
  const led = ledColor(view.led);
  const pulse = view.led === "running"
    ? Math.round((0.55 + 0.45 * Math.sin(performance.now() / 160)) * 20) / 20
    : 1;
  const ledX = 12 * s;
  const ledY = h / 2;
  const layout = { size: [w, h], s, ledX, ledY, x0, baseline, mainW, fontBig, fontSmall, glow };
  drawGlow(ctx, state, view, layout, led, pulse);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = led;
  ctx.beginPath();
  ctx.arc(ledX, ledY, 3.2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = fontBig;
  ctx.fillStyle = view.color;
  ctx.fillText(view.main, x0, baseline);
  let x = x0 + mainW;
  if (view.tenths) {
    ctx.font = fontSmall;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = view.color;
    ctx.fillText(view.tenths, x, baseline);
    ctx.globalAlpha = 1;
    x += tenthsW;
  }
  if (view.unit) {
    ctx.font = fontTiny;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = view.color;
    ctx.fillText(view.unit, x + 3 * s, baseline);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// Width is the handle, height follows. During a corner drag LiteGraph
// writes node.size directly on every move and calls onResize once at
// most, so this runs from the draw path as well: a tall or squat box is
// corrected before the next frame, the way Pixaroma's clock snaps back.
function keepAspect(node) {
  const width = Math.max(MIN_WIDTH, Math.round(node.size?.[0] ?? BASE_WIDTH));
  const height = Math.round((width * BASE_HEIGHT) / BASE_WIDTH);
  if (node.size[0] === width && node.size[1] === height) return false;
  // setSize is the frontend's sanctioned write (it runs onResize); the
  // equality check above is what stops that callback from recursing.
  if (typeof node.setSize === "function") node.setSize([width, height]);
  else node.size = [width, height];
  return true;
}

// 切渲染模式时把计时搬过去：state 会被丢掉，timer 不能跟着丢
// （正在跑的那一轮，elapsed 就断了）。
function takeTimer(node) {
  const carried = node.__qgTimerCarry;
  node.__qgTimerCarry = null;
  return carried && typeof carried === "object" ? carried : createTimer(savedHistory(node));
}

function installCanvasReadout(node) {
  if (node.__qgRunTimer) return node.__qgRunTimer;
  node.flags ??= {};
  node.flags.no_title = true;
  suppressBadges(node);
  paintBlack(node);
  installCanvasHooks(node);
  const state = (node.__qgRunTimer = {
    node, abort: new AbortController(), interval: null, mode: "canvas",
    timer: takeTimer(node), glow: {},
    render: () => node.setDirtyCanvas?.(true, false),
  });
  // Width is the handle: drag the corner and the readout scales with it.
  // computeSize is the MINIMUM the canvas will let a drag reach - it must
  // never echo the current size, or the node can only ever grow.
  node.resizable = true;
  // 原样存一份：切到 Nodes 2.0 时要还回去，否则 DOM 那条路被这个常量最小尺寸压着。
  node.__qgOrigComputeSize ??= node.computeSize;
  node.computeSize = () => [MIN_WIDTH, Math.round((MIN_WIDTH * BASE_HEIGHT) / BASE_WIDTH)];
  // A saved workflow overwrites this in onConfigure; a fresh node starts here.
  node.size = [BASE_WIDTH, BASE_HEIGHT];
  listen(state);
  resumeTicking(state);
  return state;
}

// 🔴 画布钩子只装一次：chainCallback 摘不掉，而切渲染模式会反复 install/uninstall，
//    每切一次再包一层的话，onDrawForeground 会把读数画两遍。
//    钩子只跟节点挂钩，装完靠自己看 mode 短路。
function installCanvasHooks(node) {
  if (node.__qgRunTimerHooks) return;
  node.__qgRunTimerHooks = true;
  const canvasMode = (n) => n.__qgRunTimer?.mode === "canvas";

  chainCallback(node, "onResize", function () {
    if (!canvasMode(this)) return;
    keepAspect(this);
  });

  chainCallback(node, "onDrawForeground", function (ctx) {
    if (!canvasMode(this) || this.flags?.collapsed) return;
    // The body was already painted at whatever size the drag left; fix
    // the size now and ask for one more frame so the box catches up.
    if (keepAspect(this)) this.setDirtyCanvas?.(true, false);
    // state 随模式重建，所以现取，别闭包捕获
    drawReadout(this, ctx, this.__qgRunTimer);
  });
}

// ---------------------------------------------------------------------------
// Nodes 2.0 fallback: the same readout as a DOM panel
// ---------------------------------------------------------------------------

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-timer{box-sizing:border-box;width:100%;height:100%;pointer-events:none;overflow:hidden;}
.qgtools-timer-box{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:100%;padding:0 12px;overflow:hidden;border-radius:9px;background:${READOUT_COLOR};}
.qgtools-timer-led{flex:none;width:7px;height:7px;border-radius:50%;background:#2b3336;}
.qgtools-timer-led.running{background:${AMBER};box-shadow:0 0 8px rgba(255,209,102,.9);animation:qgtools-timer-pulse 1s ease-in-out infinite;}
.qgtools-timer-led.done{background:${BRAND};box-shadow:0 0 8px rgba(0,180,170,.8);}
.qgtools-timer-led.error,.qgtools-timer-led.interrupted{background:${RED};box-shadow:0 0 8px rgba(255,92,77,.8);}
@keyframes qgtools-timer-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.qgtools-timer-digits{display:flex;align-items:baseline;color:${TEAL};font:700 28px/1 ${MONO};font-variant-numeric:tabular-nums;letter-spacing:.02em;text-shadow:0 0 12px rgba(46,232,220,.35);white-space:nowrap;}
.qgtools-timer-digits.idle{color:${DIM};text-shadow:none;}
.qgtools-timer-digits.error{color:#ff8a7d;text-shadow:0 0 12px rgba(255,92,77,.35);}
.qgtools-timer-digits .tenths{font-size:15px;margin-left:2px;opacity:.78;}
.qgtools-timer-digits .unit{font-size:10px;margin-left:5px;letter-spacing:.12em;opacity:.55;}
/* Nodes 2.0 only: the Vue node wraps this panel in a 225px-minimum body and
   hangs its own pack badge in a footer row; the readout is the whole node. */
.lg-node:has(.qgtools-timer){min-width:0!important;}
.lg-node:has(.qgtools-timer) .bg-component-node-background>div:last-child{display:none;}
`;
  document.head.appendChild(style);
}

function installDomReadout(node) {
  if (node.__qgRunTimer) return node.__qgRunTimer;
  ensureCss();
  node.flags ??= {};
  node.flags.no_title = true;
  suppressBadges(node);
  paintBlack(node);

  const root = document.createElement("div");
  root.className = "qgtools-timer";
  const box = document.createElement("div");
  box.className = "qgtools-timer-box";
  const led = document.createElement("span");
  led.className = "qgtools-timer-led";
  const digits = document.createElement("span");
  digits.className = "qgtools-timer-digits idle";
  const main = document.createElement("span");
  const tenths = document.createElement("span");
  tenths.className = "tenths";
  const unit = document.createElement("span");
  unit.className = "unit";
  digits.append(main, tenths, unit);
  box.append(led, digits);
  root.append(box);

  const widget = node.addDOMWidget(WIDGET_NAME, "qg_run_timer", root, {
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => BASE_HEIGHT,
  });
  keepDomWidgetWidthAuto(widget);
  // Not saved with the workflow either: options.serialize only keeps it out
  // of the prompt, and saved values come back by position.
  widget.serialize = false;
  // A constant-height readout, not a viewport: pinned on purpose (see
  // tests/panel_guards.test.mjs, fixedByDesign).
  widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || node.size?.[0] || BASE_WIDTH)), BASE_HEIGHT];
  widget.computeLayoutSize = () => ({ minWidth: MIN_WIDTH, minHeight: BASE_HEIGHT });
  widget.options.minNodeSize = [MIN_WIDTH, BASE_HEIGHT];
  holdNodeMinWidth(widget, MIN_WIDTH);

  const state = (node.__qgRunTimer = {
    node, abort: new AbortController(), interval: null, mode: "dom",
    timer: takeTimer(node), root, widget,
    render: () => {
      const view = readout(state);
      main.textContent = view.main;
      tenths.textContent = view.tenths;
      unit.textContent = view.unit;
      led.className = `qgtools-timer-led ${view.led === "idle" ? "" : view.led}`;
      digits.className = "qgtools-timer-digits";
      if (!view.hasRun) digits.classList.add("idle");
      if (view.led === "error" || view.led === "interrupted") digits.classList.add("error");
    },
  });
  state.render();
  listen(state);
  resumeTicking(state);
  return state;
}

function install(node) {
  const state = usesVueNodes() ? installDomReadout(node) : installCanvasReadout(node);
  if (state) node.__qgSyncMode = () => syncTimerMode(node);
  return state;
}

// ---------------------------------------------------------------- 渲染模式迁移
//
// install 只在新建 / 读档时按当时模式装一次，切渲染模式时卡片不跟着换。
// 迁移时要把「正在跑的计时」带过去，见 takeTimer。
function uninstall(node) {
  const state = node.__qgRunTimer;
  if (!state) return;
  node.__qgRunTimer = null;
  node.__qgTimerCarry = state.timer;
  stopTicking(state);
  try { state.abort.abort(); } catch { /* 忽略 */ }
  if (state.mode === "dom") {
    detachDomWidget(node, state.widget, state.root);
    state.widget = null;
    state.root = null;
  }
  // 画布钩子摘不掉，只把被它改过的实例字段还回去
  if (node.__qgOrigComputeSize) node.computeSize = node.__qgOrigComputeSize;
}

function syncTimerMode(node) {
  const want = usesVueNodes() ? "dom" : "canvas";
  if (node.__qgRunTimer?.mode !== want) {
    uninstall(node);
    install(node);
  }
  return node.__qgRunTimer;
}

app.registerExtension({
  name: "QG.RunTimer",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    // Set once on the TYPE at registration: the classic renderer reads it
    // per draw, and the Nodes 2.0 renderer snapshots it when the node is
    // created, so a per-node write would come too late there.
    nodeType.title_mode = NO_TITLE;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      install(this);
    });
    chainCallback(nodeType.prototype, "onConfigure", function () {
      // Saved properties land after onNodeCreated: pick the history up then,
      // and keep the readout black however the save was colored.
      queueMicrotask(() => {
        // syncTimerMode 而不是 install：读档时渲染模式可能跟建节点那一刻不同
        // （同一个工作流在两种模式下打开过），顺手校正到当前模式。
        const state = syncTimerMode(this);
        if (!state) return;
        if (!state.timer.running) state.timer = createTimer(savedHistory(this));
        this.flags.no_title = true;
        paintBlack(this);
        if (state.mode === "canvas") keepAspect(this);
        state.render();
      });
    });
    chainCallback(nodeType.prototype, "getExtraMenuOptions", function (_canvas, options) {
      const state = this.__qgRunTimer;
      if (!state || !Array.isArray(options)) return;
      // Built at click time, so the translation plugin's DOM watcher never
      // sees it - these three go through zh() like every other composed
      // string. The history is a joined list, so it rides the {a} slot.
      const previous = state.timer.history.slice(0, 5).map(formatElapsed).join(" · ");
      options.unshift(
        {
          content: previous
            ? zh("Runs: {a}").replace("{a}", previous)
            : zh("No completed runs yet"),
          disabled: true,
        },
        {
          content: zh("Reset Run Timer history"),
          callback: () => {
            state.timer = createTimer([]);
            this.properties ??= {};
            this.properties[PROPERTY] = { history: [] };
            state.render();
          },
        },
        null,
      );
    });
    chainCallback(nodeType.prototype, "onRemoved", function () {
      const state = this.__qgRunTimer;
      if (!state) return;
      stopTicking(state);
      state.abort.abort();
      this.__qgRunTimer = null;
    });
  },

  async setup() {
    installModeWatcher((node) => {
      if (String(node?.comfyClass ?? node?.type ?? "") !== NODE_CLASS) return null;
      if (typeof node.__qgSyncMode !== "function") {
        node.__qgSyncMode = () => syncTimerMode(node);
      }
      return node.__qgSyncMode;
    });
  },
});
