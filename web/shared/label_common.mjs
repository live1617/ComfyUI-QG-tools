// ===========================================================================
// 「画布标签」与「Markdown 文本」两个节点共用的界面与画布钩子
// 只提供：样式注入、DOM 小工具、编辑弹窗、画布绘制/穿透钩子
// ===========================================================================
import { app } from "/scripts/app.js";
import { zh } from "./zh.mjs?v=2026102706";
import { MD_DEFAULT_MAX_WIDTH } from "./md_render.mjs?v=2026102706";

const CSS_ID = "qgtools-canvaslabel-css";

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
/* ---- 弹窗版式（Markdown 文本专用：左侧实时预览 / 右侧表单，即备份版布局） ---- */
.qgtools-cl-mdl-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0);padding:18px;}
.qgtools-cl-mdl{display:flex;flex-direction:column;width:min(900px,94vw);max-height:90vh;border:1px solid #3a4047;border-radius:9px;background:#1c1f23;box-shadow:0 12px 40px rgba(0,0,0,.6);color:#d7dde2;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.qgtools-cl-mdl *{box-sizing:border-box;}
.qgtools-cl-mdl-head{display:flex;align-items:center;gap:8px;flex:none;padding:11px 14px;border-bottom:1px solid #2c3238;font-weight:600;font-size:13px;color:#e6f4f3;}
.qgtools-cl-mdl-spacer{flex:1 1 auto;}
.qgtools-cl-mdl-body{flex:1 1 auto;min-height:0;overflow:hidden;padding:12px 14px;display:flex;flex-direction:column;gap:11px;}
.qgtools-cl-mdl-foot{display:flex;align-items:center;gap:8px;flex:none;padding:10px 14px;border-top:1px solid #2c3238;}
.qgtools-cl-mdl-split{display:flex;gap:12px;align-items:stretch;flex:1 1 auto;min-height:0;}
.qgtools-cl-mdl-pane{flex:1 1 50%;min-width:0;display:flex;flex-direction:column;gap:11px;}
.qgtools-cl-mdl-fieldspane{overflow-y:auto;padding-right:4px;}
.qgtools-cl-mdl-fieldspane textarea{min-height:220px;resize:vertical;}
.qgtools-cl-mdl-previewwrap{position:relative;flex:1 1 auto;min-height:280px;overflow:hidden;border:1px dashed #3a4047;border-radius:6px;background:repeating-conic-gradient(#222 0% 25%,#2a2a2a 0% 50%) 50%/16px 16px;}
.qgtools-cl-mdl-preview{display:block;position:sticky;top:0;left:0;width:100%;border:0;border-radius:0;background:transparent;pointer-events:none;}
.qgtools-cl-mdl-previewspace{position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;}
.qgtools-cl-mdl-previewbar{display:flex;align-items:center;gap:10px;margin-top:6px;}
.qgtools-cl-mdl-cap{flex:1 1 auto;color:#8a9098;font-size:10.5px;font-variant-numeric:tabular-nums;}
.qgtools-cl-mdl-hint{color:#7d848c;font-size:10.5px;}
.qgtools-cl-mdl-livehint{flex:none;color:#7d848c;font-size:10.5px;margin-top:2px;}
.qgtools-cl-mdl-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.qgtools-cl-mdl-checkline{display:flex;align-items:center;gap:7px;}
.qgtools-cl-mdl-btn{height:26px;padding:0 12px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#d7dde2;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;}
.qgtools-cl-mdl-btn:hover{border-color:#00b4aa;color:#fff;}
.qgtools-cl-mdl-btn.primary{border-color:#00b4aa;background:#00b4aa;color:#08211f;font-weight:600;}
.qgtools-cl-mdl-btn.primary:hover{background:#19c9be;}
/* 弹窗内表单控件的统一外观 */
.qgtools-cl-mdl input,.qgtools-cl-mdl textarea,.qgtools-cl-mdl select{width:100%;padding:5px 8px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#e6f4f3;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;}
.qgtools-cl-mdl input:focus,.qgtools-cl-mdl textarea:focus,.qgtools-cl-mdl select:focus{border-color:#00b4aa;}
.qgtools-cl-mdl textarea{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.qgtools-cl-mdl input[type=checkbox]{width:auto;height:auto;padding:0;margin:0;cursor:pointer;accent-color:#00b4aa;}
.qgtools-cl-mdl .qgtools-cl-combo{width:100%;flex:1 1 auto;min-width:0;}
.qgtools-cl-mdl .qgtools-cl-editor-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.qgtools-cl-mdl .qgtools-cl-editor-field > label{color:#9ba2aa;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qgtools-cl-mdl .qgtools-cl-colorline{display:flex;align-items:center;gap:8px;min-width:0;}
.qgtools-cl-mdl .qgtools-cl-colorline input[type=color]{width:34px;height:28px;flex:none;padding:0;border:1px solid #3a4047;border-radius:5px;background:#23272c;cursor:pointer;}
.qgtools-cl-mdl .qgtools-cl-colorline input[type=text]{flex:1 1 auto;width:auto;min-width:0;}
/* 自定义字体下拉：原生 <select> 弹层方向由浏览器决定，无法保证向下，这里自己画 */
.qgtools-cl-combo{position:relative;display:flex;flex:0 1 150px;min-width:96px;width:auto;}
.qgtools-cl-combo-trigger{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;padding:5px 8px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#e6f4f3;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;text-align:left;outline:none;}
.qgtools-cl-combo-trigger:hover,.qgtools-cl-combo-trigger:focus{border-color:#00b4aa;}
.qgtools-cl-combo-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qgtools-cl-combo-arrow{flex:none;color:#9ba2aa;font-size:10px;}
.qgtools-cl-combo-list{position:fixed;z-index:10001;min-width:120px;overflow-y:auto;overscroll-behavior:contain;border:1px solid #3a4047;border-radius:5px;background:#23272c;box-shadow:0 8px 24px rgba(0,0,0,.55);padding:2px;}
.qgtools-cl-combo-item{padding:4px 9px;border-radius:3px;color:#d7dde2;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qgtools-cl-combo-item:hover{background:#2c333a;color:#fff;}
.qgtools-cl-combo-item.active{background:#00b4aa;color:#08211f;font-weight:600;}
/* ---- 浮动工具条（配色对齐 ComfyUI 暗色主题） ---- */
.qgtools-cl-editor-toolbar{position:fixed;z-index:10001;display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:7px 8px;background:#1c1f23;border:1px solid #3a4047;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.55);font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#d7dde2;width:max-content;max-width:calc(100vw - 24px);}
.qgtools-cl-editor-toolbar *{box-sizing:border-box;}
/* 上排：文字框（铺满整条宽度，不再被挤成竖排折行） */
.qgtools-cl-editor-textrow{display:flex;width:100%;}
/* 下排：所有控件 */
/* 控件始终排成一行（按钮已 flex:none，不会被压扁）；视口实在放不下时横向滚动兜底，
   绝不把 ✓/✕ 挤到看不见的第二行。 */
.qgtools-cl-editor-trow{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding-bottom:1px;}
.qgtools-cl-editor-dims{position:fixed;z-index:10001;padding:2px 6px;background:rgba(18,20,23,.85);color:#cfd5db;font:11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border-radius:6px;font-variant-numeric:tabular-nums;pointer-events:none;white-space:nowrap;}
.qgtools-cl-editor-dims:empty{display:none;}
.qgtools-cl-ttext{flex:1 1 auto;width:100%;min-width:0;height:30px;padding:6px 9px;border:1px solid #3a4047;border-radius:7px;background:#23272c;color:#e6f4f3;font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;resize:none;overflow:hidden;outline:none;}
.qgtools-cl-ttext:focus{border-color:#00b4aa;background:#2a2f34;}
.qgtools-cl-tsep{width:1px;height:22px;background:#3a4047;margin:0 2px;flex:none;}
.qgtools-cl-tnum{width:56px;flex:0 0 56px;height:30px;padding:4px 6px;border:1px solid #3a4047;border-radius:7px;background:#23272c;color:#e6f4f3;font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;outline:none;}
.qgtools-cl-tnum:focus{border-color:#00b4aa;background:#2a2f34;}
.qgtools-cl-tbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:30px;height:30px;padding:0 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:#d7dde2;font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;user-select:none;white-space:nowrap;}
.qgtools-cl-tbtn:hover{background:#2c333a;color:#fff;}
.qgtools-cl-tbtn.active{background:rgba(0,180,170,.16);color:#2fe3d6;border-color:#00b4aa;}
.qgtools-cl-tbtn b{font-weight:800;}
.qgtools-cl-tbtn i{font-style:italic;font-family:Georgia,"Times New Roman",serif;}
.qgtools-cl-talign{display:inline-flex;gap:2px;flex:none;}
.qgtools-cl-tcolor{position:relative;width:30px;height:30px;padding:0;border:1px solid #3a4047;border-radius:7px;background:#23272c;cursor:pointer;overflow:hidden;flex:none;}
.qgtools-cl-tcolor input[type=color]{position:absolute;inset:-4px;width:calc(100% + 8px);height:calc(100% + 8px);border:none;padding:0;background:none;cursor:pointer;z-index:2;}
/* 这个 text input 只是值的载体（保留 transparent / 颜色名不被规范化），必须不可交互：
   否则它会盖在取色器上方吃掉点击，导致「点色块没反应」。 */
.qgtools-cl-tcolor input[type=text]{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:none;padding:0;margin:0;pointer-events:none;}
/* 背景透明状态：色块显示棋盘格（表示无填充），取色器隐藏且不可点 */
.qgtools-cl-tcolor.transparent{background:repeating-conic-gradient(#33383e 0% 25%,#1c1f23 0% 50%) 50%/10px 10px;}
.qgtools-cl-tcolor.transparent input[type=color]{opacity:0;pointer-events:none;}
.qgtools-cl-tbad{flex:none;width:34px;height:30px;border:1px solid #6b2e34;background:#2a1d22;color:#e0677a;font-weight:700;}
.qgtools-cl-tbad:hover{background:#3a2730;}
.qgtools-cl-tgood{flex:none;width:34px;height:30px;border:1px solid #2e6b46;background:#15291f;color:#5fd38a;font-weight:700;}
.qgtools-cl-tgood:hover{background:#1d3a2b;}
.qgtools-cl-editor-pop{position:fixed;z-index:10002;display:none;flex-direction:column;gap:9px;width:236px;padding:13px;border:1px solid #3a4047;border-radius:10px;background:#1c1f23;box-shadow:0 12px 40px rgba(0,0,0,.6);font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#d7dde2;}
.qgtools-cl-editor-pop.open{display:flex;}
.qgtools-cl-editor-pop .qgtools-cl-pop-title{font-weight:700;color:#d7dde2;margin-bottom:1px;font-size:12px;}
.qgtools-cl-editor-pop .qgtools-cl-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.qgtools-cl-editor-pop label{color:#9ba2aa;font-size:11px;}
.qgtools-cl-editor-pop input[type=number]{width:84px;padding:4px 6px;border:1px solid #3a4047;border-radius:6px;background:#23272c;color:#e6f4f3;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;outline:none;}
.qgtools-cl-editor-pop input[type=number]:focus{border-color:#00b4aa;background:#2a2f34;}
.qgtools-cl-editor-pop input[type=range]{width:120px;accent-color:#00b4aa;}
.qgtools-cl-editor-pop .qgtools-cl-pop-check{display:flex;align-items:center;gap:6px;color:#d7dde2;}
.qgtools-cl-editor-pop .qgtools-cl-pop-color{display:flex;align-items:center;gap:8px;}
.qgtools-cl-editor-pop .qgtools-cl-pop-color input[type=color]{width:30px;height:24px;border:1px solid #3a4047;border-radius:5px;background:#23272c;cursor:pointer;padding:0;}
.qgtools-cl-editor-pop .qgtools-cl-pop-color input[type=text]{flex:1 1 auto;width:auto;padding:4px 6px;border:1px solid #3a4047;border-radius:6px;background:#23272c;color:#e6f4f3;font:12px/1 -apple-system,sans-serif;outline:none;}
.qgtools-cl-editor-pop .qgtools-cl-pop-val{color:#9aa4b2;font-size:11px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;}
/* 字体下拉（暗色，与 ComfyUI 一致） */
.qgtools-cl-combo-list.qgtools-cl-dark{background:#1c1f23;border-color:#3a4047;box-shadow:0 8px 24px rgba(0,0,0,.5);}
.qgtools-cl-combo-list.qgtools-cl-dark .qgtools-cl-combo-item{color:#d7dde2;}
.qgtools-cl-combo-list.qgtools-cl-dark .qgtools-cl-combo-item:hover{background:#2c333a;color:#fff;}
.qgtools-cl-combo-list.qgtools-cl-dark .qgtools-cl-combo-item.active{background:#00b4aa;color:#08211f;}
.qgtools-cl-combo-trigger.qgtools-cl-dark{background:#23272c;border-color:#3a4047;color:#d7dde2;height:30px;}
.qgtools-cl-combo-trigger.qgtools-cl-dark:hover,.qgtools-cl-combo-trigger.qgtools-cl-dark:focus{border-color:#00b4aa;color:#fff;}
`;
    document.head.appendChild(style);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * <input type="number"> 默认响应鼠标滚轮 —— 用户滚动画布时鼠标扫过输入框，
 * 值会被悄悄改掉（实测把字号从 20 滚成 200，8 个字量出 1600px 宽，
 * 节点直接被顶出画布，看起来像「标签消失了」）。
 *
 * 所以未聚焦时禁止滚轮改值（聚焦时保留，用户明确在调才生效）。
 */
function guardNumberInput(inp) {
    if (!inp || inp.__qgNoWheel) return inp;
    inp.__qgNoWheel = true;
    inp.addEventListener("wheel", (e) => {
        if (document.activeElement === inp) return; // 已聚焦：用户自己在调
        e.preventDefault();
        inp.blur();
    }, { passive: false });
    return inp;
}

// 离屏上下文：computeSize 拿不到画布 ctx，用它来量文字（两节点共用）
let _measureCtx = null;
function getMeasureCtx() {
    if (!_measureCtx) {
        try { _measureCtx = document.createElement("canvas").getContext("2d"); }
        catch (e) { _measureCtx = null; }
    }
    return _measureCtx;
}

function field(labelText, control) {
    const wrap = el("div", "qgtools-cl-editor-field");
    wrap.append(el("label", "", labelText), control);
    return wrap;
}

// 把任意颜色尽量转成 #rrggbb 给 <input type=color>（不支持透明/命名色时退化为白）
function toHexColor(value) {
    if (typeof value !== "string") return "#ffffff";
    const v = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    if (/^#[0-9a-f]{3}$/.test(v)) {
        return "#" + v.slice(1).split("").map((c) => c + c).join("");
    }
    if (v === "transparent" || v === "") return "#000000";
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (m) {
        const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
        const [r, g, b] = parts;
        const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
        return "#" + h(r) + h(g) + h(b);
    }
    return "#ffffff";
}

// 把表单里的当前值读成一个纯对象
function readValues(form, node, showMarkdown) {
    // 字段为空/非法时保留节点当前值，再不行才回退到默认 20
    // 上限 400：字号再大也没意义，而且会把节点宽度顶成几千 px、直接飞出画布
    // （踩过：误输入 200 让 8 个字量出 1600px 宽，节点看起来「消失」了）
    const fsRaw = (form.fontSize.value ?? "").trim();
    const fsNum = fsRaw === "" ? Number(node?.properties?.["fontSize"]) || 20 : Number(fsRaw);
    const fontSize = Math.max(1, Math.min(400, Number.isFinite(fsNum) ? fsNum : 20));
    const values = {
        text: form.text.value,
        fontSize,
        fontFamily: form.fontFamily.value || "Arial",
        fontColor: form.fontColor.value || "#ffffff",
        textAlign: form.textAlign.value || "left",
        backgroundColor: form.backgroundColor.value || "transparent",
        padding: Number(form.padding.value) || 0,
        borderRadius: Number(form.borderRadius.value) || 0,
        angle: Number(form.angle.value) || 0,
    };
    // 加粗 / 斜体 / 阴影 / 透明度：只有工具条渲染了对应控件时才读取
    if (form.bold) values.bold = !!form.bold.checked;
    if (form.italic) values.italic = !!form.italic.checked;
    if (form.shadow) values.shadow = !!form.shadow.checked;
    if (form.opacity) values.opacity = Number(form.opacity.value) || 100;
    if (showMarkdown) {
        values.markdown = !!form.markdown.checked;
        values.wrap = !!form.wrap.checked;
        values.maxWidth = Number(form.maxWidth.value) || MD_DEFAULT_MAX_WIDTH;
    }
    return values;
}

// 把一组值应用到节点上
function applyToNode(node, v) {
    node.title = v.text;
    node.properties["fontSize"] = v.fontSize;
    node.properties["fontFamily"] = v.fontFamily;
    node.properties["fontColor"] = v.fontColor;
    node.properties["textAlign"] = v.textAlign;
    node.properties["backgroundColor"] = v.backgroundColor;
    node.properties["padding"] = v.padding;
    node.properties["borderRadius"] = v.borderRadius;
    node.properties["angle"] = v.angle;
    if ("bold" in v) node.properties["bold"] = v.bold !== false;
    if ("italic" in v) node.properties["italic"] = v.italic !== false;
    if ("shadow" in v) node.properties["shadow"] = v.shadow !== false;
    if ("opacity" in v) node.properties["opacity"] = Math.max(0, Math.min(100, Number(v.opacity) || 100));
    if ("markdown" in v) node.properties["markdown"] = v.markdown !== false;
    if ("wrap" in v) node.properties["wrap"] = v.wrap !== false;
    if ("maxWidth" in v) node.properties["maxWidth"] = Number(v.maxWidth) || MD_DEFAULT_MAX_WIDTH;
    // 属性变化后让节点按内容重新量算尺寸（尺寸测量已搬进各节点的 computeSize）
    if (typeof node.computeSize === "function") {
        try {
            const s = node.computeSize();
            if (Array.isArray(s) && s[0] > 0 && s[1] > 0) node.size = s;
        } catch (e) { /* 量算失败不阻断 */ }
    }
    // 🔴 Vue（Nodes 2.0）下内容画在 DOM widget 里：直接改 title / properties 不会
    //    触发任何重绘，setDirtyCanvas 也只作用于 canvas。必须显式通知 DOM 分支重排，
    //    否则「输入框里改了字、画布上还是旧内容」。经典模式没有 __qgLabelDom，空操作。
    node.__qgLabelDom?.refresh?.();
    app.graph?.setDirtyCanvas?.(true, true);
}

const FALLBACK_FONTS = [
    "微软雅黑", "宋体", "黑体", "楷体", "仿宋", "等线",
    "Arial", "Segoe UI", "Times New Roman", "Courier New",
    "Georgia", "Verdana", "Impact", "Consolas",
];

// 两类便签的默认外观。⚠️ 它们是【唯一色源 / 尺寸源】：节点的 properties 默认值、
// draw() 与 DOM 侧的兜底、编辑器的取色器初始值都引用这里，别在别处再写字面量。
//
// 画布标签（CanvasLabel）：透明底 + 3px 内边距 + 3px 圆角 —— 它通常直接压在画面上，
//   不填充才不会挡住底图，内边距/圆角只为「万一填了色」时留出边界感。
// Markdown 便签（MarkdownNote）：#2B3A3F 深青灰卡片 + 8px 内边距 + 8px 圆角。
//   底色由 #161F21 换到 #2B3A3F 的原因：深色主题画布是 rgb(26,26,26)，
//   #161F21 与它只有 1.04:1（等于隐形），这个色是 1.47:1，能看出卡片边界。
const DEFAULT_LABEL_BG = "transparent";
const DEFAULT_MD_BG = "#2B3A3F";
const DEFAULT_LABEL_PAD = 3;
const DEFAULT_LABEL_RADIUS = 3;
const DEFAULT_MD_PAD = 8;
const DEFAULT_MD_RADIUS = 8;

// 按节点类型取默认底色（编辑器的取色器初始值要走这里，否则打开面板会显示错色）
const isMdNode = (node) => String(node?.comfyClass ?? "") === "QG_MarkdownNote";
const defaultBgOf = (node) => (isMdNode(node) ? DEFAULT_MD_BG : DEFAULT_LABEL_BG);

// 「取消/ESC 回滚」模板。仅用于把快照里没有的 key（如 shadow/opacity）归位到默认，
// 绝不覆盖快照里已有的真实值。两类节点分开，免得把另一类的默认值写进来。
const COMMON_DEFAULTS = {
    fontColor: "#ffffff", textAlign: "left", angle: 0,
    shadow: false, opacity: 100, maxWidth: MD_DEFAULT_MAX_WIDTH,
};
const LABEL_DEFAULTS = Object.assign({}, COMMON_DEFAULTS, {
    fontSize: 20, fontFamily: "Arial",
    backgroundColor: DEFAULT_LABEL_BG,
    padding: DEFAULT_LABEL_PAD, borderRadius: DEFAULT_LABEL_RADIUS,
    bold: false, italic: false, markdown: false, wrap: false,
});
const MD_DEFAULTS = Object.assign({}, COMMON_DEFAULTS, {
    fontSize: 16, fontFamily: "Arial",
    backgroundColor: DEFAULT_MD_BG,
    padding: DEFAULT_MD_PAD, borderRadius: DEFAULT_MD_RADIUS,
    markdown: true, wrap: true,
});
const defaultsFor = (node) => (isMdNode(node) ? MD_DEFAULTS : LABEL_DEFAULTS);

let openDialog = null;

// 版本标记：方便在浏览器控制台确认新 js 已加载（面板根节点也带 data-qgtools-cl-build）
const BUILD = "2026-10-22.20";
function logBuild() {
    if (window.__qgLabelBuildLogged) return;
    console.info("[QG-tools] build " + BUILD + "（标签编辑器：切渲染模式自动收起浮层、遮罩点空白即关闭）");
    window.__qgLabelBuildLogged = 1;
}

/**
 * 清掉任何残留的 QG 浮层。
 *
 * 🔴 全屏遮罩（.qgtools-cl-mdl-overlay）是 position:fixed;inset:0、背景完全透明、
 *    z-index 10000，且设计成「点空白不关闭、只吞事件」。它一旦没被正常关闭
 *    （切节点 / 切渲染模式 / 异常路径），就会永久盖在最上层 —— 画布拖不动、
 *    滚轮缩放失效、连顶部按钮都点不了，用户只能强刷页面。
 *    所以每次打开编辑器前先清一遍；也给控制台留一个手动清理入口。
 */
function killStaleFloating() {
    let n = 0;
    try { openDialog?.close?.(); } catch { /* 忽略 */ }
    openDialog = null;
    try {
        const sel = ".qgtools-cl-mdl-overlay, .qgtools-cl-editor-toolbar, "
            + ".qgtools-cl-editor-dims, .qgtools-cl-editor-pop";
        for (const e of document.querySelectorAll(sel)) {
            e.remove();
            n++;
        }
    } catch { /* 忽略 */ }
    return n;
}

// 打开标签编辑面板（暗色浮动工具条版式，画布标签节点专用）。
// 编辑时画布上的真实节点实时同步；工具条浮在节点正下方，并在节点左上角显示 W×H 尺寸徽标。
// opts: { showMarkdown, placeholder }
function openLabelEditor(node, opts) {
    killStaleFloating();
    ensureCss();
    logBuild();
    const showMarkdown = !!opts.showMarkdown;
    const snapshot = { title: node.title, properties: { ...node.properties } };

    const root = el("div", "qgtools-cl-editor-toolbar");
    root.dataset.qgLabelBuild = BUILD;
    const dims = el("div", "qgtools-cl-editor-dims", "—");
    dims.style.display = "none";

    // --- 文字 ---
    const text = el("textarea", "qgtools-cl-ttext");
    text.rows = 1;
    text.value = node.title ?? "";
    text.placeholder = opts.placeholder || (showMarkdown ? "Markdown 文本" : "标签文字");
    const textRow = el("div", "qgtools-cl-editor-textrow");
    const bar = el("div", "qgtools-cl-editor-trow");
    // 工具条版式：文字框独立上排，所有控件在下排排成一行
    textRow.append(text);
    root.append(textRow, bar);
    const actionsHost = bar;

    // --- 字号 ---
    const fontSize = el("input", "qgtools-cl-tnum");
    fontSize.type = "number";
    fontSize.min = "1";
    fontSize.max = "400";
    guardNumberInput(fontSize);
    fontSize.value = node.properties["fontSize"] ?? 20;
    bar.append(fontSize);
    bar.append(el("span", "qgtools-cl-tsep"));

    // --- 字体（自定义下拉，永远向下 + 悬停预览） ---
    const currentFont = node.properties["fontFamily"] ?? "Arial";
    let fontNames = FALLBACK_FONTS.slice();
    const fontFamily = el("input");
    fontFamily.type = "hidden";
    fontFamily.value = currentFont;
    const fontTrigger = el("button", "qgtools-cl-combo-trigger qgtools-cl-dark");
    fontTrigger.type = "button";
    const fontLabel = el("span", "qgtools-cl-combo-label", currentFont);
    const fontArrow = el("span", "qgtools-cl-combo-arrow", "▾");
    fontTrigger.append(fontLabel, fontArrow);
    const fontCombo = el("div", "qgtools-cl-combo");
    fontCombo.append(fontTrigger, fontFamily);
    bar.append(fontCombo);
    bar.append(el("span", "qgtools-cl-tsep"));

    let selectedFont = currentFont;
    let fontListEl = null;
    const restoreFontPreview = () => {
        if (fontFamily.value !== selectedFont) { fontFamily.value = selectedFont; refresh(); }
    };
    const closeFontList = () => {
        if (!fontListEl) return;
        restoreFontPreview();
        fontListEl.remove();
        fontListEl = null;
        document.removeEventListener("pointerdown", onDocPointer, true);
    };
    const onDocPointer = (e) => {
        if (!fontListEl) return;
        if (!fontListEl.contains(e.target) && !fontTrigger.contains(e.target)) closeFontList();
    };
    const buildFontList = () => {
        closeFontList();
        fontListEl = el("div", "qgtools-cl-combo-list qgtools-cl-dark");
        const names = fontNames.includes(fontFamily.value)
            ? fontNames
            : [fontFamily.value, ...fontNames];
        for (const n of names) {
            const item = el("div", "qgtools-cl-combo-item", n);
            if (n === fontFamily.value) item.classList.add("active");
            const previewWith = () => { if (fontFamily.value === n) return; fontFamily.value = n; refresh(); };
            item.addEventListener("mouseenter", previewWith);
            item.addEventListener("mousemove", previewWith);
            item.addEventListener("click", () => {
                selectedFont = n;
                fontFamily.value = n;
                fontLabel.textContent = n;
                fontFamily.dispatchEvent(new Event("input", { bubbles: true }));
                fontFamily.dispatchEvent(new Event("change", { bubbles: true }));
                closeFontList();
            });
            fontListEl.append(item);
        }
        fontListEl.addEventListener("mouseleave", restoreFontPreview);
        document.body.append(fontListEl);
        const rect = fontTrigger.getBoundingClientRect();
        fontListEl.style.left = Math.round(rect.left) + "px";
        fontListEl.style.top = Math.round(rect.bottom + 2) + "px";
        fontListEl.style.minWidth = Math.round(rect.width) + "px";
        const below = window.innerHeight - rect.bottom - 8;
        fontListEl.style.maxHeight = Math.max(Math.min(280, below), 120) + "px";
        const active = fontListEl.querySelector(".active");
        if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
        document.addEventListener("pointerdown", onDocPointer, true);
    };
    fontTrigger.addEventListener("click", () => { fontListEl ? closeFontList() : buildFontList(); });
    let fontsLoaded = false;
    const loadSystemFonts = async () => {
        if (fontsLoaded) return;
        fontsLoaded = true;
        try {
            if (typeof window.queryLocalFonts === "function") {
                const fonts = await window.queryLocalFonts();
                const seen = new Set();
                const sys = [];
                for (const f of fonts) { if (f.family && !seen.has(f.family)) { seen.add(f.family); sys.push(f.family); } }
                if (sys.length) {
                    fontNames = sys.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
                    if (fontListEl) buildFontList();
                }
            }
        } catch (e) { /* 授权拒绝等，保持回退列表 */ }
    };
    fontTrigger.addEventListener("pointerdown", loadSystemFonts, { once: true });

    // --- 加粗 / 斜体（纯文字标签节点才有；Markdown 由语法控制） ---
    let bold = null, italic = null;
    if (!showMarkdown) {
        bold = el("input"); bold.type = "checkbox"; bold.checked = !!node.properties["bold"];
        const boldBtn = el("button", "qgtools-cl-tbtn", "B");
        boldBtn.classList.toggle("active", bold.checked);
        boldBtn.addEventListener("click", () => { bold.checked = !bold.checked; boldBtn.classList.toggle("active", bold.checked); refresh(); });
        bar.append(boldBtn);

        italic = el("input"); italic.type = "checkbox"; italic.checked = !!node.properties["italic"];
        const italicBtn = el("button", "qgtools-cl-tbtn", "I");
        italicBtn.classList.toggle("active", italic.checked);
        italicBtn.addEventListener("click", () => { italic.checked = !italic.checked; italicBtn.classList.toggle("active", italic.checked); refresh(); });
        bar.append(italicBtn);
        bar.append(el("span", "qgtools-cl-tsep"));
    }

    // --- 文字颜色 ---
    const fontColor = el("input"); fontColor.type = "text"; fontColor.value = node.properties["fontColor"] ?? "#ffffff";
    const fcPicker = el("input"); fcPicker.type = "color"; fcPicker.value = toHexColor(node.properties["fontColor"] ?? "#ffffff");
    fcPicker.addEventListener("input", () => { fontColor.value = fcPicker.value; refresh(); });
    fcPicker.addEventListener("change", () => { fontColor.value = fcPicker.value; refresh(); });
    fontColor.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(fontColor.value)) fcPicker.value = fontColor.value; });
    const fcWrap = el("div", "qgtools-cl-tcolor");
    fcWrap.append(fontColor, fcPicker); // 取色器放最后 → 位于最上层，点击必到它

    bar.append(fcWrap);

    // --- 对齐（三态分段） ---
    const textAlign = el("input"); textAlign.type = "hidden"; textAlign.value = node.properties["textAlign"] ?? "left";
    const alignBox = el("div", "qgtools-cl-talign");
    for (const pair of [["left", "⇤"], ["center", "↔"], ["right", "⇥"]]) {
        const b = el("button", "qgtools-cl-tbtn", pair[1]);
        if (textAlign.value === pair[0]) b.classList.add("active");
        b.addEventListener("click", () => {
            textAlign.value = pair[0];
            for (const c of alignBox.children) c.classList.remove("active");
            b.classList.add("active");
            refresh();
        });
        alignBox.append(b);
    }
    bar.append(alignBox);
    bar.append(el("span", "qgtools-cl-tsep"));

    // --- 背景颜色（含「透明」开关：系统取色器本身给不出 transparent） ---
    const backgroundColor = el("input"); backgroundColor.type = "text"; backgroundColor.value = node.properties["backgroundColor"] ?? defaultBgOf(node);
    const bgPicker = el("input"); bgPicker.type = "color"; bgPicker.value = toHexColor(node.properties["backgroundColor"] ?? defaultBgOf(node));
    const bgWrap = el("div", "qgtools-cl-tcolor");
    bgWrap.append(backgroundColor, bgPicker); // 同上：取色器置于最上层
    const bgTransBtn = el("button", "qgtools-cl-tbtn", "透明");
    bgTransBtn.title = "背景透明（不填充底色）";
    const isBgTransparent = () => !backgroundColor.value || backgroundColor.value === "transparent";
    const syncBgTrans = () => {
        const t = isBgTransparent();
        bgTransBtn.classList.toggle("active", t);
        bgPicker.disabled = t;
        bgWrap.classList.toggle("transparent", t);
    };
    bgPicker.addEventListener("input", () => { backgroundColor.value = bgPicker.value; syncBgTrans(); refresh(); });
    bgPicker.addEventListener("change", () => { backgroundColor.value = bgPicker.value; syncBgTrans(); refresh(); });
    backgroundColor.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(backgroundColor.value)) bgPicker.value = backgroundColor.value; });
    bgTransBtn.addEventListener("click", () => {
        if (isBgTransparent()) {
            // 取消透明：用取色器当前颜色（默认黑会给个能看见的底色）
            backgroundColor.value = bgPicker.value || "#000000";
        } else {
            backgroundColor.value = "transparent";
        }
        syncBgTrans();
        refresh();
    });
    syncBgTrans();
    bar.append(bgWrap, bgTransBtn);
    bar.append(el("span", "qgtools-cl-tsep"));

    // --- 更多（弹层） ---
    const moreBtn = el("button", "qgtools-cl-tbtn", "更多");
    bar.append(moreBtn);
    bar.append(el("span", "qgtools-cl-tsep"));

    // --- 应用 / 取消 ---
    const applyBtn = el("button", "qgtools-cl-tbtn qgtools-cl-tgood", "✓");
    applyBtn.title = zh("Apply (Ctrl+Enter)");
    const cancelBtn = el("button", "qgtools-cl-tbtn qgtools-cl-tbad", "✕");
    cancelBtn.title = zh("Cancel (Esc)");
    actionsHost.append(applyBtn, cancelBtn);

    // --- 弹层内容 ---
    const pop = el("div", "qgtools-cl-editor-pop");
    const popFields = el("div");
    pop.append(popFields);

    const numField = (labelText, value, o) => {
        const row = el("div", "qgtools-cl-pop-row");
        row.append(el("label", "", labelText));
        const inp = el("input"); inp.type = "number";
        guardNumberInput(inp);
        if (o && o.min != null) inp.min = String(o.min);
        if (o && o.step != null) inp.step = String(o.step);
        inp.value = value ?? 0;
        row.append(inp);
        return { row, inp };
    };

    const pad = numField("内边距", node.properties["padding"] ?? 0, { min: 0 });
    const radius = numField("圆角", node.properties["borderRadius"] ?? 0, { min: 0 });
    const angle = numField("旋转(度)", node.properties["angle"] ?? 0);
    popFields.append(pad.row, radius.row, angle.row);

    const shadow = el("input"); shadow.type = "checkbox"; shadow.checked = !!node.properties["shadow"];
    const shadowRow = el("div", "qgtools-cl-pop-row");
    const shadowCheck = el("label", "qgtools-cl-pop-check");
    shadowCheck.append(shadow, el("span", "", "阴影"));
    shadowRow.append(shadowCheck);
    popFields.append(shadowRow);

    const opacity = el("input"); opacity.type = "range"; opacity.min = "0"; opacity.max = "100"; opacity.value = node.properties["opacity"] ?? 100;
    const opacityVal = el("span", "qgtools-cl-pop-val", (node.properties["opacity"] ?? 100) + "%");
    const opacityRow = el("div", "qgtools-cl-pop-row");
    opacityRow.append(el("label", "", "透明度"), opacity, opacityVal);
    popFields.append(opacityRow);

    let md = null, wrap = null, mwInp = null;
    if (showMarkdown) {
        md = el("input"); md.type = "checkbox"; md.checked = node.properties["markdown"] !== false;
        const mdRow = el("div", "qgtools-cl-pop-row");
        const mdCheck = el("label", "qgtools-cl-pop-check");
        mdCheck.append(md, el("span", "", "Markdown 语法"));
        mdRow.append(mdCheck);
        popFields.append(mdRow);

        wrap = el("input"); wrap.type = "checkbox"; wrap.checked = node.properties["wrap"] !== false;
        const wrapRow = el("div", "qgtools-cl-pop-row");
        const wrapCheck = el("label", "qgtools-cl-pop-check");
        wrapCheck.append(wrap, el("span", "", "自动换行"));
        wrapRow.append(wrapCheck);
        popFields.append(wrapRow);

        const mw = numField("最大宽度(px)", node.properties["maxWidth"] ?? MD_DEFAULT_MAX_WIDTH, { min: 40, step: 10 });
        popFields.append(mw.row);
        mwInp = mw.inp;
    }

    const form = { text, fontSize, fontFamily, textAlign, fontColor, backgroundColor, padding: pad.inp, borderRadius: radius.inp, angle: angle.inp, shadow, opacity };
    if (bold) form.bold = bold;
    if (italic) form.italic = italic;
    if (showMarkdown) { form.markdown = md; form.wrap = wrap; form.maxWidth = mwInp; }

    // 实时同步：任何改动都写回真实节点（画布上即时看到效果）
    const updateDims = () => {
        const w = Math.round(node.size ? node.size[0] : 0);
        const h = Math.round(node.size ? node.size[1] : 0);
        if (w > 0 && h > 0) { dims.textContent = w + " × " + h; dims.style.display = ""; }
        else { dims.style.display = "none"; }
    };
    const placeFloating = () => {
        try {
            const canvasEl = app.canvas && app.canvas.canvas;
            const ds = app.canvas && app.canvas.ds;
            if (!canvasEl || !ds || !node.pos) return;
            const rect = canvasEl.getBoundingClientRect();
            // 图坐标 → 画布元素内像素：screen = (graph + offset) × scale。
            // 实测 ComfyUI（含 Leopard-cat 集成版）的 convertOffsetToCanvas 返回的
            // 已是相对画布元素的 CSS 像素，【不要】再除 canvas.width/rect.width（DPR），
            // 否则高分屏下整条坐标会被砍半（工具条跑到左上角）。
            let px, py;
            if (typeof ds.convertOffsetToCanvas === "function") {
                const p = ds.convertOffsetToCanvas(node.pos);
                px = p[0]; py = p[1];
            } else {
                px = (node.pos[0] + ds.offset[0]) * ds.scale;
                py = (node.pos[1] + ds.offset[1]) * ds.scale;
            }
            const sx = rect.left + px;
            const sy = rect.top + py;
            const nw = node.size[0] * ds.scale;
            const nh = node.size[1] * ds.scale;
            // 工具条：水平居中于节点底边中点，垂直贴节点下方 10px；并钳制在画布视口内，宁偏移也不消失
            const rW = root.offsetWidth || 0;
            const rH = root.offsetHeight || 0;
            let centerX = sx + nw / 2;
            centerX = Math.max(rect.left + rW / 2 + 4, Math.min(rect.right - rW / 2 - 4, centerX));
            let topY = sy + nh + 10;
            topY = Math.max(rect.top + 4, Math.min(rect.bottom - rH - 4, topY));
            root.style.left = Math.round(centerX) + "px";
            root.style.top = Math.round(topY) + "px";
            root.style.transform = "translate(-50%, 0)";
            // 尺寸徽标：节点左上角上方 24px；同样钳制在视口内
            const dW = dims.offsetWidth || 0;
            const dH = dims.offsetHeight || 0;
            let dX = sx;
            dX = Math.max(rect.left + 4, Math.min(rect.right - dW - 4, dX));
            let dY = sy - 24;
            dY = Math.max(rect.top + 4, Math.min(rect.bottom - dH - 4, dY));
            dims.style.left = Math.round(dX) + "px";
            dims.style.top = Math.round(dY) + "px";
            dims.style.transform = "none";
        } catch (e) { /* ignore */ }
    };
    const refresh = () => {
        applyToNode(node, readValues(form, node, showMarkdown));
        updateDims();
        placeFloating();
    };

    // 文本框自适应高度：单行 30px，多行自动长高（上限 120px），超出由 textarea 滚动
    const autoGrow = () => {
        if (!text.style) return;
        text.style.height = "30px";
        const sh = text.scrollHeight;
        if (typeof sh === "number" && sh > 30) text.style.height = Math.min(sh + 2, 120) + "px";
    };
    // 输入 / 改变 → 实时刷新（refresh 必须是 text 的第一个 input 监听，其它逻辑排在其后）
    for (const c of [text, fontSize, fontColor, backgroundColor, pad.inp, radius.inp, angle.inp, opacity]) {
        c.addEventListener("input", refresh);
        c.addEventListener("change", refresh);
    }
    // 工具条版式：文本框随内容自动增高（单行 30px，上限 120px）
    text.addEventListener("input", autoGrow);
    autoGrow();
    shadow.addEventListener("input", refresh);
    shadow.addEventListener("change", refresh);
    if (md) { md.addEventListener("input", refresh); md.addEventListener("change", refresh); }
    if (wrap) { wrap.addEventListener("input", refresh); wrap.addEventListener("change", refresh); }

    opacity.addEventListener("input", () => { opacityVal.textContent = (Number(opacity.value) || 0) + "%"; });

    // 更多弹层开关（点击外部关闭）
    const onDocPointerPop = (e) => {
        if (pop.classList.contains("open") && !pop.contains(e.target) && !moreBtn.contains(e.target)) pop.classList.remove("open");
    };
    moreBtn.addEventListener("click", () => {
        const open = pop.classList.toggle("open");
        if (open) {
            const r = moreBtn.getBoundingClientRect();
            pop.style.left = Math.round(r.left) + "px";
            pop.style.top = Math.round(r.bottom + 6) + "px";
        }
    });
    document.addEventListener("pointerdown", onDocPointerPop, true);

    // --- 关闭 / 应用 ---
    const cleanup = () => {
        closeFontList();
        root.remove();
        dims.remove();
        pop.remove();
        if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} }
        document.removeEventListener("pointerdown", onDocPointerPop, true);
        document.removeEventListener("keydown", onKeydown, true);
        if (typeof window.removeEventListener === "function") {
            window.removeEventListener("scroll", placeFloating, true);
            window.removeEventListener("resize", placeFloating, true);
        }
        openDialog = null;
    };
    // 取消 / ESC：把快照原样写回节点。用 defaultsFor(node) 兜底——把本次会话新增、
    // 快照里没有的 key（shadow/opacity）归位到默认，避免「勾了阴影又取消却还在」的回滚遗漏。
    const close = (revert) => {
        if (revert) {
            node.title = snapshot.title;
            const restored = Object.assign({}, defaultsFor(node));
            for (const k in snapshot.properties) restored[k] = snapshot.properties[k];
            node.properties = restored;
            if (typeof node.computeSize === "function") {
                try {
                    const s = node.computeSize();
                    if (Array.isArray(s) && s[0] > 0 && s[1] > 0) node.size = s;
                } catch (e) { /* 忽略 */ }
            }
            // Vue 模式下回滚同样要重排 DOM（经典模式没有 __qgLabelDom，空操作）
            node.__qgLabelDom?.refresh?.();
            app.graph?.setDirtyCanvas?.(true, true);
        }
        cleanup();
    };
    const commit = () => { applyToNode(node, readValues(form, node, showMarkdown)); cleanup(); };

    applyBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", () => close(true));
    const onKeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); if (fontListEl) closeFontList(); else close(true); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    };
    document.addEventListener("keydown", onKeydown, true);

    // 工具条跟随节点 / 画布平移缩放（rAF 持续校正）
    let rafId = 0;
    {
        const tick = () => {
            placeFloating();
            rafId = (typeof requestAnimationFrame === "function") ? requestAnimationFrame(tick) : 0;
        };
        if (typeof requestAnimationFrame === "function") rafId = requestAnimationFrame(tick);
        if (typeof window.addEventListener === "function") {
            window.addEventListener("scroll", placeFloating, true);
            window.addEventListener("resize", placeFloating, true);
        }
    }

    document.body.append(root, dims, pop);
    // close(true) = 取消并回滚（编辑期间没写节点，等价于丢弃本次修改）
    openDialog = { overlay: root, close: () => close(true) };
    text.focus();
    refresh();
}


// 打开标签编辑面板（居中的弹窗：左侧预览 / 右侧表单字段）——Markdown 文本节点专用。
// 布局沿用「带预览」那版备份面板，但行为改为：编辑期间【不同步】画布节点，点「应用」才写回。
// opts: { heading, showMarkdown, placeholder, paint(ctx, values, w, h, view), measure(values, { width }) }
//   paint   —— 把 values 画到预览画布上（canvas 恒等于可视区大小，view.scrollTop 为当前偏移），
//              并把真实尺寸写进 ctx.canvas.__label = { w, h, fit }。
//   measure —— 返回内容在给定可视宽度下的实际占位尺寸 { w, h }，用来撑出滚动范围；
//              必须与 paint 用同一套缩放算式，否则联动比例会跑偏。
function openLabelEditorModal(node, opts) {
    // 同时只开一个 —— 但「已登记」不等于「还活着」：切渲染模式 / 异常卸载会把
    // 浮层从 DOM 摘走却留下 openDialog，此时的 return 等于永久锁死编辑器。
    // 只有登记对象确实还挂在文档里才真的跳过，否则按残留清掉再开。
    if (openDialog) {
        const alive = openDialog.overlay?.isConnected;
        if (alive) return;
        killStaleFloating();
    }
    ensureCss();
    logBuild();
    const showMarkdown = !!opts.showMarkdown;

    const overlay = el("div", "qgtools-cl-mdl-overlay");
    const dialog = el("div", "qgtools-cl-mdl");
    const head = el("div", "qgtools-cl-mdl-head");
    head.append(el("span", "qgtools-cl-mdl-title", opts.heading || "编辑标签"), el("span", "qgtools-cl-mdl-spacer"));
    const body = el("div", "qgtools-cl-mdl-body");
    const foot = el("div", "qgtools-cl-mdl-foot");
    const cancelBtn = el("button", "qgtools-cl-mdl-btn", "取消");
    cancelBtn.type = "button";
    const applyBtn = el("button", "qgtools-cl-mdl-btn primary", "应用");
    applyBtn.type = "button";
    foot.append(el("span", "qgtools-cl-mdl-spacer"), cancelBtn, applyBtn);
    dialog.append(head, body, foot);
    overlay.append(dialog);

    // --- 实时预览（左栏）：1:1 原始尺寸，超出可视区可滚动 ---
    const preview = el("canvas", "qgtools-cl-mdl-preview");
    // 撑开滚动范围的占位层（绝对定位，不参与流布局，只贡献 scrollWidth/scrollHeight）
    const previewSpace = el("div", "qgtools-cl-mdl-previewspace");
    const previewWrap = el("div", "qgtools-cl-mdl-previewwrap");
    previewWrap.append(preview, previewSpace);
    // 预览信息条：显示真实尺寸（paint 渲染时写入 preview.__label）
    const previewCap = el("span", "qgtools-cl-mdl-cap", "　");
    const previewBar = el("div", "qgtools-cl-mdl-previewbar");
    previewBar.append(previewCap);
    const split = el("div", "qgtools-cl-mdl-split");
    const previewPane = el("div", "qgtools-cl-mdl-pane qgtools-cl-mdl-previewpane");
    const fieldsPane = el("div", "qgtools-cl-mdl-pane qgtools-cl-mdl-fieldspane");
    previewPane.append(el("div", "qgtools-cl-mdl-hint", "预览"), previewWrap, previewBar);
    split.append(previewPane, fieldsPane); // 左边预览、右边编辑
    body.append(split);

    // --- 表单控件（右栏） ---
    const text = el("textarea");
    text.value = node.title ?? "";
    text.placeholder = opts.placeholder || "标签文字（多行）";
    fieldsPane.append(field("文字", text));

    let markdown = null, wrap = null, maxWidth = null;
    if (showMarkdown) {
        markdown = el("input"); markdown.type = "checkbox";
        markdown.checked = node.properties["markdown"] !== false;
        wrap = el("input"); wrap.type = "checkbox";
        wrap.checked = node.properties["wrap"] !== false;
        const mdLine = el("div", "qgtools-cl-mdl-checkline");
        mdLine.append(markdown, el("span", "qgtools-cl-mdl-hint", "Markdown"), wrap, el("span", "qgtools-cl-mdl-hint", "自动换行"));
        maxWidth = el("input"); maxWidth.type = "number";
        guardNumberInput(maxWidth);
        maxWidth.min = "40"; maxWidth.step = "10";
        maxWidth.value = Number(node.properties["maxWidth"]) || MD_DEFAULT_MAX_WIDTH;
        const mdRow = el("div", "qgtools-cl-mdl-row");
        mdRow.append(field("语法", mdLine), field("最大宽度(px)", maxWidth));
        fieldsPane.append(mdRow);
    }

    // --- 字号 ---
    const fontSize = el("input");
    fontSize.type = "number";
    fontSize.min = "1";
    fontSize.max = "400";
    guardNumberInput(fontSize);
    fontSize.value = node.properties["fontSize"] ?? 20;

    // 字体：自定义下拉（原生 <select> 的展开方向由浏览器决定，无法保证向下）
    const currentFont = node.properties["fontFamily"] ?? "Arial";
    let fontNames = FALLBACK_FONTS.slice();
    const fontFamily = el("input");
    fontFamily.type = "hidden";
    fontFamily.value = currentFont;
    const fontTrigger = el("button", "qgtools-cl-combo-trigger qgtools-cl-dark");
    fontTrigger.type = "button";
    const fontLabel = el("span", "qgtools-cl-combo-label", currentFont);
    const fontArrow = el("span", "qgtools-cl-combo-arrow", "▾");
    fontTrigger.append(fontLabel, fontArrow);
    const fontCombo = el("div", "qgtools-cl-combo");
    fontCombo.append(fontTrigger, fontFamily);

    let selectedFont = currentFont;
    let fontListEl = null;
    const restoreFontPreview = () => {
        if (fontFamily.value !== selectedFont) { fontFamily.value = selectedFont; refresh(); }
    };
    const closeFontList = () => {
        if (!fontListEl) return;
        restoreFontPreview();
        fontListEl.remove();
        fontListEl = null;
        document.removeEventListener("pointerdown", onDocPointer, true);
    };
    const onDocPointer = (e) => {
        if (!fontListEl) return;
        if (!fontListEl.contains(e.target) && !fontTrigger.contains(e.target)) closeFontList();
    };
    const buildFontList = () => {
        closeFontList();
        fontListEl = el("div", "qgtools-cl-combo-list qgtools-cl-dark");
        const names = fontNames.includes(fontFamily.value) ? fontNames : [fontFamily.value, ...fontNames];
        for (const n of names) {
            const item = el("div", "qgtools-cl-combo-item", n);
            if (n === fontFamily.value) item.classList.add("active");
            // 悬停即用该字体渲染预览，但不改动已选值
            const previewWith = () => { if (fontFamily.value === n) return; fontFamily.value = n; refresh(); };
            item.addEventListener("mouseenter", previewWith);
            item.addEventListener("mousemove", previewWith);
            item.addEventListener("click", () => {
                selectedFont = n;
                fontFamily.value = n;
                fontLabel.textContent = n;
                fontFamily.dispatchEvent(new Event("input", { bubbles: true }));
                fontFamily.dispatchEvent(new Event("change", { bubbles: true }));
                closeFontList();
            });
            fontListEl.append(item);
        }
        fontListEl.addEventListener("mouseleave", restoreFontPreview);
        document.body.append(fontListEl);
        const rect = fontTrigger.getBoundingClientRect();
        fontListEl.style.left = Math.round(rect.left) + "px";
        fontListEl.style.top = Math.round(rect.bottom + 2) + "px";
        fontListEl.style.minWidth = Math.round(rect.width) + "px";
        const below = window.innerHeight - rect.bottom - 8;
        fontListEl.style.maxHeight = Math.max(Math.min(280, below), 120) + "px";
        const active = fontListEl.querySelector(".active");
        if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
        document.addEventListener("pointerdown", onDocPointer, true);
    };
    fontTrigger.addEventListener("click", () => { fontListEl ? closeFontList() : buildFontList(); });
    let fontsLoaded = false;
    const loadSystemFonts = async () => {
        if (fontsLoaded) return;
        fontsLoaded = true;
        try {
            if (typeof window.queryLocalFonts === "function") {
                const fonts = await window.queryLocalFonts();
                const seen = new Set();
                const sys = [];
                for (const f of fonts) { if (f.family && !seen.has(f.family)) { seen.add(f.family); sys.push(f.family); } }
                if (sys.length) {
                    fontNames = sys.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
                    if (fontListEl) buildFontList();
                }
            }
        } catch (e) { /* 授权拒绝等，保持回退列表 */ }
    };
    fontTrigger.addEventListener("pointerdown", loadSystemFonts, { once: true });
    // 右栏滚动时收起 fixed 定位的字体列表
    fieldsPane.addEventListener("scroll", closeFontList);

    const row1 = el("div", "qgtools-cl-mdl-row");
    row1.append(field("字号", fontSize), field("字体", fontCombo));
    fieldsPane.append(row1);

    // --- 对齐 / 内边距 ---
    const textAlign = el("select");
    for (const o of ["left", "center", "right"]) {
        const opt = el("option", "", o === "left" ? "左" : o === "center" ? "中" : "右");
        opt.value = o;
        textAlign.append(opt);
    }
    textAlign.value = node.properties["textAlign"] ?? "left";
    const padding = el("input");
    padding.type = "number";
    guardNumberInput(padding);
    padding.min = "0";
    padding.value = node.properties["padding"] ?? 0;
    const row2 = el("div", "qgtools-cl-mdl-row");
    row2.append(field("对齐", textAlign), field("内边距", padding));
    fieldsPane.append(row2);

    // --- 文字颜色（取色器 + 文本框双向同步，可填 rgba / #RRGGBBAA） ---
    const fontColorLine = el("div", "qgtools-cl-colorline");
    const fontColorPicker = el("input");
    fontColorPicker.type = "color";
    fontColorPicker.value = toHexColor(node.properties["fontColor"] ?? "#ffffff");
    const fontColor = el("input");
    fontColor.type = "text";
    fontColor.value = node.properties["fontColor"] ?? "#ffffff";
    fontColorPicker.addEventListener("input", () => { fontColor.value = fontColorPicker.value; refresh(); });
    fontColorPicker.addEventListener("change", () => { fontColor.value = fontColorPicker.value; refresh(); });
    fontColor.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(fontColor.value)) fontColorPicker.value = fontColor.value; });
    fontColorLine.append(fontColorPicker, fontColor);
    const fontColorField = field("文字颜色", fontColorLine);

    // --- 背景颜色（transparent = 无填充） ---
    const bgLine = el("div", "qgtools-cl-colorline");
    const bgPicker = el("input");
    bgPicker.type = "color";
    bgPicker.value = toHexColor(node.properties["backgroundColor"] ?? defaultBgOf(node));
    const backgroundColor = el("input");
    backgroundColor.type = "text";
    backgroundColor.value = node.properties["backgroundColor"] ?? defaultBgOf(node);
    bgPicker.addEventListener("input", () => { backgroundColor.value = bgPicker.value; refresh(); });
    bgPicker.addEventListener("change", () => { backgroundColor.value = bgPicker.value; refresh(); });
    backgroundColor.addEventListener("input", () => { if (/^#[0-9a-fA-F]{6}$/.test(backgroundColor.value)) bgPicker.value = backgroundColor.value; });
    bgLine.append(bgPicker, backgroundColor);
    const bgField = field("背景颜色（无=透明）", bgLine);
    bgField.title = zh("Background colour: transparent means no fill");

    // 文字颜色 / 背景颜色 并排一行（半宽下取色器 + 文本框仍能放下）
    const colorRow = el("div", "qgtools-cl-mdl-row");
    colorRow.append(fontColorField, bgField);
    fieldsPane.append(colorRow);

    // --- 圆角 / 旋转 ---
    const borderRadius = el("input");
    borderRadius.type = "number";
    guardNumberInput(borderRadius);
    borderRadius.min = "0";
    borderRadius.value = node.properties["borderRadius"] ?? 0;
    const angle = el("input");
    angle.type = "number";
    guardNumberInput(angle);
    angle.value = node.properties["angle"] ?? 0;
    const row3 = el("div", "qgtools-cl-mdl-row");
    row3.append(field("圆角", borderRadius), field("旋转(度)", angle));
    fieldsPane.append(row3);

    const form = { text, fontSize, fontFamily, textAlign, padding, fontColor, backgroundColor, borderRadius, angle };
    if (showMarkdown) { form.markdown = markdown; form.wrap = wrap; form.maxWidth = maxWidth; }

    // 编辑时【不】同步到画布节点：改动只反映在左栏预览里，点「应用」才写回节点。
    body.append(el("div", "qgtools-cl-mdl-livehint", "提示：修改只在左侧预览里显示，点「应用」后才写入画布；取消则全部丢弃。"));

    // --- 预览渲染（只画预览画布，不动真实节点） ---
    // 预览交给调用方渲染（Markdown 走 md_render 排版 → 绘制）。
    // 画布恒等于可视区：内容按宽度自适应该缩放（不横向裁切），纵向超出则平移重绘。
    // 容器是 overflow:hidden —— 没有滚动条，纵向偏移只能由右侧文本框带动。
    const paint = opts.paint || (() => {});
    const refresh = () => {
        const ctx = preview.getContext && preview.getContext("2d");
        if (!ctx) return;
        const values = readValues(form, node, showMarkdown);
        // 视口尺寸：无滚动条，与内容无关，可以直接读
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, previewWrap.clientWidth || 400);
        const h = Math.max(1, previewWrap.clientHeight || 280);
        // 1) 量内容尺寸（按可视宽度等比自适应），据此撑出纵向滚动范围
        let cw = w, ch = h;
        if (typeof opts.measure === "function") {
            try {
                const m = opts.measure(values, { width: w });
                if (m) { cw = Math.max(1, Math.round(m.w)); ch = Math.max(1, Math.round(m.h)); }
            } catch (e) { /* 量算失败就只按视口画 */ }
        }
        if (previewSpace.style.width !== cw + "px") previewSpace.style.width = cw + "px";
        if (previewSpace.style.height !== ch + "px") previewSpace.style.height = ch + "px";
        // 2) 画布 = 可视区大小
        if (preview.style.width !== w + "px") preview.style.width = w + "px";
        if (preview.style.height !== h + "px") preview.style.height = h + "px";
        // 赋 width/height 会清空位图（即使值没变），滚动重绘时按需才赋，避免闪屏
        const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
        if (preview.width !== bw) preview.width = bw;
        if (preview.height !== bh) preview.height = bh;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        preview.__label = null;
        paint(ctx, values, w, h, { scrollTop: previewWrap.scrollTop || 0 });
        // paint 渲染时把真实尺寸写进 preview.__label，这里转成信息条文字
        const lb = preview.__label;
        if (lb) {
            let txt = "实际尺寸 " + lb.w + " × " + lb.h + " px";
            if (typeof lb.fit === "number" && lb.fit < 0.999) txt += " · 按宽度缩放 " + Math.round(lb.fit * 100) + "%";
            if (ch > h) txt += " · 跟随文本框滚动";
            previewCap.textContent = txt;
        }
        // 内容变短后滚动位置可能越界，夹回范围内并重绘一次
        const maxTop = Math.max(0, (Number(previewWrap.scrollHeight) || 0) - (Number(previewWrap.clientHeight) || 0));
        if ((Number(previewWrap.scrollTop) || 0) > maxTop) previewWrap.scrollTop = maxTop;
    };
    for (const c of Object.values(form)) {
        if (!c) continue;
        c.addEventListener("input", refresh);
        c.addEventListener("change", refresh);
    }

    // 文本框滚动 → 预览同步滚动（两边内容高度不同，按可滚动范围等比映射）
    const syncPreviewScroll = () => {
        const tRange = (Number(text.scrollHeight) || 0) - (Number(text.clientHeight) || 0);
        const pRange = (Number(previewWrap.scrollHeight) || 0) - (Number(previewWrap.clientHeight) || 0);
        if (tRange <= 0 || pRange <= 0) return;
        const target = Math.round(((Number(text.scrollTop) || 0) / tRange) * pRange);
        if (target !== (Number(previewWrap.scrollTop) || 0)) previewWrap.scrollTop = target;
    };
    text.addEventListener("scroll", syncPreviewScroll);
    // 预览自身滚动 / 尺寸变化时重绘（画布是固定视口的「窗口」，必须按新偏移重画）
    previewWrap.addEventListener("scroll", refresh);
    // 滚轮停在预览框上不滚动：预览只跟随右侧文本框（容器是 overflow:hidden，本就不会滚，
    // 这里再拦一道，防止以后有人把 CSS 改回 auto 又出现两边各滚各的）
    previewWrap.addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
    }, { passive: false });

    // --- 关闭 / 应用 ---
    const cleanup = () => {
        closeFontList();
        overlay.remove();
        document.removeEventListener("pointerdown", onDocPointer, true);
        document.removeEventListener("keydown", onKeydown, true);
        openDialog = null;
    };
    // 取消 / ESC：编辑期间从未写过节点，所以【不需要回滚】，直接关掉即可。
    // （旧版在这里把 snapshot 合进默认模板再写回，会顺手给节点补上
    //   shadow/opacity 两个默认键，把存档数据弄脏。）
    const close = () => cleanup();
    const commit = () => { applyToNode(node, readValues(form, node, showMarkdown)); cleanup(); };

    applyBtn.addEventListener("click", commit);
    cancelBtn.addEventListener("click", close);
    const onKeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); if (fontListEl) closeFontList(); else close(); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    };
    document.addEventListener("keydown", onKeydown, true);
    // 点击遮罩空白处 = 取消关闭（编辑期间从未写过节点，取消即丢弃修改）。
    // 🔴 绝不能只 stopPropagation 而不关闭：遮罩是全屏、背景完全透明、z-index 10000，
    //    残留一份就会永久盖住整页 —— 画布拖不动、滚轮缩放失效、顶部按钮点不了。
    overlay.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.target === overlay) close();
    });
    // 滚轮也别让它漏到画布（否则遮罩在时画布还会跟着缩放）
    overlay.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });

    document.body.append(overlay);
    openDialog = { overlay, close };
    text.focus();
    refresh();
}


// --- 画布钩子：所有「标签类」节点共用（跳过默认外观、Pin 后点击穿透） ---
const labelClasses = new Set();
let leftMouseDown = false;

function registerLabelCanvasHooks(classes) {
    for (const c of classes) labelClasses.add(c);

    // 绘制接管：跳过默认节点外观（标题栏/边框），改由各节点自己的 draw() 绘制
    if (!LGraphCanvas.prototype.__qgLabelDrawPatched) {
        LGraphCanvas.prototype.__qgLabelDrawPatched = true;
        const oldDrawNode = LGraphCanvas.prototype.drawNode;
        LGraphCanvas.prototype.drawNode = function (node, ctx) {
            if (labelClasses.has(node.constructor)) {
                node.bgcolor = "transparent";
                node.color = "transparent";
                const v = oldDrawNode.apply(this, arguments);
                const p = node.properties || {};
                // 阴影 / 透明度：统一在节点绘制外包裹一层（两节点通用）
                const op = Number(p["opacity"]);
                const useShadow = !!p["shadow"];
                ctx.save();
                if (useShadow) {
                    ctx.shadowColor = "rgba(0,0,0,.32)";
                    ctx.shadowBlur = 9;
                    ctx.shadowOffsetY = 2;
                }
                if (Number.isFinite(op) && op >= 0 && op < 100) {
                    ctx.globalAlpha = Math.max(0, Math.min(1, op / 100));
                }
                node.draw(ctx);
                ctx.restore();
                return v;
            }
            return oldDrawNode.apply(this, arguments);
        };
    }

    // Pin 后点击穿透：按下左键（非双击）时，被 Pin 的标签不再挡住下层节点
    const hookCanvas = () => {
        const canvasEl = app.canvas?.canvas;
        if (!canvasEl || canvasEl.dataset.qgCanvasLabelHooked) return false;
        canvasEl.dataset.qgCanvasLabelHooked = "1";
        canvasEl.addEventListener("pointerdown", (e) => {
            if (e.which === 1) leftMouseDown = true;
        });
        canvasEl.addEventListener("pointerup", () => {
            leftMouseDown = false;
        });
        return true;
    };
    if (!hookCanvas()) {
        const iv = setInterval(() => hookCanvas() && clearInterval(iv), 1000);
        setTimeout(() => clearInterval(iv), 30000);
    }

    if (!LGraph.prototype.__qgLabelNodeOnPosPatched) {
        LGraph.prototype.__qgLabelNodeOnPosPatched = true;
        const oldGetNodeOnPos = LGraph.prototype.getNodeOnPos;
        LGraph.prototype.getNodeOnPos = function (x, y, nodes_list) {
            if (
                nodes_list &&
                leftMouseDown &&
                LGraphCanvas.active_canvas?.last_mouseclick != null &&
                LiteGraph.getTime() - LGraphCanvas.active_canvas.last_mouseclick >= 300
            ) {
                nodes_list = [...nodes_list].filter(
                    (n) => !labelClasses.has(n.constructor) || !n.flags?.pinned
                );
            }
            return oldGetNodeOnPos.apply(this, [x, y, nodes_list]);
        };
    }
}

export { ensureCss, el, field, toHexColor, getMeasureCtx, openLabelEditor, openLabelEditorModal, registerLabelCanvasHooks, killStaleFloating, DEFAULT_LABEL_BG, DEFAULT_MD_BG, DEFAULT_LABEL_PAD, DEFAULT_LABEL_RADIUS, DEFAULT_MD_PAD, DEFAULT_MD_RADIUS };
