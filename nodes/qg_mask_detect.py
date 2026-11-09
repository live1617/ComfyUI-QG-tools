# -*- coding: utf-8 -*-
"""QG_MaskDetect - does this mask cover enough area? One BOOLEAN out.

Ported from the author's own ComfyUI-QG-Multipack v0.1.0 (``mask_detect_node.py``),
which implements the same contract as Goohaitools' "孤海遮罩检测"
(``nodes/遮罩检测.py::GuHaiMaskDetect``, GPL-3.0): a MASK input, a "minimum
filter" slider, and one BOOLEAN telling you whether the mask is worth branching
on. One input, one output, no thresholds hidden anywhere else.

The four rules below are the reference's, kept exactly - not "fixed" into what
they look like they should be. The lesson came from QG_MaskAnalysis, where a
rule that read like a typo turned out to be what makes the two nodes
interchangeable:

* A pixel counts when it is **strictly greater** than 0.5. Exactly 0.5 does not
  count. The rest of this pack uses ``>=``; this node deliberately does not.
* The ratio is measured over **everything after ``squeeze()``**, so a batch is
  not judged frame by frame - all frames share one denominator.
* A minimum of **0 skips the area test entirely**: any single active pixel is
  enough, and an all-black mask is still False.
* Otherwise the answer is ``ratio >= minimum``, in percent.

Hardened on input handling only, none of which changes the four rules above:

* numpy arrays and plain lists are converted instead of raising
  ``AttributeError`` the way the reference does;
* ``None`` and non-numeric thresholds raise a readable message instead of a bare
  exception;
* tensors are detached and moved to the CPU, and the caller's tensor is never
  modified.

Not the same question as ``QG_Exists`` (``QG-tools/Logic``): that one asks
"did a value arrive at all" across any type, and treats a mask whose maximum is
below 0.02 as empty. This node asks "is the covered area big enough", takes
only a mask, and its cut-off is 0.5 plus an adjustable percentage. Use
``QG_Exists`` to gate a branch on "nothing connected", and this one to gate on
"the mask is too small to bother with".
"""

import torch

# 有效像素判定：参考实现是严格 > 0.5，这里保持一致。
ACTIVE_THRESHOLD = 0.5


def _to_cpu_tensor(mask):
    """任意常见 MASK 输入 -> CPU 张量；原张量不做值域钳制、不改维度。"""
    if mask is None:
        raise ValueError("Mask Detect: no mask input; connect an upstream MASK to the mask slot")
    if isinstance(mask, torch.Tensor):
        return mask.detach().cpu()
    try:
        return torch.as_tensor(mask).detach().cpu()
    except Exception as error:  # noqa: BLE001 - 把类型错误换成能照做的提示
        raise ValueError(
            "Mask Detect: mask cannot be converted to a tensor (%s); connect a ComfyUI MASK output"
            % error) from error


def _threshold(min_ratio):
    """把「过滤最小值」归一成 float；非数值输入给中文提示。"""
    try:
        return float(min_ratio)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "Mask Detect: the filter minimum must be a number (got %r); range 0-10, "
            "0 means only check whether there is any valid pixel" % (min_ratio,)) from error


def detect_mask(mask, min_ratio=3.0):
    """返回 ``(是否存在遮罩,)``，与参考节点的 ``detect`` 同输入同结果。"""
    limit = _threshold(min_ratio)
    squeezed = _to_cpu_tensor(mask).squeeze()
    active = squeezed > ACTIVE_THRESHOLD
    found = bool(active.any())

    # 0 = 不过滤面积：只要有一个有效像素就算存在遮罩。
    if limit == 0:
        return (found,)
    if not found:
        return (False,)

    # 面积占比按 squeeze 后的全部元素算，batch / 通道维都计入分母。
    ratio = float(active.sum()) / squeezed.numel() * 100
    return (bool(ratio >= limit),)


class QGMaskDetect:
    """判断遮罩有效区域占比是否达到阈值，输出一个 BOOLEAN。"""

    DESCRIPTION = (
        "Checks whether a mask covers enough area to be worth branching on: a "
        "pixel counts when it is strictly above 0.5, the active ratio is taken "
        "over the whole mask with every frame sharing one denominator, and the "
        "answer is True when that ratio reaches the minimum. A minimum of 0 "
        "skips the area test, so any single active pixel answers True; an "
        "all-black mask is always False. Matches Goohaitools' mask-detect node "
        "value for value, so the same numbers work in both."
    )
    SEARCH_ALIASES = [
        "mask", "detect", "detection", "check", "exists", "has mask",
        "boolean", "threshold", "ratio", "area", "遮罩", "蒙版",
        "检测", "判断", "是否存在", "过滤", "面积", "占比", "阈值", "qg",
    ]
    CATEGORY = "QG-tools/Mask"
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("has_mask",)
    OUTPUT_TOOLTIPS = (
        "True when the active area reaches the minimum ratio; an empty mask "
        "is always False.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": (
                    "MASK",
                    {"tooltip": "The mask to test. A pixel counts when it is above 0.5; a batch is judged as a whole - one ratio across every frame, not one verdict per frame."},
                ),
                "min_ratio": (
                    "FLOAT",
                    {
                        "default": 3.0,
                        "min": 0.0,
                        "max": 10.0,
                        "step": 0.1,
                        "display": "slider",
                        "tooltip": "Smallest share of active pixels, in percent (0-10), for the answer to be True. 0 skips the area test and only asks whether any pixel is active. The same number means the same thing in Goohaitools' mask-detect node.",
                    },
                ),
            },
        }

    def execute(self, mask, min_ratio=3.0):
        return detect_mask(mask, min_ratio)


NODE_CLASS_MAPPINGS = {"QG_MaskDetect": QGMaskDetect}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskDetect": "Mask Detect"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
