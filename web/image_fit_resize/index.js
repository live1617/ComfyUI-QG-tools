// QG 图像适配缩放（Image Fit Resize）—— 前端：按「目标」只显示相关控件
//
// 后端 12 个控件平铺会很吓人，而且同一时刻只有一个模式在生效。这里按
// target_mode 收起无关的控件（与 AusBoss 的同类节点同款体验）：
//   megapixels                  → megapixels
//   longest_edge / shortest_edge → edge_length
//   width_height                → width / height / keep_proportion
//                                 （pad 时再加 fill_color；cover_crop / pad 时再加 anchor）
//   scale_factor                → scale_factor
// 常显：target_mode / divisible_by / interpolation。
// anchor 只在「有富余空间」的两种策略下出现：stretch 铺满无富余、fit 输出贴合尺寸，
// 两者都没有可锚的那条带子，露出来只会让人以为它有作用。
// 隐藏只收起渲染，值仍在 widgets_values 里 —— 存档、撤销、API 导出都不变
// （shared/widget_visibility.mjs 的两套渲染器兼容都在那边处理了）。

import { app } from "/scripts/app.js";
import { setWidgetVisible } from "../shared/widget_visibility.mjs?v=202611132008";

const NODE_TYPE = "QG_ImageFitResize";

const MODE_WIDGETS = {
  megapixels: ["megapixels"],
  longest_edge: ["edge_length"],
  shortest_edge: ["edge_length"],
  width_height: ["width", "height", "keep_proportion"],
  scale_factor: ["scale_factor"],
};

const ALL_MODE_WIDGETS = ["megapixels", "edge_length", "width", "height", "scale_factor",
                         "keep_proportion", "fill_color", "anchor"];
const ALWAYS = ["target_mode", "divisible_by", "interpolation"];

function widgetOf(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

// 当前模式下每个控件的可见性。
function visibilityFor(mode, proportion) {
  const shown = new Set([...ALWAYS, ...(MODE_WIDGETS[mode] ?? MODE_WIDGETS.megapixels)]);
  // 填充色只在「宽度×高度 + 填充」这一种组合下才有意义
  if (mode === "width_height" && proportion === "pad") shown.add("fill_color");
  // 锚点只在裁剪 / 补边时有效（拉伸与适应画布没有富余空间可锚）
  if (mode === "width_height" && (proportion === "cover_crop" || proportion === "pad")) {
    shown.add("anchor");
  }
  const out = {};
  for (const name of ALL_MODE_WIDGETS) out[name] = shown.has(name);
  return out;
}

function applyVisibility(node, { resize = true } = {}) {
  const mode = String(widgetOf(node, "target_mode")?.value ?? "megapixels");
  const proportion = String(widgetOf(node, "keep_proportion")?.value ?? "fit");
  const want = visibilityFor(mode, proportion);
  let changed = false;
  for (const [name, visible] of Object.entries(want)) {
    const widget = widgetOf(node, name);
    if (widget && setWidgetVisible(widget, visible)) changed = true;
  }
  if (changed && resize) {
    // 控件行数变了，节点高度跟着收放（宽度不动）
    const natural = node.computeSize?.()[1];
    if (natural) node.setSize?.([node.size[0], natural]);
  }
  app.graph?.setDirtyCanvas?.(true, true);
  return changed;
}

app.registerExtension({
  name: "QG.ImageFitResize",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      const node = this;

      for (const name of ["target_mode", "keep_proportion"]) {
        const widget = widgetOf(node, name);
        if (!widget) continue;
        const original = widget.callback;
        widget.callback = function () {
          const out = original?.apply(this, arguments);
          applyVisibility(node);
          return out;
        };
      }

      // 首帧再收一次：有的前端在 onNodeCreated 之后还会重建 options
      requestAnimationFrame(() => applyVisibility(node, { resize: true }));
      return result;
    };

    // 工作流读档走 configure，不走 callback —— 原型级补一次（只在注册时包一层）
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const out = configured?.apply(this, arguments);
      applyVisibility(this);
      return out;
    };
  },
});
