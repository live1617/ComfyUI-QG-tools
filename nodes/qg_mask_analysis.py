# ============================================================
# 搬入说明（2026-11-08，用户确认后 1:1 搬运 + 文案英化）
#   来源：作者自有插件 ComfyUI-QG-Multipack v0.1.0 / mask_analysis_node.py
#         （GPL-3.0-or-later）
#   原文件：D:////WorkBuddy////2026-10-10-13-25-05////intake////multipack-v0.1.0////
#           ComfyUI-QG-Multipack\\mask_analysis_node.py
#   搬运清单：dist/QG-Multipack-节点搬迁清单.html 的 QG_MaskAnalysis
#   概念参考：孤海工具箱 Goohaitools「孤海-遮罩分析」（GPL-3.0）；源包为独立
#   实现，业务逻辑与参考实现零重合（见源包 README 的来源表）。
#
#   🔴 计算逻辑一行未改（反向还原后与源文件逐字节相同）。
#   只做界面文案英化与命名适配 —— 本包 verify_bilingual 硬判据要求后端
#   显示名 / DESCRIPTION / tooltip 不许含中文，中文一律进语言包：
#     1) CATEGORY "QG 工具" -> "QG-tools/Mask"；
#     2) DESCRIPTION 改英文单行；
#     3) 5 条 tooltip（mask + 四个百分比）改英文；
#     4) INPUT_TYPES 按本包规范重排（"xxx": ( 独占行，tooltip 单独占行 ——
#        verify_bilingual 的启发式从 dict 往上找 "name": ( 行尾；源包把
#        {"tooltip": 留在行尾会把 5 个输入全误判成一个名叫 tooltip 的输入）。
#        顺带把那个只用了 4 次的 percent() 工厂内联展开：它的调用处写成
#        `"expand_top": percent(`，行尾不是 "("，同样过不了那个启发式。
#        默认值 / 范围 / step / 输入顺序全部不变；
#     5) 文件名 -> nodes/qg_mask_analysis.py（加载器按目录扫）。
#   保持不变：MAX_SHRINK_RATIO / ACTIVE_THRESHOLD 两个常量、全部外接矩形与
#   扩缩计算、收缩保护的「与参考实现对齐」语义、中文异常提示（本包 nodes/
#   里 70 处 raise 都是中文）、中文 docstring 与行内注释、SEARCH_ALIASES、
#   RETURN_TYPES / RETURN_NAMES。显示名 "Mask Analysis" 本来就合规
#   （不带 QG 前缀），未改。
#
#   ⚠️ 与 QG_MaskCrop / QG_MaskAlign 不是一回事：那两个一个按遮罩裁出图、
#   一个把遮罩平移对齐；本节点只量尺寸，输出的是「填满矩形的纯白遮罩 +
#   各项坐标」，不碰原图也不移动内容。
# ============================================================

# -*- coding: utf-8 -*-
"""QG_MaskAnalysis —— 遮罩分析：量出非零外接矩形，四边按百分比扩缩后输出白矩形与尺寸。

功能规格参照本机已安装的 Goohaitools-comfyui「孤海-遮罩分析」：一个 MASK
输入、上/下/左/右四个扩缩百分比，输出遮罩 + 画布宽高 + 矩形宽高 + 矩形中心。
**代码为本包独立实现，没有复制参考实现的任何一行**，见 README「来源」一节。

与参考实现有意不同的地方（都是修缺陷，不是改需求）：

* batch 输入不再只取第 0 帧：按所有帧的整体非零范围取外接矩形，输出也保留
  全部帧，不再塌成 1 帧；
* 接受 ``[H,W]`` / ``[B,H,W]`` / ``[B,1,H,W]``，统一输出 ``[B,H,W]`` float32；
* 全黑遮罩不再「输出全黑却报画布尺寸」：矩形宽高如实返回 0；

关于收缩保护：参考实现把「两侧百分比之和」与「0.9 × 矩形像素数」比较，
量纲并不一致，压缩时还会把另一侧填的正扩展吞成 0。这显然是原作者的笔误，
但它影响的是**所有填了负百分比的常规场景**，不只是极端值。为了让同一组参数
在两个节点上得到同样的结果（工作流里的数值可以直接搬过来），这里**照原样
对齐**，没有擅自修正；`shrink_guard()` 的注释写明了这一点。

有效像素按 ``>= 0.5`` 判定，与参考实现一致；软边遮罩里低于该值的像素不计入
外接矩形。输出遮罩是把矩形**填满纯白**（不是裁剪原图），矩形越界时先钳进画布
再返回真实宽高。
"""

