// -*- coding: utf-8 -*-
// QG Step Preview front end: the picture while it is being made, plus a Stop button.
//
// 后端只负责开开关（nodes/qg_step_preview.py 改写 extra_data["preview_method"]），
// 采样本画由 ComfyUI 逐步骤发给浏览器。这个模块把那些帧接到节点里的一块画布上：
// 采样中显示画面 + 「第几步 / 共几步」，跑完显示最终结果图，中途可以按 STOP 中断。
//
// 为什么自己写而不搬 ComfyUI-AusBoss 的那一套（它也有同样的面板）：那套带一个完整的状态机
// （step_preview_math.mjs，跟踪多标签页、多 run、队列剩余数），本插件只需要
// 「当前这次运行」，三十行状态就够，跟着上游一起坏的面积也小得多。

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { sizeFor } from "../shared/node_width.mjs?v=2026102915";
import { fillNodeHeight } from "../shared/panel_layout.mjs?v=2026102915";
import { keepDomWidgetWidthAuto } from "../shared/index.mjs?v=2026102915";
import { hideCanvasWidget } from "../shared/core_preview.mjs?v=2026102915";
import { zhPair } from "../shared/zh.mjs?v=2026102915";

const NODE_TYPE = "QG_StepPreview";
const PANEL_WIDGET = "qg_step_preview_panel";
const CSS_ID = "qgtools-step-preview-css";
const STAGE_MIN_HEIGHT = 150;
const BAR_HEIGHT = 22;
// 被替换掉的预览帧地址不会马上回收：还在换图过程中把 blob 撤掉，<img> 会闪成破图。
const URL_GRACE_MS = 3000;
// 成品图解码的等待上限。超过就先换上，总比一直停在步骤图强。
const RESULT_WAIT_MS = 4000;
// 「隐藏采样器缩略图」：Vue 渲染下缩略图是外壳里的一张 <img>，加个类用 CSS 藏掉；
// 经典画布是 canvas 画 node.imgs，只能把它们清空。
const HIDE_CLASS = "qgtools-sp-nothumb";
const SAMPLER_RE = /sampler/i;

// 三个原生控件收进齿轮里：节点上不再占行。Vue 靠这个类定位到对应的 widget 行，
// 经典画布靠 hideCanvasWidget 把行压成 0 高。
const COLLAPSED_CLASS = "qgtools-sp-nested";
const NESTED_WIDGETS = ["method", "max_size", "hide_sampler"];
// 下拉的取值必须和 CLI / INPUT_TYPES 一字不差，标签只是给人看的。
const METHOD_OPTIONS = [
    ["auto", "自动", "Auto"],
    ["latent2rgb", "快速", "Fast"],
    ["taesd", "清晰", "Sharp"],
    ["none", "关闭", "Off"],
];

const HIDDEN = new Set();   // 这些节点 id 上的缩略图不该显示
const COLLAPSED = new Set(); // 这些节点 id 的原生控件要收起来

// 分块放大的采样帧是「一小块」，不是整张。拿它顶掉整图，看着就像画面被放大到
// 只剩角落里的一块 —— Ultimate SD Upscale 在自己节点里切块采样，最容易撞上。
const TILE_NODE_RE = /^UltimateSDUpscale/i;

// 一次只跟一个运行。ComfyUI 的队列是串行的，够用。
const RUN = {
    promptId: null,
    status: "idle",     // idle | running | done | stopped | error
    step: 0,
    total: 0,
    url: null,          // 当前显示的那一帧
    whole: null,        // 最近一张「整图」，分块阶段拿它顶着
    tile: false,        // 当前帧来自分块节点
    result: null,       // 跑完后的成品（有就优先显示）
    node: null,         // 当前正在执行的节点 id（老接口判分块用）
};

const FACES = new Set();
let wired = false;
let pendingRevoke = [];
// 每来一张成品图就 +1，旧的解码回来发现自己过期了就不动面板。
let resultToken = 0;

function refresh() {
    for (const face of FACES) {
        try {
            face.update(RUN);
        } catch {
            // 一个节点出错不该连累其他节点
        }
    }
}

