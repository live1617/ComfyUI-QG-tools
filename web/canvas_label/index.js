// 画布标签 / Markdown 便签 —— 两个纯前端虚拟节点。
//
// 共用一套编辑面板（浮动工具条 / 居中预览弹窗）与画布绘制接管，绘制引擎与
// 面板实现都在 shared/ 下，这里只负责注册、老存档类型名迁移和右键菜单。
//
// ⚠️ 两个节点必须共用本入口。label_common 的绘制接管靠模块私有的 labelClasses
//    + 原型守卫；拆成两个入口各自 import，一旦 ?v= 版本串不一致就会出现两份
//    模块实例 → 后注册的那个节点不走自定义绘制，静默退化成默认外观且不报错。
import { app } from "/scripts/app.js";
import { zh } from "../shared/zh.mjs?v=2026102319";
import { QGCanvasLabel } from "../shared/canvas_label_node.mjs?v=2026102319";
import { QGMarkdownNote, openMarkdownEditor } from "../shared/markdown_node.mjs?v=2026102319";
import { openLabelEditor, registerLabelCanvasHooks, killStaleFloating } from "../shared/label_common.mjs?v=2026102319";
import {
    clearPointerPassthrough,
    installModeWatcher,
    onRenderModeSwitch,
    sanitizePagePassthrough,
    unwatchPointerPassthrough,
    vueNodesEnabled,
    watchPointerPassthrough,
} from "../shared/vue_mode.mjs?v=2026102319";
import { syncCanvasLabelMode } from "../shared/canvas_label_dom.mjs?v=2026102319";
import { syncMarkdownNoteMode } from "../shared/markdown_dom.mjs?v=2026102319";

const TYPES = [
    ["QG_CanvasLabel", QGCanvasLabel],
    ["QG_MarkdownNote", QGMarkdownNote],
];

// 开发版用过这两个中文类型名，老工作流里存的就是它们。
// 以前是「再注册一遍旧名」来兼容，但那会让新版搜索面板多出两条「仅前端」的重复项
// （旧版 litegraph 菜单只列服务器定义，所以那时候看着没问题）。现在改成
// **加载工作流时把旧 type 改写成新名**，既不重复，老存档也照样能开。
const LEGACY_TYPE_MAP = {
    "画布标签": "QG_CanvasLabel",
    "Markdown 文本": "QG_MarkdownNote",
};

function registerAll() {
    if (registerAll.__done) return;
    registerAll.__done = true;
    for (const [type, cls] of TYPES) LiteGraph.registerNodeType(type, cls);
    // 注册后 litegraph 可能改写 category，这里重新钉住
    for (const [, cls] of TYPES) cls.category = "QG-tools/标注";
}

function isCanvasLabel(node) {
    if (!node) return false;
    return node.type === "QG_CanvasLabel" || node.comfyClass === "QG_CanvasLabel"
        || node.type === "画布标签";
}

function isMarkdownNote(node) {
    if (!node) return false;
    return node.type === "QG_MarkdownNote" || node.comfyClass === "QG_MarkdownNote"
        || node.type === "Markdown 文本";
}

/** 两个标签类节点（共用编辑面板与绘制接管），也是「有 Vue DOM 分支」的节点集合。 */
function isLabelNode(node) {
    return isCanvasLabel(node) || isMarkdownNote(node);
}

/** 只补挂迁移入口，不立刻迁移（给 watcher 的兜底用）。 */
function repairCanvasLabelSync(node) {
    if (typeof node?.__qgSyncMode === "function") return node.__qgSyncMode;
    if (isCanvasLabel(node)) {
        node.__qgSyncMode = () => syncCanvasLabelMode(node);
        return node.__qgSyncMode;
    }
    if (isMarkdownNote(node)) {
        node.__qgSyncMode = () => syncMarkdownNoteMode(node);
        return node.__qgSyncMode;
    }
    return null;
}

function ensureCanvasLabelSync(node) {
    const fn = repairCanvasLabelSync(node);
    if (fn && !node.__qgLabelSyncedOnce) {
        node.__qgLabelSyncedOnce = true;
        fn();
    }
    return fn;
}

function hookGraph(graph) {
    if (!graph || graph.__qgCanvasLabelHooked) return;
    graph.__qgCanvasLabelHooked = true;
    const orig = graph.onNodeAdded;
    graph.onNodeAdded = function (node) {
        ensureCanvasLabelSync(node);
        return orig?.apply?.(this, arguments);
    };
    // 已存在的节点也补挂
    for (const n of graph._nodes ?? []) ensureCanvasLabelSync(n);
}

