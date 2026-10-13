"""Color helpers shared by QG-tools nodes: fill-color parsing and LAB
statistics matching.

Fill-color precedence (keep in sync with js/shared/fill_color.mjs):
  1. Hex: #RGB / #RRGGBB, and bare hex when unambiguous (6 digits, or a
     3-char form containing a-f). A bare 3-digit number like "128" is
     grayscale, not short hex.
  2. Numbers: "R, G, B" (commas or spaces) or one bare grayscale value.
     When every value is <= 1 they read as 0..1 floats, otherwise 0-255.
  3. CSS color names via PIL.ImageColor.
  4. Anything else warns once (ASCII) and falls back to mid-gray.
"""

from __future__ import annotations

import math
import re

import torch
from PIL import ImageColor

from ._qg_execution_helpers import warn_once

FALLBACK_RGB = (128, 128, 128)

_HEX_PATTERN = re.compile(r"^#?([0-9a-f]{3}|[0-9a-f]{6})$")
_NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")

# Unparseable colors already reported. They are typed values, so past this
# many remembered notes the set starts over rather than growing all session.
_warned_values: set[str] = set()
_WARNED_VALUE_LIMIT = 256


def _channels_from_numbers(numbers: list[float]) -> tuple[int, int, int]:
    if all(number <= 1.0 for number in numbers):
        numbers = [number * 255.0 for number in numbers]
    if len(numbers) == 1:
        numbers = numbers * 3
    # floor(x + 0.5) matches JavaScript's Math.round, keeping the editor
    # preview and the backend byte-identical on .5 boundaries.
    return tuple(max(0, min(255, math.floor(number + 0.5))) for number in numbers)


def parse_fill_color(value: object, source: str = "Transform fill_color") -> tuple[int, int, int]:
    """Parse a fill color leniently; never raises, falls back to mid-gray.

    ``source`` names the node and widget in the console note, so a colour the
    parser could not read is reported against the control the user actually
    typed it into rather than against whichever node happened to be first to
    call this."""
    text = str("" if value is None else value).strip()
    lowered = text.lower()

    match = _HEX_PATTERN.match(lowered)
    if match:
        digits = match.group(1)
        unambiguous = lowered.startswith("#") or len(digits) == 6 or any(
            character in "abcdef" for character in digits
        )
        if unambiguous:
            if len(digits) == 3:
                digits = "".join(character * 2 for character in digits)
            return tuple(int(digits[index : index + 2], 16) for index in (0, 2, 4))

    parts = [part for part in lowered.replace(",", " ").split() if part]
    if len(parts) in (1, 3) and all(_NUMBER_PATTERN.match(part) for part in parts):
        return _channels_from_numbers([float(part) for part in parts])

    if text:
        try:
            rgb = ImageColor.getrgb(text)
            return tuple(int(channel) for channel in rgb[:3])
        except ValueError:
            pass

    # Keyed by widget as well as value: the same unparseable color typed into
    # two different nodes is two different mistakes to go and fix, and one
    # node staying silent because another already complained is worse than a
    # repeated line.
    safe = text.encode("ascii", "backslashreplace").decode("ascii")
    warn_once(
        f"{source}: could not parse '{safe}'; using mid-gray 128,128,128.",
        _warned_values,
        key=f"{source}\x00{text}",
        limit=_WARNED_VALUE_LIMIT,
    )
    return FALLBACK_RGB


# --- pure-torch sRGB <-> CIELAB ----------------------------------------------
#
# D65 white point, float32 throughout, BHWC in and out. No cv2 or numpy —
# the conversions run on whatever device the tensors already live on.

_D65 = (0.95047, 1.0, 1.08883)
_DELTA = 6.0 / 29.0

_RGB_TO_XYZ = (
    (0.4124564, 0.3575761, 0.1804375),
    (0.2126729, 0.7151522, 0.0721750),
    (0.0193339, 0.1191920, 0.9503041),
)
_XYZ_TO_RGB = (
    (3.2404542, -1.5371385, -0.4985314),
    (-0.9692660, 1.8760108, 0.0415560),
    (0.0556434, -0.2040259, 1.0572252),
)


