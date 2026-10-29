// Nodes 2.0（Vue 渲染）公共工具。
//
// 目标：让 QG-tools 的自定义节点在 Comfy.VueNodes.Enabled = true 时也能正常显示，
// 同时保持经典模式行为不变。本模块提供判断、迁移、拆卸、宽度补偿等通用能力。

import { app } from "/scripts/app.js";
import { chainCallback } from "./index.mjs?v=2026102915";

const FLOORS = Symbol("qg.widthFloors");

/** 当前是否处于 Nodes 2.0（Vue 渲染）模式。取不到设置一律按经典模式处理。 */
export function vueNodesEnabled() {
    const KEY = "Comfy.VueNodes.Enabled";
    // 两条官方 API 在不同前端版本上都有出现，任一能读到就用它；
    // 都读不到才认为「不是 Vue 模式」。
    try {
        const v = app.ui?.settings?.getSettingValue?.(KEY);
        if (v !== undefined && v !== null) return v === true || v === "true";
    } catch { /* 换下一条 */ }
    try {
        const v = app.extensionManager?.setting?.get?.(KEY);
        if (v !== undefined && v !== null) return v === true || v === "true";
    } catch { /* 换下一条 */ }
    try {
        const raw = localStorage.getItem("Comfy.Settings.json");
        if (raw) {
            const v = JSON.parse(raw)?.[KEY];
            if (v !== undefined && v !== null) return v === true || v === "true";
        }
    } catch { /* 放弃 */ }
    return false;
}

// 渲染模式切换的额外挂钩。多个模块可各自登记，互不覆盖
// （installModeWatcher 只能有一个实例，但它需要的附带动作往往不止一处）。
const modeSwitchHooks = [];

/**
 * 登记「渲染模式切换时额外要做的事」。
 *
 * 典型用途：关掉正在显示的编辑浮层。浮层按旧模式的定位基准摆放
 * （Vue 用 DOM rect、经典用画布坐标），切完模式就错位；更糟的是弹窗遮罩是
 * position:fixed;inset:0 + 全透明，残留一次整页就点不动了。
 *
 * ⚠️ 不要塞进节点的 __qgSyncMode —— 那个函数在新建节点 / 加载工作流时也会跑，
 *    在那些时机关浮层会打断正在编辑的用户。
 */
export function onRenderModeSwitch(fn) {
    if (typeof fn === "function" && !modeSwitchHooks.includes(fn)) modeSwitchHooks.push(fn);
}

/**
 * 监听渲染模式开关。切换后自动调用每个节点上的 __qgSyncMode() 进行就地迁移。
 *
 * 不挂钩设置项 onChange（ComfyUI 设置表结构不稳定），用轻量轮询 + 防抖。
 * 400ms 轮询一次值，变化后等 350ms 稳定再遍历节点，避免快速连切时并发迁移。
 *
 * @param {(node:any)=>(Function|null)} [fallback] 节点上没有 __qgSyncMode 时的兜底：
 *        由调用方判断类型、现场补挂并返回该函数。没有它就只能跳过该节点，
 *        表现为「切了模式但节点不动」。
 */
export function installModeWatcher(fallback) {
    if (installModeWatcher.__timer) return;
    let last = vueNodesEnabled();
    let scheduled = null;
    installModeWatcher.__timer = setInterval(() => {
        const now = vueNodesEnabled();
        if (now === last) return;
        last = now;
        clearTimeout(scheduled);
        scheduled = setTimeout(() => {
            scheduled = null;
            const nodes = app.graph?._nodes;
            if (!Array.isArray(nodes)) return;
            // 迁移前后各扫一次页面级容器：任何一次迁移路径把 body/html 写成
            // pointer-events:none，都会让整个界面失去响应（而画面看不出异常）。
            try { sanitizePagePassthrough(); } catch { /* 忽略 */ }
            // 切模式前先把浮层收掉：它们按旧模式的定位基准摆，切完必然错位，
            // 而且弹窗遮罩是全屏透明层，残留一份整页都点不动。
            for (const hook of modeSwitchHooks) {
                try { hook(now); } catch (e) { console.error("[QG-tools] 模式切换钩子出错：", e); }
            }
            let done = 0, skipped = 0;
            for (const n of nodes.slice()) {
                let fn = n.__qgSyncMode;
                if (typeof fn !== "function" && typeof fallback === "function") {
                    try { fn = fallback(n); } catch { fn = null; }
                }
                if (typeof fn !== "function") { skipped++; continue; }
                try {
                    fn();
                    done++;
                } catch (e) {
                    console.error("[QG-tools] 渲染模式迁移出错：", e);
                }
            }
            // 一个都没迁移成功，几乎一定意味着挂载入口丢了，留个线索
            if (!done && skipped) {
                console.warn("[QG-tools] 渲染模式已切换，但没有节点响应迁移（%d 个跳过）", skipped);
            }
            try { sanitizePagePassthrough(); } catch { /* 忽略 */ }
        }, 350);
    }, 400);
}

