"""Crop-for-inpaint geometry and stitching shared by QG-tools nodes.

The contract is a two-rect canvas:

* ``canvas`` is the original image, edge-replicate padded only when the
  grown context rect truly cannot fit inside the frame.
* ``canvas_to_original`` locates the untouched original inside the canvas.
* ``crop_to_canvas`` locates the crop handed to the sampler inside the
  canvas.

Stitching blends the (possibly resized) inpainted crop into the canvas
with a feathered blend mask, then slices ``canvas_to_original`` back out.
Because the original pixels sit verbatim in the canvas and the blend is
applied as ``canvas + blend * (inpainted - canvas)`` with a hard zero
guard, every pixel outside the blend region is bit-identical to the
input image — nothing outside the crop ever round-trips a resize. The
optional edge-halo spread only swaps the color that gets blended in, so
that guarantee holds with the toggle on as well.

The "blend in" seam (the section near the end) hands an outpaint over by
depth into the picture instead of by the blend mask; its promise is the
same for every pixel deeper than its ramps.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as functional

from ._qg_execution_helpers import progress_bar, raise_if_interrupted, warn_once
from ._qg_mask_helpers import blur_mask, grow_shrink_mask, mask_size_mismatch

try:
    from scipy.ndimage import distance_transform_edt as _scipy_distance
except Exception:  # scipy is optional; the torch fallback below covers it.
    _scipy_distance = None

STITCHER_KIND = "ausboss_inpaint_stitcher"
STITCHER_VERSION = 1

# How the new area meets the picture (Stitch Inpaint's Seam choice). The
# first is the feathered paste every earlier workflow uses.
SEAM_CLASSIC = "classic"
SEAM_BLEND_IN = "blend in"
SEAM_MODES = (SEAM_CLASSIC, SEAM_BLEND_IN)

Rect = tuple[int, int, int, int]  # (x, y, w, h)


# --- pure geometry -----------------------------------------------------------


def round_up_to_multiple(value: int, multiple: int) -> int:
    """Smallest multiple of ``multiple`` that is >= ``value``."""
    multiple = max(1, int(multiple))
    value = max(1, int(value))
    return ((value + multiple - 1) // multiple) * multiple


def mask_bbox(mask: torch.Tensor) -> Rect | None:
    """Tight bounding box of all nonzero pixels, unioned across the batch.

    Returns ``None`` for an empty mask.
    """
    covered = mask > 0
    if not bool(covered.any()):
        return None
    rows = covered.any(dim=2).any(dim=0)
    cols = covered.any(dim=1).any(dim=0)
    row_idx = torch.nonzero(rows).flatten()
    col_idx = torch.nonzero(cols).flatten()
    y0, y1 = int(row_idx[0]), int(row_idx[-1]) + 1
    x0, x1 = int(col_idx[0]), int(col_idx[-1]) + 1
    return (x0, y0, x1 - x0, y1 - y0)


def grow_rect(rect: Rect, factor: float) -> Rect:
    """Grow a rect symmetrically so each side scales by ``factor``."""
    x, y, w, h = rect
    new_w = max(1, round(w * float(factor)))
    new_h = max(1, round(h * float(factor)))
    return (x - (new_w - w) // 2, y - (new_h - h) // 2, new_w, new_h)


def expand_rect_to_multiple(rect: Rect, multiple: int) -> Rect:
    """Grow a rect symmetrically until both sides are multiples."""
    x, y, w, h = rect
    new_w = round_up_to_multiple(w, multiple)
    new_h = round_up_to_multiple(h, multiple)
    return (x - (new_w - w) // 2, y - (new_h - h) // 2, new_w, new_h)


def fit_rect(rect: Rect, bounds_w: int, bounds_h: int) -> Rect:
    """Shift a rect fully into bounds; center it when it cannot fit.

    The size is never changed: a rect wider or taller than the bounds is
    centered so its overflow splits evenly — that overflow becomes the
    replicate-padded canvas margin.
    """
    x, y, w, h = rect
    if w <= bounds_w:
        x = min(max(x, 0), bounds_w - w)
    else:
        x = -((w - bounds_w) // 2)
    if h <= bounds_h:
        y = min(max(y, 0), bounds_h - h)
    else:
        y = -((h - bounds_h) // 2)
    return (x, y, w, h)


def clamp_rect_to_bounds(rect: Rect, bounds_w: int, bounds_h: int) -> Rect:
    """Shrink a rect to the bounds on each axis it is too big for.

    An axis that fits is left alone (``fit_rect`` shifts it inside later).
    An axis that is wider or taller than the bounds becomes exactly the
    bounds, so no replicate padding is needed there. A mask box always lies
    inside the bounds, so the clamped rect still contains it.
    """
    x, y, w, h = rect
    if w > bounds_w:
        x, w = 0, bounds_w
    if h > bounds_h:
        y, h = 0, bounds_h
    return (x, y, w, h)


def rect_margins(rect: Rect, bounds_w: int, bounds_h: int) -> tuple[int, int, int, int]:
    """(left, top, right, bottom) overflow of a rect past the bounds."""
    x, y, w, h = rect
    return (max(0, -x), max(0, -y), max(0, x + w - bounds_w), max(0, y + h - bounds_h))


# --- tensor plumbing ---------------------------------------------------------


# ``source`` is the node an error names: the crop, the stitch and every
# stitcher producer validate through these two.
def _as_image(image: torch.Tensor, source: str = "Crop For Inpaint") -> torch.Tensor:
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError(f"{source} expected a BHWC IMAGE batch.")
    return image.float()


def _as_mask(
    mask: torch.Tensor, image: torch.Tensor, source: str = "Crop For Inpaint"
) -> torch.Tensor:
    if isinstance(mask, torch.Tensor) and mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if not isinstance(mask, torch.Tensor) or mask.ndim != 3:
        raise ValueError(f"{source} expected a BHW MASK.")
    if mask.shape[1:] != image.shape[1:3]:
        # Most often core Load Image's 64x64 stand-in for "nothing painted".
        raise ValueError(mask_size_mismatch(mask, int(image.shape[1]), int(image.shape[2])))
    if mask.shape[0] not in (1, image.shape[0]):
        raise ValueError(
            f"Mask batch {mask.shape[0]} cannot broadcast across "
            f"image batch {image.shape[0]}."
        )
    return mask.float().clamp(0.0, 1.0)


RESIZE_ALGORITHMS = ("bilinear", "bicubic", "area", "nearest")


def _resize_image(
    image: torch.Tensor, width: int, height: int, algorithm: str = "bilinear"
) -> torch.Tensor:
    if algorithm not in RESIZE_ALGORITHMS:
        raise ValueError(
            f"Crop For Inpaint rescale_algorithm must be one of "
            f"{RESIZE_ALGORITHMS}, not '{algorithm}'."
        )
    moved = image.movedim(-1, 1).contiguous()
    if algorithm == "nearest":
        resized = functional.interpolate(moved, size=(height, width), mode="nearest-exact")
    elif algorithm == "area":
        resized = functional.interpolate(moved, size=(height, width), mode="area")
    else:
        antialias = width < moved.shape[-1] or height < moved.shape[-2]
        resized = functional.interpolate(
            moved,
            size=(height, width),
            mode=algorithm,
            align_corners=False,
            antialias=antialias,
        )
    return resized.movedim(1, -1).contiguous()


def _resize_mask(mask: torch.Tensor, width: int, height: int) -> torch.Tensor:
    resized = functional.interpolate(
        mask.unsqueeze(1), size=(height, width), mode="nearest-exact"
    )
    return resized.squeeze(1)


def _replicate_pad_image(
    image: torch.Tensor, left: int, top: int, right: int, bottom: int
) -> torch.Tensor:
    moved = image.movedim(-1, 1).contiguous()
    padded = functional.pad(moved, (left, right, top, bottom), mode="replicate")
    return padded.movedim(1, -1).contiguous()


# --- optional edge-halo spread -----------------------------------------------

# The spread estimates against the exact mask the composite uses - never a
# dilated one. Measured on flat, gradient, noisy and hard-edged backgrounds:
# each pixel of dilation throws away roughly half of the remaining correction
# (1px leaves ~45% of the halo, 2px leaves ~75%), and the opposite-sign rim
# dilation would guard against never showed up above the noise floor.

_PYMATTING_HINT = (
    "Stitch Inpaint: fix_edge_halo needs the optional 'pymatting' package "
    "(add the pymatting package); pasting the edge pixels unchanged."
)

# Notes already printed this process; each prints once, with no cap.
_warned: set[str] = set()


def _foreground_estimator():
    """pymatting's multi-level foreground estimator, or None when absent."""
    try:
        from pymatting import estimate_foreground_ml
    except Exception:
        return None
    return estimate_foreground_ml


def spread_edge_colors(patch: torch.Tensor, alpha: torch.Tensor) -> torch.Tensor:
    """True foreground color of ``patch``, spread across the blend band.

    A semi-transparent seam pixel carries a mix of the inpainted color and
    the background it was generated against. Blending that mix in a second
    time multiplies the background contribution twice and reads as a dark
    or light halo along the seam. Estimating the unmixed color first and
    compositing *that* keeps the seam neutral.

    Returns ``patch`` untouched when pymatting is missing (one warning), when
    the estimate fails, or when the mask has no semi-transparent pixels to
    fix. Only the pasted color changes: the caller still weights with the
    ungrown mask, so zero-weight pixels stay bit-identical.

    The solve runs on the CPU, one frame at a time, and reports progress and
    honors a cancel between frames.
    """
    if not bool(((alpha > 0.0) & (alpha < 1.0)).any()):
        return patch
    estimate = _foreground_estimator()
    if estimate is None:
        warn_once(_PYMATTING_HINT, _warned)
        return patch

    matte_alpha = alpha
    if matte_alpha.shape[0] == 1 and patch.shape[0] > 1:
        matte_alpha = matte_alpha.expand(patch.shape[0], -1, -1)

    # Cost, measured on a 16-thread desktop CPU with pymatting 1.1.15: about
    # 90 ms per megapixel of paste window, per frame - 48 ms for the 768x768
    # window a 1024x1024 frame produces, 106 ms for the 1440x816 window from
    # 1080p. That is why the toggle ships off: it is meant for finishing a
    # chosen take, not for a long exploratory batch, where 300 frames of 1080p
    # is over half a minute of solving. The per-frame cancel check and progress
    # update keep such a batch stoppable at the next frame boundary.
    total = patch.shape[0]
    progress = progress_bar(total) if total > 1 else None
    spread = torch.empty_like(patch)
    for index in range(total):
        raise_if_interrupted()
        # pymatting solves in float32 and casts whatever it is handed, so
        # feeding float32 drops a float64 temporary of twice the size for a
        # bit-identical estimate.
        image = patch[index].detach().to(torch.float32).cpu().contiguous().numpy()
        matte = (
            matte_alpha[index].detach().to(torch.float32).clamp(0.0, 1.0).cpu().contiguous().numpy()
        )
        try:
            foreground = estimate(image, matte)
        except Exception as exc:  # A failed estimate must never fail the paste.
            detail = str(exc).encode("ascii", "replace").decode("ascii")
            warn_once(f"Stitch Inpaint: edge-halo spread failed ({detail}).", _warned)
            return patch
        spread[index] = torch.as_tensor(foreground)  # copy_ handles dtype/device
        if progress is not None:
            progress.update_absolute(index + 1, total)

    torch.nan_to_num_(spread, nan=0.0, posinf=1.0, neginf=0.0)
    # The spread redistributes colors the patch already holds; clamping to its
    # own range keeps the fix from inventing a brighter ring than it removes.
    low = float(torch.nan_to_num(patch.min(), nan=0.0))
    high = float(torch.nan_to_num(patch.max(), nan=1.0))
    return spread.clamp_(low, high)


