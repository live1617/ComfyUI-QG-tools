# -*- coding: utf-8 -*-
"""Follow changes for QG_StitchInpaint - paste what the model changed, not just the box.

An edit model that redraws the whole crop it is given (MiniMax H3 Image, or
any edit run at full denoise) does not keep to the inpaint box: a new pair
of boots, a plate's rim or a coat's collar reach past it, and a box-only
paste cuts them off at its edge. The model can also draw the crop a touch
zoomed or shifted, so its background no longer lines up with the picture
around it.

Follow changes runs two steps before the usual classic paste:

1. Line the model's crop up with the picture's own crop (the zoom and shift
   that Realign to Source measures). An unreliable measurement leaves the
   crop as it came back.
2. Grow the paste from the box to every change that touches it: pixels where
   the lined-up crop differs from the picture, joined to the box. The grown
   edge fades out before the crop window's border, so nothing ends in a hard
   line. When the change covers most of the window outside the box, the
   model redrew everything and the paste stays the box.

The work runs at most WORK_SIDE pixels on the long side, on the CPU, and the
grown mask is scaled back to the window. Distances below are in pixels of
the crop window at full size and scale with it.

Semantics follow ComfyUI-AusBoss 2.26's ``feat/stitch-follow-changes`` (MIT,
https://github.com/ausboss) so the same stitcher stitches the same way in
both plugins - this file is this pack's own implementation, calling our
``_qg_realign_helpers`` and taking the resize routine as an argument, not
a copy of the upstream file.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from ._qg_realign_helpers import crop_if_shift, measure, warp_to_source

WORK_SIDE = 768
# A change this large (0..1, mean over RGB, after a light blur) counts.
CHANGE_LEVEL = 0.10
CHANGE_BLUR = 4.0
# How close a change has to come to the box to join it, how far the joined
# shape is closed and widened, and how soft its edge is.
TOUCH = 8.0
CLOSE = 6.0
WIDEN = 10.0
SOFT = 10.0
# The paste fades to nothing over this many pixels before a window border
# that lies inside the picture.
BORDER_FADE = 24.0
# When the change outside the box covers more than this share of the window
# outside the box, the model redrew everything: keep the box.
REDREW_ALL = 0.5
MAX_ZOOM = 0.2


def _blur(image: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian blur of an HW map, edges extended."""
    if sigma <= 0.3:
        return image
    radius = max(1, int(round(sigma * 3)))
    x = torch.arange(-radius, radius + 1, dtype=torch.float32)
    kernel = torch.exp(-(x * x) / (2 * sigma * sigma))
    kernel = kernel / kernel.sum()
    out = image[None, None]
    out = F.conv2d(F.pad(out, (radius, radius, 0, 0), mode="replicate"), kernel.view(1, 1, 1, -1))
    out = F.conv2d(F.pad(out, (0, 0, radius, radius), mode="replicate"), kernel.view(1, 1, -1, 1))
    return out[0, 0]


