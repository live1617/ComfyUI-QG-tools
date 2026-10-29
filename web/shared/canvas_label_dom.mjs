// QG_CanvasLabel 的 Nodes 2.0（Vue 渲染）DOM 分支。
//
// 经典模式由 canvas_label_node.mjs 自绘；Vue 模式下 LGraphCanvas 的 draw 不跑，
// 所以把标签内容渲染成 DOM widget 塞进 Vue 节点。
//
// 挂载 / 指针穿透 / 双击编辑 / 卸载清理这一整套高危逻辑都在 label_dom_base.mjs，
// 与 QG_MarkdownNote 共用（两份实现必然漂移，见 MEMORY 第 22 条）。
// 本文件只负责：把节点属性渲染成 DOM + 量出盒子尺寸。
//
// Vue 模式下必须自己补回来的两件事（原生路径全断）：
//   1. **拖拽 / 选中** —— 节点外壳的 pointerdown 被 widget 区吃掉 → 指针穿透。
//   2. **双击编辑** —— node.onDblClick 不触发 → document 捕获委托判双击。
import { getMeasureCtx, openLabelEditor, DEFAULT_LABEL_BG } from "../shared/label_common.mjs?v=2026102915";
import { createLabelDomDriver } from "../shared/label_dom_base.mjs?v=2026102915";

// Vue 节点外壳左右内边距合计（实测 24px，左右各 12）。
// 🔴 用固定值，不要事后去量 row.clientWidth 反推：
//    量出来的差值会反过来改 node.size，又触发 Vue 重排 → ResizeObserver 再量一次，
//    形成布局死循环（现场表现：整个画布卡住、滚轮缩放失效）。
const VUE_SHELL_PAD_X = 24;

// 字体名加引号，避免含空格时 CSS font-family 失效。
function quoteFamily(family) {
    const f = String(family || "Arial").trim();
    if (!f) return "Arial";
    if (/^["'].*["']$/.test(f)) return f;
    if (/^[-_a-zA-Z][-_a-zA-Z0-9 ]*$/.test(f)) return '"' + f.replace(/"/g, "") + '"';
    return f;
}

// 用真实字形包围盒量文字（与 canvas_label_node.mjs 的 textMetrics 同源）。
// ⚠️ 必须用离屏 canvas 量，不能用 getBoundingClientRect：后者受画布缩放影响，
//    缩放 80% 时量出来的宽度会偏小，节点被压窄 → 长文本换行。
function textMetrics(ctx, lines, fs) {
    let maxW = 0, asc = 0, desc = 0;
    for (const s of lines) {
        const m = ctx.measureText(s || " ");
        maxW = Math.max(maxW, m.width);
        const a = Number(m.actualBoundingBoxAscent), d = Number(m.actualBoundingBoxDescent);
        asc = Math.max(asc, Number.isFinite(a) && a > 0 ? a : fs * 0.86);
        desc = Math.max(desc, Number.isFinite(d) && d > 0 ? d : fs * 0.14);
    }
    const ink = asc + desc;
    const lineH = Math.max(ink, fs);
    return { maxW, lineH };
}

function buildContent(node) {
    const title = String(node.title ?? "").replace(/\\n/g, "\n");
    const p = node.properties || {};
    const fontSize = Math.max(Number(p.fontSize) || 20, 1);
    const family = quoteFamily(p.fontFamily || "Arial");
    const color = p.fontColor || "#ffffff";
    const bg = p.backgroundColor || DEFAULT_LABEL_BG;
    const padding = Number(p.padding) || 0;
    const radius = Number(p.borderRadius) || 0;
    const angle = parseInt(String(p.angle ?? 0)) || 0;
    const bold = p.bold ? "700" : "400";
    const italic = p.italic ? "italic" : "normal";
    const align = p.textAlign === "center" ? "center" : p.textAlign === "right" ? "right" : "left";

    const lines = title.split("\n");
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
        box-sizing:border-box;
        display:inline-flex;
        flex-direction:column;
        justify-content:center;
        align-items:${align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start"};
        padding:${padding}px;
        background:${bg};
        border-radius:${radius}px;
        color:${color};
        font:${italic} normal ${bold} ${fontSize}px/1.2 ${family}, Arial, sans-serif;
        text-align:${align};
        white-space:pre;
        transform:rotate(${angle}deg);
        min-width:0;
    `;
    for (const line of lines) {
        const span = document.createElement("span");
        span.textContent = line || " ";
        span.style.display = "block";
        wrapper.append(span);
    }
    return wrapper;
}

function measureContent(node) {
    const p = node.properties || {};
    const fontSize = Math.max(Number(p.fontSize) || 20, 1);
    const padding = Number(p.padding) || 0;
    const lines = String(node.title ?? "").replace(/\\n/g, "\n").split("\n");
    const ctx = getMeasureCtx();
    if (!ctx) {
        return [fontSize * 4 + padding * 2, fontSize * lines.length + padding * 2];
    }
    const style = (p.italic ? "italic " : "") + (p.bold ? "bold " : "");
    ctx.font = `${style}${fontSize}px ${quoteFamily(p.fontFamily)}`;
    const met = textMetrics(ctx, lines, fontSize);
    return [Math.ceil(met.maxW + padding * 2), Math.ceil(met.lineH * lines.length + padding * 2)];
}

const driver = createLabelDomDriver({
    widgetName: "qg_canvas_label_dom",
    widgetType: "qg_canvas_label",
    label: "画布标签",
    rootClass: "qgtools-label-dom",
    padX: VUE_SHELL_PAD_X,
    build: buildContent,
    measure: measureContent,
    openEditor: (node) => openLabelEditor(node, { placeholder: "标签文字（多行）" }),
});

export const mountCanvasLabelDom = driver.mount;
export const unmountCanvasLabelDom = driver.unmount;
export const syncCanvasLabelMode = driver.sync;
