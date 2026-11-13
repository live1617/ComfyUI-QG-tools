/**
 * QG 注释 —— ComfyUI 画布上的便签节点。
 *
 * 搬入说明（2026-11-08，用户确认后 1:1 搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/qg_note.js
 *   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_Note
 *
 *   只做四类必要改动，绘制与交互逻辑一行未改：
 *     1) import 路径 ../../scripts/app.js -> /scripts/app.js（本包约定：内置脚本绝对路径）；
 *     2) CSS 类前缀 .qg-* -> .qgtools-*（本包约定），选择器与 className 同步改；
 *     3) 界面文案英化 + zhPair（工具栏标签、右键菜单、默认文本、配色预设名）；
 *        显示名 "QG 注释" -> "Note"（本包不许显示名带 QG 前缀）；
 *     4) 分类 "QG 工具" -> "QG-tools/Workflow"，注入的 def 里 python_module 改成本包。
 *
 * 交互参照本机 Goohaitools 的「孤海注释」，但代码独立重写，做法上有几处不同：
 *   1. 后端补了一个 QG_Note 节点定义，所以「添加节点 → QG-tools」里能直接搜到；
 *      原版是纯前端注册，/object_info 里没有，菜单搜不到。
 *   2. 不定义 onDrawBackground（LiteGraph 会在 drawNode 内部调它），改为在
 *      drawNode 的局部 patch 里调一次 paint()，避免同一帧把文字画两遍；
 *      这个 patch 同时覆盖新前端 Vue 节点模式（drawNode 会提前 return）。
 *   3. 固定节点直接用 flags.allow_interaction —— 本机前端 resolvePointerTarget
 *      会据此忽略节点、让点击穿透，不需要像原版那样全局改 getNodeOnPos。
 *   4. 链接额外支持 [[显示文字|网址]] 写法。
 *
 * 节点本身没有任何输入/输出，isVirtualNode，不进入 prompt。
 * 后端节点：nodes/qg_note.py。改本文件只需 F5 刷新页面。
 */
import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=2026111208";
import { pinCategory } from "../shared/category_zh.mjs?v=2026111208";

const NODE_TYPE = "QG_Note";
const FONT_STACK = 'Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif';
const LINK_COLOR = "#69c0ff";
const EDITOR_STYLE_ID = "qgtools-note-editor-style";

/**
 * 默认文本（节点里那行提示）必须**延迟求值**：模块顶层跑的时候
 * `app.i18n` 还没建好、`<html lang>` 还是模板里的 en，此刻 zhPair 会定稿成英文，
 * 之后切中文界面这行提示仍然是英文（11-08 真机实测：节点标题是中文，只有它英文）。
 * 所以 DEFAULTS 里的 text 留空，真正取默认值走 defaultText()。
 */
const defaultText = () => zhPair("Double-click to edit…", "双击编辑注释…");

const DEFAULTS = {
    // text 不放在这里：它是延迟求值的（见 defaultText），放进来会被定稿成英文。
    fontSize: 26,
    fontColor: "#dbe7f3",
    backgroundColor: "#16283f",
    backgroundAlpha: 0.42,
    borderRadius: 16,
    padding: 14,
    lineHeight: 1.4,
    textAlign: "center",
    stroke: true,
};

// 键是英文（存进 properties 的只有颜色值，键只用于菜单），
// 菜单里显示中文名，所以标签放在 label 里由 zhPair 决定。
const PRESETS = {
    "deep-blue": { label: () => zhPair("Deep blue", "深蓝"), backgroundColor: "#16283f", backgroundAlpha: 0.42, fontColor: "#dbe7f3", stroke: true },
    moss: { label: () => zhPair("Moss green", "苔绿"), backgroundColor: "#13291f", backgroundAlpha: 0.42, fontColor: "#d8ecdd", stroke: true },
    sand: { label: () => zhPair("Warm sand", "暖沙"), backgroundColor: "#2b2117", backgroundAlpha: 0.42, fontColor: "#f0e3ca", stroke: true },
    none: { label: () => zhPair("No fill", "无底色"), backgroundColor: "#16283f", backgroundAlpha: 0, fontColor: "#dbe7f3", stroke: false },
};

