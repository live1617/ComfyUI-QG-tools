# -*- coding: utf-8 -*-
"""QG_BatchEveryNth — 从 IMAGE 批次里每 n 帧抽一张。

用法形态参考 ComfyUI-AusBoss's「Select Every Nth 🆎」（MIT，nodes/node_batch_utils.py +
_batch_helpers.py 的 select_every_nth），代码零复用：边界校验、fps 换算、报错措辞
都是本文件重新写的。视频抽帧、把一次跑出来的大批次抽成样本，都用得上。

语义：
  * 先跳过 offset 帧，然后每隔 nth 取一帧，顺序不变 ——
    nth=2 / offset=0 保留第 1, 3, 5 … 帧；offset=1 保留第 2, 4, 6 … 帧（都从 1 数起）；
  * offset 必须小于批内帧数 —— 全跳光和空批一样是非法的；
  * 接了 fps 就输出 fps / nth（抽稀后帧率，片段时长不变），没接输出 0.0。
"""

import torch

from ._qg_combo_legacy import combo_legacy


@combo_legacy("QG_BatchEveryNth")
class QGBatchEveryNth:
    """每 n 帧抽一张，先跳过 offset 帧；顺带把 fps 除以 n。"""

    CATEGORY = "QG-tools/Image/Batch"
    DESCRIPTION = (
        "Keeps every nth frame of an IMAGE batch — halve a video's frame "
        "count before an expensive stage, or thin a sweep down to samples. "
        "offset skips that many frames before the first kept one, so nth 2 "
        "with offset 0 keeps frames 1, 3, 5 and offset 1 keeps 2, 4, 6. "
        "Wire the batch's fps in and the fps output divides it by nth, so "
        "the thinned clip keeps its duration."
    )
    SEARCH_ALIASES = [
        "nth", "every", "skip", "thin", "frames", "抽帧", "批次", "间隔", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "FLOAT")
    RETURN_NAMES = ("images", "fps")
    OUTPUT_TOOLTIPS = (
        "The kept frames, in their original order.",
        "The wired fps divided by nth, so the kept frames still span the same "
        "time; 0 when no fps is wired.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": (
                    "IMAGE",
                    {"tooltip": "The [B,H,W,C] IMAGE batch to thin out."},
                ),
                "nth": (
                    "INT",
                    {
                        "default": 2, "min": 1, "max": 4096, "step": 1,
                        "tooltip": "Keep one frame in every nth: 2 keeps every other frame.",
                    },
                ),
                "offset": (
                    "INT",
                    {
                        "default": 0, "min": 0, "max": 2147483647, "step": 1,
                        "tooltip": "Frames to skip before the first kept frame; "
                                   "must be smaller than the batch's frame count.",
                    },
                ),
            },
            "optional": {
                "fps": (
                    "FLOAT",
                    {
                        "forceInput": True,
                        "tooltip": (
                            "Optional: the batch's frame rate, such as a video "
                            "loader's fps. The fps output divides it by nth."
                        ),
                    },
                ),
            },
        }

    def execute(self, images, nth=2, offset=0, fps=None):
        if not isinstance(images, torch.Tensor) or images.ndim != 4:
            raise ValueError("Batch Every Nth expected a [B,H,W,C] IMAGE batch.")
        count = int(images.shape[0])
        if count < 1:
            raise ValueError("Batch Every Nth received an empty IMAGE batch.")
        step = int(nth)
        skip = int(offset)
        if step < 1:
            raise ValueError("Batch Every Nth needs an nth of at least 1.")
        if skip < 0:
            raise ValueError("Batch Every Nth needs an offset of 0 or more.")
        if skip >= count:
            raise ValueError(
                "Batch Every Nth skipped %d frames, but this batch only "
                "contains %d." % (skip, count)
            )
        rate = float(fps) / step if fps else 0.0
        return (images[skip::step], rate)


NODE_CLASS_MAPPINGS = {"QG_BatchEveryNth": QGBatchEveryNth}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BatchEveryNth": "Batch Every Nth"}
