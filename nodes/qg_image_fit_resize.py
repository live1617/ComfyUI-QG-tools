# -*- coding: utf-8 -*-
"""Image Fit Resize（图像适配缩放）—— 自写，2026-11-11。

用法形态参考 AusBoss's Image Resize（同样的目标模式表与「适应」语义），代码零复用：
几何规划、采样、填色解析都是本文件重新实现的。与 QG_ImageScale 的分工：
  - QG_ImageScale 按长边/短边/自定义宽高 + 裁剪/填充（对齐 Goohaitools V2）；
  - 本节点多了「像素预算（megapixels）」「倍数（scale_factor）」两种目标，
    以及不裁剪不留边的「适应画布（fit）」策略，适合「按 1MP 预算出图」这种场合。

语义要点（与 AusBoss 的节点一致，tooltip 里也写了）：
  - 只有 width_height 模式可能真的落到「盒子和源图比例不一致」，所以只有它
    会拉伸或发明像素；其余模式的目标盒子由源图比例推出，keep_proportion 一律
    按 fit 处理（整除数的小数尾巴靠半格以内的一次重采样消化）。
  - width_height 里填 0 的一边跟随源图比例；两边都 0 就是源尺寸。
  - divisible_by 把最终画布尺寸吸附到最近的倍数（不低于一格）。
  - pad 模式新填出来的边条在 mask 输出里是 1.0 —— 可以直接当 outpaint 遮罩用。
  - 没接 mask 时输出全零遮罩。
  - anchor 只影响 cover_crop 的裁剪方向与 pad 的补边方向；stretch / fit 没有
    「多出来的那部分」，锚点无处可用，读了也不生效（与 QG_ImageScale 一致）。
  - 最近邻用的是 ``nearest-exact``（ComfyUI 全生态 ``common_upscale`` 的同款相位），
    不是 torch 默认的 ``nearest`` —— 后者整体错开半个像素，跟别的节点拼在一起会
    看到一像素的位移。
"""

import math

import numpy as np
import torch
import torch.nn.functional as functional
from PIL import Image, ImageColor

from ._qg_combo_legacy import combo_legacy

TARGET_MODES = (
    "megapixels",
    "longest_edge",
    "shortest_edge",
    "width_height",
    "scale_factor",
)
PROPORTION_MODES = ("stretch", "fit", "cover_crop", "pad")
# center/top/bottom/left/right 与 QG_ImageScale 的 ANCHORS 同名同序，两边可以互抄存档。
ANCHORS = ("center", "top", "bottom", "left", "right")
# 🔴 nearest-exact 而不是 nearest：ComfyUI 的 common_upscale 一直用前者，torch 的
#    "nearest" 坐标映射是 floor(i*scale)、前者是 round((i+0.5)*scale-0.5)，两者整体
#    差半个像素（8x8 棋盘缩到 4x4，一个全取偶行、一个全取奇行）。要和别的节点
#    对齐就必须用生态同款。torch 1.11+ 的 interpolate 原生支持这个模式名。
INTERPOLATIONS = ("lanczos", "bicubic", "bilinear", "nearest-exact", "area")

_TORCH_MODES = {
    "bicubic": "bicubic",
    "bilinear": "bilinear",
    "nearest-exact": "nearest-exact",
    "area": "area",
}

# 颜色名的中英对照（PIL 只认英文名；常见几个补上，够用就行）
_COLOR_WORDS = {
    "黑": (0, 0, 0), "白": (255, 255, 255), "红": (255, 0, 0),
    "绿": (0, 128, 0), "蓝": (0, 0, 255), "灰": (128, 128, 128),
    "黄": (255, 255, 0), "橙": (255, 165, 0), "紫": (128, 0, 128),
}


def _round_half_up(value):
    """四舍五入（Python 内建 round 是银行家舍入，尺寸计算不能用它）。"""
    return int(math.floor(float(value) + 0.5))


def _snap(value, multiple):
    """吸附到最近的倍数，且不低于一格 —— 尺寸既不会归零，也不会漂过半格。"""
    step = max(1, int(multiple))
    return max(step, _round_half_up(int(value) / step) * step)


