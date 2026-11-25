// QG_MaskCrop —— 控件顺序迁移。
//
// 2026-11-23 按用户要求把输入顺序对齐孤海「遮罩裁剪V2」：
//   旧：[size_mode, custom_width, custom_height, multiple, pad_top, pad_right, pad_bottom, pad_left, fill_holes, fill]
//   新：[fill_holes, pad_top, pad_bottom, pad_left, pad_right, size_mode, custom_width, custom_height, multiple, fill]
//
// 🔴 widgets_values 是按**数组下标**存的，改顺序后老工作流加载会把值填到错误的
//    控件上（实测：size_mode="custom" 会落进 fill_holes，pad_top 拿到 1024）。
//    这里在 onConfigure 里识别旧布局并重排，老存档打开即是正确值。
//
// 识别旧布局的判据：数组首位是字符串（旧第 0 位是 size_mode 的 COMBO 值）。
// 新布局第 0 位是 fill_holes（布尔），所以这条判据不会误伤新存档。
// 长度不等于 10 的不碰（更早/更晚的形态留给各自的迁移，宁可不猜）。

import { app } from "/scripts/app.js";
import { chainCallback } from "../shared/index.mjs?v=202611251300";

const TYPE = "QG_MaskCrop";

// 新数组第 i 位取旧数组的第 MAP[i] 位。
const MAP = [8, 4, 6, 7, 5, 0, 1, 2, 3, 9];

function migrateWidgetOrder(node) {
    const wv = node.widgets_values;
    if (!Array.isArray(wv) || wv.length !== MAP.length) return;
    if (typeof wv[0] !== "string") return; // 新布局（fill_holes 是布尔），不用动
    const fixed = MAP.map((i) => wv[i]);
    node.widgets_values = fixed;
    const widgets = node.widgets || [];
    fixed.forEach((value, index) => {
        const widget = widgets[index];
        if (widget && value !== undefined) widget.value = value;
    });
}

app.registerExtension({
    name: "QG.MaskCropOrder",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TYPE) return;
        // onConfigure 在 widgets_values 已按（新）顺序填进各控件之后才跑，
        // 所以这里读的是原始数组、改的是填错的值 —— 顺序正好。
        chainCallback(nodeType.prototype, "onConfigure", function () {
            migrateWidgetOrder(this);
        });
    },
});
