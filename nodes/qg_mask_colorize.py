# -*- coding: utf-8 -*-
"""QG_MaskColorize - paint a colour into the masked area of an image.

Ported from ComfyUI_Muye (mask/mask_colorize.py, class MaskColorize),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips.
  * Works on batches: a per-frame mask (B, H, W) is applied frame by frame; a
    single (H, W) mask is applied to every frame. Upstream only looked at the
    first mask slice and broadcast it over whatever the image shape was.
  * Thresholds the mask at 0.5 - soft masks are treated as a hard cut, which is
    what "paint the area" means here.

Useful for visualising a segmentation mask or for burning a flat colour into a
region before inpainting.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import numpy as np
import torch
from ._qg_combo_legacy import combo_legacy

COLOR_MAP = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "gray": (128, 128, 128),
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
}


@combo_legacy("QG_MaskColorize")
class QGMaskColorize:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Paints a flat colour into the masked area of an image. Pick one of six "
        "built-in colours or feed an RGB triple; the mask is thresholded at 0.5 "
        "and applies to every frame of a batch. Handy for eyeballing a mask or "
        "for burning a solid area into a region meant for inpainting."
    )
    SEARCH_ALIASES = ["mask", "colorize", "paint", "遮罩", "上色", "涂色", "qg"]

    @classmethod
    def VALIDATE_INPUTS(cls, color_name=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The base image; every frame of a batch is painted."}),
                "mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "The mask: white areas (above 0.5) take the color, black areas keep "
                            "the image. A single mask applies to every frame of the batch."
                        )
                    },
                ),
                "color_name": (
                    list(COLOR_MAP.keys()),
                    {"default": "white", "tooltip": "One of the built-in colors; a wired custom RGB triple wins over it."},
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        "tooltip": "Optional custom color: wire an [R, G, B] triple (0-255 or 0-1).",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The image with the masked area painted.",
    )
    FUNCTION = "colorize"

    @staticmethod
    def _resolve_color(color_rgb, color_name):
        if color_rgb is not None:
            try:
                values = list(color_rgb)
            except TypeError:
                values = []
            if len(values) == 3:
                if max(values) <= 1.0:
                    return tuple(int(c * 255) for c in values)
                return tuple(int(c) for c in values)
        return COLOR_MAP.get(color_name, (255, 0, 0))

    def colorize(self, image, mask, color_name, color_rgb=None):
        if image.dim() == 3:
            image = image.unsqueeze(0)

        # Normalise the mask to (B, H, W) matching the image frames.
        if mask.dim() == 4:
            mask = mask.max(dim=1).values
        elif mask.dim() == 2:
            mask = mask.unsqueeze(0)
        if mask.shape[0] == 1 and image.shape[0] > 1:
            mask = mask.expand(image.shape[0], -1, -1)
        elif mask.shape[0] != image.shape[0]:
            mask = mask[: image.shape[0]]

        mask = (mask > 0.5).to(device=image.device, dtype=image.dtype)
        mask = mask.unsqueeze(-1)  # (B, H, W, 1)

        color = self._resolve_color(color_rgb, color_name)
        color_arr = torch.tensor(color, dtype=image.dtype, device=image.device) / 255.0
        color_layer = torch.ones_like(image) * color_arr
        out = image * (1 - mask) + color_layer * mask
        return (out.clamp(0, 1),)


NODE_CLASS_MAPPINGS = {"QG_MaskColorize": QGMaskColorize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskColorize": "Mask Colorize"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