def _parse_color(text):
    """把用户填的颜色解析成 0..1 的 rgb。支持 #RGB / #RRGGBB / R,G,B /
    单个灰度 / CSS 颜色名 / 常见中文色名。解析不了返回 None，由调用方报错。"""
    raw = str(text or "").strip()
    if not raw:
        return None
    if raw in _COLOR_WORDS:
        r, g, b = _COLOR_WORDS[raw]
        return (r / 255.0, g / 255.0, b / 255.0)
    parts = [p for p in raw.replace("，", ",").split(",") if p.strip()]
    if len(parts) in (1, 3):
        try:
            nums = [float(p) for p in parts]
        except ValueError:
            nums = None
        if nums is not None:
            if len(nums) == 1:
                v = int(nums[0]) if nums[0] > 1.0 or nums[0] == 0.0 else nums[0]
                v = float(v)
                if v > 1.0:
                    v = v / 255.0
                v = min(1.0, max(0.0, v))
                return (v, v, v)
            vals = []
            for n in nums:
                v = n / 255.0 if n > 1.0 else n
                vals.append(min(1.0, max(0.0, v)))
            return tuple(vals)
    try:
        rgb = ImageColor.getrgb(raw)
        if len(rgb) >= 3:
            return (rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)
    except (ValueError, AttributeError):
        pass
    return None


def _resolve_target(source_w, source_h, mode, width, height, edge_length, megapixels, scale_factor):
    """请求的输出尺寸（尚未处理比例策略）。各模式的 0 都表示「保持源尺寸」。"""
    sw, sh = int(source_w), int(source_h)
    if sw <= 0 or sh <= 0:
        raise ValueError("Image Fit Resize needs a source larger than 0x0.")

    def scaled(scale):
        return (
            max(1, _round_half_up(sw * scale)),
            max(1, _round_half_up(sh * scale)),
        )

    if mode == "width_height":
        tw, th = max(0, int(width)), max(0, int(height))
        if tw <= 0 and th <= 0:
            return sw, sh
        if tw > 0 and th > 0:
            return tw, th
        if tw > 0:
            return tw, max(1, _round_half_up(sh * tw / sw))
        return max(1, _round_half_up(sw * th / sh)), th
    if mode == "longest_edge":
        edge = int(edge_length)
        if edge <= 0:
            return sw, sh
        tw, th = scaled(edge / max(sw, sh))
        # 选中的那条边正好落在请求值上，只有另一条参与取整
        return (edge, th) if sw >= sh else (tw, edge)
    if mode == "shortest_edge":
        edge = int(edge_length)
        if edge <= 0:
            return sw, sh
        tw, th = scaled(edge / min(sw, sh))
        return (edge, th) if sw <= sh else (tw, edge)
    if mode == "megapixels":
        target = float(megapixels)
        if target <= 0.0:
            return sw, sh
        return scaled(math.sqrt(target * 1e6 / (sw * sh)))
    # scale_factor
    factor = float(scale_factor)
    if factor <= 0.0:
        return sw, sh
    return scaled(factor)


def _anchored_start(extra_w, extra_h, anchor):
    """「多出来的那条带子」按锚点靠哪边 —— 裁剪与补边共用一套方向。

    ``extra`` 是正数（多出来的像素数），返回值是起点：裁剪时是源图里第一刀的
    偏移，补边时是内容在画布里的落点。锚点只动它自己那个轴，另一个轴保持居中
    （top / bottom 只决定纵向，横向仍居中），与 QG_ImageScale 的单值 anchor 一致。
    """
    if anchor == "top":
        return extra_w // 2, 0
    if anchor == "bottom":
        return extra_w // 2, extra_h
    if anchor == "left":
        return 0, extra_h // 2
    if anchor == "right":
        return extra_w, extra_h // 2
    return extra_w // 2, extra_h // 2


