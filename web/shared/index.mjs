// Shared helpers for ComfyUI-QG-tools frontend extensions.
//
// .mjs files under web/ are NOT auto-loaded by ComfyUI (only .js files are),
// which makes this the right home for import-only utilities. Per-node
// entry points live in web/<node>/index.js and import from here.

import { app } from "/scripts/app.js";
import { zh } from "./zh.mjs?v=2026101403";

// Re-exported so node entry points keep a single shared import path.
export { zh, zhOn, zhCount, zhSep, zhEnd } from "./zh.mjs?v=2026101403";

// Kept in lockstep with __version__ in the pack's __init__.py by hand.
// The backend does not serve a matching version endpoint here, so this
// is informational: bump it if the frontend and backend drift apart.
export const QG_JS_VERSION = "0.4.0";

export const BRAND = "#00b4aa"; // QG-tools teal — keep node accents consistent.
export const BRAND_DARK = "#007f78";
export const BRAND_BODY = "#081413";

// Wrap a LiteGraph prototype callback without clobbering whoever hooked it
// first. Other node packs patch the same prototypes, so never assign
// `proto[name] = fn` directly — always chain.
export function chainCallback(proto, name, fn) {
  const prior = proto[name];
  proto[name] = function (...args) {
    const result = prior?.apply(this, args);
    fn.apply(this, args);
    return result;
  };
}

// chainCallback for handlers whose truthy return tells LiteGraph the event
// was consumed (onMouseDown skips the node drag): the chain reports consumed
// when either handler did. chainCallback would drop this handler's verdict.
export function chainHandler(proto, name, fn) {
  const prior = proto[name];
  proto[name] = function (...args) {
    const result = prior?.apply(this, args);
    const handled = fn.apply(this, args);
    return result || handled;
  };
}

// Every node this pack ships, matched by ID prefix so a node added
// later as QG_* is recognized without touching this list.
export function isQgNode(node) {
  const comfyClass = node?.comfyClass || "";
  return comfyClass.startsWith("QG_");
}

// One toast for every QG-tools message. The frontend's toast store queues a
// PrimeVue toast; a frontend without one gets the console instead, and this
// never throws - a message must not break the action that raised it.
// Summary/detail go through zh() because PrimeVue toasts render inside the
// app root, where the zh DOM translator's observer never looks; see zh.mjs.
export function showToast({ detail, severity = "info", summary = "QG-tools", life = 5000 } = {}) {
  const title = zh(summary);
  const body = zh(detail);
  try {
    const toast = app?.extensionManager?.toast;
    if (typeof toast?.add === "function") {
      toast.add({ severity, summary: title, detail: body, life });
      return;
    }
  } catch (_error) {
    // Toast store missing or incompatible: fall through to the console.
  }
  const line = `[QG-tools] ${summary === "QG-tools" ? "" : `${title}: `}${body}`;
  if (severity === "error" || severity === "warn") console.warn(line);
  else console.log(line);
}

// ComfyUI's undo/dirty tracker snapshots the graph on canvas mouse-up, but
// our DOM panels commit widget values and node.properties from click/change/
// pointerup handlers that run one phase later. Without a nudge those edits
// never mark the workflow modified and never enter undo history. Call this
// once per user gesture, AFTER the write has landed — and never from a
// workflow-load path, which must stay clean.
//
// The trailing timer batches a gesture's writes into a single snapshot and
// guarantees the capture runs after the handler that invoked us returned.
// A capture that finds nothing changed is a no-op inside the tracker.
let qgChangeTimer = null;

export function notifyQgChange() {
  if (qgChangeTimer) clearTimeout(qgChangeTimer);
  qgChangeTimer = setTimeout(() => {
    qgChangeTimer = null;
    try {
      const workflow =
        app?.extensionManager?.workflow?.activeWorkflow ??
        app?.workflowManager?.activeWorkflow;
      const tracker = workflow?.changeTracker;
      if (!tracker) return;
      if (typeof tracker.captureCanvasState === "function") tracker.captureCanvasState();
      else tracker.checkState?.();
    } catch (_error) {
      // Best effort: the widget write itself already succeeded, and a
      // frontend rename must never break the control that called us.
    }
  }, 120);
}


// The frontend sizes a DOM widget's wrapper as `widget.width ?? node.width`
// (GraphView, useDomWidget's updateWidgets). LiteGraph's layout plants
// widget.width during draws, and once planted it OUTRANKS the node width
// forever: resize the node narrower and the wrapper keeps the old width,
// parking the panel's right edge outside the node. The overflow clip cannot
// help - it clips at the wrapper's edge, which is the thing that is too
// wide. Discarding every write keeps the lookup on its node-width fallback,
// so the wrapper tracks the node in both directions for the life of the
// widget. Call it on every DOM widget right after addDOMWidget.
export function keepDomWidgetWidthAuto(widget) {
  if (!widget) return widget;
  try {
    Object.defineProperty(widget, "width", {
      get() {
        return undefined;
      },
      set(_value) {
        /* a planted layout width must never outrank the node */
      },
      configurable: true,
    });
  } catch (_error) {
    // A frozen widget object keeps its old behavior; nothing to break.
  }
  return widget;
}