# --- the crop / stitch pair --------------------------------------------------


def build_crop(
    image: torch.Tensor,
    mask: torch.Tensor,
    context_factor: float,
    blend_pixels: int,
    output_multiple: int,
    target_width: int = 0,
    target_height: int = 0,
    mask_grow: int = 0,
    mask_blur: float = 0.0,
    invert_mask: bool = False,
    context_pixels: int = 0,
    target_megapixels: float = 0.0,
    rescale_algorithm: str = "bilinear",
    extend_left: int = 0,
    extend_right: int = 0,
    extend_up: int = 0,
    extend_down: int = 0,
    keep_inside: bool = False,
) -> tuple[torch.Tensor, torch.Tensor, dict]:
    """Crop the masked region plus context; return (image, mask, stitcher).

    ``invert_mask`` flips the selection before anything else; ``mask_grow``
    dilates (or erodes, negative) the sampling mask and ``mask_blur``
    softens its edge — both reshape the region the inpainter paints, unlike
    ``blend_pixels`` which only feathers the paste-back. ``context_pixels``
    adds flat pixels of context on top of the ``context_factor`` growth.
    An empty mask selects the full image without context growth, so the
    graph keeps running; its blend mask is empty, so stitching returns
    the original untouched.

    ``target_megapixels`` rescales the crop for the sampler so its area is
    about that many megapixels (0 = off); explicit ``target_width``/
    ``target_height`` win over it. ``rescale_algorithm`` picks the resize
    filter for both directions of the round trip. The ``extend_*`` pixel
    counts grow the frame itself before anything else — the new bands are
    replicate-filled, added to the mask, and become part of the stitched
    output, which is how the pair outpaints.

    ``keep_inside`` stops the context at the frame's edges: on an axis where
    the grown box is bigger than the frame, the crop becomes the whole frame
    on that axis instead of running past it into replicate-padded edge
    copies. The sampler then sees only real pixels, at a larger working size
    after a megapixel rescale. The helper keeps the old padding by default;
    the node turns this on by default. Native sizing (no target) can still
    pad a few pixels to reach ``output_multiple``.
    """
    image = _as_image(image)
    mask = _as_mask(mask, image)
    if invert_mask:
        mask = 1.0 - mask

    ext_l, ext_r = max(0, int(extend_left)), max(0, int(extend_right))
    ext_u, ext_d = max(0, int(extend_up)), max(0, int(extend_down))
    if ext_l or ext_r or ext_u or ext_d:
        src_h, src_w = image.shape[1], image.shape[2]
        image = _replicate_pad_image(image, ext_l, ext_u, ext_r, ext_d)
        extended = torch.ones(
            (mask.shape[0], src_h + ext_u + ext_d, src_w + ext_l + ext_r),
            dtype=mask.dtype,
            device=mask.device,
        )
        extended[:, ext_u : ext_u + src_h, ext_l : ext_l + src_w] = mask
        mask = extended
    grow_px = int(mask_grow)
    if grow_px:
        mask = grow_shrink_mask(mask, grow_px)
    blur_sigma = max(0.0, float(mask_blur))
    if blur_sigma > 0.0:
        mask = blur_mask(mask, blur_sigma).clamp(0.0, 1.0)
    height, width = image.shape[1], image.shape[2]
    multiple = max(1, int(output_multiple))
    blend_px = max(0, int(blend_pixels))
    context_px = max(0, int(context_pixels))
    target_w = max(0, int(target_width))
    target_h = max(0, int(target_height))
    use_target = target_w > 0 or target_h > 0
    megapixels = max(0.0, float(target_megapixels))
    if rescale_algorithm not in RESIZE_ALGORITHMS:
        raise ValueError(
            f"Crop For Inpaint rescale_algorithm must be one of "
            f"{RESIZE_ALGORITHMS}, not '{rescale_algorithm}'."
        )

    bbox = mask_bbox(mask)
    if bbox is None:
        rect = (0, 0, width, height)
    else:
        rect = grow_rect(bbox, max(1.0, float(context_factor)))
        if context_px:
            rect = (
                rect[0] - context_px,
                rect[1] - context_px,
                rect[2] + 2 * context_px,
                rect[3] + 2 * context_px,
            )
        if keep_inside:
            rect = clamp_rect_to_bounds(rect, width, height)
        rect = fit_rect(rect, width, height)
    if not use_target and megapixels > 0.0:
        # Megapixel sizing: scale the crop so its area lands on the target;
        # explicit target_width/height always wins over this.
        area_scale = (megapixels * 1_000_000.0 / (rect[2] * rect[3])) ** 0.5
        target_w = max(1, round(rect[2] * area_scale))
        target_h = max(1, round(rect[3] * area_scale))
        use_target = True
    if not use_target:
        # Native sizing: the crop itself must satisfy the sampler multiple.
        rect = expand_rect_to_multiple(rect, multiple)
        rect = fit_rect(rect, width, height)

    left, top, right, bottom = rect_margins(rect, width, height)
    if left or top or right or bottom:
        canvas = _replicate_pad_image(image, left, top, right, bottom)
    else:
        canvas = image
    canvas_h = height + top + bottom
    canvas_w = width + left + right
    canvas_to_original: Rect = (left, top, width, height)
    crop_to_canvas: Rect = (rect[0] + left, rect[1] + top, rect[2], rect[3])

    canvas_mask = torch.zeros(
        (mask.shape[0], canvas_h, canvas_w), dtype=torch.float32, device=mask.device
    )
    canvas_mask[:, top : top + height, left : left + width] = mask

    blend = stitch_blend_from_mask(canvas_mask, blend_px)

    cx, cy, cw, ch = crop_to_canvas
    cropped = canvas[:, cy : cy + ch, cx : cx + cw, :].clone()
    sampling = canvas_mask[:, cy : cy + ch, cx : cx + cw].clone()

    scale = None
    if use_target:
        if target_w <= 0:
            target_w = max(1, round(cw * target_h / ch))
        if target_h <= 0:
            target_h = max(1, round(ch * target_w / cw))
        target_w = round_up_to_multiple(target_w, multiple)
        target_h = round_up_to_multiple(target_h, multiple)
        if (target_w, target_h) != (cw, ch):
            cropped = _resize_image(cropped, target_w, target_h, rescale_algorithm)
            sampling = _resize_mask(sampling, target_w, target_h)
        scale = (target_w / cw, target_h / ch)

    stitcher = {
        "kind": STITCHER_KIND,
        "version": STITCHER_VERSION,
        "canvas": canvas,
        "canvas_to_original": canvas_to_original,
        "crop_to_canvas": crop_to_canvas,
        "blend": blend,
        "scale": scale,
        "algorithm": rescale_algorithm,
    }
    return cropped, sampling, stitcher


def stitch_blend_from_mask(
    mask: torch.Tensor, blend_pixels: int, grow_pixels: int = 0
) -> torch.Tensor:
    """The paste mask :func:`apply_stitch` blends with, from a generated-area mask.

    ``grow_pixels`` first moves the paste boundary: positive lets the
    generation replace a strip of the source next to the seam, negative keeps
    a strip of the generated area out. ``blend_pixels`` then ramps the mask
    into the kept pixels - grown by that many pixels and blurred - so the
    paste fades in instead of ending at a hard cut. Crop For Inpaint and the
    padding producers all feather through here, so a stitch looks the same
    whichever node built it.
    """
    blend = mask
    grow = int(grow_pixels)
    if grow:
        blend = grow_shrink_mask(blend, grow)
    ramp = max(0, int(blend_pixels))
    if ramp > 0:
        blend = grow_shrink_mask(blend, ramp)
        blend = blur_mask(blend, ramp / 3.0)
    return blend.clamp(0.0, 1.0) if (grow or ramp) else blend.clone()


def build_canvas_stitcher(
    canvas: torch.Tensor,
    blend: torch.Tensor,
    bbox: tuple[int, int, int, int] | None = None,
    source: str = "Stitcher",
) -> dict:
    """A stitcher that pastes a full-frame result back over ``canvas``.

    The crop/stitch pair sends a *region* to the sampler. Padding sends the
    whole canvas instead, so the crop is the identity rectangle and ``blend``
    marks the padded band. :func:`apply_stitch` then keeps every pixel where
    the blend is zero bit-identical to ``canvas`` - the original photo - and
    takes the sampler's version only inside the band, which is what makes an
    outpaint leave the source untouched.

    Sharing one stitcher shape means Stitch Inpaint 🆎 accepts either
    producer; no second stitch node has to exist.

    ``bbox`` is where the *source* sits inside the canvas, as
    ``(x0, y0, x1, y1)`` pixels. Padding knows it exactly, and a model that
    places reference tokens on the canvas grid needs it, so it rides along
    here rather than on a parallel wire that can be left unplugged. It is
    stored twice - ``source_bbox`` in pixels and ``bbox_normalized`` in 0..1 -
    because a consumer reading normalized coordinates should not have to know
    the canvas size. Omitted when unknown; :func:`apply_stitch` never reads
    either key, so an older stitcher still stitches.

    ``source`` is the producing node, named if its canvas or mask is not a
    usable batch.
    """
    canvas = _as_image(canvas, source)
    blend = _as_mask(blend, canvas, source)
    height, width = canvas.shape[1], canvas.shape[2]
    stitcher = {
        "kind": STITCHER_KIND,
        "version": STITCHER_VERSION,
        "canvas": canvas,
        "canvas_to_original": (0, 0, width, height),
        "crop_to_canvas": (0, 0, width, height),
        "blend": blend,
        "scale": (1.0, 1.0),
        "algorithm": "bilinear",
    }
    if bbox is not None:
        x0, y0, x1, y1 = (int(value) for value in bbox)
        stitcher["source_bbox"] = (x0, y0, x1, y1)
        stitcher["bbox_normalized"] = [
            x0 / float(width),
            y0 / float(height),
            x1 / float(width),
            y1 / float(height),
        ]
    return stitcher