def _plan(source_w, source_h, target_w, target_h, proportion, divisible_by, anchor="center"):
    """把一次缩放拆成纯数字的几何：resize 尺寸、画布尺寸、裁剪/偏移量。"""
    sw, sh = int(source_w), int(source_h)
    tw, th = int(target_w), int(target_h)
    if sw <= 0 or sh <= 0 or tw <= 0 or th <= 0:
        raise ValueError("Image Fit Resize needs source and target sizes above zero.")
    if proportion not in PROPORTION_MODES:
        raise ValueError(
            "keep_proportion must be one of %s, got '%s'." % (PROPORTION_MODES, proportion)
        )

    plan = {"crop_x": 0, "crop_y": 0, "offset_x": 0, "offset_y": 0}

    if proportion == "fit":
        # 输出就是贴合后的尺寸，不补边 —— 整除数作用在贴合尺寸上
        scale = min(tw / sw, th / sh)
        canvas_w = _snap(max(1, _round_half_up(sw * scale)), divisible_by)
        canvas_h = _snap(max(1, _round_half_up(sh * scale)), divisible_by)
        plan.update(
            resize_width=canvas_w,
            resize_height=canvas_h,
            canvas_width=canvas_w,
            canvas_height=canvas_h,
        )
        return plan

    canvas_w = _snap(tw, divisible_by)
    canvas_h = _snap(th, divisible_by)
    plan.update(canvas_width=canvas_w, canvas_height=canvas_h)

    if proportion == "stretch":
        plan.update(resize_width=canvas_w, resize_height=canvas_h)
    elif proportion == "cover_crop":
        scale = max(canvas_w / sw, canvas_h / sh)
        # 减一个极小量：正好 0.5 这种比例别因为浮点噪声多裁一像素
        resize_w = max(canvas_w, math.ceil(sw * scale - 1e-6))
        resize_h = max(canvas_h, math.ceil(sh * scale - 1e-6))
        crop_x, crop_y = _anchored_start(resize_w - canvas_w, resize_h - canvas_h, anchor)
        plan.update(
            resize_width=resize_w,
            resize_height=resize_h,
            crop_x=crop_x,
            crop_y=crop_y,
        )
    else:  # pad
        scale = min(canvas_w / sw, canvas_h / sh)
        resize_w = min(canvas_w, max(1, _round_half_up(sw * scale)))
        resize_h = min(canvas_h, max(1, _round_half_up(sh * scale)))
        offset_x, offset_y = _anchored_start(canvas_w - resize_w, canvas_h - resize_h, anchor)
        plan.update(
            resize_width=resize_w,
            resize_height=resize_h,
            offset_x=offset_x,
            offset_y=offset_y,
        )
    return plan


def _lanczos_resize(batch, width, height):
    """逐通道走 PIL 的 F 模式 lanczos —— float 进 float 出，不经过 uint8。"""
    device = batch.device
    array = batch.detach().cpu().numpy().astype(np.float32, copy=False)
    frames = []
    for frame in array:
        channels = [
            np.asarray(
                Image.fromarray(np.ascontiguousarray(frame[:, :, index]), mode="F")
                .resize((width, height), Image.LANCZOS),
                dtype=np.float32,
            )
            for index in range(frame.shape[-1])
        ]
        frames.append(np.stack(channels, axis=-1))
    result = torch.from_numpy(np.stack(frames, axis=0))
    # Lanczos 会冲出 0..1，钳回来
    return result.clamp_(0.0, 1.0).to(device)


def _resample(batch, width, height, interpolation):
    """缩放 BHWC float 批次（遮罩当作 BHW1 参与同一套几何）。"""
    if batch.shape[2] == int(width) and batch.shape[1] == int(height):
        return batch  # 尺寸没变就原样返回，保证逐位一致
    batch = batch.float()
    if interpolation == "lanczos":
        return _lanczos_resize(batch, int(width), int(height))
    moved = batch.movedim(-1, 1).contiguous()
    kwargs = {}
    if interpolation in ("bilinear", "bicubic"):
        downscale = int(width) < moved.shape[-1] or int(height) < moved.shape[-2]
        kwargs = {"align_corners": False, "antialias": downscale}
    resized = functional.interpolate(
        moved, size=(int(height), int(width)), mode=_TORCH_MODES[interpolation], **kwargs
    )
    if interpolation == "bicubic":
        resized = resized.clamp_(0.0, 1.0)
    return resized.movedim(1, -1).contiguous()


