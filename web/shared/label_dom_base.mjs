// Nodes 2.0（Vue 渲染）下「纯展示型标签节点」的 DOM 挂载驱动。
//
// QG_CanvasLabel 与 QG_MarkdownNote 的 Vue 分支只有一处不同：怎么把节点内容
// 变成 DOM。其余全部一样，且都属于「一改就出事」的高危逻辑 —— 指针穿透、
// 双击委托、尺寸回写、卸载清理。所以统一放在这里，两边共用，避免两份实现漂移。
//
// 调用方只需提供 spec：
//   build(node)      → 返回内容 Element（宽度/高度由 measure 决定，这里不做测量）
//   measure(node)    → [w, h] 完整盒子尺寸（含自身 padding，不含 Vue 外壳内边距）
//   padX             → Vue 节点外壳左右内边距合计
//   openEditor(node) → 双击时调用
//
// 🔴 尺寸必须由 measure() 一次算死。绝不能在 refresh 里回读 DOM 布局反推尺寸：
//    写 node.size → Vue 重排 → ResizeObserver → 再写，形成回声循环，
//    节点一大就把主线程占满，画布滚轮缩放完全失效（实测过）。
import { keepDomWidgetWidthAuto } from "./index.mjs?v=2026102571";
import {
    applyPointerPassthrough,
    detachDomWidget,
    sanitizePagePassthrough,
    unwatchPointerPassthrough,
    vueNodesEnabled,
    watchPointerPassthrough,
} from "./vue_mode.mjs?v=2026102571";

const MOUNTING = Symbol("qg.labelDomMounting");
// 间隔兜底阈值。450 → 600 → 800 的演进原因：
// 实测「550ms 间隔的手慢双击」在 450/600 下都打不开（CDP 的 press→release
// 还有 30ms 开销，实际间隔会比 gap 大一截），而探针历来用 120ms 间隔，
// 永远能过 —— 于是「Vue 模式双击没反应」这个 bug 一直没被测试暴露。
// 800ms 只会更容易触发，误伤「快速点两下想取消选中」的代价可以接受。
const DOUBLE_TAP_MS = 800;

/** 兜底尺寸：measure 抛错时用，保证 node.size 永远是合法正数。 */
const FALLBACK_SIZE = [80, 24];

/**
 * 造一对 mount/unmount/sync 函数。
 *
 * @param {{widgetName:string, widgetType:string, label:string,
 *          rootClass:string, padX:number,
 *          build:(node:any)=>Element,
 *          measure:(node:any)=>[number,number],
 *          openEditor:(node:any)=>void}} spec
 */
