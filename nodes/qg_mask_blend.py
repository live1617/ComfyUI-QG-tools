# ============================================================
# 搬入说明（2026-11-08，用户确认后 1:1 搬运 + 文案英化）
#   来源：作者自有插件 ComfyUI-QG-Multipack v0.1.0 / mask_blend_node.py
#         （GPL-3.0-or-later）
#   原文件：D:////WorkBuddy////2026-10-10-13-25-05////intake////multipack-v0.1.0////
#           ComfyUI-QG-Multipack\\mask_blend_node.py
#   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_MaskBlend
#   概念参考：孤海工具箱 Goohaitools「孤海-遮罩混合运算」（GPL-3.0）；源包为
#   独立实现，业务逻辑与参考实现零重合（见源包 README 的来源表）。
#
#   🔴 计算逻辑一行未改（反向还原后与源文件逐字节相同）。
#   只做界面文案英化与命名适配 —— 本包 verify_bilingual 硬判据要求后端
#   显示名 / DESCRIPTION / tooltip 不许含中文，中文一律进语言包：
#     1) CATEGORY "QG 工具" -> "QG-tools/Mask"；
#     2) DESCRIPTION 改英文单行；
#     3) 5 条 tooltip（3 个下拉 + 2 个可选输入）改英文；
#     4) INPUT_TYPES 按本包规范重排（"xxx": ( 独占行，tooltip 单独占行 ——
#        verify_bilingual 的启发式从 dict 往上找 "name": ( 行尾；源包把
#        {"tooltip": 留在行尾会把 5 个输入全误判成一个名叫 tooltip 的输入）；
#        下拉常量、默认值、输入顺序、optional 归属全部不变；
#     5) 文件名 -> nodes/qg_mask_blend.py（加载器按目录扫）。
#   保持不变：BLEND_MODES / BBOX_MODES / ALIGN_MODES 三组英文值、全部混合与
#   BBOX 计算、越界钳制、中文异常提示（本包 nodes/ 里 70 处 raise 都是中文）、
#   中文 docstring 与行内注释、SEARCH_ALIASES、RETURN_TYPES/RETURN_NAMES。
#   显示名 "Mask Blend" 本来就合规（不带 QG 前缀），未改。
#
#   ⚠️ 与 QG_MaskConcat（遮罩拼接）不是一回事：那个把两张遮罩并排拼成更大的
#   画布，本节点是逐像素布尔运算 + 外接矩形，两者并存不替代。
# ============================================================

# -*- coding: utf-8 -*-
"""QG_MaskBlend —— 遮罩混合运算：两张遮罩做布尔/方向运算，再取外接矩形。

功能规格参照本机已安装的 Goohaitools-comfyui「孤海-遮罩混合运算」：
8 种混合模式、6 种 BBOX 规则、5 种对齐方式，输出 MASK + 宽 + 高。
**代码为本包独立实现，没有复制参考实现的任何一行**，见 README「来源」一节。

与参考实现有意不同的地方（都是修缺陷，不是改需求）：

* 两张遮罩尺寸不一致时，把遮罩 2 缩放到遮罩 1 的画布，不再抛
  ``ValueError("两个遮罩尺寸必须相同")``；
* batch 输入按**所有帧**的整体非零范围算外接矩形，不再只看第 0 帧；
* 两个输入都为空时返回 1x1 空遮罩，不再硬编码 1024x1024 假尺寸；
* BBOX 矩形越界时钳进画布，**输出的宽高等于实际画出来的尺寸**；
* 接受 ``[H,W]`` / ``[B,H,W]`` / ``[B,1,H,W]``，统一输出 ``[B,H,W]`` float32。

两段逻辑，别混在一起：

1. **混合模式**：add/subtract/intersect/exclude 是逐像素运算；left/right/
   top/bottom 是「用两张遮罩非零区域中较小的那个右/下边界作切点，保留
   遮罩 1 的对应半边」。
2. **BBOX**：把混合结果的非零外接矩形**替换成纯白矩形**（不是裁剪！）。
   ``off`` 不做替换，直接输出混合结果，宽高仍返回外接矩形的尺寸。
"""

import torch
import torch.nn.functional as F

from ._qg_combo_legacy import combo_legacy

# 下拉值用英文 key（存进 widgets_values 的是数据不是文案）；中文界面显示什么
# 由 nodes/_qg_combo_legacy.py 的 LEGACY 表 + web/shared/combo_zh.mjs 决定。
BLEND_MODES = [
    "add", "subtract", "intersect", "exclude",
    "left", "right", "top", "bottom",
]
BBOX_MODES = [
    "off", "original", "square_long", "square_short",
    "square_width", "square_height",
]
ALIGN_MODES = ["left", "right", "center", "top", "bottom"]


# ---------------------------------------------------------------------------
# 输入整理
# ---------------------------------------------------------------------------

