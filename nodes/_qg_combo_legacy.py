# -*- coding: utf-8 -*-
"""下拉选项的中英对照表：老存档兼容 + 中文显示名，一份表管两头。

两条用途
--------
1. **老存档兼容**（中文值 → 英文值）。选项值一开始全是中文（``"不缩放"``、
   ``"仅输出空值"``…），存进工作流的 ``widgets_values`` 里就是这些中文字符串。
   改成英文后，老工作流一读回来就是一个「不在列表里」的值：ComfyUI 会直接报
   ``Value not in list``，图跑不起来。
2. **中文显示名**（英文值 → 中文名）。11-08 起本包所有带下拉的节点都登记进来，
   前端 ``web/shared/combo_zh.mjs`` 用同一张表反查，中文界面才显示「裁剪填满」
   而不是 ``crop``。这批节点从来没有中文化过，``coerce()`` 对它们是空操作。

三条腿一起兜（缺一条都会漏）：
  1. 前端 ``web/shared/combo_zh.mjs`` 在 onConfigure 阶段把存档里的中文值
     就地换成英文 —— 常规路径，改完再存就是新值；
  2. 这里 ``coerce()`` 在执行前把漏网的中文值换掉 —— 兜住「不经过前端」的
     调用（API 直连、脚本批量跑、老图只读不存）；
  3. 各节点挂 ``VALIDATE_INPUTS`` 把选项名报上去 —— 让 ComfyUI 跳过
     「值必须在列表里」这道检查，否则第 2 步根本轮不到。

表的形态：{节点ID: {输入名: {新英文值: 老中文值}}}。
新英文值作键，是为了让「英文 → 中文」这条给前端用的反查能直接 dict 反转，
也方便 verify_combo_i18n.py 对账。
"""

import functools


