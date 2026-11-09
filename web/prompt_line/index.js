/**
 * QG 提示词行 —— 「从 COMBO 链接中获取值」按钮。
 *
 * 搬入说明（2026-11-08，用户确认后 1:1 搬运）
 *   来源：自有插件 ComfyUI-QG-Multipack v0.1.0 / web/qg_prompt_line.js
 *   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_PromptLine
 *
 *   只做三类必要改动，交互逻辑一行未改：
 *     1) import 路径 ../../scripts/app.js -> /scripts/app.js（本包约定：内置脚本绝对路径）；
 *     2) 按钮名与 toast 文案英化，画布文案走 zhPair 以便中文界面下是中文；
 *     3) 扩展名沿用本包前缀 QG.PromptLine。
 *
 * 功能：节点添加时挂一个按钮，点击后找到本节点 COMBO 输出口接的下游节点，
 * 取它那个 combo 下拉控件的全部可选值，逐行写回文本控件，免去手动抄选项。
 * 规格对齐 ComfyUI-Easy-Use「提示词行」的前端部分（ComfyUI-Easy-Use-Frontend
 * src/extensions/widget.js 里 easy promptLine 分支）。
 *
 * 与参考的有意差异：参考在下游输入口不是下拉控件时直接抛 TypeError
 * （`input.widget.name` 无防护），这里改成 toast 提示。
 *
 * 后端节点：nodes/qg_prompt_line.py。改本文件只需 F5 刷新页面。
 */
import { app } from "/scripts/app.js";
import { zhPair } from "../shared/zh.mjs?v=2026110904";

const TYPE = "QG_PromptLine";

// 画布按钮名与标题不在词典里（词典只覆盖 nodeDefs 的 ui 段），必须自己 zhPair。
const LABEL_FILL = () => zhPair("Fill from combo link", "从 COMBO 链接中获取值");
const TITLE = () => zhPair("Prompt Line", "提示词行");

/** 找不到 COMBO 连线或下游没有可抄的下拉时弹的警告（与包内其他模块同款）。 */
function toastError(detail) {
    app.extensionManager?.toast?.add?.({
        severity: "error",
        summary: TITLE(),
        detail,
        life: 3000,
    });
}

app.registerExtension({
    name: "QG.PromptLine",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TYPE) return;

        const onAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = async function () {
            onAdded?.apply(this, arguments);
            const prompt_widget = this.widgets.find((w) => w.name === "prompt");
            this.addWidget(
                "button",
                LABEL_FILL(),
                "",
                () => {
                    // 与参考一致：只看 COMBO 口（第 2 个输出口）的第一条连线
                    const output_link =
                        this.outputs[1]?.links?.length > 0
                            ? this.outputs[1].links[0]
                            : null;
                    const all_nodes = app.graph._nodes;
                    const node = all_nodes.find((cate) =>
                        cate.inputs?.find((input) => input.link == output_link));
                    if (!output_link || !node) {
                        toastError(zhPair("No COMBO link found",
                                          "没有找到 COMBO 连接"));
                        return;
                    }
                    const input = node.inputs.find(
                        (input) => input.link == output_link);
                    const widget = input.widget
                        ? node.widgets.find(
                              (cate) => cate.name == input.widget.name)
                        : null;
                    const values = widget?.options?.values || null;
                    if (values) {
                        prompt_widget.value = values.join("\n");
                    } else {
                        toastError(zhPair(
                            "That input on the downstream node has no dropdown options to copy",
                            "下游节点的这个输入口没有可获取的下拉选项"));
                    }
                },
                { serialize: false }
            );
        };
    },
});
