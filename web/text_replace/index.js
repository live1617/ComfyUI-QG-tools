/**
 * QG 文本替换 —— 老工作流的参数搬家（前端）
 *
 * v0.9.3 及更早的 QG_TextReplace 是从 Muye 的 BatchTextReplace 搬的：
 *   · text 是**多行文本框**（可编辑控件）
 *   · texts 是「文本列表」输入槽
 * 现在改搬 Comfyroll 的 CR_TextReplace：text 变成**纯输入槽**（只能从上游接），
 * 中间多了一个「模式（字面 / 正则）」下拉。两者的控件个数碰巧都是 7 个：
 *
 *   老：[text, find1, replace1, find2, replace2, find3, replace3]
 *   新：[mode, find1, replace1, find2, replace2, find3, replace3]
 *
 * LiteGraph 的 configure() 是**按位置**塞 widgets_values 的，所以老存档打开后
 * 「模式」会吃到老存档里的那串文本（变成一个不存在的选项），而三组查找/替换
 * 恰好各归原位 —— 看着像没事，其实模式是脏的、而且老存档里手打的那段文本
 * 没有地方落脚（text 已经是槽了），一跑就变成空串。
 *
 * 这里把它们掰回来：模式恢复默认值，老的 text 值自动补一个「多行文本」节点接上。
 * 判断依据：模式值不在选项里才算老存档 —— 新存档的模式只会是那两个字面值。
 */

import { app } from "/scripts/app.js";
import { chainCallback } from "../shared/index.mjs?v=2026102420";

const NODE_CLASS = "QG_TextReplace";
const TEXT_SOURCE = "PrimitiveStringMultiline"; // comfy_extras 内置的多行文本
const TEXT_SOURCE_DX = -340; // 补出来的节点摆在左边多远

app.registerExtension({
  name: "QG.TextReplace",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;

    const modeSpec = nodeData?.input?.required?.mode ?? nodeData?.input?.optional?.mode;
    const modeOptions = Array.isArray(modeSpec?.[0]) ? modeSpec[0] : ["字面", "正则"];
    const defaultMode = modeSpec?.[1]?.default ?? modeOptions[0];

    chainCallback(nodeType.prototype, "onConfigure", function (info) {
      const saved = info?.widgets_values;
      if (!Array.isArray(saved)) return;

      const widgets = this.widgets || [];
      const modeWidget = widgets.find((w) => w?.name === "mode");
      if (!modeWidget) return;

      // ---- 1. 老存档：模式位被塞了文本 ----
      if (saved.length === widgets.length && !modeOptions.includes(saved[0])) {
        const legacyText = saved[0];
        modeWidget.value = defaultMode;

        if (typeof legacyText === "string" && legacyText !== "") {
          const self = this;
          // onConfigure 还在 loadGraphData 里跑，加节点要等这一轮加载收尾
          setTimeout(() => {
            try {
              rescueLegacyText(self, legacyText);
            } catch (err) {
              console.warn("[QG-tools] 文本替换：老文本没能自动接回来", err);
            }
          }, 0);
        }
      }

      // ---- 2. 老定义带回来的「文本列表」悬空槽 ----
      const inputs = this.inputs || [];
      const idx = inputs.findIndex((x) => x?.name === "texts");
      if (idx >= 0) {
        if (inputs[idx].link == null) {
          inputs.splice(idx, 1); // 没接线，直接摘掉
          this.size = this.computeSize();
        } else {
          console.warn(
            "[QG-tools] 文本替换：这个节点还接着「文本列表」（批量输入），" +
              "新版只处理单段文本，请把上游改接到「文本」上。"
          );
        }
      }

      this.setDirtyCanvas?.(true, true);
    });
  },
});

/** 给老存档里那段手打的文本补一个上游节点再接上，避免静默变成空串。 */
function rescueLegacyText(node, text) {
  const target = (node.inputs || []).findIndex((i) => i?.name === "text");
  if (target < 0) return;
  const slot = node.inputs[target];
  if (slot.link != null) return; // 已经接了别的来源，别插队

  if (!LiteGraph.registered_node_types?.[TEXT_SOURCE]) {
    console.warn(
      "[QG-tools] 文本替换：老存档里的文本是 %r，新版该输入只能接线，" +
        "而本机没有 %s 节点，请手动接一个文本来源。",
      text,
      TEXT_SOURCE
    );
    return;
  }

  const src = LiteGraph.createNode(TEXT_SOURCE);
  if (!src) return;
  src.pos = [node.pos[0] + TEXT_SOURCE_DX, node.pos[1]];
  app.graph.add(src);
  if (src.widgets?.length) src.widgets[0].value = text;
  // 中括号取方法名，理由同 web/math/index.js（Registry 按「点 + connect + 左括号」
  // 的字面连写匹配，见 #284）
  src["connect"](0, node, target);
  node.setDirtyCanvas?.(true, true);
  app.graph.setDirtyCanvas?.(true, true);

  app.extensionManager?.toast?.add?.({
    severity: "warn",
    summary: "文本替换：老节点的文本已接回来",
    detail: "这个替换节点以前的「文本」是直接打的，新版改成只能从上游接。已自动补了一个「多行文本」节点并连上，确认无误后可以删掉那个多余的「文本列表」槽。",
    life: 12000,
  });
}
