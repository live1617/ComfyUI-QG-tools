// ComfyUI — 画布标签节点
// 纯前端虚拟节点：不参与后端执行，只在画布上显示一行/多行纯文字。
// Markdown 相关的渲染已拆到独立节点「Markdown 文本」；本节点保持纯文本，不做语法解析。
// 共用代码：label_common.js（编辑面板 + 画布钩子）
import { openLabelEditor, registerLabelCanvasHooks, getMeasureCtx, DEFAULT_LABEL_BG,
         DEFAULT_LABEL_PAD, DEFAULT_LABEL_RADIUS } from "./label_common.mjs?v=2026102319";
import { syncCanvasLabelMode } from "./canvas_label_dom.mjs?v=2026102319";
import { vueNodesEnabled } from "./vue_mode.mjs?v=2026102319";

const NODE_TYPE = "QG_CanvasLabel";

// 用真实字形包围盒量文字：fontSize ≠ 字形高度（尤其中文字体，墨迹经常比 fontSize 高一截），
// 而且 textBaseline="top" 的 top 只是 em 框顶不是墨迹顶——背景若按 fontSize 算就会包不住字。
// 返回 maxW（最宽行）、asc/desc（跨行最大升部/降部）、lineH（行距，不低于 fontSize）。
function textMetrics(ctx, lines, fs) {
    let maxW = 0, asc = 0, desc = 0;
    for (const s of lines) {
        const m = ctx.measureText(s || " ");
        maxW = Math.max(maxW, m.width);
        const a = Number(m.actualBoundingBoxAscent), d = Number(m.actualBoundingBoxDescent);
        // 浏览器不支持/异常时退回经典近似值（升部 0.86 / 降部 0.14）
        asc = Math.max(asc, Number.isFinite(a) && a > 0 ? a : fs * 0.86);
        desc = Math.max(desc, Number.isFinite(d) && d > 0 ? d : fs * 0.14);
    }
    const ink = asc + desc;
    const lineH = Math.max(ink, fs);
    // 行距比墨迹高出的部分上下均摊，让文字在每行里垂直居中
    const extra = Math.max(0, lineH - ink) / 2;
    return { maxW, asc, desc, lineH, extra };
}

