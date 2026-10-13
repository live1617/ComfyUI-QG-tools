"""Mask refinement helpers shared by QG-tools nodes."""

from __future__ import annotations

import math

import torch
import torch.nn.functional as functional

from ._qg_execution_helpers import raise_if_interrupted

try:
    from scipy.ndimage import binary_fill_holes as _scipy_fill_holes
    from scipy.ndimage import label as _scipy_label
except Exception:  # scipy is optional; the torch fallback below covers it.
    _scipy_fill_holes = None
    _scipy_label = None


# Core Load Image returns a 64x64 mask of zeros when the picture has no
# painted mask (no alpha channel), whatever the picture's own size. Picking
# a new picture after painting one gives the same stand-in, because the new
# file carries no mask.
UNPAINTED_MASK_SIZE = (64, 64)
NO_MASK_PAINTED = (
    "No mask painted: right-click your picture, choose Open in MaskEditor, "
    "paint the area, then click Save."
)


def is_unpainted_mask(mask) -> bool:
    """True for core Load Image's stand-in: a 64x64 mask of zeros."""
    return (
        isinstance(mask, torch.Tensor)
        and mask.ndim in (2, 3)
        and tuple(int(side) for side in mask.shape[-2:]) == UNPAINTED_MASK_SIZE
        and not bool(mask.any())
    )


def mask_size_mismatch(mask: torch.Tensor, height: int, width: int) -> str:
    """Why this mask cannot go with a width x height picture, in plain words."""
    if is_unpainted_mask(mask):
        return NO_MASK_PAINTED
    mask_height, mask_width = (int(side) for side in mask.shape[-2:])
    return (
        f"The mask is {mask_width}x{mask_height} but the picture is {width}x{height}. "
        "Use the mask made for this picture: right-click the picture, choose "
        "Open in MaskEditor, paint the area, then click Save."
    )


def _as_bhw(mask: torch.Tensor) -> torch.Tensor:
    if isinstance(mask, torch.Tensor) and mask.ndim == 2:
        mask = mask.unsqueeze(0)
    if not isinstance(mask, torch.Tensor) or mask.ndim != 3:
        raise ValueError("Mask Refine expected a BHW MASK.")
    return mask.float().clamp(0.0, 1.0)


def grow_shrink_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """Dilate (positive) or erode (negative) by whole pixels; soft values survive.

    One separable pass, not ``pixels`` iterated 3x3 pools: n 3x3 dilations
    equal a single (2n+1)-square dilation, and a square max filter splits
    into a horizontal then a vertical 1-D pass. Same result to the bit -
    max is order-free and the -inf padding composes identically - for a
    fraction of the work: two passes however far the mask moves, instead of
    2n full-image pools. Measured at 32 px on a 16-frame 1080p batch this
    is ~5x; the matting trimap, which used to pay it per frame, gains more.
    """
    steps = abs(int(pixels))
    if steps == 0:
        return mask
    size = 2 * steps + 1
    grown = mask.unsqueeze(1)
    if pixels > 0:
        grown = functional.max_pool2d(grown, kernel_size=(1, size), stride=1, padding=(0, steps))
        grown = functional.max_pool2d(grown, kernel_size=(size, 1), stride=1, padding=(steps, 0))
    else:
        grown = -functional.max_pool2d(-grown, kernel_size=(1, size), stride=1, padding=(0, steps))
        grown = -functional.max_pool2d(-grown, kernel_size=(size, 1), stride=1, padding=(steps, 0))
    return grown.squeeze(1)


def _torch_fill_holes(solid: torch.Tensor) -> torch.Tensor:
    """Flood the border-connected background; whatever is left inside is a hole."""
    background = ~solid
    reachable = torch.zeros_like(background)
    reachable[:, 0, :] = background[:, 0, :]
    reachable[:, -1, :] = background[:, -1, :]
    reachable[:, :, 0] = background[:, :, 0]
    reachable[:, :, -1] = background[:, :, -1]
    while True:
        grown = (
            functional.max_pool2d(
                reachable.float().unsqueeze(1), kernel_size=3, stride=1, padding=1
            )
            .squeeze(1)
            .bool()
            & background
        )
        if torch.equal(grown, reachable):
            break
        reachable = grown
    return solid | (background & ~reachable)


def _hole_limit(max_hole_size: float, height: int, width: int) -> float | None:
    """The largest hole to fill, in pixels; None fills every hole.

    max_hole_size is a percent of the frame's area. 0 means no limit, and so
    does anything from 100 up, since no hole is bigger than the frame; a
    value that is not a number leaves the fill unlimited too.
    """
    percent = float(max_hole_size)
    if not math.isfinite(percent) or percent <= 0.0 or percent >= 100.0:
        return None
    return percent / 100.0 * height * width