def apply_stitch(
    stitcher: dict,
    inpainted: torch.Tensor,
    fix_edge_halo: bool = False,
    color_match: float = 0.0,
    seam: str = SEAM_CLASSIC,
) -> torch.Tensor:
    """Blend the inpainted crop back and return the original-size image.

    Guarantees: pixels where the blend mask is zero are bit-identical to
    the original image, and passing the crop back unchanged reproduces
    the original exactly. A stitcher built from a single image legally
    broadcasts across an N-frame inpainted batch, and a stitcher built
    from more frames than came back is trimmed to the leading ``N``
    (video models return 8n+1 or 4n+1 frames and drop the tail).

    ``fix_edge_halo`` swaps the blended-in color for the spread foreground
    color from :func:`spread_edge_colors`; it never widens the blend, so
    the zero-weight guarantee is unaffected. Identity round trips are only
    exact with the toggle off, since the spread deliberately rewrites the
    feathered band.

    ``color_match`` (0..1) shifts the patch's tone by the offset measured
    in the feathered band (:func:`estimate_tone_offset`) before blending,
    so an outpaint whose new bands came out a touch lighter or warmer than
    the picture lands on the picture's own tone. 0 leaves the patch alone.

    ``seam`` "classic" is everything above. "blend in" replaces it on a
    stitcher that knows where the picture's edge is (Load Image + Pad and
    the Crop + Rotate + Pad nodes): :func:`blend_in_seam` hands the
    model's picture over to the source across that edge. There
    ``color_match`` is blend in's own Tone match (:func:`blend_in_tone_match`,
    read where the model redrew the picture, and only used when it holds
    on a held-out part of that strip); at 0 blend in leaves the model's
    colour as painted. ``fix_edge_halo`` does not apply. A Crop For Inpaint
    stitcher has no such edge and is stitched the classic way, with a
    one-time console note.
    """
    if not isinstance(stitcher, dict) or stitcher.get("kind") != STITCHER_KIND:
        raise ValueError(
            "Stitch Inpaint needs a stitcher from Crop For Inpaint, Load Image + Pad "
            "or a Crop + Rotate + Pad node."
        )
    inpainted = _as_image(inpainted, "Stitch Inpaint")
    canvas = stitcher["canvas"]
    blend = stitcher["blend"]
    cx, cy, cw, ch = stitcher["crop_to_canvas"]
    ox, oy, ow, oh = stitcher["canvas_to_original"]

    frames = inpainted.shape[0]
    batch = canvas.shape[0]
    if batch == frames:
        out = canvas.clone()
    elif batch == 1:
        out = canvas.expand(frames, -1, -1, -1).clone()
    elif frames < batch:
        # Video models hand back fewer frames than they were given (LTX
        # keeps 8n+1, Wan 4n+1) and drop the tail. Paste what came back
        # over the matching leading source frames and say so, rather than
        # throw away a long run over the count.
        print(
            f"[QG-tools] Stitch Inpaint: {frames} inpainted frame(s) for a "
            f"stitcher built from {batch}; stitching the first {frames} and "
            f"dropping the last {batch - frames} source frame(s)."
        )
        out = canvas[:frames].clone()
        if blend.shape[0] == batch:
            blend = blend[:frames]
    else:
        raise ValueError(
            f"Cannot stitch {frames} inpainted frame(s) into a stitcher "
            f"built from {batch} image(s); a stitcher built from one image "
            "broadcasts, and a longer stitcher is trimmed to the frames "
            "that came back, but it cannot invent frames it never had."
        )
    if inpainted.shape[3] == 4 and canvas.shape[3] == 3:
        # Qwen Image 2.1's VAE decodes RGBA; an RGB source has nowhere to
        # put the alpha, so it goes rather than failing the run.
        inpainted = inpainted[..., :3]
    if inpainted.shape[3] != canvas.shape[3]:
        raise ValueError(
            f"Inpainted channels ({inpainted.shape[3]}) do not match the "
            f"cropped image ({canvas.shape[3]})."
        )
    if blend.shape[0] not in (1, frames):
        raise ValueError(
            f"Blend mask batch {blend.shape[0]} cannot broadcast across "
            f"{frames} inpainted frame(s)."
        )

    patch = inpainted.to(dtype=out.dtype, device=out.device)
    if (patch.shape[1], patch.shape[2]) != (ch, cw):
        patch = _resize_image(patch, cw, ch, stitcher.get("algorithm", "bilinear"))

    if seam == SEAM_BLEND_IN:
        plan = seam_plan(stitcher)
        if plan is not None:
            # The canvas itself, not its per-frame copy in `out`: a single
            # canvas under a frame batch has its own layers split once.
            base = canvas[:1] if batch == 1 else canvas[:frames]
            region = base[:, cy : cy + ch, cx : cx + cw, :].to(out.device)
            depth = plan["depth"][:, cy : cy + ch, cx : cx + cw]
            strength = min(1.0, max(0.0, float(color_match)))
            match = None
            if strength > 0:
                sampler = plan.get("sampler")
                window = {"depth": depth, "sampler": None if sampler is None else sampler[:, cy : cy + ch, cx : cx + cw]}
                match = blend_in_tone_match(region, patch, window)
            blend_in_seam(
                region,
                patch,
                depth,
                plan["tone"],
                plan["detail"],
                out=out[:, cy : cy + ch, cx : cx + cw, :],
                match=match,
                strength=strength,
            )
            return out[:, oy : oy + oh, ox : ox + ow, :].contiguous()
        warn_once(_BLEND_IN_FALLBACK_NOTE, _warned)

    alpha = blend[:, cy : cy + ch, cx : cx + cw].to(out.device)
    if color_match > 0:
        # Measured against the canvas region the patch lands on; the shift
        # reaches every patch pixel but only the blended ones survive, so
        # the zero-blend guarantee below is untouched.
        bbox = stitcher.get("source_bbox")
        if bbox is not None:
            # The bbox is in canvas pixels; the crop window is the identity
            # for a padded canvas, so it maps straight onto the patch.
            bbox = (bbox[0] - cx, bbox[1] - cy, bbox[2] - cx, bbox[3] - cy)
        generated = stitcher.get("generated")
        if generated is not None:
            # Trimmed like the blend when fewer frames came back.
            generated = generated[:frames] if generated.shape[0] > frames else generated
            generated = generated[:, cy : cy + ch, cx : cx + cw].to(out.device)
        field = tone_offset_field(patch, out[:, cy : cy + ch, cx : cx + cw, :], alpha, bbox, generated)
        # Weighted by the blend: a fully generated pixel drifted by the whole
        # field, a band pixel the sampler mixed at alpha drifted by alpha of
        # it, and the blend below scales the correction by alpha once more.
        # Shifting the band by the full field would land it alpha*(1-alpha)
        # of the drift below the picture - a faint dark line along the seam.
        patch = shift_tone(patch, field * alpha.unsqueeze(-1), min(1.0, float(color_match)))
    if fix_edge_halo:
        patch = spread_edge_colors(patch, alpha)
    weights = alpha.unsqueeze(-1)
    region = out[:, cy : cy + ch, cx : cx + cw, :]
    # canvas + blend * (inpainted - canvas): identical input reproduces the
    # canvas bitwise; the where-guard pins the zero-blend region regardless
    # of what the sampler returned.
    mixed = region + weights * (patch - region)
    mixed = torch.where(weights > 0, mixed, region)
    out[:, cy : cy + ch, cx : cx + cw, :] = mixed
    return out[:, oy : oy + oh, ox : ox + ow, :].contiguous()


def estimate_tone_offset(
    inpainted: torch.Tensor, canvas: torch.Tensor, blend: torch.Tensor
) -> torch.Tensor:
    """Per-frame LAB mean offset of the inpainted patch against the canvas,
    measured where both hold real content: the feathered band (0 < blend
    < 1), inside the original picture but partly regenerated.

    The sampler mixes original and generated latent by the mask, so a band
    pixel comes out roughly ``blend * generated + (1 - blend) * original``.
    Dividing that difference back out is the weighted least-squares
    estimate ``sum(blend * (patch - canvas)) / sum(blend**2)`` per channel -
    the tone the model drifted by, read off pixels whose true color is
    known. Returns [B, 3] in LAB; zeros when there is no band to measure.
    """
    from ._qg_color_helpers import rgb_to_lab

    diff = rgb_to_lab(inpainted[..., :3]) - rgb_to_lab(canvas[..., :3])
    band = _band_weights(blend)
    weights = band.unsqueeze(-1)
    numerator = (weights * diff).sum(dim=(1, 2))
    denominator = (weights * weights).sum(dim=(1, 2)).clamp_min(1e-6)
    offset = numerator / denominator
    measured = (band.sum(dim=(1, 2)) > 0).unsqueeze(-1)
    return torch.where(measured, offset, torch.zeros_like(offset))


def _band_weights(blend: torch.Tensor) -> torch.Tensor:
    return torch.where((blend > 0.001) & (blend < 0.999), blend, torch.zeros_like(blend))


