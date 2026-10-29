# -*- coding: utf-8 -*-
"""下拉选项的老存档兼容：中文值 → 英文值。

为什么需要这张表
----------------
选项值一开始全是中文（``"不缩放"``、``"仅输出空值"``…），存进工作流的
``widgets_values`` 里就是这些中文字符串。改成英文后，老工作流一读回来就是
一个「不在列表里」的值：ComfyUI 会直接报 ``Value not in list``，图跑不起来。

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
    "QG_ImageWatermark": {
        "scale_mode": {
            "none": "不缩放",
            "fit": "等比适配",
            "factor": "按倍数缩放",
            "width-height": "按指定宽高缩放",
        },
        "position": {
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
    "QG_TextOverlayImage": {
        "color_name": {
            "black": "黑",
            "white": "白",
            "gray": "灰",
            "red": "红",
            "green": "绿",
            "blue": "蓝",
        },
        "layout": {
            "horizontal": "横向",
            "vertical": "纵向",
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
    """
    names = tuple(LEGACY.get(node_id, {}))

    def deco(cls):
        fname = getattr(cls, "FUNCTION", "execute")
        orig = getattr(cls, fname, None)
        if orig is None or not names:
            return cls

        @functools.wraps(orig)
        def call(self, **kwargs):
            for key in names:
                if key in kwargs:
                    kwargs[key] = coerce(node_id, key, kwargs[key])
            return orig(self, **kwargs)

        setattr(cls, fname, call)
        return cls

    return deco
