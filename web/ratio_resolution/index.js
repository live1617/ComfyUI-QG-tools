/**
 * QG 比例与分辨率 —— 控件动态显隐 + 输出口实时预览宽高。
 *
 * 搬入说明（2026-11-08，用户确认后 1:1 搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/qg_ratio_resolution.js
 *   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_RatioResolution
 *
 *   只做三类必要改动，交互逻辑一行未改：
 *     1) import 路径 ../../scripts/app.js -> /scripts/app.js（本包约定：内置脚本绝对路径）；
 *     2) 控件名与下拉值英文化 —— 源包的输入名（比例 / 模式 / 固定边像素 …）和下拉值
 *        （原始比例 / 固定长边 / 长边（范围）…）全是中文，英文界面上会直接露中文。
 *        中文显示交给 combo_zh.mjs 的 getOptionLabel（源在 _qg_combo_legacy.LEGACY），
 *        老存档里的中文值由同一份表在 onConfigure 阶段迁成英文 key；
 *     3) 输出槽名 比例 / 宽度 / 高度 -> ratio / width / height（与后端 RETURN_NAMES 一致）。
 *
 * 交互（与参考节点 Goohaitools「比例与分辨率」一致）：
 *   1. 控件按「ratio / mode」动态显隐：custom 只留两个自定宽高；total-pixels 只留
 *      百万像素；long-side-range 只留长边最小 / 最大；其余显示 fixed_edge；
 *   2. 图像未连线或比例是 custom 时，「mode」下拉里去掉 long-side-range，
 *      正选中的回落到 long-side；
 *   3. width / height 输出口名旁实时预览青色（#2aa6c2）预计值；original 无法
 *      穿透读到上游图像尺寸时先显示空、等执行后回显真实结果；
 *   4. 后端执行事件（onExecuted / api executed）把真实宽高写回显示。
 *
 * 新旧前端是两套输出标签渲染器：旧版 canvas 走 drawNode 叠加绘制，
 * Nodes 2.0 走 Vue DOM（CSS 替换标签内容），两套都装，按环境各自生效。
 *
 * 后端节点：nodes/qg_ratio_resolution.py。改本文件只需 F5 刷新页面。
 */
import { app } from "/scripts/app.js";

const TYPE = "QG_RatioResolution";
const CYAN = "#2aa6c2";

const RATIO_VALUES = {
    "1:1": [1, 1], "2:3": [2, 3], "3:2": [3, 2], "3:4": [3, 4],
    "4:3": [4, 3], "5:7": [5, 7], "9:16": [9, 16], "16:9": [16, 9],
    "21:9": [21, 9], "1:2": [1, 2], "2:1": [2, 1],
};

const MODE_VALUES = [
    "long-side", "short-side", "width", "height", "total-pixels", "long-side-range",
];

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback) {
    const w = getWidget(node, name);
    return w && w.value !== undefined ? w.value : fallback;
}

/** 尽量从上游预览图读取已连图像的尺寸（穿不透时 size 为 null）。 */
function connectedImageInfo(node) {
    const input = node.inputs?.find(
        (slot) => slot.name === "image" || slot.label === "image");
    if (!input || input.link == null || !node.graph?.links) {
        return { connected: false, size: null };
    }
    const link = node.graph.links[input.link];
    const origin = link && node.graph.getNodeById?.(link.origin_id);
    const image = origin?.imgs?.[origin.imageIndex ?? 0] || origin?.imgs?.[0];
    const width = Number(image?.naturalWidth || image?.width || 0);
    const height = Number(image?.naturalHeight || image?.height || 0);
    return { connected: true, size: width > 0 && height > 0 ? [width, height] : null };
}

function roundToMultiple(value, multiple) {
    value = Math.max(1, Number(value) || 1);
    multiple = Math.trunc(Number(multiple) || 0);
    if (multiple <= 0) return Math.max(1, Math.round(value));
    return Math.max(multiple, Math.round(value / multiple) * multiple);
}

