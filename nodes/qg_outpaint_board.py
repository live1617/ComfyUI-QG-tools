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

from ._qg_color_helpers import parse_fill_color
from ._qg_combo_legacy import combo_legacy
from ._qg_tensor_helpers import as_image_batch

# Hard stop, not a real limit: it only keeps a typo (999999) from asking for a
# canvas that will not fit in memory.
PAD_LIMIT = 16384


# ----------------------------------------------------------------------
# Sizing
# ----------------------------------------------------------------------
def _to_px(value, unit, base):
    """One side value as pixels. ``percent`` is measured on that axis."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = 0.0
    if unit == "percent":
        return int(round(base * v / 100.0))
    return int(round(v))


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
    l = min(PAD_LIMIT, max(0, _to_px(left, unit, w)))
    r = min(PAD_LIMIT, max(0, _to_px(right, unit, w)))
    t = min(PAD_LIMIT, max(0, _to_px(top, unit, h)))
    b = min(PAD_LIMIT, max(0, _to_px(bottom, unit, h)))

    try:
        max_side = int(max_side or 0)
    except (TypeError, ValueError):
        max_side = 0
    try:
        divisor = int(divisor or 0)
    except (TypeError, ValueError):
        divisor = 0

    warns = []

    # Long-side ceiling: padding gives way, the picture does not.
    if max_side > 0:
        if w > max_side or h > max_side:
            # The picture itself is over the line, so the ceiling is already
            # impossible to meet. Any padding only makes it worse, so all four
            # sides go, not just the ones that overflow.
            l = r = t = b = 0
            warns.append(
                "picture %dx%d is already past max_output_side %d; all padding "
                "dropped (scale it down with another node)" % (w, h, max_side)
            )
        else:
            l, r = _scale_pair(l, r, max_side - w)
            t, b = _scale_pair(t, b, max_side - h)

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
@combo_legacy("QG_OutpaintBoard")
class QGOutpaintBoard:

    SEARCH_ALIASES = ["outpaint", "canvas", "pad", "extend", "扩图", "外扩", "补边", "qg"]

    @classmethod
    def VALIDATE_INPUTS(cls, unit=None):
        # Listed by name so ComfyUI skips the "value must be in the list" check:
        # this node ships with English option values, but the panel and the
        # legacy table both hand back Chinese ones in older workflows.
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "The picture to grow. Padding is added around it; the "
                               "picture itself is copied into the bigger canvas, never "
                               "resampled or cropped.",
                }),
                "unit": (["pixels", "percent"], {
                    "default": "pixels",
                    "tooltip": "pixels: the four side values are literal pixels. "
                               "percent: left/right read against the width, "
                               "top/bottom against the height.",
                }),
                "left": ("INT", {
                    "default": 0, "min": 0, "max": PAD_LIMIT, "step": 1,
                    "tooltip": "How far to grow the left side. pixels: literal pixels; "
                               "percent: a share of the width. 0 = none.",
                }),
                "right": ("INT", {
                    "default": 0, "min": 0, "max": PAD_LIMIT, "step": 1,
                    "tooltip": "How far to grow the right side. pixels: literal pixels; "
                               "percent: a share of the width. 0 = none.",
                }),
                "top": ("INT", {
                    "default": 0, "min": 0, "max": PAD_LIMIT, "step": 1,
                    "tooltip": "How far to grow the top side. pixels: literal pixels; "
                               "percent: a share of the height. 0 = none.",
                }),
                "bottom": ("INT", {
                    "default": 0, "min": 0, "max": PAD_LIMIT, "step": 1,
                    "tooltip": "How far to grow the bottom side. pixels: literal pixels; "
                               "percent: a share of the height. 0 = none.",
                }),
                "max_output_side": ("INT", {
                    "default": 0, "min": 0, "max": PAD_LIMIT, "step": 128,
                    "tooltip": "0 = no ceiling. When the canvas would go past it, "
                               "only the padding is trimmed - the picture is never "
                               "cropped or rescaled. A picture already over the "
                               "limit drops all padding and says so.",
                }),
                "divisible_by": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 1,
                    "tooltip": "0 = leave the canvas alone. Above 1 the canvas is "
                               "rounded up to a multiple of this, and the extra "
                               "goes on the right and bottom, so the picture keeps "
                               "its position. 8 / 16 / 32 / 64 are the usual picks.",
                }),
                "pad_color": ("STRING", {
                    "default": "#808080",
                    "tooltip": "Fill for the new area. Takes #RRGGBB, #ABC, a "
                               "colour name such as gray, 128,128,128, or 0.5.",
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional existing repaint mask. It is copied into the "
                               "output mask inside the frame; every new pixel is 1.0.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "BOOLEAN")
    RETURN_NAMES = ("image", "mask", "has_padding")
    OUTPUT_TOOLTIPS = (
        "The padded image; the original pixels are copied in untouched, "
        "never resampled.",
        "A mask that is 1 over the newly added area and keeps the input mask "
        "inside the original frame.",
        "True when padding was added on at least one side.",
    )
    FUNCTION = "run"
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Grow the canvas outwards and hand back both the padded picture and a "
        "mask of the new area. Input pixels are copied, never resampled, so "
        "the picture sits exactly where it did. Drive it from the panel: drag "
        "the four sides, or click outside the frame to snap that side to the "
        "cursor."
    )

    def run(self, **kw):
        image = kw["image"]
        mask_in = kw.get("mask")
        unit = kw.get("unit") or "pixels"

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

        rgb255 = parse_fill_color(kw.get("pad_color", "#808080"),
                                  "Outpaint Board pad_color")
        rgb = tuple(c / 255.0 for c in rgb255)
        has_pad = (l + r + t + b) > 0

        # Output picture: paint the fill, then copy the source in place. No
        # interpolation anywhere on this path.
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
        out[:, t:t + h, l:l + w, :] = image

        # Output mask: 1.0 on the new area, the source mask inside the frame.
        out_mask = torch.ones((batch, out_h, out_w),
                              dtype=torch.float32, device=image.device)
        if mask_in is not None:
            out_mask[:, t:t + h, l:l + w] = _fit_mask(mask_in, batch, h, w, image.device)
        else:
            out_mask[:, t:t + h, l:l + w] = 0.0

        for msg in warns:
            print("[QG-tools] Outpaint Board: %s" % msg)
        print("[QG-tools] Outpaint Board: %dx%d -> %dx%d (l%d r%d t%d b%d, fill %s)"
              % (w, h, out_w, out_h, l, r, t, b,
                 "#%02X%02X%02X" % rgb255))

        return (out, out_mask, bool(has_pad))


NODE_CLASS_MAPPINGS = {"QG_OutpaintBoard": QGOutpaintBoard}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_OutpaintBoard": "Outpaint Board"}
