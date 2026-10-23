/**
 * ComfyUI-QG-tools 前端扩展入口
 *
 * 除了打一条启动日志，还负责一件全局的事：把各节点的默认宽度钉成一致
 * （ComfyUI 的默认宽度由前端按控件类型算，带多行文本框的会被撑宽，
 *  Python 侧没法声明，见 shared/node_width.mjs）。
 *
 * 路径约定：
 *   - 节点自带的界面脚本放 web/<节点名>/index.js，会被 ComfyUI 自动当扩展加载。
 *   - 被 import 的共享模块一律用 .mjs，这样 ComfyUI 不会把它们当独立扩展加载。
 *   - 引用 ComfyUI 内置脚本一律用绝对路径 "/scripts/app.js"。
 *     不要用相对路径：web/ 根下的文件和 web/子目录/ 下的文件层级不同，
 *     "../../scripts/app.js" 只在根目录下成立，换个层级就错了。
 */

import { app } from "/scripts/app.js";
import { pinNodeWidth } from "./shared/node_width.mjs?v=2026102319";

app.registerExtension({
    name: "QG.tools.init",
    beforeRegisterNodeDef(nodeType, nodeData) {
        pinNodeWidth(nodeType, nodeData);
    },
    async setup() {
        console.log(
            "%c[QG-tools] 前端扩展已加载",
            "color:#4ade80;font-weight:bold"
        );
    },
});
