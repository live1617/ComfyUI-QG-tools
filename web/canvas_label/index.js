// 画布标签 / Markdown 便签 —— 两个纯前端虚拟节点。
//
// 共用一套编辑面板（浮动工具条 / 居中预览弹窗）与画布绘制接管，绘制引擎与
// 面板实现都在 shared/ 下，这里只负责注册和右键菜单。
//
// ⚠️ 两个节点必须共用本入口。label_common 的绘制接管靠模块私有的 labelClasses
//    + 原型守卫；拆成两个入口各自 import，一旦 ?v= 版本串不一致就会出现两份
//    模块实例 → 后注册的那个节点不走自定义绘制，静默退化成默认外观且不报错。
import { app } from "/scripts/app.js";
import { zh } from "../shared/zh.mjs?v=2026102002";
import { QGCanvasLabel } from "../shared/canvas_label_node.mjs?v=2026102002";
import { QGMarkdownNote, openMarkdownEditor } from "../shared/markdown_node.mjs?v=2026102002";
import { openLabelEditor, registerLabelCanvasHooks } from "../shared/label_common.mjs?v=2026102002";

const TYPES = [
    ["QG_CanvasLabel", QGCanvasLabel],
    ["QG_MarkdownNote", QGMarkdownNote],
];

// 开发版用过这两个中文类型名，老工作流里存的就是它们。只在这里补注册，
// 不写进 Python 映射，所以「添加节点」菜单里不会重复出现。
const LEGACY_TYPES = [
    ["画布标签", QGCanvasLabel],
    ["Markdown 文本", QGMarkdownNote],
];

function registerAll() {
    // ⚠️ 顺序要紧：registerNodeType 会把 cls.type 写成「最后一次注册用的名字」。
    // 旧类型名必须先注册，让 QG_ 前缀的名字留在最后，否则节点存盘时 type 会写成中文旧名。
    for (const [type, cls] of LEGACY_TYPES) LiteGraph.registerNodeType(type, cls);
    for (const [type, cls] of TYPES) LiteGraph.registerNodeType(type, cls);
    // 同一个类被注册两次后 litegraph 会把 category 清掉，这里重新钉住
    for (const [, cls] of TYPES) cls.category = "QG-tools/标注";
}

app.registerExtension({
    name: "QG.CanvasLabel",
    registerCustomNodes() {
        registerAll();
        registerLabelCanvasHooks([QGCanvasLabel, QGMarkdownNote]);
    },
    // 兜底：后端同名通用类可能在前端把类型覆盖掉，所以 setup 与「下一帧」各再来一次
    setup() {
        registerAll();
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(registerAll);
        }
    },
    getNodeMenuItems(node) {
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
