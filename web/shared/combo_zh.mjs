// 下拉选项的中文标签（英文值 → 中文），由 tools/gen_combo_zh.py 生成，别手改。
//
// 为什么需要这一层：选项值本身必须保持英文（它存进工作流的 widgets_values，
// 是数据不是文案），中文界面要让用户看到「不缩放」而不是 "none"，只能靠前端
// 把显示名换掉。litegraph 的 combo 本来就带 getOptionLabel 钩子 ——
// ComboWidget._displayValue 和 useWidgetSelectItems 都认它，canvas 与 Vue 两种
// 渲染模式一并覆盖，不用自己画控件、也不动存的值。
//
// 老工作流里存的还是中文值（"不缩放" 这类）。这里两手都兜：
//   · configure 之前把存档里的中文值就地换成英文（新存档从此干净）
//   · getOptionLabel 认不出英文值时原样返回 —— 没迁干净的老图也不会显示成空白
//
// 数据源：nodes/_qg_combo_legacy.py 的 LEGACY 表（Python 侧执行期兜底用的是同一张表）。

import { wantsChinese } from "./zh.mjs?v=2026102915";
import { chainCallback } from "./index.mjs?v=2026102915";

export const COMBO_ZH = {
    QG_ColorMatch: {
        method: {
            "wavelet": "小波变换",
            "adain": "自适应实例统一化",
            "mmd": "最大均值差异",
            "histogram": "直方图匹配",
            "reinhard": "莱因哈德色彩迁移",
            "mvgd": "多元高斯分布",
            "histogram-mvgd-histogram": "直方图匹配-多元高斯分布-直方图匹配",
            "histogram-mmd-histogram": "直方图匹配-最大均值差异-直方图匹配",
            "reinhard-lab-gpu": "Reinhard Lab GPU算法",
            "mean-only": "仅均值",
        },
        ref_mode: {
            "all-merged": "全部合并",
            "first-frame": "仅第一帧",
            "per-frame": "逐帧对应",
        },
        src_mode: {
            "per-frame": "逐帧",
            "whole-batch": "全批统一",
        },
        scope: {
            "all": "全部",
            "chroma-only": "仅色度",
            "luma-only": "仅明暗",
        },
        mask_use: {
            "result-only": "仅结果",
            "also-restrict-reference": "也限定目标统计",
        },
    },
    QG_ExportImage: {
        subsampling: {
            "4:4:4": "4:4:4（最高画质）",
            "4:2:2": "4:2:2（均衡）",
            "4:2:0": "4:2:0（最省体积）",
        },
        alpha_mode: {
            "on-white": "合成白底",
            "on-black": "合成黑底",
            "keep-alpha": "保留透明（PNG / WEBP）",
        },
    },
    QG_ImageGrid: {
        background: {
            "black": "黑色",
            "white": "白色",
        },
    },
    QG_ImageWatermark: {
        scale_mode: {
            "none": "不缩放",
            "fit": "等比适配",
            "factor": "按倍数缩放",
            "width-height": "按指定宽高缩放",
        },
        position: {
            "center": "居中",
            "top": "上",
            "bottom": "下",
            "left": "左",
            "right": "右",
            "top-left": "左上",
            "top-right": "右上",
            "bottom-left": "左下",
            "bottom-right": "右下",
        },
    },
    QG_MaskColorize: {
        color_name: {
            "black": "黑",
            "white": "白",
            "gray": "灰",
            "red": "红",
            "green": "绿",
            "blue": "蓝",
        },
    },
    QG_MaskConcat: {
        direction: {
            "left-right": "左右",
            "top-bottom": "上下",
        },
    },
    QG_Number: {
        kind: {
            "integer": "整数",
            "float": "浮点数",
        },
    },
    QG_RouteBlocker: {
        mode: {
            "empty": "仅输出空值",
            "cut": "中断后续分支",
        },
    },
    QG_SizeSelector: {
        ratio: {
            "none": "无",
            "from-preset": "采用比例",
        },
    },
    QG_EmptyLatentResolution: {
        aspect_ratio: {
            "1:1 (Square)": "1:1（方形）",
            "2:3 (Portrait Photo)": "2:3（竖版摄影）",
            "3:2 (Photo)": "3:2（横版摄影）",
            "3:4 (Portrait Standard)": "3:4（竖版标准）",
            "4:3 (Standard)": "4:3（标准）",
            "9:16 (Portrait Widescreen)": "9:16（竖版宽屏）",
            "16:9 (Widescreen)": "16:9（宽屏）",
            "21:9 (Ultrawide)": "21:9（超宽屏）",
        },
    },
    QG_LoadImage: {
        tint_color: {
            "white": "白",
            "red": "红",
            "orange": "橙",
            "yellow": "黄",
            "green": "绿",
            "cyan": "青",
            "blue": "蓝",
            "purple": "紫",
            "gray": "灰",
        },
    },
    QG_Slider: {
        kind: {
            "integer": "整数",
            "float": "浮点数",
        },
    },
    QG_TextOverlayImage: {
        color_name: {
            "black": "黑",
            "white": "白",
            "gray": "灰",
            "red": "红",
            "green": "绿",
            "blue": "蓝",
        },
        layout: {
            "horizontal": "横向",
            "vertical": "纵向",
        },
    },
    QG_TextReplace: {
        mode: {
            "literal": "字面",
            "regex": "正则",
        },
    },
    QG_TextSplit: {
        input_source: {
            "text-field": "文本框",
            "external-list": "外部列表",
        },
    },
    QG_StepPreview: {
        method: {
            "auto": "自动",
            "latent2rgb": "快速",
            "taesd": "清晰",
            "none": "关闭",
        },
    },
};