def _dilate(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    k = 2 * radius + 1
    return F.max_pool2d(mask[None, None].float(), k, stride=1, padding=radius)[0, 0] > 0.5


def _erode(mask: torch.Tensor, radius: int) -> torch.Tensor:
    return ~_dilate(~mask, radius)


def _reconstruct(seed: torch.Tensor, allowed: torch.Tensor) -> torch.Tensor:
    """Every pixel of ``allowed`` connected to ``seed`` (8-neighbour fill)."""
    region = seed & allowed
    # Steps of 2 px: a gap of a pixel or two in the change still joins,
    # and the fill takes a quarter of the passes.
    for _ in range(sum(allowed.shape)):
        grown = _dilate(region, 2) & allowed
        if torch.equal(grown, region):
            break
        region = grown
    return region


def _fill_holes(mask: torch.Tensor) -> torch.Tensor:
    border = torch.zeros_like(mask)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    outside = _reconstruct(border & ~mask, ~mask)
    return ~outside


def _border_ramp(height: int, width: int, fade: float, open_sides: tuple[bool, bool, bool, bool]) -> torch.Tensor:
    """1 inside, falling to 0 at each window border inside the picture.

    open_sides: (top, bottom, left, right) borders that are the picture's own
    edge, where nothing is cut and nothing fades."""
    top, bottom, left, right = open_sides
    ys = torch.arange(height, dtype=torch.float32)
    xs = torch.arange(width, dtype=torch.float32)
    big = float(height + width)
    dy = torch.minimum(ys if not top else torch.full_like(ys, big),
                       (height - 1 - ys) if not bottom else torch.full_like(ys, big))
    dx = torch.minimum(xs if not left else torch.full_like(xs, big),
                       (width - 1 - xs) if not right else torch.full_like(xs, big))
    return (torch.minimum(dy[:, None], dx[None, :]) / max(fade, 1.0)).clamp(0.0, 1.0)


def _resize_hw(mask: torch.Tensor, height: int, width: int) -> torch.Tensor:
    return F.interpolate(mask[None, None].float(), size=(height, width), mode="bilinear", align_corners=False)[0, 0]


def realign_crop(source: torch.Tensor, patch: torch.Tensor) -> tuple[torch.Tensor, bool]:
    """The patch (HWC, window size) lined up with the source crop (HWC).

    Returns (patch, moved); an unreliable measurement leaves it as it is."""
    height, width = int(source.shape[0]), int(source.shape[1])
    result = measure(source, patch, "zoom + shift", MAX_ZOOM)
    if not result.reliable:
        return patch, False
    out = crop_if_shift(patch, result.matrix, width, height)
    if out is None:
        out, _ = warp_to_source(patch, result.matrix, width, height, "source", source)
    return out, True


def follow_mask(source: torch.Tensor, patch: torch.Tensor, box: torch.Tensor,
                open_sides: tuple[bool, bool, bool, bool]) -> tuple[torch.Tensor, dict]:
    """The grown paste mask (HW, 0..1) for one frame, in window pixels.

    source, patch: HWC at window size, patch already lined up. box: HW blend
    mask in the window. Returns (mask, info) where info says what was done."""
    height, width = int(box.shape[0]), int(box.shape[1])
    scale = min(1.0, WORK_SIDE / max(height, width))
    wh, ww = max(8, int(round(height * scale))), max(8, int(round(width * scale)))

    def px(value: float) -> float:
        return value * scale

    small = lambda img: F.interpolate(img.permute(2, 0, 1)[None, :3].float(), size=(wh, ww),
                                      mode="area")[0]
    diff = (small(patch) - small(source)).abs().mean(0)
    diff = _blur(diff, px(CHANGE_BLUR))
    core = _resize_hw(box, wh, ww) >= 0.5
    if not bool(core.any()):
        return box.clone(), {"grew": False, "why": "no box"}
    changed = diff > CHANGE_LEVEL
    joined = _reconstruct(_dilate(core, max(1, round(px(TOUCH)))) & changed, changed) | core
    outside = ~core
    added = (joined & outside).sum().item()
    room = max(1, outside.sum().item())
    if added / room > REDREW_ALL:
        return box.clone(), {"grew": False, "why": "the model redrew most of the window"}
    close = max(1, round(px(CLOSE)))
    joined = _erode(_dilate(joined, close), close) | core
    joined = _fill_holes(joined)
    joined = _dilate(joined, max(1, round(px(WIDEN))))
    soft = _blur(joined.float(), px(SOFT))
    soft = _resize_hw(soft, height, width).clamp(0.0, 1.0)
    ramp = _border_ramp(height, width, BORDER_FADE, open_sides)
    grown = torch.maximum(soft * ramp, box.float() * ramp)
    # The box itself always pastes as it did, ramp or not.
    grown = torch.maximum(grown, box.float() * (box >= 0.999).float())
    share = float((grown > 0.5).sum()) / max(1.0, float((box > 0.5).sum()))
    return grown, {"grew": True, "share": share}


def follow_changes(stitcher: dict, patch: torch.Tensor, resize) -> tuple[torch.Tensor, dict, list[str]]:
    """Line the patch up and grow the paste. Returns (patch at window size,
    a stitcher copy whose blend is the grown mask, one line per frame).

    ``resize(patch, width, height, algorithm)`` brings the patch to the
    window size the way the classic stitch does."""
    canvas = stitcher["canvas"]
    blend = stitcher["blend"]
    cx, cy, cw, ch = stitcher["crop_to_canvas"]
    if (patch.shape[1], patch.shape[2]) != (ch, cw):
        patch = resize(patch, cw, ch, stitcher.get("algorithm", "bilinear"))
    full_h, full_w = int(canvas.shape[1]), int(canvas.shape[2])
    open_sides = (cy <= 0, cy + ch >= full_h, cx <= 0, cx + cw >= full_w)
    frames = int(patch.shape[0])
    patches, blends, lines = [], [], []
    for index in range(frames):
        src = canvas[min(index, canvas.shape[0] - 1), cy:cy + ch, cx:cx + cw, :3].detach().float().cpu()
        edit = patch[index, ..., :3].detach().float().cpu()
        box = blend[min(index, blend.shape[0] - 1), cy:cy + ch, cx:cx + cw].detach().float().cpu()
        lined, moved = realign_crop(src, edit)
        grown, info = follow_mask(src, lined, box, open_sides)
        if patch.shape[-1] > 3:
            lined = torch.cat([lined, patch[index, ..., 3:].detach().float().cpu()], dim=-1)
        patches.append(lined)
        whole = blend[min(index, blend.shape[0] - 1)].detach().float().cpu().clone()
        whole[cy:cy + ch, cx:cx + cw] = grown
        blends.append(whole)
        what = "lined up" if moved else "not moved"
        if info["grew"]:
            lines.append("Follow changes: %s; paste grown to %.2fx the box." % (what, info["share"]))
        else:
            lines.append("Follow changes: %s; paste kept to the box (%s)." % (what, info["why"]))
    out_patch = torch.stack(patches).to(device=patch.device, dtype=patch.dtype)
    new = dict(stitcher)
    new["blend"] = torch.stack(blends).to(device=blend.device, dtype=blend.dtype)
    return out_patch, new, lines
