# -*- coding: utf-8 -*-
"""QG_MaskConcat - join two masks, left-right or top-bottom.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.5 port of
ComfyUI_Muye's ``MaskConcatenate`` (MIT). The four widgets, their option values
and the returned shape for a single mask are unchanged.

What the port got right, and is kept
------------------------------------
* Four widgets and two directions, no hidden modes.
* ``match_size`` off keeps both masks at their own size and lays them out from
  the canvas origin, leaving the leftover area black. That is documented
  behaviour, not a gap - the two masks really do have different sizes.
* Empty pieces are not invented: nothing is trimmed, nothing is normalised,
  the values are copied across as they are.
* ``combo_legacy`` still translates the pre-v0.8.5 Chinese direction values.

What this rewrite changed
-------------------------
* **The batch is no longer flattened.** A 3-D mask is ``(B, H, W)`` in ComfyUI,
  and the port collapsed anything with ``B > 1`` into a single frame by taking
  a per-pixel maximum::

      if mask.shape[0] == 1: return mask.squeeze(0)
      return mask.max(dim=0).values          # four frames in, one frame out

  Four frames of mask went in and a per-pixel union came out - no error, no
  warning, the frames simply gone. It survives here as ``(B, H, W)``, with the
  shorter side repeated when the two batches differ in length. With ``B = 1``
  on both sides the output is byte-for-byte what the port produced.
* **dtype is promoted rather than taken from the first mask** - a float16 and a
  float32 wired together used to be silently narrowed by the assignment.
* **An unknown direction now behaves like left-right.** The port sized the
  canvas for left-right but only filled it when the value matched
  ``"left-right"`` exactly, so any unrecognised string produced an all-black
  mask of the right size.
* ``direction`` is compared against module constants instead of being spelled
  out in three places.
* ``FUNCTION`` is ``execute``, matching the rest of the pack.

One thing that is deliberately *not* changed
--------------------------------------------
``match_size`` stretches the smaller mask to the larger one's *box*, aspect
ratio and all: a 512x512 beside a 1024x256 becomes 512x512, so a round subject
turns into an oval. That is the cost of the option, not an oversight - joining
two masks requires one common size, and preserving the ratio would mean
leaving black bars, which is padding rather than matching. Resizing each mask
before this node is the way to keep a ratio.

Only the standard library plus torch is used -- no new dependency.
"""

import torch
import torch.nn.functional as F

from ._qg_combo_legacy import combo_legacy

LEFT_RIGHT = "left-right"
TOP_BOTTOM = "top-bottom"
DIRECTIONS = [LEFT_RIGHT, TOP_BOTTOM]


def _as_batch(mask):
    """Any mask rank to ``(B, H, W)``, keeping every frame.

    The port's version ended in a per-pixel maximum over the batch, which read
    as "normalise to (H, W)" but actually discarded frames.
    """
    if mask.dim() == 2:
        return mask.unsqueeze(0)
    if mask.dim() == 3:
        return mask
    if mask.dim() == 4:
        # (B, 1, H, W) is a batch with a channel dim kept; (B, C, H, W) is a
        # real multi-channel mask and there the channels do merge.
        return mask.squeeze(1) if mask.shape[1] == 1 else mask.max(dim=1).values
    raise ValueError(
        "[QG-tools] 遮罩拼接：不支持的遮罩维度 %s（要 2 维 (H,W)、3 维 (B,H,W) 或 4 维）"
        % (tuple(mask.shape),)
    )


def _resize(mask, height, width):
    """Interpolate the whole batch at once (B, H, W) -> (B, height, width)."""
    if tuple(mask.shape[1:]) == (height, width):
        return mask
    small = mask.unsqueeze(1)
    small = F.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)
    return small.squeeze(1)


def _repeat_to(mask, count):
    """Repeat a batch up to ``count`` frames; an empty batch becomes empty frames.

    ``expand`` cannot do this - it only grows dimensions that are already 1, so
    going from two frames to four raises instead of repeating.
    """
    if mask.shape[0] == count:
        return mask
    if mask.shape[0] == 0:
        return mask.new_zeros((count, mask.shape[1], mask.shape[2]))
    times = -(-count // mask.shape[0])
    return mask.repeat((times, 1, 1))[:count]


def _align_batches(a, b):
    """Bring both batches to the same length, the shorter one repeating in order."""
    longest = max(a.shape[0], b.shape[0])
    return _repeat_to(a, longest), _repeat_to(b, longest)


@combo_legacy("QG_MaskConcat")
class QGMaskConcat:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Joins two masks into one, either left-right or top-bottom. Turn on "
        "match_size to stretch the smaller mask to the bigger one's size - that "
        "changes its aspect ratio, so resize beforehand if the shape matters. "
        "Leave it off to keep both at their own size and place them at the "
        "origin of a canvas large enough for both, with the leftover area left "
        "black. Masks with several frames stay several frames: the shorter "
        "batch is repeated to match the longer one."
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
                "mask1": ("MASK", {"tooltip": "The first mask. Several frames are fine and stay several frames."}),
                "mask2": ("MASK", {"tooltip": "The second mask, of any size."}),
                "match_size": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "On: stretch the smaller mask to the bigger one's size, which also "
                                   "changes its aspect ratio. Off: both keep their own size and the "
                                   "leftover area stays black.",
                    },
                ),
                "direction": (
                    DIRECTIONS,
                    {
                        "default": LEFT_RIGHT,
                        "tooltip": "Left-right joins them side by side; top-bottom stacks them "
                                   "vertically. Both lay the first mask at the top-left corner.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("MASK",)
    OUTPUT_TOOLTIPS = (
        "The joined mask as (B, H, W): one frame when both inputs had one, "
        "otherwise as many frames as the longer input.",
    )
    FUNCTION = "execute"

    def execute(self, mask1, mask2, match_size, direction):
        a = _as_batch(mask1)
        b = _as_batch(mask2)

        # 两路 dtype 不同时取更宽的那个：原版直接按 mask1.dtype 建画布，赋值
        # 时会把另一路静默降精度。
        dtype = torch.promote_types(a.dtype, b.dtype)
        a = a.to(dtype)
        b = b.to(dtype)
        if a.device != b.device:
            b = b.to(a.device)

        height1, width1 = a.shape[1], a.shape[2]
        height2, width2 = b.shape[1], b.shape[2]

        if match_size and (height1, width1) != (height2, width2):
            # 面积大的那侧不动。相等时和原版一样落进第一个分支（尺寸相同则
            # _resize 直接返回，不做任何插值）。
            if height1 * width1 >= height2 * width2:
                b = _resize(b, height1, width1)
                height2, width2 = height1, width1
            else:
                a = _resize(a, height2, width2)
                height1, width1 = height2, width2

        a, b = _align_batches(a, b)

        if direction == TOP_BOTTOM:
            out_h, out_w = height1 + height2, max(width1, width2)
        else:
            # 未知值也走左右：原版按左右算画布、却只在值严格等于
            # "left-right" 时填充，于是任何不认识的字符串都给一张全黑。
            out_h, out_w = max(height1, height2), width1 + width2

        out = torch.zeros((a.shape[0], out_h, out_w), device=a.device, dtype=dtype)
        if direction == TOP_BOTTOM:
            out[:, :height1, :width1] = a
            out[:, height1:height1 + height2, :width2] = b
        else:
            out[:, :height1, :width1] = a
            out[:, :height2, width1:width1 + width2] = b
        return (out,)


NODE_CLASS_MAPPINGS = {"QG_MaskConcat": QGMaskConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskConcat": "Mask Concat"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
