// ComfyUI — Markdown 文本节点
// 纯前端虚拟节点：在画布上显示支持 Markdown 的便签/说明文字。
// 渲染引擎：md_render.js（解析 → 排版 → 绘制）
// 共用代码：label_common.js（编辑面板 + 画布钩子）
import { openLabelEditorModal, registerLabelCanvasHooks, getMeasureCtx, DEFAULT_MD_BG,
         DEFAULT_MD_PAD, DEFAULT_MD_RADIUS } from "./label_common.mjs?v=2026102915";
import { MD_DEFAULT_MAX_WIDTH, getLabelLayout, drawLabelBlocks } from "./md_render.mjs?v=2026102915";
import { vueNodesEnabled } from "./vue_mode.mjs?v=2026102915";
import { sizeFor } from "./node_width.mjs?v=2026102915";

const MD_NODE_TYPE = "QG_MarkdownNote";

// 新建节点时标签上的默认内容。这是「内容」不是界面文案，所以不进 zh()：
// 英文界面下也按用户写的语言原样显示。
const MD_DEFAULT_TEXT = "Markdown 文本";

const MD_PLACEHOLDER = [
    "**粗体** *斜体* ***粗斜*** `代码` ~~删除线~~ ==高亮==",
    "x^上标^  y~下标~  <u>下划线</u>  <mark>高亮</mark>",
    "<b>HTML 粗</b> <i>斜</i> <s>删</s> <code>码</code> <kbd>键</kbd>",
    "<span style=\"color:red\">红字</span> <span style=\"color:#0088ff;background-color:#222\">蓝字蓝底</span>",
    "&amp; &lt; &gt; &copy; &rarr; &#65;  ← 实体自动解码",
    "# 一级标题  ## 二级 ### 三级",
    "标题\n===   ← Setext 一级标题",
    "> 引用（>> 可嵌套）",
    "- 列表项\n  - 子项（缩进两空格）",
    "1. 编号项\n2. 第二项",
    "（不做链接/任务列表：URL 与 [x] 原样显示）",
    "<h3>HTML 标题</h3>",
    "<ul><li>项目一</li><li>项目二<ul><li>子项</li></ul></li></ul>",
    "<table><tr><th>列1</th><th>列2</th></tr><tr><td>甲</td><td>乙</td></tr></table>",
    "<small>小字</small> <big>大字</big> <abbr>CSS</abbr> <q>引语</q>",
    "术语\n: 这是定义列表的释义",
    "---",
    "```js\n代码块（右上角显示语言）\n```",
    "| 列1 | 列2 |\n| --- | ---: |\n| 居左 | 居右 |\n| 带 | 斑马纹 |",
    "![图片](http://example.com/a.png \"标题\" =200x120)",
    "\\* 这样写就显示星号本身 \\*",
].join("\n");

// 预览用统一排版参数（paint 与 measure 必须完全一致，否则滚动范围会和实际内容对不上）
function previewOpts(v) {
    return {
        size: Math.max(Number(v.fontSize) || 20, 1),
        family: v.fontFamily || "Arial",
        wrap: v.wrap !== false,
        maxWidth: v.maxWidth,
        markdown: v.markdown !== false,
    };
}
function previewPadding(v) {
    return Number(v.padding) || 0;
}

// 量算预览内容尺寸：宽度不够时按宽度等比缩小（与 paint 用同一套算式，不能各算各的）
function measureMarkdown(v, view) {
    const mctx = getMeasureCtx();
    if (!mctx) return null;
    const padding = previewPadding(v);
    const { layout } = getLabelLayout(mctx, String(v.text ?? "").replace(/\\n/g, "\n"), previewOpts(v));
    const blockW = Math.max(layout.width, 1) + padding * 2;
    const blockH = Math.max(layout.height, 1) + padding * 2;
    const availW = (view && Number(view.width)) || 0;
    const fit = (availW > 1 && blockW > availW) ? availW / blockW : 1;
    return { w: Math.round(blockW * fit), h: Math.round(blockH * fit) };
}

// 预览画布（编辑面板左栏）：按宽度等比自适应，纵向 1:1 平移。
// 画布恒等于可视区大小，view.scrollTop 给出滚动偏移，内容据此上移 —— 长文本靠文本框带动查看。
function paintMarkdown(ctx, v, w, h, view) {
    const padding = previewPadding(v);
    const opts = previewOpts(v);
    const align = v.textAlign === "center" ? "center" : v.textAlign === "right" ? "right" : "left";
    const { blocks, layout } = getLabelLayout(ctx, String(v.text ?? "").replace(/\\n/g, "\n"), opts);
    const blockW = Math.max(layout.width, 1) + padding * 2;
    const blockH = Math.max(layout.height, 1) + padding * 2;

    // 内容比预览宽时整体等比缩小，避免右侧被裁掉（预览框没有滚动条）
    const fit = (w > 1 && blockW > w) ? w / blockW : 1;
    const sy = (view && view.scrollTop) || 0;
    const ox = (w - blockW * fit) / 2;

    ctx.save();
    ctx.translate(ox, -sy);
    ctx.scale(fit, fit);
    if (v.backgroundColor && v.backgroundColor !== "transparent") {
        ctx.beginPath();
        ctx.roundRect(0, 0, blockW, blockH, [Number(v.borderRadius) || 0]);
        ctx.fillStyle = v.backgroundColor;
        ctx.fill();
    }
    drawLabelBlocks(ctx, blocks, opts, padding, padding, blockW, align, v.fontColor || "#ffffff");
    ctx.restore();
    // 把真实尺寸回传给编辑面板的信息条
    ctx.canvas.__label = { w: Math.round(blockW), h: Math.round(blockH), fit };
}

