# -*- coding: utf-8 -*-
"""QG_OutpaintBoard - grow a picture's canvas outwards, with the mask to match.

Written for ComfyUI-QG-tools on 2026-11-01 from scratch. The workflow it
serves is the one 孤海工具箱 (Goohaitools) covers with 外补画板（可视化）:
drag the four sides of the canvas out, watch the result live, hand the padded
picture and its repaint mask to the sampler.

What is deliberately different from that node:

  * The canvas frame is amber (``#FFA23A``) rather than cyan, the settings
    live in a sheet that floats beside the node instead of on the panel, and
    the node carries its own name so the two are not confused at a glance.
  * Clicking a strip that is already padding shrinks it back; dragging the
    frame works in both directions. This pack made shrinking reachable on
    purpose - an expanded canvas that cannot be taken back is a one-way door.
  * Zoom is pinned while the canvas grows: a click extends the frame and
    leaves the picture exactly where it was on screen. Only the wheel and the
    percentage dropdown move the scale. The ceiling is whatever the preview
    area can show - to go past it, zoom out first.
  * Sizing never resamples: the picture is copied into a bigger tensor, so
    output pixels are bit-identical to the input ones.

Three sizing rules, applied in this order:

  0. A negative side value crops that edge of the source image (the picture
     itself is sliced, and the mask with it). Crops are capped so at least
     ``ceil(size * 0.1)`` pixels survive on each axis - Goohaitools 88f2dd1's
     ``_limit_crops``. Positive values still grow the canvas as before.
  1. ``unit`` turns the four side values into pixels (``percent`` reads left
     and right against the width, top and bottom against the height).
  2. ``max_output_side`` > 0 shrinks the padding only - the picture keeps its
     size and its pixels. A picture already over the limit loses all padding
     and says so, rather than silently cropping.
  3. ``divisible_by`` > 1 rounds the canvas **up** to that multiple and puts
     the difference on the right and bottom, so the picture still does not
     move.

Why ``compute_layout`` here instead of ``_qg_pad_helpers.resolve_pad_geometry``:
that one snaps each axis to the *nearest* multiple and trims the source when
the nearest lands below it, which moves the picture. This node's contract is
"round up, put the extra on the right and bottom, never touch the picture",
so the two cannot share an implementation without changing what this node
promises. The colour parser *is* shared: ``_qg_color_helpers.parse_fill_color``
gives every node in the pack the same lenient handling of ``pad_color``.

The panel lives in ``web/outpaint_board/index.js``.
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from comfy_api.latest import io

from ._qg_color_helpers import parse_fill_color
from ._qg_combo_legacy import coerce
from ._qg_tensor_helpers import as_image_batch

# Hard stop, not a real limit: it only keeps a typo (999999) from asking for a
# canvas that will not fit in memory.
PAD_LIMIT = 16384
# A negative side pads means "crop that edge of the source" (Goohaitools 88f2dd1).
# Same hard-stop idea as PAD_LIMIT: far past any real crop, just blocks typos.
CROP_LIMIT = 3000
# At least this share of the source must survive a crop on each axis. Mirrors
# Goohaitools' ``_limit_crops``: budget = size - ceil(size * 0.1).
MIN_SOURCE_RATIO = 0.1


# ----------------------------------------------------------------------
# Sizing
# ----------------------------------------------------------------------
def _to_px(value, unit, base):
    """One side value as pixels. ``percent`` is measured on that axis.

    Negative stays negative - it means crop that edge. Clamped to
    ``[-CROP_LIMIT, PAD_LIMIT]`` so a typo cannot ask for an absurd canvas.
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 0.0
    px = int(round(base * v / 100.0)) if unit == "percent" else int(round(v))
    return min(PAD_LIMIT, max(-CROP_LIMIT, px))


def _nearest(value):
    """Python 2-style round-half-up, matching Goohaitools' ``_nearest``."""
    return int(math.floor(value + 0.5))