const noTitleMode = () => globalThis.LiteGraph?.NO_TITLE ?? 1;
/** active_canvas 只在发生过鼠标交互后才被 LiteGraph 赋值，app.canvas 更可靠。 */
const activeCanvas = () => globalThis.LGraphCanvas?.active_canvas || app.canvas || null;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isCJK = (ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch);
const LEAD_FORBIDDEN = new Set(
    [",", ".", ";", ":", "!", "?", "，", "。", "；", "：", "！", "？",
        "、", "）", "」", "』", "”", "’", "】", "》"].flatMap((c) => [...c])
);
const LINK_RE = /\[\[([^\]]+)\]\]|https?:\/\/[^\s<>"'）】]+|www\.[^\s<>"'）】]+/g;

/* ---------------- 文本处理 ---------------- */

function normText(value) {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\\n/g, "\n"); // 工作流里存的字面 \n 也当换行
}

function hexParts(hex) {
    let h = String(hex || "").trim();
    if (!h.startsWith("#")) h = "#" + h;
    if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    if (h.length !== 7) return [22, 40, 63];
    const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    return rgb.some(Number.isNaN) ? [22, 40, 63] : rgb;
}

function rgba(hex, alpha) {
    const [r, g, b] = hexParts(hex);
    return `rgba(${r}, ${g}, ${b}, ${clamp(Number(alpha) || 0, 0, 1)})`;
}