/**
 * 摘掉一个 DOM widget，并且连 GraphView 的包装层一起拆干净。
 *
 * 前端把每个 DOM widget 登记在内部 widgetStates，对应画布上一个 div.dom-widget。
 * 只 splice node.widgets 会留下包装层，且重新布局时它会把已摘掉的 element 再 append
 * 回去，造成幽灵 DOM。官方注销路径是 widget.onRemove()（node.removeWidget 内部调用）。
 */
export function detachDomWidget(node, widget, root) {
    if (!widget) return null;
    const host = root?.parentElement ?? null;
    try {
        if (typeof node?.removeWidget === "function") node.removeWidget(widget);
        else widget.onRemove?.();
    } catch (e) {
        console.error("[QG-tools] 摘 DOM widget 出错：", e);
    }
    const i = node?.widgets ? node.widgets.indexOf(widget) : -1;
    if (i >= 0) node.widgets.splice(i, 1);
    try {
        node?.[FLOORS]?.delete?.(widget);
    } catch { /* 忽略 */ }
    try {
        root?.remove();
    } catch { /* 忽略 */ }
    if (host && host.classList?.contains("dom-widget")) {
        try {
            host.remove();
        } catch { /* 忽略 */ }
    }
    return widget;
}

// 向上遍历时绝对不许跨过的边界。它们的 pointer-events 一旦被改成 none，
// 整个界面（画布拖拽、滚轮缩放、顶栏按钮）会全部失效，而画面看起来完全正常。
const PE_HARD_STOP = ["graph-canvas-container", "vue-app", "comfyui-body"];

/** 是否属于「绝不能碰」的页面级容器。 */
function isPageLevel(el) {
    if (!el) return true;
    if (el === document.body || el === document.documentElement) return true;
    const id = el.id || "";
    if (PE_HARD_STOP.includes(id)) return true;
    return el.tagName === "MAIN" || el.tagName === "HTML" || el.tagName === "BODY";
}

/**
 * 让纯展示 DOM 的指针事件穿过 root → .lg-node 之间的中间层，落到节点外壳上。
 * 节点外壳本身不能设 pointer-events:none，否则拖/点全灭。
 *
 * 🔴 先收集再动手，找不到外壳就整体放弃：
 *    曾出过整页失效事故 —— 切渲染模式那一瞬间 root 会被摘下来重新挂，此时
 *    祖先链里没有 .lg-node，旧实现（边找边改 + guard<16）会一路把
 *    #graph-canvas-container / MAIN / #vue-app / BODY / HTML 全写成
 *    pointer-events:none。表现就是「画布滚轮缩放不了、顶部按钮点不了，
 *    但界面看着一切正常」，只能强刷页面。
 *    现在的做法：链上任何一环是页面级容器就立刻 return false，一个字节都不改。
 */
export function applyPointerPassthrough(root) {
    if (!root) return false;
    const chain = [];
    let el = root.parentElement;
    let shell = null;
    let guard = 0;
    while (el && guard++ < 16) {
        if (el.classList?.contains("lg-node")) { shell = el; break; }
        if (isPageLevel(el)) return false; // 越界：不改任何东西，等下次重试
        chain.push(el);
        el = el.parentElement;
    }
    if (!shell) return false; // 还没接上外壳
    if (root.style.pointerEvents !== "none") root.style.pointerEvents = "none";
    // 直接写，不用 getComputedStyle —— 后者会强制同步布局，
    // 而这个函数在 MutationObserver 里会被反复调用（画布一卡就全卡）。
    for (const e of chain) {
        if (e.style.pointerEvents !== "none") {
            e.dataset.qgPassthrough = "1";
            e.style.pointerEvents = "none";
        }
    }
    return true;
}

/**
 * 还原 applyPointerPassthrough 写下的 pointer-events:none。
 *
 * 🔴 这一步不是可选的。被写到 none 的中间层如果被前端复用（Vue 只重建外壳、
 *    不一定重建外层容器），切回经典模式后它仍然收不到事件 —— 于是画布拖不动、
 *    滚轮不缩放，而节点看起来都是好好的。所以卸载 / 切模式时必须还原。
 *
 * @param {Element} [root] 只还原该 root 那条链；不传就全量扫 data-qg-passthrough
 *        （控制台自救命令 __qgClean 用）。
 */