LEGACY = {
    "QG_ImageScaleRange": {
        "limit_mode": {
            "long": "长边", "short": "短边", "width": "宽度",
            "height": "高度", "both": "宽度与高度",
        },
    },
    "QG_ColorImage": {
        "size": {
            "custom": "自定义",
            "256x256": "256x256", "512x512": "512x512", "768x768": "768x768",
            "1024x1024": "1024x1024", "512x768": "512x768", "768x512": "768x512",
            "768x1024": "768x1024", "1024x768": "1024x768",
            "1024x1536": "1024x1536", "1536x1024": "1536x1024",
        },
    },
    "QG_AddWatermark": {
        # 源包（QG-Multipack）的锚点值是中文，搬入时换成英文 key；
        # 顺序必须与节点里的 _H_POSITIONS / _V_POSITIONS 一致。
        "h_position": {
            "center": "居中",
            "left": "靠左",
            "right": "靠右",
        },
        "v_position": {
            "center": "居中",
            "top": "靠上",
            "bottom": "靠下",
        },
    },
    "QG_CropForInpaint": {
        "rescale_algorithm": {
            # 与 locales/zh/nodeDefs.json 的同名下拉一致；V1 时代 AST 对
            # list(RESIZE_ALGORITHMS) 求值失败静默跳过，一直漏登记。
            "bilinear": "双线性",
            "bicubic": "双三次",
            "area": "面积平均",
            "nearest": "最近邻",
        },
    },
    "QG_ColorMatchPro": {
        "method": {
            "mkl": "MKL 线性映射",
            "hm": "直方图匹配",
            "reinhard": "莱因哈德色彩迁移",
            "mvgd": "多元高斯分布",
            "hm-mvgd-hm": "直方图-多元高斯-直方图",
            "hm-mkl-hm": "直方图-MKL-直方图",
            "reinhard_lab": "Reinhard Lab（快速）",
            "wavelet": "小波变换",
            "adain": "自适应实例统一化",
        },
    },
    "QG_ColorMatch": {
        "method": {
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
        "ref_mode": {
            "all-merged": "全部合并",
            "first-frame": "仅第一帧",
            "per-frame": "逐帧对应",
        },
        "src_mode": {
            "per-frame": "逐帧",
            "whole-batch": "全批统一",
        },
        "scope": {
            "all": "全部",
            "chroma-only": "仅色度",
            "luma-only": "仅明暗",
        },
        "mask_use": {
            "result-only": "仅结果",
            "also-restrict-reference": "也限定目标统计",
        },
    },
    "QG_ExportImage": {
        "subsampling": {
            "4:4:4": "4:4:4（最高画质）",
            "4:2:2": "4:2:2（均衡）",
            "4:2:0": "4:2:0（最省体积）",
        },
        "alpha_mode": {
            "on-white": "合成白底",
            "on-black": "合成黑底",
            "keep-alpha": "保留透明（PNG / WEBP）",
        },
    },
    "QG_ImageGrid": {
        "background": {
            "black": "黑色",
            "white": "白色",
        },
    },
    "QG_MaskColorize": {
        "color_name": {
            "black": "黑",
            "white": "白",
            "gray": "灰",
            "red": "红",
            "green": "绿",
            "blue": "蓝",
        },
    },
    "QG_MaskConcat": {
        "direction": {
            "left-right": "左右",
            "top-bottom": "上下",
        },
    },
    "QG_Number": {
        "kind": {
            "integer": "整数",
            "float": "浮点数",
        },
    },
    "QG_RouteBlocker": {
        "mode": {
            "empty": "仅输出空值",
            "cut": "中断后续分支",
        },
    },
    "QG_SizeSelector": {
        "ratio": {
            "none": "无",
            "from-preset": "采用比例",
        },
    },
    # 这个节点从来没发布过中文值，登记在这里纯粹是为了给前端那份中文标签
    # （web/shared/combo_zh.mjs 由这张表生成）。coerce 对它是空操作。
    "QG_EmptyLatentResolution": {
        "aspect_ratio": {
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
    "QG_LoadImage": {
        "tint_color": {
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
    "QG_Slider": {
        "kind": {
            "integer": "整数",
            "float": "浮点数",
        },
    },
    "QG_TextReplace": {
        "mode": {
            "literal": "字面",
            "regex": "正则",
        },
    },
    "QG_TextSplit": {
        "input_source": {
            "text-field": "文本框",
            "external-list": "外部列表",
        },
    },
    "QG_OutpaintBoard": {
        # 选项值从一开始就是英文，没有老存档要换；登记在这里是为了让前端
        # gen_combo_zh 那张反查表有中文可显示（否则中文界面下面板与外露的
        # 单元下拉会写 pixels / percent）。
        "unit": {
            "pixels": "像素",
            "percent": "百分比",
        },
    },
    "QG_RatioResolution": {
        # 1:1 搬自自有插件 QG-Multipack，源包两个下拉的值全是中文，按本包约定
        # 换成英文 key。11 个 "1:1" / "16:9" 这类中英同形的值不登记 —— 没有
        # 要迁移的东西，登记了反而让前端多绕一圈。
        "ratio": {
            "original": "原始比例",
            "custom": "自定义宽高",
        },
        "mode": {
            "long-side": "固定长边",
            "short-side": "固定短边",
            "width": "固定宽度",
            "height": "固定高度",
            "total-pixels": "总像素",
            "long-side-range": "长边（范围）",
        },
    },
    "QG_StepPreview": {
        # 值必须与 CLI 的 --preview-method 一字不差（交给 from_string 解析），
        # 中文只作显示，靠这张表反查。
        "method": {
            "auto": "自动",
            "latent2rgb": "快速",
            "taesd": "清晰",
            "none": "关闭",
        },
    },
    # ───────────────────────────────────────────────────────────────────
    # 以下这批从没发布过中文值，登记进来纯粹是为了给中文界面补显示名
    # （前端 combo_zh.mjs 用同一张表做「英文值 → 中文标签」）。coerce 对它们
    # 是空操作 —— 老存档里本来存的就是英文。
    #
    # 为什么不能只靠 locales/zh/nodeDefs.json 的 options：实测当前前端不读那
    # 一份（widget.options.values 仍是英文数组、没有 getOptionLabel），只有
    # 这里挂上的 getOptionLabel 才真的换掉画布上显示的下拉文字。
    # ───────────────────────────────────────────────────────────────────
    # 11-11 新增节点（自写）：三个下拉都从第一天就登记，中文界面直接显示中文；
    # 这三个表的值从来没有中文存档，所以这里只有「英文 → 中文」这一层含义。
    "QG_ImageFitResize": {
        "target_mode": {
            "megapixels": "百万像素",
            "longest_edge": "长边",
            "shortest_edge": "短边",
            "width_height": "宽高",
            "scale_factor": "倍数",
        },
        "keep_proportion": {
            "stretch": "拉伸",
            "fit": "适应画布",
            "cover_crop": "裁剪",
            "pad": "填充",
        },
        "interpolation": {
            "lanczos": "Lanczos 重采样（高质量抗锯齿）",
            "bicubic": "双三次",
            "bilinear": "双线性",
            # 11-11 从 "nearest" 改名（torch 的 nearest 整体错开半像素，生态用的是
            # nearest-exact）。中文名取 QG_ImageScale 的同款，同一个界面里说法一致。
            "nearest-exact": "邻近-精确",
            "area": "区域",
        },
        # 锚点名与 QG_ImageScale 完全一致，两边的存档可以互相抄。
        "anchor": {
            "center": "居中",
            "top": "上",
            "bottom": "下",
            "left": "左",
            "right": "右",
        },
    },
    # 11-11 新增批次三件套（自写）：BatchMerge 只有一个下拉，从第一天就登记。
    "QG_BatchMerge": {
        "on_mismatch": {
            "resize_to_a": "缩到 A 的尺寸",
            "resize_to_b": "缩到 B 的尺寸",
            "error": "报错",
        },
    },
    # 11-11 新增 RealignToSource（算法同源 MIT）：两个下拉从第一天就登记。
    "QG_RealignToSource": {
        "fit": {
            "zoom + shift": "缩放 + 平移",
            "affine": "仿射（含轻微倾斜）",
        },
        "empty_fill": {
            "edge": "延伸边缘像素",
            "source": "取自原图",
            "gray": "平灰（供重绘）",
        },
    },
    # 11-11 新增节点（封装）：编辑对位回源的两个下拉从第一天就登记。
    "QG_RealignToSource": {
        "fit": {
            "zoom + shift": "缩放 + 平移",
            "affine": "仿射（含倾斜）",
        },
        "empty_fill": {
            "edge": "拉伸边缘",
            "source": "从原图填",
            "gray": "平灰（给重绘）",
        },
    },
    "QG_ImageScale": {
        # 例外：源包这五个下拉的值**本来就是中文**，这一轮才换成英文 key，
        # 所以这里的方向真的是「老中文值 → 英文值」，不只是显示名。
        # 换值的那一步有反向还原证明（见 nodes/qg_image_scale.py 的搬入说明）。
        "scale_method": {
            "by-long-side": "按长边等比例",
            "by-short-side": "按短边等比例",
            "custom-size": "自定义宽高",
        },
        "interpolation": {
            "bilinear": "双线性插值",
            "bicubic": "双三次插值",
            "area": "区域",
            "nearest-exact": "邻近-精确",
            # 源包这里写的是英文 "Lanczos"，也一并规范成小写 key；
            # 老存档里的 "Lanczos" 靠这条换回来。
            "lanczos": "Lanczos",
        },
        "scale_mode": {
            "stretch": "拉伸",
            "crop": "裁剪",
            "fill-color": "填充_自定颜色",
            "fill-border-color": "填充_边框颜色",
            "fill-edge-pixels": "填充_边缘像素",
            "total-pixels": "总像素_等比例",
        },
        "anchor": {
            "center": "居中",
            "top": "上",
            "bottom": "下",
            "left": "左",
            "right": "右",
        },
        "condition": {
            "always": "总是",
            "when-long-side-greater": "最长边大于时",
            "when-short-side-smaller": "最小边小于时",
        },
    },
    "QG_ImageNormalize": {
        # 只作中文显示名用：两个下拉的值从源包起就是英文（Qwen-Image 1K /
        # lanczos …），老存档里不存在中文值，coerce() 对这里是空操作。
        # 「桶」= bucket 的直译，指模型认可的那组固定分辨率。
        "model": {
            "Qwen-Image 1K": "Qwen-Image 1K 桶",
            "Qwen-Image 2K": "Qwen-Image 2K 桶",
            "SDXL 1K": "SDXL 1K 桶",
            "SD 1.5 512": "SD 1.5 512 桶",
            "SD 1.5 768": "SD 1.5 768 桶",
            "Flux 1MP": "Flux 1MP 桶",
            "Flux 2MP": "Flux 2MP 桶",
        },
        "resize_method": {
            "lanczos": "Lanczos（最锐利）",
            "bicubic": "双三次（平滑）",
            "bilinear": "双线性（快）",
            "nearest": "最近邻（硬边）",
        },
    },
    "QG_MDReader": {
        "mode": {
            "plain": "纯文本",
            "raw": "原始",
        },
    },
    "QG_MaskAlign": {
        "align_x": {
            "none": "不移动",
            "center": "居中",
            "left": "左",
            "right": "右",
        },
        "align_y": {
            "none": "不移动",
            "center": "居中",
            "top": "上",
            "bottom": "下",
        },
        "output": {
            "aligned": "对齐后的遮罩",
            "bbox": "外接矩形",
        },
    },
    "QG_MaskBlend": {
        "blend_mode": {
            "add": "相加",
            "subtract": "相减",
            "intersect": "相交",
            "exclude": "排除",
            "left": "保留左半",
            "right": "保留右半",
            "top": "保留上半",
            "bottom": "保留下半",
        },
        "bbox": {
            "off": "不替换",
            "original": "原始尺寸",
            "square_long": "正方形（长边）",
            "square_short": "正方形（短边）",
            "square_width": "正方形（按宽）",
            "square_height": "正方形（按高）",
        },
        "align": {
            "left": "左",
            "right": "右",
            "center": "居中",
            "top": "上",
            "bottom": "下",
        },
    },
    "QG_MaskCrop": {
        "size_mode": {
            "native": "原始尺寸",
            "square": "正方形",
            "custom": "自定义",
        },
        "fill": {
            "edge": "边缘主色",
            "stretch": "拉伸边缘",
            "black": "黑色",
        },
    },
    # 2026-11-25 从 Multipack v2.22.13 搬入的颜色节点。这几个下拉在源包里
    # 就是英文 key（没有中文遗留值），登记进来是为了**中文显示名**这一向：
    # 前端 combo_zh.mjs 与本表逐字对齐，中文界面才显示「纯色」而不是 solid。
    # 老存档里不存在这些中文值，所以反查方向是空转，不会误伤。
    "QG_ColorPicker": {
        "mode": {
            "HEX": "十六进制",
            "RGB": "RGB 整数",
            "HSL": "HSL 百分比",
        },
    },
    "QG_DualColorPicker": {
        "mode": {
            "solid": "纯色",
            "vertical_gradient": "上下渐变",
            "radial_gradient": "中心渐变",
        },
    },
    "QG_ColorConvert": {
        "format": {
            "#HEX": "带 # 十六进制",
            "HEX": "十六进制",
            "RGB": "RGB 整数",
            "HSL": "HSL 百分比",
        },
    },
    "QG_CustomColor": {
        "mode": {
            "solid": "纯色",
            "vertical_gradient": "上下渐变",
            "radial_gradient": "中心渐变",
        },
    },
    "QG_ImageBatchBuilder": {
        "resize_mode": {
            "first": "以第 1 张为准缩放",
            "error": "尺寸不一致就报错",
        },
    },
    # 2026-11-25 从 Multipack v2.22.13 搬入的两个节点。它们在源包里的输入名
    # 和选项值都是中文，搬进来时按本包规范英化，所以老存档里的中文值必须能换
    # 回来 —— 这两个节点的参数是老用户直接存的 widgets_values，不兜会报
    # 「Value not in list」。
    "QG_MaskOrderFilter": {
        "priority": {
            "area": "面积大小",
            "width": "宽度大小",
            "height": "高度大小",
            "top_down": "上下左右",
            "bottom_up": "下上左右",
        },
        "direction": {
            "forward": "正序",
            "reverse": "反序",
        },
    },
    "QG_ImageMaskPreview": {
        "index_scale": {
            "follow_mask": "跟随遮罩缩放",
            "fixed": "固定大小",
        },
    },
}


# 老中文值 → 新英文值（执行期兜底用）
_ZH_TO_EN = {}
for _node, _inputs in LEGACY.items():
    for _name, _pairs in _inputs.items():
        _ZH_TO_EN[(_node, _name)] = {zh: en for en, zh in _pairs.items()}


def coerce(node_id, name, value):
    """把老存档里的中文选项值换成英文；认不出（已经是英文 / 别的值）原样返回。"""
    mapping = _ZH_TO_EN.get((node_id, name))
    if not mapping or not isinstance(value, str):
        return value
    return mapping.get(value, value)


def combo_legacy(node_id):
    """类装饰器：把 FUNCTION 包一层，进来的老中文值先换成英文。

    为什么包 FUNCTION 而不是在 INPUT_TYPES 里换：INPUT_TYPES 是给前端和校验
    用的，执行入口才是真正收值的地方，包在这里一处就覆盖所有分支，也不用担心
    以后给节点加参数时忘了补 coerce。

    🔴 位置参数要原样透传，不能只留 ``**kwargs``：ComfyUI 自己永远用关键字
    调用（``func(**inputs)``），但节点自己的单测、巡检脚本会按签名顺序位置调用
    （``node.execute(mode, "off", "center", a, b)``）—— 只收 kwargs 的那种包装
    会让它们全炸成 ``takes 1 positional argument but 6 were given``，而这跟
    功能对不对毫无关系。代价是位置传进来的值不做 coerce，可那本来就只有脚本
    会做，且传的都是英文值。
    """
    names = tuple(LEGACY.get(node_id, {}))

    def deco(cls):
        fname = getattr(cls, "FUNCTION", "execute")
        orig = getattr(cls, fname, None)
        if orig is None or not names:
            return cls

        @functools.wraps(orig)
        def call(self, *args, **kwargs):
            for key in names:
                if key in kwargs:
                    kwargs[key] = coerce(node_id, key, kwargs[key])
            return orig(self, *args, **kwargs)

        setattr(cls, fname, call)
        return cls

    return deco