function statusLabel(run) {
    switch (run.status) {
        case "running": {
            const steps = run.total > 1 ? `step ${run.step} / ${run.total}` : "";
            if (run.tile) {
                // 分块阶段总数是一块自己的步数，别让人以为整张图只剩这么几步。
                return steps
                    ? zhPair(`upscaling in tiles \u00b7 ${steps}`, `分块放大中 \u00b7 ${steps}`)
                    : zhPair("upscaling in tiles", "分块放大中");
            }
            return steps || zhPair("sampling\u2026", "采样中\u2026");
        }
        case "done":
            return zhPair("done", "完成");
        case "stopped":
            return zhPair("stopped", "已停止");
        case "error":
            return zhPair("error", "出错");
        default:
            return "";
    }
}

/** 「预览方式」是不是「关闭」那一档。老存档可能存着中文值。 */
function previewOff(node) {
    const widget = (node?.widgets || []).find((w) => w.name === "method");
    const value = String(widget?.value ?? "").toLowerCase();
    return value === "none" || value === "关闭";
}

/** 这一帧是不是分块放大的「一小块」。判不出来就当整图，宁可按老样子显示。 */
function drawsTiles(nodeId) {
    if (nodeId === null || nodeId === undefined) return false;
    const node = nodeById(String(nodeId));
    const type = String(node?.comfyClass || node?.type || "");
    return TILE_NODE_RE.test(type);
}

/** 有任意一个采样预览节点要求藏掉采样器上的缩略图就算开。 */
function hideRequested() {
    for (const node of app.graph?._nodes || []) {
        if (node?.type !== NODE_TYPE) continue;
        const widget = (node.widgets || []).find((w) => w.name === "hide_sampler");
        if (widget && (widget.value === true || widget.value === "true")) return true;
    }
    return false;
}

/**
 * 经典画布上按住一个节点的缩略图。
 *
 * 不能「事件来了就把 node.imgs 清空」—— 前端是异步解码 blob 之后再写 imgs 的，
 * 我们清完它又填回去，实测采样中始终是 1。改成在实例上盖一个访问器：
 * 值照样存下来（前端逻辑不受影响），但读出来永远是空数组，于是画布一份都不画。
 * 关掉开关只要把 __qgSpShow 置回 true，真值原样回来，不用拆访问器。
 */
function guardImgs(node, hide) {
    if (!node) return;
    const want = !hide;
    if (!node.__qgSpGuard) {
        let real = Array.isArray(node.imgs) ? node.imgs : [];
        try {
            Object.defineProperty(node, "imgs", {
                configurable: true,
                get: () => (node.__qgSpShow ? real : []),
                set: (value) => { real = value; },
            });
            node.__qgSpGuard = true;
        } catch {
            return; // 个别节点不让改，放弃这一条，不影响 Vue 那条路
        }
    }
    // 🔴 状态没变就别 setDirty。DOM 观察者会在每次重绘后再叫一遍 applyHidden，
    // 无条件重绘就成了「重绘 → mutation → applyHidden → 重绘」的自激循环。
    if (node.__qgSpShow === want) return;
    node.__qgSpShow = want;
    try {
        app.canvas?.setDirty(true, true);
    } catch {
        /* 画布还没就绪 */
    }
}

/** 把已经登记的节点上的缩略图按住。Vue 靠 CSS 类，经典靠 imgs 访问器。 */
function applyHidden() {
    if (!HIDDEN.size) return;
    for (const id of HIDDEN) {
        for (const shell of document.querySelectorAll(`[data-node-id="${id}"]`)) {
            if (!shell.classList.contains(HIDE_CLASS)) shell.classList.add(HIDE_CLASS);
        }
        guardImgs(nodeById(id), true);
    }
}

function nodeById(id) {
    const nodes = app.graph?._nodes || [];
    return nodes.find((n) => String(n?.id) === String(id)) || null;
}

/** 把三个原生控件的行藏掉。Vue 是 CSS 类，经典那半在 hideCanvasWidget 里做完了。 */
function applyCollapsed() {
    if (!COLLAPSED.size) return;
    for (const id of COLLAPSED) {
        for (const shell of document.querySelectorAll(`[data-node-id="${id}"]`)) {
            if (!shell.classList.contains(COLLAPSED_CLASS)) shell.classList.add(COLLAPSED_CLASS);
        }
    }
}

