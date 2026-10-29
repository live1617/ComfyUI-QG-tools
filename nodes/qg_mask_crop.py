# -*- coding: utf-8 -*-
"""QG_MaskCrop / QG_CropRestore - crop around a painted area and paste it back.

Written for ComfyUI-QG-tools on 2026-10-29 from scratch. The workflow it
serves is the one 孤海工具箱 (Goohaitools) covers with 遮罩裁剪V2 + 裁剪恢复:
paint a subject, cut it out with room to spare, let an upscale or repaint model
work on that small piece, then drop the result back exactly where it came from
so the rest of the picture never goes through a resize.

What is deliberately different from that pair:

  * The crop rectangle is planned in one pure function
    (``_qg_mask_crop_helpers.plan_crop``) with no PIL, no OpenCV and no scipy
    at import time, so the geometry is testable on its own and the node has no
    extra dependency.
  * Edge filling is computed per side from the frame's own rows/columns. Pure
    colour (the most common edge colour) and edge stretch are both offered,
    because a gradient backdrop looks wrong painted in one flat colour.
  * ``custom`` output sizes cover rather than fit: the rectangle is widened to
    the requested aspect *before* the resize, so asking for 1024x1024 never
    squeezes a tall subject narrower - it adds room and fills it.
  * A batch shares one rectangle (the union of every frame's painted area),
    otherwise every frame of a video would be framed slightly differently and
    the result would jitter.
  * Paste-back works in pixels (expand / feather) instead of percent, and only
    writes the part of the rectangle that lands inside the picture, so a crop
    that hung outside the frame loses nothing on the way home.

The seam value handed to QG_CropRestore is a plain dict: ComfyUI passes
arbitrary Python objects between nodes without serialising them.
"""

from __future__ import annotations

import torch

from ._qg_execution_helpers import raise_if_interrupted, warn_once
from ._qg_mask_crop_helpers import (
    crop_image,
    crop_mask,
    mask_bounds,
    plan_crop,
    resize_image,
    resize_mask,
    stitch_back,
)
from ._qg_mask_helpers import (
    blur_mask,
    fill_mask_holes,
    grow_shrink_mask,
    is_unpainted_mask,
    mask_size_mismatch,
)

SEAM_TYPE = "QGSeam"
SEAM_KIND = "qg_mask_crop_seam"
_WARNED: set[str] = set()

SIZE_MODES = ["native", "square", "custom"]
FILL_MODES = ["edge", "stretch", "black"]


def _as_image(image) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise ValueError("[QG-tools] Mask Crop expected an IMAGE tensor.")
    if image.dim() == 3:
        image = image.unsqueeze(0)
    if image.dim() != 4:
        raise ValueError(
            "[QG-tools] Mask Crop expected a BHWC IMAGE, got shape %s." % (tuple(image.shape),)
        )
    return image.float()


def _as_mask(mask) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise ValueError("[QG-tools] Mask Crop expected a MASK tensor.")
    if mask.dim() == 4:
        mask = mask.flatten(0, 1)
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if mask.dim() != 3:
        raise ValueError(
            "[QG-tools] Mask Crop expected a BHW MASK, got shape %s." % (tuple(mask.shape),)
        )
    return mask.float().clamp(0.0, 1.0)


def _seam(seam) -> dict:
    if not isinstance(seam, dict) or seam.get("kind") != SEAM_KIND:
        raise ValueError(
            "[QG-tools] Crop Restore needs the seam output of Mask Crop. "
            "Wire it from that node's first slot."
        )
    return seam


