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

import { wantsChinese } from "./zh.mjs?v=2026110904";
import { chainCallback } from "./index.mjs?v=2026110904";

export const COMBO_ZH = {
    QG_AddWatermark: {
        h_position: {
            "center": "居中",
            "left": "靠左",
            "right": "靠右",
        },
        v_position: {
            "center": "居中",
            "top": "靠上",
            "bottom": "靠下",
        },
    },
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
    QG_OutpaintBoard: {
        unit: {
            "pixels": "像素",
            "percent": "百分比",
        },
    },
    QG_RatioResolution: {
        ratio: {
            "original": "原始比例",
            "custom": "自定义宽高",
        },
        mode: {
            "long-side": "固定长边",
            "short-side": "固定短边",
            "width": "固定宽度",
            "height": "固定高度",
            "total-pixels": "总像素",
            "long-side-range": "长边（范围）",
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
    QG_ImageScale: {
        scale_method: {
            "by-long-side": "按长边等比例",
            "by-short-side": "按短边等比例",
            "custom-size": "自定义宽高",
        },
        interpolation: {
            "bilinear": "双线性插值",
            "bicubic": "双三次插值",
            "area": "区域",
            "nearest-exact": "邻近-精确",
            "lanczos": "Lanczos",
        },
        scale_mode: {
            "stretch": "拉伸",
            "crop": "裁剪",
            "fill-color": "填充_自定颜色",
            "fill-border-color": "填充_边框颜色",
            "fill-edge-pixels": "填充_边缘像素",
            "total-pixels": "总像素_等比例",
        },
        anchor: {
            "center": "居中",
            "top": "上",
            "bottom": "下",
            "left": "左",
            "right": "右",
        },
        condition: {
            "always": "总是",
            "when-long-side-greater": "最长边大于时",
            "when-short-side-smaller": "最小边小于时",
        },
    },
    QG_ImageNormalize: {
        model: {
            "Qwen-Image 1K": "Qwen-Image 1K 桶",
            "Qwen-Image 2K": "Qwen-Image 2K 桶",
            "SDXL 1K": "SDXL 1K 桶",
            "SD 1.5 512": "SD 1.5 512 桶",
            "SD 1.5 768": "SD 1.5 768 桶",
            "Flux 1MP": "Flux 1MP 桶",
            "Flux 2MP": "Flux 2MP 桶",
        },
        resize_method: {
            "lanczos": "Lanczos（最锐利）",
            "bicubic": "双三次（平滑）",
            "bilinear": "双线性（快）",
            "nearest": "最近邻（硬边）",
        },
    },
    QG_MDReader: {
        mode: {
            "plain": "纯文本",
            "raw": "原始",
        },
    },
    QG_MaskAlign: {
        align_x: {
            "none": "不移动",
            "center": "居中",
            "left": "左",
            "right": "右",
        },
        align_y: {
            "none": "不移动",
            "center": "居中",
            "top": "上",
            "bottom": "下",
        },
        output: {
            "aligned": "对齐后的遮罩",
            "bbox": "外接矩形",
        },
    },
    QG_MaskBlend: {
        blend_mode: {
            "add": "相加",
            "subtract": "相减",
            "intersect": "相交",
            "exclude": "排除",
            "left": "保留左半",
            "right": "保留右半",
            "top": "保留上半",
            "bottom": "保留下半",
        },
        bbox: {
            "off": "不替换",
            "original": "原始尺寸",
            "square_long": "正方形（长边）",
            "square_short": "正方形（短边）",
            "square_width": "正方形（按宽）",
            "square_height": "正方形（按高）",
        },
        align: {
            "left": "左",
            "right": "右",
            "center": "居中",
            "top": "上",
            "bottom": "下",
        },
    },
    QG_MaskCrop: {
        size_mode: {
            "native": "原始尺寸",
            "square": "正方形",
            "custom": "自定义",
        },
        fill: {
            "edge": "边缘主色",
            "stretch": "拉伸边缘",
            "black": "黑色",
        },
    },
    QG_GoogleTranslateText: {
        from_translate: {
            "auto": "自动检测",
            "af": "南非荷兰语",
            "sq": "阿尔巴尼亚语",
            "am": "阿姆哈拉语",
            "ar": "阿拉伯语",
            "hy": "亚美尼亚语",
            "az": "阿塞拜疆语",
            "eu": "巴斯克语",
            "be": "白俄罗斯语",
            "bn": "孟加拉语",
            "bs": "波斯尼亚语",
            "bg": "保加利亚语",
            "ca": "加泰罗尼亚语",
            "ceb": "宿务语",
            "ny": "齐切瓦语",
            "zh-cn": "中文（简体）",
            "zh-tw": "中文（繁体）",
            "co": "科西嘉语",
            "hr": "克罗地亚语",
            "cs": "捷克语",
            "da": "丹麦语",
            "nl": "荷兰语",
            "en": "英语",
            "eo": "世界语",
            "et": "爱沙尼亚语",
            "tl": "菲律宾语",
            "fi": "芬兰语",
            "fr": "法语",
            "fy": "弗里西语",
            "gl": "加利西亚语",
            "ka": "格鲁吉亚语",
            "de": "德语",
            "el": "希腊语",
            "gu": "古吉拉特语",
            "ht": "海地克里奥尔语",
            "ha": "豪萨语",
            "haw": "夏威夷语",
            "iw": "希伯来语（旧码）",
            "he": "希伯来语",
            "hi": "印地语",
            "hmn": "苗语",
            "hu": "匈牙利语",
            "is": "冰岛语",
            "ig": "伊博语",
            "id": "印尼语",
            "ga": "爱尔兰语",
            "it": "意大利语",
            "ja": "日语",
            "jw": "爪哇语",
            "kn": "卡纳达语",
            "kk": "哈萨克语",
            "km": "高棉语",
            "ko": "韩语",
            "ku": "库尔德语（库尔曼吉）",
            "ky": "吉尔吉斯语",
            "lo": "老挝语",
            "la": "拉丁语",
            "lv": "拉脱维亚语",
            "lt": "立陶宛语",
            "lb": "卢森堡语",
            "mk": "马其顿语",
            "mg": "马尔加什语",
            "ms": "马来语",
            "ml": "马拉雅拉姆语",
            "mt": "马耳他语",
            "mi": "毛利语",
            "mr": "马拉地语",
            "mn": "蒙古语",
            "my": "缅甸语",
            "ne": "尼泊尔语",
            "no": "挪威语",
            "or": "奥里亚语",
            "ps": "普什图语",
            "fa": "波斯语",
            "pl": "波兰语",
            "pt": "葡萄牙语",
            "pa": "旁遮普语",
            "ro": "罗马尼亚语",
            "ru": "俄语",
            "sm": "萨摩亚语",
            "gd": "苏格兰盖尔语",
            "sr": "塞尔维亚语",
            "st": "塞索托语",
            "sn": "绍纳语",
            "sd": "信德语",
            "si": "僧伽罗语",
            "sk": "斯洛伐克语",
            "sl": "斯洛文尼亚语",
            "so": "索马里语",
            "es": "西班牙语",
            "sw": "斯瓦希里语",
            "sv": "瑞典语",
            "tg": "塔吉克语",
            "ta": "泰米尔语",
            "te": "泰卢固语",
            "th": "泰语",
            "tr": "土耳其语",
            "uk": "乌克兰语",
            "ur": "乌尔都语",
            "ug": "维吾尔语",
            "uz": "乌兹别克语",
            "vi": "越南语",
            "cy": "威尔士语",
            "xh": "科萨语",
            "yi": "意第绪语",
            "yo": "约鲁巴语",
            "zu": "祖鲁语",
        },
        to_translate: {
            "af": "南非荷兰语",
            "sq": "阿尔巴尼亚语",
            "am": "阿姆哈拉语",
            "ar": "阿拉伯语",
            "hy": "亚美尼亚语",
            "az": "阿塞拜疆语",
            "eu": "巴斯克语",
            "be": "白俄罗斯语",
            "bn": "孟加拉语",
            "bs": "波斯尼亚语",
            "bg": "保加利亚语",
            "ca": "加泰罗尼亚语",
            "ceb": "宿务语",
            "ny": "齐切瓦语",
            "zh-cn": "中文（简体）",
            "zh-tw": "中文（繁体）",
            "co": "科西嘉语",
            "hr": "克罗地亚语",
            "cs": "捷克语",
            "da": "丹麦语",
            "nl": "荷兰语",
            "en": "英语",
            "eo": "世界语",
            "et": "爱沙尼亚语",
            "tl": "菲律宾语",
            "fi": "芬兰语",
            "fr": "法语",
            "fy": "弗里西语",
            "gl": "加利西亚语",
            "ka": "格鲁吉亚语",
            "de": "德语",
            "el": "希腊语",
            "gu": "古吉拉特语",
            "ht": "海地克里奥尔语",
            "ha": "豪萨语",
            "haw": "夏威夷语",
            "iw": "希伯来语（旧码）",
            "he": "希伯来语",
            "hi": "印地语",
            "hmn": "苗语",
            "hu": "匈牙利语",
            "is": "冰岛语",
            "ig": "伊博语",
            "id": "印尼语",
            "ga": "爱尔兰语",
            "it": "意大利语",
            "ja": "日语",
            "jw": "爪哇语",
            "kn": "卡纳达语",
            "kk": "哈萨克语",
            "km": "高棉语",
            "ko": "韩语",
            "ku": "库尔德语（库尔曼吉）",
            "ky": "吉尔吉斯语",
            "lo": "老挝语",
            "la": "拉丁语",
            "lv": "拉脱维亚语",
            "lt": "立陶宛语",
            "lb": "卢森堡语",
            "mk": "马其顿语",
            "mg": "马尔加什语",
            "ms": "马来语",
            "ml": "马拉雅拉姆语",
            "mt": "马耳他语",
            "mi": "毛利语",
            "mr": "马拉地语",
            "mn": "蒙古语",
            "my": "缅甸语",
            "ne": "尼泊尔语",
            "no": "挪威语",
            "or": "奥里亚语",
            "ps": "普什图语",
            "fa": "波斯语",
            "pl": "波兰语",
            "pt": "葡萄牙语",
            "pa": "旁遮普语",
            "ro": "罗马尼亚语",
            "ru": "俄语",
            "sm": "萨摩亚语",
            "gd": "苏格兰盖尔语",
            "sr": "塞尔维亚语",
            "st": "塞索托语",
            "sn": "绍纳语",
            "sd": "信德语",
            "si": "僧伽罗语",
            "sk": "斯洛伐克语",
            "sl": "斯洛文尼亚语",
            "so": "索马里语",
            "es": "西班牙语",
            "sw": "斯瓦希里语",
            "sv": "瑞典语",
            "tg": "塔吉克语",
            "ta": "泰米尔语",
            "te": "泰卢固语",
            "th": "泰语",
            "tr": "土耳其语",
            "uk": "乌克兰语",
            "ur": "乌尔都语",
            "ug": "维吾尔语",
            "uz": "乌兹别克语",
            "vi": "越南语",
            "cy": "威尔士语",
            "xh": "科萨语",
            "yi": "意第绪语",
            "yo": "约鲁巴语",
            "zu": "祖鲁语",
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