def _limit_crops(width, height, pads):
    """Cap each axis' negative pads so at least 10% of the source survives.

    ``pads`` is ``[l, r, t, b]``. Only negative entries count as crops; their
    total per axis may not exceed ``size - ceil(size * MIN_SOURCE_RATIO)``,
    i.e. ``ceil(size * 0.1)`` pixels of source remain. When over budget both
    sides shrink proportionally (integer, never negative). 1:1 with
    Goohaitools 88f2dd1's ``_limit_crops``. Returns a new list.
    """
    pads = list(pads)
    for first, second, size in ((0, 1, width), (2, 3, height)):
        a, b = max(0, -pads[first]), max(0, -pads[second])
        budget = size - int(math.ceil(size * MIN_SOURCE_RATIO))
        if a + b > budget:
            cropped_first = _nearest(budget * a / float(a + b))
            if a:
                pads[first] = -cropped_first
            if b:
                pads[second] = -(budget - cropped_first)
    return pads


def _scale_pair(a, b, allow):
    """Shrink two opposite pads together, keeping their ratio.

    ``allow`` 0 or less takes both to zero. Never returns a negative.
    """
    total = a + b
    if total <= allow:
        return a, b
    if allow <= 0:
        return 0, 0
    k = allow / float(total)
    na = int(math.floor(a * k))
    nb = int(allow - na)
    return max(0, na), max(0, nb)


def compute_layout(w, h, unit, left, right, top, bottom, max_side=0, divisor=0):
    """Return ``(l, r, t, b, out_w, out_h, warnings)``.

    Pure function, no tensors, so it can be tested on its own.
    """
    l = _to_px(left, unit, w)
    r = _to_px(right, unit, w)
    t = _to_px(top, unit, h)
    b = _to_px(bottom, unit, h)

    # Negative pads crop the source. Cap them before anything else so at least
    # 10% of each axis survives -- otherwise "crop 3000" on a 100px picture
    # would ask for a negative canvas.
    l, r, t, b = _limit_crops(w, h, [l, r, t, b])

    crop_l, crop_r, crop_t, crop_b = max(0, -l), max(0, -r), max(0, -t), max(0, -b)
    kept_w, kept_h = w - crop_l - crop_r, h - crop_t - crop_b

    try:
        max_side = int(max_side or 0)
    except (TypeError, ValueError):
        max_side = 0
    try:
        divisor = int(divisor or 0)
    except (TypeError, ValueError):
        divisor = 0

    warns = []

    # Long-side ceiling: padding gives way, the picture does not. With crops
    # the "picture" is what survives the slice (kept_w x kept_h), so the head-
    # room is measured against that. Negative pads (crops) are left untouched -
    # they already shrink the canvas; only positive padding is trimmed.
    if max_side > 0:
        if kept_w > max_side or kept_h > max_side:
            # The kept picture itself is over the line, so the ceiling is
            # already impossible. Positive padding all goes; crops stay.
            l = min(0, l)
            r = min(0, r)
            t = min(0, t)
            b = min(0, b)
            warns.append(
                "picture %dx%d is already past max_output_side %d; all padding "
                "dropped (scale it down with another node)" % (kept_w, kept_h, max_side)
            )
        else:
            pos_l, pos_r = max(0, l), max(0, r)
            pos_t, pos_b = max(0, t), max(0, b)
            nl, nr = _scale_pair(pos_l, pos_r, max_side - kept_w)
            nt, nb = _scale_pair(pos_t, pos_b, max_side - kept_h)
            l, r = min(0, l) + nl, min(0, r) + nr
            t, b = min(0, t) + nt, min(0, b) + nb

    out_w, out_h = w + l + r, h + t + b

    # Round up to the multiple, difference on right and bottom: the picture
    # does not move, which is the whole point of this node.
    if divisor > 1:
        nw = int(math.ceil(out_w / float(divisor)) * divisor)
        nh = int(math.ceil(out_h / float(divisor)) * divisor)
        if nw != out_w or nh != out_h:
            r += nw - out_w
            b += nh - out_h
            out_w, out_h = nw, nh
        if max_side > 0 and max(out_w, out_h) > max_side:
            warns.append(
                "divisible_by %d rounded the canvas to %dx%d, past "
                "max_output_side %d; the multiple wins, the ceiling did not "
                "apply" % (divisor, out_w, out_h, max_side)
            )

    return l, r, t, b, out_w, out_h, warns


