"""Pure rotate, crop, and pad processing shared by the QG-tools loaders."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Iterable

import numpy as np
from ._qg_execution_helpers import advance_progress, frame_progress, raise_if_interrupted
from PIL import Image, ImageFilter
import torch

from ._qg_color_helpers import parse_fill_color
from ._qg_inpaint_crop_helpers import transform_picture_box
from ._qg_pad_helpers import _axis_layout


MAX_DIMENSION = 65536
MAX_PADDING = 32768

# A source pixel stays picture when its alpha is at least this share, in
# percent, of the most solid pixel's; anything more see-through is area to
# paint, like the padding. Measured on stranger-test cutouts: an oval photo
# whose edge ramp stores colours darkened by their alpha keeps a rim at most
# 10% dark at 90 (half dark at 50, the ring the model painted back), while
# matting noise inside solid subjects sits above 90, so no holes open there.
# Relative to the most solid pixel, a picture saved at 50% opacity throughout
# is kept whole instead of painted over. A picture at least this solid
# everywhere has no see-through part and goes through exactly as before
# (generated pictures often carry alpha 249-254 in places).
SEE_THROUGH_KEEP_PERCENT = 90
# How see-through parts are shown to a prompt writer (prompt_image) and in
# the untransformed `original`: on white, as a picture viewer shows them.
SEE_THROUGH_BACKDROP = (255, 255, 255)


@dataclass(frozen=True)
class TransformSpec:
    rotation_degrees: float = 0.0
    crop_aspect_ratio: str = "free"
    crop_x: int = 0
    crop_y: int = 0
    crop_width: int = 0
    crop_height: int = 0
    pad_left: int = 0
    pad_top: int = 0
    pad_right: int = 0
    pad_bottom: int = 0
    feather: int = 0
    canvas_multiple: int = 1
    fill_color: str = "#808080"

    def normalized(self) -> "TransformSpec":
        angle = ((float(self.rotation_degrees) + 180.0) % 360.0) - 180.0
        if abs(angle) < 0.00005:
            angle = 0.0
        return TransformSpec(
            rotation_degrees=round(angle, 4),
            crop_aspect_ratio=normalize_aspect_ratio(self.crop_aspect_ratio),
            crop_x=max(0, int(self.crop_x)),
            crop_y=max(0, int(self.crop_y)),
            crop_width=max(0, int(self.crop_width)),
            crop_height=max(0, int(self.crop_height)),
            pad_left=_bounded_padding(self.pad_left, "pad_left"),
            pad_top=_bounded_padding(self.pad_top, "pad_top"),
            pad_right=_bounded_padding(self.pad_right, "pad_right"),
            pad_bottom=_bounded_padding(self.pad_bottom, "pad_bottom"),
            feather=max(0, min(int(self.feather), 4096)),
            canvas_multiple=max(1, min(int(self.canvas_multiple), 4096)),
            fill_color=normalize_fill_color(self.fill_color),
        )


@dataclass(frozen=True)
class TransformGeometry:
    rotated_width: int
    rotated_height: int
    crop_x: int
    crop_y: int
    crop_width: int
    crop_height: int
    pad_left: int
    pad_top: int
    pad_right: int
    pad_bottom: int
    output_width: int
    output_height: int


def _bounded_padding(value: int, name: str) -> int:
    value = int(value)
    if value < 0 or value > MAX_PADDING:
        raise ValueError(
            f"Transform: input '{name}' expected 0..{MAX_PADDING}, received {value}."
        )
    return value


def normalize_fill_color(value: str) -> str:
    return "#" + "".join(f"{channel:02x}" for channel in parse_fill_color(value))


def fill_rgb(value: str) -> tuple[int, int, int]:
    return parse_fill_color(value)


def normalize_aspect_ratio(value: str) -> str:
    text = str(value or "free").strip().lower()
    if text in {"free", "source"}:
        return text
    try:
        width, height = (int(part) for part in text.split(":", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "Transform: input 'crop_aspect_ratio' expected free, source, or W:H."
        ) from exc
    if width < 1 or height < 1:
        raise ValueError("Transform: crop aspect ratio values must be positive.")
    common = math.gcd(width, height)
    return f"{width // common}:{height // common}"


def _validate_source(image: Image.Image) -> None:
    width, height = image.size
    if width < 1 or height < 1:
        raise ValueError("Transform: source image must contain at least one pixel.")
    if width > MAX_DIMENSION or height > MAX_DIMENSION:
        raise ValueError(
            f"Transform: source dimensions must be at most {MAX_DIMENSION} pixels per side."
        )


def see_through_kept(image: Image.Image) -> np.ndarray | None:
    """[H, W] bool map of the pixels that stay picture; the rest are see-through.

    None when every pixel is at least SEE_THROUGH_KEEP_PERCENT solid, so an
    opaque source takes exactly the path it always took. Otherwise a pixel
    stays when its alpha is at least SEE_THROUGH_KEEP_PERCENT of the most
    solid pixel's; a source with no solid pixel at all is see-through
    everywhere.
    """
    if "A" not in image.getbands():
        return None
    alpha = np.asarray(image.getchannel("A"))
    if int(alpha.min()) * 100 >= 255 * SEE_THROUGH_KEEP_PERCENT:
        return None
    top = int(alpha.max())
    return alpha.astype(np.int32) * 100 >= top * SEE_THROUGH_KEEP_PERCENT if top else np.zeros(alpha.shape, bool)


def _empty_see_through(rgba: Image.Image, kept: np.ndarray) -> Image.Image:
    """The source with its see-through pixels made empty, alpha 0 like a
    rotation corner, and every kept pixel fully solid in its own colour.

    The stored colour of a see-through pixel is often black or the old
    background, and blending it over the fill left a dark ring that the model
    painted back; with alpha 0 it never reaches the canvas (Pillow's turn
    resamples with the alpha applied), and the mask marks it as area to paint.
    """
    array = np.array(rgba, dtype=np.uint8)
    array[..., 3] = np.where(kept, 255, 0).astype(np.uint8)
    return Image.fromarray(array, "RGBA")


def _solid(image: Image.Image) -> Image.Image:
    """The source fully solid: every pixel in its stored colour."""
    return image.convert("RGB").convert("RGBA")


def _rotate_rgba(image: Image.Image, spec: TransformSpec) -> Image.Image:
    rgba = image.convert("RGBA")
    if spec.rotation_degrees == 0.0:
        return rgba.copy()
    color = fill_rgb(spec.fill_color)
    return rgba.rotate(
        -spec.rotation_degrees,
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=(*color, 0),
    )


def _ratio_box(width: int, height: int, ratio_width: int, ratio_height: int) -> tuple[int, int]:
    """The largest ratio_width:ratio_height box inside width x height.

    Integer maths: the float version lost a pixel on the limiting side
    (21 * (3813 / 21) is 3812.99...). A box already within a pixel of the
    ratio on either side is kept, so a resolved crop written back resolves
    to itself. transform_geometry.mjs ratioBox is the same rule, which keeps
    the editor's size readout equal to the run.
    """
    fit_height = width * ratio_height // ratio_width
    fit_width = height * ratio_width // ratio_height
    if height == fit_height or width == fit_width:
        return width, height
    if width * ratio_height > height * ratio_width:
        return max(1, fit_width), height
    return width, max(1, fit_height)


def _geometry(rotated: Image.Image, spec: TransformSpec) -> TransformGeometry:
    rotated_width, rotated_height = rotated.size
    crop_x = min(spec.crop_x, rotated_width - 1)
    crop_y = min(spec.crop_y, rotated_height - 1)
    available_width = rotated_width - crop_x
    available_height = rotated_height - crop_y
    crop_width = available_width if spec.crop_width <= 0 else min(spec.crop_width, available_width)
    crop_height = available_height if spec.crop_height <= 0 else min(spec.crop_height, available_height)
    crop_width = max(1, crop_width)
    crop_height = max(1, crop_height)
    if spec.crop_aspect_ratio != "free":
        if spec.crop_aspect_ratio == "source":
            ratio_width, ratio_height = rotated_width, rotated_height
        else:
            ratio_width, ratio_height = (int(part) for part in spec.crop_aspect_ratio.split(":"))
        crop_width, crop_height = _ratio_box(crop_width, crop_height, ratio_width, ratio_height)

    # The canvas rounds to canvas_multiple one axis at a time, by Load Image +
    # Pad's rule (_qg_pad_helpers._axis_layout): the leftover joins a side the
    # user padded, and an axis nobody padded has its crop trimmed evenly to
    # the multiple below instead. The leftover used to go to the right and
    # bottom whatever was padded, so an unpadded edge got a strip of fill a
    # pixel or more wide; a resize then smeared it into the picture's last
    # column, and the stitch kept that as a light line.
    # transform_geometry.mjs resolvePadding is the same rule, which keeps
    # the editor's picture and size readout equal to the run.
    pad_left, pad_right, trim_left, _, output_width = _axis_layout(
        crop_width, spec.pad_left, spec.pad_right, spec.canvas_multiple
    )
    pad_top, pad_bottom, trim_top, _, output_height = _axis_layout(
        crop_height, spec.pad_top, spec.pad_bottom, spec.canvas_multiple
    )
    if output_width > MAX_DIMENSION or output_height > MAX_DIMENSION:
        raise ValueError(
            "Transform: requested crop and padding exceed the 65536-pixel output limit."
        )

    return TransformGeometry(
        rotated_width=rotated_width,
        rotated_height=rotated_height,
        crop_x=crop_x + trim_left,
        crop_y=crop_y + trim_top,
        crop_width=output_width - pad_left - pad_right,
        crop_height=output_height - pad_top - pad_bottom,
        pad_left=pad_left,
        pad_top=pad_top,
        pad_right=pad_right,
        pad_bottom=pad_bottom,
        output_width=output_width,
        output_height=output_height,
    )


def transform_pil(image: Image.Image, spec: TransformSpec) -> tuple[Image.Image, Image.Image, TransformGeometry]:
    """Apply rotate -> crop -> pad and return opaque RGB, BHW-style mask image, and geometry."""
    output, mask, geometry, _ = _transform_frame(image, spec, False)
    return output, mask, geometry


def _transform_frame(
    image: Image.Image, spec: TransformSpec, view: bool, keep_see_through: bool = False
) -> tuple[Image.Image, Image.Image, TransformGeometry, Image.Image | None]:
    """transform_pil, plus the prompt view (:func:`_see_through_view`) when
    ``view`` is set and the source has see-through parts; None otherwise.

    With ``keep_see_through`` the stored colour under a see-through part
    stays in the picture and only the mask marks it, so there is no prompt
    view either: the picture is whole. That is what a mask painted in the
    MaskEditor needs when a later step reads what is under the paint.
    """
    _validate_source(image)
    spec = spec.normalized()
    rgba = image if image.mode == "RGBA" else image.convert("RGBA")
    kept = see_through_kept(rgba)
    if kept is not None:
        rgba = _empty_see_through(rgba, kept)
    rotated = _rotate_rgba(rgba, spec)
    geometry = _geometry(rotated, spec)
    crop_box = (
        geometry.crop_x,
        geometry.crop_y,
        geometry.crop_x + geometry.crop_width,
        geometry.crop_y + geometry.crop_height,
    )
    cropped = rotated.crop(crop_box)

    # What the mask is cut from: the kept picture, see-through parts empty.
    alpha = cropped.getchannel("A")
    if kept is not None and keep_see_through:
        # The picture itself goes through whole, turned and cropped the same
        # way; its own alpha is only the corners a turn leaves empty.
        cropped = _rotate_rgba(_solid(image), spec).crop(crop_box)
    fill = fill_rgb(spec.fill_color)
    filled_crop = Image.new("RGB", cropped.size, fill)
    filled_crop.paste(cropped.convert("RGB"), mask=cropped.getchannel("A"))

    output = Image.new("RGB", (geometry.output_width, geometry.output_height), fill)
    output.paste(filled_crop, (geometry.pad_left, geometry.pad_top))

    generated_crop = Image.fromarray(255 - np.asarray(alpha, dtype=np.uint8))
    mask = Image.new("L", output.size, 255)
    mask.paste(generated_crop, (geometry.pad_left, geometry.pad_top))
    if spec.feather > 0:
        original = np.asarray(mask, dtype=np.uint8)
        blurred = np.asarray(
            mask.filter(ImageFilter.GaussianBlur(spec.feather)), dtype=np.uint16
        )
        # A blurred step edge sits at ~50% exactly on the boundary, so using
        # the blur directly (or max() with it) leaves a visible 255->127 seam.
        # Doubling and clipping pins the generated side at 255 and starts a
        # smooth ramp exactly at the edge; max() keeps thin generated slivers
        # fully masked.
        feathered = np.maximum(original, np.minimum(blurred * 2, 255).astype(np.uint8))
        mask = Image.fromarray(feathered)
        # Only the mask is feathered; the picture keeps its hard edge against
        # the fill, as Load Image + Pad's does. Outpaint models key on a solid
        # hard-edged fill and read a faded ramp as content (a darker band, or
        # LTX's IC-LoRA leaving the bars unpainted), and the stitcher built
        # from this canvas must hold real pixels for its color match.

    prompt_view = None
    if view and kept is not None and not keep_see_through:
        prompt_view = _see_through_view(output, alpha, rgba.size, crop_box, spec, geometry)
    return output, mask, geometry, prompt_view


def _see_through_view(
    output: Image.Image,
    picture_alpha: Image.Image,
    source_size: tuple[int, int],
    crop_box: tuple[int, int, int, int],
    spec: TransformSpec,
    geometry: TransformGeometry,
) -> Image.Image:
    """The canvas with its see-through parts on SEE_THROUGH_BACKDROP.

    ``picture_alpha`` is the kept picture's alpha, turned and cropped. The
    source's whole rectangle, turned and cropped the same way, covers the
    picture plus its see-through parts, so what it covers beyond the picture
    is see-through; padding and the corners a turn leaves keep the fill.
    A partly covered edge pixel keeps each share: picture, backdrop, fill.
    """
    area = Image.new("L", source_size, 255)
    if spec.rotation_degrees != 0.0:
        area = area.rotate(
            -spec.rotation_degrees, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=0
        )
    area = np.asarray(area.crop(crop_box), dtype=np.int16)
    share = np.clip(area - np.asarray(picture_alpha, dtype=np.int16), 0, 255)
    canvas = np.array(output, dtype=np.uint8)
    rows = np.flatnonzero(share.any(axis=1))
    cols = np.flatnonzero(share.any(axis=0))
    if rows.size == 0:
        return Image.fromarray(canvas, "RGB")
    # Only the see-through part's bounding box changes; whole-number maths:
    # (2 * share * lift + 255) // 510 is share * lift / 255 rounded.
    y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
    lift = np.asarray(SEE_THROUGH_BACKDROP, dtype=np.int32) - np.asarray(fill_rgb(spec.fill_color), dtype=np.int32)
    top, left = geometry.pad_top + y0, geometry.pad_left + x0
    window = canvas[top : top + (y1 - y0), left : left + (x1 - x0)]
    rise = (2 * share[y0:y1, x0:x1, None].astype(np.int32) * lift + 255) // 510
    window[...] = np.clip(window.astype(np.int32) + rise, 0, 255).astype(np.uint8)
    return Image.fromarray(canvas, "RGB")


def transform_pil_batch(
    images: Iterable[Image.Image], spec: TransformSpec, *, view: bool = False, keep_see_through: bool = False
) -> tuple:
    """transform_pil over every frame, as BHWC image and BHW mask batches.

    With ``view`` a fourth item follows: the prompt view batch, each frame's
    canvas with its see-through parts on SEE_THROUGH_BACKDROP, or None when
    no frame has any (the view is then the image itself). With
    ``keep_see_through`` the picture keeps what is stored under its
    see-through parts and only the mask marks them.
    """
    frames: list[torch.Tensor] = []
    masks: list[torch.Tensor] = []
    views: list[Image.Image] = []
    first_geometry: TransformGeometry | None = None
    for index, image in enumerate(images):
        output, mask, geometry, prompt_view = _transform_frame(image, spec, view, keep_see_through)
        if first_geometry is None:
            first_geometry = geometry
        elif output.size != (first_geometry.output_width, first_geometry.output_height):
            raise ValueError(
                f"Transform: frame {index} produced dimensions that differ from frame 0."
            )
        image_array = np.asarray(output, dtype=np.float32) / 255.0
        mask_array = np.asarray(mask, dtype=np.float32) / 255.0
        frames.append(torch.from_numpy(image_array.copy()))
        masks.append(torch.from_numpy(mask_array.copy()))
        views.append(prompt_view)

    if not frames or first_geometry is None:
        raise ValueError("Transform: source contained no decodable frames.")
    result = (torch.stack(frames, dim=0), torch.stack(masks, dim=0), first_geometry)
    if not view:
        return result
    if all(item is None for item in views):
        return (*result, None)
    shown = [
        frames[index] if item is None else torch.from_numpy(np.asarray(item, dtype=np.float32) / 255.0)
        for index, item in enumerate(views)
    ]
    return (*result, torch.stack(shown, dim=0))


def transform_tensor_batch(
    image: torch.Tensor, spec: TransformSpec, source_mask: torch.Tensor | None = None
) -> tuple[torch.Tensor, torch.Tensor, TransformGeometry]:
    if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[-1] not in (3, 4):
        received = tuple(image.shape) if isinstance(image, torch.Tensor) else type(image).__name__
        raise ValueError(
            "Transform: input 'image' expected BHWC with 3 or 4 channels, "
            f"received {received}."
        )
    if source_mask is not None:
        if not isinstance(source_mask, torch.Tensor) or tuple(source_mask.shape) != tuple(image.shape[:3]):
            raise ValueError(
                "Transform: input 'source_mask' expected BHW matching the image batch."
            )

    device = image.device
    dtype = image.dtype
    pil_frames: list[Image.Image] = []
    image_cpu = image.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0)
    mask_cpu = None if source_mask is None else source_mask.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0)
    for index in range(image_cpu.shape[0]):
        rgb = (image_cpu[index, ..., :3].numpy() * 255.0).round().astype(np.uint8)
        if image_cpu.shape[-1] == 4:
            alpha = (image_cpu[index, ..., 3].numpy() * 255.0).round().astype(np.uint8)
        else:
            alpha = np.full(image_cpu.shape[1:3], 255, dtype=np.uint8)
        if mask_cpu is not None:
            alpha = np.minimum(alpha, ((1.0 - mask_cpu[index].numpy()) * 255.0).round().astype(np.uint8))
        pil_frames.append(Image.fromarray(np.dstack((rgb, alpha))))

    output, mask, geometry = transform_pil_batch(pil_frames, spec)
    return output.to(device=device, dtype=dtype), mask.to(device=device, dtype=dtype), geometry


def transform_tensor_batch_chunked(
    image: torch.Tensor, spec: TransformSpec, chunk_size: int = 16
) -> tuple[torch.Tensor, torch.Tensor, TransformGeometry]:
    """transform_tensor_batch over a long batch, one chunk of frames at a time.

    Every chunk goes through the same PIL round trip, but peak memory stays
    at the finished output plus one chunk instead of every frame twice, and
    the queue's interrupt and progress bar are serviced between chunks - the
    video node feeds whole clips through here.
    """
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        received = tuple(image.shape) if isinstance(image, torch.Tensor) else type(image).__name__
        raise ValueError(f"Transform: input 'image' expected a BHWC batch, received {received}.")
    total = int(image.shape[0])
    size = max(1, int(chunk_size))
    output = mask = geometry = None
    progress = frame_progress(total)
    for start in range(0, total, size):
        raise_if_interrupted()
        chunk_output, chunk_mask, chunk_geometry = transform_tensor_batch(image[start : start + size], spec)
        if output is None:
            geometry = chunk_geometry
            output = torch.empty((total, *chunk_output.shape[1:]), dtype=chunk_output.dtype, device=chunk_output.device)
            mask = torch.empty((total, *chunk_mask.shape[1:]), dtype=chunk_mask.dtype, device=chunk_mask.device)
        elif chunk_output.shape[1:] != output.shape[1:]:
            raise ValueError(f"Transform: frame {start} produced dimensions that differ from frame 0.")
        count = int(chunk_output.shape[0])
        output[start : start + count] = chunk_output
        mask[start : start + count] = chunk_mask
        advance_progress(progress, min(start + count, total), total)
    if output is None or mask is None or geometry is None:
        raise ValueError("Transform: source contained no decodable frames.")
    return output, mask, geometry


def stable_file_fingerprint(path: str | os.PathLike[str], inputs: dict[str, object]) -> str:
    normalized_path = str(Path(path).resolve()).casefold()
    try:
        stat = os.stat(path)
        file_state: dict[str, object] = {
            "path": normalized_path,
            "mtime_ns": stat.st_mtime_ns,
            "size": stat.st_size,
        }
    except OSError:
        file_state = {"path": normalized_path, "missing": True}
    payload = {"file": file_state, "inputs": inputs}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def scale_to_megapixels(
    width: int, height: int, megapixels: float, steps: int = 1
) -> tuple[int, int]:
    """Target size whose pixel count is ~megapixels, aspect preserved.

    Mirrors core ImageScaleToTotalPixels semantics so the two stay
    interchangeable in a workflow: the budget is megapixels * 1024 * 1024,
    and each dimension rounds independently to the nearest multiple of
    steps (never below one step)."""
    source_width = max(1, int(width))
    source_height = max(1, int(height))
    total = max(1.0, float(megapixels) * 1024 * 1024)
    scale = (total / (source_width * source_height)) ** 0.5
    step = max(1, int(steps))
    scaled_width = max(step, round(source_width * scale / step) * step)
    scaled_height = max(step, round(source_height * scale / step) * step)
    return int(scaled_width), int(scaled_height)


def resize_then_pad(output, mask, geometry, fill_color, megapixels, method, steps, view=None):
    """A transform's canvas at a pixel budget: the picture resized, then padded.

    ``output`` and ``mask`` are a transform's BHWC canvas and BHW mask,
    ``view`` its prompt view or None. Returns the three at the size
    :func:`scale_to_megapixels` gives the canvas.

    Resizing the padded canvas as one picture mixed fill into the picture
    along every seam: a column part fill with a part mask, which a hard
    paste kept as a line, and a band under a pixel wide came out as nothing
    else. So only the picture is resized, with the chosen method, into the
    box it has on the resized canvas (transform_picture_box, the stitcher's
    own source bbox), and the fill goes around it. Bands are whole pixels,
    the picture's edge is picture, and a band that comes to under half a
    pixel is gone.

    The mask is 1 on the fill. Inside the box it is the transform's own
    mask there, resized with the picture: the feather's ramp from each
    seam, the corners of a turn and see-through parts. It resizes bilinear:
    it is a soft coverage map, and a ringing method would push it outside
    0..1. Without padding the box is the whole canvas, and this is a plain
    resize of image and mask.
    """
    import comfy.utils

    height, width = int(output.shape[1]), int(output.shape[2])
    target_width, target_height = scale_to_megapixels(width, height, megapixels, steps)
    if (target_width, target_height) == (width, height):
        return output, mask, view
    x0, y0, x1, y1 = transform_picture_box(geometry, target_width, target_height)
    rows = slice(geometry.pad_top, geometry.pad_top + geometry.crop_height)
    cols = slice(geometry.pad_left, geometry.pad_left + geometry.crop_width)
    fill = torch.tensor([channel / 255.0 for channel in fill_rgb(fill_color)])

    def place(canvas):
        picture = comfy.utils.common_upscale(
            canvas[:, rows, cols].movedim(-1, 1), x1 - x0, y1 - y0, str(method), "disabled"
        )
        placed = fill.to(canvas).expand(canvas.shape[0], target_height, target_width, -1).clone()
        placed[:, y0:y1, x0:x1] = picture.movedim(1, -1).clamp(0.0, 1.0)
        return placed

    resized = mask.new_ones((mask.shape[0], target_height, target_width))
    inside = mask[:, rows, cols]
    if bool(inside.any()):
        inside = comfy.utils.common_upscale(inside.unsqueeze(1), x1 - x0, y1 - y0, "bilinear", "disabled")
        resized[:, y0:y1, x0:x1] = inside.squeeze(1).clamp(0.0, 1.0)
    else:
        resized[:, y0:y1, x0:x1] = 0.0
    return place(output), resized, None if view is None else place(view)


def original_image_batch(images: Iterable[Image.Image], keep_see_through: bool = False) -> torch.Tensor:
    """Untransformed, EXIF-oriented RGB source frames for reference outputs.

    See-through parts (:func:`see_through_kept`) show on
    SEE_THROUGH_BACKDROP, as a picture viewer shows them. Dropping the alpha
    showed their stored colour instead, black for most cutouts, and a prompt
    writer reading this output described a black backdrop. With
    ``keep_see_through`` the stored colour is what the caller asked for.
    """
    frames = []
    for image in images:
        array = np.asarray(image.convert("RGB"), dtype=np.float32).copy()
        kept = None if keep_see_through else see_through_kept(image if image.mode == "RGBA" else image.convert("RGBA"))
        if kept is not None:
            array[~kept] = SEE_THROUGH_BACKDROP
        frames.append(torch.from_numpy(array / 255.0))
    return torch.stack(frames)
