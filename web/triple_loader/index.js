/**
 * QG Triple Loader — 模型加载器（UNET + CLIP + VAE 三合一）—— 显示美化扩展
 *
 * Ported from ComfyUI-TripleLoader (web/js/triple_loader.js), a plugin by this
 * pack's author. Renamed to the QG_ prefix and moved under web/<feature>/ per
 * this pack's layout. The display name stays Chinese ("QG 模型加载器").
 *
 * 目标：unet_name / clip_name / vae_name 三个下拉
 *   - 展开的列表：完整路径 + 后缀（默认行为，本扩展不干预）
 *   - 节点上收起显示：只显示短文件名（去子目录、去扩展名）
 *
 * 值（value）始终是完整路径，后端校验、序列化零影响。
 *
 * 渲染路径分析（ComfyUI_frontend 1.55.x，实测）：
 *   默认渲染模式是 litegraph canvas（设置 Comfy.VueNodes.Enabled 可切
 *   Vue DOM「Nodes 2.0」）。两种模式下 combo 控件都是 ComboWidget 实例：
 *     - canvas 绘制：ComboWidget.drawWidget -> drawWidgetShape 读取
 *       实例的 _displayValue getter 作为显示文本；
 *     - 下拉列表：DOM 弹窗 WidgetSelect 用
 *       getDisplayLabel(value, options.getOptionLabel)，未设置时原样显示。
 *   因此正确做法是【只覆盖实例的 _displayValue】：
 *     - canvas 收起显示变短名；
 *     - options.getOptionLabel 不设置，下拉列表仍是完整路径
 *       （此前误设 getOptionLabel 会同时污染列表，是 bug 根因）；
 *     - widget.value 完全不动，序列化/后端校验零影响。
 *   另保留两套兜底：
 *     - widget.draw 包装：兼容还没有 ComboWidget 类的旧前端；
 *     - MutationObserver：Vue DOM 模式下只改写节点 DOM 里文本等于
 *       当前值的叶子元素（下拉面板 teleport 到 body，不受影响）。
 */

import { app } from "/scripts/app.js";
import { sizeFor } from "../shared/node_width.mjs?v=2026102706";

const NODE_CLASS = "QG_TripleLoader";
const PRETTY_WIDGETS = new Set(["unet_name", "clip_name", "vae_name"]);

// 新建节点的默认宽度（CSS px）。
// 取 400 = 「LoRA 加载器」的宽度，两个加载器并排放着一样宽（2026-10-21 用户指定）。
// 仅在节点创建时设置一次；工作流加载时 configure() 会用保存的 size 覆盖，
// 用户手动调整过的宽度不会丢。高度取当前值，不改变默认高度行为。
const DEFAULT_WIDTH = sizeFor("QG_TripleLoader").w;

// nodeId -> { element, widgets: [widget...], observer }
const patchedNodes = new Map();

