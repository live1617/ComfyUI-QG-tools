import { TRANSFORM_MIN_WIDTH, registerTransformExtension, transformPanelFloor } from "../shared/transform_editor.mjs?v=2026102571";
import { chainCallback, keepDomWidgetWidthAuto } from "../shared/index.mjs?v=2026102571";
import { fillNodeHeight } from "../shared/panel_layout.mjs?v=2026102571";
import { fitNodeToPanelHeight, unwatchVueShell, watchVueShell } from "../shared/vue_panel_fit.mjs?v=2026102571";

const PANEL_MIN_WIDTH = TRANSFORM_MIN_WIDTH;

// Guard rule the DOM-panel audit (tests/panel_guards.test.mjs) checks next
// to the addDOMWidget call: padding stays inside the widget's box and
// oversized content clips at the panel edge instead of escaping the node.
// The shared transform stylesheet carries the same declarations; this rule
// keeps them greppable beside the mount that depends on them.
const GUARD_CSS_ID = "qgtools-transform-panel-guards";
const GUARD_CSS = ".qgtools-transform-panel{box-sizing:border-box;overflow:hidden}";

function mountTransformPanel(node, panel) {
  if (!document.getElementById(GUARD_CSS_ID)) {
    const style = document.createElement("style");
    style.id = GUARD_CSS_ID;
    style.textContent = GUARD_CSS;
    document.head.appendChild(style);
  }
  const widget = node.addDOMWidget("qg_transform_preview", "qg_transform_preview", panel, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => transformPanelFloor(node),
  });
  keepDomWidgetWidthAuto(widget);
  // Not saved with the workflow either: options.serialize only keeps it out
  // of the prompt, and saved values come back by position.
  widget.serialize = false;
  // The stage's floor follows its width (transformPanelFloor), as on the
  // video nodes: the picture never shrinks to a thumbnail.
  fillNodeHeight(widget, {
    minWidth: PANEL_MIN_WIDTH,
    minHeight: () => transformPanelFloor(node),
    minNodeSize: [PANEL_MIN_WIDTH, 470],
    exactMinWidth: true,
  });
  // Nodes 2.0：这个节点有一大把输入槽，Vue 里槽行 + 内边距比经典版式多吃 37px，
  // 可面板自己带着 fillNodeHeight 写的 min-height 地板（舞台不能缩成一条线），
  // 夹面板夹不下来。反过来让 size 跟上外壳的实测高度：外壳被地板卡住时
  // size 会收敛到「chrome + 地板 − 标题栏」，用户再拖高则两边一起长，始终对齐。
  const panelOf = () => node.widgets?.find((w) => w.name === "qg_transform_preview")?.element ?? panel;
  watchVueShell(node, panelOf, () => fitNodeToPanelHeight(node, panelOf(), (node.__qgCropFit ??= {})));
  chainCallback(node, "onRemoved", () => unwatchVueShell(node));
  return widget;
}

registerTransformExtension("QG_ImageCropRotatePad", "image", mountTransformPanel);