# ----------------------------------------------------------------------
# Mask
# ----------------------------------------------------------------------
def _fit_mask(mask, batch, h, w, device):
    """Normalise an input mask to ``[batch, h, w]``.

    Nearest-neighbour when the size differs - interpolating here would invent
    partial coverage the user never painted.
    """
    m = mask
    if m.dim() == 2:
        m = m.unsqueeze(0)
    elif m.dim() == 4:                    # [B, H, W, 1] from some loaders
        m = m[..., 0]
    if tuple(m.shape[-2:]) != (h, w):
        m = F.interpolate(m.unsqueeze(1).float(), size=(h, w), mode="nearest")
        m = m.squeeze(1)
    m = m.float().to(device)
    if m.shape[0] == 1 and batch > 1:
        m = m.expand(batch, h, w)
    elif m.shape[0] != batch:
        m = m[:1].expand(batch, h, w)
    return m.clamp(0.0, 1.0)


# ----------------------------------------------------------------------
# Node
# ----------------------------------------------------------------------
# V1 @combo_legacy("QG_OutpaintBoard")：unit 有中文遗留值需 coerce。
# V3 去装饰器，run 内 coerce，与 V1 等价。
class QGOutpaintBoard(io.ComfyNode):

    SEARCH_ALIASES = ["outpaint", "canvas", "pad", "extend", "扩图", "外扩", "补边", "qg"]

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Grow the canvas outwards and hand back both the padded picture and a "
        "mask of the new area. Input pixels are copied, never resampled, so "
        "the picture sits exactly where it did. Drive it from the panel: drag "
        "the four sides, or click outside the frame to snap that side to the "
        "cursor."
    )

    @classmethod
    def validate_inputs(cls, unit=None):
        # unit 中文遗留值在 LEGACY 表；具名跳过列表校验，值由 run 内 coerce 换回。
        return True

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_OutpaintBoard",
            display_name="Outpaint Board",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input("image", tooltip="The picture to grow. Padding is added around it; the picture itself is copied into the bigger canvas, never resampled or cropped."),
                io.Combo.Input("unit", options=["pixels", "percent"], default="pixels",
                    tooltip="pixels: the four side values are literal pixels. percent: left/right read against the width, top/bottom against the height."),
                io.Int.Input("left", default=0, min=-CROP_LIMIT, max=PAD_LIMIT, step=1,
                    tooltip="How far to grow the left side. pixels: literal pixels; percent: a share of the width. Negative crops that edge of the source (at least 10% of each axis is kept). 0 = none."),
                io.Int.Input("right", default=0, min=-CROP_LIMIT, max=PAD_LIMIT, step=1,
                    tooltip="How far to grow the right side. pixels: literal pixels; percent: a share of the width. Negative crops that edge of the source (at least 10% of each axis is kept). 0 = none."),
                io.Int.Input("top", default=0, min=-CROP_LIMIT, max=PAD_LIMIT, step=1,
                    tooltip="How far to grow the top side. pixels: literal pixels; percent: a share of the height. Negative crops that edge of the source (at least 10% of each axis is kept). 0 = none."),
                io.Int.Input("bottom", default=0, min=-CROP_LIMIT, max=PAD_LIMIT, step=1,
                    tooltip="How far to grow the bottom side. pixels: literal pixels; percent: a share of the height. Negative crops that edge of the source (at least 10% of each axis is kept). 0 = none."),
                io.Int.Input("max_output_side", default=0, min=0, max=PAD_LIMIT, step=128,
                    tooltip="0 = no ceiling. When the canvas would go past it, only the padding is trimmed - the picture is never cropped or rescaled. A picture already over the limit drops all padding and says so."),
                io.Int.Input("divisible_by", default=0, min=0, max=256, step=1,
                    tooltip="0 = leave the canvas alone. Above 1 the canvas is rounded up to a multiple of this, and the extra goes on the right and bottom, so the picture keeps its position. 8 / 16 / 32 / 64 are the usual picks."),
                io.String.Input("pad_color", default="#808080",
                    tooltip="Fill for the new area. Takes #RRGGBB, #ABC, a colour name such as gray, 128,128,128, or 0.5."),
                io.Mask.Input("mask", optional=True,
                    tooltip="Optional existing repaint mask. It is copied into the output mask inside the frame; every new pixel is 1.0."),
            ],
            outputs=[
                io.Image.Output("image", tooltip="The padded image; the original pixels are copied in untouched, never resampled."),
                io.Mask.Output("mask", tooltip="A mask that is 1 over the newly added area and keeps the input mask inside the original frame."),
                io.Boolean.Output("has_padding", tooltip="True when padding was added on at least one side."),
            ],
        )

    @classmethod
    def execute(cls, **kw):
        # V1 @combo_legacy 对 unit 的 coerce 在此显式保留（中文遗留值 → 英文）。
        image = kw["image"]
        mask_in = kw.get("mask")
        unit = kw.get("unit") or "pixels"
        unit = coerce("QG_OutpaintBoard", "unit", unit)

        # 3 维有两种可能：单张 (H,W,C)，或者一批灰度帧 (B,H,W)。判据在共享助手
        # 里（看最后一维宽度）—— 手写 unsqueeze(0) 会把灰度批当成一张很高的图，
        # 补边结果整个错位。11-01 把这条判据收成一处，就是为了不再各写各的。
        image, _ = as_image_batch(image, "Outpaint Board image")
        batch, h, w, channels = (int(v) for v in image.shape)

        l, r, t, b, out_w, out_h, warns = compute_layout(
            w, h, unit,
            kw.get("left", 0), kw.get("right", 0),
            kw.get("top", 0), kw.get("bottom", 0),
            kw.get("max_output_side", 0), kw.get("divisible_by", 0),
        )

        # Negative pads slice the source (Goohaitools 88f2dd1): l=-50 crops 50px
        # off the left, t=-30 crops 30 off the top. The rest become positive pads
        # around the kept piece. compute_layout already capped crops at 10%.
        crop_l, crop_r = max(0, -l), max(0, -r)
        crop_t, crop_b = max(0, -t), max(0, -b)
        pad_l, pad_r = max(0, l), max(0, r)
        pad_t, pad_b = max(0, t), max(0, b)
        src_x0, src_x1 = crop_l, w - crop_r
        src_y0, src_y1 = crop_t, h - crop_b
        kept = image[:, src_y0:src_y1, src_x0:src_x1, :]
        kept_h, kept_w = int(kept.shape[1]), int(kept.shape[2])

        rgb255 = parse_fill_color(kw.get("pad_color", "#808080"),
                                  "Outpaint Board pad_color")
        rgb = tuple(c / 255.0 for c in rgb255)
        # 🔴 用正化后的 pad 判据，不能用 l+r+t+b：pad 可为负（裁源图），正负
        # 会互相抵消 —— left=-50/right=50 明明右侧补了 50px 新区域，求和却是 0，
        # has_padding 误报 False，下游据此跳过就漏绘了新区域（2026-11-23 排查）。
        has_pad = any(v > 0 for v in (pad_l, pad_r, pad_t, pad_b))

        # Output picture: paint the fill, then copy the kept pixels in place. No
        # interpolation anywhere on this path - a pure crop + paste.
        out = torch.empty((batch, out_h, out_w, channels),
                          dtype=image.dtype, device=image.device)
        if channels >= 3:
            out[..., 0] = rgb[0]
            out[..., 1] = rgb[1]
            out[..., 2] = rgb[2]
        else:
            gray = (rgb[0] + rgb[1] + rgb[2]) / 3.0
            out[..., 0] = gray
        if channels >= 4:
            out[..., 3] = 1.0
        out[:, pad_t:pad_t + kept_h, pad_l:pad_l + kept_w, :] = kept

        # Output mask: 1.0 on the added area (including cropped-away edges),
        # the input mask's surviving slice inside the frame. A crop discards
        # source pixels, so their mask slice goes with them.
        out_mask = torch.ones((batch, out_h, out_w),
                              dtype=torch.float32, device=image.device)
        if mask_in is not None:
            kept_mask = _fit_mask(mask_in, batch, h, w, image.device)[
                :, src_y0:src_y1, src_x0:src_x1]
            out_mask[:, pad_t:pad_t + kept_h, pad_l:pad_l + kept_w] = kept_mask
        else:
            out_mask[:, pad_t:pad_t + kept_h, pad_l:pad_l + kept_w] = 0.0

        for msg in warns:
            print("[QG-tools] Outpaint Board: %s" % msg)
        print("[QG-tools] Outpaint Board: %dx%d -> %dx%d (l%d r%d t%d b%d, fill %s)"
              % (w, h, out_w, out_h, l, r, t, b,
                 "#%02X%02X%02X" % rgb255))

        return io.NodeOutput(out, out_mask, bool(has_pad))


NODE_CLASS_MAPPINGS = {"QG_OutpaintBoard": QGOutpaintBoard}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_OutpaintBoard": "Outpaint Board"}