export function createLabelDomDriver(spec) {
    const {
        widgetName, widgetType, label, rootClass,
        padX = 24, build, measure, openEditor,
    } = spec;

    /** 摘掉旧的 DOM widget / 监听器 / 观察者，避免重复挂载留下幽灵。 */
    function cleanupStale(node) {
        const old = node.__qgLabelDom;
        if (old) {
            old.disposed = true;
            if (old.editDelegate) {
                document.removeEventListener("mousedown", old.editDelegate, true);
                old.editDelegate = null;
            }
            if (old.dblDelegate) {
                document.removeEventListener("dblclick", old.dblDelegate, true);
                old.dblDelegate = null;
            }
            unwatchPointerPassthrough(old.root);
            node.__qgLabelDom = null;
        }
        const widgets = node.widgets;
        if (Array.isArray(widgets)) {
            for (let i = widgets.length - 1; i >= 0; i--) {
                const w = widgets[i];
                if (w?.name !== widgetName) continue;
                try {
                    if (typeof node.removeWidget === "function") node.removeWidget(w);
                    else widgets.splice(i, 1);
                } catch (e) {
                    console.warn("[QG-tools] 清理旧 " + label + " DOM widget 失败：", e);
                    widgets.splice(i, 1);
                }
            }
        }
        // 文档里残留、且属于当前节点的 root（Vue 重建时可能没走 removeWidget）
        let orphans = [];
        try {
            orphans = document.querySelectorAll("." + rootClass + "[data-qg-owner-id]");
        } catch { /* 忽略 */ }
        for (const el of orphans) {
            if (el.dataset.qgOwnerId === String(node.id)) {
                try { el.remove(); } catch { /* 忽略 */ }
            }
        }
    }

    function safeMeasure(node) {
        try {
            const s = measure(node);
            if (Array.isArray(s) && s[0] > 0 && s[1] > 0
                && Number.isFinite(s[0]) && Number.isFinite(s[1])) {
                return s;
            }
        } catch (e) {
            console.warn("[QG-tools] " + label + " 尺寸量算失败，用兜底值：", e);
        }
        return FALLBACK_SIZE;
    }

    /**
     * 双击编辑：document 捕获委托 + 原生 dblclick 双通道。
     *
     * Vue 模式下节点外壳收不到可靠的 dblclick（onDblClick 根本不触发），
     * 所以自己按「两次 pointerdown 间隔」判双击。
     *
     * 🔴 三层判定，缺一不可（2026-10-22 用户反馈「Vue 模式不能编辑」）：
     *   ① `mousedown` 的 `event.detail`：浏览器已经算好的连击计数，阈值就是
     *      系统「双击速度」设置（Windows 默认 500ms，用户可调到更宽）。
     *      这是唯一「符合用户直觉」的判据。
     *   ② 自己算间隔兜底：Vue 外壳上 detail 可能恒为 1（合成/虚拟事件），
     *      此时按 `performance.now()` 差值判，阈值 800ms。
     *      🔴 原来写 450ms，实测「550ms 间隔的手慢双击」打不开 —— 而探针历来
     *      用 120ms，永远能过，所以这个 bug 一直没暴露。
     *   ③ 原生 `dblclick`：浏览器 500ms 内会派发，冒泡到 document，双保险。
     *
     * 🔴 认领判据不能只看 root 引用：Vue 重排会重建 DOM widget 的中间容器，
     *    root 可能被摘下重挂，此时 `shell.contains(state.root)` 为 false →
     *    委托永远不认领 → 双击静默失效。优先用外壳的 data-node-id 直接对
     *    节点 id，root 关系只作兜底。
     */
    function installEditDelegate(node, state) {
        let lastTap = 0;

        /** 这个外壳是不是本节点的？ */
        const mine = (shell) => {
            if (!shell) return false;
            const sid = shell.dataset?.nodeId;
            if (sid != null && String(sid) === String(node.id)) return true;
            return !!(state.root && shell.contains(state.root));
        };

        const fire = (event) => {
            lastTap = 0;
            try { event?.stopPropagation?.(); } catch { /* 忽略 */ }
            try {
                openEditor(node);
            } catch (e) {
                console.error("[QG-tools] 打开" + label + "编辑器失败：", e);
            }
        };

        const onMouseDown = (event) => {
            const t = event.target;
            if (!(t instanceof Element)) return;
            const shell = t.closest?.(".lg-node");
            if (!mine(shell)) return;
            // Pin 后：阻止拖动/框选（对齐经典模式「Pin 的标签不参与拖拽」）
            if (node.flags?.pinned) {
                event.stopPropagation();
                return;
            }
            // ① 浏览器算好的连击计数（遵循系统双击速度）
            if (event.detail >= 2) {
                fire(event);
                return;
            }
            // ② 间隔兜底
            const now = performance.now();
            if (now - lastTap < DOUBLE_TAP_MS) {
                fire(event);
                return;
            }
            lastTap = now;
        };

        const onDblClick = (event) => {
            const t = event.target;
            if (!(t instanceof Element)) return;
            if (!mine(t.closest?.(".lg-node"))) return;
            fire(event);
        };

        document.addEventListener("mousedown", onMouseDown, true);
        document.addEventListener("dblclick", onDblClick, true);
        state.editDelegate = onMouseDown;
        state.dblDelegate = onDblClick;
    }

    function mount(node) {
        let state = node.__qgLabelDom;
        // 「还在文档里」不等于「还在节点外壳里」：Vue 重排可能把 DOM widget 的
        // 中间容器整体换掉，root 被摘到别处（甚至孤零零挂在 body 上）。
        // 那种情况下必须重建，否则节点看着是空的、双击也认领不到。
        // ⚠️ 刚挂载的 800ms 内不重建：Vue 挂 DOM widget 是异步的，这期间 root
        //    必然短暂地还不在外壳里，此时重建会陷入「建了又建」。
        if (state?.root?.isConnected) {
            const settled = performance.now() - (state.mountedAt || 0) > 800;
            if (state.root.closest(".lg-node") || !settled) return state;
        }
        if (node[MOUNTING]) return state;
        node[MOUNTING] = true;
        try {
            cleanupStale(node);
        } finally {
            node[MOUNTING] = false;
        }

        const root = document.createElement("div");
        root.className = rootClass;
        root.dataset.qgOwnerId = String(node.id ?? "unknown");
        root.style.cssText = "box-sizing:border-box;width:100%;height:100%;pointer-events:none;overflow:visible;";

        state = node.__qgLabelDom = {
            node, root, widget: null,
            contentWidth: 0, contentHeight: 0,
            disposed: false,
            mountedAt: performance.now(),
        };

        const refresh = () => {
            if (state.disposed || !state.root) return;
            state.root.innerHTML = "";
            try {
                const content = build(node);
                if (content) state.root.append(content);
            } catch (e) {
                console.error("[QG-tools] " + label + " DOM 渲染出错：", e);
            }
            const [w, h] = safeMeasure(node);
            state.contentWidth = w;
            state.contentHeight = h;
            // 宽度 = 内容宽 + 固定外壳内边距，一次算到位，绝不回读布局反推
            const targetW = w + padX;
            if (Math.abs((Number(node.size[0]) || 0) - targetW) >= 1) node.size[0] = targetW;
            if (Math.abs((Number(node.size[1]) || 0) - h) >= 1) node.size[1] = h;
            const widget = state.widget;
            if (widget) {
                widget.computeSize = () => [targetW, h];
                widget.options = widget.options || {};
                widget.options.minNodeSize = [targetW, h];
            }
            // Vue 重排会重建中间容器，内联样式随之丢失 —— 每次刷新都补一遍。
            // 这里用 applyPointerPassthrough 而不是 watchPointerPassthrough：
            // 后者见到已挂的观察者就直接 return，刷新时不会重新补样式。
            applyPointerPassthrough(root);
        };
        state.refresh = refresh;

        const widget = node.addDOMWidget(widgetName, widgetType, root, {
            serialize: false,
            hideOnZoom: false,
            margin: 0,
        });
        keepDomWidgetWidthAuto(widget);
        widget.serialize = false;
        if (widget.options) widget.options.minNodeSize = [FALLBACK_SIZE[0], FALLBACK_SIZE[1]];
        state.widget = widget;

        // 属性变化时刷新（节点的 onPropertyChanged 也会调，这里再兜一层事件）
        const onProp = () => refresh();
        state.propListener = onProp;
        node.addEventListener?.("propertychange", onProp);

        installEditDelegate(node, state);
        refresh();
        watchPointerPassthrough(node, root, state);
        // Vue 是异步挂 DOM widget 的：300ms 后再补一轮穿透与尺寸
        setTimeout(() => {
            if (state.disposed || !root.isConnected) return;
            watchPointerPassthrough(node, root, state);
            refresh();
        }, 300);

        return state;
    }

    function unmount(node) {
        const state = node.__qgLabelDom;
        if (state) {
            node.__qgLabelDom = null;
            state.disposed = true;
            unwatchPointerPassthrough(state.root);
            if (state.editDelegate) {
                document.removeEventListener("mousedown", state.editDelegate, true);
                state.editDelegate = null;
            }
            if (state.dblDelegate) {
                document.removeEventListener("dblclick", state.dblDelegate, true);
                state.dblDelegate = null;
            }
            if (state.propListener) {
                node.removeEventListener?.("propertychange", state.propListener);
                state.propListener = null;
            }
            detachDomWidget(node, state.widget, state.root);
        }
        // 页面级容器上若有残留穿透（早期版本会一路写到 body/html），无条件清掉
        try { sanitizePagePassthrough(); } catch { /* 忽略 */ }
        // 切回经典模式：尺寸一律交回 canvas 的 computeSize 决定。
        // 无条件执行（不只 state 存在时）—— 尺寸可能已被 Vue 那边撑歪，
        // 这里必须拉回内容尺寸，否则节点看着像「消失了」。
        try {
            if (typeof node.computeSize === "function") {
                const s = node.computeSize();
                if (Array.isArray(s) && s[0] > 0 && s[1] > 0) {
                    node.size[0] = s[0];
                    node.size[1] = s[1];
                }
            }
        } catch (e) {
            console.warn("[QG-tools] 切回经典模式重算尺寸失败：", e);
        }
        try { node.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
    }

    function sync(node) {
        // ⚠️ 这里不做「关编辑器」——本函数在新建节点 / 加载工作流时也会被调用，
        //    在那种时机关浮层会打断正在编辑的用户。关浮层的时机由
        //    installModeWatcher 的 onRenderModeSwitch 钩子负责。
        if (vueNodesEnabled()) mount(node);
        else unmount(node);
    }

    return { mount, unmount, sync, refreshOf: (node) => node.__qgLabelDom?.refresh?.() };
}