/** 与后端 calculate 同口径的预览计算；unknown 表示当前算不出可信值。 */
function estimateSize(node) {
    const ratioName = String(widgetValue(node, "ratio", "original"));
    const mode = String(widgetValue(node, "mode", "long-side"));
    const fixed = Number(widgetValue(node, "fixed_edge", 1024));
    const mp = Math.max(0.2, Number(widgetValue(node, "megapixels", 2.0)) || 2.0);
    const minLong = Math.max(8, Math.trunc(Number(widgetValue(node, "long_edge_min", 512)) || 512));
    const maxLong = Math.max(8, Math.trunc(Number(widgetValue(node, "long_edge_max", 2048)) || 2048));
    const customW = Number(widgetValue(node, "custom_width", 1024));
    const customH = Number(widgetValue(node, "custom_height", 1024));
    const multiple = Number(widgetValue(node, "multiple", 16));

    const imageInfo = (ratioName === "original" || mode === "long-side-range")
        ? connectedImageInfo(node)
        : null;
    if (mode === "long-side-range" && !imageInfo?.connected) {
        return { width: null, height: null, ratio: null, unknown: true };
    }
    if (ratioName === "original" && imageInfo.connected && !imageInfo.size) {
        // 已连图像但穿不透中间节点：不能伪显示 1:1，等执行回显。
        if (mode !== "long-side-range") {
            if (node._qgRatioExecutedSize) {
                return { ...node._qgRatioExecutedSize };
            }
            return { width: null, height: null, ratio: null, unknown: true };
        }
    }

    let w, h;
    if (ratioName === "custom") {
        w = customW;
        h = customH;
    } else {
        const pair = ratioName === "original"
            ? (imageInfo.size || [1, 1])
            : (RATIO_VALUES[ratioName] || [1, 1]);
        const rw = pair[0];
        const rh = pair[1];
        if (mode === "long-side-range") {
            const originalLong = imageInfo.size
                ? Math.max(imageInfo.size[0], imageInfo.size[1])
                : 1536;
            const lower = Math.min(minLong, maxLong);
            const upper = Math.max(minLong, maxLong);
            const targetLong = Math.min(Math.max(originalLong, lower), upper);
            const scale = targetLong / Math.max(rw, rh);
            w = rw * scale; h = rh * scale;
        } else if (mode === "long-side") {
            const scale = fixed / Math.max(rw, rh);
            w = rw * scale; h = rh * scale;
        } else if (mode === "short-side") {
            const scale = fixed / Math.min(rw, rh);
            w = rw * scale; h = rh * scale;
        } else if (mode === "width") {
            w = fixed; h = fixed * rh / rw;
        } else if (mode === "height") {
            h = fixed; w = fixed * rw / rh;
        } else if (mode === "total-pixels") {
            const area = mp * 1024 * 1024;
            const scale = Math.sqrt(area / (rw * rh));
            w = rw * scale;
            h = rh * scale;
        } else {
            const scale = fixed / Math.max(rw, rh);
            w = rw * scale; h = rh * scale;
        }
    }

    w = roundToMultiple(w, multiple);
    h = roundToMultiple(h, multiple);
    return { width: w, height: h, ratio: h ? w / h : 0 };
}

function displaySize(node) {
    const estimated = estimateSize(node);
    // 只有前端确实无法穿透读取图像尺寸时，才沿用最近一次后端执行结果。
    if (estimated?.unknown && node._qgRatioExecutedSize) {
        return { ...node._qgRatioExecutedSize };
    }
    return estimated;
}

/* ------------------------------------------------------------------ */
/* 控件显隐与视图刷新                                                   */
/* ------------------------------------------------------------------ */

function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (!widget._qgRatioOriginals) {
        widget._qgRatioOriginals = {
            computeSize: widget.computeSize,
            draw: widget.draw,
            mouse: widget.mouse,
        };
    }
    widget.hidden = !visible;
    if (visible) {
        widget.computeSize = widget._qgRatioOriginals.computeSize;
        widget.draw = widget._qgRatioOriginals.draw;
        widget.mouse = widget._qgRatioOriginals.mouse;
    } else {
        widget.computeSize = () => [0, 0];
        widget.draw = () => {};
        widget.mouse = () => false;
    }
}

function updateOutputNames(node) {
    const outputs = node.outputs || [];
    const names = ["ratio", "width", "height"];
    for (let i = 0; i < outputs.length && i < 3; i++) {
        if (!outputs[i]) continue;
        outputs[i].name = names[i];
        outputs[i].label = names[i];
        if (i > 0) {
            outputs[i].color = outputs[i].color_on = outputs[i].color_off = CYAN;
        }
    }
}

/** 按当前控件状态把节点高度压回去（隐藏项不留空白）。 */
function shrinkNodeHeight(node) {
    // 🔴 1.58.5 的 node.size 是 Float64Array，Array.isArray 判不到 → 动态显隐后不再收缩。
    if (typeof node.computeSize === "function" && (Array.isArray(node.size) || ArrayBuffer.isView(node.size))) {
        const nextSize = node.computeSize();
        if (Array.isArray(nextSize) && nextSize.length >= 2) {
            node.size[1] = nextSize[1];
        }
    }
}

