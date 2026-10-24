/**
 * ComfyUI-QG-tools 前端扩展入口
 *
 * 除了打一条启动日志，还负责两件全局的事：
 *   1. 把各节点的默认宽度钉成一致（ComfyUI 的默认宽度由前端按控件类型算，
 *      带多行文本框的会被撑宽，Python 侧没法声明，见 shared/node_width.mjs）。
 *   2. 中文界面下把「添加节点」菜单里的分类名换成中文（经典画布不查官方
 *      nodeCategories，见 shared/category_zh.mjs）。
 *
 * 路径约定：
 *   - 节点自带的界面脚本放 web/<节点名>/index.js，会被 ComfyUI 自动当扩展加载。
 *   - 被 import 的共享模块一律用 .mjs，这样 ComfyUI 不会把它们当独立扩展加载。
 *   - 引用 ComfyUI 内置脚本一律用绝对路径 "/scripts/app.js"。
 *     不要用相对路径：web/ 根下的文件和 web/子目录/ 下的文件层级不同，
 *     "../../scripts/app.js" 只在根目录下成立，换个层级就错了。
 */

import { app } from "/scripts/app.js";
import { chainCallback } from "./shared/index.mjs?v=2026102418";
import { pinNodeWidth } from "./shared/node_width.mjs?v=2026102418";
import { installComboZh } from "./shared/combo_zh.mjs?v=2026102418";
import { applyCategoryNames, installCategoryNames } from "./shared/category_zh.mjs?v=2026102418";

app.registerExtension({
    name: "QG.tools.init",
    beforeRegisterNodeDef(nodeType, nodeData) {
        pinNodeWidth(nodeType, nodeData);
        // 下拉选项的中文标签 + 老存档中文值迁移（见 shared/combo_zh.mjs）
        installComboZh(nodeType, nodeData);
    },
    async setup() {
        // 分类名要在节点注册完之后才改得动。先改现有注册表，再包住 registerNodeType
        // 兜住「本扩展之后才注册」的节点（扩展的 setup 是逐个跑的）。开菜单前再补一次
        // 兜底：万一是别的途径直接写了 category。
        const changed = installCategoryNames(globalThis.LiteGraph);
        const proto = globalThis.LiteGraph?.LGraphCanvas?.prototype;
        if (proto) {
            chainCallback(proto, "getCanvasMenuOptions", () => {
                applyCategoryNames(globalThis.LiteGraph);
            });
        }
        // 探针/排障标记：改了哪些、这次 setup 改了几条（见 tools/probe_category_zh.cjs）
        globalThis.__QG_CATEGORY_ZH__ = { setup: changed };

        console.log(
            "%c[QG-tools] 前端扩展已加载",
            "color:#4ade80;font-weight:bold"
        );
        if (changed) {
            console.log(
                "[QG-tools] 中文界面：%d 个节点的菜单分类已改为中文",
                changed
            );
        }
    },
});