def _torch_hole_areas(holes: torch.Tensor) -> torch.Tensor:
    """Each hole pixel's hole size in pixels, 0 elsewhere, for one HW frame.

    Holes are 8-connected, the way _torch_fill_holes floods them. Every hole
    pixel starts with its own index; each pass takes the largest index in
    its 3x3 neighbourhood, then the index held by the pixel that index names
    (both stay inside the same hole), until every hole holds one index.
    """
    height, width = holes.shape
    inside = holes.reshape(-1)
    zero = torch.zeros((), dtype=torch.float64, device=holes.device)
    index = torch.arange(1, height * width + 1, dtype=torch.float64, device=holes.device)
    labels = torch.where(inside, index, zero)
    while True:
        spread = functional.max_pool2d(
            labels.view(1, 1, height, width), kernel_size=3, stride=1, padding=1
        ).reshape(-1)
        spread = torch.where(inside, spread, zero)
        spread = torch.where(inside, spread[(spread.long() - 1).clamp(min=0)], zero)
        if torch.equal(spread, labels):
            break
        labels = spread
    _, hole_of, sizes = torch.unique(labels, return_inverse=True, return_counts=True)
    return torch.where(inside, sizes[hole_of], 0).view(height, width)


def _fill_small_holes(solid: torch.Tensor, limit: float) -> torch.Tensor:
    """Fill only the enclosed holes of at most `limit` pixels, frame by frame."""
    frames = []
    for layer in solid:
        raise_if_interrupted()
        if _scipy_fill_holes is not None:
            array = layer.cpu().numpy()
            labels, _count = _scipy_label(_scipy_fill_holes(array) & ~array)
            labels = torch.from_numpy(labels).long()
            small = torch.bincount(labels.reshape(-1)) <= limit
            small[0] = False  # label 0 is everything that is not a hole
            frames.append(torch.from_numpy(array) | small[labels])
        else:
            layer = layer.cpu()  # the sizes count in float64, which not every device has
            holes = _torch_fill_holes(layer.unsqueeze(0))[0] & ~layer
            frames.append(layer | (holes & (_torch_hole_areas(holes) <= limit)))
    return torch.stack(frames).to(solid.device)


def fill_mask_holes(mask: torch.Tensor, max_hole_size: float = 0.0) -> torch.Tensor:
    """Fill the unselected areas the mask closes all the way round.

    An area touching the frame's edge is never a hole. With max_hole_size
    (a percent of the frame's area) above 0, only holes up to that size are
    filled, so a subject someone left unselected stays out of the mask.
    """
    solid = mask >= 0.5
    limit = _hole_limit(max_hole_size, mask.shape[-2], mask.shape[-1])
    if limit is not None:
        filled = _fill_small_holes(solid, limit)
    elif _scipy_fill_holes is not None:
        filled = torch.stack(
            [torch.from_numpy(_scipy_fill_holes(layer.cpu().numpy())) for layer in solid]
        ).to(mask.device)
    else:
        filled = _torch_fill_holes(solid)
    return torch.maximum(mask, filled.to(mask.dtype))


def blur_mask(mask: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma <= 0.0:
        return mask
    radius = max(1, int(math.ceil(float(sigma) * 3.0)))
    coords = torch.arange(-radius, radius + 1, dtype=torch.float32, device=mask.device)
    kernel = torch.exp(-(coords**2) / (2.0 * float(sigma) ** 2))
    kernel = kernel / kernel.sum()
    blurred = mask.unsqueeze(1)
    blurred = functional.pad(blurred, (radius, radius, 0, 0), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, 1, -1))
    blurred = functional.pad(blurred, (0, 0, radius, radius), mode="replicate")
    blurred = functional.conv2d(blurred, kernel.view(1, 1, -1, 1))
    return blurred.squeeze(1)


def smooth_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """Melt staircase jaggies while keeping a hard edge.

    Binarize at 0.5, gaussian-blur with sigma ~ pixels, re-binarize at 0.5,
    and apply only the DIFFERENCE that made to the mask it was given. Unlike
    blur_mask this adds no softness of its own, so it de-jaggies segmentation
    edges without feathering them.

    Applying the difference rather than the re-binarized result is what lets
    a mask that is already soft - a matte, or anything that has been
    feathered upstream - keep its soft alpha. On a binary mask the difference
    is the whole change, so the result is bit-identical to a plain threshold.
    """
    if int(pixels) <= 0:
        return mask
    solid = (mask >= 0.5).to(mask.dtype)
    melted = (blur_mask(solid, float(int(pixels))) >= 0.5).to(mask.dtype)
    return (mask + (melted - solid)).clamp(0.0, 1.0)


