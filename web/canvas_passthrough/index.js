// -*- coding: utf-8 -*-
// 全局接线：指针落在本插件任何一块 DOM 面板上时，滚轮仍然缩放画布。
//
// 为什么必须有这一层：面板是盖在画布上的 <div>，litegraph 只听自己 <canvas>
// 上的 wheel。指针一进面板，事件链就断在那里 —— 每块面板都变成一个滚轮死区。
//
// 为什么挂在 window 上、而不是逐个面板去接：
//   * 本插件有十几块面板，逐个接必然漏，以后新加面板还会漏。
//   * 面板里还会再套一层自己的滚轮语义（遮罩编辑器的 stage 缩放、裁剪编辑器的
//     canvas 缩放、列表滚动、多行文本框），逐层判断「这一层要不要让」会越写越乱。
//
// 让它自己让：监听走**冒泡**，凡是面板内部先把 wheel 用掉的（preventDefault
// 或 stopPropagation），事件要么到不了这里，要么到这里时 defaultPrevented
// 已是 true —— 我们据此放行，不需要维护「谁有资格要滚轮」的名单。
//
// 只认带 qgtools- 前缀的面板根（shared/canvas_passthrough.mjs 的 panelRoot）。
// 挂在 body 上的浮层（选择器、设置菜单、帮助卡）不算：在浮层里缩放画布没有意义。

import { app } from "/scripts/app.js";
import {
    panelHost,
    panelKeepsWheel,
    panelRoot,
} from "../shared/canvas_passthrough.mjs?v=2026110820";

const MARK = "__QG_PANEL_WHEEL__";

// 一个页面只装一次。ComfyUI 切换 Nodes 2.0 时会重新 setup 扩展，
// 那时候旧监听还在，重复安装会让一格滚轮缩放两次。
function installOnce(handler) {
    if (globalThis[MARK]) return false;
    globalThis[MARK] = true;
    window.addEventListener("wheel", handler, { passive: false });
    return true;
}

function toGraph(event) {
    // 面板内部已经用掉了这一格（编辑器缩放、列表滚动、文本框）。
    if (event.defaultPrevented) return;

    const target = event.target;
    if (!target?.closest) return;

    const root = panelRoot(target);
    if (!root) return;                       // 不是本插件的面板，原样放行

    const view = app.canvas;
    if (typeof view?.processMouseWheel !== "function") return;

    // 面板自己还能滚（长列表、可滚动的说明区）时，滚轮属于面板。
    const keeps = panelKeepsWheel(target, event, {
        root,
        host: panelHost(target),
        styleOf: (element) => getComputedStyle(element),
        activeElement: document.activeElement,
    });
    if (keeps) return;

    if (typeof event.preventDefault === "function") event.preventDefault();
    view.processMouseWheel(event);
}

app.registerExtension({
    name: "QG.CanvasPassthrough",
    async setup() {
        const installed = installOnce(toGraph);
        // 探针/排障标记：这次 setup 是新装的，还是已经装过了
        // （见 tools/_probe_panel_wheel.cjs）。
        globalThis.__QG_PANEL_WHEEL_READY__ = installed;
    },
});