def _pad_to(output, left, top, right, bottom, rgb):
    """把 output（BHWC）放到画布中央，四周按 rgb 填。返回画布与「新增区域」遮罩。"""
    b, h, w, c = output.shape
    canvas_h = h + top + bottom
    canvas_w = w + left + right
    canvas = torch.empty((b, canvas_h, canvas_w, c), dtype=output.dtype, device=output.device)
    canvas[:, :, :, 0] = rgb[0]
    canvas[:, :, :, 1] = rgb[1]
    canvas[:, :, :, 2] = rgb[2]
    if c > 3:
        canvas[:, :, :, 3] = 0.0
    canvas[:, top:top + h, left:left + w, :] = output
    # 生成区域遮罩：边条 1.0，源区 0.0
    new_area = torch.ones((b, canvas_h, canvas_w), dtype=torch.float32, device=output.device)
    new_area[:, top:top + h, left:left + w] = 0.0
    return canvas, new_area


@combo_legacy("QG_ImageFitResize")
class QGImageFitResize:
    """图像 + 遮罩一起缩放到目标预算/边长/宽高，输出缩放图、遮罩与最终宽高。"""

    CATEGORY = "QG-tools/Image/Transform"
    DESCRIPTION = (
        "Resize an image and an optional mask together to a pixel budget, an edge length, "
        "a width+height box or a scale factor. Pick how to meet a mismatched box: stretch, "
        "fit inside (no bars), cover and crop, or pad with a colour whose new bars "
        "come back as 1.0 in the mask. anchor picks which side survives a crop or takes the "
        "bars; divisible_by snaps the result to a clean multiple."
    )
    SEARCH_ALIASES = [
        "image", "resize", "scale", "fit", "megapixels", "budget", "crop", "pad",
        "letterbox", "divisible", "anchor", "图像", "缩放", "适配", "预算", "百万像素",
        "裁剪", "填充", "倍数", "锚点", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    OUTPUT_TOOLTIPS = (
        "The resized image batch.",
        "The mask through the same resize/crop/pad geometry; pad bars are 1.0 "
        "(a ready outpaint mask). All zeros when no mask is wired.",
        "Output width in pixels.",
        "Output height in pixels.",
    )

    @classmethod
    def VALIDATE_INPUTS(cls, target_mode=None, keep_proportion=None, interpolation=None,
                        anchor=None):
        # 四个下拉的译名在 nodes/_qg_combo_legacy.py 的 LEGACY 表里。这里具名报上去，
        # 让 ComfyUI 跳过「值必须在列表里」那道检查 —— 中文界面显示的是「适应画布」，
        # 直接往 API 里塞中文也不会炸。不写 **kwargs：那会把宽 / 高 / 整除数这些
        # 数字的 min/max 一起关掉。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "Image batch to resize, as [B,H,W,C].",
                    },
                ),
                "target_mode": (
                    list(TARGET_MODES),
                    {
                        "default": "megapixels",
                        "tooltip": "What sets the output size: megapixels reads the pixel budget, "
                                   "longest_edge / shortest_edge read the edge length, "
                                   "width_height reads the two size fields, scale_factor multiplies "
                                   "the source. Each mode only reads its own field.",
                    },
                ),
                "megapixels": (
                    "FLOAT",
                    {
                        "default": 1.0, "min": 0.0, "max": 64.0, "step": 0.01,
                        "tooltip": "Pixel budget in megapixels (megapixels mode). The image scales "
                                   "with its aspect kept until width x height is about this many "
                                   "million pixels. 0 keeps the source size.",
                    },
                ),
                "edge_length": (
                    "INT",
                    {
                        "default": 1024, "min": 0, "max": 16384, "step": 1,
                        "tooltip": "Target length for the longest_edge / shortest_edge modes; that "
                                   "edge lands exactly here and the other keeps the aspect. "
                                   "0 keeps the source size.",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 0, "min": 0, "max": 16384, "step": 1,
                        "tooltip": "Target width (width_height mode). 0 keeps the source width, or "
                                   "follows the height to keep the aspect when only height is set.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 0, "min": 0, "max": 16384, "step": 1,
                        "tooltip": "Target height (width_height mode). 0 keeps the source height, or "
                                   "follows the width to keep the aspect when only width is set.",
                    },
                ),
                "scale_factor": (
                    "FLOAT",
                    {
                        "default": 0.5, "min": 0.0, "max": 16.0, "step": 0.01,
                        "tooltip": "Multiplier for the scale_factor mode: 0.5 halves both sides, "
                                   "2.0 doubles them. 0 keeps the source size.",
                    },
                ),
                "keep_proportion": (
                    list(PROPORTION_MODES),
                    {
                        "default": "fit",
                        "tooltip": "How a width_height box that disagrees with the source aspect is "
                                   "met: stretch distorts to the exact box; fit shrinks the box to "
                                   "the aspect (no bars, output may be smaller); cover_crop fills "
                                   "the box and centre-crops the overflow; pad fits inside and fills "
                                   "the rest with fill_color, marking the bars in the mask. The "
                                   "other target modes derive the box from the source, so they "
                                   "always behave like fit.",
                    },
                ),
                "anchor": (
                    list(ANCHORS),
                    {
                        "default": "center",
                        "tooltip": "Which side of the spare space survives: center (default), top, "
                                   "bottom, left, right. Applies to cover_crop (which part of the "
                                   "overflow is kept) and to pad (which side the bars go on); "
                                   "stretch and fit have no spare space, so it does nothing there. "
                                   "A single value only moves its own axis - top/bottom keep the "
                                   "horizontal centre, left/right keep the vertical centre.",
                    },
                ),
                "divisible_by": (
                    "INT",
                    {
                        "default": 1, "min": 1, "max": 1024, "step": 1,
                        "tooltip": "Snaps each output dimension to the nearest multiple of this "
                                   "(never below one step). Set 16 for WAN, 8 for most latent "
                                   "spaces. 1 leaves sizes exactly as computed.",
                    },
                ),
                "interpolation": (
                    list(INTERPOLATIONS),
                    {
                        "default": "lanczos",
                        "tooltip": "Resampling filter: lanczos is the sharpest all-rounder, bicubic "
                                   "and bilinear are softer, nearest-exact keeps hard pixels (pixel "
                                   "art, masks) on the same half-pixel grid as the rest of ComfyUI, "
                                   "area is best for strong downscales.",
                    },
                ),
                "fill_color": (
                    "STRING",
                    {
                        "default": "#000000",
                        "tooltip": "Bar colour for pad mode: #RGB / #RRGGBB / R,G,B (0-255 or 0..1) "
                                   "/ one grayscale number / a CSS colour name. Ignored by the "
                                   "other modes.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "Optional mask carried through the exact same resize, crop and pad "
                                   "geometry as the image.",
                    },
                ),
            },
        }

    def execute(self, image, target_mode, megapixels, edge_length, width, height,
                scale_factor, keep_proportion, divisible_by, interpolation, fill_color,
                anchor="center", mask=None):
        # image 在 INPUT_TYPES 里是 **required**，到不了 None 分支。只接遮罩做缩放
        # 请用 QG_ImageScale（那个节点的 image / mask 都是选填）—— 这里曾经写过
        # 「只接遮罩就造黑图占位」的分支，但 required 让它永远进不去，纯属自欺，
        # 11-11 已删。anchor 带默认值是为了老的按位置调用的脚本还能跑。
        if not torch.is_tensor(image) or image.ndim != 4:
            raise ValueError("Image Fit Resize expected a [B,H,W,C] image batch.")
        image = image.float()
        source_h, source_w = int(image.shape[1]), int(image.shape[2])

        mode = str(target_mode)
        if mode not in TARGET_MODES:
            raise ValueError(
                "target_mode must be one of %s, got '%s'." % (TARGET_MODES, mode)
            )
        proportion = str(keep_proportion)
        if proportion not in PROPORTION_MODES:
            raise ValueError(
                "keep_proportion must be one of %s, got '%s'." % (PROPORTION_MODES, proportion)
            )
        interp = str(interpolation)
        if interp == "nearest":
            # 11-11 当天改名为 nearest-exact（对齐 ComfyUI 生态的相位），当天写的
            # 工作流与手写 API 里可能还是旧值，认下来别让它变成 "Value not in list"。
            interp = "nearest-exact"
        if interp not in INTERPOLATIONS:
            raise ValueError(
                "interpolation must be one of %s, got '%s'." % (INTERPOLATIONS, interp)
            )
        anchor = str(anchor)
        if anchor not in ANCHORS:
            raise ValueError(
                "anchor must be one of %s, got '%s'." % (ANCHORS, anchor)
            )

        target_w, target_h = _resolve_target(
            source_w, source_h, mode, width, height, edge_length, megapixels, scale_factor
        )
        # 除 width_height 外的模式，目标盒子由源图比例推出，没有「不一致」可处理：
        # 一律按 fit，整除数的小数尾巴靠半格内的重采样消化，绝不发明像素。
        if mode != "width_height":
            proportion = "fit"
        elif proportion == "pad" and (int(width) <= 0 or int(height) <= 0):
            # 单边为 0 时盒子形状也来自源图；补边只会补出 1~2 像素的细条
            proportion = "stretch"

        plan = _plan(source_w, source_h, target_w, target_h, proportion,
                     int(divisible_by), anchor)
        resize_w, resize_h = plan["resize_width"], plan["resize_height"]
        canvas_w, canvas_h = plan["canvas_width"], plan["canvas_height"]

        output = _resample(image, resize_w, resize_h, interp)

        work_mask = None
        if mask is not None:
            if mask.ndim != 3:
                raise ValueError("Image Fit Resize expected a [B,H,W] mask.")
            work_mask = mask.float()
            if (int(work_mask.shape[2]), int(work_mask.shape[1])) != (resize_w, resize_h):
                work_mask = _resample(work_mask.unsqueeze(-1), resize_w, resize_h, interp)
                work_mask = work_mask.squeeze(-1).clamp_(0.0, 1.0)

        def zeros_mask():
            return torch.zeros(
                (output.shape[0], canvas_h, canvas_w),
                dtype=torch.float32,
                device=output.device,
            )

        if (resize_w, resize_h) == (canvas_w, canvas_h):
            return (output, work_mask if work_mask is not None else zeros_mask(), canvas_w, canvas_h)

        if resize_w >= canvas_w and resize_h >= canvas_h:  # cover_crop
            x0, y0 = plan["crop_x"], plan["crop_y"]
            output = output[:, y0:y0 + canvas_h, x0:x0 + canvas_w, :].contiguous()
            if work_mask is not None:
                work_mask = work_mask[:, y0:y0 + canvas_h, x0:x0 + canvas_w].contiguous()
            return (output, work_mask if work_mask is not None else zeros_mask(), canvas_w, canvas_h)

        # pad
        rgb = _parse_color(fill_color)
        if rgb is None:
            raise ValueError(
                "fill_color could not be parsed: '%s'. Use #RGB, #RRGGBB, R,G,B, "
                "a grayscale number or a CSS colour name." % (fill_color,)
            )
        left, top = plan["offset_x"], plan["offset_y"]
        right = canvas_w - resize_w - left
        bottom = canvas_h - resize_h - top
        output, new_area = _pad_to(output, left, top, right, bottom, rgb)
        if work_mask is None:
            return (output, new_area, canvas_w, canvas_h)
        # 源区遮罩放在生成区遮罩里面（新边条保持 1.0）
        merged = new_area.clone()
        merged[:, top:top + resize_h, left:left + resize_w] = work_mask
        return (output, merged.clamp_(0.0, 1.0), canvas_w, canvas_h)


NODE_CLASS_MAPPINGS = {"QG_ImageFitResize": QGImageFitResize}

NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageFitResize": "Image Fit Resize"}