# Below this an alpha reads as empty, above 1 - this as fully opaque. Only
# used to tell a feathered edge from a hard one when seeding a trimap.
_SOFT_EPSILON = 1e-3

EDGE_REFINE_MODES = ("off", "guided filter", "matting")

_GUIDED_FILTER_HINT = (
    "Mask Refine edge_refine 'guided filter' needs the optional "
    "opencv-contrib dependency. Add the opencv-contrib-python package to "
    "ComfyUI's python (the pack's 'guided-filter' optional-dependencies "
    "group), then restart ComfyUI."
)
_MATTING_HINT = (
    "Mask Refine edge_refine 'matting' needs the optional pymatting "
    "dependency. Add the pymatting package to ComfyUI's python (the pack's "
    "'matting' optional-dependencies group), then restart ComfyUI."
)


def _optional_import(module_name: str):
    """Import an optional dependency at call time; tests monkeypatch this."""
    import importlib

    return importlib.import_module(module_name)


def _load_guided_filter():
    try:
        cv2 = _optional_import("cv2")
    except ImportError as exc:
        raise RuntimeError(_GUIDED_FILTER_HINT) from exc
    ximgproc = getattr(cv2, "ximgproc", None)
    if ximgproc is None or not hasattr(ximgproc, "guidedFilter"):
        # Plain opencv-python ships without the contrib ximgproc module.
        raise RuntimeError(_GUIDED_FILTER_HINT)
    return ximgproc.guidedFilter


def _load_alpha_matting():
    try:
        pymatting = _optional_import("pymatting")
    except ImportError as exc:
        raise RuntimeError(_MATTING_HINT) from exc
    estimate = getattr(pymatting, "estimate_alpha_cf", None)
    if estimate is None:
        raise RuntimeError(_MATTING_HINT)
    return estimate


def _edge_radius(expand: int) -> int:
    """Working radius at the edge, scaled with how far the mask was moved."""
    return max(4, 2 * abs(int(expand)))


def _guide_frames(
    guide_image: torch.Tensor, count: int, height: int, width: int
) -> torch.Tensor:
    """Validate guide_image against the mask batch and return BHWC RGB frames."""
    if (
        not isinstance(guide_image, torch.Tensor)
        or guide_image.ndim != 4
        or guide_image.shape[-1] < 3
    ):
        raise ValueError("Mask Refine expected guide_image as a BHWC RGB IMAGE batch.")
    if tuple(guide_image.shape[1:3]) != (height, width):
        raise ValueError(
            f"Mask Refine guide_image is {guide_image.shape[2]}x{guide_image.shape[1]} "
            f"but the mask is {width}x{height}; connect the image the mask belongs to."
        )
    if guide_image.shape[0] not in {1, count}:
        raise ValueError(
            "Mask Refine needs one guide frame for the whole mask batch or one per mask."
        )
    # Validated view only - the float()/clamp() copy happens per frame at the
    # call sites, so a whole-batch duplicate of the guide (398 MB for 16
    # frames of 1080p) is never resident alongside the solve.
    frames = guide_image[..., :3]
    if frames.shape[0] == 1 and count > 1:
        frames = frames.expand(count, -1, -1, -1)
    return frames


def guided_filter_refine(
    mask: torch.Tensor, guide_image: torch.Tensor, expand: int
) -> torch.Tensor:
    """Snap soft mask edges to guide-image edges with an edge-aware filter."""
    guided_filter = _load_guided_filter()
    count, height, width = mask.shape
    guides = _guide_frames(guide_image, count, height, width)
    radius = _edge_radius(expand)
    frames = []
    for index in range(count):
        raise_if_interrupted()
        guide = guides[index].detach().float().clamp(0.0, 1.0).contiguous().cpu().numpy()
        source = mask[index].detach().float().contiguous().cpu().numpy()
        frames.append(torch.from_numpy(guided_filter(guide, source, radius, 1e-4)))
    return torch.stack(frames).to(device=mask.device, dtype=mask.dtype).clamp(0.0, 1.0)


