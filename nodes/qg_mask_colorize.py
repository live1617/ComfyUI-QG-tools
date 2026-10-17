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
"""

import numpy as np
import torch

COLOR_MAP = {
    "黑": (0, 0, 0),
    "白": (255, 255, 255),
    "灰": (128, 128, 128),
    "红": (255, 0, 0),
    "绿": (0, 255, 0),
    "蓝": (0, 0, 255),
}


class QGMaskColorize:
    CATEGORY = "QG-tools/遮罩"
    DESCRIPTION = (
        "Paints a flat colour into the masked area of an image. Pick one of six "
        "built-in colours or feed an RGB triple; the mask is thresholded at 0.5 "
        "and applies to every frame of a batch. Handy for eyeballing a mask or "
        "for burning a solid area into a region meant for inpainting."
    )
    SEARCH_ALIASES = ["mask", "colorize", "paint", "遮罩", "上色", "涂色", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "底图（批次时每帧都上色）"}),
                "mask": (
                    "MASK",
                    {
                        "tooltip": (
                            "遮罩：白色（>0.5）区域涂色，黑色区域保留原图；"
                            "接单张遮罩时会应用到批次里每一帧"
                        )
                    },
                ),
                "color_name": (
                    list(COLOR_MAP.keys()),
                    {"default": "白", "tooltip": "内置颜色；接了「自定义 RGB」时以它为准"},
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        "tooltip": "可选自定义颜色：接 [R, G, B] 三元组（0-255 或 0-1）",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = ("上色后的图像。",)
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
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskColorize": "QG 遮罩上色"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