/** DOM 挂载完成后前端可能按 DOM 高度回写一次节点尺寸，延迟补收缩两次
 *  跨过这个时刻（实测 50ms 起稳定；重复调用幂等，只保留最后一组定时器）。 */
function scheduleShrink(node) {
    if (!node._qgRatioShrinkTimers) node._qgRatioShrinkTimers = [];
    for (const t of node._qgRatioShrinkTimers) clearTimeout(t);
    node._qgRatioShrinkTimers = [50, 200].map((delay) =>
        setTimeout(() => {
            shrinkNodeHeight(node);
            node.setDirtyCanvas?.(true, true);
        }, delay));
}

function updateNodeView(node) {
    const ratioName = String(widgetValue(node, "ratio", "original"));
    const mode = String(widgetValue(node, "mode", "long-side"));
    const isCustom = ratioName === "custom";
    const isTotalPixels = mode === "total-pixels";
    const imageInfo = connectedImageInfo(node);
    const canUseRange = imageInfo.connected && !isCustom;
    const modeWidget = getWidget(node, "mode");

    // 「长边（范围）」只在图像已连线且比例不是自定义宽高时出现在下拉里；
    // 保留原始选项数组，避免切完工作流选项被永久改写。
    if (modeWidget) {
        if (!modeWidget._qgRatioAllModeValues) {
            modeWidget._qgRatioAllModeValues = [...MODE_VALUES];
        }
        const values = canUseRange
            ? modeWidget._qgRatioAllModeValues
            : modeWidget._qgRatioAllModeValues.filter((v) => v !== "long-side-range");
        modeWidget.options = modeWidget.options || {};
        modeWidget.options.values = [...values];
        if (!canUseRange && modeWidget.value === "long-side-range") {
            modeWidget.value = "long-side";
        }
    }

    const isLongRange = canUseRange && mode === "long-side-range";
    setWidgetVisible(getWidget(node, "mode"), !isCustom);
    setWidgetVisible(getWidget(node, "fixed_edge"),
                     !isCustom && !isTotalPixels && !isLongRange);
    setWidgetVisible(getWidget(node, "megapixels"),
                     !isCustom && isTotalPixels && !isLongRange);
    setWidgetVisible(getWidget(node, "long_edge_min"), isLongRange);
    setWidgetVisible(getWidget(node, "long_edge_max"), isLongRange);
    setWidgetVisible(getWidget(node, "custom_width"), isCustom);
    setWidgetVisible(getWidget(node, "custom_height"), isCustom);

    updateOutputNames(node);
    node._qgRatioSize = displaySize(node);
    scheduleDomRefresh();
    // 隐藏项改变后不总会自动重算节点高度，这里补一次，避免留空白。
    shrinkNodeHeight(node);
    scheduleShrink(node);
    node.setDirtyCanvas?.(true, true);
}

function refreshNode(node) {
    delete node._qgRatioExecutedSize;
    updateNodeView(node);
}

/* ------------------------------------------------------------------ */
/* 输出口实时数值：旧版 canvas 渲染器                                    */
/* ------------------------------------------------------------------ */

function outputLocalY(node, index) {
    const output = node.outputs?.[index];
    const direct = Number(output?.pos?.[1]);
    if (Number.isFinite(direct)) return direct;
    if (typeof node.getConnectionPos === "function") {
        const point = node.getConnectionPos(false, index, [0, 0]);
        const y = Number(point?.[1]) - Number(node.pos?.[1] || 0);
        if (Number.isFinite(y)) return y;
    }
    return null;
}

