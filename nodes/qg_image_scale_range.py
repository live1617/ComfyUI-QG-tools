# -*- coding: utf-8 -*-
"""QG_ImageScaleRange —— 把图像与遮罩按范围限制缩放（图像缩放·范围）。

功能对位本机 Goohaitools-comfyui「图像缩放（范围）」(图像缩放范围孤海)
的节点形态与参数，但**代码完全自写**：不引 PIL / numpy，几何与插值全用
torch。接口与输出一致：图像 + 可选遮罩进，图像 + 遮罩出。

尺寸计算严格按参考的几何口径（真机逐项对过黄金基准）：

  * 五种限制模式：long(长边) / short(短边) / width(宽度) / height(高度) /
    both(宽度与高度)。都先算一个缩放比例，再用 ``round`` 得目标宽高。
  * 整除数 > 0 时走 cover：先把目标宽高各向下取到整除数的倍数，按原比例
    算出两套候选、选面积更接近原目标的一套，等比放大到「盖住」目标后
    居中裁到整除数倍数 —— 主体不被压窄，多出的边被裁掉。

与参考实现有意不同（修缺陷，不是改需求）：

  * 「宽度与高度」模式在极端宽高比下，参考实现只把短边放大到最小尺寸、
    却 ``pass`` 掉了长边超最大尺寸的检查，实测 4000x100 会吐出 40960x1024
    的巨型图。这里在「短边要放大且长边要缩小」时优先满足最大尺寸，避免
    内存爆炸；常规比例下与参考逐项相同。
  * 插值用 torch 的 area(缩)/bilinear(放)，遮罩走同一套几何但保持连续
    alpha，不量化到 8 位；参考把图像/遮罩都先量化成 uint8 再缩放。
  * 遮罩全黑或没接时，输出与结果图同尺寸的全黑遮罩（与参考一致），
    不浪费一次缩放。

V3 migration (2026-11-19): V1 -> V3 via ``io.ComfyNode``. Schema is built in
``define_schema``; ``execute`` is a classmethod returning ``io.NodeOutput``.
The ``@combo_legacy`` decorator is dropped (it wraps ``cls.FUNCTION``, which
in V3 is the base class's ``EXECUTE_NORMALIZED``) and replaced by an explicit
``coerce()`` call at the top of ``execute``, preserving legacy Chinese combo
values from saved workflows. ``validate_inputs`` is the V3 spelling of the old
``VALIDATE_INPUTS``. All inputs stay optional, matching the V1 input_order.
"""

import torch
import torch.nn.functional as F

from comfy_api.latest import io

from ._qg_combo_legacy import coerce


# 限制模式值用英文键（存进 widgets_values 的是数据），中文靠 LEGACY/combo_zh。
# 顺序与截图一致：长边 / 短边 / 宽度 / 高度 / 宽度与高度。
LIMIT_MODES = ["long", "short", "width", "height", "both"]


def _round_half_up(value):
    """Python round 是银行家舍入；参考用 int(round(x)) 也是银行家，这里同款。"""
    return int(round(value))


def _target_size(width, height, mode, minimum, maximum):
    """按限制模式算目标 (宽, 高)，不含整除数处理。"""
    if mode == "long":
        edge = max(width, height)
        scale = minimum / edge if edge < minimum else (maximum / edge if edge > maximum else 1.0)
    elif mode == "short":
        edge = min(width, height)
        scale = minimum / edge if edge < minimum else (maximum / edge if edge > maximum else 1.0)
    elif mode == "width":
        scale = minimum / width if width < minimum else (maximum / width if width > maximum else 1.0)
    elif mode == "height":
        scale = minimum / height if height < minimum else (maximum / height if height > maximum else 1.0)
    elif mode == "both":
        short, long = min(width, height), max(width, height)
        need_up = short < minimum
        need_down = long > maximum
        if need_up and need_down:
            # 两个约束冲突（极端长条）：优先不超最大尺寸，避免巨型图。
            scale = maximum / long
        elif need_up:
            scale = minimum / short
        elif need_down:
            scale = maximum / long
        else:
            scale = 1.0
    else:
        scale = 1.0
    return _round_half_up(width * scale), _round_half_up(height * scale)