function prettyName(v) {
    if (typeof v !== "string" || v === "") return v;
    const norm = v.replace(/\\/g, "/");
    const base = norm.split("/").pop();
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

/** 把节点 DOM 内文本恰好等于 value 的叶子元素文字改写为短名（跳过 listbox 内） */
function rewriteCollapsedDisplay(rootEl, value) {
    if (!rootEl || typeof value !== "string" || !value) return;
    const pretty = prettyName(value);
    if (!pretty || pretty === value) return;
    const walk = (el) => {
        if (el.children.length === 0) {
            if (el.closest('[role="listbox"], [role="menu"], [role="dialog"]')) return;
            const txt = el.textContent ?? "";
            const trimmed = txt.trim();
            if (trimmed === value) {
                el.textContent = txt.replace(trimmed, pretty);
            }
            return;
        }
        for (const child of Array.from(el.children)) walk(child);
    };
    walk(rootEl);
}

function rewriteAll(nodeId) {
    const entry = patchedNodes.get(nodeId);
    if (!entry || !entry.element || !entry.element.isConnected) return;
    for (const w of entry.widgets) {
        rewriteCollapsedDisplay(entry.element, w.value);
    }
}

function attachNodeObserver(nodeId, widgets) {
    const existing = patchedNodes.get(nodeId);
    if (existing) {
        existing.widgets = widgets;
        rewriteAll(nodeId);
        return;
    }
    const tryAttach = (tries) => {
        const el = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (el && el.isConnected) {
            const entry = { element: el, widgets, observer: null };
            const observer = new MutationObserver(() => rewriteAll(nodeId));
            observer.observe(el, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            entry.observer = observer;
            patchedNodes.set(nodeId, entry);
            rewriteAll(nodeId);
            return;
        }
        // Vue DOM 异步挂载，轮询等待
        if (tries < 40) setTimeout(() => tryAttach(tries + 1), 50);
    };
    tryAttach(0);
}

function patchWidget(widget, nodeId) {
    if (!widget || widget._qgTriplePrettyPatched) return;
    if (!PRETTY_WIDGETS.has(widget.name)) return;
    widget._qgTriplePrettyPatched = true;

    const entry = patchedNodes.get(nodeId);
    if (entry && !entry.widgets.some((w) => w.name === widget.name)) {
        entry.widgets.push(widget);
    }

    // 主路径：覆盖实例 _displayValue（canvas 渲染的显示文本来源）。
    // 语义与原 ComboWidget._displayValue 对齐：disabled 时为空串；
    // 字符串值替换为短名；其余（数字等）按原逻辑转字符串。
    try {
        Object.defineProperty(widget, "_displayValue", {
            configurable: true,
            get: function () {
                if (this.computedDisabled) return "";
                const v = this.value;
                if (typeof v === "string" && v !== "") {
                    const p = prettyName(v);
                    return p === v ? v : p;
                }
                return typeof v === "number" ? String(v) : v;
            },
        });
    } catch (e) {
        console.warn("[QG-tools] override _displayValue failed:", e);
    }

    // 老前端 canvas 兜底：包装 widget.draw，仅绘制时替换显示文本，value 不动
    const origDraw = widget.draw;
    if (typeof origDraw === "function") {
        widget.draw = function (ctx, node, widgetWidth, y, widgetHeight) {
            const real = this.value;
            let swapped = false;
            if (typeof real === "string" && real !== prettyName(real)) {
                this.value = prettyName(real);
                swapped = true;
            }
            try {
                return origDraw.apply(this, arguments);
            } finally {
                if (swapped) this.value = real;
            }
        };
    }
}

app.registerExtension({
    name: "QG.TripleLoader",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            // 新建节点默认宽度（高度不变）；保存过 size 的工作流会在 configure() 时覆盖
            try {
                const h = Array.isArray(this.size) ? this.size[1] : 60;
                this.size = [DEFAULT_WIDTH, h];
                if (typeof this.setDirtyCanvas === "function") {
                    this.setDirtyCanvas(true, true);
                }
            } catch (e) {
                console.warn("[QG-tools] set default size failed:", e);
            }

            patchNodeWidgets(this);
            return r;
        };
    },
});

function patchNodeWidgets(node) {
    const nodeId = node.id;
    const targets = [];
    for (const w of node.widgets || []) {
        if (PRETTY_WIDGETS.has(w.name)) {
            patchWidget(w, nodeId);
            targets.push(w);
        }
    }
    if (targets.length) attachNodeObserver(nodeId, targets);
}

// 兜底轮询：
// 1) 工作流加载等场景下后出现的控件补打补丁（patchWidget 内部去重）；
// 2) 节点 DOM 被重建（刷新/重挂载）后重新挂 observer（仅 Vue DOM 模式需要）。
setInterval(() => {
    try {
        for (const n of app.graph?._nodes || []) {
            if (n?.type !== NODE_CLASS) continue;
            patchNodeWidgets(n);
        }
    } catch (e) { /* graph 未就绪时忽略 */ }
    for (const [nodeId, entry] of patchedNodes) {
        if (!entry.element || !entry.element.isConnected) {
            patchedNodes.delete(nodeId);
            attachNodeObserver(nodeId, entry.widgets);
        } else {
            rewriteAll(nodeId);
        }
    }
}, 2000);

console.log("[QG-tools] triple loader front end ready");
