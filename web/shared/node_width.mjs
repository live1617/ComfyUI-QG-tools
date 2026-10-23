/**
 * QG 节点默认宽度表（前端）
 *
 * 为什么需要这张表：ComfyUI 的节点默认宽度**不在 Python 里**，是前端按控件类型给的
 * （带多行文本框的节点会被撑到 400，普通节点是 270，某些只有两个控件的算出来只有 159）。
 * Python 侧 grep 不到宽度，也没法声明。所以统一在这里钉一遍，让一屏里并排放的节点宽度一致。
 *
 * 规则：
 *   1. `SKIP` 里的节点有自己的前端尺寸逻辑（种子卡片、LoRA 面板、对比台…），这里绝不碰；
 *   2. `OVERRIDES` 里显式列出的宽度优先（目前留给带多行输入框的三个节点，400）；
 *   3. 其余 `QG_*` 一律钉成 `DEFAULT_WIDTH`；
 *   4. **只影响新建**：存档里已有宽度的节点由 onConfigure 覆盖回来，不动用户调过的尺寸。
 */

import { chainCallback } from "./index.mjs?v=2026102319";

export const DEFAULT_WIDTH = 270;

/** 自己有尺寸逻辑的节点，别碰。改这张表前先看对应 web/<节点>/index.js。 */
export const SKIP = new Set([
    "QG_AnySwitch",          // 240：胶囊开关，宽度跟内容走
    "QG_BoolToggle",         // 320x100：整张节点就是一枚开关，前端自己按比例管尺寸
    "QG_Number",             // 卡片 260：一行「值」+ 一个可拖数字框（minWidth 自己管）
    "QG_Math",               // 卡片 300：表达式行 + 两行变量（minWidth 自己管）
    "QG_CanvasLabel",        // 自由尺寸的文字块
    "QG_MarkdownNote",       // 同上
    "QG_DisplayAny",         // 320：预览区跟着图片比例
    "QG_ExportImage",        // MIN_WIDTH 270 + 概要行布局
    "QG_ImageCompare",       // 420：对比台
    "QG_ImageCropRotatePad", // 330：三个并列面板
    "QG_LoraLoader",         // 400：LoRA 面板
    "QG_MDReader",           // 380：文档预览
    "QG_RunTimer",           // 176：计时器卡片
    "QG_Seed",               // 300：种子卡片
    "QG_TripleLoader",       // 400：三联加载器（自己的 DEFAULT_WIDTH，与 LoRA 加载器等宽）
    "QG_WorkflowNote",       // 520：说明卡
    "QG_WorkflowSwitches",   // 320：开关条
]);

/** 带多行输入框的节点，先按 400 留着（用户要一个个试再定）。 */
export const OVERRIDES = {
    QG_GoogleTranslateText: 400,
    QG_TextEditOutput: 400,
    QG_TextSplit: 400,
    QG_StringSwitch: 400,     // 上下两段多行文本框，270 太窄打不动字
};

/** 这个节点该钉多宽；返回 null = 不碰。 */
export function widthFor(nodeName) {
    if (!nodeName || !nodeName.startsWith("QG_")) return null;
    if (SKIP.has(nodeName)) return null;
    return OVERRIDES[nodeName] ?? DEFAULT_WIDTH;
}

/** 把宽度钉在 nodeType 上（只影响新建节点）。 */
export function pinNodeWidth(nodeType, nodeData) {
    const target = widthFor(nodeData?.name);
    if (!target) return;
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        const width = this.size?.[0];
        if (typeof width === "number" && Math.abs(width - target) > 0.5) {
            this.size[0] = target;
            this.setDirtyCanvas?.(true, true);
        }
    });
}