function installCanvasRenderer() {
    if (globalThis.__qgRatioCanvasHooked) return;
    if (typeof LGraphCanvas === "undefined" || !LGraphCanvas.prototype?.drawNode) {
        // 扩展注册时 LiteGraph 可能还没初始化完，延迟重试。
        if (!globalThis.__qgRatioCanvasRetry) {
            globalThis.__qgRatioCanvasRetry = true;
            let attempts = 0;
            const retry = () => {
                globalThis.__qgRatioCanvasRetry = false;
                if (!globalThis.__qgRatioCanvasHooked && attempts++ < 30) {
                    installCanvasRenderer();
                }
            };
            setTimeout(retry, 100);
        }
        return;
    }
    globalThis.__qgRatioCanvasHooked = true;
    const originalDrawNode = LGraphCanvas.prototype.drawNode;
    LGraphCanvas.prototype.drawNode = function (node, ctx, ...args) {
        if (node?.type !== TYPE) {
            return originalDrawNode.call(this, node, ctx, ...args);
        }
        const size = displaySize(node);
        node._qgRatioSize = size;
        updateOutputNames(node);
        const result = originalDrawNode.call(this, node, ctx, ...args);

        ctx.save();
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "right";
        const fontFamily = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_FONT)
            ? LiteGraph.NODE_FONT
            : "sans-serif";
        for (const [index, value] of [[1, size.width], [2, size.height]]) {
            const y = outputLocalY(node, index);
            if (!Number.isFinite(y)) continue;
            if (!size.unknown && Number.isFinite(value)) {
                const fontSize =
                    (typeof LiteGraph !== "undefined" &&
                     Number.isFinite(Number(LiteGraph.NODE_TEXT_SIZE)))
                        ? Math.max(8, Number(LiteGraph.NODE_TEXT_SIZE) - 2)
                        : 12;
                ctx.font = `${fontSize}px ${fontFamily}`;
                const right = node.size[0] - 10;
                const labelWidth = ctx.measureText(index === 1 ? "width" : "height").width;
                ctx.fillStyle = CYAN;
                ctx.fillText(String(value), right - labelWidth - 12, y + 5);
            }
        }
        ctx.restore();
        return result;
    };
}

/* ------------------------------------------------------------------ */
/* 输出口实时数值：Nodes 2.0 DOM 渲染器                                  */
/* ------------------------------------------------------------------ */

function installDomStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById("qg-ratio-label-styles")) return;
    const style = document.createElement("style");
    style.id = "qg-ratio-label-styles";
    style.textContent = `
      [data-qg-ratio-label="1"] {
        color: transparent !important;
        font-size: 0 !important;
        white-space: nowrap !important;
      }
      [data-qg-ratio-label="1"]::before {
        content: attr(data-qg-ratio-value);
        display: inline-block;
        color: ${CYAN} !important;
        font-family: inherit !important;
        font-size: var(--qg-ratio-value-size, 12px) !important;
        font-weight: inherit !important;
      }
      [data-qg-ratio-label="1"]::after {
        content: attr(data-qg-ratio-name);
        display: inline-block;
        color: #cfd3dc !important;
        font-family: inherit !important;
        font-size: var(--qg-ratio-label-size, 14px) !important;
        font-weight: inherit !important;
        margin-left: 10px;
      }
    `;
    document.head.appendChild(style);
}

function refreshDomLabels() {
    if (typeof document === "undefined" || typeof NodeFilter === "undefined") return;
    installDomStyles();
    const roots = document.querySelectorAll("[data-node-id]");
    for (const root of roots) {
        const id = root.getAttribute("data-node-id");
        const node = app.graph?.getNodeById?.(Number(id))
            || app.graph?.getNodeById?.(id);
        if (node?.type !== TYPE) continue;
        const size = displaySize(node);
        const labels = root.querySelectorAll(
            ".lg-slot--output .text-node-component-slot-text");
        for (const el of labels) {
            const label = el.textContent.trim();
            if (label !== "width" && label !== "height") continue;
            const value = label === "width" ? size?.width : size?.height;
            const nativeSize =
                Number.parseFloat(getComputedStyle(el).fontSize) || 14;
            el.dataset.qgRatioLabel = "1";
            el.dataset.qgRatioValue = size?.unknown ? "" : String(value ?? "");
            el.dataset.qgRatioName = label;
            el.style.setProperty("--qg-ratio-label-size", `${nativeSize}px`);
            el.style.setProperty("--qg-ratio-value-size",
                                 `${Math.max(8, nativeSize - 2)}px`);
            tintDomDot(el);
        }
    }
}

function tintDomDot(labelElement) {
    const row = labelElement.closest?.(".lg-slot--output");
    const dot = row?.querySelector?.('[data-testid="slot-dot"]');
    if (!dot) return;
    dot.style.setProperty("background-color", CYAN, "important");
    dot.querySelectorAll?.("circle, path").forEach((shape) => {
        shape.style.setProperty("fill", CYAN, "important");
    });
}

