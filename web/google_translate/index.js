// -*- coding: utf-8 -*-
// QG Google Translate front end.
// Ported from AlekPet/ComfyUI_Custom_Nodes_AlekPet (google_translate_node.js), MIT.
// Adds a "Manual Translate" button that rewrites the text in place via /qg/translate/manual.

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { zhPair } from "../shared/zh.mjs?v=2026111208";

const NODE_CLASS = "QG_GoogleTranslateText";

// 控件的 name 永远是英文键（汉化只改显示名），所以按 name 找是稳的。
const BUTTON_NAME = "Manual Translate";

const findWidget = (node, name) => node.widgets?.find((w) => w?.name === name);

async function manualTranslate(node) {
  const manual = findWidget(node, "manual_translate");
  const textWidget = findWidget(node, "text");
  if (!textWidget) return;

  if (!manual?.value) {
    app.extensionManager.toast.add({
      severity: "info",
      summary: zhPair("Information", "提示"),
      detail: zhPair(
        "Manual translate is off. The text is translated when you queue the node (press Run).",
        "「手动翻译」没开。文本会在排队运行节点时自动翻译（点「运行」）。"
      ),
      life: 8000,
    });
    return;
  }

  try {
    const responseData = await api.fetchApi("/qg/translate/manual", {
      method: "POST",
      body: JSON.stringify({
        prompt: textWidget.value,
        srcTrans: findWidget(node, "from_translate")?.value ?? "auto",
        toTrans: findWidget(node, "to_translate")?.value ?? "en",
      }),
    });

    if (responseData.status !== 200) {
      // 后端失败时回 {"ok": false, "error": "..."}，把这句话转给用户，别只写控制台。
      let detail = responseData.statusText;
      try {
        const body = await responseData.json();
        if (body?.error) detail = body.error;
      } catch (error) {
        // 响应不是 JSON：保持 statusText
      }
      app.extensionManager.toast.add({
        severity: "error",
        summary: zhPair("Information", "提示"),
        detail: String(detail),
        life: 10000,
      });
      return;
    }

    const json = await responseData.json();
    if (typeof json?.translate_prompt !== "string") return;

    textWidget.value = json.translate_prompt;
    // 面板是 DOM 还是 canvas 画的都成立：通知画布重画，别让旧文字留在屏幕上。
    node.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas?.(true, true);
  } catch (error) {
    console.error("[QG-tools] manual translate error", error);
  }
}

app.registerExtension({
  name: "QG.GoogleTranslate",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply?.(this, arguments);
      const node = this;

      // 🔴 按钮的文字必须放 label，不能放 addWidget 的第二个参数。
      //   litegraph 的 button 控件是 `label ?? name` 决定显示什么，而第二个参数同时
      //   就是控件的 name —— 把中文塞进去，中文界面下 name 就变成「手动翻译」，
      //   按 name 查找（还有存档里的控件名）全部落空。这里 name 永远是英文常量，
      //   显示文字单独写进 label，中英文都验过（见 tools/_check_google_translate_ui.cjs）。
      const button = node.addWidget(
        "button",
        BUTTON_NAME,
        BUTTON_NAME,
        () => manualTranslate(node)
      );
      if (button) button.label = zhPair("Manual Translate", "手动翻译");

      // 把按钮挪到「文本」控件之前（与上游一致的视觉顺序）。按 name 找位置，
      // 别写死下标 —— 上游是 splice(3, 0, ...)，一旦控件增减按钮就插错地方。
      const widgets = node.widgets;
      const here = widgets.indexOf(button);
      const textIndex = widgets.findIndex((w) => w?.name === "text");
      if (here >= 0 && textIndex >= 0) {
        widgets.splice(here, 1);
        widgets.splice(widgets.findIndex((w) => w?.name === "text"), 0, button);
      }
    };
  },
});