def _matrix(rows, like: torch.Tensor) -> torch.Tensor:
    return torch.tensor(rows, dtype=like.dtype, device=like.device)


def rgb_to_lab(rgb: torch.Tensor) -> torch.Tensor:
    """BHWC sRGB in [0, 1] to BHWC CIELAB (L in [0, 100], a/b signed)."""
    rgb = rgb.clamp(0.0, 1.0)
    linear = torch.where(
        rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4
    )
    xyz = linear @ _matrix(_RGB_TO_XYZ, rgb).T
    scaled = xyz / _matrix([_D65], rgb)
    f = torch.where(
        scaled > _DELTA**3,
        scaled.clamp_min(1e-12) ** (1.0 / 3.0),
        scaled / (3.0 * _DELTA**2) + 4.0 / 29.0,
    )
    fx, fy, fz = f.unbind(-1)
    return torch.stack(
        [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], dim=-1
    )


def lab_to_rgb(lab: torch.Tensor) -> torch.Tensor:
    """BHWC CIELAB back to BHWC sRGB, clamped to [0, 1]."""
    lightness, a, b = lab.unbind(-1)
    fy = (lightness + 16.0) / 116.0
    f = torch.stack([fy + a / 500.0, fy, fy - b / 200.0], dim=-1)
    scaled = torch.where(
        f > _DELTA, f**3, 3.0 * _DELTA**2 * (f - 4.0 / 29.0)
    )
    xyz = scaled * _matrix([_D65], lab)
    linear = (xyz @ _matrix(_XYZ_TO_RGB, lab).T).clamp_min(0.0)
    srgb = torch.where(
        linear <= 0.0031308,
        linear * 12.92,
        1.055 * linear ** (1.0 / 2.4) - 0.055,
    )
    return srgb.clamp(0.0, 1.0)


# --- color statistics matching -----------------------------------------------

# Method names are the node's combo values. All are textbook constructions
# implemented here from the math: per-channel mean/std transfer in LAB or RGB,
# the closed-form Monge-Kantorovich linear covariance mapping, and per-channel
# histogram (quantile) matching.
COLOR_MATCH_METHODS = ("lab", "rgb", "mkl", "histogram")