function brighter(hex, amount) {
    const [r, g, b] = hexParts(hex);
    return `#${[r, g, b].map((v) => clamp(v + amount, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function roundPath(ctx, w, h, radius) {
    const r = clamp(Number(radius) || 0, 0, Math.min(w, h) / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(0, 0, w, h, r);
        return;
    }
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
}

/** 把文本切成逐字符 token，链接 token 带 url；[[标签|网址]] 只显示标签。 */
function tokenize(text) {
    const tokens = [];
    const push = (s, url) => { for (const ch of s) tokens.push({ ch, url }); };
    LINK_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = LINK_RE.exec(text)) !== null) {
        if (m.index > last) push(text.slice(last, m.index), null);
        if (m[1] !== undefined) {
            const bar = m[1].indexOf("|");
            const label = bar >= 0 ? m[1].slice(0, bar) : m[1];
            const url = bar >= 0 ? m[1].slice(bar + 1) : m[1];
            push(label, url);
        } else {
            push(m[0], m[0]);
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) push(text.slice(last), null);
    return tokens;
}

function groupTokens(tokens) {
    const groups = [];
    for (const t of tokens) {
        const prev = groups[groups.length - 1];
        if (prev && prev.url === t.url) prev.text += t.ch;
        else groups.push({ url: t.url, text: t.ch });
    }
    return groups;
}

/** 按画布宽度折行：CJK 逐字可断，西文尽量在空格处断，行首标点回挂上一行。 */
function layoutText(ctx, text, maxWidth) {
    const lines = [];
    let line = [];
    let width = 0;
    const widthOf = (arr) => arr.reduce((s, t) => s + ctx.measureText(t.ch).width, 0);
    const flush = () => { lines.push(line); line = []; width = 0; };

    for (const tok of tokenize(text)) {
        if (tok.ch === "\n") { flush(); continue; }
        const cw = ctx.measureText(tok.ch).width;
        if (line.length && width + cw > maxWidth) {
            let cut = -1;
            if (!isCJK(tok.ch)) {
                for (let i = line.length - 1; i >= Math.max(0, line.length - 28); i--) {
                    if (/\s/.test(line[i].ch)) { cut = i + 1; break; }
                }
            }
            const tail = cut > 0 && cut < line.length ? line.slice(cut) : [];
            lines.push(cut > 0 && cut < line.length ? line.slice(0, cut) : line);
            line = tail;
            width = widthOf(line);
            // 行首禁则：标点不能落在行首，回挂到上一行末尾
            if (line.length && LEAD_FORBIDDEN.has(line[0].ch) && lines.length) {
                const prev = lines[lines.length - 1];
                while (line.length && LEAD_FORBIDDEN.has(line[0].ch)) prev.push(line.shift());
                width = widthOf(line);
            }
        }
        line.push(tok);
        width += cw;
    }
    if (line.length || lines.length === 0) lines.push(line);
    return lines.map(groupTokens);
}

/** 排版结果缓存。
 *
 * 拖动/缩放画布时 LiteGraph 每帧重绘所有节点，而 layoutText 要对每个字符
 * 调一次 measureText——一段几百字的便签就是每帧几百次测量，长文便签拖起来
 * 会明显掉帧。文本、可用宽度、字号三者都没变时直接复用上次的行数组：这三样
 * 正是排版结果的全部输入。
 */
function layoutCached(node, ctx, text, maxWidth, font) {
    const cache = node.__qgLayout;
    if (cache && cache.text === text && cache.maxWidth === maxWidth
        && cache.font === font) {
        return cache.lines;
    }
    const lines = layoutText(ctx, text, maxWidth);
    node.__qgLayout = { text, maxWidth, font, lines };
    return lines;
}

/* ---------------- 编辑器 DOM ---------------- */

function ensureEditorStyle() {
    if (document.getElementById(EDITOR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = EDITOR_STYLE_ID;
    style.textContent = `
        .qgtools-note-toolbar, .qgtools-note-toolbar * { pointer-events: auto !important; }
        .qgtools-note-toolbar {
            position: absolute; width: 372px; box-sizing: border-box;
            padding: 10px 12px; border-radius: 10px;
            border: 1px solid rgba(105, 192, 255, .38);
            background: rgba(16, 28, 42, .92); color: #e8f2fb;
            box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
            backdrop-filter: blur(12px); font: 12px ${FONT_STACK};
            z-index: 2147483000; display: flex; flex-direction: column; gap: 7px;
        }
        .qgtools-note-toolbar .qgtools-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
        .qgtools-note-toolbar .qgtools-label { min-width: 36px; color: #9fb6cc; flex: none; }
        .qgtools-note-toolbar .qgtools-value { min-width: 30px; text-align: right; color: #9fb6cc; flex: none; }
        .qgtools-note-toolbar input[type="range"] {
            flex: 1; height: 18px; accent-color: ${LINK_COLOR}; background: transparent;
        }
        .qgtools-note-toolbar input[type="color"] {
            width: 52px; height: 22px; padding: 0; border: 0; border-radius: 4px;
            background: transparent; cursor: pointer;
        }
        .qgtools-note-toolbar button {
            border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
            background: rgba(255,255,255,.08); color: #dceaf7; cursor: pointer;
            padding: 2px 9px; font: 12px ${FONT_STACK};
        }
        .qgtools-note-toolbar button.is-active {
            border-color: ${LINK_COLOR}; color: ${LINK_COLOR};
            background: rgba(105,192,255,.16);
        }
        .qgtools-note-toolbar label.qgtools-check { display: flex; align-items: center; gap: 5px; cursor: pointer; }
        .qgtools-note-hint { color: #7f98af; font-size: 11px; text-align: right; }
        .qgtools-note-editor {
            position: absolute; z-index: 2147482999; box-sizing: border-box;
            border: 0; outline: none; resize: none; overflow: auto;
            background: transparent !important; box-shadow: none !important;
            padding: 0; pointer-events: auto !important;
        }
    `;
    document.head.appendChild(style);
}

function makeRow(labelText) {
    const row = document.createElement("div");
    row.className = "qgtools-row";
    const label = document.createElement("span");
    label.className = "qgtools-label";
    label.textContent = labelText;
    row.appendChild(label);
    return row;
}

function makeSlider(node, row, key, min, max, step, onChange) {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(node.properties[key]);
    const value = document.createElement("span");
    value.className = "qgtools-value";
    const show = () => {
        value.textContent = step < 1
            ? Number(node.properties[key]).toFixed(step < 0.1 ? 2 : 1)
            : String(Math.round(Number(node.properties[key])));
    };
    show();
    input.addEventListener("input", () => {
        node.properties[key] = Number(input.value);
        show();
        onChange?.();
        node.repaint();
    });
    row.appendChild(input);
    row.appendChild(value);
    return { input, show };
}

function makeColor(node, row, key) {
    const input = document.createElement("input");
    input.type = "color";
    input.value = node.properties[key];
    input.addEventListener("input", () => {
        node.properties[key] = input.value;
        node.repaint();
    });
    row.appendChild(input);
    return input;
}

/* ---------------- 节点 ---------------- */

class QGNoteNode extends LGraphNode {
    constructor(title) {
        super(title ?? "Note");
        this.type = NODE_TYPE;
        this.comfyClass = NODE_TYPE;
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        this.resizable = true;
        this.size = [560, 120];
        this.color = "#fff0";
        this.bgcolor = "transparent";
        this.properties = { ...DEFAULTS, text: defaultText() };
        this.flags = { pinned: false, allow_interaction: true };
        this.linkAreas = [];
        this.editing = false;
        this.toolbar = null;
        this.textarea = null;
        this.snapshot = null;
        this.rafId = 0;
    }

    applySaved(info) {
        const p = this.properties || (this.properties = {});
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (p[k] === undefined || p[k] === null) p[k] = v;
        }
        // 文本单独补：空串是「用户把它清空了」，要保留；只有 undefined/null 才给默认值
        if (p.text === undefined || p.text === null) p.text = defaultText();
        // 从别处复制 / 旧版本迁移时补一份最小尺寸，避免出现 0 宽节点
        this.size = [
            Math.max(120, Number(this.size?.[0]) || 560),
            Math.max(60, Number(this.size?.[1]) || 120),
        ];
        this.color = "#fff0";
        this.bgcolor = "transparent";
        this.resizable = true;
        this.serialize_widgets = true;
        this.isVirtualNode = true;
        this.flags = this.flags || {};
        this.flags.allow_interaction = !this.flags.pinned;
        if (info) this.title = this.title || "Note";
        this.setDirtyCanvas?.(true, true);
    }

    onConfigure() { this.applySaved(); }

    repaint() {
        // 面板画在 drawNode（前景层），两层都标脏，确保静止时也会重绘一次
        this.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    }

    /** 唯一的绘制入口：由 drawNode 的局部 patch 调用，ctx 已平移到节点原点。 */
    paint(ctx) {
        const p = this.properties;
        const [w, h] = this.size;
        ctx.save();

        roundPath(ctx, w, h, p.borderRadius);
        ctx.fillStyle = rgba(p.backgroundColor, p.backgroundAlpha);
        ctx.fill();

        const active = !!this.selected || !!this.editing;
        if (p.stroke || active) {
            roundPath(ctx, w - 1, h - 1, p.borderRadius);
            ctx.lineWidth = active ? 2 : 1;
            ctx.strokeStyle = active
                ? LINK_COLOR
                : rgba(brighter(p.backgroundColor, 70), clamp(Number(p.backgroundAlpha) + 0.4, 0.15, 1));
            ctx.stroke();
        }

        if (this.editing) { ctx.restore(); return; }

        const fontSize = Number(p.fontSize) || 26;
        ctx.font = `${fontSize}px ${FONT_STACK}`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        const lineH = fontSize * (Number(p.lineHeight) || 1.4);
        const lines = layoutCached(
            this, ctx, normText(p.text),
            Math.max(12, w - 2 * (Number(p.padding) || 0)),
            ctx.font);
        /* 文本块高度 = (行数-1)*行距 + 字号：最后一行只占一个字号，不再补一整行行距。
         * 之前写成 行数*行距，等于在最后一行下面多算 0.4 倍字号，居中时整块就被顶上去
         * 半个字号 —— 表现就是"字贴着上边框"。
         * 再补 字号/10 的视觉下沉：textBaseline="top" 用的是字体 em 框顶，汉字墨迹本身
         * 在 em 框内还有一小段空白，原版孤海注释也是这么补的，补完上边距才对得上。 */
        const blockH = Math.max(0, lines.length - 1) * lineH + fontSize;
        const top = Math.max(4, (h - blockH) / 2 + fontSize / 10);
        this.linkAreas = [];

        lines.forEach((groups, i) => {
            const total = groups.reduce((s, g) => s + ctx.measureText(g.text).width, 0);
            let x = p.textAlign === "left" ? (Number(p.padding) || 0)
                : p.textAlign === "right" ? w - (Number(p.padding) || 0) - total
                    : (w - total) / 2;
            const y = top + i * lineH;
            for (const g of groups) {
                const gw = ctx.measureText(g.text).width;
                if (g.url) {
                    this.linkAreas.push({ x, y, w: gw, h: lineH, url: g.url });
                    ctx.fillStyle = LINK_COLOR;
                    ctx.fillText(g.text, x, y);
                    ctx.beginPath();
                    ctx.moveTo(x, y + (Number(p.fontSize) || 26) * 1.02);
                    ctx.lineTo(x + gw, y + (Number(p.fontSize) || 26) * 1.02);
                    ctx.strokeStyle = LINK_COLOR;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                } else {
                    ctx.fillStyle = p.fontColor;
                    ctx.fillText(g.text, x, y);
                }
                x += gw;
            }
        });
        ctx.restore();
    }

    /* --- 编辑器 --- */

    buildToolbar() {
        const node = this;
        const bar = document.createElement("div");
        bar.className = "qgtools-note-toolbar";

        const alignRow = makeRow(zhPair("Align", "对齐"));
        this.alignButtons = {};
        for (const [key, label] of [["left", zhPair("L", "左")],
                                    ["center", zhPair("C", "中")],
                                    ["right", zhPair("R", "右")]]) {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.addEventListener("click", () => {
                node.properties.textAlign = key;
                this.syncAlignButtons();
                node.repaint();
            });
            this.alignButtons[key] = btn;
            alignRow.appendChild(btn);
        }
        const strokeLabel = document.createElement("label");
        strokeLabel.className = "qgtools-check";
        const strokeBox = document.createElement("input");
        strokeBox.type = "checkbox";
        strokeBox.checked = !!this.properties.stroke;
        strokeBox.addEventListener("change", () => {
            node.properties.stroke = strokeBox.checked;
            node.repaint();
        });
        strokeLabel.append(strokeBox, document.createTextNode(zhPair("Outline", "描边")));
        strokeLabel.style.marginLeft = "auto";
        alignRow.appendChild(strokeLabel);
        bar.appendChild(alignRow);
        this.syncAlignButtons();

        const textRow = makeRow(zhPair("Text", "文字"));
        this.textColorInput = makeColor(this, textRow, "fontColor");
        makeSlider(this, textRow, "fontSize", 8, 200, 1, () => this.syncEditorStyle());
        bar.appendChild(textRow);

        const bgRow = makeRow(zhPair("Fill", "底色"));
        this.bgColorInput = makeColor(this, bgRow, "backgroundColor");
        makeSlider(this, bgRow, "backgroundAlpha", 0, 1, 0.05);
        bar.appendChild(bgRow);

        const shapeRow = makeRow(zhPair("Radius", "圆角"));
        makeSlider(this, shapeRow, "borderRadius", 0, 200, 1);
        bar.appendChild(shapeRow);

        const lhRow = makeRow(zhPair("Line height", "行距"));
        makeSlider(this, lhRow, "lineHeight", 0.8, 3, 0.1);
        bar.appendChild(lhRow);

        const hint = document.createElement("div");
        hint.className = "qgtools-note-hint";
        hint.textContent = zhPair(
            "Ctrl+Enter saves · Esc cancels · click outside saves",
            "Ctrl + Enter 保存 · Esc 取消 · 点空白处保存");
        bar.appendChild(hint);
        return bar;
    }

    syncAlignButtons() {
        if (!this.alignButtons) return;
        for (const [key, btn] of Object.entries(this.alignButtons)) {
            btn.classList.toggle("is-active", this.properties.textAlign === key);
        }
    }

    syncEditorStyle() {
        if (!this.textarea) return;
        const p = this.properties;
        const scale = activeCanvas()?.ds?.scale || 1;
        Object.assign(this.textarea.style, {
            fontFamily: FONT_STACK,
            fontSize: `${(Number(p.fontSize) || 26) * scale}px`,
            lineHeight: String(Number(p.lineHeight) || 1.4),
            color: p.fontColor,
            textAlign: p.textAlign,
            caretColor: p.fontColor,
        });
    }

    placeEditor() {
        if (!this.editing || !this.textarea || !this.toolbar) return;
        const c = activeCanvas();
        if (!c?.canvas) return;
        const rect = c.canvas.getBoundingClientRect();
        const s = c.ds?.scale || 1;
        const off = c.ds?.offset || [0, 0];
        const left = rect.left + (this.pos[0] + off[0]) * s;
        const top = rect.top + (this.pos[1] + off[1]) * s;
        const pad = Number(this.properties.padding) || 0;

        Object.assign(this.textarea.style, {
            left: `${left + pad * s}px`,
            top: `${top + 8 * s}px`,
            width: `${Math.max(40, (this.size[0] - 2 * pad) * s)}px`,
            height: `${Math.max(30, (this.size[1] - 16) * s)}px`,
        });
        const barH = this.toolbar.offsetHeight || 210;
        let barTop = top - barH - 10;
        if (barTop < 4) barTop = top + this.size[1] * s + 10;
        Object.assign(this.toolbar.style, {
            left: `${clamp(left, 4, Math.max(4, window.innerWidth - 380))}px`,
            top: `${clamp(barTop, 4, Math.max(4, window.innerHeight - barH - 4))}px`,
        });
        this.syncEditorStyle();
    }

    openEditor() {
        if (this.editing || !activeCanvas()?.canvas) return;
        ensureEditorStyle();
        this.snapshot = { ...this.properties };
        this.editing = true;

        this.toolbar = this.buildToolbar();
        document.body.appendChild(this.toolbar);

        const ta = document.createElement("textarea");
        ta.className = "qgtools-note-editor";
        ta.spellcheck = false;
        ta.value = normText(this.properties.text);
        document.body.appendChild(ta);
        this.textarea = ta;
        this.placeEditor();
        ta.focus();
        ta.select();

        const tick = () => {
            if (!this.editing) return;
            this.placeEditor();
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);

        ta.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") this.closeEditor(false);
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.closeEditor(true);
        });
        ta.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.toolbar.addEventListener("pointerdown", (e) => e.stopPropagation());

        // 延迟绑定，避开打开编辑器那一次双击/点击事件
        setTimeout(() => {
            if (!this.editing) return;
            this.outsideHandler = (e) => {
                if (!this.editing) return;
                const inside = this.textarea?.contains(e.target) || this.toolbar?.contains(e.target);
                if (!inside) this.closeEditor(true);
            };
            document.addEventListener("pointerdown", this.outsideHandler, true);
        }, 0);
        this.repaint();
    }

    closeEditor(save) {
        if (!this.editing) return;
        if (save && this.textarea) this.properties.text = this.textarea.value;
        else if (this.snapshot) Object.assign(this.properties, this.snapshot);

        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        if (this.outsideHandler) {
            document.removeEventListener("pointerdown", this.outsideHandler, true);
            this.outsideHandler = null;
        }
        this.textarea?.remove();
        this.toolbar?.remove();
        this.textarea = null;
        this.toolbar = null;
        this.alignButtons = null;
        this.snapshot = null;
        this.editing = false;
        this.repaint();
        app.graph?.change?.();
    }

    /* --- 交互 --- */

    openLink(url) {
        let target = String(url || "").trim();
        if (!target) return;
        if (!/^(https?:\/\/|www\.)/i.test(target)) target = "https://" + target;
        window.open(target, "_blank", "noopener");
    }

    onMouseDown(evt, pos) {
        if (this.editing) return false;
        if (evt?.button === 0 && this.linkAreas.length && Array.isArray(pos)) {
            for (const a of this.linkAreas) {
                if (pos[0] >= a.x && pos[0] <= a.x + a.w && pos[1] >= a.y && pos[1] <= a.y + a.h) {
                    this.openLink(a.url);
                    return true;
                }
            }
        }
        // 固定后不允许拖动；右键仍放行，保留右键菜单
        if (this.flags?.pinned && evt?.button === 0) return true;
        return false;
    }

    onDblClick() { this.openEditor(); }

    onResize(size) {
        // 🔴 1.58.5 的 size 参数可能是 Float64Array，也可能是 Rectangle 类数组，
        // 两种都过不了 Array.isArray；只要能按下标读到两个有限数就按尺寸处理。
        if (size && typeof size.length === "number" && size.length >= 2
            && Number.isFinite(size[0]) && Number.isFinite(size[1])) {
            this.size[0] = Math.max(120, size[0]);
            this.size[1] = Math.max(60, size[1]);
            this.repaint();
        }
    }

    onRemoved() { this.closeEditor(false); }

    getExtraMenuOptions(_node, options) {
        options.unshift({ content: zhPair("Edit text", "编辑文本"),
            callback: () => this.openEditor() });
        options.push({
            content: this.flags?.pinned
                ? zhPair("Unpin", "取消固定")
                : zhPair("Pin (clicks pass through)", "固定节点（点击穿透）"),
            callback: () => {
                this.flags = this.flags || {};
                this.flags.pinned = !this.flags.pinned;
                this.flags.allow_interaction = !this.flags.pinned;
                this.repaint();
            },
        });
        options.push({
            content: zhPair("Copy text", "复制文本"),
            callback: () => navigator.clipboard?.writeText(normText(this.properties.text)),
        });
        for (const preset of Object.values(PRESETS)) {
            // label 是菜单文案（函数），不能随 Object.assign 写进 properties：
            // 属性表会跟着工作流序列化，塞个函数进去只会变成 undefined 字段。
            const { label, ...colours } = preset;
            options.push({
                content: zhPair("Theme: ", "配色：") + label(),
                callback: () => { Object.assign(this.properties, colours); this.repaint(); },
            });
        }
        options.push({
            content: zhPair("Reset style", "重置样式"),
            // 有意修正源包的一处缺陷：源包的 DEFAULTS 里有 text，于是点「重置样式」
            // 会把便签文字一起清掉。这里 DEFAULTS 不含 text（它走 defaultText()），
            // 所以重置的只是样式，内容原样保留。
            callback: () => { Object.assign(this.properties, DEFAULTS); this.repaint(); },
        });
    }
}

QGNoteNode.title = "Note";
QGNoteNode.title_mode = noTitleMode();
QGNoteNode.collapsable = false;
QGNoteNode.category = "QG-tools/Workflow";

/* ---------------- 全局挂接（尽量局部、只认自己的节点） ---------------- */

let patched = false;
const CanvasProto = globalThis.LGraphCanvas?.prototype;
if (CanvasProto && typeof CanvasProto.drawNode === "function") {
    const original = CanvasProto.drawNode;
    CanvasProto.drawNode = function (node, ctx) {
        if (!(node instanceof QGNoteNode)) return original.apply(this, arguments);
        node.color = "#fff0";
        node.bgcolor = "transparent";
        const wasSelected = !!node.selected;
        if (wasSelected) node.selected = false; // 用自绘边框代替 LiteGraph 的选中框
        const result = original.apply(this, arguments);
        if (wasSelected) node.selected = true;
        node.paint(ctx); // ctx 此时已平移到节点原点；Vue 节点模式下也照常画
        return result;
    };
    patched = true;
}
if (!patched) {
    // 极旧前端没有 LGraphCanvas.prototype 可 patch 时，退回 LiteGraph 自带的钩子
    QGNoteNode.prototype.onDrawBackground = function (ctx) { this.paint(ctx); };
}

/* 右键按住左右拖动 = 等比缩放文字与底板；右下角 24px 留给原生 resize */
let scaleState = null;
let suppressMenuUntil = 0;

function noteAtEvent(e) {
    const c = activeCanvas();
    if (!c?.graph || !c.canvas) return null;
    const pos = c.convertEventToCanvasOffset?.(e);
    if (!pos) return null;
    const nodes = c.visible_nodes || c.graph._nodes || [];
    const node = c.graph.getNodeOnPos(pos[0], pos[1], nodes);
    if (!(node instanceof QGNoteNode) || node.editing) return null;
    return { node, pos };
}

document.addEventListener("pointerdown", (e) => {
    if (e.button !== 2) return;
    const hit = noteAtEvent(e);
    if (!hit) return;
    const { node, pos } = hit;
    const lx = pos[0] - node.pos[0];
    const ly = pos[1] - node.pos[1];
    if (lx > node.size[0] - 24 && ly > node.size[1] - 24) return;
    scaleState = {
        node,
        startX: e.clientX,
        font: Number(node.properties.fontSize) || 26,
        size: [node.size[0], node.size[1]],
        moved: false,
    };
}, true);

document.addEventListener("pointermove", (e) => {
    if (!scaleState || !(e.buttons & 2)) return;
    const delta = e.clientX - scaleState.startX;
    if (Math.abs(delta) < 2) return;
    const { node } = scaleState;
    const next = clamp(scaleState.font + delta / 4, 8, 200);
    const k = next / scaleState.font;
    node.properties.fontSize = next;
    node.size[0] = Math.max(120, scaleState.size[0] * k);
    node.size[1] = Math.max(60, scaleState.size[1] * k);
    scaleState.moved = true;
    node.repaint();
    e.preventDefault();
    e.stopPropagation();
}, true);

function endScale() {
    if (scaleState?.moved) suppressMenuUntil = Date.now() + 350;
    scaleState = null;
}
document.addEventListener("pointerup", endScale, true);
document.addEventListener("pointercancel", endScale, true);
window.addEventListener("blur", endScale);

document.addEventListener("contextmenu", (e) => {
    if (Date.now() < suppressMenuUntil) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true);

/* 新前端 Vue 节点层会吃掉双击，这里把 node-body 上的双击转回节点 */
document.addEventListener("dblclick", (e) => {
    const body = e.target?.closest?.('[data-testid^="node-body-"]');
    if (!body) return;
    if (e.target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    const id = body.getAttribute("data-testid").slice("node-body-".length);
    const node = app.canvas?.graph?.getNodeById?.(id);
    if (!(node instanceof QGNoteNode)) return;
    node.openEditor();
    e.preventDefault();
    e.stopPropagation();
}, true);

const qgNoteExtension = {
    name: "QG.Note",

    /** 后端 /object_info 是启动时构建的：没重启之前里面没有 QG_Note，
     *  节点搜索菜单就搜不到。这里补一份纯展示用的定义，刷新页面即可使用；
     *  重启后端后 defs 里已有真实定义，直接跳过（以后端为准）。
     *  节点是 isVirtualNode 且无输出，不会被 graphToPrompt 提交给后端。 */
    async addCustomNodeDefs(defs) {
        qgNoteExtension.defInjected = false;
        if (!defs || defs[NODE_TYPE]) return;
        defs[NODE_TYPE] = {
            name: NODE_TYPE,
            display_name: "Note",
            description: "Canvas sticky note / title card. Double-click to edit; "
                + "CJK wrapping, links, right-drag scaling and colour presets. "
                + "Presentation only, never queued.",
            category: "QG-tools/Workflow",
            input: { required: {} },
            output: [],
            output_name: [],
            output_node: false,
            python_module: "custom_nodes.ComfyUI-QG-tools",
        };
        qgNoteExtension.defInjected = true;
    },

    registerCustomNodes() {
        // 覆盖掉 /object_info 自动生成的类，让节点走自己的绘制与序列化；
        // 分类由后端 CATEGORY（或上面注入的 def）决定。
        LiteGraph.registerNodeType(NODE_TYPE, QGNoteNode);
        QGNoteNode.type = NODE_TYPE;
        QGNoteNode.comfyClass = NODE_TYPE;
        QGNoteNode.title = "Note";
        QGNoteNode.title_mode = noTitleMode();
        QGNoteNode.collapsable = false;
        // registerNodeType 会把 category 重置为空；补回去，旧版 LiteGraph
        // 的节点菜单靠它分类（新版菜单读的是 defs 里的 category）。
        // 🔴 必须用 pinCategory：它把英文尾段 + 中文译名一起钉住，只写英文的话
        //    中文界面下这个节点会永远停在英文分类（纯前端裸节点最常漏的一手）。
        pinCategory(QGNoteNode, "Workflow");
    },
};

app.registerExtension(qgNoteExtension);