def matting_refine(
    mask: torch.Tensor, guide_image: torch.Tensor, expand: int
) -> torch.Tensor:
    """Closed-form alpha matting around the mask edge.

    The binarized mask eroded by the edge radius is definite foreground, the
    dilation marks where definite background begins, and the band between is
    solved by pymatting's estimate_alpha_cf against the guide image.
    """
    estimate_alpha_cf = _load_alpha_matting()
    count, height, width = mask.shape
    guides = _guide_frames(guide_image, count, height, width)
    band = _edge_radius(expand)
    # Morphology once for the whole batch, not per frame: pooling is
    # per-sample, so the batched call is bit-identical, and rebuilding the
    # trimap inside the loop was paying the erode/dilate `count` times over.
    alpha_all = mask.detach().float().cpu()
    solid_all = (alpha_all >= 0.5).float()
    eroded_all = grow_shrink_mask(solid_all, -band) >= 0.5
    dilated_all = grow_shrink_mask(solid_all, band) >= 0.5
    frames = []
    for index in range(count):
        raise_if_interrupted()
        alpha_in = alpha_all[index]
        # Definite foreground has to be opaque in the mask we were handed, and
        # anything carrying any alpha at all is at least possible foreground.
        # On a binary mask those reduce to exactly the eroded and dilated
        # shapes; on a feathered one the soft ramp widens the unknown band,
        # which is what lets the blur control reach the solve instead of being
        # thresholded straight back out of it.
        sure_fg = eroded_all[index] & (alpha_in >= 1.0 - _SOFT_EPSILON)
        possible = dilated_all[index] | (alpha_in > _SOFT_EPSILON)
        unknown = possible & ~sure_fg
        if not bool(unknown.any()) or not bool(sure_fg.any()) or bool(possible.all()):
            # Degenerate trimap (empty mask, mask everywhere, or a shape the
            # band swallows whole): keep this frame's mask as it arrived.
            frames.append(alpha_in)
            continue
        trimap = torch.full((height, width), 0.5, dtype=torch.float64)
        trimap[~possible] = 0.0
        trimap[sure_fg] = 1.0
        guide = (
            guides[index].detach().float().clamp(0.0, 1.0).contiguous().cpu().numpy().astype("float64")
        )
        alpha = estimate_alpha_cf(guide, trimap.numpy())
        frames.append(torch.from_numpy(alpha).float())
    return torch.stack(frames).to(device=mask.device, dtype=mask.dtype).clamp(0.0, 1.0)


def remap_mask(
    mask: torch.Tensor, black_point: float, white_point: float
) -> torch.Tensor:
    """Levels remap: values at or below black_point become 0, values at or
    above white_point become 1, the range between rescales linearly. Clears
    gray haze left behind by soft segmentation or feathering."""
    black = float(black_point)
    white = float(white_point)
    if black <= 0.0 and white >= 1.0:
        return mask
    span = max(white - black, 1e-6)  # degenerate points act as a threshold
    return ((mask - black) / span).clamp(0.0, 1.0)


def refine_mask(
    mask: torch.Tensor,
    expand: int,
    blur: float,
    fill_holes: bool,
    smooth: int = 0,
    black_point: float = 0.0,
    white_point: float = 1.0,
    edge_refine: str = "off",
    guide_image: torch.Tensor | None = None,
    max_hole_size: float = 0.0,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Expand, fill holes, smooth, feather, edge-refine, then remap levels.

    max_hole_size limits fill holes to holes up to that percent of the
    frame's area; 0 (the default) fills every hole, as before it existed.
    """
    if edge_refine not in EDGE_REFINE_MODES:
        raise ValueError(
            f"Mask Refine edge_refine must be one of {EDGE_REFINE_MODES}, "
            f"not '{edge_refine}'."
        )
    if edge_refine != "off" and guide_image is None:
        raise ValueError(
            f"Mask Refine edge_refine '{edge_refine}' needs the guide_image "
            "input; connect the RGB image the mask belongs to, or set "
            "edge_refine back to 'off'."
        )
    refined = _as_bhw(mask)
    if (
        isinstance(guide_image, torch.Tensor)
        and guide_image.ndim == 4
        and tuple(guide_image.shape[1:3]) != tuple(refined.shape[1:])
        and is_unpainted_mask(refined)
    ):
        raise ValueError(NO_MASK_PAINTED)
    refined = grow_shrink_mask(refined, expand)
    if fill_holes:
        refined = fill_mask_holes(refined, max_hole_size)
    refined = smooth_mask(refined, int(smooth))
    refined = blur_mask(refined, blur).clamp(0.0, 1.0)
    if edge_refine == "guided filter":
        refined = guided_filter_refine(refined, guide_image, expand)
    elif edge_refine == "matting":
        refined = matting_refine(refined, guide_image, expand)
    refined = remap_mask(refined, black_point, white_point)
    return refined, 1.0 - refined


__all__ = [
    "EDGE_REFINE_MODES",
    "blur_mask",
    "fill_mask_holes",
    "grow_shrink_mask",
    "guided_filter_refine",
    "matting_refine",
    "refine_mask",
    "remap_mask",
    "smooth_mask",
]