/**
 * 盯着画布 DOM，外壳一被重建就把类补回去。
 *
 * 光靠事件补不够：Nodes 2.0 在 execution_success 之后会把节点从「执行中」重渲染成常态，
 * 整个 class 属性重设一遍，我们加的类就没了 —— 实测采样中是 hidden，跑完又变回 block。
 * 之后没有 progress 也没有帧事件，再没人补。
 */
let shellObserver = null;

function watchShells() {
    if (shellObserver) return;
    const root = document.getElementById("graph-canvas-container") || document.body;
    if (!root) return;
    let pending = false;
    shellObserver = new MutationObserver(() => {
        if (pending || (!HIDDEN.size && !COLLAPSED.size)) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            applyHidden();
            applyCollapsed();
        });
    });
    // 只关心 class 与节点增删；加类本身也会触发一次 attribute 变化，
    // 但 applyHidden 对已有类的元素不再写，所以不会自激。
    shellObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
    });
}

function clearHidden() {
    // 先放开访问器再清集合：否则关掉开关后缩略图也回不来。
    for (const id of HIDDEN) guardImgs(nodeById(id), false);
    HIDDEN.clear();
    for (const el of document.querySelectorAll(`.${HIDE_CLASS}`)) el.classList.remove(HIDE_CLASS);
}

/** 用完的 blob 地址延迟回收：换帧那一刻旧图可能还在画面上，立刻 revoke 会闪白。 */
function releaseSoon(url) {
    if (!url || pendingRevoke.includes(url)) return;
    pendingRevoke.push(url);
    setTimeout(() => {
        pendingRevoke = pendingRevoke.filter((u) => u !== url);
        URL.revokeObjectURL(url);
    }, URL_GRACE_MS);
}

function pushFrame(blob, isTile = false) {
    let url;
    try {
        url = URL.createObjectURL(blob);
    } catch {
        return;
    }
    const stale = [];
    RUN.tile = Boolean(isTile);
    if (isTile) {
        // 分块阶段：整图还在就继续显示整图。一块局部图顶上去，反而看不出进度落在整图哪儿。
        if (RUN.whole) {
            stale.push(url);
            RUN.url = RUN.whole;
        } else {
            stale.push(RUN.url);
            RUN.url = url;
        }
    } else {
        stale.push(RUN.url);
        RUN.whole = url;
        RUN.url = url;
    }
    RUN.result = null;
    if (RUN.status !== "running" && RUN.status !== "done") RUN.status = "running";
    refresh();
    for (const old of stale) releaseSoon(old);
}

function onEvent(name, handler) {
    api.addEventListener(name, ({ detail }) => {
        try {
            handler(detail);
        } catch {
            // 事件处理出错绝不能让这次运行受影响
        }
    });
}

