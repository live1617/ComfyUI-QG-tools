// Nodes 2.0（Vue 渲染）下，参数面板的高度与节点高度是两套算法，必须显式对齐。
//
// 外壳 .lg-node 只有下限（`min-h-(--node-height)`），没有上界；节点实际高度
// = 标题栏 + 槽行 + 内边距 + 每一行 widget 的自然高。这套算法和经典画布的
// `node.size[1]` 不是一回事，参数面板一掺进来就会错开。两种面板要两种做法：
//
//   · 弹性面板（有滚动区，或走 fillNodeHeight 参与空间分配）
//     面板会跟着空间长，外壳被内容顶高，节点越来越长，没有刹车。
//     → pinPanelToNodeHeight：给面板加 max-height 上限。
//
//   · 固定面板（卡片，高度由行数/内容定，压不动）
//     外壳比 `size[1] + 30` 高一截，画布上的选中框、连线锚点、右下角缩放手柄
//     全对不上（Vue 的节点几何仍读 node.size）。
//     → fitNodeToPanelHeight：反过来让 size 跟上外壳的实测高度。
//
// 两种做法都不写死「面板以外有多高」：它随前端版式变，且恒等于
// 「外壳高 − 面板高」—— 面板被夹住时同样成立，所以一次就能收敛。

import { vueNodesEnabled } from "./vue_mode.mjs?v=2026102420";

/** 外壳上标题栏之外的高度（Vue 里 node.size[1] 不含标题栏，与经典一致）。 */
export const VUE_TITLE_HEIGHT = 30;

// 只有一行输入槽 + 一行输出槽时的常见值。第一次测量后就被实测值替换。
const DEFAULT_CHROME = 92;

/**
 * 找节点在 Vue 下的外壳元素。
 * 优先沿面板往上爬（最准），爬不到再按 data-node-id 查（面板刚挂上、还没接进外壳时）。
 */
export function vueShellOf(node, panel) {
    if (!node || !vueNodesEnabled()) return null;
    const shell = panel?.closest?.(".lg-node");
    if (shell) return shell;
    return document.querySelector(`[data-node-id="${node.id}"]`);
}

// 面板刚挂上 / 刚切模式时外壳可能还没出现：有限次重试（250ms × 8），别自激。
function retryLater(state, run) {
    if (!state || (state.tries ?? 0) >= 8 || state.timer) return false;
    state.tries = (state.tries ?? 0) + 1;
    state.timer = setTimeout(() => {
        state.timer = null;
        try { run(); } catch { /* 下次再说 */ }
    }, 250);
    return false;
}

/**
 * 弹性面板：把面板高度夹在「节点总高 − 面板以外的高度」以内。
 *
 * `state` 是调用方自己的对象（通常挂在 node 上），用来记住实测的 chrome
 * 与重试计数，跨调用复用。
 */
export function pinPanelToNodeHeight(node, panel, state = {}) {
    if (!panel) return false;
    if (!vueNodesEnabled() || node?.flags?.collapsed) {
        if (panel.style.maxHeight) panel.style.maxHeight = "";
        return false;
    }
    const chrome = Number.isFinite(state.chrome) ? state.chrome : DEFAULT_CHROME;
    const fallback = Math.round(node.size?.[1] ?? 0) + VUE_TITLE_HEIGHT;
    // 用 calc 引用 --node-height：拖大拖小、内容变化都自动跟随，不必每帧重算
    const wanted = `calc(var(--node-height, ${fallback}px) - ${chrome}px)`;
    if (panel.style.maxHeight !== wanted) panel.style.maxHeight = wanted;
    const shell = vueShellOf(node, panel);
    if (!shell) return retryLater(state, () => pinPanelToNodeHeight(node, panel, state));
    state.tries = 0;
    const actual = shell.offsetHeight - panel.offsetHeight;
    if (actual <= 0 || Math.abs(actual - chrome) <= 2) return true;
    state.chrome = actual;
    const fixed = `calc(var(--node-height, ${fallback}px) - ${actual}px)`;
    if (panel.style.maxHeight !== fixed) panel.style.maxHeight = fixed;
    return true;
}

/**
 * 固定面板：让 node.size 跟上外壳的实测高度。
 *
 * 面板高度不随节点变，所以外壳高是常数 —— 写进去一次就稳定，不会自激。
 * `__qgAutoSize` 标记给节点的 onResize 用：区分「用户拖的」和「我们调的」。
 */
export function fitNodeToPanelHeight(node, panel, state = {}) {
    if (!node || !vueNodesEnabled() || node.flags?.collapsed) return false;
    const shell = vueShellOf(node, panel);
    if (!shell) return retryLater(state, () => fitNodeToPanelHeight(node, panel, state));
    state.tries = 0;
    const want = Math.round(shell.offsetHeight - VUE_TITLE_HEIGHT);
    if (!(want > 40)) return false;
    const current = Math.round(node.size?.[1] ?? 0);
    if (Math.abs(current - want) < 2) return true;
    const width = node.size?.[0] ?? 320;
    node.__qgAutoSize = true;
    try {
        node.setSize?.([width, want]);
    } finally {
        node.__qgAutoSize = false;
    }
    node.setDirtyCanvas?.(true, true);
    return true;
}

/**
 * 盯着外壳尺寸：它一变就回调（Vue 里外壳是 DOM，尺寸由内容决定）。
 *
 * `getRoot` 每次现取面板元素 —— 切渲染模式会重建 DOM，闭包里捕获的旧引用会失效。
 * 外壳还没出现时按 400ms 重试，最多 20 次；节点删掉后由 unwatchVueShell 收尾。
 *
 * 🔴 一个节点可以挂多个面板（LoraLoader 每个 LoRA 输入一块），它们共用同一个
 * 外壳。所以按 key 登记回调、只观察一次外壳，别让后注册的把先注册的冲掉。
 */
export function watchVueShell(node, getRoot, onChange, key = "panel") {
    if (!node) return null;
    const state = (node.__qgShellWatch ??= {
        obs: null, shell: null, timer: null, tries: 0, listeners: new Map(),
    });
    state.listeners.set(key, { getRoot, onChange });
    const fire = () => {
        for (const { onChange: run } of state.listeners.values()) {
            try { run(); } catch (e) { console.error("[QG-tools] 面板高度对齐出错：", e); }
        }
    };
    const findShell = () => {
        for (const { getRoot: rootOf } of state.listeners.values()) {
            const shell = vueShellOf(node, rootOf?.());
            if (shell) return shell;
        }
        return null;
    };
    const attempt = () => {
        const shell = findShell();
        if (!shell) {
            if ((state.tries ?? 0) < 20 && !state.timer) {
                state.tries = (state.tries ?? 0) + 1;
                state.timer = setTimeout(() => {
                    state.timer = null;
                    attempt();
                }, 400);
            }
            return false;
        }
        state.tries = 0;
        if (state.shell !== shell) {
            state.obs?.disconnect?.();
            state.shell = shell;
            if (typeof ResizeObserver === "function") {
                state.obs = new ResizeObserver(fire);
                state.obs.observe(shell);
            }
        }
        fire();
        return true;
    };
    attempt();
    return state;
}

/** 拆掉 watchVueShell 挂的观察者与定时器（不传 key 就全拆，节点删除时用）。 */
export function unwatchVueShell(node, key) {
    const state = node?.__qgShellWatch;
    if (!state) return;
    if (key !== undefined) {
        state.listeners.delete(key);
        if (state.listeners.size) return;
    }
    try { state.obs?.disconnect?.(); } catch { /* 忽略 */ }
    clearTimeout(state.timer);
    node.__qgShellWatch = null;
}