// family 加引号：字体名含空格（如 "Microsoft YaHei"）或特殊字符时，
// 不带引号的 ctx.font 会静默失效、沿用上一套字体。引号可避免这种情况。
function quoteFamily(family) {
    const f = String(family || "Arial").trim();
    if (!f) return "Arial";
    if (/^["'].*["']$/.test(f)) return f;          // 已经带引号
    if (/^[-_a-zA-Z][-_a-zA-Z0-9 ]*$/.test(f)) {   // 纯标识符（可含空格）→ 加双引号
        return '"' + f.replace(/"/g, "") + '"';
    }
    return f;                                       // 含其他字符，原样（让浏览器决定）
}

// 预览画布函数 paintSimple 已在「模态弹窗 → 浮动工具条」重构时弃用（工具条走画布实时同步，
// 不再有预览画布），此处不再保留死代码。

class QGCanvasLabel extends LGraphNode {
    constructor(title = "标签") {
        super(title);
        this.comfyClass = NODE_TYPE;
        this.resizable = false;
        // isVirtualNode 只对我们自己的画布钩子（label_common 的 drawNode patch）有意义，
        // ComfyUI 前端本身【不认】这个 flag。真正让它不进 prompt 的原因是：本节点没有任何
        // 输出槽，graphToPrompt 从输出节点反向遍历时不可达，自然被丢弃。
        // ⚠️ 因此千万不要给它加输出槽——一旦加了，后端就会收到这个不存在的类型而报错，
        //    届时 isVirtualNode 提供不了任何保护。
        this.isVirtualNode = true;
        this.properties = Object.assign(
            {
                fontSize: 20,
                fontFamily: "Arial",
                fontColor: "#ffffff",
                textAlign: "left",
                // 默认外观（色 / 内边距 / 圆角）统一取 label_common 的常量：
                // 画布标签默认透明底（压在画面上不挡底图），3px 内边距 + 3px 圆角
                // 只是「用户一旦填了色」时的边界感。
                backgroundColor: DEFAULT_LABEL_BG,
                padding: DEFAULT_LABEL_PAD,
                borderRadius: DEFAULT_LABEL_RADIUS,
                angle: 0,
                bold: false,
                italic: false,
            },
            this.properties
        );
        this.color = "#fff0";
        this.bgcolor = "#fff0";
    }

    // 节点加入 graph 时挂上模式迁移入口。Vue 模式下 ComfyUI 可能不走 constructor，
    // 但 onAdded 在两种模式下都会被调用。
    onAdded() {
        if (typeof this.__qgSyncMode !== "function") {
            this.__qgSyncMode = () => syncCanvasLabelMode(this);
        }
        syncCanvasLabelMode(this);
    }

    // 覆盖 litegraph 的徽标绘制：前端虚拟节点默认会被 ComfyUI 打上
    // "frontend_only" 徽标（无后端定义时的标记），这里留空即不显示任何徽标。
    drawBadges(ctx) {}

    draw(ctx) {
        // Vue 渲染模式下由 DOM widget 接管，canvas 自绘会跟 DOM 双影，直接短路。
        if (vueNodesEnabled()) return;
        this.flags = this.flags || {};
        // Pin 后不再响应拖拽等交互
        this.flags.allow_interaction = !this.flags.pinned;
        ctx.save();
        this.color = "#fff0";
        this.bgcolor = "#fff0";

        const fontSize = Number(this.properties["fontSize"]) || 20;
        const fontColor = this.properties["fontColor"] || "#ffffff";
        const backgroundColor = this.properties["backgroundColor"] || DEFAULT_LABEL_BG;
        const family = this.properties["fontFamily"] || "Arial";
        const padding = Number(this.properties["padding"]) || 0;

        // 标题即内容；支持字面 "\n" 与真实换行
        const lines = (this.title ?? "").replace(/\\n/g, "\n").split("\n");
        const style = (this.properties["italic"] ? "italic " : "") + (this.properties["bold"] ? "bold " : "");
        ctx.font = `${style}${Math.max(fontSize, 1)}px ${quoteFamily(family)}`;
        const met = textMetrics(ctx, lines, Math.max(fontSize, 1));

        // 尺寸由 computeSize() 统一管理（不在 draw 里写 this.size，避免选中框滞后 / 复制粘贴尺寸错）
        const w = met.maxW + padding * 2;
        const h = met.lineH * lines.length + padding * 2;

        // 可选旋转（度）
        const angleDeg = parseInt(String(this.properties["angle"] ?? 0)) || 0;
        if (angleDeg) {
            const cx = w / 2;
            const cy = h / 2;
            ctx.translate(cx, cy);
            ctx.rotate((angleDeg * Math.PI) / 180);
            ctx.translate(-cx, -cy);
        }

        // 背景圆角矩形
        if (backgroundColor && backgroundColor !== "transparent") {
            ctx.beginPath();
            const borderRadius = Number(this.properties["borderRadius"]) || 0;
            ctx.roundRect(0, 0, w, h, [borderRadius]);
            ctx.fillStyle = backgroundColor;
            ctx.fill();
        }

        // alphabetic 基线 + 真实升部：墨迹顶正好落在 padding 处，与背景对齐
        const align = this.properties["textAlign"] === "center" ? "center"
            : this.properties["textAlign"] === "right" ? "right" : "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = fontColor;
        let currentY = padding + met.asc + met.extra;
        for (const line of lines) {
            let x = padding;
            if (align === "center") { ctx.textAlign = "center"; x = w / 2; }
            else if (align === "right") { ctx.textAlign = "right"; x = w - padding; }
            else { ctx.textAlign = "left"; }
            ctx.fillText(line, x, currentY);
            currentY += met.lineH;
        }
        ctx.restore();
    }

    // 尺寸由内容决定：量文字 → 算出背景框。draw() 只读 this.size，不写。
    // 这样选中框 / 复制粘贴 / 撤销 / 导出图片用的都是算好的尺寸，不会慢一帧或失真。
    computeSize() {
        const p = this.properties || {};
        const fontSize = Number(p["fontSize"]) || 20;
        const family = p["fontFamily"] || "Arial";
        const padding = Number(p["padding"]) || 0;
        const lines = String(this.title ?? "").replace(/\\n/g, "\n").split("\n");
        const mctx = getMeasureCtx();
        if (!mctx) return [Math.max(fontSize, 1) * 4 + padding * 2, Math.max(fontSize, 1) * lines.length + padding * 2];
        // ⚠️ 必须先设字体再量：否则离屏 ctx 会用默认 10px sans-serif，量出来的尺寸严重偏小
        const style = (p["italic"] ? "italic " : "") + (p["bold"] ? "bold " : "");
        mctx.font = `${style}${Math.max(fontSize, 1)}px ${quoteFamily(family)}`;
        const met = textMetrics(mctx, lines, Math.max(fontSize, 1));
        return [met.maxW + padding * 2, met.lineH * lines.length + padding * 2];
    }

    // 属性变化时，Vue 模式的 DOM 分支需要重排内容
    onPropertyChanged(name, value, prev) {
        this.__qgLabelDom?.refresh?.();
    }

    // 双击或右键菜单都走同一个编辑弹窗
    onDblClick(event, pos, canvas) {
        openLabelEditor(this, {
            placeholder: "标签文字（多行）",
        });
    }

    inResizeCorner(x, y) {
        return this.resizable;
    }
}

QGCanvasLabel.type = NODE_TYPE;
QGCanvasLabel.title = "画布标签";
QGCanvasLabel.title_mode = LiteGraph.NO_TITLE;
QGCanvasLabel.collapsable = false;
QGCanvasLabel.category = "QG-tools/标注";

export { QGCanvasLabel };
