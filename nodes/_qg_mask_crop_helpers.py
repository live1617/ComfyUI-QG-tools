# -*- coding: utf-8 -*-
"""Mask-driven crop geometry, edge filling and stitching for QG-tools.

A painted area is grown by a multiplier of its *short* side, the grown
rectangle is tidied to a multiple of N, and whatever still hangs outside the
frame is filled from the frame's own edge colours. ``stitch_back`` puts a
processed crop back where it came from, so a workflow can crop, upscale or
repaint, and paste the result over the original without the rest of the
picture ever going through a resize.

Rectangles are ``(x, y, width, height)`` and may stick out of the frame on any
side; every helper here clips while reading and never assumes the rectangle is
inside the picture.

All geometry stays local; cv2 is only used as an optional exact-distance
accelerator when present, with a pure torch disk fallback. Nothing in here
touches the filesystem or the network.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as functional

Rect = tuple[int, int, int, int]  # (x, y, width, height)

# A pixel this faint is treated as unpainted. Painted masks come out of
# MaskEditor with hard 0/1 edges, but a refined or matted one has a wide
# feathered fringe that must not stretch the crop to the far corner.
MASK_THRESHOLD = 0.01

# How many pixels of the frame's edge each side samples when working out the
# colour used to fill the room it added.
EDGE_SAMPLE = 8


def mask_bounds(mask: torch.Tensor, threshold: float = MASK_THRESHOLD):
    """Union bounding box of every frame in a BHW mask, as ``(x, y, w, h)``.

    Union rather than per frame on purpose: one crop is shared by the whole
    batch, otherwise every frame of a video gets its own framing and the
    result jitters. Returns ``None`` when nothing is painted.
    """
    solid = mask > float(threshold)
    if not bool(solid.any()):
        return None
    # solid is BHW: reducing the width axis leaves one flag per row (y), and
    # reducing the height axis leaves one per column (x). Getting these two
    # the wrong way round silently swaps width and height.
    rows = torch.nonzero(solid.any(dim=2).any(dim=0)).flatten()
    columns = torch.nonzero(solid.any(dim=1).any(dim=0)).flatten()
    x0, x1 = int(columns[0]), int(columns[-1])
    y0, y1 = int(rows[0]), int(rows[-1])
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1


def _ceil_to(value: int, multiple: int) -> int:
    if multiple <= 1:
        return int(value)
    return int(math.ceil(int(value) / int(multiple))) * int(multiple)


def _floor_to(value: int, multiple: int) -> int:
    if multiple <= 1:
        return max(1, int(value))
    return max(int(multiple), int(value) // int(multiple) * int(multiple))


def plan_crop(
    bounds: tuple[int, int, int, int],
    pads: tuple[float, float, float, float],
    size_mode: str,
    custom_width: int,
    custom_height: int,
    multiple: int = 8,
):
    """Work out where to cut, and how big the result has to be.

    ``pads`` is ``(top, right, bottom, left)``, each a multiplier of the
    painted area's short side where 1.0 adds nothing. Returns
    ``(rect, (target_height, target_width), mode)``; the mode comes back
    changed to ``native`` when ``custom`` was asked for but no size given.

    The rectangle is centred on the *grown* box, not on the original painted
    bounds: asymmetric pads move the framing by half their difference, the
    same way the reference crop node does.

    Rounding is deliberately asymmetric: ``native`` and ``square`` round **up**
    so the crop never loses painted pixels, ``custom`` rounds **down** because
    the target is a hard output size the sampler will be handed.
    """
    x0, y0, area_w, area_h = bounds
    short = min(area_w, area_h)
    top, right, bottom, left = (
        int(round(short * (float(value) - 1.0))) for value in pads
    )
    width = max(1, area_w + left + right)
    height = max(1, area_h + bottom + top)
    # 展开后的矩形中心 = ((x0 - left) + (x0 + area_w + right)) // 2。
    # 孤海「遮罩裁剪V2」先按四向扩展量拼出基础矩形再取中心；上下或左右
    # 扩展不对称时它和原遮罩 bbox 中心差 (扩展差)/2，取景会跟着错开同样
    # 的像素数。这次上扩 197、下扩 263，旧口径就比孤海高 33px。
    centre_x = ((x0 - left) + (x0 + area_w + right)) // 2
    centre_y = ((y0 - top) + (y0 + area_h + bottom)) // 2

    mode = str(size_mode)
    target_w = target_h = 0
    if mode == "custom":
        target_w = int(custom_width)
        target_h = int(custom_height)
        if target_w <= 0 and target_h <= 0:
            mode = "native"
        elif target_w <= 0:
            # Only one side given: treat it as the long side and derive the
            # other from the composed rectangle's aspect.
            target_h = _floor_to(max(target_h, multiple), multiple)
            target_w = _floor_to(max(1, round(width * target_h / height)), multiple)
        elif target_h <= 0:
            target_w = _floor_to(max(target_w, multiple), multiple)
            target_h = _floor_to(max(1, round(height * target_w / width)), multiple)
        else:
            target_w = _floor_to(max(target_w, multiple), multiple)
            target_h = _floor_to(max(target_h, multiple), multiple)
        if mode == "custom":
            # Cover, not fit: widen the shorter side until the rectangle has
            # the requested aspect, so the resize-to-target below never
            # distorts the picture. The extra room is filled from the edges.
            ratio = target_w / float(target_h)
            if width / float(height) < ratio:
                width = max(width, int(round(height * ratio)))
            else:
                height = max(height, int(round(width / ratio)))

    if mode == "native":
        width = _ceil_to(width, multiple)
        height = _ceil_to(height, multiple)
        target_w, target_h = width, height
    elif mode == "square":
        side = _ceil_to(max(width, height), multiple)
        width = height = side
        target_w = target_h = side

    rect = (centre_x - width // 2, centre_y - height // 2, width, height)
    return rect, (target_h, target_w), mode


def _dominant_colour(strip: torch.Tensor) -> torch.Tensor:
    """Most common colour of an ``(N, C)`` strip, quantised to 16 levels.

    Quantising first is what makes the mode a *background* colour instead of
    an accident of one noisy pixel; the returned value is the mean of the
    winning bucket, so it still lands between the steps.
    """
    channels = int(strip.shape[-1])
    # 桶号是 16 ** 参与量化的通道数。4 通道（RGBA）已经是 65536 个桶，再往上
    # bincount 就没法用了；超过 4 个通道时只拿前 3 个定桶，其余通道跟着一起取
    # 均值。以前这里是 min(3, C)，只返回 3 个值 —— 给 4 通道图填边时形状对不上，
    # 崩在这一行：out[..., :pad] = 三通道颜色。
    key_channels = min(3, channels)
    quantised = torch.clamp((strip[..., :key_channels] * 15.0).round().long(), 0, 15)
    index = torch.zeros(quantised.shape[0], dtype=torch.long, device=strip.device)
    for channel in range(key_channels):
        index = index * 16 + quantised[:, channel]
    counts = torch.bincount(index, minlength=16 ** key_channels)
    bucket = int(counts.argmax())
    picked = strip[index == bucket]
    if picked.numel() == 0:
        return torch.zeros(channels, dtype=strip.dtype, device=strip.device)
    # 取中选桶里**原始**像素的均值（量化档位只用来选桶，不用来回坐台阶）。
    return picked.mean(dim=0)


def crop_image(image: torch.Tensor, rect: Rect, fill_mode: str = "edge") -> torch.Tensor:
    """Cut ``rect`` out of a BHWC image, filling whatever lies outside it.

    ``fill_mode``:
      ``edge``    - each side that hangs out is painted with that side's most
                    common edge colour (what a plain background wants);
      ``stretch`` - the outermost row/column is repeated outwards (what a
                    gradient or a blurred backdrop wants);
      ``black``   - no fill at all.
    """
    x, y, width, height = rect
    batch, src_h, src_w, channels = image.shape
    out = torch.zeros(
        (batch, height, width, channels), dtype=image.dtype, device=image.device
    )

    x_start, y_start = max(0, x), max(0, y)
    x_end, y_end = min(src_w, x + width), min(src_h, y + height)
    if x_end <= x_start or y_end <= y_start:
        return out

    out[:, y_start - y:y_end - y, x_start - x:x_end - x] = image[:, y_start:y_end, x_start:x_end]
    if fill_mode == "black":
        return out

    pad_left, pad_top = x_start - x, y_start - y
    pad_right, pad_bottom = (x + width) - x_end, (y + height) - y_end

    if fill_mode == "stretch":
        # The side bands only cover the rows the frame actually has; the
        # corners above and below them belong to the top/bottom bands.
        band = slice(y_start - y, y_end - y)
        if pad_left > 0:
            out[:, band, :pad_left] = image[:, y_start:y_end, x_start:x_start + 1].expand(
                -1, -1, pad_left, -1
            )
        if pad_right > 0:
            out[:, band, width - pad_right:] = image[:, y_start:y_end, x_end - 1:x_end].expand(
                -1, -1, pad_right, -1
            )
        # The vertical bands copy a row that is already complete, so the
        # corners come out continuous with the sides above.
        if pad_top > 0:
            out[:, :pad_top] = out[:, pad_top:pad_top + 1].expand(-1, pad_top, -1, -1)
        if pad_bottom > 0:
            out[:, height - pad_bottom:] = out[:, height - pad_bottom - 1:height - pad_bottom].expand(
                -1, pad_bottom, -1, -1
            )
        return out

    sample = max(1, min(EDGE_SAMPLE, y_end - y_start, x_end - x_start))
    inside = image[:, y_start:y_end, x_start:x_end]
    colours = {
        "left": _dominant_colour(inside[:, :, :sample].reshape(-1, channels)),
        "right": _dominant_colour(inside[:, :, -sample:].reshape(-1, channels)),
        "top": _dominant_colour(inside[:, :sample, :].reshape(-1, channels)),
        "bottom": _dominant_colour(inside[:, -sample:, :].reshape(-1, channels)),
    }
    if pad_left > 0:
        out[:, :, :pad_left] = colours["left"]
    if pad_right > 0:
        out[:, :, width - pad_right:] = colours["right"]
    if pad_top > 0:
        out[:, :pad_top] = colours["top"]
    if pad_bottom > 0:
        out[:, height - pad_bottom:] = colours["bottom"]
    return out


def crop_mask(mask: torch.Tensor, rect: Rect) -> torch.Tensor:
    """Cut ``rect`` out of a BHW mask. Outside the frame the mask reads 0."""
    x, y, width, height = rect
    batch, src_h, src_w = mask.shape
    out = torch.zeros((batch, height, width), dtype=mask.dtype, device=mask.device)
    x_start, y_start = max(0, x), max(0, y)
    x_end, y_end = min(src_w, x + width), min(src_h, y + height)
    if x_end > x_start and y_end > y_start:
        out[:, y_start - y:y_end - y, x_start - x:x_end - x] = mask[:, y_start:y_end, x_start:x_end]
    return out


def resize_image(image: torch.Tensor, height: int, width: int) -> torch.Tensor:
    """Resize a BHWC image; shrinks read as area, grows read as bilinear.

    This is the package-wide default used by nodes that only need a size change
    (for example Image Merge Mask). Crop Restore deliberately opts into the
    antialiased variant below instead, because its result is pasted back over
    the untouched source and any extra blur there reads as a colour shift.
    """
    if image.shape[1] == height and image.shape[2] == width:
        return image
    work = image.permute(0, 3, 1, 2)
    shrinking = height <= image.shape[1] and width <= image.shape[2]
    if shrinking:
        work = functional.interpolate(work, size=(height, width), mode="area")
    else:
        work = functional.interpolate(
            work, size=(height, width), mode="bilinear", align_corners=False
        )
    return work.permute(0, 2, 3, 1)


def resize_image_aa(image: torch.Tensor, height: int, width: int) -> torch.Tensor:
    """LANCZOS-like crop resize: antialiased bicubic on the way back.

    Bicubic with antialias keeps more of the source's fine detail than plain
    bilinear, so a crop that shrinks for the sampler and grows back on paste
    loses less texture -- measurably closer to a LANCZOS round-trip. Scoped to
    Mask Crop / Crop Restore so other nodes keep their established behaviour.
    """
    if image.shape[1] == height and image.shape[2] == width:
        return image
    work = image.permute(0, 3, 1, 2)
    shrinking = height <= image.shape[1] and width <= image.shape[2]
    if shrinking:
        work = functional.interpolate(work, size=(height, width), mode="area")
    else:
        work = functional.interpolate(
            work, size=(height, width), mode="bicubic", align_corners=False,
            antialias=True
        ).clamp(0.0, 1.0)
    return work.permute(0, 2, 3, 1)


def resize_mask(mask: torch.Tensor, height: int, width: int) -> torch.Tensor:
    """Resize a BHW mask without ever quantising it to 8 bits."""
    if mask.shape[-2] == height and mask.shape[-1] == width:
        return mask
    work = mask.unsqueeze(1)
    shrinking = height <= mask.shape[-2] and width <= mask.shape[-1]
    if shrinking:
        work = functional.interpolate(work, size=(height, width), mode="area")
    else:
        work = functional.interpolate(
            work, size=(height, width), mode="bilinear", align_corners=False
        )
    return work.squeeze(1).clamp(0.0, 1.0)


def feather_mask_softtail(mask: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian feather whose kernel tapers smoothly to zero at its radius.

    A plain gaussian still carries weight at the cut-off, so truncating it
    makes the first transparent pixel jump to a nonzero value - a faint hard
    ring around a pasted crop. Tapering the kernel's outer half with a
    smoothstep drives the tail to zero before the cut-off, so the transition
    reads as continuous. Used only on Crop Restore's paste mask; the shared
    blur_mask is left untouched for every other node.
    """
    if sigma <= 0.0:
        return mask
    radius = max(1, int(math.ceil(float(sigma))))
    coords = torch.arange(-radius, radius + 1, dtype=torch.float64, device=mask.device)
    ratio = coords.abs() / (radius + 0.5)
    tail = ((ratio - 0.5) * 2.0).clamp(0.0, 1.0)
    smooth = 1.0 - tail ** 3 * (tail * (tail * 6.0 - 15.0) + 10.0)
    kernel = torch.exp(-0.5 * (coords / radius) ** 2) * smooth
    kernel = (kernel / kernel.sum()).to(mask.dtype)
    blurred = mask.unsqueeze(1)
    blurred = functional.pad(blurred, (radius, radius, 0, 0), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, 1, -1))
    blurred = functional.pad(blurred, (0, 0, radius, radius), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, -1, 1))
    return blurred.squeeze(1).clamp(0.0, 1.0)