def _apply_divisor(width, height, divisor, ratio):
    """整除数 cover：两套候选选面积更接近者。ratio 是原始 宽/高。"""
    plan_w = (width // divisor) * divisor
    plan_h = _round_half_up(plan_w / ratio)
    plan_h = (plan_h // divisor) * divisor

    plan_h2 = (height // divisor) * divisor
    plan_w2 = _round_half_up(plan_h2 * ratio)
    plan_w2 = (plan_w2 // divisor) * divisor

    target_area = width * height
    if abs(plan_w * plan_h - target_area) <= abs(plan_w2 * plan_h2 - target_area):
        return max(divisor, plan_w), max(divisor, plan_h)
    return max(divisor, plan_w2), max(divisor, plan_h2)


def _resize_cover(tensor, target_w, target_h):
    """等比放大到盖住目标尺寸，返回放大后的张量（再交给居中裁剪）。"""
    cur_h, cur_w = tensor.shape[-2], tensor.shape[-1]
    cur_ratio = cur_w / cur_h
    tgt_ratio = target_w / target_h
    if cur_ratio > tgt_ratio:
        scaled_h = target_h
        scaled_w = max(1, _round_half_up(scaled_h * cur_ratio))
    else:
        scaled_w = target_w
        scaled_h = max(1, _round_half_up(scaled_w / cur_ratio))
    return _interpolate(tensor, scaled_w, scaled_h)


def _center_crop_to_divisor(tensor, divisor):
    """居中裁到整除数的倍数。尺寸不足一个整除数时先补黑再裁。"""
    cur_h, cur_w = tensor.shape[-2], tensor.shape[-1]
    crop_w = max(divisor, (cur_w // divisor) * divisor)
    crop_h = max(divisor, (cur_h // divisor) * divisor)
    pad_w, pad_h = max(0, crop_w - cur_w), max(0, crop_h - cur_h)
    work = tensor
    if pad_w or pad_h:
        pad = (pad_w // 2, pad_w - pad_w // 2, pad_h // 2, pad_h - pad_h // 2)
        work = F.pad(work, pad)
    cur_h, cur_w = work.shape[-2], work.shape[-1]
    left, top = (cur_w - crop_w) // 2, (cur_h - crop_h) // 2
    return work[..., top:top + crop_h, left:left + crop_w]


def _interpolate(work, width, height):
    """只接受 ``[N,C,H,W]``：缩小用 area，放大用 bilinear。

    维度重排由调用方显式做，避免 [H,W,C] 被当成 [B,H,W] 误读（那会让高度
    完全不缩放，极端比例下还会按错的轴算出巨型张量）。
    """
    shrinking = height <= work.shape[2] and width <= work.shape[3]
    if shrinking:
        return F.interpolate(work, size=(height, width), mode="area")
    return F.interpolate(work, size=(height, width), mode="bilinear", align_corners=False)


def _is_black(mask):
    """与参考一致：整批都没有 > 0.01 的像素才算全黑。"""
    if mask is None:
        return True
    return not bool((mask > 0.01).any())


def _as_mask_bhw(mask):
    if mask is None:
        return None
    m = mask.to(torch.float32)
    if m.dim() == 2:
        m = m.unsqueeze(0)
    elif m.dim() == 4:
        m = m[:, 0]
    return m.clamp(0.0, 1.0)


class QGImageScaleRange(io.ComfyNode):
    CATEGORY = "QG-tools/Image"

    DESCRIPTION = (
        "Scales an image and its mask so the chosen dimension stays inside a "
        "size range. Limit Mode picks which dimension the range applies to: "
        "long side, short side, width, height, or both. Min Size and Max Size "
        "bound that dimension; a picture outside the range is scaled back in "
        "with its aspect ratio kept. Divisible rounds the result to multiples "
        "of that number using a cover-and-centre-crop, so the subject is never "
        "squashed - extra edges are cropped instead. Image and mask are "
        "processed frame by frame with the same geometry; they must have the "
        "same batch size when both are connected. A black or missing mask "
        "comes back as an all-black mask at the output image's size."
    )
    SEARCH_ALIASES = [
        "image scale range", "scale to range", "resize range", "limit size",
        "image resize", "按比例缩放", "图像缩放", "范围缩放", "长边缩放",
        "限制尺寸", "尺寸范围", "整除裁剪",
    ]
    OUTPUT_NODE = False

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ImageScaleRange",
            display_name="Image Scale (Range)",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input(
                    "image", optional=True,
                    tooltip="The picture to scale. At least one of Image or Mask must be connected.",
                ),
                io.Mask.Input(
                    "mask", optional=True,
                    tooltip="Mask to scale with the same geometry. Must share the image's batch size.",
                ),
                io.Combo.Input(
                    "limit_mode", options=list(LIMIT_MODES), default="long", optional=True,
                    tooltip="Which dimension the size range applies to.",
                ),
                io.Int.Input(
                    "min_size", default=1024, min=10, max=10240, step=1, optional=True,
                    tooltip="Lower bound of the chosen dimension.",
                ),
                io.Int.Input(
                    "max_size", default=3000, min=10, max=10240, step=1, optional=True,
                    tooltip="Upper bound of the chosen dimension.",
                ),
                io.Int.Input(
                    "divisible", default=0, min=0, max=512, step=1, optional=True,
                    tooltip="Round each side to a multiple of this via cover-and-centre-crop. 0 disables it.",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="The scaled image, or None if only a mask was connected.",
                ),
                io.Mask.Output(
                    "mask",
                    tooltip="The mask scaled with the same geometry, or an all-black mask at the output size.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, limit_mode=None):
        # Name the combo so ComfyUI skips its list check; coerce() in execute
        # handles any legacy value before execution.
        return True

    @classmethod
    def execute(cls, image=None, mask=None, limit_mode="long", min_size=1024,
                max_size=3000, divisible=0):
        # 🔴 V3 不能套 @combo_legacy（它按 cls.FUNCTION 找方法，而 V3 的 FUNCTION
        # 是基类给的 EXECUTE_NORMALIZED）。直接在这里 coerce，语义与 V1 装饰器一致。
        limit_mode = coerce("QG_ImageScaleRange", "limit_mode", limit_mode)
        if image is None and mask is None:
            raise ValueError("Image Scale Range: connect an image, a mask, or both.")

        image = image.to(torch.float32).clamp(0.0, 1.0) if image is not None else None
        if image is not None and image.dim() == 3:
            image = image.unsqueeze(0)
        mask = _as_mask_bhw(mask)

        if image is not None and mask is not None and image.shape[0] != mask.shape[0]:
            raise ValueError(
                "Image Scale Range: image batch %d does not match mask batch %d."
                % (image.shape[0], mask.shape[0])
            )

        minimum = max(1, int(min_size))
        maximum = max(minimum, int(max_size))
        divisor = max(0, int(divisible))

        def plan(width, height):
            tw, th = _target_size(width, height, str(limit_mode), minimum, maximum)
            if divisor > 0:
                tw, th = _apply_divisor(tw, th, divisor, width / height)
            return max(1, tw), max(1, th)

        def process(frame, is_mask):
            # frame: 单帧 image [H,W,C] 或 mask [H,W]；统一成 [1,C,H,W] 再处理。
            if is_mask:
                work = frame.unsqueeze(0).unsqueeze(0)   # [H,W] -> [1,1,H,W]
            else:
                work = frame.permute(2, 0, 1).unsqueeze(0)  # [H,W,C] -> [1,C,H,W]
            width, height = int(work.shape[3]), int(work.shape[2])
            tw, th = plan(width, height)
            if (tw, th) != (width, height):
                if divisor > 0:
                    work = _resize_cover(work, tw, th)
                else:
                    work = _interpolate(work, tw, th)
            if divisor > 0:
                work = _center_crop_to_divisor(work, divisor)
            if is_mask:
                return work[0, 0]            # -> [H,W]
            return work[0].permute(1, 2, 0)  # -> [H,W,C]

        out_image = None
        if image is not None:
            out_image = torch.stack([process(image[i], False) for i in range(image.shape[0])], dim=0)

        out_mask = None
        if mask is not None and _is_black(mask):
            mask = None  # 全黑遮罩跳过缩放，后面按输出图尺寸直接造黑遮罩
        if mask is not None:
            out_mask = torch.stack([process(mask[i], True) for i in range(mask.shape[0])], dim=0)

        if out_image is not None:
            if out_mask is None:
                out_mask = torch.zeros(
                    (out_image.shape[0], out_image.shape[1], out_image.shape[2]),
                    dtype=torch.float32,
                )
        return io.NodeOutput(out_image, out_mask)


NODE_CLASS_MAPPINGS = {"QG_ImageScaleRange": QGImageScaleRange}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageScaleRange": "Image Scale (Range)"}
