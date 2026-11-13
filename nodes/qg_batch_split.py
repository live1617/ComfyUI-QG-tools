# -*- coding: utf-8 -*-
"""QG_BatchSplit — 把一个 IMAGE 批次按帧号切成两段。

用法形态参考 ComfyUI-AusBoss's「Split Batch 🆎」（MIT，nodes/node_batch_utils.py +
_batch_helpers.py 的 split_batch），代码零复用：边界校验的措辞、报错、检查脚本
都是本文件重新写的。同一族还有 QG_BatchMerge（拼回去）与 QG_BatchEveryNth（抽帧）。

语义：
  * index 是**从 1 数起**的切分点 —— 1..index 出 a 口，index+1..末尾出 b 口；
  * 两边都必须留至少一帧：空批在 ComfyUI 的线上本身就是非法的，
    所以会把允许范围直接报在错误里，而不是悄悄给出空的一半；
  * 切出来的两段与输入共享同一块张量存储（torch 切片视图），
    不复制像素 —— 后续节点如果就地改写才会真正拷贝。
"""

import torch

from ._qg_combo_legacy import combo_legacy


def _require_batch(frames, source):
    """校验非空 BHWC 批次并返回帧数。"""
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4:
        raise ValueError("%s expected a [B,H,W,C] IMAGE batch." % source)
    count = int(frames.shape[0])
    if count < 1:
        raise ValueError("%s received an empty IMAGE batch." % source)
    return count


@combo_legacy("QG_BatchSplit")
class QGBatchSplit:
    """按 1 起算的帧号把批次切成两段：1..index 出 a，其余出 b。"""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Split an IMAGE batch in two after a one-based frame index: frames 1 "
        "through index come out of a, the rest out of b. Send a clip's halves "
        "to different treatments, or peel leading frames off a batch. Both "
        "sides must keep at least one frame."
    )
    SEARCH_ALIASES = [
        "split", "batch", "frames", "half", "拆分", "批次", "拆", "帧", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("a", "b")
    OUTPUT_TOOLTIPS = (
        "Frames 1 through index.",
        "The remaining frames.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": (
                    "IMAGE",
                    {"tooltip": "The [B,H,W,C] IMAGE batch to split."},
                ),
                "index": (
                    "INT",
                    {
                        "default": 1, "min": 1, "max": 2147483647, "step": 1,
                        "tooltip": (
                            "One-based split point: frames 1 through index go to a, "
                            "the rest to b. With N frames the valid range is 1..N-1 "
                            "so neither side ends up empty."
                        ),
                    },
                ),
            },
        }

    def execute(self, images, index):
        count = _require_batch(images, "Batch Split")
        number = int(index)
        if count < 2:
            raise ValueError(
                "Batch Split needs at least 2 frames to split, but this batch "
                "contains %d." % count
            )
        if number < 1 or number >= count:
            raise ValueError(
                "Batch Split cannot split after frame %d: with %d frames the "
                "split point must be between 1 and %d so neither side is empty."
                % (number, count, count - 1)
            )
        return (images[:number], images[number:])


NODE_CLASS_MAPPINGS = {"QG_BatchSplit": QGBatchSplit}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BatchSplit": "Batch Split"}