/**
 * 控制台诊断入口：出问题时在控制台敲 __qgDiag() 就能看到模式值、每个节点的
 * 迁移入口 / DOM 状态 / 残留数量。
 */
function installDiagnostics() {
    if (window.__qgDiagInstalled) return;
    window.__qgDiagInstalled = true;
    window.__qgErrs = window.__qgErrs || [];
    try {
        window.addEventListener("error", (e) => {
            window.__qgErrs.push(String(e.message || e).slice(0, 240));
            if (window.__qgErrs.length > 30) window.__qgErrs.shift();
        });
        const origErr = console.error;
        console.error = function (...args) {
            window.__qgErrs.push(args.map((a) => String(a)).join(" ").slice(0, 240));
            if (window.__qgErrs.length > 30) window.__qgErrs.shift();
            return origErr.apply(console, args);
        };
    } catch { /* 忽略 */ }

    window.__qgDiag = function () {
        const nodes = (app.graph?._nodes ?? []).filter(isLabelNode);
        let vue = null, vueAlt = null;
        try { vue = app.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled"); } catch { /* 忽略 */ }
        try { vueAlt = app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled"); } catch { /* 忽略 */ }
        // 当前前端里所有含 Vue 的设置项 ID —— 用来确认开关 ID 有没有改名
        let settingIds = [];
        try {
            const bag = app.ui?.settings?.settingsLookup
                ?? app.ui?.settings?.settings
                ?? app.extensionManager?.setting?.settings;
            const keys = bag instanceof Map ? [...bag.keys()]
                : bag && typeof bag === "object" ? Object.keys(bag) : [];
            settingIds = keys.filter((k) => /vue/i.test(k));
        } catch { /* 忽略 */ }
        return {
            vue,
            vueAlt,
            settingIds,
            watcherRunning: Boolean(installModeWatcher.__timer),
            nodeCount: nodes.length,
            nodes: nodes.map((n) => {
                const st = n.__qgLabelDom;
                const shell = st?.root?.closest?.(".lg-node") ?? null;
                return {
                    id: n.id,
                    kind: isMarkdownNote(n) ? "md" : "label",
                    hasSync: typeof n.__qgSyncMode === "function",
                    hasDomState: Boolean(st),
                    rootConnected: Boolean(st?.root?.isConnected),
                    // —— 编辑链路三件套：任何一项为 false，双击都不可能打开编辑器 ——
                    hasDelegate: Boolean(st?.editDelegate),
                    hasDbl: Boolean(st?.dblDelegate),
                    rootInShell: Boolean(shell),
                    shellNodeId: shell?.dataset?.nodeId ?? null,
                    pinned: Boolean(n.flags?.pinned),
                    domWidgets: (n.widgets ?? []).filter(
                        (w) => w.name === "qg_canvas_label_dom" || w.name === "qg_markdown_note_dom").length,
                    size: n.size ? [...n.size].map((v) => Math.round(v)) : null,
                    pos: n.pos ? [...n.pos].map((v) => Math.round(v)) : null,
                    // 尺寸异常时最需要看的就是这几项：到底是标题长、字号大，还是量算坏了
                    title: String(n.title ?? "").slice(0, 60),
                    titleLen: String(n.title ?? "").length,
                    fontSize: n.properties?.fontSize,
                    fontFamily: n.properties?.fontFamily,
                    padding: n.properties?.padding,
                    contentWidth: st?.contentWidth ?? null,
                    contentHeight: st?.contentHeight ?? null,
                    measured: (() => {
                        try {
                            const s = typeof n.computeSize === "function" ? n.computeSize() : null;
                            return Array.isArray(s) ? [...s].map((v) => Math.round(v)) : null;
                        } catch { return null; }
                    })(),
                };
            }),
            domInDoc: document.querySelectorAll(".qgtools-label-dom, .qgtools-md-dom").length,
            wfTabs: document.querySelectorAll(".workflow-tab").length,
            errs: (window.__qgErrs ?? []).slice(-8),
        };
    };
    // 控制台里对象会被折叠，这个直接给可复制的字符串
    window.__qgDiagText = () => JSON.stringify(window.__qgDiag(), null, 1);

    // 现场急救：把标签节点的尺寸拉回 computeSize 的结果，并顺带汇报属性，
    // 一次调用就能区分「字号被设太大」和「量算坏了」。
    window.__qgFix = function () {
        const out = [];
        for (const n of (app.graph?._nodes ?? []).filter(isLabelNode)) {
            const p = n.properties || {};
            const rec = {
                id: n.id,
                title: String(n.title ?? "").slice(0, 40),
                titleLen: String(n.title ?? "").length,
                fontSize: p.fontSize,
                fontFamily: p.fontFamily,
                padding: p.padding,
            };
            try {
                const s = typeof n.computeSize === "function" ? n.computeSize() : null;
                if (Array.isArray(s) && s[0] > 0 && s[1] > 0) {
                    n.size[0] = s[0];
                    n.size[1] = s[1];
                }
                rec.size = n.size.map((v) => Math.round(v));
            } catch (e) {
                rec.error = String(e).slice(0, 120);
            }
            out.push(rec);
        }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
        return out;
    };

    // 字号被误设成几百时，把属性重置成默认值（标题不动）。
    // 若节点因此落在视野外，顺便挪回画布中心。
    window.__qgResetStyle = function (ids) {
        const targets = new Set((ids ?? []).map(String));
        const out = [];
        const v = app.canvas?.visible_area;
        for (const n of (app.graph?._nodes ?? []).filter(isLabelNode)) {
            if (targets.size && !targets.has(String(n.id))) continue;
            n.properties = Object.assign({}, n.properties, {
                fontSize: 20,
                padding: 0,
                borderRadius: 0,
                angle: 0,
                bold: false,
                italic: false,
            });
            try {
                const s = n.computeSize?.();
                if (Array.isArray(s) && s[0] > 0 && s[1] > 0) {
                    n.size[0] = s[0];
                    n.size[1] = s[1];
                }
            } catch { /* 忽略 */ }
            const rec = { id: n.id, size: n.size.map((x) => Math.round(x)) };
            // 完全在视野外就挪到中心，省得用户还得按「适应视图」找
            if (v && v.length >= 4) {
                const [vx, vy, vw, vh] = v;
                const inside = n.pos[0] + n.size[0] > vx && n.pos[0] < vx + vw
                    && n.pos[1] + n.size[1] > vy && n.pos[1] < vy + vh;
                if (!inside) {
                    n.pos[0] = Math.round(vx + vw / 2 - n.size[0] / 2);
                    n.pos[1] = Math.round(vy + vh / 2 - n.size[1] / 2);
                    rec.movedTo = [Math.round(n.pos[0]), Math.round(n.pos[1])];
                }
            }
            n.__qgLabelDom?.refresh?.();
            out.push(rec);
        }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
        return out;
    };

    /**
     * 现场自救：解开「整页点不动」。
     *
     * 症状：画布滚轮不缩放、顶部按钮点不了、节点拖不走，但界面看起来完全正常。
     * 成因有两类，这里一起清：
     *   ① 编辑器的全屏透明遮罩 / 浮层没被关掉（position:fixed;inset:0;z-index:10000）
     *   ② 指针穿透被写到页面级容器上（body / html / #graph-canvas-container
     *      残留 pointer-events:none）—— 早期版本切渲染模式时会这样。
     *
     * 用户不必强刷页面，控制台敲 __qgClean() 即可。
     */
    window.__qgClean = function () {
        let floating = 0, passthrough = 0, page = 0, remounted = 0;
        try { floating = killStaleFloating(); } catch { /* 忽略 */ }
        try { passthrough = clearPointerPassthrough(); } catch { /* 忽略 */ }
        try { page = sanitizePagePassthrough(); } catch { /* 忽略 */ }
        // 🔴 清完必须把仍存活的标签 DOM 的穿透补回来：
        //    上面是「全量清除」，连正常在用的节点也一起还原了，
        //    不重建的话用户敲完这条命令就会发现节点拖不动了。
        const vue = (() => { try { return vueNodesEnabled(); } catch { return false; } })();
        for (const n of (app.graph?._nodes ?? [])) {
            const state = n?.__qgLabelDom;
            if (!state?.root?.isConnected) continue;
            try {
                unwatchPointerPassthrough(state.root); // 先断旧观察者并还原
                if (vue) {
                    watchPointerPassthrough(n, state.root, state);
                    remounted++;
                }
            } catch (e) { console.warn("[QG-tools] 重建穿透失败：", e); }
        }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch { /* 忽略 */ }
        const out = { floating, passthrough, page, remounted };
        console.info("[QG-tools] __qgClean 完成：", out);
        return out;
    };

    /**
     * 终极兜底：绕过所有交互判据，直接打开某个节点的编辑器。
     *
     * 用来区分两类故障，一次调用就能定死：
     *   - 打开了 → 编辑器本身没问题，是「双击/右键没传到」的交互问题
     *     （看 __qgDiag() 里的 hasDelegate / rootInShell / shellNodeId）
     *   - 打不开 → 编辑器自身的问题（看控制台报错）
     *
     * 用法：__qgEdit()          打开第一个标签节点
     *      __qgEdit(36)        打开指定 id
     */
    window.__qgEdit = function (id) {
        const list = (app.graph?._nodes ?? []).filter(isLabelNode);
        const node = id === undefined || id === null
            ? list[0]
            : list.find((n) => String(n.id) === String(id));
        if (!node) return { ok: false, error: "找不到节点", available: list.map((n) => String(n.id)) };
        try {
            if (isMarkdownNote(node)) openMarkdownEditor(node);
            else openLabelEditor(node, { placeholder: "标签文字（多行）" });
            return { ok: true, id: String(node.id), kind: isMarkdownNote(node) ? "md" : "label" };
        } catch (e) {
            return { ok: false, id: String(node.id), error: String(e).slice(0, 200) };
        }
    };

    /** 一句话体检：现在这个坐标上最上层是谁（整页死掉时它会告诉你罪魁祸首）。 */
    window.__qgWho = function (x, y) {        const e = document.elementFromPoint(
            x ?? (window.innerWidth / 2), y ?? (window.innerHeight / 2));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
            tag: e.tagName,
            id: e.id || null,
            cls: e.className ? String(e.className).slice(0, 90) : null,
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            pe: getComputedStyle(e).pointerEvents,
            z: getComputedStyle(e).zIndex,
        };
    };
}

/** 把存档里的旧类型名改成现名（原地改 graphData）。返回改了几个。 */function remapLegacyTypes(graphData) {
    const nodes = graphData?.nodes;
    if (!Array.isArray(nodes)) return 0;
    let hit = 0;
    for (const node of nodes) {
        const next = LEGACY_TYPE_MAP[node?.type];
        if (next) {
            node.type = next;
            hit++;
        }
    }
    return hit;
}

app.registerExtension({
    name: "QG.CanvasLabel",
    // 赶在 litegraph 按类型建节点之前改名，旧工作流不会变成红叉
    beforeConfigureGraph(graphData, missingNodeTypes) {
        const hit = remapLegacyTypes(graphData);
        if (hit) {
            console.info("[QG-tools] 画布标签 / Markdown 便签：%d 个节点用了旧类型名，已改成现名", hit);
            // 缺失清单如果已经按旧名算过，把已映射掉的那几条去掉
            if (Array.isArray(missingNodeTypes)) {
                for (let i = missingNodeTypes.length - 1; i >= 0; i--) {
                    const name = missingNodeTypes[i];
                    if (typeof name === "string" && LEGACY_TYPE_MAP[name]) missingNodeTypes.splice(i, 1);
                }
            }
        }
    },
    registerCustomNodes() {
        registerAll();
        registerLabelCanvasHooks([QGCanvasLabel, QGMarkdownNote]);
    },
    // 节点创建后（含 Vue 模式）挂上模式迁移入口
    nodeCreated(node) {
        ensureCanvasLabelSync(node);
    },
    // 兜底：后端同名通用类可能在前端把类型覆盖掉，所以 setup 与「下一帧」各再来一次
    setup() {
        registerAll();
        // 切渲染模式时收掉编辑浮层：浮层按旧模式的定位基准摆放，切完必然错位；
        // 弹窗遮罩还是全屏透明层，残留一份就会让整页点不动。
        onRenderModeSwitch(() => { try { killStaleFloating(); } catch { /* 忽略 */ } });
        // fallback：节点上 __qgSyncMode 丢了也能现场补挂，否则切模式时静默跳过
        installModeWatcher(repairCanvasLabelSync);
        hookGraph(app.graph);
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(registerAll);
        }
        installDiagnostics();
    },
    getNodeMenuItems(node) {
        // 老类型名保留判断：工作流迁移后节点类型已是 QG_*，但用户手动建的老节点
        // 在改名之前右键也得能用。
        if (node.comfyClass === "QG_CanvasLabel" || node.comfyClass === "画布标签") {
            return [{
                content: zh("Edit label…"),
                callback: () => openLabelEditor(node, { placeholder: "标签文字（多行）" }),
            }];
        }
        if (node.comfyClass === "QG_MarkdownNote" || node.comfyClass === "Markdown 文本") {
            return [{
                content: zh("Edit text…"),
                callback: () => openMarkdownEditor(node),
            }];
        }
        return [];
    },
});
