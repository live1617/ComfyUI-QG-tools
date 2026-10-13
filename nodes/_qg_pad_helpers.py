"""Image padding shared by QG-tools nodes.

Four fill mechanisms behind one geometry: the original always lands
bit-identical at (pad_left, pad_top), and the returned mask is 1.0 over
every padded pixel and 0.0 over the original — a ready-made outpaint
mask.

* ``color``          solid fill from a parsed color string
* ``edge``           each side takes the average color of the nearest
                     source edge; corners blend their two sides
* ``edge pixel``     the outermost rows/cols replicate outward; corner
                     quadrants take the corner pixel
* ``pillarbox blur`` the source is cover-scaled onto the canvas,
                     center-cropped, blurred and dimmed, then the sharp
                     original is pasted at its true position
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as functional

from ._qg_color_helpers import parse_fill_color
from ._qg_mask_helpers import blur_mask

# "mirror" is appended, never inserted: a saved workflow stores the mode by
# name, and the order is the order the Fill list shows.
PAD_MODES = ("color", "edge", "edge pixel", "pillarbox blur", "mirror")

# sigma = backdrop_blur * min(canvas_h, canvas_w) / _SIGMA_DIVISOR keeps the
# pillarbox look identical across resolutions; the same knob dims the
# backdrop toward _MAX_DIM at full strength.
_SIGMA_DIVISOR = 16.0
_MAX_DIM = 0.5
# Above this sigma the pillarbox blur runs at reduced resolution; below it
# the full-resolution path is cheap and stays exact.
_LOWRES_BLUR_MIN_SIGMA = 8.0
_LOWRES_BLUR_FACTOR = 4


def _as_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("Padding expected a BHWC IMAGE batch.")
    return image.float()


def _fill_tensor(
    fill_color: object, like: torch.Tensor, source: str = "Load Image + Pad fill_color"
) -> torch.Tensor:
    # `source` names the node and widget in the console note; Align Image passes
    # its own, so a colour it could not read is never reported against padding.
    rgb = [channel / 255.0 for channel in parse_fill_color(fill_color, source)]
    channels = like.shape[3]
    if channels > len(rgb):
        rgb = rgb + [1.0] * (channels - len(rgb))
    return torch.tensor(rgb[:channels], dtype=like.dtype, device=like.device)


def _blur_image(image: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian-blur a BHWC image by folding channels into the mask path."""
    if sigma <= 0.0:
        return image
    batch, height, width, channels = image.shape
    flat = image.movedim(-1, 1).reshape(batch * channels, height, width)
    blurred = blur_mask(flat, sigma)
    return blurred.reshape(batch, channels, height, width).movedim(1, -1).contiguous()


def _replicate_pad(image: torch.Tensor, left: int, top: int, right: int, bottom: int) -> torch.Tensor:
    moved = image.movedim(-1, 1).contiguous()
    padded = functional.pad(moved, (left, right, top, bottom), mode="replicate")
    return padded.movedim(1, -1).contiguous()


def _mirror_index(length: int, before: int, after: int) -> torch.Tensor:
    """Source index for every position of an axis padded by mirroring.

    The picture repeats as picture, flipped, flipped back (edge pixel
    included, like a mirror laid against the edge), so a pad wider than
    the picture keeps reflecting instead of failing."""
    positions = torch.arange(-before, length + after)
    period = 2 * length
    index = torch.remainder(positions, period)
    return torch.where(index >= length, period - 1 - index, index)


def _mirror_pad(image: torch.Tensor, left: int, top: int, right: int, bottom: int) -> torch.Tensor:
    rows = _mirror_index(int(image.shape[1]), top, bottom).to(image.device)
    cols = _mirror_index(int(image.shape[2]), left, right).to(image.device)
    return image.index_select(1, rows).index_select(2, cols).contiguous()