def _as_bhw(mask):
    """任意常见遮罩形状 -> float32 ``[B,H,W]``，值域钳到 0..1。"""
    if mask is None:
        return None
    tensor = mask if isinstance(mask, torch.Tensor) else torch.as_tensor(mask)
    tensor = tensor.float()
    if tensor.ndim == 2:
        tensor = tensor[None]
    elif tensor.ndim == 4:
        tensor = tensor[:, 0]              # [B,1,H,W]，多通道只取第一通道
    elif tensor.ndim != 3:
        raise ValueError(
            "Unsupported mask shape: %s; expected [H,W], [B,H,W] or [B,1,H,W]"
            % (tuple(tensor.shape),)
        )
    return tensor.clamp(0.0, 1.0)


def _align_pair(a, b):
    """把两张遮罩对齐成同形：帧数补最后一帧，尺寸以遮罩 1 为基准。"""
    if a is None and b is None:
        return None, None
    if a is None:
        return torch.zeros_like(b), b
    if b is None:
        return a, torch.zeros_like(a)

    frames = max(a.shape[0], b.shape[0])

    def pad_batch(t):
        if t.shape[0] == frames:
            return t
        tail = t[-1:].expand(frames - t.shape[0], -1, -1)
        return torch.cat([t, tail], dim=0)

    a, b = pad_batch(a), pad_batch(b)
    if a.shape[1:] != b.shape[1:]:
        b = F.interpolate(
            b[:, None], size=a.shape[1:], mode="bilinear", align_corners=False
        )[:, 0]
    return a, b


# ---------------------------------------------------------------------------
# 非零区域
# ---------------------------------------------------------------------------

def _bbox(mask):
    """所有帧的整体非零外接矩形，闭区间 ``(x0, y0, x1, y1)``；全黑返回 None。"""
    nz = torch.nonzero(mask > 0)
    if nz.numel() == 0:
        return None
    ys, xs = nz[:, 1], nz[:, 2]
    return (
        int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    )


def _extent(mask, vertical):
    """所有帧在 x（或 y）方向上的非零范围 ``(min, max)``；全黑返回 None。"""
    nz = torch.nonzero(mask > 0)
    if nz.numel() == 0:
        return None
    col = nz[:, 1] if vertical else nz[:, 2]
    return int(col.min()), int(col.max())


# ---------------------------------------------------------------------------
# 第一段：混合
# ---------------------------------------------------------------------------

def blend_masks(a, b, mode):
    """两张同形 ``[B,H,W]`` 遮罩按 mode 混合，返回同形 float32。"""
    if mode == "add":
        return (a + b).clamp(0.0, 1.0)
    if mode == "subtract":
        # 遮罩 1 里扣掉与遮罩 2 重叠的部分，等价于 max(a-b, 0)
        return (a - torch.minimum(a, b)).clamp(0.0, 1.0)
    if mode == "intersect":
        return torch.minimum(a, b)
    if mode == "exclude":
        # 两张都不覆盖的区域（NOR），不是 XOR
        return 1.0 - (a + b).clamp(0.0, 1.0)

    if mode in ("left", "right", "top", "bottom"):
        vertical = mode in ("top", "bottom")
        r1 = _extent(a, vertical)
        r2 = _extent(b, vertical)
        if r1 is None and r2 is None:
            return torch.zeros_like(a)
        if r1 is None:
            return b
        if r2 is None:
            return a
        cut = min(r1[1], r2[1])           # 两张里较靠左/上的右(下)边界
        out = a.clone()                    # 方向模式只保留遮罩 1 的半边
        if mode == "left":
            out[:, :, cut + 1:] = 0
        elif mode == "right":
            out[:, :, :cut] = 0
        elif mode == "top":
            out[:, cut + 1:, :] = 0
        else:
            out[:, :cut, :] = 0
        return out

    raise ValueError(
        "Unknown blend mode: %r; available: %s" % (mode, ", ".join(BLEND_MODES))
    )


# ---------------------------------------------------------------------------
# 第二段：外接矩形 / BBOX
# ---------------------------------------------------------------------------

def _rect_size(rect_w, rect_h, bbox):
    if bbox == "original":
        return rect_w, rect_h
    if bbox == "square_long":
        return max(rect_w, rect_h), max(rect_w, rect_h)
    if bbox == "square_short":
        return min(rect_w, rect_h), min(rect_w, rect_h)
    if bbox == "square_width":
        return rect_w, rect_w
    if bbox == "square_height":
        return rect_h, rect_h
    raise ValueError(
        "Unknown BBOX rule: %r; available: %s" % (bbox, ", ".join(BBOX_MODES))
    )


