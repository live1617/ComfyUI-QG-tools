// -*- coding: utf-8 -*-
// QG 存在判断（Exists）前端扩展 —— 让输入口那个「任意」跟着上游变成
// 「图像 / 遮罩 / 潜空间 …」，一眼看得出这一路到底在判什么。
//
// 🔴 只改 label，绝不碰 slot.name / slot.type：
//   · name 是存档键和后端参数名，改了等于换接口；
//   · type 必须保持 "*"，线才能接任何类型。孤海那版把 type 改成真实类型，
//     接完图像就再也接不了遮罩，想换类型必须先断线（11-12 对比结论）。
// 断线后标签自动回到「任意」，节点不往存档里写任何东西。
//
// 显示只在画布层：后端判定逻辑与 `any_input` 这个参数名完全不知道标签存在。

import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=2026111208";

const NODE_TYPE = "QG_Exists";
const INPUT_NAME = "any_input";

// 槽位显示名：[英文, 中文]。同形词（CLIP / VAE）不列，回落类型名本身。
// 🔴 与 web/any_switch/index.js 的 LABELS 同源，新增类型时两处一起加。
const LABELS = {
    IMAGE: ["image", "图像"],
    MASK: ["mask", "遮罩"],
    LATENT: ["latent", "潜空间"],
    CONDITIONING: ["conditioning", "条件"],
    STRING: ["string", "文本"],
    INT: ["int", "整数"],
    FLOAT: ["float", "浮点"],
    BOOLEAN: ["boolean", "布尔"],
    MODEL: ["model", "模型"],
    AUDIO: ["audio", "音频"],
    VIDEO: ["video", "视频"],
    SEGS: ["segs", "分割"],
    TENSOR: ["tensor", "张量"],
    LIST: ["list", "列表"],
    UPSCALE_MODEL: ["upscale model", "放大模型"],
    CONTROL_NET: ["control net", "控制网络"],
};

// 顶层求值会被定稿成英文（注册期 app.i18n 还没建好），所以包成函数、调用时再算。
const anyLabel = () => zhPair("any", "任意");

function normalizeType(raw) {
    if (Array.isArray(raw)) {
        const list = raw
            .map((item) => String(item || "").toUpperCase())
            .filter((item) => item && item !== "*" && item !== "ANY");
        // 多类型（V3 的联合类型）说不清是哪一种，显示「任意」比挑一个更诚实。
        return list.length === 1 ? list[0] : "ANY";
    }
    const text = String(raw || "").toUpperCase();
    return text && text !== "*" && text !== "ANY" ? text : "ANY";
}

function labelFor(type) {
    if (!type || type === "ANY") return anyLabel();
    const pair = LABELS[type];
    return pair ? zhPair(pair[0], pair[1]) : type;
}

/** 这一路接的是什么类型；没接线或上游也是通配时返回 "ANY"。 */
function linkedType(node) {
    const index = (node.inputs || []).findIndex((slot) => slot.name === INPUT_NAME);
    if (index < 0) return "ANY";
    const slot = node.inputs[index];
    if (slot?.link == null) return "ANY";

    let link = null;
    try {
        // 1.58.5 的官方入口；老版本没有就退回直接读 graph.links。
        link = node.getInputLink?.(index) || null;
    } catch (_) { /* 老版本没有这个方法 */ }
    if (!link) {
        const links = node.graph?.links;
        link = (links instanceof Map ? links.get(slot.link) : links?.[slot.link]) || null;
    }
    if (!link) return "ANY";

    // link.type 是 1.5x 起就带的字段，节点被删了也还在；取不到再回查上游输出槽。
    const fromLink = normalizeType(link.type);
    if (fromLink !== "ANY") return fromLink;
    const origin = node.graph?.getNodeById?.(link.origin_id);
    return normalizeType(origin?.outputs?.[link.origin_slot]?.type);
}

function applyLabels(node) {
    if (!node || node.type !== NODE_TYPE) return;
    const text = labelFor(linkedType(node));
    const input = (node.inputs || []).find((slot) => slot.name === INPUT_NAME);
    if (input && input.label !== text) input.label = text;
    // 输出透传的是同一个值，标签跟着改；它的 type 仍是 "*"，接什么端口都行。
    const output = node.outputs?.[0];
    if (output && output.label !== text) output.label = text;
    try {
        node.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
    } catch (_) { /* 画布还没建好 */ }
}

function scheduleSync(node) {
    if (!node || node.type !== NODE_TYPE) return;
    if (node.__qgExistsSyncScheduled) return;
    node.__qgExistsSyncScheduled = true;
    // 连线信息在 onConnectionsChange 触发时可能还没写进 graph.links，补一帧再读；
    // Nodes 2.0 下画布是异步布局的，这一帧同样把首次渲染兜住。
    requestAnimationFrame(() => {
        node.__qgExistsSyncScheduled = false;
        applyLabels(node);
    });
}

app.registerExtension({
    name: "QG.Exists",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            originalCreated?.apply(this, arguments);
            scheduleSync(this);
        };

        const originalConnections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            originalConnections?.apply(this, arguments);
            scheduleSync(this);
        };

        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            originalConfigure?.apply(this, arguments);
            scheduleSync(this);
        };
    },
});

export { applyLabels, linkedType };