class QGMaskCrop:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Cuts the painted area out of a picture with room to spare, in a size a "
        "sampler will accept. pad_* are multipliers of the painted area's short "
        "side, so 1.4 adds 40% of it on that side and 1.0 hugs the paint. "
        "size_mode native keeps the composed size, square pads it out to a "
        "square, custom frames it to custom_width x custom_height (0 on one side "
        "derives it from the other). multiple rounds the result up to a whole "
        "number (8 keeps latent sizes legal). Whatever still hangs outside the "
        "picture is filled from its own edge colours. Feed the seam output to "
        "Crop Restore to paste a processed crop back in place."
    )
    SEARCH_ALIASES = ["mask crop", "crop by mask", "crop to mask", "遮罩裁剪", "裁剪", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "IMAGE",
                    {"tooltip": "The picture to cut from."},
                ),
                "mask": (
                    "MASK",
                    {
                        "tooltip": "What to keep in frame. The whole batch shares the union of every frame's painted area."
                    },
                ),
                "size_mode": (
                    SIZE_MODES,
                    {
                        "default": "native",
                        "tooltip": "native: the composed size. square: padded out to a square. custom: framed to the size below.",
                    },
                ),
                "custom_width": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "tooltip": "custom only. 0 means derive it from custom_height and the composed aspect.",
                    },
                ),
                "custom_height": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 0,
                        "max": 8192,
                        "step": 8,
                        "tooltip": "custom only. 0 means derive it from custom_width and the composed aspect.",
                    },
                ),
                "multiple": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "tooltip": "Round the crop up to a whole multiple of this. 8 keeps latent sizes legal; 1 disables it.",
                    },
                ),
                "pad_top": (
                    "FLOAT",
                    {
                        "default": 1.4,
                        "min": 1.0,
                        "max": 4.0,
                        "step": 0.05,
                        "tooltip": "Room above the paint, as a multiplier of its short side. 1.0 hugs it.",
                    },
                ),
                "pad_right": (
                    "FLOAT",
                    {"default": 1.4, "min": 1.0, "max": 4.0, "step": 0.05, "tooltip": "Room to the right, same unit."},
                ),
                "pad_bottom": (
                    "FLOAT",
                    {"default": 1.4, "min": 1.0, "max": 4.0, "step": 0.05, "tooltip": "Room below, same unit."},
                ),
                "pad_left": (
                    "FLOAT",
                    {"default": 1.4, "min": 1.0, "max": 4.0, "step": 0.05, "tooltip": "Room to the left, same unit."},
                ),
                "fill_holes": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "Fill the gaps the paint closes all the way round before measuring it, so a bracelet or a window does not shrink the frame.",
                    },
                ),
                "fill": (
                    FILL_MODES,
                    {
                        "default": "edge",
                        "tooltip": "How the room outside the picture gets painted: edge takes each side's most common colour, stretch repeats its outer row or column, black leaves it empty.",
                    },
                ),
            }
        }

    RETURN_TYPES = (SEAM_TYPE, "IMAGE", "MASK")
    RETURN_NAMES = ("seam", "image", "mask")
    OUTPUT_TOOLTIPS = (
        "Everything Crop Restore needs to put the result back: the source picture, the rectangle and the size it was cut at.",
        "The crop, ready for an upscale or a repaint.",
        "The same crop's mask. Empty where the crop reaches outside the picture.",
    )
    FUNCTION = "crop"

    def crop(
        self,
        image,
        mask,
        size_mode="native",
        custom_width=1024,
        custom_height=1024,
        multiple=8,
        pad_top=1.4,
        pad_right=1.4,
        pad_bottom=1.4,
        pad_left=1.4,
        fill_holes=False,
        fill="edge",
    ):
        image = _as_image(image)
        mask = _as_mask(mask)
        height, width = int(image.shape[1]), int(image.shape[2])
        if is_unpainted_mask(mask[0]):
            # LoadImage hands out a 64x64 placeholder whenever the picture
            # carries no alpha, so a mask nobody has painted yet can never
            # match the frame. Swap in a blank one at the right size and let
            # the "nothing painted" branch below pass the whole picture
            # through: this is a step the user has not reached yet, not a
            # broken graph, and refusing here would stop a whole run over it.
            mask = torch.zeros(
                (int(mask.shape[0]), height, width),
                dtype=mask.dtype,
                device=mask.device,
            )
        elif tuple(mask.shape[-2:]) != (height, width):
            raise ValueError(mask_size_mismatch(mask[0], height, width))

        work_mask = fill_mask_holes(mask, 0.0) if fill_holes else mask
        bounds = mask_bounds(work_mask)
        pads = (pad_top, pad_right, pad_bottom, pad_left)
        if bounds is None:
            # Nothing painted: hand the whole picture through rather than
            # growing an empty rectangle by four pads' worth of blank.
            warn_once(
                "Mask Crop: nothing painted, passing the whole picture through.",
                _WARNED,
            )
            bounds = (0, 0, width, height)
            pads = (1.0, 1.0, 1.0, 1.0)

        rect, target, mode = plan_crop(
            bounds, pads, size_mode, custom_width, custom_height, multiple
        )
        raise_if_interrupted()

        cropped = crop_image(image, rect, fill)
        cut_mask = crop_mask(work_mask, rect)
        rect_h, rect_w = int(rect[3]), int(rect[2])
        if target != (rect_h, rect_w):
            cropped = resize_image(cropped, target[0], target[1])
            cut_mask = resize_mask(cut_mask, target[0], target[1])

        seam = {
            "kind": SEAM_KIND,
            "size": (height, width),
            "rect": rect,
            "target": target,
            "mode": mode,
            "multiple": int(multiple),
            "pads": tuple(float(value) for value in pads),
            "bounds": bounds,
            "image": image,
            "mask": work_mask,
        }
        return (seam, cropped, cut_mask)


