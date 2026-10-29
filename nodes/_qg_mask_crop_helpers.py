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

Pure torch. Nothing in here touches the filesystem or the network.
"""

from __future__ import annotations

import math

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
    centre_x = x0 + area_w // 2
    centre_y = y0 + area_h // 2

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
    channels = min(3, int(strip.shape[-1]))
    quantised = torch.clamp((strip[..., :channels] * 15.0).round().long(), 0, 15)
    index = torch.zeros(quantised.shape[0], dtype=torch.long, device=strip.device)
    for channel in range(channels):
        index = index * 16 + quantised[:, channel]
    counts = torch.bincount(index, minlength=16 ** channels)
    bucket = int(counts.argmax())
    picked = quantised[index == bucket].to(strip.dtype) / 15.0
    if picked.numel() == 0:
        return torch.zeros(channels, dtype=strip.dtype, device=strip.device)
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
    """Resize a BHWC image; shrinks read as area, grows read as bilinear."""
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


def match_colour(patch: torch.Tensor, reference: torch.Tensor, strength: float) -> torch.Tensor:
    """Nudge the patch's channels so its median lines up with the reference's.

    A crop that went through a resize-and-back comes home a touch brighter or
    duller. One global per-channel offset removes that drift without touching
    local contrast, which is all this is for: it is not a colour transfer, and
    a patch that was genuinely repainted only gets its overall cast aligned.
    """
    if strength <= 0.0 or patch.shape[-1] < 3:
        return patch
    source = patch[..., :3].reshape(-1, 3)
    target = reference[..., :3].reshape(-1, 3)
    offset = (target.median(dim=0).values - source.median(dim=0).values).clamp(-0.2, 0.2)
    out = patch.clone()
    out[..., :3] = (out[..., :3] + offset * float(strength)).clamp(0.0, 1.0)
    return out


def stitch_back(
    background: torch.Tensor,
    patch: torch.Tensor,
    mask: torch.Tensor,
    rect: Rect,
    colour_strength: float = 0.0,
) -> torch.Tensor:
    """Blend a processed crop over ``background`` at ``rect``.

    Only the part of ``rect`` that lands inside the picture is written, so a
    crop that hung outside the frame loses nothing on the way back. Every
    pixel outside the mask is copied from ``background`` verbatim.
    """
    x, y, width, height = rect
    _, dst_h, dst_w, _ = background.shape
    if patch.shape[1] != height or patch.shape[2] != width:
        patch = resize_image(patch, height, width)
    if tuple(mask.shape[-2:]) != (height, width):
        mask = resize_mask(mask, height, width)
    if patch.shape[0] != background.shape[0]:
        patch = patch[:1].expand(background.shape[0], -1, -1, -1)

    x_start, y_start = max(0, x), max(0, y)
    x_end, y_end = min(dst_w, x + width), min(dst_h, y + height)
    if x_end <= x_start or y_end <= y_start:
        return background

    src_x, src_y = x_start - x, y_start - y
    span_w, span_h = x_end - x_start, y_end - y_start
    patch_region = patch[:, src_y:src_y + span_h, src_x:src_x + span_w]
    mask_region = mask[:, src_y:src_y + span_h, src_x:src_x + span_w].unsqueeze(-1)

    out = background.clone()
    base = out[:, y_start:y_end, x_start:x_end]
    if colour_strength > 0.0:
        patch_region = match_colour(patch_region, base, colour_strength)
    out[:, y_start:y_end, x_start:x_end] = base * (1.0 - mask_region) + patch_region * mask_region
    return out