def percent_to_pixels(percent: float, bounds: Rect) -> int:
    """孤海口径：百分比按涂色区域平均边长换算，最小 1 像素。

    ``bounds`` is the painted area's ``(x, y, w, h)``. GH_CropRestore stores
    the same white-area size in its seam and uses ``int((w+h)/2*pct/100)``;
    keeping that exact floor makes the same number mean the same thing in
    both nodes.
    """
    value = float(percent)
    if value <= 0.0:
        return 0
    _, _, w, h = bounds
    average = (int(w) + int(h)) / 2.0
    return max(1, int(average * value / 100.0))


def expand_mask_euclidean(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """Expand a binary-ish BHW mask by a Euclidean disk, GH style.

    GH uses ``cv2.distanceTransform(1 - fg, DIST_L2, 3)`` and fills anything
    within the radius. When cv2 is installed on the CPU path we use that exact
    same call, so the shapes match bit for bit. Without it, the row-wise max
    filter below is a pure torch disk union: for every vertical offset the
    allowed horizontal half-width is ``floor(sqrt(r*r - dy*dy))``.
    """
    radius = int(pixels)
    if radius <= 0:
        return mask
    flat = mask.ndim == 2
    work = (mask > 1e-6).to(mask.dtype)
    if flat:
        work = work.unsqueeze(0)

    if work.device.type == "cpu":
        try:
            import cv2
        except ImportError:
            cv2 = None
        if cv2 is not None:
            out = torch.zeros_like(work)
            for b in range(int(work.shape[0])):
                fg = work[b].detach().cpu().numpy().astype(np.uint8)
                dist = cv2.distanceTransform(1 - fg, cv2.DIST_L2, 3)
                filled = torch.from_numpy(
                    (dist <= float(radius)).astype(np.float32)
                ).to(work.dtype)
                out[b] = filled
            return out.squeeze(0) if flat else out

    height = int(work.shape[-2])
    out = torch.zeros_like(work)
    for dy in range(-radius, radius + 1):
        half = int(math.floor(math.sqrt(max(0, radius * radius - dy * dy))))
        shifted = torch.zeros_like(work)
        if dy > 0:
            if dy < height:
                shifted[:, :-dy, :] = work[:, dy:, :]
        elif dy < 0:
            take = -dy
            if take < height:
                shifted[:, take:, :] = work[:, :-take, :]
        else:
            shifted = work
        if half == 0:
            row = shifted
        else:
            padded = functional.pad(
                shifted.unsqueeze(1), (half, half, 0, 0), mode="constant", value=0.0
            )
            row = functional.max_pool2d(
                padded, kernel_size=(1, 2 * half + 1), stride=1
            ).squeeze(1)
        out = torch.maximum(out, row)
    return out.squeeze(0) if flat else out


def fade_mask_at_crop_edges(
    mask: torch.Tensor, rect: Rect, frame_hw: tuple[int, int], fade_px: int
) -> torch.Tensor:
    """GH's smoothstep fade on crop edges that fall inside the picture.

    A crop cut out of the picture has artificial borders: there is no
    processed pixel beyond them. Fading the paste mask to zero there avoids
    a hard seam; borders that coincide with the canvas edge need no fade.
    """
    fade = int(fade_px)
    if fade <= 0:
        return mask
    x, y, w, h = (int(v) for v in rect)
    frame_h, frame_w = (int(v) for v in frame_hw)
    vx0, vy0 = max(0, -x), max(0, -y)
    vx1, vy1 = min(w, frame_w - x), min(h, frame_h - y)
    if vx1 <= vx0 or vy1 <= vy0:
        return mask

    flat = mask.ndim == 2
    out = mask.unsqueeze(0) if flat else mask.clone()
    valid = out[..., vy0:vy1, vx0:vx1]

    def window(length: int, low: bool, high: bool) -> torch.Tensor:
        pos = torch.arange(length, dtype=out.dtype, device=out.device)
        weight = torch.ones_like(pos)
        if low:
            weight = torch.minimum(weight, pos / float(fade))
        if high:
            weight = torch.minimum(weight, (length - 1 - pos) / float(fade))
        weight = weight.clamp(0.0, 1.0)
        return weight ** 3 * (weight * (weight * 6.0 - 15.0) + 10.0)

    if y > 0 or y + h < frame_h:
        valid = valid * window(vy1 - vy0, y > 0, y + h < frame_h).view(1, -1, 1)
    if x > 0 or x + w < frame_w:
        valid = valid * window(vx1 - vx0, x > 0, x + w < frame_w).view(1, 1, -1)
    out[..., vy0:vy1, vx0:vx1] = valid
    return out.squeeze(0) if flat else out


# 校色候选的判据：亮度结构（高频细节）一致才认为是「同一画面整体偏色」。
# 整体偏色是每条通道加同一个偏移，高频细节原样保留；新增/移除的重绘内容
# 会把局部结构换掉。用结构差异把后者排除，校色才不会去压暗一朵新画的花。
COLOUR_DETAIL_SCALE = 0.02     # 高频差超过这个量级就开始降权
COLOUR_STRUCTURE_MIN = 0.8     # 结构相似度低于此值不当作「同一画面」
COLOUR_DIFF_CAP = 24.0 / 255.0   # 单通道差超过 24 级的不算「轻微偏色」
COLOUR_LUMA_CAP = 18.0 / 255.0   # 明度差超过 18 级的不算「轻微偏色」
COLOUR_SAMPLE_FRAC = 0.05      # 候选少于 5% 就不校，宁可不动也不瞎猜
COLOUR_WORK_SIZE = 256         # 估算用的降采样边长上限，省算力又滤掉单像素噪声
COLOUR_GAIN_MIN = 0.9          # 增益钳制区间：平坦背景不该被放大噪声
COLOUR_GAIN_MAX = 1.1
COLOUR_OFFSET_CAP = 24.0 / 255.0
COLOUR_ITERATIONS = 6          # 增益/偏移的鲁棒迭代轮数
COLOUR_STABLE_FRAC = 0.6       # 稳定样本不足 60% 就放弃整块校正


def _colour_detail(gray: torch.Tensor) -> torch.Tensor:
    """灰度图减去 5×5 盒式模糊 = 高频细节；整体平移不改它。"""
    padded = functional.pad(gray, (2, 2, 2, 2), mode="replicate")
    box = sum(padded[..., dy:dy + gray.shape[-2], dx:dx + gray.shape[-1]]
              for dy in range(5) for dx in range(5))
    return gray - box / 25.0


def match_colour(patch: torch.Tensor, reference: torch.Tensor, strength: float) -> torch.Tensor:
    """Align a *global* colour cast, never the repainted content.

    Only pixels that are still the same picture as the source qualify: their
    local detail must match (a repaint replaces structure) and their colour
    and luminance must be only slightly adrift (a genuinely different patch
    is not a cast). From those samples a robust gain+offset pair is fitted by
    iterated reweighted least squares; the fit is thrown away unless a large
    fraction of samples agree with it. Flat backgrounds fall back to offset
    only, so noise is never amplified.
    """
    if strength <= 0.0 or patch.shape[-1] < 3:
        return patch

    src = patch[..., :3]
    ref = reference[..., :3]
    if src.shape[-2:] != ref.shape[-2:]:
        return patch

    # 输入是 [B,H,W,C]：插值要临时换到 [B,C,H,W]，换回后仍是 BHWC。
    h, w = int(src.shape[-2]), int(src.shape[-1])
    scale = min(1.0, COLOUR_WORK_SIZE / max(h, w))
    if scale < 1.0:
        size = (max(1, round(w * scale)), max(1, round(h * scale)))
        src_s = functional.interpolate(src.permute(0, 3, 1, 2), size=size, mode="area").permute(0, 2, 3, 1)
        ref_s = functional.interpolate(ref.permute(0, 3, 1, 2), size=size, mode="area").permute(0, 2, 3, 1)
    else:
        src_s, ref_s = src, ref

    # Rec.601 亮度：只用来比结构和明度差，不参与最终增益/偏移。
    lum = torch.tensor([0.299, 0.587, 0.114], dtype=src_s.dtype, device=src_s.device)
    src_gray = (src_s * lum).sum(dim=-1)
    ref_gray = (ref_s * lum).sum(dim=-1)
    detail_gap = _colour_detail(src_gray) - _colour_detail(ref_gray)
    structure = 1.0 / (1.0 + (detail_gap / COLOUR_DETAIL_SCALE).square())

    # 三个判据同时成立才算「轻微偏色」样本；通道/明度阈值比旧版严得多，
    # 免得把重绘内容当整体偏色一起校掉。
    candidate = (structure > COLOUR_STRUCTURE_MIN) \
        & ((src_s - ref_s).abs().amax(dim=-1) <= COLOUR_DIFF_CAP) \
        & ((src_gray - ref_gray).abs() <= COLOUR_LUMA_CAP)

    # 3×3 腐蚀：贴着重绘边界的像素混了两边的颜色，不能拿来估算。
    if bool(candidate.any()):
        near = functional.max_pool2d(
            candidate.to(torch.float32).unsqueeze(1), kernel_size=3, stride=1, padding=1
        ).squeeze(1) > 0.5
        candidate = candidate & near

    sample_count = int(candidate.sum().item())
    frames = int(src.shape[0])
    # 判据按每帧独立成立：batch 变大不能把「最少样本」也放大，否则第 2 帧
    # 起会永远凑不够全局阈值，明明是整体偏色却整批不校。
    need_per = max(16, int(candidate.shape[-2] * candidate.shape[-1] * COLOUR_SAMPLE_FRAC))
    if sample_count < need_per * frames:
        return patch

    fitted = []
    for b in range(frames):
        count = int(candidate[b].sum().item())
        if count < need_per:
            fitted.append(None)
            continue
        sv = src_s[b][candidate[b]].to(torch.float64)
        rv = ref_s[b][candidate[b]].to(torch.float64)
        sw = structure[b][candidate[b]].to(torch.float64)
        gain = torch.ones(3, dtype=torch.float64, device=sv.device)
        offset = torch.median(rv - sv, dim=0).values
        for _ in range(COLOUR_ITERATIONS):
            residual = rv - (sv * gain + offset)
            center = torch.median(residual, dim=0).values
            mad = torch.median((residual - center).abs(), dim=0).values * 1.4826
            scale = torch.clamp(mad, min=0.004)
            deviation = ((residual - center).abs() / (4.685 * scale)).amax(dim=1)
            weight = (1.0 - deviation.square()).clamp(min=0.0).square() * sw
            wsum = float(weight.sum().item())
            if wsum < max(16, len(sv) * 0.1):
                gain = None
                break
            wn = weight / wsum
            sm = (sv * wn[:, None]).sum(dim=0)
            rm = (rv * wn[:, None]).sum(dim=0)
            var = ((sv - sm).square() * wn[:, None]).sum(dim=0)
            cov = ((sv - sm) * (rv - rm) * wn[:, None]).sum(dim=0)
            gain = ((cov + 1e-4) / (var + 1e-4)).clamp(COLOUR_GAIN_MIN, COLOUR_GAIN_MAX)
            offset = (rm - sm * gain).clamp(-COLOUR_OFFSET_CAP, COLOUR_OFFSET_CAP)
        if gain is None:
            fitted.append(None)
            continue
        stable = ((rv - (sv * gain + offset)).abs().amax(dim=1) < 0.035) & (sw > 0.5)
        ok = int(stable.sum().item()) >= max(need_per, int(len(sv) * COLOUR_STABLE_FRAC))
        fitted.append((gain, offset) if ok else None)

    out = patch.clone()
    mix = min(float(strength), 1.0)
    for b, fit in enumerate(fitted):
        if fit is None:
            continue
        gain = (1.0 + (fit[0] - 1.0) * mix).to(torch.float32)
        offset = (fit[1] * mix).to(torch.float32)
        out[b, ..., :3] = (out[b, ..., :3] * gain + offset).clamp(0.0, 1.0)
    return out


def stitch_back(
    background: torch.Tensor,
    patch: torch.Tensor,
    mask: torch.Tensor,
    rect: Rect,
    colour_strength: float = 0.0,
    dither: bool = False,
) -> torch.Tensor:
    """Blend a processed crop over ``background`` at ``rect``.

    Only the part of ``rect`` that lands inside the picture is written, so a
    crop that hung outside the frame loses nothing on the way back. Every
    pixel outside the mask is copied from ``background`` verbatim. ``dither``
    adds GH's sub-1/255 pattern in the soft transition so uint8 saving does
    not quantise the feather into a visible ring.
    """
    x, y, width, height = rect
    _, dst_h, dst_w, _ = background.shape
    if patch.shape[1] != height or patch.shape[2] != width:
        patch = resize_image_aa(patch, height, width)
    if tuple(mask.shape[-2:]) != (height, width):
        mask = resize_mask(mask, height, width)
    if patch.shape[0] != background.shape[0]:
        # 帧数对不上时要选方向，而不是永远把结果砍成第一帧（8 帧结果丢 7 帧
        # 且没有任何提示）。
        if patch.shape[0] == 1:
            patch = patch.expand(background.shape[0], -1, -1, -1)
        elif background.shape[0] == 1:
            # 单帧背景接了多帧结果：把背景铺成同样的帧数。
            background = background.expand(patch.shape[0], -1, -1, -1)
        else:
            raise ValueError(
                "the processed crop has %d frames but the picture has %d; "
                "crop and stitch have to agree on the frame count"
                % (patch.shape[0], background.shape[0])
            )

    x_start, y_start = max(0, x), max(0, y)
    x_end, y_end = min(dst_w, x + width), min(dst_h, y + height)
    if x_end <= x_start or y_end <= y_start:
        return background

    src_x, src_y = x_start - x, y_start - y
    span_w, span_h = x_end - x_start, y_end - y_start
    patch_region = patch[:, src_y:src_y + span_h, src_x:src_x + span_w]
    mask_region = mask[:, src_y:src_y + span_h, src_x:src_x + span_w].unsqueeze(-1)

    # 采样器回的可能真是 RGBA（Qwen Image 2.1 的 VAE 解出来就是 4 通道），
    # 而背景是 RGB，或者反过来。混之前先统一到背景的通道数：多的丢掉，
    # 少的从背景对应位置补。不统一的话，下面那一行加法直接 RuntimeError。
    channels = int(background.shape[-1])
    if int(patch_region.shape[-1]) != channels:
        if int(patch_region.shape[-1]) > channels:
            patch_region = patch_region[..., :channels]
        else:
            fill = background[:, y_start:y_end, x_start:x_end][..., int(patch_region.shape[-1]):]
            patch_region = torch.cat([patch_region, fill], dim=-1)

    out = background.clone()
    base = out[:, y_start:y_end, x_start:x_end]
    if colour_strength > 0.0:
        patch_region = match_colour(patch_region, base, colour_strength)
    blended = base * (1.0 - mask_region) + patch_region * mask_region
    if dither:
        xs = torch.arange(x_start, x_end, dtype=torch.float64, device=out.device)
        ys = torch.arange(y_start, y_end, dtype=torch.float64, device=out.device)
        pattern = torch.remainder(
            52.9829189 * torch.remainder(
                xs[None, :] * 0.06711056 + ys[:, None] * 0.00583715, 1.0
            ),
            1.0,
        ).to(blended.dtype) / 255.0
        transition = (mask_region > 0.0) & (mask_region < 1.0)
        channels = min(3, int(blended.shape[-1]))
        cap = torch.maximum(base[..., :channels], patch_region[..., :channels])
        noisy = torch.minimum(
            blended[..., :channels] + pattern[None, :, :, None], cap
        )
        blended[..., :channels] = torch.where(
            transition.expand_as(blended[..., :channels]), noisy, blended[..., :channels]
        )
    out[:, y_start:y_end, x_start:x_end] = blended
    return out