class QGCropRestore:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Pastes a processed crop back where Mask Crop took it from. The crop is "
        "resized back to the rectangle it was cut at, then blended over the "
        "source picture through the mask, so every pixel outside the mask stays "
        "bit-identical to the source. expand grows the mask before pasting (a "
        "few pixels hide the seam of a repaint), feather softens that edge, and "
        "colour_match shifts the patch's overall colour to match the source and "
        "remove the brightness drift an upscale-and-back leaves behind. Only the "
        "part of the rectangle inside the picture is written; a crop that hung "
        "outside the frame keeps its filled room outside."
    )
    SEARCH_ALIASES = ["crop restore", "paste back", "stitch crop", "裁剪恢复", "贴回", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seam": (
                    SEAM_TYPE,
                    {"tooltip": "The seam output of Mask Crop."},
                ),
                "image": (
                    "IMAGE",
                    {"tooltip": "The crop after processing. Any size; it is resized back to the rectangle."},
                ),
                "expand": (
                    "INT",
                    {
                        "default": 0,
                        "min": -256,
                        "max": 256,
                        "step": 1,
                        "tooltip": "Grow the mask this many pixels before pasting; negative shrinks it. 4 to 16 hides a repaint seam.",
                    },
                ),
                "feather": (
                    "INT",
                    {
                        "default": 8,
                        "min": 0,
                        "max": 256,
                        "step": 1,
                        "tooltip": "Soften the pasted edge over this many pixels. 0 gives a hard cut.",
                    },
                ),
                "colour_match": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": "Line the patch's median colour up with the source's. Fixes a brightness or cast drift, does not recolour a repaint.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "A mask for the processed crop (the crop's own mask, edited). Leave empty to reuse the painted area."
                    },
                ),
                "background": (
                    "IMAGE",
                    {"tooltip": "Paste onto this instead of the source picture. Must be the source's size."},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_TOOLTIPS = ("The source picture with the processed crop blended back in.",)
    FUNCTION = "restore"

    def restore(self, seam, image, expand=0, feather=8, colour_match=0.0, mask=None, background=None):
        seam = _seam(seam)
        height, width = seam["size"]
        rect = seam["rect"]
        target_h, target_w = seam["target"]
        rect_h, rect_w = int(rect[3]), int(rect[2])

        patch = _as_image(image)
        if (int(patch.shape[1]), int(patch.shape[2])) != (target_h, target_w):
            patch = resize_image(patch, target_h, target_w)
        if (target_h, target_w) != (rect_h, rect_w):
            patch = resize_image(patch, rect_h, rect_w)

        if mask is not None:
            blend = _as_mask(mask)
            if tuple(blend.shape[-2:]) != (rect_h, rect_w):
                if tuple(blend.shape[-2:]) != (target_h, target_w):
                    blend = resize_mask(blend, target_h, target_w)
                blend = resize_mask(blend, rect_h, rect_w)
        else:
            blend = crop_mask(seam["mask"], rect)
            if (rect_h, rect_w) != (target_h, target_w):
                blend = resize_mask(blend, target_h, target_w)
                blend = resize_mask(blend, rect_h, rect_w)
        raise_if_interrupted()

        steps = int(expand)
        if steps:
            blend = grow_shrink_mask(blend, steps)
        if feather > 0:
            blend = blur_mask(blend, float(feather))
        blend = blend.clamp(0.0, 1.0)

        if background is not None:
            base = _as_image(background)
            if (int(base.shape[1]), int(base.shape[2])) != (height, width):
                raise ValueError(
                    "[QG-tools] Crop Restore: the background is %dx%d but the source picture was %dx%d."
                    % (int(base.shape[2]), int(base.shape[1]), width, height)
                )
        else:
            base = seam["image"]

        result = stitch_back(base, patch, blend, rect, float(colour_match))
        return (result,)


NODE_CLASS_MAPPINGS = {
    "QG_MaskCrop": QGMaskCrop,
    "QG_CropRestore": QGCropRestore,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "QG_MaskCrop": "Mask Crop",
    "QG_CropRestore": "Crop Restore",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
