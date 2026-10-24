# -*- coding: utf-8 -*-
"""QG_MaskConcat - concatenate two masks side by side or top to bottom.

Ported from ComfyUI_Muye (mask/mask_concatenate.py, class MaskConcatenate),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips, all debug prints removed (upstream
    printed four lines per run, including tensor devices).
  * Output is always a standard (1, H, W) mask. Upstream returned a bare (H, W)
    tensor, which some downstream mask nodes accept and others do not.
  * ``match_size`` stretches the smaller mask to the larger one's size (bilinear);
    when off, masks keep their size and are placed at the origin of a canvas
    sized to hold both - no stretching, the empty area stays 0.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import torch
import torch.nn.functional as F
from ._qg_combo_legacy import combo_legacy


def _to_2d(mask):
    if mask.dim() == 4:
        return mask.flatten(0, 1).max(dim=0).values
    if mask.dim() == 3:
        return mask.squeeze(0) if mask.shape[0] == 1 else mask.max(dim=0).values
    if mask.dim() == 2:
        return mask
    raise ValueError("[QG-tools] 遮罩拼接：不支持的遮罩维度 %s" % (tuple(mask.shape),))


def _resize(mask, height, width):
    if tuple(mask.shape) == (height, width):
        return mask
    small = mask.unsqueeze(0).unsqueeze(0)
    small = F.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)
    return small.squeeze(0).squeeze(0)


@combo_legacy("QG_MaskConcat")
class QGMaskConcat:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Joins two masks into one, either left-right or top-bottom. Turn on "
        "match_size to stretch the smaller mask to the bigger one's size; leave "
        "it off to keep both at their own size and place them at the origin of a "
        "canvas large enough for both, with the leftover area left black."
    )
    SEARCH_ALIASES = ["mask", "concat", "join", "遮罩", "拼接", "合并", "qg"]

    @classmethod
    def VALIDATE_INPUTS(cls, direction=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask1": ("MASK", {"tooltip": "The first mask."}),
                "mask2": ("MASK", {"tooltip": "The second mask."}),
                "match_size": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "On: stretch the smaller mask to the bigger one's size. Off: both keep their own size.",
                    },
                ),
                "direction": (
                    ["left-right", "top-bottom"],
                    {"default": "left-right", "tooltip": "Left-right joins them side by side; top-bottom stacks them vertically."},
                ),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("MASK",)
    OUTPUT_TOOLTIPS = (
        "The joined mask as (1, H, W).",
    )
    FUNCTION = "concatenate"

    def concatenate(self, mask1, mask2, match_size, direction):
        mask1 = _to_2d(mask1)
        mask2 = _to_2d(mask2)
        if mask2.device != mask1.device:
            mask2 = mask2.to(mask1.device)

        height1, width1 = mask1.shape
        height2, width2 = mask2.shape

        if match_size:
            if height1 * width1 >= height2 * width2:
                mask2 = _resize(mask2, height1, width1)
                height2, width2 = height1, width1
            else:
                mask1 = _resize(mask1, height2, width2)
                height1, width1 = height2, width2

        if direction == "top-bottom":
            out_h, out_w = height1 + height2, max(width1, width2)
        else:
            out_h, out_w = max(height1, height2), width1 + width2

        output = torch.zeros(out_h, out_w, device=mask1.device, dtype=mask1.dtype)
        if direction == "left-right":
            output[:height1, :width1] = mask1
            output[:height2, width1:width1 + width2] = mask2
        else:
            output[:height1, :width1] = mask1
            output[height1:height1 + height2, :width2] = mask2
        return (output.unsqueeze(0),)


NODE_CLASS_MAPPINGS = {"QG_MaskConcat": QGMaskConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskConcat": "Mask Concat"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