import torch

# 参考实现的收缩保护系数：与「0.9 × 矩形像素数」比较，见 shrink_guard()。
MAX_SHRINK_RATIO = 0.9
ACTIVE_THRESHOLD = 0.5


# ---------------------------------------------------------------------------
# 输入整理与外接矩形
# ---------------------------------------------------------------------------

def normalize_mask(mask):
    """任意常见 MASK 形状 -> CPU float32 ``[B,H,W]``，值域钳到 0..1。"""
    if mask is None:
        raise ValueError("Mask Analysis: no mask input; connect an upstream MASK to the mask slot")
    tensor = mask if isinstance(mask, torch.Tensor) else torch.as_tensor(mask)
    tensor = tensor.detach().cpu().float()
    if tensor.ndim == 2:
        tensor = tensor.unsqueeze(0)
    elif tensor.ndim == 4:
        tensor = tensor[:, 0, :, :]        # [B,1,H,W]，多通道只取第一通道
    elif tensor.ndim != 3:
        raise ValueError(
            "Unsupported mask shape: %s; expected [H,W], [B,H,W] or [B,1,H,W]"
            % (tuple(tensor.shape),)
        )
    return tensor.clamp(0.0, 1.0)


def bounding_box(mask):
    """所有帧合并后的外接矩形 ``(x0, y0, x1, y1)``，闭区间；全黑返回 None。"""
    hits = torch.nonzero(mask >= ACTIVE_THRESHOLD)
    if hits.numel() == 0:
        return None
    xs, ys = hits[:, 2], hits[:, 1]
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


# ---------------------------------------------------------------------------
# 四边扩缩
# ---------------------------------------------------------------------------

def shrink_guard(first, second, extent):
    """同一轴两侧百分比的收缩保护，与参考实现逐项对齐。

    ``extent`` 是该轴原始矩形的像素数（高或宽）。参考实现把「百分比之和」
    ``total`` 与 ``0.9 * extent`` 比较：量纲不一致，只有 extent 恰好 100 时
    两者数值才碰巧等价。压缩时它把**两侧都**写成负值，于是另一侧填的正扩展
    会被吞成 0。这两点看着都像笔误，但影响的是所有填了负数的常规输入；
    为了让工作流参数可以在两个节点之间直接互换，这里照原样保留。

    想改成「纯百分比、且不吃掉正扩展」的语义，只要把 limit 换成常数 90、
    并在压缩时保留非负值即可——那会改变现有参数的结果，需另行确认。
    """
    a, b = int(first), int(second)
    sa, sb = max(0, -a), max(0, -b)
    total = sa + sb
    if total == 0:
        return a, b
    limit = MAX_SHRINK_RATIO * extent
    if total <= limit:
        return a, b          # 含正扩展：原样保留
    scale = limit / total
    return -int(sa * scale), -int(sb * scale)


def percent_to_pixels(percent, extent):
    """百分比 -> 像素数：按该轴原始矩形尺寸换算，向零截断并保留正负号。"""
    value = int(percent)
    return (1 if value >= 0 else -1) * int(extent * abs(value) / 100)


