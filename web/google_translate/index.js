// -*- coding: utf-8 -*-
// QG Google Translate front end.
// Ported from AlekPet/ComfyUI_Custom_Nodes_AlekPet (google_translate_node.js), MIT.
// Adds a "Manual Translate" button that rewrites the text in place via /qg/translate/manual.

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { zh } from "../shared/zh.mjs?v=2026101802";

const findWidget = (node, name, attr = "name", func = "find") =>
  node.widgets[func]((w) => w[attr] === name);

function manual_translate_prompt() {
  const node = this,
    button_manual_translate = findWidget(node, "Manual Translate"),
    widget_from_translate = findWidget(node, "from_translate"),
    widget_to_translate = findWidget(node, "to_translate"),
    manual_translate = findWidget(node, "manual_translate"),
    widget_textmultiline = findWidget(node, "customtext", "type");

  button_manual_translate.onClick = async function () {
    if (!manual_translate.value) {
      app.extensionManager.toast.add({
        severity: "info",
        summary: zh("Information"),
        detail: zh(
          "Manual translate is off. The text is translated when you queue the node (press Run)."
        ),
        life: 8000,
      });
      return;
    }

    try {
      const responseData = await api.fetchApi("/qg/translate/manual", {
        method: "POST",
        body: JSON.stringify({
          prompt: widget_textmultiline.value,
          srcTrans: widget_from_translate.value,
          toTrans: widget_to_translate.value,
        }),
      });

      if (responseData.status !== 200) {
        console.log(
          "[QG-tools] translate failed [" +
            responseData.status +
            "] > " +
            responseData.statusText
        );
        return;
      }

      const json = await responseData?.json();
      if (!json || json === undefined) {
        console.log("[QG-tools] translate returned nothing");
        return;
      }

      if (json.hasOwnProperty("translate_prompt")) {
        widget_textmultiline.value = json.translate_prompt;
      }
    } catch (e) {
      console.error("[QG-tools] manual translate error", e);
    }
  };
}

app.registerExtension({
  name: "QG.GoogleTranslate",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "QG_GoogleTranslateText") {
      return;
    }

    // --- Node Created: add the Manual Translate button ---
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply?.(this, arguments);
      const node = this,
        nodeName = `${nodeData.name}_${app.graph._nodes.filter((n) => n.type === nodeData.name).length}`;

      console.log(`Create ${nodeData.name}: ${nodeName}`);

      node.addWidget(
        "button",
        zh("Manual Translate"),
        "Manual Translate",
        manual_translate_prompt.bind(node)
      );

      // 把按钮插到 text 控件之前（与上游一致的视觉顺序）
      node.widgets.splice(3, 0, node.widgets.pop());
    };
  },
});