function wire() {
    if (wired) return;
    wired = true;

    onEvent("execution_start", (detail) => {
        RUN.promptId = detail?.prompt_id ?? null;
        RUN.status = "running";
        RUN.step = 0;
        RUN.total = 0;
        releaseSoon(RUN.whole);
        RUN.url = null;
        RUN.whole = null;
        RUN.tile = false;
        RUN.result = null;
        // 先按节点类型把采样器全部登记上：等到第一帧才有 detail.nodeId 时再藏，
        // 第一帧已经画出来了，会闪一下。
        if (hideRequested()) {
            for (const node of app.graph?._nodes || []) {
                const type = String(node?.comfyClass || node?.type || "");
                if (SAMPLER_RE.test(type)) HIDDEN.add(String(node.id));
            }
            applyHidden();
        } else {
            // 上一轮开过、这一轮关了：不清就会一直藏着。
            clearHidden();
        }
        refresh();
    });

    // 新版把预览帧和来源节点一起发；老版 b_preview 的 detail 就是个 Blob。
    // 两个都收：前端版本不同，发的事件也不一样。
    onEvent("b_preview_with_metadata", (detail) => {
        // 谁发的帧就藏谁，不靠节点类型猜 —— 第三方采样器也能罩住。
        if (detail?.nodeId !== undefined && hideRequested()) {
            HIDDEN.add(String(detail.nodeId));
        }
        if (detail?.blob) pushFrame(detail.blob, drawsTiles(detail?.nodeId));
        applyHidden();
    });
    onEvent("b_preview", (detail) => {
        // 老接口只有 blob，没有来源：退回用「当前正跑哪个节点」判分块。
        if (detail instanceof Blob) pushFrame(detail, drawsTiles(RUN.node));
    });
    // 记一下当前跑的是哪个节点，给上面那条兜底用。
    onEvent("executing", (detail) => {
        RUN.node = detail === null || detail === undefined ? null : String(detail);
    });

    onEvent("progress", (detail) => {
        const max = Number(detail?.max ?? 0);
        // 只要采样器那种多步进度：VAE 解码 / 其他节点也会发 progress，max 常常是 1，
        // 那种会把「step 8 / 8」盖成「step 1 / 1」。
        if (!(max > 1)) return;
        RUN.step = Number(detail.value ?? 0);
        RUN.total = max;
        if (RUN.status !== "running") RUN.status = "running";
        // 顺带按住缩略图：Nodes 2.0 重排节点会把我们加的类冲掉，进度事件比帧事件稳。
        applyHidden();
        refresh();
    });

    // 跑完时有成品就换成成品：最后一帧预览是 latent2rgb 的糊图，不是最终画面。
    onEvent("executed", (detail) => {
        const images = detail?.output?.images;
        if (!Array.isArray(images) || !images.length) return;
        const first = images[0];
        if (!first?.filename) return;
        const query = new URLSearchParams({
            filename: first.filename,
            type: first.type || "output",
            subfolder: first.subfolder || "",
        });
        const base = typeof api.apiURL === "function" ? api.apiURL("") : "/";
        const target = `${base}/view?${query}`;
        // 先解码再换。直接改 src 时浏览器会占着旧帧，可「最后一步」和成品几乎同尺寸，
        // 解码那一下仍可能闪白；等解码好再切，面板从头到尾只变一次画面。
        const token = ++resultToken;
        const swap = () => {
            if (token !== resultToken) return;
            if (RUN.result === target) return;
            RUN.result = target;
            refresh();
        };
        const warm = new Image();
        warm.decoding = "async";
        warm.onload = swap;
        // 拿不到也要给个交代，不能让面板停在最后一步装作还在跑。
        warm.onerror = swap;
        warm.src = target;
        if (typeof warm.decode === "function") warm.decode().then(swap).catch(() => {});
        // 两个回调都没来（极少见）时的兜底
        setTimeout(swap, RESULT_WAIT_MS);
    });

    onEvent("execution_success", () => {
        RUN.status = "done";
        // 跑完也按住：KSampler 上留着的最后一帧同样不该冒出来。
        applyHidden();
        refresh();
    });
    onEvent("execution_interrupted", () => {
        RUN.status = "stopped";
        refresh();
    });
    onEvent("execution_error", () => {
        RUN.status = "error";
        refresh();
    });
}

function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
.qgtools-sp{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:100%;height:100%;padding:0 4px 4px;overflow:hidden;}
.qgtools-sp-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid rgba(0,180,170,.26);border-radius:6px;background:rgba(0,0,0,.28);}
/* 绝对定位：写成普通块级元素时，图片的固有高度（512×512）会把 stage 撑开，
   底部状态栏就被挤出可视区域，STOP 也跟着看不见。 */