def expand_box(box, canvas, top, bottom, left, right):
    """把外接矩形按四边百分比扩缩，并钳进画布，返回 ``(x0,y0,x1,y1)``。

    收缩到边界反转时，该轴回退到原始矩形（与参考实现一致，宁可不变也不
    抛错）。正数向外扩、负数向内收，超过画布的部分直接被裁掉，返回的宽高
    始终是实际画出来的尺寸。
    """
    x0, y0, x1, y1 = box
    width, height = canvas
    rect_w, rect_h = x1 - x0 + 1, y1 - y0 + 1

    top_pct, bottom_pct = shrink_guard(top, bottom, rect_h)
    left_pct, right_pct = shrink_guard(left, right, rect_w)
    t = percent_to_pixels(top_pct, rect_h)
    b = percent_to_pixels(bottom_pct, rect_h)
    l = percent_to_pixels(left_pct, rect_w)
    r = percent_to_pixels(right_pct, rect_w)

    new_x0 = max(0, x0 - max(0, l) + max(0, -l))
    new_x1 = min(width - 1, x1 + max(0, r) - max(0, -r))
    new_y0 = max(0, y0 - max(0, t) + max(0, -t))
    new_y1 = min(height - 1, y1 + max(0, b) - max(0, -b))
    if new_x0 > new_x1:
        new_x0, new_x1 = x0, x1
    if new_y0 > new_y1:
        new_y0, new_y1 = y0, y1
    return new_x0, new_y0, new_x1, new_y1


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def analyze_mask(mask, expand_top=0, expand_bottom=0,
                 expand_left=0, expand_right=0):
    """返回 ``(遮罩, 画布宽, 画布高, 矩形宽, 矩形高, 中心x, 中心y)``。"""
    tensor = normalize_mask(mask)
    _, height, width = tensor.shape
    box = bounding_box(tensor)
    if box is None:
        # 全黑：如实报 0x0；中心仍给画布中心，方便下游定位节点不出错。
        return (torch.zeros_like(tensor), int(width), int(height), 0, 0,
                int(width // 2), int(height // 2))

    rect = expand_box(box, (width, height), expand_top, expand_bottom,
                      expand_left, expand_right)
    x0, y0, x1, y1 = rect
    out = torch.zeros_like(tensor)
    out[:, y0:y1 + 1, x0:x1 + 1] = 1.0
    return (
        out,
        int(width), int(height),
        int(x1 - x0 + 1), int(y1 - y0 + 1),
        int((x0 + x1) // 2), int((y0 + y1) // 2),
    )


# ---------------------------------------------------------------------------
# 节点外壳
# ---------------------------------------------------------------------------

class QGMaskAnalysis:
    """量出遮罩的非零外接矩形，四边按百分比扩缩，输出白矩形与各项尺寸。"""

    DESCRIPTION = (
        "Measure the non-zero bounding box of a mask, grow or shrink each of "
        "its four sides by a percentage, and paint that rectangle solid white. "
        "Positive values grow outward, negative values pull inward (the shrink "
        "guard matches the original Mask Analysis node, so the same numbers can "
        "be pasted between them). Pixels count as painted at >= 0.5, a batch "
        "uses the combined extent of every frame, and the node also returns the "
        "canvas size, the rectangle size and the rectangle centre."
    )
    SEARCH_ALIASES = [
        "mask", "analyze", "analysis", "bbox", "bounding box", "expand",
        "extend", "shrink", "center", "遮罩", "蒙版", "分析", "扩展",
        "收缩", "外接矩形", "中心", "qg",
    ]
    CATEGORY = "QG-tools/Mask"
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("MASK", "INT", "INT", "INT", "INT", "INT", "INT")
    RETURN_NAMES = (
        "mask", "canvas_width", "canvas_height",
        "mask_width", "mask_height", "center_x", "center_y",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "The mask to measure. Pixels count as painted at >= 0.5; a batch uses the combined non-zero extent of every frame and keeps every frame in the output.",
                    },
                ),
                "expand_top": (
                    "INT",
                    {
                        "default": 0, "min": -90, "max": 1000, "step": 1,
                        "tooltip": "How far the top edge grows outward, as a percentage of the mask height. Negative values pull it inward; when the two sides together shrink too much they are scaled down, exactly like the original Mask Analysis node, so the same numbers work in both.",
                    },
                ),
                "expand_bottom": (
                    "INT",
                    {
                        "default": 0, "min": -90, "max": 1000, "step": 1,
                        "tooltip": "How far the bottom edge grows outward, as a percentage of the mask height. Negative values pull it inward; when the two sides together shrink too much they are scaled down, exactly like the original Mask Analysis node, so the same numbers work in both.",
                    },
                ),
                "expand_left": (
                    "INT",
                    {
                        "default": 0, "min": -90, "max": 1000, "step": 1,
                        "tooltip": "How far the left edge grows outward, as a percentage of the mask width. Negative values pull it inward; when the two sides together shrink too much they are scaled down, exactly like the original Mask Analysis node, so the same numbers work in both.",
                    },
                ),
                "expand_right": (
                    "INT",
                    {
                        "default": 0, "min": -90, "max": 1000, "step": 1,
                        "tooltip": "How far the right edge grows outward, as a percentage of the mask width. Negative values pull it inward; when the two sides together shrink too much they are scaled down, exactly like the original Mask Analysis node, so the same numbers work in both.",
                    },
                ),
            },
        }

    def execute(self, mask, expand_top=0, expand_bottom=0,
                expand_left=0, expand_right=0):
        return analyze_mask(mask, expand_top, expand_bottom,
                            expand_left, expand_right)


NODE_CLASS_MAPPINGS = {"QG_MaskAnalysis": QGMaskAnalysis}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskAnalysis": "Mask Analysis"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