function scheduleDomRefresh() {
    if (typeof document === "undefined" ||
        globalThis.__qgRatioDomRefreshQueued) return;
    globalThis.__qgRatioDomRefreshQueued = true;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            globalThis.__qgRatioDomRefreshQueued = false;
            refreshDomLabels();
        });
    });
}

/* ------------------------------------------------------------------ */
/* 执行结果回显                                                         */
/* ------------------------------------------------------------------ */

function asNumber(value) {
    if (Array.isArray(value)) value = value[0];
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function applyExecutedSize(node, message) {
    const output = message?.output || message;
    if (!output) return;
    const metadata = Array.isArray(output.ratio_resolution)
        ? output.ratio_resolution[0]
        : output.ratio_resolution;
    const width = asNumber(metadata?.width ?? output.width
                           ?? output[2]);
    const height = asNumber(metadata?.height ?? output.height
                            ?? output[3]);
    if (width === null || height === null || width <= 0 || height <= 0) return;

    const size = {
        width: Math.round(width),
        height: Math.round(height),
        ratio: width / height,
        unknown: false,
        executed: true,
    };
    node._qgRatioExecutedSize = size;
    node._qgRatioSize = size;
    updateOutputNames(node);
    scheduleDomRefresh();
    node.setDirtyCanvas?.(true, true);
}

/* ------------------------------------------------------------------ */
/* 扩展注册                                                             */
/* ------------------------------------------------------------------ */

app.registerExtension({
    name: "QG.RatioResolution",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TYPE) return;

        installCanvasRenderer();
        installDomStyles();
        scheduleDomRefresh();

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            requestAnimationFrame(() => {
                hookWidgetCallbacks(this);
                updateNodeView(this);
            });
            return result;
        };

        const originalConfigured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalConfigured?.apply(this, arguments);
            requestAnimationFrame(() => {
                hookWidgetCallbacks(this);
                updateNodeView(this);
            });
            return result;
        };

        const originalConnections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const result = originalConnections?.apply(this, arguments);
            refreshNode(this);
            return result;
        };

        const originalExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = originalExecuted?.apply(this, arguments);
            applyExecutedSize(this, message);
            return result;
        };

        // 新版前端经 API executed 事件派发结果，兼容 onExecuted 不触发的情况。
        const api = globalThis.api;
        if (api?.addEventListener && !globalThis.__qgRatioExecutedListener) {
            globalThis.__qgRatioExecutedListener = true;
            api.addEventListener("executed", ({ detail }) => {
                const nodeId = String(detail?.node ?? detail?.display_node ?? "");
                const node = app.graph?.getNodeById?.(Number(nodeId))
                    || app.graph?.getNodeById?.(nodeId);
                if (node?.type === TYPE) applyExecutedSize(node, detail);
            });
        }
    },
});

/** 每个控件值变化后都重算显隐与预览（兼容新旧两套回调路径）。 */
function hookWidgetCallbacks(node) {
    if (node._qgRatioHooked) return;
    node._qgRatioHooked = true;
    for (const widget of node.widgets || []) {
        if (widget._qgRatioCallback) continue;
        const original = widget.callback;
        widget.callback = function (value) {
            const result = original?.apply(this, arguments);
            refreshNode(node);
            return result;
        };
        widget._qgRatioCallback = true;
    }
    const originalWidgetChanged = node.onWidgetChanged;
    node.onWidgetChanged = function (name, value, widget) {
        const result = originalWidgetChanged?.apply(this, arguments);
        refreshNode(this);
        return result;
    };
}

/* 高度兜底：前端在控件值变化 / 节点挂载后的内部流程可能把节点高度按
 * 全部控件展开的尺寸写回，留下的空白与参考节点一致要等下一次调参才收敛。
 * 这里低频巡检（500ms，仅本类型节点、仅高度大于计算值时压回），
 * 与用户调参后的收敛效果相同；无空白时零开销。 */
setInterval(() => {
    const graph = app.graph;
    if (!graph?._nodes) return;
    for (const node of graph._nodes) {
        if (node.type !== TYPE) continue;
        if (!node.widgets?.length) continue;
        shrinkIfTaller(node);
    }
}, 500);

function shrinkIfTaller(node) {
    if (typeof node.computeSize !== "function" || !(Array.isArray(node.size) || ArrayBuffer.isView(node.size))) {
        return;
    }
    const computed = node.computeSize();
    if (!Array.isArray(computed) || computed.length < 2) return;
    if (node.size[1] > computed[1] + 2) {
        node.size[1] = computed[1];
        node.setDirtyCanvas?.(true, true);
    }
}