def apply_bbox(mask, bbox, align):
    """返回 ``(遮罩, 宽, 高)``。

    ``off`` 原样返回混合结果，宽高是外接矩形尺寸；其余规则把外接矩形
    替换成纯白矩形，宽高是实际绘制的矩形尺寸（越界钳制后可能变小）。
    """
    box = _bbox(mask)
    if box is None:
        return mask, 0, 0
    x0, y0, x1, y1 = box
    rect_w, rect_h = x1 - x0 + 1, y1 - y0 + 1
    if bbox == "off":
        return mask, rect_w, rect_h

    new_w, new_h = _rect_size(rect_w, rect_h, bbox)
    _, height, width = mask.shape
    # 画布比目标矩形还小时只能画下画布本身，输出真实尺寸而不是虚报。
    new_w, new_h = min(new_w, width), min(new_h, height)

    if bbox == "original" or align == "center":
        new_x = x0 + (rect_w - new_w) // 2
        new_y = y0 + (rect_h - new_h) // 2
    elif align == "left":
        new_x, new_y = x0, y0 + (rect_h - new_h) // 2
    elif align == "right":
        new_x, new_y = x0 + rect_w - new_w, y0 + (rect_h - new_h) // 2
    elif align == "top":
        new_x, new_y = x0 + (rect_w - new_w) // 2, y0
    elif align == "bottom":
        new_x, new_y = x0 + (rect_w - new_w) // 2, y0 + rect_h - new_h
    else:
        raise ValueError(
            "Unknown alignment: %r; available: %s" % (align, ", ".join(ALIGN_MODES))
        )

    # 钳进画布：宁可平移，也不要画出一个被裁掉一半却仍报原尺寸的矩形。
    new_x = max(0, min(new_x, width - new_w))
    new_y = max(0, min(new_y, height - new_h))
    rect = torch.zeros_like(mask)
    rect[:, new_y:new_y + new_h, new_x:new_x + new_w] = 1.0
    return rect, new_w, new_h


# ---------------------------------------------------------------------------
# 节点外壳
# ---------------------------------------------------------------------------

@combo_legacy("QG_MaskBlend")
class QGMaskBlend:
    """两张遮罩做混合运算，再按 BBOX 规则输出矩形遮罩与宽高。"""

    DESCRIPTION = "Blend two masks with add / subtract / intersect / exclude, or keep one half by direction, then optionally replace the non-zero bounding box with a solid rectangle according to the BBOX rule and report that rectangle's width and height. Sizes are matched automatically and a batch uses the combined extent of every frame."
    SEARCH_ALIASES = [
        "mask", "blend", "bbox", "bounding box", "union", "subtract",
        "intersect", "遮罩", "蒙版", "混合", "相加", "相减", "相交",
        "外接矩形", "对齐", "qg",
    ]
    CATEGORY = "QG-tools/Mask"
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("MASK", "INT", "INT")
    RETURN_NAMES = ("mask", "width", "height")
    OUTPUT_TOOLTIPS = (
        "The blended mask, with the solid rectangle applied when a BBOX "
        "rule was chosen.",
        "Width of the reported rectangle in pixels; 0 when no rectangle "
        "was applied.",
        "Height of the reported rectangle in pixels; 0 when no rectangle "
        "was applied.",
    )

    @classmethod
    def VALIDATE_INPUTS(cls, blend_mode=None, bbox=None, align=None):
        # 三个下拉的中文标签（相加 / 相减 …；不替换 / 正方形（长边）…；左 / 居中 …）
        # 登记在 nodes/_qg_combo_legacy.py 的 LEGACY 表里，值本身是英文。
        # 具名列出的作用只有一个：让 ComfyUI 跳过「值必须在列表里」，
        # 别的输入（两张遮罩）照常校验。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "blend_mode": (
                    BLEND_MODES,
                    {
                        "default": "subtract",
                        "tooltip": "add / subtract / intersect / exclude work per pixel (exclude is NOR: the area neither mask covers). left / right / top / bottom compare the two masks' non-zero extents, cut at the nearer edge and keep that half of mask 1 only.",
                    },
                ),
                "bbox": (
                    BBOX_MODES,
                    {
                        "default": "off",
                        "tooltip": "Replace the non-zero bounding box of the blended mask with a solid white rectangle (not a crop). off outputs the blended mask as it is and still reports the box size. The other rules rescale the box 1:1; align decides where it lands.",
                    },
                ),
                "align": (
                    ALIGN_MODES,
                    {
                        "default": "center",
                        "tooltip": "Where the new rectangle sits relative to the original bounding box. Has no effect when bbox is off or original.",
                    },
                ),
            },
            "optional": {
                "mask1": (
                    "MASK",
                    {
                        "tooltip": "First mask. Its canvas size is the reference; the other mask is resized to match when the sizes differ.",
                    },
                ),
                "mask2": (
                    "MASK",
                    {
                        "tooltip": "Second mask. Leave it unconnected to use an all-black mask of the same size.",
                    },
                ),
            },
        }

    def execute(self, blend_mode="subtract", bbox="off", align="center",
                mask1=None, mask2=None):
        a, b = _align_pair(_as_bhw(mask1), _as_bhw(mask2))
        if a is None:                       # 两个输入都没接
            return (torch.zeros((1, 1, 1), dtype=torch.float32), 0, 0)
        blended = blend_masks(a, b, blend_mode)
        out, width, height = apply_bbox(blended, bbox, align)
        return (out.contiguous().float(), int(width), int(height))


NODE_CLASS_MAPPINGS = {"QG_MaskBlend": QGMaskBlend}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskBlend": "Mask Blend"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
