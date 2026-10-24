# -*- coding: utf-8 -*-
"""QG_EmptyLatentResolution - 宽高比 + 百万像素 → 空 Latent + 最终宽高。

来源：作者自有旧插件 `ComfyUI-EmptyLatentResolution`（relation = own）。那份是用
V3 节点 API（`io.ComfyNode` + `comfy_entrypoint`）写的，本包走 V1（`NODE_CLASS_MAPPINGS`）
—— ComfyUI 的加载器先看 V1 mapping，两套同时存在时 V3 入口根本不会被调用，所以这里
按 V1 重写了一遍节点壳，算法原样保留。

做的事：把官方的「分辨率选择器」和「空 Latent」压成一个节点，省掉中间两根宽高连线。

    comfy_extras/nodes_resolution.py::ResolutionSelector   宽高比 + 百万像素 -> 宽 / 高
    nodes.py::EmptyLatentImage                            宽 + 高 + 批量大小   -> LATENT
    本节点                                                 三者 + 对齐倍数      -> LATENT + 宽 + 高

尺寸算法与 ResolutionSelector 逐行一致（同样的 sqrt 缩放、同样的 multiple 取整）；
latent 结构与 EmptyLatentImage 逐行一致（4 通道、`intermediate_device()` /
`intermediate_dtype()`、`downscale_ratio_spacial = 8`），所以把原来两个节点的连线
换到这个节点上，出图尺寸和内容都不会变。

与旧插件相比只做了四件事，逻辑没动：

  * 文案改英文（旧插件是中文优先，本包后端一律英文 + 中文走语言包）；
  * `multiple` 的取整后再向下贴到 8 的倍数（旧插件就有，这里保留并把理由写进注释）——
    空 Latent 的 latent 尺寸 = 像素 ÷ 8，宽高不是 8 的倍数时 latent 会悄悄丢掉
    不到一行/一列的像素，于是输出的宽高就是 latent 真正覆盖的像素范围；
  * `preview` 输入按 V1 的写法声明成 optional 的自定义控件
    （`RESOLUTION_PREVIEW` 是前端 `ComfyWidgets` 里现成的控件，靠
    `ratio_widget` / `megapixels_widget` / `multiple_widget` 三个键指向同节点的
    另外三个控件自己算图）。V3 里它天然是 optional + socketless，V1 只能靠
    `optional` 段 + 控件 `serialize: false` 达到同样效果；
  * 类名加 `QG_` 前缀、分类并进 `QG-tools/Image`、多语言名称走语言包。

已知限制（与旧插件一致）：固定 4 通道空 latent（和官方空 Latent 一样）。Flux / SD3
这类 16 通道的模型要用对应的专属节点。
"""

import math

import torch

import comfy.model_management

from ._qg_combo_legacy import combo_legacy

# 空 Latent 的空间下采样倍数：像素 / 8 = latent 尺寸。
LATENT_DOWNSCALE = 8

# 下拉选项的值（存进工作流的那份数据）一律英文，中文显示名在
# nodes/_qg_combo_legacy.py 里登记、由前端组合成中文标签。
ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}


def _align_to_latent(value):
    """向下对齐到 8 的倍数，保证 latent 尺寸和输出宽高说的是同一件事。"""
    return max(LATENT_DOWNSCALE, int(value) // LATENT_DOWNSCALE * LATENT_DOWNSCALE)


def compute_size(aspect_ratio, megapixels, multiple=8):
    """按宽高比与百万像素算宽高，返回 (width, height)，均为 8 的倍数。

    与官方 ResolutionSelector 的算法一致：先按总像素求缩放系数，再按 `multiple`
    取整。区别只在最后多一步「向下贴到 8」——官方没有空 Latent，不需要对齐 latent 网格。
    """
    w_ratio, h_ratio = ASPECT_RATIOS[aspect_ratio]
    total_pixels = float(megapixels) * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    multiple = max(1, int(multiple))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return _align_to_latent(width), _align_to_latent(height)


def make_latent(width, height, batch_size=1):
    """造一个和官方 EmptyLatentImage 完全一样的空 latent（含 8 倍下采样声明）。"""
    latent = torch.zeros(
        [int(batch_size), 4, int(height) // LATENT_DOWNSCALE, int(width) // LATENT_DOWNSCALE],
        device=comfy.model_management.intermediate_device(),
        dtype=comfy.model_management.intermediate_dtype(),
    )
    return {"samples": latent, "downscale_ratio_spacial": LATENT_DOWNSCALE}


@combo_legacy("QG_EmptyLatentResolution")
class QG_EmptyLatentResolution:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Turns an aspect ratio and a megapixel target into an empty latent that is "
        "ready to sample, and returns the final pixel width and height too. The size "
        "math matches the core Resolution Selector and the latent matches the core "
        "Empty Latent Image, so replacing those two nodes with this one keeps every "
        "render identical. The preview box draws the resulting shape live while you "
        "drag the aspect ratio or megapixels."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, aspect_ratio=None):
        # 选项值只有英文，本来没有老存档问题；具名列出来是为了让 combo_legacy
        # 那层 coerce 有机会跑（ComfyUI 否则会先按列表校验把中文值挡回去）。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (
                    list(ASPECT_RATIOS),
                    {
                        "default": "1:1 (Square)",
                        "tooltip": (
                            "Aspect ratio of the result. Portrait entries are vertical, "
                            "the rest are horizontal."
                        ),
                    },
                ),
                "megapixels": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.1,
                        "max": 16.0,
                        "step": 0.1,
                        "tooltip": (
                            "Target total pixels in megapixels. 1.0 MP is about "
                            "1024x1024 at 1:1."
                        ),
                    },
                ),
                "batch_size": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 4096,
                        "tooltip": "How many empty latents to produce at once.",
                    },
                ),
                "multiple": (
                    "INT",
                    {
                        "default": 8,
                        "min": 8,
                        "max": 128,
                        "step": 8,
                        "advanced": True,
                        "tooltip": (
                            "Round both sides to this multiple before aligning them to "
                            "the latent grid. 8 matches the 8x downscale; 16 / 32 / 64 "
                            "suit newer models."
                        ),
                    },
                ),
            },
            # 实时分辨率预览：前端现成的控件，本身不参与运行（serialize 关掉），
            # 所以只能放 optional —— 放 required 会因为提交时缺这个输入而报错。
            "optional": {
                "preview": (
                    "RESOLUTION_PREVIEW",
                    {
                        "tooltip": (
                            "Live preview of the shape these settings produce. It reads "
                            "the three controls above."
                        ),
                        "ratio_widget": "aspect_ratio",
                        "megapixels_widget": "megapixels",
                        "multiple_widget": "multiple",
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    OUTPUT_TOOLTIPS = (
        "Empty latent, ready for a sampler.",
        "Final width in pixels - the range the latent actually covers.",
        "Final height in pixels - the range the latent actually covers.",
    )
    FUNCTION = "run"

    def run(self, aspect_ratio, megapixels, batch_size=1, multiple=8, preview=None):
        width, height = compute_size(aspect_ratio, megapixels, multiple)
        return (make_latent(width, height, batch_size), width, height)


NODE_CLASS_MAPPINGS = {"QG_EmptyLatentResolution": QG_EmptyLatentResolution}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_EmptyLatentResolution": "Empty Latent Resolution"}
