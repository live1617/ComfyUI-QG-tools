/**
 * QG 尺寸选择器 —— 老工作流的「比例」搬家（前端）
 *
 * v0.9.4 之前「比例」是**自由文本**（STRING），用户直接往里填 16:9 / 2.39:1。
 * 现在改成了真正的下拉（COMBO：「无 / 采用比例 / 1:1 / …」），任意比例挪到
 * 新增的「自定义比例」（ratio_custom，排在控件末尾，不会顶掉老存档的值）。
 *
 * LiteGraph 的 configure() 按**位置**塞 widgets_values。老存档 8 个值：
 *   [preset, batch_size, long_edge, ratio, frames, factor, latent_channels, mp]
 * 新的第 9 个 ratio_custom 缺席时取默认空串，前面一格格都对得上 —— 唯一的
 * 麻烦是 ratio 那格可能存着 `2.39:1` 这种**不在下拉选项里**的值：LiteGraph
 * 会照收，但提交时后端校验 COMBO 成员会直接报错。
 *
 * 所以这里把它接住：值不在选项里就搬到 ratio_custom，下拉回「无」。
 * 判据很硬 —— 新存档的 ratio 只可能是选项里的那几条。
 */

import { app } from "/scripts/app.js";
import { chainCallback } from "../shared/index.mjs?v=2026102571";

const NODE_CLASS = "QG_SizeSelector";

app.registerExtension({
    name: "QG.SizeSelector",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS) return;

        const ratioSpec =
            nodeData?.input?.required?.ratio ?? nodeData?.input?.optional?.ratio;
        const RATIOS = Array.isArray(ratioSpec?.[0]) ? ratioSpec[0] : [];

        chainCallback(nodeType.prototype, "onConfigure", function (info) {
            const saved = info?.widgets_values;
            if (!Array.isArray(saved) || !RATIOS.length) return;

            const widgets = this.widgets || [];
            const ratioW = widgets.find((w) => w?.name === "ratio");
            const customW = widgets.find((w) => w?.name === "ratio_custom");
            if (!ratioW || !customW) return;

            const value = String(ratioW.value ?? "").trim();
            if (!value || value === "无" || RATIOS.includes(value)) return;
            if (String(customW.value ?? "").trim()) return; // 已经是新存档，别再动

            customW.value = value;
            ratioW.value = "无";
            this.setDirtyCanvas?.(true, true);
            console.info(
                `[QG-tools] 尺寸选择器中检测到老存档的自定义比例「${value}」，` +
                    `已迁移到「自定义比例」`
            );
        });
    },
});
