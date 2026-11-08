/**
 * QG 取色器 —— 把「字符串型颜色输入」变成图形化色块 + 弹出色板。
 *
 * 搬入说明（2026-11-08，用户确认后搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/qg_color_picker.js
 *   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 EXT.ColorPicker
 *
 *   改了什么：
 *     1) import 路径 ../../scripts/app.js -> /scripts/app.js（本包约定：内置脚本一律绝对路径）；
 *     2) 文案英文化 + zhPair(英文, 中文)（本包规范：前端写死的中文进不了汉化插件）；
 *     3) 面板标题按控件给，不再写死「描边颜色」—— 源包那 4 个控件里只有一个是描边；
 *     4) 控制台前缀 [QG 取色器] -> [QG-tools]；
 *     5) 🔴 **非 hex 的存量值不再被规范化**。源包在 hook 时无条件 `widget.value =
 *        normHex(value)`，碰上 `red` / `255,0,0` / CSS 颜色名会直接吃掉成默认色。
 *        本包 `QG_ImageCropRotatePad.fill_color` 的 tooltip 明确支持那些写法，所以
 *        这里只规范化「本来就是 hex」的值，别的原样留着、照原文显示。
 *     6) 目标节点表按本包实际情况重做（见下），源包列的 QG_BiRefNet 本包没有。
 *
 * 为什么后端一行不改：颜色输入仍是 STRING，工作流里存的就是 "#364254" 这样可读的
 * 字符串 —— 老工作流完全兼容，用户想手输十六进制也能输（色板里有输入框），PG 校验
 * 和 API 提交路径都不受影响。
 *
 * 弹层是自己画的 DOM 面板而不是原生 <input type="color">：原生取色器在不同浏览器里
 * 长相和交互差异很大，而且没法放常用预设色。
 */
import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=2026110820";

const STYLE_ID = "qg-color-picker-style";
const FALLBACK = "#364254";

/**
 * 需要图形化的颜色控件：节点注册 key → { 控件名: 面板标题 }。
 * 要复用到别的节点，在这里加一行即可。
 *
 * 🔴 只挂「值域就是 hex」的控件。`QG_ImageCropRotatePad.fill_color` 看着也像，
 * 但它的后端接受 `#RGB` / `R, G, B` / 单灰度 / CSS 颜色名四种写法，挂上取色器
 * 等于告诉用户只能选色 —— 而且面板选中预设后会把原本的 `red` 改成 hex。故意不挂。
 */
const COLOR_WIDGETS = {
    QG_RemoveBGByMask: {
        stroke_color: { en: "Stroke colour", zh: "描边颜色" },
    },
    QG_ImageScale: {
        fill_color: { en: "Fill colour", zh: "填充颜色" },
    },
    QG_AddWatermark: {
        text_color: { en: "Text colour", zh: "文字颜色" },
    },
};

/** 预设色：按「中性色 / 暖色 / 冷色」三行排，每行 8 个，跟面板 8 列网格对齐。 */
const PRESETS = [
    "#000000", "#1F2328", "#364254", "#5B6675", "#8A94A6", "#C3CBD6", "#E8EDF3", "#FFFFFF",
    "#E5484D", "#F76808", "#FFB224", "#FFD60A", "#D9A066", "#8B5E3C", "#C2410C", "#7C2D12",
    "#30A46C", "#12A594", "#0090FF", "#3E63DD", "#6E56CF", "#8E4EC6", "#D6409F", "#0F766E",
];

const FONT = 'Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif';

/* ------------------------------------------------------------------ *
 * 颜色工具
 * ------------------------------------------------------------------ */

/** 是不是一个能认出来的 hex（#rgb / #rrggbb / #rrggbbaa，有无 # 都行）。 */
function isHex(value) {
    return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(value ?? "").trim());
}

/** 统一成小写 #rrggbb；#rgb / #rrggbbaa / 无 # 前缀都能吃。非法输入回退默认色。 */
function normHex(value, fallback = FALLBACK) {
    const t = String(value ?? "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(t)) {
        return "#" + t.split("").map((c) => c + c).join("").toLowerCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(t)) return "#" + t.toLowerCase();
    if (/^[0-9a-fA-F]{8}$/.test(t)) return "#" + t.slice(0, 6).toLowerCase();
    return fallback;
}