// 统一的编辑入口：备份版分栏弹窗（左预览 / 右表单）
function openMarkdownEditor(node) {
    openLabelEditorModal(node, {
        showMarkdown: true,
        heading: "编辑 Markdown 文本",
        placeholder: MD_PLACEHOLDER,
        paint: paintMarkdown,
        measure: measureMarkdown,
    });
}

class QGMarkdownNote extends LGraphNode {
    constructor(title = "Markdown") {
        super(title);
        this.comfyClass = MD_NODE_TYPE;
        this.resizable = false;
        // isVirtualNode 只对我们自己的画布钩子有意义，ComfyUI 前端本身【不认】这个 flag。
        // 真正让它不进 prompt 的原因是：本节点没有任何输出槽，graphToPrompt 反向
        // 遍历时不可达 → 自然被丢弃。⚠️ 不要给它加输出槽，否则后端会收到不存在的类型。
        this.isVirtualNode = true;
        this.properties = Object.assign(
            {
                fontSize: 16,
                fontFamily: "Arial",
                fontColor: "#ffffff",
                textAlign: "left",
                // 默认外观（同 label_common 常量）：深青灰卡片 + 8px 内边距 + 8px 圆角
                backgroundColor: DEFAULT_MD_BG,
                padding: DEFAULT_MD_PAD,
                borderRadius: DEFAULT_MD_RADIUS,
                angle: 0,
                markdown: true,
                wrap: true,
                maxWidth: MD_DEFAULT_MAX_WIDTH,
            },
            this.properties
        );
        // 节点本身不带任何边框/底色，视觉完全由 draw() 控制
        this.color = "#fff0";
        this.bgcolor = "#fff0";
    }

    // 覆盖 litegraph 的徽标绘制：不显示 frontend_only 徽标
    drawBadges(ctx) {}

    draw(ctx) {
        // Nodes 2.0（Vue 渲染）：节点由 DOM widget 显示，这里必须立刻返回，
        // 否则 canvas 自绘与 DOM 会同时出现（双影 / 错位叠字）。
        if (vueNodesEnabled()) return;
        this.flags = this.flags || {};
        // Pin 后不再响应拖拽等交互
        this.flags.allow_interaction = !this.flags.pinned;
        ctx.save();
        this.color = "#fff0";
        this.bgcolor = "#fff0";

        const fontSize = Number(this.properties["fontSize"]) || 16; // 与构造函数默认值保持一致
        const fontColor = this.properties["fontColor"] || "#ffffff";
        const backgroundColor = this.properties["backgroundColor"] || DEFAULT_MD_BG;
        const family = this.properties["fontFamily"] || "Arial";
        const padding = Number(this.properties["padding"]) || 0;
        const opts = {
            size: fontSize,
            family,
            wrap: this.properties["wrap"] !== false,
            maxWidth: this.properties["maxWidth"],
            markdown: this.properties["markdown"] !== false,
        };

        // 标题即内容；支持字面 "\n" 与真实换行
        const processed = (this.title ?? "").replace(/\\n/g, "\n").replace(/\n*$/, "");
        const { blocks, layout } = getLabelLayout(ctx, processed, opts);

        // 尺寸由 computeSize() 统一管理（不在 draw 里写 this.size，避免选中框滞后 / 复制粘贴尺寸错）
        const w = layout.width + padding * 2;
        const h = layout.height + padding * 2;

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

        const align = this.properties["textAlign"] === "center" ? "center"
            : this.properties["textAlign"] === "right" ? "right" : "left";
        drawLabelBlocks(ctx, blocks, opts, padding, padding, w, align, fontColor);
        ctx.restore();
    }

    // 尺寸由内容决定：排版量算 → 算出背景框。draw() 只读 this.size，不写。
    computeSize() {
        const p = this.properties || {};
        const fontSize = Number(p["fontSize"]) || 16;
        const family = p["fontFamily"] || "Arial";
        const padding = Number(p["padding"]) || 0;
        const opts = {
            size: fontSize,
            family,
            wrap: p["wrap"] !== false,
            maxWidth: p["maxWidth"],
            markdown: p["markdown"] !== false,
        };
        const processed = (this.title ?? "").replace(/\\n/g, "\n").replace(/\n*$/, "");
        const mctx = getMeasureCtx();
        if (!mctx) return [100, 40];
        const { layout } = getLabelLayout(mctx, processed, opts);
        // 尺寸表里给本节点填了数字就以它为最小宽（现在表里是 null = 完全按文字算）。
        const pinned = sizeFor(MD_NODE_TYPE).w;
        const width = layout.width + padding * 2;
        return [pinned ? Math.max(width, pinned) : width, layout.height + padding * 2];
    }

    // 属性变化时重排 Vue 分支的 DOM（经典模式没有 __qgLabelDom，空操作）。
    // 🔴 setDirtyCanvas() 在 Vue 下不管 DOM widget，改完属性必须主动刷新。
    onPropertyChanged(name, value, prev) {
        this.__qgLabelDom?.refresh?.();
    }

    // 双击或右键菜单都走同一个编辑弹窗（备份版布局：左预览 / 右表单）
    onDblClick(event, pos, canvas) {
        openMarkdownEditor(this);
    }

    inResizeCorner(x, y) {
        return this.resizable;
    }
}

QGMarkdownNote.type = MD_NODE_TYPE;
QGMarkdownNote.title = MD_DEFAULT_TEXT;
QGMarkdownNote.title_mode = LiteGraph.NO_TITLE;
QGMarkdownNote.collapsable = false;
QGMarkdownNote.category = "QG-tools/Annotation";

export { QGMarkdownNote, openMarkdownEditor };