// 每个节点/控件的双向查表：en→zh 给显示，zh→en 给老存档迁移。
const LOOKUP = {};
for (const [node, inputs] of Object.entries(COMBO_ZH)) {
    LOOKUP[node] = {};
    for (const [widget, pairs] of Object.entries(inputs)) {
        const back = {};
        for (const [en, zh] of Object.entries(pairs)) back[zh] = en;
        LOOKUP[node][widget] = { pairs, back };
    }
}

/** 只在中文界面挂显示钩子；英文界面什么都不做，下拉里本来就是英文值。 */
function applyLabels(node, table) {
    for (const widget of node.widgets || []) {
        const entry = table[widget?.name];
        if (!entry) continue;
        widget.options = widget.options || {};
        if (!wantsChinese()) {
            delete widget.options.getOptionLabel;
            continue;
        }
        widget.options.getOptionLabel = (value) => {
            if (value === null || value === undefined || value === "") return "";
            // 认不出（老中文值、或用户在 API 里塞的别的值）就原样显示，别给空串
            return entry.pairs[value] ?? value;
        };
    }
}

/** 老存档：把 widgets_values 里的中文选项值换成英文（按控件名对位，不按位置猜）。 */
function migrateSaved(info, table) {
    const saved = info?.widgets_values;
    if (!Array.isArray(saved)) return;
    const widgets = this.widgets || [];
    if (saved.length !== widgets.length) return; // 结构对不上就别猜，交给后端 coerce
    for (let i = 0; i < widgets.length; i += 1) {
        const entry = table[widgets[i]?.name];
        if (!entry || typeof saved[i] !== "string") continue;
        const en = entry.back[saved[i]];
        if (en !== undefined) saved[i] = en;
    }
}

/**
 * 挂到某个节点类型上。qg_init.js 的 beforeRegisterNodeDef 里调。
 *
 * 🔴 迁移必须抢在 configure 之前：`info.widgets_values` 是 configure 读的那份
 * 数据，onConfigure 时值已经按位置塞进控件了，那时候再改就晚了（canvas 能改
 * widget.value，Vue 侧的值来自构造时同步的 store，改了不重渲染）。
 * shared/index.mjs 的 chainCallback 是「先跑原来的、再跑自己的」，顺序正好反，
 * 所以这里自己写一个前置版本。
 */
export function installComboZh(nodeType, nodeData) {
    const table = LOOKUP[nodeData?.name];
    if (!table || !nodeType?.prototype) return;

    const priorConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function (info) {
        try {
            migrateSaved.call(this, info, table);
        } catch (err) {
            console.warn("[QG-tools] 下拉选项老值迁移失败", err);
        }
        return priorConfigure ? priorConfigure.apply(this, arguments) : undefined;
    };

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
        applyLabels(this, table);
    });
}