/** 按背景亮度选对比色，保证色块上的勾选标记在任何底色上都看得见。 */
function isLight(hex) {
    const v = normHex(hex);
    const r = parseInt(v.slice(1, 3), 16);
    const g = parseInt(v.slice(3, 5), 16);
    const b = parseInt(v.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

/* ------------------------------------------------------------------ *
 * 主题色（ComfyUI 用 CSS 变量，不同主题下取值不同）
 * ------------------------------------------------------------------ */

let themeCache = { at: 0, value: null };

function getTheme() {
    const now = performance.now();
    if (themeCache.value && now - themeCache.at < 800) return themeCache.value;
    const cs = getComputedStyle(document.body);
    const pick = (name, fb) => (cs.getPropertyValue(name) || "").trim() || fb;
    themeCache = {
        at: now,
        value: {
            inputBg: pick("--comfy-input-bg", "#2a2a33"),
            border: pick("--border-color", "#4a4a55"),
            text: pick("--input-text", "") || pick("--fg-color", "#dddddd"),
            menuBg: pick("--comfy-menu-bg", "#1e1e24"),
            divider: pick("--border-color", "#3a3a44"),
        },
    };
    return themeCache.value;
}

/* ------------------------------------------------------------------ *
 * 节点上的色块控件
 * ------------------------------------------------------------------ */

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    // 老浏览器兜底
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

/** 接管 widget 的绘制：胶囊底板 + 左侧色块 + HEX + 右侧取色提示。 */
function drawColorWidget(ctx, node, widget, width, y, H) {
    const h = H || 20;
    const theme = getTheme();
    const hex = normHex(widget.value);
    const x = 15;

    /* 不同前端版本传进来的 width 含义不一样：有的给整节点宽（含左右 15px 边距），
     * 有的已经减好了。用「是否接近节点总宽」来判断，避免底板戳出节点右边框。 */
    const nodeW = node.size?.[0] || 320;
    let innerW = Number.isFinite(width) && width > 0 ? width : nodeW - 30;
    if (innerW > nodeW - 24) innerW = nodeW - 30;
    innerW = Math.max(40, innerW);

    const by = y + 1;
    const bh = h - 2;

    ctx.save();

    // 胶囊底板：和其它输入控件同一套观感
    roundRect(ctx, x, by, innerW, bh, bh / 2);
    ctx.fillStyle = theme.inputBg;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 色块：四周留出明显内边距，不要填满整行（那样看不出是可点的控件）
    const chipInset = 3;
    const chipH = bh - chipInset * 2;
    const chipW = Math.max(16, Math.min(chipH * 2.1, innerW * 0.3));
    roundRect(ctx, x + chipInset, by + chipInset, chipW, chipH, Math.min(4, chipH / 3));
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.strokeStyle = isLight(hex) ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.28)";
    ctx.stroke();

    // 右侧取色提示：一个调色盘轮廓，暗示这行可以点开色板
    const iconR = Math.max(4, Math.min(6, bh * 0.28));
    const iconX = x + innerW - 12;
    const iconY = by + bh / 2;
    ctx.beginPath();
    ctx.arc(iconX, iconY, iconR, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(theme.text, 0.55);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(iconX, iconY, iconR * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();

    // 文本：合法 hex 显示大写 HEX；别的写法（CSS 名 / RGB 元组）原样显示，
    // 不假装它是个颜色 —— 这类值是后端认的，本扩展不该悄悄改掉。
    const text = isHex(widget.value) ? hex.toUpperCase() : String(widget.value ?? "");
    ctx.fillStyle = theme.text;
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const tx = x + chipInset + chipW + 9;
    const maxTx = iconX - iconR - 6;
    if (maxTx - tx > 24 && text) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(tx, by, maxTx - tx, bh);
        ctx.clip(); // 节点被拖得很窄时文字自动截断，不压到图标
        ctx.fillText(text, tx, iconY + 0.5);
        ctx.restore();
    }

    ctx.restore();
}

/** 给 '#rrggbb' 加透明度，返回 rgba()。 */
function withAlpha(hex, alpha) {
    const v = normHex(hex);
    const r = parseInt(v.slice(1, 3), 16);
    const g = parseInt(v.slice(3, 5), 16);
    const b = parseInt(v.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 值变化后统一走这条路径：callback → 变更通知 → 重绘。 */
function applyColor(node, widget, raw) {
    const next = normHex(raw, normHex(widget.value));
    const prev = widget.value;
    widget.value = next;

    if (prev !== next) {
        try {
            widget.callback?.(next, app.canvas, node, [0, 0], {});
        } catch (e) {
            console.warn("[QG-tools] colour widget callback failed", e);
        }
        node.onWidgetChanged?.(widget.name, next, prev, widget);
        node.graph?.incrementVersion?.();
    }
    node.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

/* ------------------------------------------------------------------ *
 * 弹出色板
 * ------------------------------------------------------------------ */

let panel = null;
let panelOwner = null; // { node, widget }
let outsideHandler = null;
let keyHandler = null;

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.qgcp-panel {
    position: fixed;
    z-index: 2147483000;
    width: 268px;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border-color, #3a3a44);
    background: var(--comfy-menu-bg, #1e1e24);
    color: var(--fg-color, #dddddd);
    font: 12px ${FONT};
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    pointer-events: auto;
    user-select: none;
}
.qgcp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}
.qgcp-title { font-size: 12px; opacity: 0.75; letter-spacing: 0.05em; }
.qgcp-close {
    width: 20px; height: 20px; line-height: 18px;
    border-radius: 5px; border: none; cursor: pointer;
    background: transparent; color: inherit; opacity: 0.6; font-size: 14px;
}
.qgcp-close:hover { opacity: 1; background: var(--comfy-input-bg, #2a2a33); }
.qgcp-row {
    display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.qgcp-chip {
    width: 42px; height: 30px; border-radius: 6px; flex: none;
    border: 1px solid rgba(128, 128, 128, 0.45);
}
.qgcp-hex {
    flex: 1; min-width: 0; height: 30px; padding: 0 8px;
    border-radius: 6px; box-sizing: border-box;
    border: 1px solid var(--border-color, #3a3a44);
    background: var(--comfy-input-bg, #2a2a33);
    color: var(--input-text, #dddddd);
    font: 12px ui-monospace, Menlo, Consolas, monospace;
    outline: none;
}
.qgcp-hex:focus { border-color: #5b9dff; }
.qgcp-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 6px;
    margin-bottom: 10px;
}
.qgcp-swatch {
    position: relative;
    aspect-ratio: 1 / 1;
    border-radius: 5px;
    cursor: pointer;
    border: 1px solid rgba(128, 128, 128, 0.35);
    transition: transform 0.08s ease;
}
.qgcp-swatch:hover { transform: scale(1.12); border-color: #5b9dff; }
.qgcp-swatch[data-active="1"]::after {
    content: "";
    position: absolute; inset: 0;
    border-radius: 4px;
    box-shadow: 0 0 0 2px #5b9dff inset;
}
.qgcp-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.qgcp-custom {
    display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer; opacity: 0.85; padding: 4px 6px; border-radius: 6px;
}
.qgcp-custom:hover { opacity: 1; background: var(--comfy-input-bg, #2a2a33); }
.qgcp-custom input[type="color"] {
    width: 22px; height: 22px; padding: 0; border: none;
    border-radius: 5px; background: transparent; cursor: pointer;
}
.qgcp-btn {
    height: 26px; padding: 0 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--border-color, #3a3a44);
    background: var(--comfy-input-bg, #2a2a33);
    color: var(--fg-color, #dddddd);
    font: 12px ${FONT};
}
.qgcp-btn:hover { border-color: #5b9dff; }
`;
    document.head.appendChild(style);
}

function closePanel() {
    if (outsideHandler) {
        window.removeEventListener("pointerdown", outsideHandler, true);
        outsideHandler = null;
    }
    if (keyHandler) {
        window.removeEventListener("keydown", keyHandler, true);
        keyHandler = null;
    }
    panel?.remove();
    panel = null;
    panelOwner = null;
}

/** 面板锚点：优先用 widget 在画布上的最近绘制位置，取不到就退回屏幕中间。 */
function anchorOf(node, widget) {
    const canvas = app.canvas;
    const cv = canvas?.canvas;
    const ds = canvas?.ds;
    if (cv && ds) {
        const rect = cv.getBoundingClientRect();
        const localY = Number.isFinite(widget.last_y) ? widget.last_y : 40;
        const gx = (node.pos?.[0] ?? 0) + (node.size?.[0] ?? 200) + 8;
        const gy = (node.pos?.[1] ?? 0) + localY;
        return {
            x: rect.left + (gx + ds.offset[0]) * ds.scale,
            y: rect.top + (gy + ds.offset[1]) * ds.scale,
        };
    }
    return { x: window.innerWidth / 2 - 134, y: window.innerHeight / 2 - 120 };
}

function openPicker(node, widget, spec) {
    ensureStyle();

    // 同一个控件再点一次 = 收起（当成开关用）
    if (panel && panelOwner?.node === node && panelOwner?.widget === widget) {
        closePanel();
        return;
    }
    closePanel();

    const el = document.createElement("div");
    el.className = "qgcp-panel";
    // reka-ui / Vue 弹层会靠这个属性判断"点外面该不该关"，标上后点击不会被它们吞掉
    el.dataset.dismissableLayer = "";

    el.innerHTML = `
        <div class="qgcp-head">
            <span class="qgcp-title"></span>
            <button class="qgcp-close">×</button>
        </div>
        <div class="qgcp-row">
            <div class="qgcp-chip"></div>
            <input class="qgcp-hex" maxlength="7" spellcheck="false" />
        </div>
        <div class="qgcp-grid"></div>
        <div class="qgcp-foot">
            <label class="qgcp-custom">
                <input type="color" />
                <span class="qgcp-custom-label"></span>
            </label>
            <button class="qgcp-btn"></button>
        </div>
    `;

    const chip = el.querySelector(".qgcp-chip");
    const hexInput = el.querySelector(".qgcp-hex");
    const grid = el.querySelector(".qgcp-grid");
    const colorInput = el.querySelector('input[type="color"]');
    const title = el.querySelector(".qgcp-title");
    const closeBtn = el.querySelector(".qgcp-close");
    const customLabel = el.querySelector(".qgcp-custom");
    const doneBtn = el.querySelector(".qgcp-btn");

    title.textContent = zhPair(spec.en, spec.zh);
    closeBtn.title = zhPair("Close", "关闭");
    customLabel.title = zhPair("Open the system colour wheel", "打开系统调色器");
    el.querySelector(".qgcp-custom-label").textContent = zhPair("Custom", "自定义");
    doneBtn.textContent = zhPair("Done", "完成");

    const syncUi = () => {
        const hex = normHex(widget.value);
        chip.style.background = hex;
        colorInput.value = hex;
        if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
        for (const s of grid.children) {
            s.dataset.active = s.dataset.hex === hex ? "1" : "0";
        }
    };

    for (const hex of PRESETS) {
        const sw = document.createElement("div");
        sw.className = "qgcp-swatch";
        sw.dataset.hex = hex;
        sw.style.background = hex;
        sw.title = hex.toUpperCase();
        sw.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyColor(node, widget, hex);
            syncUi();
            closePanel(); // 选预设色就直接收工，省一次点击
        });
        grid.appendChild(sw);
    }

    // 手动输 HEX：边输边预览，合法才落到节点上（避免半截 "#3" 把颜色打乱）
    hexInput.addEventListener("input", () => {
        const t = hexInput.value.trim().replace(/^#/, "");
        if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(t)) {
            const hex = normHex(t);
            chip.style.background = hex;
            colorInput.value = hex;
            applyColor(node, widget, hex);
            for (const s of grid.children) s.dataset.active = s.dataset.hex === hex ? "1" : "0";
        }
    });
    hexInput.addEventListener("keydown", (e) => {
        e.stopPropagation(); // 别让画布抢走快捷键
        if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            closePanel();
        }
    });
    hexInput.addEventListener("blur", syncUi);

    // 系统调色器：适合从别处取到的精确颜色
    colorInput.addEventListener("input", () => {
        applyColor(node, widget, colorInput.value);
        syncUi();
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closePanel();
    });
    doneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closePanel();
    });

    // 面板内所有指针事件都不往上冒：否则画布会把点击当成"点到空白处"清空选择
    ["pointerdown", "mousedown", "click", "dblclick"].forEach((type) => {
        el.addEventListener(type, (e) => e.stopPropagation());
    });

    document.body.appendChild(el);

    const at = anchorOf(node, widget);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = Math.round(Math.max(8, Math.min(at.x, window.innerWidth - w - 8))) + "px";
    el.style.top = Math.round(Math.max(8, Math.min(at.y, window.innerHeight - h - 8))) + "px";

    panel = el;
    panelOwner = { node, widget };
    syncUi();

    // 点面板外面关闭。用捕获阶段，保证即使有别的层拦了冒泡也能收到
    outsideHandler = (e) => {
        if (panel && !panel.contains(e.target)) closePanel();
    };
    window.addEventListener("pointerdown", outsideHandler, true);

    keyHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closePanel();
        }
    };
    window.addEventListener("keydown", keyHandler, true);
}

/* ------------------------------------------------------------------ *
 * 挂钩子
 * ------------------------------------------------------------------ */

function hookNode(node) {
    const specs = COLOR_WIDGETS[node?.type] || COLOR_WIDGETS[node?.comfyClass];
    if (!specs || !Array.isArray(node.widgets)) return;
    // 控件还没建出来时（个别版本 nodeCreated 早于 widget 创建）下一轮再补
    if (node.widgets.length === 0) {
        if (!node.__qgColorRetry) {
            node.__qgColorRetry = true;
            setTimeout(() => {
                node.__qgColorRetry = false;
                hookNode(node);
            }, 0);
        }
        return;
    }

    for (const [name, spec] of Object.entries(specs)) {
        const widget = node.widgets.find((w) => w?.name === name);
        if (!widget || widget.__qgColor) continue;
        widget.__qgColor = true;

        // 老工作流里可能存着 "#abc" / "364254" 这种写法，统一成标准形态。
        // 🔴 但只动「本来就是 hex」的：别的写法（CSS 名 / RGB 元组）是后端认的，
        // 这里改成默认色等于把用户的配置吃掉。
        if (isHex(widget.value)) widget.value = normHex(widget.value);

        widget.draw = function (ctx, n, width, y, H) {
            drawColorWidget(ctx, n, this, width, y, H);
        };

        // 老路径（普通 widget）走 mouse；新路径（具体 widget）走 onClick，两个都挂上
        widget.mouse = function (event, _pos, n) {
            const type = event?.type;
            if (type === "pointerdown" || type === "mousedown") {
                openPicker(n || node, this, spec);
                return true;
            }
            return false;
        };
        widget.onClick = function () {
            openPicker(node, widget, spec);
        };
    }
}

app.registerExtension({
    name: "QG.ColorPicker",

    /**
     * 三路兜底，因为"什么时候挂上"在不同加载顺序下不一样：
     *   1. beforeRegisterNodeDef —— 正常启动时扩展先加载，patch 节点原型；
     *   2. nodeCreated —— 节点创建后的统一回调，覆盖粘贴/复制/子图里的节点；
     *   3. setup —— 扩展比节点定义晚加载时，把画布上已有的节点补上。
     * 三者都用 __qgColor 去重，重复调用无副作用。
     */
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!COLOR_WIDGETS[nodeData?.name]) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            hookNode(this);
            return r;
        };

        // 从已保存工作流加载时不会走 onNodeCreated，补一道
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            hookNode(this);
            return r;
        };
    },

    nodeCreated(node) {
        hookNode(node);
    },

    setup() {
        for (const node of app.graph?._nodes || []) hookNode(node);
    },
});