.qgtools-sp-img{display:none;position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;object-fit:contain;}
.qgtools-sp-img.on{display:block;}
.qgtools-sp-hint{display:none;padding:0 10px;color:#7d9593;font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.4;text-align:center;white-space:pre-line;}
.qgtools-sp-hint.on{display:block;}
.qgtools-sp-bar{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:6px;height:${BAR_HEIGHT}px;}
.qgtools-sp-steps{color:#5f7674;font:10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;}
.qgtools-sp-steps.live{color:#00b4aa;}
.qgtools-sp-gear{margin-left:auto;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${BAR_HEIGHT - 2}px;height:${BAR_HEIGHT - 2}px;padding:0;border:1px solid rgba(0,180,170,.32);border-radius:4px;background:rgba(0,0,0,.7);color:#8fb4b2;cursor:pointer;}
.qgtools-sp-gear:hover{color:#c8dddd;border-color:rgba(0,180,170,.7);}
.qgtools-sp-gear.on{color:#00d8cc;border-color:#00b4aa;background:rgba(0,79,75,.6);}
.qgtools-sp-stop{box-sizing:border-box;height:${BAR_HEIGHT - 2}px;min-width:46px;padding:0 8px;border:1px solid rgba(0,180,170,.52);border-radius:4px;background:rgba(0,0,0,.7);color:#c8dddd;font:700 9.5px/1 "Segoe UI",sans-serif;letter-spacing:.08em;cursor:pointer;}
.qgtools-sp-stop:hover:not(:disabled){border-color:#00b4aa;background:rgba(0,79,75,.78);color:#fff;}
.qgtools-sp-stop:disabled{opacity:.34;cursor:default;border-color:rgba(0,180,170,.28);color:#7d9593;}
/* 设置浮层：盖满画面，内容贴顶。铺满但不居中 —— 三行居中会在上面空一大片。
   铺满而不是只盖一条，是为了别让下面的提示文字露出半截，看着割裂。 */
.qgtools-sp-settings{position:absolute;inset:4px;z-index:6;display:none;flex-direction:column;justify-content:flex-start;gap:6px;box-sizing:border-box;padding:8px 10px;border:1px solid rgba(0,180,170,.42);border-radius:6px;background:rgba(6,22,22,.97);}
.qgtools-sp-settings.on{display:flex;}
.qgtools-sp-row{display:flex;align-items:center;gap:8px;min-width:0;font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#9fb6b4;}
.qgtools-sp-row > span{flex:0 0 auto;white-space:nowrap;}
.qgtools-sp-row select,.qgtools-sp-row input[type="number"]{flex:1 1 auto;min-width:0;box-sizing:border-box;height:20px;padding:0 4px;border:1px solid rgba(0,180,170,.34);border-radius:4px;background:rgba(0,0,0,.55);color:#d6e8e6;font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.qgtools-sp-row select:focus,.qgtools-sp-row input[type="number"]:focus{outline:none;border-color:#00b4aa;}
.qgtools-sp-row input[type="checkbox"]{flex:0 0 auto;width:14px;height:14px;margin:0 0 0 auto;accent-color:#00b4aa;cursor:pointer;}
.qgtools-sp-note{margin-top:auto;color:#5f7674;font:10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;}
/* 三个原生控件收进齿轮后不占行。data-widget-name 是 Nodes 2.0 给每行打的记号，
   实测存在；经典画布那半由 hideCanvasWidget 把 computeSize 压到 0 高。 */
.qgtools-sp-nested [data-widget-name="method"],
.qgtools-sp-nested [data-widget-name="max_size"],
.qgtools-sp-nested [data-widget-name="hide_sampler"]{display:none!important;}
/* 「隐藏采样器缩略图」：Nodes 2.0 的缩略图是节点外壳里的一张 <img>（src 是 blob:），
   加这个类就藏掉。限定在带类的节点外壳里，不碰别的节点。 */
.qgtools-sp-nothumb img:not(.qgtools-sp-img){display:none!important;}
`;
    document.head.appendChild(style);
}

function mountPanel(node) {
    if (node._qgStepPreview) return node._qgStepPreview;
    ensureCss();
    wire();
    watchShells();

    const root = document.createElement("div");
    root.className = "qgtools-sp";

    const stage = document.createElement("div");
    stage.className = "qgtools-sp-stage";
    const img = document.createElement("img");
    img.className = "qgtools-sp-img";
    img.alt = "";
    const hint = document.createElement("div");
    hint.className = "qgtools-sp-hint";
    stage.append(img, hint);

    const bar = document.createElement("div");
    bar.className = "qgtools-sp-bar";
    const steps = document.createElement("span");
    steps.className = "qgtools-sp-steps";

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "qgtools-sp-gear";
    gear.title = zhPair("Settings", "设置");
    gear.setAttribute("aria-label", gear.title);
    gear.innerHTML =
        '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">' +
        '<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
        '<circle cx="6" cy="6" r="1.4" fill="currentColor"/></svg>';

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "qgtools-sp-stop";
    stop.textContent = "STOP";
    stop.title = zhPair("Interrupt this run", "中断这次运行");
    stop.addEventListener("pointerdown", (event) => event.stopPropagation());
    stop.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (RUN.status === "running") api.interrupt();
    });
    bar.append(steps, gear, stop);

    // ---------------------------------------------------------------- 设置浮层
    // 三个参数收进齿轮里：节点上不再占三行，需要时才展开。
    const widgetOf = (name) => (node.widgets || []).find((w) => w.name === name) || null;

    const writeWidget = (name, value) => {
        const widget = widgetOf(name);
        if (!widget) return;
        widget.value = value;
        // 走一遍 callback：method / hide_sampler 被本文件包过（刷新提示、重按缩略图）。
        // 原生 callback 的参数格式各家不同，出错也不影响值已经写进去。
        try {
            widget.callback?.(value, null, node);
        } catch {
            /* 忽略 */
        }
        try {
            node.setDirtyCanvas?.(true, true);
        } catch {
            /* 忽略 */
        }
    };

    const settings = document.createElement("div");
    settings.className = "qgtools-sp-settings";
    // 浮层里的点击不能再往下走，否则会被当成拖节点。
    settings.addEventListener("pointerdown", (event) => event.stopPropagation());

    const makeRow = (labelText) => {
        const row = document.createElement("div");
        row.className = "qgtools-sp-row";
        const tag = document.createElement("span");
        tag.textContent = labelText;
        row.append(tag);
        return row;
    };

    const methodRow = makeRow(zhPair("Mode", "预览方式"));
    const methodSel = document.createElement("select");
    for (const [value, zh, en] of METHOD_OPTIONS) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = zhPair(en, zh);
        methodSel.append(option);
    }
    methodRow.append(methodSel);

    const sizeRow = makeRow(zhPair("Max edge", "最大边长"));
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "64";
    sizeInput.max = "2048";
    sizeInput.step = "64";
    sizeRow.append(sizeInput);

    const hideRow = makeRow(zhPair("Hide thumbnail", "隐藏缩略图"));
    const hideBox = document.createElement("input");
    hideBox.type = "checkbox";
    hideRow.append(hideBox);

    const note = document.createElement("div");
    note.className = "qgtools-sp-note";
    note.textContent = zhPair(
        "Previews only \u2014 the saved image is untouched.",
        "只影响预览，不影响出图。"
    );

    settings.append(methodRow, sizeRow, hideRow, note);
    stage.append(settings);

    /** 把三个原生控件的当前值抄进浮层。打开浮层和加载工作流时都要来一次。 */
    const syncUi = () => {
        const method = String(widgetOf("method")?.value ?? "auto");
        // 老存档可能存着中文值；不在选项里就落回默认，避免下拉显示成空白。
        methodSel.value = METHOD_OPTIONS.some(([v]) => v === method) ? method : "auto";
        const size = Number(widgetOf("max_size")?.value ?? 512);
        sizeInput.value = String(Number.isFinite(size) ? size : 512);
        const hide = widgetOf("hide_sampler")?.value;
        hideBox.checked = hide === true || hide === "true";
    };

    gear.addEventListener("pointerdown", (event) => event.stopPropagation());
    gear.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = !settings.classList.contains("on");
        if (open) syncUi();
        settings.classList.toggle("on", open);
        gear.classList.toggle("on", open);
    });

    methodSel.addEventListener("change", () => writeWidget("method", methodSel.value));
    sizeInput.addEventListener("change", () => {
        const wanted = Number(sizeInput.value);
        // 控件被藏起来了，原生那层不会再帮着夹范围，自己来。
        const clamped = Number.isFinite(wanted)
            ? Math.max(64, Math.min(2048, Math.round(wanted / 64) * 64))
            : 512;
        sizeInput.value = String(clamped);
        writeWidget("max_size", clamped);
    });
    hideBox.addEventListener("change", () => writeWidget("hide_sampler", hideBox.checked));

    // 原生那三行不显示了：经典画布压成 0 高，Nodes 2.0 用 CSS 类藏。
    // 控件本身留在 node.widgets 里 —— 值要靠它进存档和 prompt，删了就没参数了。
    COLLAPSED.add(String(node.id));
    for (const name of NESTED_WIDGETS) {
        const widget = widgetOf(name);
        if (widget) hideCanvasWidget(widget);
    }
    applyCollapsed();

    root.append(stage, bar);

    const minHeight = STAGE_MIN_HEIGHT + BAR_HEIGHT;
    const widget = node.addDOMWidget(PANEL_WIDGET, "qg_step_preview", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => minHeight,
        getMaxHeight: () => undefined,
        // 画布和 Vue 节点都显示，侧边面板不显示（跟其他 QG 面板一致）
        surfaces: { canvas: "shown", vueNode: "shown", panel: "never" },
    });
    if (widget?.visibility?.surfaces) {
        widget.visibility.surfaces.canvas = "shown";
        widget.visibility.surfaces.vueNode = "shown";
        widget.visibility.surfaces.panel = "never";
    }
    widget.serialize = false;
    keepDomWidgetWidthAuto(widget);
    fillNodeHeight(widget, {
        minWidth: sizeFor(NODE_TYPE).minW,
        minHeight,
        minNodeSize: [sizeFor(NODE_TYPE).minW, minHeight],
        // 不加这个，litegraph 会把 minWidth 当「控件内容宽」再补上一圈 margin /
        // 数值区（实测 104px），拖到表里的 270 实际卡在 374。
        exactMinWidth: true,
    });

    // 换「预览方式」时提示语要跟着变，但此时没有事件可听；「隐藏缩略图」同理。
    for (const name of ["method", "hide_sampler"]) {
        const widget = (node.widgets || []).find((w) => w.name === name);
        if (!widget || widget.__qgSpWrapped) continue;
        const original = widget.callback;
        widget.callback = function (...args) {
            const result = typeof original === "function"
                ? original.apply(this, args)
                : undefined;
            if (!hideRequested()) clearHidden();
            applyHidden();
            refresh();
            return result;
        };
        widget.__qgSpWrapped = true;
    }

    const face = {
        node,
        root,
        stage,
        img,
        hint,
        steps,
        stop,
        gear,
        settings,
        syncUi,
        lastSrc: null,
        update(run) {
            const live = run.status === "running";
            this.stop.disabled = !live;
            this.steps.textContent = statusLabel(run);
            this.steps.classList.toggle("live", live);

            // result 一到就显示，不等 execution_success：那条消息在整条图跑完之后才到，
            // 「关闭」档里中间没有任何帧，等下去会先闪一下「没有可显示的图」。
            const src = run.result || run.url;
            if (src) {
                if (this.lastSrc !== src) {
                    this.img.src = src;
                    this.lastSrc = src;
                }
                this.img.classList.add("on");
                this.hint.classList.remove("on");
            } else {
                this.img.classList.remove("on");
                this.lastSrc = null;
                // 画面既然藏起来了，src 也一并摘掉：刚回收的 blob 地址不该还挂在这儿。
                if (this.img.getAttribute("src")) this.img.removeAttribute("src");
                this.hint.classList.add("on");
                // 「关闭」这一档中间永远没有帧，得把话说清楚，不然看着像坏了。
                if (run.status === "idle") {
                    this.hint.textContent = zhPair(
                        "Run the workflow \u2014 the picture forms here.\n" +
                        "With method set to none only the finished image shows.",
                        "运行工作流，画面会在这里逐步成形。\n" +
                        "预览方式设为「关闭」时，只显示跑完的成品图。"
                    );
                } else if (previewOff(this.node)) {
                    this.hint.textContent = zhPair(
                        "Previews are off \u2014 the finished image shows when the run ends",
                        "预览已关闭，跑完显示成品图"
                    );
                } else if (run.status === "running") {
                    // 模型加载到第一帧之间那几秒是空的。以前这儿写「没有可显示的图」，
                    // 看着像坏了；其实只是一帧都还没来。
                    this.hint.textContent = zhPair(
                        "Running \u2014 the picture appears here as soon as it starts",
                        "正在运行，画面一出来就显示在这里"
                    );
                } else {
                    this.hint.textContent = zhPair("No image to show", "没有可显示的图");
                }
            }
        },
        dispose() {
            this.img.removeAttribute("src");
            this.root.remove();
        },
    };
    FACES.add(face);
    node._qgStepPreview = face;
    face.update(RUN);
    return face;
}

app.registerExtension({
    name: "QG.stepPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            mountPanel(this);
            return result;
        };

        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configured?.apply(this, arguments);
            // 加载进来的工作流会重写控件值，浮层得跟着对齐（已经挂过就不会重建）。
            mountPanel(this).syncUi?.();
            return result;
        };

        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const face = this._qgStepPreview;
            if (face) {
                FACES.delete(face);
                COLLAPSED.delete(String(this.id));
                face.dispose();
                this._qgStepPreview = null;
            }
            return removed?.apply(this, arguments);
        };
    },
    async setup() {
        wire();
    },
});