def _weighted_lab_stats(
    lab: torch.Tensor, weights: torch.Tensor | None
) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-frame, per-channel (mean, std) over H and W, optionally weighted."""
    if weights is None:
        mean = lab.mean(dim=(1, 2), keepdim=True)
        std = lab.std(dim=(1, 2), keepdim=True, unbiased=False)
        return mean, std
    w = weights.unsqueeze(-1)
    total = w.sum(dim=(1, 2), keepdim=True).clamp_min(1e-8)
    mean = (lab * w).sum(dim=(1, 2), keepdim=True) / total
    var = (((lab - mean) ** 2) * w).sum(dim=(1, 2), keepdim=True) / total
    return mean, var.clamp_min(0.0).sqrt()


def _stats_matched(
    rgb: torch.Tensor,
    reference: torch.Tensor,
    mask: torch.Tensor | None,
    in_lab: bool,
) -> torch.Tensor:
    """Mean/std transfer per channel, in LAB or straight RGB."""
    source = rgb_to_lab(rgb) if in_lab else rgb
    ref = rgb_to_lab(reference) if in_lab else reference
    img_mean, img_std = _weighted_lab_stats(source, mask)
    ref_mean, ref_std = _weighted_lab_stats(ref, None)
    gain = ref_std / img_std.clamp_min(1e-6)
    matched = (source - img_mean) * gain + ref_mean
    return lab_to_rgb(matched) if in_lab else matched.clamp(0.0, 1.0)


def _weighted_mean_cov(
    pixels: torch.Tensor, weights: torch.Tensor | None
) -> tuple[torch.Tensor, torch.Tensor]:
    """(mean[3], covariance[3,3]) of an N x 3 pixel list, optionally weighted."""
    if weights is None:
        mean = pixels.mean(dim=0)
        centered = pixels - mean
        cov = centered.T @ centered / max(1, pixels.shape[0])
        return mean, cov
    total = weights.sum().clamp_min(1e-8)
    mean = (pixels * weights.unsqueeze(-1)).sum(dim=0) / total
    centered = pixels - mean
    cov = (centered * weights.unsqueeze(-1)).T @ centered / total
    return mean, cov


def _matrix_sqrt(matrix: torch.Tensor, inverse: bool = False) -> torch.Tensor:
    """Symmetric PSD square root (or inverse square root) via eigh."""
    values, vectors = torch.linalg.eigh(matrix.double())
    values = values.clamp_min(1e-10)
    roots = values.rsqrt() if inverse else values.sqrt()
    return (vectors @ torch.diag(roots) @ vectors.T).to(matrix.dtype)


def _mkl_matched(
    rgb: torch.Tensor, reference: torch.Tensor, mask: torch.Tensor | None
) -> torch.Tensor:
    """Monge-Kantorovich linear color mapping (Pitie's closed form).

    The unique linear map A with A @ cov_img @ A = cov_ref moves the image's
    RGB covariance onto the reference's while touching pixels as little as
    any linear map can. Frames are processed one at a time; batches here are
    short next to the 3x3 eigendecompositions being cheap.
    """
    frames = []
    for index in range(rgb.shape[0]):
        pixels = rgb[index].reshape(-1, 3)
        weights = None
        if mask is not None:
            weights = mask[index if mask.shape[0] > 1 else 0].reshape(-1)
        img_mean, img_cov = _weighted_mean_cov(pixels, weights)
        ref_pixels = reference[index if reference.shape[0] > 1 else 0].reshape(-1, 3)
        ref_mean, ref_cov = _weighted_mean_cov(ref_pixels, None)
        img_root = _matrix_sqrt(img_cov)
        img_root_inv = _matrix_sqrt(img_cov, inverse=True)
        middle = _matrix_sqrt(img_root @ ref_cov @ img_root)
        mapping = img_root_inv @ middle @ img_root_inv
        matched = (pixels - img_mean) @ mapping.T + ref_mean
        frames.append(matched.reshape(rgb.shape[1], rgb.shape[2], 3))
    return torch.stack(frames, dim=0).clamp(0.0, 1.0)


def _histogram_matched(
    rgb: torch.Tensor, reference: torch.Tensor, mask: torch.Tensor | None
) -> torch.Tensor:
    """Per-channel quantile mapping onto the reference's distribution.

    Each image value's rank inside the (masked) region indexes the same
    quantile of the reference channel — full histogram shape transfer, the
    strongest and least linear of the methods.
    """
    frames = []
    for index in range(rgb.shape[0]):
        frame = rgb[index]
        ref = reference[index if reference.shape[0] > 1 else 0]
        selected = None
        if mask is not None:
            region = mask[index if mask.shape[0] > 1 else 0] > 0.5
            if region.any():
                selected = region
        channels = []
        for channel in range(3):
            values = frame[..., channel]
            pool = values[selected] if selected is not None else values.reshape(-1)
            sorted_pool, _ = pool.reshape(-1).sort()
            sorted_ref, _ = ref[..., channel].reshape(-1).sort()
            # Rank every pixel against the measured pool, then read the same
            # quantile off the reference.
            ranks = torch.searchsorted(sorted_pool, values.reshape(-1).contiguous())
            ranks = ranks.clamp_max(sorted_pool.numel() - 1)
            quantiles = ranks.float() / max(1, sorted_pool.numel() - 1)
            positions = quantiles * (sorted_ref.numel() - 1)
            low = positions.floor().long()
            high = positions.ceil().long()
            fraction = positions - low.float()
            mapped = sorted_ref[low] * (1.0 - fraction) + sorted_ref[high] * fraction
            channels.append(mapped.reshape(values.shape))
        frames.append(torch.stack(channels, dim=-1))
    return torch.stack(frames, dim=0).clamp(0.0, 1.0)


def match_colors(
    image: torch.Tensor,
    reference: torch.Tensor,
    strength: float,
    mask: torch.Tensor | None = None,
    method: str = "lab",
    invert_mask: bool = False,
) -> torch.Tensor:
    """Transfer the reference's color statistics onto the image.

    ``method`` picks the construction: "lab" and "rgb" move per-channel
    mean/std in that space, "mkl" maps the full RGB covariance through the
    Monge-Kantorovich linear transform, "histogram" matches each channel's
    quantiles exactly. With a mask, both the measured statistics and the
    applied correction are restricted to the white region (``invert_mask``
    flips which side that is); pixels where the mask is zero are returned
    bit-identical. ``strength`` lerps between the original (0) and the
    fully matched image (1). A batch-1 reference broadcasts across an
    image batch.
    """
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("Color Match expected a BHWC IMAGE batch.")
    if not isinstance(reference, torch.Tensor) or reference.ndim != 4:
        raise ValueError("Color Match expected a BHWC reference IMAGE.")
    if reference.shape[0] not in (1, image.shape[0]):
        raise ValueError(
            f"Reference batch {reference.shape[0]} cannot broadcast across "
            f"image batch {image.shape[0]}."
        )
    if method not in COLOR_MATCH_METHODS:
        raise ValueError(
            f"Color Match method must be one of {COLOR_MATCH_METHODS}, "
            f"not '{method}'."
        )
    image = image.float()
    reference = reference.float()
    strength = max(0.0, min(1.0, float(strength)))
    if strength == 0.0:
        return image

    if mask is not None:
        if mask.ndim == 2:
            mask = mask.unsqueeze(0)
        if not isinstance(mask, torch.Tensor) or mask.ndim != 3:
            raise ValueError("Color Match expected a BHW MASK.")
        if mask.shape[1:] != image.shape[1:3]:
            from ._qg_mask_helpers import mask_size_mismatch

            raise ValueError(mask_size_mismatch(mask, int(image.shape[1]), int(image.shape[2])))
        if mask.shape[0] not in (1, image.shape[0]):
            raise ValueError(
                f"Mask batch {mask.shape[0]} cannot broadcast across "
                f"image batch {image.shape[0]}."
            )
        mask = mask.float().clamp(0.0, 1.0)
        if invert_mask:
            mask = 1.0 - mask
        if mask.shape[0] == 1 and image.shape[0] > 1:
            mask = mask.expand(image.shape[0], -1, -1)

    rgb = image[..., :3]
    ref_rgb = reference[..., :3]
    if method == "mkl":
        matched = _mkl_matched(rgb, ref_rgb, mask)
    elif method == "histogram":
        matched = _histogram_matched(rgb, ref_rgb, mask)
    else:
        matched = _stats_matched(rgb, ref_rgb, mask, in_lab=method == "lab")

    if mask is None:
        blend = torch.full(
            (image.shape[0], 1, 1, 1), strength, dtype=image.dtype, device=image.device
        ).expand(image.shape[0], image.shape[1], image.shape[2], 1)
    else:
        blend = (mask * strength).unsqueeze(-1)
    mixed = rgb + blend * (matched - rgb)
    # The where-guard pins zero-blend pixels bit-exactly, whatever the
    # LAB round trip produced there.
    mixed = torch.where(blend > 0, mixed, rgb)
    if image.shape[3] > 3:
        mixed = torch.cat([mixed, image[..., 3:]], dim=-1)
    return mixed


__all__ = [
    "COLOR_MATCH_METHODS",
    "FALLBACK_RGB",
    "lab_to_rgb",
    "match_colors",
    "parse_fill_color",
    "rgb_to_lab",
]