def _smooth_lines(curve: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian-smooth [B, N, C] along N with reflect padding."""
    length = curve.shape[1]
    if sigma <= 0 or length < 3:
        return curve
    radius = max(1, min(int(3 * sigma), length - 1))
    taps = torch.arange(-radius, radius + 1, dtype=curve.dtype, device=curve.device)
    kernel = torch.exp(-(taps * taps) / (2 * sigma * sigma))
    kernel = kernel / kernel.sum()
    channels = curve.shape[2]
    x = curve.permute(0, 2, 1)  # [B, C, N]
    x = torch.nn.functional.pad(x, (radius, radius), mode="reflect")
    weight = kernel.view(1, 1, -1).expand(channels, 1, -1)
    return torch.nn.functional.conv1d(x, weight, groups=channels).permute(0, 2, 1)


# How far one line's drift may stray from its side's average, in LAB
# units. A line whose seam holds different content on its two sides (a
# pier post leaving the frame, a boat's reflection under open water)
# would otherwise print its content difference onto the band as a tone
# shift.
LINE_DRIFT_CLAMP = 6.0

# The drift is read across the seam: this many generated pixels just
# outside the source against this many original pixels just inside it.
# Inside the feathered band the sampler mixed generated and original
# tone, so the band itself is the one place a clean reading cannot come
# from; the pixels either side of it can.
SEAM_BAND_PX = 24

# Picture pixels this close to a rotation void or transparency are left out
# of the inside strip too: a resized canvas blends the fill into them.
SEAM_VOID_MARGIN_PX = 2

# Softening of the inverse-square distance blend between sides, in
# pixels: at a corner the two nearest sides' curves mix smoothly instead
# of switching on a diagonal.
SEAM_BLEND_SOFT_PX = 8.0


def _finish_lines(lines: torch.Tensor, cover: torch.Tensor, fallback: torch.Tensor) -> torch.Tensor:
    """Turn raw per-line drifts [B, N, 3] into a curve fit to print: the
    side's own average, plus each line's deviation from it clamped to
    LINE_DRIFT_CLAMP, uncovered lines (cover [B, N] <= 0) set to
    ``fallback`` [B, 3], and the curve smoothed so a single line cannot
    print a stripe."""
    weight = (cover > 0).to(lines.dtype).unsqueeze(-1)
    side_average = (lines * weight).sum(dim=1, keepdim=True) / weight.sum(dim=1, keepdim=True).clamp_min(1e-6)
    lines = side_average + (lines - side_average).clamp(-LINE_DRIFT_CLAMP, LINE_DRIFT_CLAMP)
    lines = torch.where(weight > 0, lines, fallback.unsqueeze(1))
    sigma = max(6.0, 0.03 * lines.shape[1])
    return _smooth_lines(lines, sigma)


def _seam_lines(
    outside: torch.Tensor,
    inside: torch.Tensor,
    along_rows: bool,
    fallback: torch.Tensor,
    inside_kept: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-line drift across one seam: the mean LAB of the generated strip
    just outside it minus the mean of the original strip just inside it,
    per row (along_rows) or per column. ``outside`` and ``inside`` are the
    two strips as [B, H, w, 3] / [B, h, W, 3] slices. ``inside_kept``
    (0/1, [B or 1] x the inside strip's H, W) limits the inside mean to
    picture pixels; a line with none is uncovered and takes ``fallback``
    [B, 3]. Returns the finished curve [B, N, 3] and its cover [B, N], the
    inside pixels each line read."""
    reduce_dim = 2 if along_rows else 1
    if inside_kept is None:
        inside_mean = inside.mean(dim=reduce_dim)
        cover = torch.ones(inside_mean.shape[:2], dtype=inside.dtype, device=inside.device)
    else:
        weight = inside_kept.unsqueeze(-1)
        count = weight.sum(dim=reduce_dim)
        inside_mean = (weight * inside).sum(dim=reduce_dim) / count.clamp_min(1.0)
        cover = count.squeeze(-1).expand(inside_mean.shape[:2])
    lines = outside.mean(dim=reduce_dim) - inside_mean
    return _finish_lines(lines, cover, fallback), cover


def tone_offset_field(
    inpainted: torch.Tensor,
    canvas: torch.Tensor,
    blend: torch.Tensor,
    source_bbox: tuple[int, int, int, int] | None,
    generated: torch.Tensor | None = None,
) -> torch.Tensor:
    """A per-pixel LAB drift field [B, H, W, 3] for the patch.

    With a source rectangle (an outpaint), each padded side's drift is read
    ACROSS its seam, line by line - per row for a left or right side, per
    column for a top or bottom one: the generated pixels just outside the
    source against the original pixels just inside it (SEAM_BAND_PX each).
    Sky and water on the same seam drift by different amounts, and one
    number for the whole picture leaves one of them showing. Every pixel
    then takes an inverse-square-distance blend of the sides' curves, so
    where two padded sides meet the correction turns the corner without
    a crease. Without a rectangle, or with nothing to measure, the field is
    the single global offset.

    ``generated`` [B or 1, H, W] is the canvas's generated-area mask. A
    rotated or transparent source leaves fill inside its rectangle, and
    fill read as "original" drags the whole side toward the fill colour;
    with the mask the inside strips read only picture pixels (those the
    mask does not mark fully generated, SEAM_VOID_MARGIN_PX clear of any
    that it does), and a line with none in its strip takes the global
    offset, which the feathered band read along the real edge.
    Without it every pixel in the rectangle counts as picture.
    """
    from ._qg_color_helpers import rgb_to_lab

    lab_patch = rgb_to_lab(inpainted[..., :3])
    lab_canvas = rgb_to_lab(canvas[..., :3])
    batch, height, width = lab_patch.shape[:3]
    global_offset = estimate_tone_offset(inpainted, canvas, blend)
    field = global_offset.view(batch, 1, 1, 3).expand(batch, height, width, 3).clone()
    if source_bbox is None:
        return field
    x0, y0, x1, y1 = (int(v) for v in source_bbox)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return field
    device = lab_patch.device
    cols = torch.arange(width, device=device, dtype=lab_patch.dtype).view(1, 1, width)
    rows = torch.arange(height, device=device, dtype=lab_patch.dtype).view(1, height, 1)
    row_index = torch.arange(height, device=device).clamp(y0, y1 - 1) - y0
    col_index = torch.arange(width, device=device).clamp(x0, x1 - 1) - x0
    sides = []  # (distance to the seam [1,H,W], drift field [B,H,W,3])

    def expand_rows(curve: torch.Tensor) -> torch.Tensor:
        # curve [B, y1-y0, 3] -> every row of the canvas, padding rows
        # taking the nearest source row's value.
        return curve[:, row_index].unsqueeze(2).expand(batch, height, width, 3)

    def expand_cols(curve: torch.Tensor) -> torch.Tensor:
        return curve[:, col_index].unsqueeze(1).expand(batch, height, width, 3)

    def seam(outside, rows_slice, cols_slice, along_rows):
        inside = lab_canvas[:, rows_slice, cols_slice]
        kept = None
        if generated is not None:
            void = (generated[:, rows_slice, cols_slice] >= 0.999).to(inside.dtype)
            size = 2 * SEAM_VOID_MARGIN_PX + 1
            void = functional.max_pool2d(void.unsqueeze(1), size, stride=1, padding=SEAM_VOID_MARGIN_PX)
            kept = 1.0 - void.squeeze(1)
        curve, _ = _seam_lines(outside, inside, along_rows, global_offset, kept)
        return curve

    if x0 > 0:
        wo, wi = min(SEAM_BAND_PX, x0), min(SEAM_BAND_PX, x1 - x0)
        curve = seam(lab_patch[:, y0:y1, x0 - wo : x0], slice(y0, y1), slice(x0, x0 + wi), True)
        sides.append(((cols - x0).abs().expand(1, height, width), expand_rows(curve)))
    if x1 < width:
        wo, wi = min(SEAM_BAND_PX, width - x1), min(SEAM_BAND_PX, x1 - x0)
        curve = seam(lab_patch[:, y0:y1, x1 : x1 + wo], slice(y0, y1), slice(x1 - wi, x1), True)
        sides.append(((cols - (x1 - 1)).abs().expand(1, height, width), expand_rows(curve)))
    if y0 > 0:
        wo, wi = min(SEAM_BAND_PX, y0), min(SEAM_BAND_PX, y1 - y0)
        curve = seam(lab_patch[:, y0 - wo : y0, x0:x1], slice(y0, y0 + wi), slice(x0, x1), False)
        sides.append(((rows - y0).abs().expand(1, height, width), expand_cols(curve)))
    if y1 < height:
        wo, wi = min(SEAM_BAND_PX, height - y1), min(SEAM_BAND_PX, y1 - y0)
        curve = seam(lab_patch[:, y1 : y1 + wo, x0:x1], slice(y1 - wi, y1), slice(x0, x1), False)
        sides.append(((rows - (y1 - 1)).abs().expand(1, height, width), expand_cols(curve)))
    if not sides:
        return field
    numerator = torch.zeros_like(field)
    denominator = torch.zeros((1, height, width, 1), dtype=field.dtype, device=device)
    for distance, side_field in sides:
        weight = (1.0 / (distance + SEAM_BLEND_SOFT_PX) ** 2).unsqueeze(-1)
        numerator = numerator + weight * side_field
        denominator = denominator + weight
    return numerator / denominator


def shift_tone(image: torch.Tensor, offset: torch.Tensor, strength: float) -> torch.Tensor:
    """Subtract ``strength * offset`` from every pixel, in LAB. ``offset``
    is [B, 3] (one shift per frame) or a [B, H, W, 3] field."""
    from ._qg_color_helpers import lab_to_rgb, rgb_to_lab

    if strength <= 0:
        return image
    lab = rgb_to_lab(image[..., :3])
    shift = offset.view(-1, 1, 1, 3) if offset.dim() == 2 else offset
    rgb = lab_to_rgb(lab - shift * float(strength)).clamp(0.0, 1.0)
    if image.shape[3] > 3:
        return torch.cat([rgb, image[..., 3:]], dim=-1)
    return rgb


def stitch_blend_mask(stitcher: dict, frames: int = 1, seam: str = SEAM_CLASSIC) -> torch.Tensor:
    """The feathered blend mask in original-image coordinates (BHW).

    This is the very mask :func:`apply_stitch` blends with — the sampling
    mask grown by ``blend_pixels`` and blurred — sliced out of the canvas by
    ``canvas_to_original`` so it lines up pixel for pixel with the stitched
    image. It follows the batch :func:`apply_stitch` returns: a single-image
    stitcher broadcasts across ``frames``, and a longer one is trimmed to
    the leading ``frames`` just as the stitch was, so a downstream color
    match or composite can weight exactly the pixels the paste touched.

    With ``seam`` "blend in" on a stitcher that stitches that way, it is
    the model's share of colour and tone instead (:func:`blend_in_weight`):
    1 over the new area, fading to 0 where the source is back to its own
    pixels, and 0 beyond - again exactly the pixels the stitch changed.
    """
    if not isinstance(stitcher, dict) or stitcher.get("kind") != STITCHER_KIND:
        raise ValueError(
            "Stitch Inpaint needs a stitcher from Crop For Inpaint, Load Image + Pad "
            "or a Crop + Rotate + Pad node."
        )
    blend = stitcher["blend"]
    ox, oy, ow, oh = stitcher["canvas_to_original"]
    frames = max(1, int(frames))
    if blend.shape[0] > frames:
        # A video model handed back fewer frames than the stitcher holds and
        # apply_stitch kept the leading ones; the mask has to match them.
        blend = blend[:frames]
    if blend.shape[0] not in (1, frames):
        raise ValueError(
            f"Blend mask batch {blend.shape[0]} cannot broadcast across "
            f"{frames} inpainted frame(s)."
        )
    if seam == SEAM_BLEND_IN:
        plan = seam_plan(stitcher)
        if plan is not None:
            # One depth map serves every frame, so the weight broadcasts.
            weight = blend_in_weight(plan["depth"], plan["tone"])[:, oy : oy + oh, ox : ox + ow]
            return weight.expand(frames, -1, -1).contiguous()
    mask = blend[:, oy : oy + oh, ox : ox + ow]
    if mask.shape[0] == 1 and frames > 1:
        mask = mask.expand(frames, -1, -1)
    return mask.contiguous()


# --- seam: blend in ------------------------------------------------------------
#
# On a turned or padded outpaint the model redraws the outer pixels of the
# picture, and there its version and the picture differ in tone and texture.
# The classic paste cross-fades the two right in that strip, and its tone
# match reads the fill mixed into the picture's outermost pixels as drift.
# Blend in does neither. It splits both pictures into colour and tone (a
# blur) and fine detail (what the blur takes away), hands colour and tone
# over from the model to the picture slowly, deep inside the picture, and
# hands the detail over in a short ramp placed where the two already line
# up. Deeper than both ramps the picture keeps its own pixels bit for bit,
# outside it the model's picture is untouched - unless Tone match finds a
# drift it can check, below - and nothing is shifted globally.

# A pixel the generated-area mask holds at or above this is new area, not
# picture. The mask is 1 right up to the picture's edge and feathers inward
# from there, so the cut lands on the edge itself.
SEAM_NEW_AREA = 0.98
# Colour and tone are a picture blurred at this sigma, in pixels.
SEAM_TONE_SIGMA = 8.0
# Picture pixels closer than this to the edge stay out of the picture's
# colour layer: turning or resizing a canvas mixes the fill into them.
SEAM_CLEAN_DEPTH = 4.0
# The detail ramp starts at 3/4 of the depth where the model's mask fell to
# 0.1 - about how deep the model was free to redraw - never shallower than
# SEAM_DETAIL_FLOOR, and runs SEAM_DETAIL_SPAN pixels. The colour ramp runs
# from SEAM_CLEAN_DEPTH to SEAM_TONE_EXTRA pixels past the detail ramp.
# That depth is the median over the picture pixels whose mask value falls
# inside SEAM_REACH_BAND.
SEAM_DETAIL_FLOOR = 8.0
SEAM_DETAIL_SPAN = 10.0
SEAM_TONE_EXTRA = 14.0
SEAM_REACH_BAND = (0.08, 0.12)
# The depth used when the mask has too few pixels in that band to read
# (no feather, or a tiny canvas).
SEAM_DEFAULT_REACH = 13.0
SEAM_REACH_MIN_PIXELS = 200
# A straight cross-fade of two unrelated textures loses strength halfway
# across. This much of the lost strength is put back, read over this blur,
# and never more than SEAM_TEXTURE_MAX_GAIN times the faded detail.
SEAM_TEXTURE_SIGMA = 6.0
SEAM_TEXTURE_KEEP = 0.6
SEAM_TEXTURE_MAX_GAIN = 1.7
# Depth is measured this far, in pixels, and clamped past it. Every ramp
# ends inside it: the deepest colour ramp ends at 3/4 of it plus 24.
SEAM_DEPTH_CAP = 128.0
# Frames are blended in chunks of about this many pixels, at least one frame.
SEAM_CHUNK_PIXELS = 2 * 1024 * 1024

# Tone match under blend in (blend_in_tone_match). The model's picture is
# compared with yours over the band it redrew: picture pixels at least
# SEAM_CLEAN_DEPTH inside the edge where the sampler mask is above
# SEAM_MATCH_MIN_MASK, leaving out any whose tone reaches SEAM_MATCH_CLIP in
# a channel (a clipped highlight has no drift to read).
SEAM_MATCH_MIN_MASK = 0.02
SEAM_MATCH_CLIP = 0.98
# Fewer band pixels than this: nothing to read, no correction.
SEAM_MATCH_MIN_PIXELS = 400
# Robust fit: SEAM_MATCH_PASSES reweighting passes, pixels further than
# SEAM_MATCH_HUBER off the fit counting less (a changed object, a moved edge).
SEAM_MATCH_HUBER = 3.0 / 255.0
SEAM_MATCH_PASSES = 3
# The check: fit on alternate SEAM_MATCH_TILE px tiles, predict the others.
# The correction is used only when it predicts the held-out band
# SEAM_MATCH_MIN_GAIN better than no correction; the local gain along the
# edge only when it predicts it another SEAM_MATCH_LOCAL_GAIN better.
SEAM_MATCH_TILE = 96
SEAM_MATCH_MIN_GAIN = 0.15
SEAM_MATCH_LOCAL_GAIN = 0.05
# The local gain is smoothed along the edge at this sigma (px) and eases
# back to 1 away from it. No curve point drifts more than SEAM_MATCH_MAX.
SEAM_MATCH_ALONG = 48.0
SEAM_MATCH_MAX = 24.0 / 255.0
# Tone match compares tone layers blurred at this sigma (px): narrower than
# blend in's own, so a thin feather's band still reads close to how free the
# model was there, wide enough that texture and small shifts average out.
SEAM_MATCH_SIGMA = 5.0
SEAM_MATCH_FALLBACK = 1e-3

_BLEND_IN_FALLBACK_NOTE = (
    "Stitch Inpaint: Seam 'blend in' needs a Load Image + Pad or Crop + Rotate "
    "+ Pad stitcher; a Crop For Inpaint stitcher is stitched the classic way."
)


def _smoothstep(x: torch.Tensor) -> torch.Tensor:
    x = x.clamp(0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _seam_blur(image: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable Gaussian blur of a [B, C, H, W] batch with mirrored edges;
    a side too short to mirror repeats its last pixel instead."""
    radius = max(1, int(math.ceil(3.0 * float(sigma))))
    taps = torch.arange(-radius, radius + 1, dtype=image.dtype, device=image.device)
    kernel = torch.exp(-(taps * taps) / (2.0 * float(sigma) ** 2))
    kernel = kernel / kernel.sum()
    channels = image.shape[1]
    mode = "reflect" if radius < image.shape[3] else "replicate"
    image = functional.pad(image, (radius, radius, 0, 0), mode=mode)
    image = functional.conv2d(image, kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1), groups=channels)
    mode = "reflect" if radius < image.shape[2] else "replicate"
    image = functional.pad(image, (0, 0, radius, radius), mode=mode)
    return functional.conv2d(image, kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1), groups=channels)


def _torch_distance(inside: torch.Tensor, reach: float = SEAM_DEPTH_CAP) -> torch.Tensor:
    """Distance from every True pixel of an [H, W] mask to the nearest False
    pixel, centre to centre, exact up to ``reach`` pixels and at least
    ``reach`` past it. The frame's border does not count as False.

    Stands in for scipy's distance transform when scipy is missing: the
    nearest False pixel along each row first, then the best row within
    ``reach`` above or below.
    """
    height, width = inside.shape
    outside = ~inside
    columns = torch.arange(width, dtype=torch.float32, device=inside.device).expand(height, width)
    far = torch.full((height, width), math.inf, device=inside.device)
    before = torch.where(outside, columns, -far).cummax(dim=1).values
    after = -torch.where(outside, -columns, -far).flip(1).cummax(dim=1).values.flip(1)
    along = torch.minimum(columns - before, after - columns)
    along = along * along
    best = along.clone()
    for step in range(1, min(int(math.ceil(reach)), height - 1) + 1):
        lift = float(step * step)
        best[step:] = torch.minimum(best[step:], along[:-step] + lift)
        best[:-step] = torch.minimum(best[:-step], along[step:] + lift)
    return best.sqrt()


def _distance(inside: torch.Tensor) -> torch.Tensor:
    if _scipy_distance is not None:
        return torch.from_numpy(_scipy_distance(inside.cpu().numpy()).astype("float32"))
    return _torch_distance(inside.cpu())


def _signed_depth(picture: torch.Tensor) -> torch.Tensor:
    """[H, W] signed distance, in pixels, from each pixel's centre to the
    picture's edge: positive inside ``picture`` (a bool map), negative
    outside, clamped to SEAM_DEPTH_CAP either way. A side of the picture
    that meets the frame is no edge, so the picture stays deep up to it."""
    if bool(picture.all()):
        return torch.full(tuple(picture.shape), SEAM_DEPTH_CAP)
    if not bool(picture.any()):
        return torch.full(tuple(picture.shape), -SEAM_DEPTH_CAP)
    inward = _distance(picture) - 0.5
    outward = 0.5 - _distance(~picture)
    return torch.where(picture.cpu(), inward, outward).clamp(-SEAM_DEPTH_CAP, SEAM_DEPTH_CAP)


def _seam_map(stitcher: dict, key: str) -> torch.Tensor | None:
    """A canvas-sized BHW mask the stitcher carries under ``key``, or None."""
    canvas = stitcher["canvas"]
    mask = stitcher.get(key)
    if isinstance(mask, torch.Tensor) and mask.ndim == 3 and tuple(mask.shape[1:]) == tuple(canvas.shape[1:3]):
        return mask
    return None


def _seam_picture(stitcher: dict) -> torch.Tensor | None:
    """[H, W] True where the canvas holds the source picture; None when the
    stitcher does not say (a Crop For Inpaint crop)."""
    generated = _seam_map(stitcher, "generated")
    if generated is not None:
        # A turned or transparent source leaves fill inside its rectangle,
        # which only this mask knows about. One map serves every frame: a
        # pixel is picture only where no frame marks it new.
        return ~(generated >= SEAM_NEW_AREA).any(dim=0).cpu()
    bbox = stitcher.get("source_bbox")
    if bbox is None:
        return None
    height, width = int(stitcher["canvas"].shape[1]), int(stitcher["canvas"].shape[2])
    x0, y0, x1, y1 = (int(value) for value in bbox)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
    picture = torch.zeros((height, width), dtype=torch.bool)
    if x1 > x0 and y1 > y0:
        picture[y0:y1, x0:x1] = True
    return picture


def seam_ramps(
    mask: torch.Tensor | None, depth: torch.Tensor
) -> tuple[tuple[float, float], tuple[float, float]]:
    """(tone, detail) ramps for blend in, each (start, end) in pixels inside
    the picture's edge, read off ``mask`` [H, W] - the mask the model was
    handed - against ``depth`` [H, W].

    The model was free to redraw the picture down to about where its mask
    fell to 0.1, and its version lines up with the picture a little before
    that; the detail ramp starts there. Without a readable mask the ramps
    fall back to SEAM_DEFAULT_REACH.
    """
    reach = SEAM_DEFAULT_REACH
    if mask is not None:
        low, high = SEAM_REACH_BAND
        ring = (mask >= low) & (mask <= high) & (depth > 0)
        count = int(ring.sum())
        if count > SEAM_REACH_MIN_PIXELS:
            values = depth[ring].sort().values
            reach = (float(values[(count - 1) // 2]) + float(values[count // 2])) / 2.0
    start = max(SEAM_DETAIL_FLOOR, 0.75 * reach)
    detail = (start, start + SEAM_DETAIL_SPAN)
    return (SEAM_CLEAN_DEPTH, detail[1] + SEAM_TONE_EXTRA), detail


def seam_plan(stitcher: dict) -> dict | None:
    """What blend in needs for this stitcher: ``depth`` [1, H, W] (see
    :func:`_signed_depth`) and the ``tone`` and ``detail`` ramps
    (:func:`seam_ramps`).

    The picture is read from the stitcher's generated-area mask when it has
    one (Crop + Rotate + Pad) and from its source rectangle otherwise (Load
    Image + Pad); the ramps follow the mask the model was handed - the
    generated-area mask, or Load Image + Pad's blend, which is that node's
    sampler mask as it stands. Worked out once, kept on the stitcher under
    ``seam_plan`` next to what it was read from, and shared by every frame,
    so a clip is blended with one map and no per-frame estimate. None when
    the stitcher has no picture edge to blend across (Crop For Inpaint).
    """
    canvas = stitcher["canvas"]
    size = (int(canvas.shape[1]), int(canvas.shape[2]))
    generated = stitcher.get("generated")
    blend = stitcher.get("blend")
    bbox = stitcher.get("source_bbox")
    cached = stitcher.get("seam_plan")
    if (
        isinstance(cached, dict)
        and cached.get("generated") is generated
        and cached.get("blend") is blend
        and cached.get("source_bbox") == bbox
        and cached.get("size") == size
    ):
        return cached
    picture = _seam_picture(stitcher)
    if picture is None:
        return None
    depth = _signed_depth(picture)
    sampler = _seam_map(stitcher, "generated")
    if sampler is None:
        sampler = _seam_map(stitcher, "blend")
    tone, detail = seam_ramps(None if sampler is None else sampler.amax(dim=0).cpu(), depth)
    plan = {
        "depth": depth.unsqueeze(0).to(canvas.device),
        "tone": tone,
        "detail": detail,
        # [1, H, W], the mask the model was handed; Tone match reads it.
        "sampler": None if sampler is None else sampler.amax(dim=0, keepdim=True),
        "generated": generated,
        "blend": blend,
        "source_bbox": bbox,
        "size": size,
    }
    stitcher["seam_plan"] = plan
    return plan


def blend_in_weight(depth: torch.Tensor, tone: tuple[float, float]) -> torch.Tensor:
    """The model's share of colour and tone in a blend-in stitch: 1 over the
    new area and the picture's outermost pixels, easing to exactly 0 where
    the tone ramp ends and the source keeps its own pixels."""
    return 1.0 - _smoothstep((depth - tone[0]) / (tone[1] - tone[0]))


# --- blend in: Tone match -----------------------------------------------------
#
# The model redraws the strip of your picture next to the new area, so there
# its version and yours can be compared pixel for pixel. The difference is
# the model's tone drift, and it depends on brightness: Klein darkens
# mid-tones and keeps black black, Krea darkens a little all over, Qwen
# barely drifts. Where the sampler mask pinned the picture the drift is
# smaller (Krea: none) or of its own kind (Klein re-renders a pinned picture).
# Tone match fits that drift as curves over brightness, checks the fit on
# part of the strip it was not fitted on, and takes it back off the model's
# picture before blend in runs, so the new area meets your picture in tone
# on any edge, turned or straight. When the check fails, or there is no
# strip to read (no feather), nothing changes. One fit serves every frame.

# Brightness knots of the drift curves, denser in the shadows.
SEAM_MATCH_KNOTS = (0.0, 0.02, 0.05, 0.1, 0.18, 0.3, 0.45, 0.62, 0.8, 1.0)
# The pinned curve A is smoothed lightly and anchored weakly at no drift;
# the free curve is A plus a difference that is smoothed a little more and
# shrunk a little toward zero. Weights are relative to the band's size.
SEAM_MATCH_SMOOTH = 0.01
SEAM_MATCH_ANCHOR = 0.001
SEAM_MATCH_SMOOTH_FREE = 0.05
SEAM_MATCH_SHRINK_FREE = 0.01
# At most this many band pixels feed a fit; a larger band is thinned evenly.
SEAM_MATCH_SAMPLES = 200_000
# The local gain along the edge: smoothed at this sigma (px), at most this
# far from 1, used only when it predicts the held-out band this much better.
SEAM_MATCH_GAIN_MAX = 0.05
SEAM_MATCH_INVERT_STEPS = 3


# How it runs. PyTorch splits a large operation across all the CPUs it sees,
# and a cloud container can show it far more CPUs than it may use: there every
# such operation waits its turn, however little work it does. So Tone match
# keeps those operations to a few large ones - the blurs, each over every layer
# it needs at once - and does the rest with NumPy, which uses one thread: the
# band's samples are summed per knot segment (sorted once, then one reduction
# per pass for all three fits), every curve is solved in one batched call, and
# the curves are read and inverted over whole pictures at once.

_KNOTS = np.asarray(SEAM_MATCH_KNOTS, dtype=np.float32)
_KNOT_WIDTHS = _KNOTS[1:] - _KNOTS[:-1]
_INNER_KNOTS = torch.from_numpy(_KNOTS[1:-1].copy())
_POINTS = len(SEAM_MATCH_KNOTS)
_SEGMENTS = _POINTS - 1
# The fit's sums per sample, channel and knot segment: products of the four
# non-zero entries of the sample's row in the design (1 - t and t for the
# pinned curve, the same times the mask for the free one) with each other and
# with the drift.
_UU, _UT, _TT, _UUM, _UTM, _TTM, _UUMM, _UTMM, _TTMM, _UD, _TD, _UMD, _TMD = range(13)


def _numpy32(tensor: torch.Tensor) -> np.ndarray:
    """A float32 NumPy array of ``tensor`` on the CPU (shared, not copied,
    when it already is one)."""
    return tensor.detach().to(device="cpu", dtype=torch.float32).numpy()


def _knot_positions(values: np.ndarray):
    """(segment, t, 1 - t) for ``values`` clamped to 0..1: the knot segment
    each falls in, counted as ``torch.bucketize`` counts it, and how far
    across it."""
    values = np.clip(values, 0.0, 1.0)
    segment = torch.bucketize(torch.from_numpy(values), _INNER_KNOTS, out_int32=True).numpy()
    t = (values - np.take(_KNOTS, segment)) / np.take(_KNOT_WIDTHS, segment)
    return segment, t, np.float32(1.0) - t


def _curves_at(points: np.ndarray, flat: np.ndarray, t: np.ndarray, u: np.ndarray) -> np.ndarray:
    """Piecewise-linear curves read off ``points`` (knot values, flattened so
    that ``flat`` is each value's segment start) with ``t`` and ``u = 1 - t``."""
    return np.take(points, flat) * u + np.take(points, flat + 1) * t


def _penalty() -> np.ndarray:
    """[20, 20] smoothing and shrinking penalty of the pinned and free curves,
    per unit of sample weight."""
    steps = np.zeros((_SEGMENTS, _POINTS))
    steps[np.arange(_SEGMENTS), np.arange(_SEGMENTS)] = -1.0
    steps[np.arange(_SEGMENTS), np.arange(1, _POINTS)] = 1.0
    rough, eye = steps.T @ steps, np.eye(_POINTS)
    penalty = np.zeros((2 * _POINTS, 2 * _POINTS))
    penalty[:_POINTS, :_POINTS] = SEAM_MATCH_SMOOTH * rough + SEAM_MATCH_ANCHOR * eye
    penalty[_POINTS:, _POINTS:] = SEAM_MATCH_SMOOTH_FREE * rough + SEAM_MATCH_SHRINK_FREE * eye
    return penalty


def _solve_curves(sums: np.ndarray, weights: np.ndarray):
    """Knot values of the pinned curve A and the free curve E for every fit
    and channel, from ``sums`` [fits, 3, segments, 13] (see _UU...) and each
    fit's total sample weight ``weights`` [fits]. The drift is modelled as
    d = A(v) + m * (E(v) - A(v)); least squares with SEAM_MATCH_* penalties.
    Returns float32 (pinned, free), each [fits, 3, knots]."""
    fits = sums.shape[0]
    gram = np.zeros((fits, 3, 2 * _POINTS, 2 * _POINTS))
    target = np.zeros((fits, 3, 2 * _POINTS))
    low = np.arange(_SEGMENTS)
    high = low + 1
    for rows, cols, same, cross, other in (
        (0, 0, _UU, _UT, _TT),
        (0, _POINTS, _UUM, _UTM, _TTM),
        (_POINTS, 0, _UUM, _UTM, _TTM),
        (_POINTS, _POINTS, _UUMM, _UTMM, _TTMM),
    ):
        gram[..., rows + low, cols + low] += sums[..., same]
        gram[..., rows + low, cols + high] += sums[..., cross]
        gram[..., rows + high, cols + low] += sums[..., cross]
        gram[..., rows + high, cols + high] += sums[..., other]
    target[..., low] += sums[..., _UD]
    target[..., high] += sums[..., _TD]
    target[..., _POINTS + low] += sums[..., _UMD]
    target[..., _POINTS + high] += sums[..., _TMD]
    gram += _penalty() * weights.reshape(fits, 1, 1, 1)
    solved = np.linalg.solve(gram, target[..., None])[..., 0].astype(np.float32)
    pinned, free = solved[..., :_POINTS], solved[..., :_POINTS] + solved[..., _POINTS:]
    return np.clip(pinned, -SEAM_MATCH_MAX, SEAM_MATCH_MAX), np.clip(free, -SEAM_MATCH_MAX, SEAM_MATCH_MAX)


class _DriftSamples:
    """The band's samples, set up once for every fit that reads them: your
    picture's tone ``v`` [N, 3], the mask ``m`` [N] and the drift ``d`` [N, 3]."""

    def __init__(self, v: np.ndarray, m: np.ndarray, d: np.ndarray):
        self.m, self.d = m, d
        self.segment, self.t, self.u = _knot_positions(v)
        um, tm = self.u * m[:, None], self.t * m[:, None]
        u, t = self.u, self.t
        # [N, 3, 13] products, float32 like the design they come from.
        self.products = np.stack(
            (u * u, u * t, t * t, u * um, u * tm, t * tm, um * um, um * tm, tm * tm, u * d, t * d, um * d, tm * d),
            axis=-1,
        )

    def layer(self, fit: np.ndarray):
        """Sort the samples of one layer - each sample fitted by ``fit`` [N]
        (a fit index) - by fit, channel and segment once, so every pass sums
        them with one reduction. Returns what :meth:`sums` needs."""
        count = self.segment.shape[0]
        bins = ((fit[:, None].astype(np.int64) * 3 + np.arange(3)) * _SEGMENTS + self.segment).reshape(-1)
        order = np.argsort(bins.astype(np.int16), kind="stable")
        ordered = bins[order]
        starts = np.flatnonzero(np.concatenate(([True], ordered[1:] != ordered[:-1])))
        return {
            "bins": ordered[starts],
            "starts": starts,
            "sample": order // 3,
            "products": self.products.reshape(count * 3, 13)[order],
            "flat": ((fit[:, None].astype(np.int64) * 3 + np.arange(3)) * _POINTS + self.segment),
        }

    def sums(self, layer: dict, weight: np.ndarray, fits: int) -> np.ndarray:
        """[fits, 3, segments, 13] weighted sums of one layer's samples."""
        out = np.zeros((fits * 3 * _SEGMENTS, 13))
        weighted = layer["products"] * weight[layer["sample"], None]
        out[layer["bins"]] = np.add.reduceat(weighted, layer["starts"], axis=0, dtype=np.float64)
        return out.reshape(fits, 3, _SEGMENTS, 13)

    def drift(self, pinned: np.ndarray, free: np.ndarray, flat: np.ndarray) -> np.ndarray:
        """[N, 3] fitted drift of every sample, read off the curves (flattened
        [fits * 3 * knots]) of the fit ``flat`` points each sample to."""
        a = _curves_at(pinned.reshape(-1), flat, self.t, self.u)
        return a + self.m[:, None] * (_curves_at(free.reshape(-1), flat, self.t, self.u) - a)


def _robust_fits(samples: _DriftSamples, halves: np.ndarray):
    """Three robust drift fits at once: every sample (fit 0), and each half
    of the check - fit 1 on the samples ``halves`` marks, fit 2 on the rest.
    Each runs SEAM_MATCH_PASSES reweighting passes, pixels further than
    SEAM_MATCH_HUBER off its fit counting less.

    Returns ``(pinned, free)`` [3, 3, knots] and the whole-band fit's final
    weights [N].
    """
    count = samples.d.shape[0]
    fit = halves.astype(np.int64) * -1 + 2  # 1 on the marked half, 2 elsewhere
    layers = (samples.layer(np.zeros(count, dtype=np.int64)), samples.layer(fit))
    weights = [np.ones(count, dtype=np.float32), np.ones(count, dtype=np.float32)]
    pinned = free = None
    for _ in range(SEAM_MATCH_PASSES):
        sums = samples.sums(layers[0], weights[0], 3) + samples.sums(layers[1], weights[1], 3)
        totals = np.array(
            (weights[0].sum(dtype=np.float64), weights[1][halves].sum(dtype=np.float64), weights[1][~halves].sum(dtype=np.float64))
        )
        pinned, free = _solve_curves(sums, totals)
        for index, layer in enumerate(layers):
            miss = np.abs(samples.d - samples.drift(pinned, free, layer["flat"])).max(axis=1)
            weights[index] = np.where(miss <= SEAM_MATCH_HUBER, np.float32(1.0), np.float32(SEAM_MATCH_HUBER) / np.maximum(miss, np.float32(1e-9)))
    return pinned, free, weights[0]


def _curve_lines(points: np.ndarray):
    """Each segment of the curves with knot values ``points`` [..., knots] as
    a line: (offset, slope) [..., segments], the value at v being
    offset + slope * v."""
    slope = (points[..., 1:] - points[..., :-1]) / _KNOT_WIDTHS
    return points[..., :-1] - slope * _KNOTS[:-1], slope


def _undo_drift(values: np.ndarray, pinned: np.ndarray, free: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Take each RGB value of ``values`` [..., H, W, 3] back through its drift
    curve: the picture value v with v + drift(v) = value, found by
    SEAM_MATCH_INVERT_STEPS fixed-point steps, so a value the model kept
    (black stays black) is kept. ``pinned`` and ``free`` are [3, knots], ``m``
    [H, W, 1] mixes them. Returns the found values, not yet mixed by strength."""
    offset, slope = _curve_lines(pinned)
    free_offset, free_slope = _curve_lines(free)
    # drift = offset + slope * v + m * (extra offset + extra slope * v)
    tables = [part.reshape(-1) for part in (offset, slope, free_offset - offset, free_slope - slope)]
    channels = np.arange(3, dtype=np.int32) * _SEGMENTS
    guess = values
    for _ in range(SEAM_MATCH_INVERT_STEPS):
        clamped = np.clip(guess, 0.0, 1.0)
        flat = torch.bucketize(torch.from_numpy(clamped), _INNER_KNOTS, out_int32=True).numpy()
        flat += channels
        drift = np.take(tables[1], flat) * clamped
        drift += np.take(tables[0], flat)
        extra = np.take(tables[3], flat) * clamped
        extra += np.take(tables[2], flat)
        extra *= m
        drift += extra
        guess = np.clip(np.subtract(values, drift, out=drift), 0.0, 1.0, out=drift)
    return guess


def _checkerboard(rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    return ((rows // SEAM_MATCH_TILE + cols // SEAM_MATCH_TILE) % 2) == 0


def _held_out_gain(errors) -> float:
    """1 - (held-out error with the fit) / (held-out error with nothing)."""
    none, fitted = errors
    return 1.0 - fitted / max(none, 1e-12)


def _smooth_fields(fields: np.ndarray, sigma: float) -> np.ndarray:
    """Every layer of ``fields`` [L, H, W] smoothed along the edge: averaged
    over 4 px cells, blurred at a quarter of ``sigma`` there and scaled back
    up, all layers in one go."""
    height, width = fields.shape[-2:]
    small = functional.avg_pool2d(torch.from_numpy(fields).unsqueeze(0), 4, stride=4, ceil_mode=True)
    small = _seam_blur(small, max(0.5, sigma / 4.0))
    return functional.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)[0].numpy()


def _gain_fields(pixels, shape, weights: np.ndarray, tone: np.ndarray, miss: np.ndarray):
    """The [L, 3, H, W] numerators and denominators of local gains g with
    miss ~ g * tone, one per weight layer in ``weights`` [L, n] over the band
    ``pixels`` (rows, cols), whose ``tone`` and ``miss`` are [3, n]: both
    smoothed along the edge (see :func:`_smooth_fields`)."""
    layers = weights.shape[0]
    fields = np.zeros((2 * layers, 3) + tuple(shape), dtype=np.float32)
    weighted = weights[:, None, :] * tone[None]
    fields[:layers, :, pixels[0], pixels[1]] = weighted * miss[None]
    fields[layers:, :, pixels[0], pixels[1]] = weighted * tone[None]
    smoothed = _smooth_fields(fields.reshape((-1,) + tuple(shape)), SEAM_MATCH_ALONG)
    smoothed = smoothed.reshape((2 * layers, 3) + tuple(shape))
    return smoothed[:layers], smoothed[layers:]


def _gain_floor(denominator: np.ndarray) -> float:
    return SEAM_MATCH_FALLBACK * float(denominator.max()) + 1e-12


def _gain(numerator: np.ndarray, denominator: np.ndarray, floor: float) -> np.ndarray:
    """The local gain, capped at SEAM_MATCH_GAIN_MAX and easing to 0 away
    from any measurement (``floor``, from :func:`_gain_floor`)."""
    return np.clip(numerator / (denominator + np.float32(floor)), -SEAM_MATCH_GAIN_MAX, SEAM_MATCH_GAIN_MAX)


def blend_in_tone_match(canvas: torch.Tensor, patch: torch.Tensor, plan: dict) -> dict | None:
    """What Tone match takes off the model's picture before blend in, or None
    when there is nothing it can trust.

    ``canvas`` [1 or B, H, W, C] and ``patch`` [B, H, W, C] as in
    :func:`blend_in_seam`, ``plan`` from :func:`seam_plan`. Your picture and
    the model's are compared as tone layers (blur sigma SEAM_MATCH_SIGMA, both
    over the same clean picture pixels) over the band the model redrew: picture pixels at
    least SEAM_CLEAN_DEPTH inside the edge where the sampler mask is above
    SEAM_MATCH_MIN_MASK, clipped highlights left out. Every frame is measured
    at once through the frames' mean, so a clip gets one correction and no
    flicker. The drift curves (:func:`_solve_curves`) must predict a
    held-out half of the band - alternate SEAM_MATCH_TILE px tiles - at least
    SEAM_MATCH_MIN_GAIN better than no correction, and the local gain along
    the edge another SEAM_MATCH_LOCAL_GAIN better than the curves alone.
    """
    sampler = plan.get("sampler")
    if sampler is None or canvas.shape[-1] < 3:
        return None
    frames, height, width = patch.shape[:3]
    depth = _numpy32(plan["depth"]).reshape(height, width)
    mask = _numpy32(sampler).reshape(height, width)
    inside = depth >= SEAM_CLEAN_DEPTH
    clean = inside.astype(np.float32)
    base = canvas[..., :3] if canvas.shape[0] == 1 else canvas[..., :3].float().mean(dim=0, keepdim=True)
    model = patch[..., :3] if frames == 1 else patch[..., :3].float().mean(dim=0, keepdim=True)
    base, model = _numpy32(base[0]), _numpy32(model[0])  # [H, W, 3]
    # Every tone layer in one blur: the clean share itself, your picture and
    # the model's over the same clean pixels (blurred across the edge, the
    # model's would carry the new area's content into the band and read it as
    # drift), and the mask, which the tone layers average the same way.
    layers = np.empty((8, height, width), dtype=np.float32)
    layers[0] = clean
    np.multiply(base.transpose(2, 0, 1), clean, out=layers[1:4])
    np.multiply(model.transpose(2, 0, 1), clean, out=layers[4:7])
    np.multiply(mask, clean, out=layers[7])
    blurred = _seam_blur(torch.from_numpy(layers).unsqueeze(0), SEAM_MATCH_SIGMA)[0].numpy()
    rows, cols = np.nonzero(inside & (mask > np.float32(SEAM_MATCH_MIN_MASK)))
    share = np.maximum(blurred[0, rows, cols], np.float32(1e-4))
    tones = blurred[1:, rows, cols] / share
    del blurred
    band = (tones[0:3].max(axis=0) < np.float32(SEAM_MATCH_CLIP)) & (tones[3:6].max(axis=0) < np.float32(SEAM_MATCH_CLIP))
    rows, cols, share, tones = rows[band], cols[band], share[band], tones[:, band]
    if rows.size < SEAM_MATCH_MIN_PIXELS:
        return None
    stride = max(1, rows.size // SEAM_MATCH_SAMPLES)
    v = np.ascontiguousarray(tones[0:3, ::stride].T)
    d = np.ascontiguousarray(tones[3:6, ::stride].T) - v
    halves = _checkerboard(rows[::stride], cols[::stride])
    if min(int(halves.sum()), int((~halves).sum())) < 50:
        return None
    samples = _DriftSamples(v, np.ascontiguousarray(tones[6, ::stride]), d)
    pinned, free, weight = _robust_fits(samples, halves)

    # The check: each half's fit predicts the other half.
    other = np.where(halves, 2, 1)[:, None].astype(np.int64)
    held_out = samples.d - samples.drift(pinned, free, (other * 3 + np.arange(3)) * _POINTS + samples.segment)
    errors = (
        float((weight.astype(np.float64)[:, None] * np.abs(samples.d)).sum()),
        float((weight.astype(np.float64)[:, None] * np.abs(held_out)).sum()),
    )
    if _held_out_gain(errors) < SEAM_MATCH_MIN_GAIN:
        return None
    curves = (pinned[0], free[0])

    # Drift that changes along the edge (sky and water on one side) is left
    # in the model's curve-corrected tone; a local gain, which leaves black
    # black, takes it off when it holds out as well.
    undone = _undo_drift(model, curves[0], curves[1], mask[..., None])
    fixed = model + np.float32(1.0) * (undone - model)
    np.multiply(fixed.transpose(2, 0, 1), clean, out=layers[1:4])
    fixed_tone = _seam_blur(torch.from_numpy(layers[1:4]).unsqueeze(0), SEAM_MATCH_SIGMA)[0].numpy()[:, rows, cols] / share
    del layers
    tone = tones[0:3]
    miss = fixed_tone - tone
    band_w = mask[rows, cols] * mask[rows, cols]
    black = _checkerboard(rows, cols).astype(np.float32)
    parts = np.stack((black, np.float32(1.0) - black))
    numerator, denominator = _gain_fields((rows, cols), (height, width), band_w * parts, tone, miss)
    band_mask = mask[rows, cols]
    errors = [0.0, 0.0]
    for index in range(2):
        test = parts[1 - index] > 0
        gain = _gain(numerator[index][:, rows, cols], denominator[index][:, rows, cols], _gain_floor(denominator[index]))
        errors[0] += float(np.abs(miss[:, test]).sum(dtype=np.float64))
        errors[1] += float(np.abs(miss - band_mask * gain * tone)[:, test].sum(dtype=np.float64))
    match = {"curves": curves, "mask": torch.from_numpy(mask).view(1, 1, height, width).to(patch.device), "gain": None}
    if frames == 1:
        # One picture: blend in applies the correction to this same picture,
        # so the values found here are kept for it.
        match["undone"] = (patch, undone)
    if _held_out_gain(errors) >= SEAM_MATCH_LOCAL_GAIN:
        # Smoothing is linear, so the whole band's field is its two halves'.
        numerator, denominator = numerator[0] + numerator[1], denominator[0] + denominator[1]
        gain = _gain(numerator, denominator, _gain_floor(denominator))
        match["gain"] = torch.from_numpy(np.ascontiguousarray(gain)).unsqueeze(0).to(patch.device)
    return match


def _apply_tone_match(model: torch.Tensor, match: dict, strength: float, undone: np.ndarray | None = None) -> torch.Tensor:
    """The model's frames [B, C, H, W] with Tone match's correction taken off,
    at ``strength`` (0..1). Channels past RGB pass through. ``undone`` is the
    frames' values already taken back through the curves, when known."""
    frames, height, width = model.shape[0], model.shape[2], model.shape[3]
    rgb = _numpy32(model[:, :3].movedim(1, -1))  # [B, H, W, 3]
    mask = _numpy32(match["mask"]).reshape(height, width, 1)
    if undone is None:
        undone = _undo_drift(rgb, match["curves"][0], match["curves"][1], mask)
    rgb = rgb + np.float32(strength) * (undone - rgb)
    gain = match["gain"]
    if gain is not None:
        gain = _numpy32(gain).reshape(3, height, width).transpose(1, 2, 0)
        rgb = rgb / (1.0 + np.float32(strength) * mask * gain)
    rgb = torch.from_numpy(np.clip(rgb, 0.0, 1.0).reshape(frames, height, width, 3))
    rgb = rgb.to(device=model.device, dtype=model.dtype).movedim(-1, 1)
    if model.shape[1] > 3:
        return torch.cat([rgb, model[:, 3:]], dim=1)
    return rgb


def blend_in_seam(
    canvas: torch.Tensor,
    patch: torch.Tensor,
    depth: torch.Tensor,
    tone: tuple[float, float],
    detail: tuple[float, float],
    out: torch.Tensor | None = None,
    match: dict | None = None,
    strength: float = 1.0,
) -> torch.Tensor:
    """Blend the model's full-canvas result into the canvas across the
    picture's edge and return [B, H, W, C], written into ``out`` when one
    is given (a long clip then holds no second copy of itself).

    ``canvas`` [1 or B, H, W, C] is the source and fill the model was given,
    ``patch`` [B, H, W, C] what came back, ``depth`` [1, H, W] and the ramps
    come from :func:`seam_plan`. Both pictures split into colour and tone (a
    blur at SEAM_TONE_SIGMA, the canvas's taken only over picture pixels
    SEAM_CLEAN_DEPTH or more inside, so the fill never leaks in) and detail
    (the rest). Colour and tone hand over from the patch to the canvas along
    ``tone``, detail along ``detail``, and part of the texture a cross-fade
    loses halfway is put back. Deeper than both ramps the result is the
    canvas bit for bit; at or outside the first ramp's start it is the patch
    bit for bit - or, with a ``match`` from :func:`blend_in_tone_match`, the
    patch with Tone match's correction taken off at ``strength``. Frames
    never read each other: they go through in chunks, with a cancel check and
    progress between chunks.
    """
    frames, height, width, channels = patch.shape
    dtype, device = patch.dtype, patch.device
    sd = depth.to(device=device, dtype=dtype).view(1, 1, height, width)
    tone_w = _smoothstep((sd - tone[0]) / (tone[1] - tone[0]))
    detail_w = _smoothstep((sd - detail[0]) / (detail[1] - detail[0]))
    model_w = 1.0 - detail_w
    clean = (sd >= SEAM_CLEAN_DEPTH).to(dtype)
    clean_share = _seam_blur(clean, SEAM_TONE_SIGMA).clamp_min(1e-4)
    source = sd >= max(tone[1], detail[1])
    new = sd <= min(tone[0], detail[0])
    ramp = (detail_w > 0) & (detail_w < 1)
    luma = torch.full((1, channels, 1, 1), 1.0 / channels, dtype=dtype, device=device)
    if channels >= 3:
        luma.zero_()
        luma[0, :3, 0, 0] = torch.tensor((0.299, 0.587, 0.114), dtype=dtype, device=device)

    def canvas_layers(image: torch.Tensor):
        tone_layer = _seam_blur(image * clean, SEAM_TONE_SIGMA) / clean_share
        grain = image - tone_layer
        grain_luma = (grain * luma).sum(dim=1, keepdim=True)
        return tone_layer, grain, grain_luma, _seam_blur(grain_luma * grain_luma, SEAM_TEXTURE_SIGMA)

    shared = canvas_layers(canvas[:1].movedim(-1, 1)) if canvas.shape[0] == 1 else None
    if out is None:
        out = torch.empty_like(patch)
    step = max(1, SEAM_CHUNK_PIXELS // max(1, height * width))
    starts = range(0, frames, step)
    progress = progress_bar(len(starts)) if len(starts) > 1 else None
    for done, start in enumerate(starts, 1):
        raise_if_interrupted()
        stop = min(frames, start + step)
        model = patch[start:stop].movedim(-1, 1)
        if match is not None and strength > 0:
            undone = match.get("undone")
            # A single picture was already taken back through the curves.
            undone = undone[1] if undone is not None and undone[0] is patch and frames == 1 else None
            model = _apply_tone_match(model, match, strength, undone)
        base = (canvas[:1] if shared is not None else canvas[start:stop]).movedim(-1, 1)
        base_tone, base_grain, base_luma, base_power = shared if shared is not None else canvas_layers(base)
        model_tone = _seam_blur(model, SEAM_TONE_SIGMA)
        model_grain = model - model_tone
        grain = model_w * model_grain + detail_w * base_grain
        model_luma = (model_grain * luma).sum(dim=1, keepdim=True)
        model_power = _seam_blur(model_luma * model_luma, SEAM_TEXTURE_SIGMA)
        cross_power = _seam_blur(model_luma * base_luma, SEAM_TEXTURE_SIGMA)
        faded = model_w**2 * model_power + detail_w**2 * base_power + 2.0 * model_w * detail_w * cross_power
        wanted = model_w * model_power + detail_w * base_power
        gain = (wanted.clamp_min(1e-9) / faded.clamp_min(1e-9)).sqrt().clamp(1.0, SEAM_TEXTURE_MAX_GAIN)
        gain = torch.where(ramp, 1.0 + SEAM_TEXTURE_KEEP * (gain - 1.0), torch.ones_like(gain))
        blended = model + tone_w * (base_tone - model_tone) + (grain * gain - model_grain)
        blended = torch.where(source, base, torch.where(new, model, blended.clamp(0.0, 1.0)))
        out[start:stop] = blended.movedim(1, -1)
        if progress is not None:
            progress.update_absolute(done, len(starts))
    return out


__all__ = [
    "RESIZE_ALGORITHMS",
    "SEAM_BLEND_IN",
    "SEAM_CLASSIC",
    "SEAM_MODES",
    "STITCHER_KIND",
    "blend_in_seam",
    "blend_in_tone_match",
    "blend_in_weight",
    "seam_plan",
    "seam_ramps",
    "build_canvas_stitcher",
    "build_transform_stitcher",
    "transform_picture_box",
    "stitch_blend_from_mask",
    "STITCHER_VERSION",
    "apply_stitch",
    "build_crop",
    "estimate_tone_offset",
    "shift_tone",
    "stitch_blend_mask",
    "clamp_rect_to_bounds",
    "expand_rect_to_multiple",
    "fit_rect",
    "grow_rect",
    "mask_bbox",
    "rect_margins",
    "round_up_to_multiple",
    "spread_edge_colors",
    "tone_offset_field",
]


def transform_picture_box(geometry, width: int, height: int) -> tuple[int, int, int, int]:
    """Where a transform's kept picture sits on its canvas at ``width`` x
    ``height``, as ``(x0, y0, x1, y1)`` pixels: the crop rectangle, scaled
    with the canvas when a resize changed its size. Never empty, so a
    picture far smaller than its padding still has a pixel to sit on.

    The megapixel resize pastes the picture into this box and the stitcher
    carries it as the source bbox, so the two cannot disagree.
    """
    width, height = int(width), int(height)
    scale_x = width / float(geometry.output_width)
    scale_y = height / float(geometry.output_height)
    x0 = min(int(round(geometry.pad_left * scale_x)), width - 1)
    y0 = min(int(round(geometry.pad_top * scale_y)), height - 1)
    x1 = min(width, max(x0 + 1, int(round((geometry.pad_left + geometry.crop_width) * scale_x))))
    y1 = min(height, max(y0 + 1, int(round((geometry.pad_top + geometry.crop_height) * scale_y))))
    return x0, y0, x1, y1


def build_transform_stitcher(
    frames, mask, geometry, blend_pixels: int, grow_pixels: int = 0, source: str = "Stitcher"
) -> dict:
    """A full-canvas stitcher for a transformed image or clip.

    The generated clip is the whole canvas, so the crop is the identity
    rectangle and the paste mask is the transform's generated-area mask -
    padding and rotation voids - ramped by the stitch settings. It is built
    from the final frames, after any resize, so the paste lines up with what
    the sampler actually returns; the source bbox rides along scaled the
    same way. ``source`` is the transform node, named in any input error.

    Unlike a padded photo, the bbox here is the crop rectangle, which can
    hold rotation voids and source transparency. The generated-area mask
    rides along as ``generated`` (the mask itself, not a copy) so the color
    match reads its seams off picture pixels only; a stitcher without it
    still stitches, reading every bbox pixel as picture.
    """
    blend = stitch_blend_from_mask(mask, blend_pixels, grow_pixels)
    bbox = transform_picture_box(geometry, frames.shape[2], frames.shape[1])
    stitcher = build_canvas_stitcher(frames, blend, bbox=bbox, source=source)
    stitcher["generated"] = mask
    return stitcher