export function clearPointerPassthrough(root) {
    let n = 0;
    if (root) {
        if (root.style?.pointerEvents === "none") { root.style.pointerEvents = ""; n++; }
        let el = root.parentElement;
        let guard = 0;
        while (el && guard++ < 16) {
            if (el.classList?.contains("lg-node") || isPageLevel(el)) break;
            if (el.dataset?.qgPassthrough === "1") {
                el.style.pointerEvents = "";
                delete el.dataset.qgPassthrough;
                n++;
            }
            el = el.parentElement;
        }
        return n;
    }
    for (const el of document.querySelectorAll('[data-qg-passthrough="1"]')) {
        el.style.pointerEvents = "";
        delete el.dataset.qgPassthrough;
        n++;
    }
    return n;
}

/**
 * 兜底大扫除：页面级容器上若残留 pointer-events:none，无条件清掉。
 *
 * 不管是谁写的、怎么写的，只要这几个节点上是 none，界面就一定点不动。
 * 挂载模式迁移前后各扫一次，成本是几次属性读取。
 */
export function sanitizePagePassthrough() {
    let n = 0;
    const list = [document.body, document.documentElement,
        document.getElementById("graph-canvas-container"),
        document.getElementById("vue-app")];
    for (const el of list) {
        if (!el) continue;
        if (el.style?.pointerEvents === "none") { el.style.pointerEvents = ""; n++; }
        if (el.dataset?.qgPassthrough) delete el.dataset.qgPassthrough;
    }
    return n;
}

/**
 * 持续保证指针穿透。Vue 异步挂载 / 重排 DOM widget 会重建中间容器，
 * 内联样式随之丢失 —— 只在 mount 时设一次会导致「看起来挂上了，但按不动拖不走」。
 *
 * 做法：先尝试设一次；没找到外壳就有限次重试（最多 8 次，400ms 间隔）；
 * 找到后挂 MutationObserver 盯外壳子树变化，每次变化补设一遍。
 * ⚠️ 重试必须能停：root 已被移除（切回经典）或 state 已 dispose 时立刻放弃。
 */
export function watchPointerPassthrough(node, root, state, attempt = 0) {
    if (!root?.isConnected) return;
    if (state?.disposed) return;
    if (root.__qgPassthroughObs) return; // 已挂过
    const done = applyPointerPassthrough(root);
    if (!done) {
        if (attempt < 8) {
            setTimeout(() => watchPointerPassthrough(node, root, state, attempt + 1), 400);
        }
        return;
    }
    const shell = root.closest?.(".lg-node");
    if (!shell || typeof MutationObserver !== "function") return;
    // rAF 节流：Vue 一次重排会连发几十条 mutation，逐条处理会把主线程拖死
    let pending = false;
    const mo = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (state?.disposed || !root.isConnected) {
                mo.disconnect();
                return;
            }
            applyPointerPassthrough(root);
        });
    });
    mo.observe(shell, { childList: true, subtree: true });
    root.__qgPassthroughObs = mo;
    state && (state.passthroughObs = mo);
}

/** 拆掉 watchPointerPassthrough 挂的观察者，并还原它写下的穿透。 */
export function unwatchPointerPassthrough(root) {
    try {
        root?.__qgPassthroughObs?.disconnect?.();
    } catch { /* 忽略 */ }
    if (root) root.__qgPassthroughObs = null;
    // 必须连着还原一起做：中间容器可能是被复用的，光断观察者会把它永久留在
    // pointer-events:none 状态（切回经典模式后画布整页点不动）。
    try {
        clearPointerPassthrough(root);
    } catch { /* 忽略 */ }
}

/**
 * Vue 节点外壳内容区比 node.size[0] 窄一圈（左右各约 12px）。
 * 若 node.size 刚好等于内容宽，DOM 内容会被压窄、长文本换行。
 * 这里按 row.clientWidth（布局宽，不受缩放影响）与 node.size[0] 的差值补偿。
 *
 * 🔴 差值必须钳住上界：外壳内边距正常只有十几 px。一旦 node.size 被别处
 *    撑大（Vue 重建节点 / 容器尺寸串味），`cur - avail` 会变成几百，
 *    回写 node.size 又让差值更大 —— 正反馈滚雪球，实测把 100px 的标签撑到
 *    1600×200，节点直接飞出视野（表现为「切模式后标签不见了」）。
 */
export function refitVueNodeWidth(node, root, state) {
    if (!root || !node) return;
    const row = root.parentElement;
    if (!row) return;
    const avail = row.clientWidth;
    if (!(avail > 4)) return;
    const content = Number(state?.contentWidth) || 0;
    if (!(content > 0)) return;
    const cur = Number(node.size?.[0]) || 0;
    const padX = Math.max(0, Math.min(60, cur - avail));
    const want = Math.round(content + padX);
    if (Math.abs(cur - want) >= 1) node.size[0] = want;
}
