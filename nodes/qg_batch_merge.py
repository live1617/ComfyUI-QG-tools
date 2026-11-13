# -*- coding: utf-8 -*-
"""QG_BatchMerge — 把两个 IMAGE 批次拼成一个，a 的帧在前。

用法形态参考 ComfyUI-AusBoss's「Merge Batches 🆎」（MIT，nodes/node_batch_utils.py +
_batch_helpers.py 的 merge_batches），代码零复用：尺寸不一致的三种策略、通道校验、
报错措辞都是本文件重新写的。与 QG_BatchSplit 是一对：拆开处理完再拼回去。

语义：
  * 结果 = a 的全部帧 + b 的全部帧（dim=0 拼接）；
  * 两边分辨率不一致时由 on_mismatch 决定：把 b 双线性缩到 a 的尺寸、
    把 a 缩到 b 的尺寸、或直接报错（两个尺寸都写在错误里）；
  * 通道数不一致直接报错 —— 悄悄补/丢一个 alpha 通道不是本节点该做的事；
  * b 的 device / dtype 对齐到 a，然后才拼接。
"""

import torch

from ._qg_combo_legacy import combo_legacy

MISMATCH_MODES = ("resize_to_a", "resize_to_b", "error")


def _require_batch(frames, source):
    """校验非空 BHWC 批次。"""
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4:
        raise ValueError("%s expected a [B,H,W,C] IMAGE batch." % source)
    if int(frames.shape[0]) < 1:
        raise ValueError("%s received an empty IMAGE batch." % source)


def _resize_bhwc(frames, height, width):
    """双线性缩放一个 BHWC 批次（interpolate 要 BCHW，来回搬一次）。"""
    moved = frames.permute(0, 3, 1, 2)
    resized = torch.nn.functional.interpolate(
        moved, size=(height, width), mode="bilinear", align_corners=False
    )
    return resized.permute(0, 2, 3, 1).contiguous()


@combo_legacy("QG_BatchMerge")
class QGBatchMerge:
    """两个批次拼成一个：a 的帧在前，尺寸不一致按 on_mismatch 处理。"""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Join two IMAGE batches into one, a's frames first — reassemble a "
        "split batch, or append a comparison strip to a run. When the two "
        "resolutions differ, on_mismatch picks which side is resized "
        "(bilinear) or refuses with both sizes named; channel counts must "
        "already match."
    )
    SEARCH_ALIASES = [
        "merge", "batch", "join", "concat", "combine", "合并", "批次", "拼接", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    OUTPUT_TOOLTIPS = ("One batch: a's frames followed by b's.",)

    @classmethod
    def VALIDATE_INPUTS(cls, on_mismatch=None):
        # on_mismatch 的译名在 nodes/_qg_combo_legacy.py 的 LEGACY 表里。这里具名报
        # 上去，让 ComfyUI 跳过「值必须在列表里」那道检查 —— 中文界面显示的是
        # 「缩到 A 的尺寸」，直接往 API 里塞中文也不会炸。不写 **kwargs。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "a": (
                    "IMAGE",
                    {"tooltip": "The first batch; its frames come first in the result."},
                ),
                "b": (
                    "IMAGE",
                    {"tooltip": "The second batch, appended after a's frames."},
                ),
                "on_mismatch": (
                    list(MISMATCH_MODES),
                    {
                        "default": "resize_to_a",
                        "tooltip": (
                            "When the sizes differ: resize_to_a resizes b's frames to "
                            "a's size, resize_to_b resizes a's to b's, error stops with "
                            "both sizes named. Sizes that already match skip this."
                        ),
                    },
                ),
            },
        }

    def execute(self, a, b, on_mismatch="resize_to_a"):
        _require_batch(a, "Batch Merge")
        _require_batch(b, "Batch Merge")
        mode = str(on_mismatch)
        if mode not in MISMATCH_MODES:
            raise ValueError(
                "Batch Merge does not know the mismatch policy '%s'; expected "
                "one of %s." % (mode, ", ".join(MISMATCH_MODES))
            )
        channels_a, channels_b = int(a.shape[3]), int(b.shape[3])
        if channels_a != channels_b:
            raise ValueError(
                "Batch Merge cannot join %d-channel and %d-channel images; "
                "convert them to match first." % (channels_a, channels_b)
            )
        merged_a = a
        merged_b = b.to(device=a.device, dtype=a.dtype)
        size_a = (int(a.shape[1]), int(a.shape[2]))
        size_b = (int(merged_b.shape[1]), int(merged_b.shape[2]))
        if size_a != size_b:
            if mode == "error":
                raise ValueError(
                    "Batch Merge received different sizes: a is %dx%d and b is "
                    "%dx%d. Pick a resize policy to join them."
                    % (size_a[1], size_a[0], size_b[1], size_b[0])
                )
            if mode == "resize_to_a":
                merged_b = _resize_bhwc(merged_b, *size_a)
            else:
                merged_a = _resize_bhwc(merged_a, *size_b)
        return (torch.cat((merged_a, merged_b), dim=0),)


NODE_CLASS_MAPPINGS = {"QG_BatchMerge": QGBatchMerge}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BatchMerge": "Batch Merge"}