def _resize_image(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    moved = image.movedim(-1, 1).contiguous()
    antialias = width < moved.shape[-1] or height < moved.shape[-2]
    resized = functional.interpolate(
        moved, size=(height, width), mode="bilinear", align_corners=False, antialias=antialias
    )
    return resized.movedim(1, -1).contiguous()


def _edge_color_canvas(
    image: torch.Tensor, left: int, top: int, right: int, bottom: int
) -> torch.Tensor:
    """Sides take the mean color of the nearest source edge; corners blend."""
    batch, height, width, channels = image.shape
    canvas = torch.zeros(
        (batch, height + top + bottom, width + left + right, channels),
        dtype=image.dtype,
        device=image.device,
    )
    top_color = image[:, 0, :, :].mean(dim=1).view(batch, 1, 1, channels)
    bottom_color = image[:, -1, :, :].mean(dim=1).view(batch, 1, 1, channels)
    left_color = image[:, :, 0, :].mean(dim=1).view(batch, 1, 1, channels)
    right_color = image[:, :, -1, :].mean(dim=1).view(batch, 1, 1, channels)

    x0, x1 = left, left + width
    y0, y1 = top, top + height
    canvas[:, :y0, x0:x1] = top_color
    canvas[:, y1:, x0:x1] = bottom_color
    canvas[:, y0:y1, :x0] = left_color
    canvas[:, y0:y1, x1:] = right_color
    canvas[:, :y0, :x0] = (top_color + left_color) / 2.0
    canvas[:, :y0, x1:] = (top_color + right_color) / 2.0
    canvas[:, y1:, :x0] = (bottom_color + left_color) / 2.0
    canvas[:, y1:, x1:] = (bottom_color + right_color) / 2.0
    return canvas


def _pillarbox_canvas(
    image: torch.Tensor,
    left: int,
    top: int,
    right: int,
    bottom: int,
    backdrop_blur: float,
) -> torch.Tensor:
    """Cover-scale, center-crop, then blur and dim by one strength knob."""
    height, width = image.shape[1], image.shape[2]
    canvas_h = height + top + bottom
    canvas_w = width + left + right
    scale = max(canvas_w / width, canvas_h / height)
    scaled_w = max(canvas_w, math.ceil(width * scale))
    scaled_h = max(canvas_h, math.ceil(height * scale))
    backdrop = _resize_image(image, scaled_w, scaled_h)
    crop_x = (scaled_w - canvas_w) // 2
    crop_y = (scaled_h - canvas_h) // 2
    backdrop = backdrop[:, crop_y : crop_y + canvas_h, crop_x : crop_x + canvas_w, :]

    strength = max(0.0, min(1.0, float(backdrop_blur)))
    sigma = strength * min(canvas_h, canvas_w) / _SIGMA_DIVISOR
    if sigma >= _LOWRES_BLUR_MIN_SIGMA:
        # A heavy blur destroys detail by definition, so it can be computed
        # on a quarter-size canvas and scaled back up: at the default
        # strength this one blur was ~90% of the node's runtime (2.2 s of
        # 2.4 s on 48 frames of 832x480 padded square; 3.0 s at 1080p), and
        # the low-res path is ~9x cheaper with a mean difference around
        # 0.001 - invisible in a backdrop that is then dimmed. Small sigmas
        # stay on the exact full-resolution path, where the blur is cheap
        # and downscaling could actually show.
        small_w = max(1, canvas_w // _LOWRES_BLUR_FACTOR)
        small_h = max(1, canvas_h // _LOWRES_BLUR_FACTOR)
        small = _resize_image(backdrop, small_w, small_h)
        small = _blur_image(small, sigma * min(small_h, small_w) / min(canvas_h, canvas_w))
        backdrop = _resize_image(small, canvas_w, canvas_h)
    else:
        backdrop = _blur_image(backdrop, sigma)
    return backdrop * (1.0 - _MAX_DIM * strength)


def _round_half_up(value: float) -> int:
    """Round a non-negative value half-up, matching JS Math.round so the
    frontend's size badge mirrors the backend to the pixel (Python's round
    banker-rounds .5 down on evens)."""
    return int(value + 0.5)


def round_up_to_multiple(value: int, multiple: int) -> int:
    step = max(1, int(multiple))
    return ((max(0, int(value)) + step - 1) // step) * step


def _axis_layout(
    size: int, before: int, after: int, multiple: int
) -> tuple[int, int, int, int, int]:
    """One axis of the canvas: (before, after, trim_before, trim_after, length).

    The canvas rounds up to the multiple and the leftover joins a side the
    user padded: the far one (right/bottom) when both are. An axis nobody
    padded never grows a strip, because a strip there is an edge to
    generate that nobody asked for: outpaint models leave a thin one flat
    and off-tone, and Stitch's tone match then reads it as a seam and
    shifts the photo beside it. The source is trimmed to the multiple below
    instead, evenly from both edges like Align Image's crop, so the pixels
    it keeps stay untouched. A source smaller than one multiple has nothing
    to trim to and grows on the far side.
    """
    requested = size + before + after
    length = round_up_to_multiple(requested, multiple)
    leftover = length - requested
    if leftover == 0 or after > 0:
        return before, after + leftover, 0, 0, length
    if before > 0:
        return before + leftover, after, 0, 0, length
    step = max(1, int(multiple))
    kept = (size // step) * step
    if kept <= 0:
        return before, after + leftover, 0, 0, length
    trim = size - kept
    return 0, 0, trim // 2, trim - trim // 2, kept


def resolve_pad_geometry(
    width: int,
    height: int,
    pad_left: int,
    pad_top: int,
    pad_right: int,
    pad_bottom: int,
    canvas_multiple: int,
) -> dict[str, int]:
    """Clamp pads to >= 0 and round the canvas to the multiple one axis at a
    time (see _axis_layout). ``trim_*`` is what comes off the source before
    padding. Mirror of padGeometry in js/shared/pad_canvas.mjs — keep the
    two in sync."""
    left, right, trim_left, trim_right, out_w = _axis_layout(
        int(width), max(0, int(pad_left)), max(0, int(pad_right)), canvas_multiple
    )
    top, bottom, trim_top, trim_bottom, out_h = _axis_layout(
        int(height), max(0, int(pad_top)), max(0, int(pad_bottom)), canvas_multiple
    )
    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": out_w,
        "height": out_h,
        "trim_left": trim_left,
        "trim_top": trim_top,
        "trim_right": trim_right,
        "trim_bottom": trim_bottom,
    }


def plan_pad_canvas(
    width: int,
    height: int,
    pad_left: int,
    pad_top: int,
    pad_right: int,
    pad_bottom: int,
    canvas_multiple: int,
    target_megapixels: float = 0.0,
) -> dict[str, float | int]:
    """Full canvas plan for Load Image + Pad, megapixel target included.

    The padding is resolved at source scale first; when target_megapixels is
    on, the SOURCE is what gets rescaled (by s = sqrt(MP*1e6 / area)) and the
    raw pads are scaled with it, then re-rounded to the multiple. Padding a
    resized source keeps the mask seam one crisp pixel wide, where resizing
    a padded result would smear it.

    An axis nobody padded is resized onto the nearest multiple rather than
    trimmed (_axis_layout), since the source is resampled anyway. When only
    one axis is unpadded, its snapped size sets the scale for both, so the
    picture keeps its shape; when neither is padded, each snaps on its own,
    as in Align Image's resize. A side under half a multiple at the budget
    scale is not snapped, so snapping never more than doubles the scale;
    it grows on the far side like any source smaller than one multiple.
    Mirror of finalOutputSize in js/shared/pad_canvas.mjs — keep the two in
    sync.
    """
    width, height = int(width), int(height)
    left, top, right, bottom = (
        max(0, int(value)) for value in (pad_left, pad_top, pad_right, pad_bottom)
    )
    target = float(target_megapixels or 0.0)
    if target <= 0.0:
        base = resolve_pad_geometry(width, height, left, top, right, bottom, canvas_multiple)
        return {"scale": 1.0, "source_width": width, "source_height": height, **base}
    # The budget is measured against the requested canvas rounded up.
    area = round_up_to_multiple(width + left + right, canvas_multiple) * round_up_to_multiple(
        height + top + bottom, canvas_multiple
    )
    scale = math.sqrt(target * 1e6 / area)
    step = max(1, int(canvas_multiple))
    source_w = max(1, _round_half_up(width * scale))
    source_h = max(1, _round_half_up(height * scale))
    # 0 = not snapped: padded, or under half a multiple.
    snap_w = _round_half_up(width * scale / step) * step if left + right == 0 else 0
    snap_h = _round_half_up(height * scale / step) * step if top + bottom == 0 else 0
    if snap_w and snap_h:
        source_w, source_h = snap_w, snap_h
    elif snap_w:
        scale = snap_w / width
        source_w, source_h = snap_w, max(1, _round_half_up(height * scale))
    elif snap_h:
        scale = snap_h / height
        source_w, source_h = max(1, _round_half_up(width * scale)), snap_h
    final = resolve_pad_geometry(
        source_w,
        source_h,
        _round_half_up(left * scale),
        _round_half_up(top * scale),
        _round_half_up(right * scale),
        _round_half_up(bottom * scale),
        canvas_multiple,
    )
    return {"scale": scale, "source_width": source_w, "source_height": source_h, **final}


def feather_pad_mask(
    mask: torch.Tensor,
    pad_left: int,
    pad_top: int,
    pad_right: int,
    pad_bottom: int,
    feather: int,
) -> torch.Tensor:
    """Ramp the outpaint mask linearly inward across the image edge on each
    padded side, ramp width min(feather, image dimension). The padding stays
    1.0 — the feather lets the sampler blend the seam into the original.
    feather=0 (or no padding on a side) returns the mask untouched.
    """
    amount = max(0, int(feather))
    left = max(0, int(pad_left))
    top = max(0, int(pad_top))
    right = max(0, int(pad_right))
    bottom = max(0, int(pad_bottom))
    if amount <= 0 or (left == 0 and top == 0 and right == 0 and bottom == 0):
        return mask
    batch, canvas_h, canvas_w = mask.shape
    height = canvas_h - top - bottom
    width = canvas_w - left - right
    if height <= 0 or width <= 0:
        return mask
    result = mask.clone()

    def ramp(count: int, inward: bool) -> torch.Tensor:
        # Strictly between 1 and 0: linspace over count+2 with the endpoints
        # dropped, so a 1-pixel feather is 0.5, not a hard 1 or 0.
        values = torch.linspace(1.0, 0.0, count + 2, dtype=result.dtype, device=result.device)[1:-1]
        return values if inward else values.flip(0)

    def merge(y0: int, y1: int, x0: int, x1: int, values: torch.Tensor) -> None:
        # Union of the ramps, not their maximum: where two padded sides meet,
        # max() creases the iso-lines at 45 degrees from the inner corner
        # and any tone difference across the band prints that crease as a
        # diagonal line. 1 - (1 - a)(1 - b) is identical along each side
        # (the other ramp is 0 there) and bilinear in the corner, so the
        # blend has no crease. The padding itself stays exactly 1.
        region = result[:, y0:y1, x0:x1]
        ramp = values.expand(batch, y1 - y0, x1 - x0)
        result[:, y0:y1, x0:x1] = 1.0 - (1.0 - region) * (1.0 - ramp)

    x0, x1 = left, left + width
    y0, y1 = top, top + height
    if top > 0:
        depth = min(amount, height)
        merge(y0, y0 + depth, x0, x1, ramp(depth, True).view(1, depth, 1))
    if bottom > 0:
        depth = min(amount, height)
        merge(y1 - depth, y1, x0, x1, ramp(depth, False).view(1, depth, 1))
    if left > 0:
        depth = min(amount, width)
        merge(y0, y1, x0, x0 + depth, ramp(depth, True).view(1, 1, depth))
    if right > 0:
        depth = min(amount, width)
        merge(y0, y1, x1 - depth, x1, ramp(depth, False).view(1, 1, depth))
    return result.clamp(0.0, 1.0)


def resize_source(image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Bilinear resize of a BHWC batch (antialiased when shrinking) for the
    megapixel-target path; a no-op when the size already matches."""
    image = _as_image(image)
    if image.shape[2] == int(width) and image.shape[1] == int(height):
        return image
    return _resize_image(image, max(1, int(width)), max(1, int(height)))


def trim_source(image: torch.Tensor, left: int, top: int, right: int, bottom: int) -> torch.Tensor:
    """Cut the plan's trim_* pixels off a BHWC batch's edges; a no-op when
    there is nothing to trim."""
    image = _as_image(image)
    if left == 0 and top == 0 and right == 0 and bottom == 0:
        return image
    height, width = image.shape[1], image.shape[2]
    return image[:, top : height - bottom, left : width - right, :].contiguous()


def pad_image(
    image: torch.Tensor,
    pad_left: int,
    pad_top: int,
    pad_right: int,
    pad_bottom: int,
    mode: str,
    fill_color: object = "#808080",
    backdrop_blur: float = 0.5,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Pad a BHWC image; returns (padded image, outpaint mask).

    The mask is 1.0 over every padded pixel and 0.0 over the original,
    and the original region is bit-identical to the input in every mode.
    """
    image = _as_image(image)
    left = max(0, int(pad_left))
    top = max(0, int(pad_top))
    right = max(0, int(pad_right))
    bottom = max(0, int(pad_bottom))
    if mode not in PAD_MODES:
        raise ValueError(f"Pad mode must be one of {PAD_MODES}, got '{mode}'.")

    batch, height, width, _ = image.shape
    canvas_h = height + top + bottom
    canvas_w = width + left + right
    mask = torch.ones((batch, canvas_h, canvas_w), dtype=torch.float32, device=image.device)
    mask[:, top : top + height, left : left + width] = 0.0
    if left == 0 and top == 0 and right == 0 and bottom == 0:
        return image, mask

    if mode == "edge pixel":
        canvas = _replicate_pad(image, left, top, right, bottom)
        return canvas, mask
    if mode == "mirror":
        return _mirror_pad(image, left, top, right, bottom), mask
    if mode == "edge":
        canvas = _edge_color_canvas(image, left, top, right, bottom)
    elif mode == "pillarbox blur":
        canvas = _pillarbox_canvas(image, left, top, right, bottom, backdrop_blur)
    else:  # color
        fill = _fill_tensor(fill_color, image).view(1, 1, 1, -1)
        canvas = fill.expand(batch, canvas_h, canvas_w, image.shape[3]).clone()
    canvas[:, top : top + height, left : left + width, :] = image
    return canvas.contiguous(), mask


__all__ = [
    "PAD_MODES",
    "feather_pad_mask",
    "pad_image",
    "plan_pad_canvas",
    "resize_source",
    "resolve_pad_geometry",
    "round_up_to_multiple",
    "trim_source",
]
