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

from comfy_api.latest import io

from ._qg_combo_legacy import coerce
from ._qg_execution_helpers import raise_if_interrupted, warn_once
from ._qg_tensor_helpers import as_image_batch, as_mask_batch
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
    """BHWC 归一化（共享判据：2 维 / 3 维单图 / 3 维灰度批 / 4 维）。"""
    return as_image_batch(image, "Mask Crop: image")[0].float()


def _as_mask(mask) -> torch.Tensor:
    """BHW 归一化（共享判据；4 维按通道取 max，不再 flatten(0, 1)）。

    🔴 `flatten(0, 1)` 对 (B, 1, H, W) 刚好等价，但对 (B, C>1, H, W) 会把
    通道叠进批次、帧数凭空翻倍 —— 共享版取 max，语义与「遮罩只有一个通道」一致。
    """
    return as_mask_batch(mask, "Mask Crop: mask").float().clamp(0.0, 1.0)


def _seam(seam) -> dict:
    if not isinstance(seam, dict) or seam.get("kind") != SEAM_KIND:
        raise ValueError(
            "[QG-tools] Crop Restore needs the seam output of Mask Crop. "
            "Wire it from that node's first slot."
        )
    return seam


# V1 @combo_legacy("QG_MaskCrop")：size_mode/fill 有中文遗留值需 coerce。
# V3 去装饰器，crop→execute 开头 coerce 两值，与 V1 等价。
# 同文件的 QGCropRestore 已是 V3，本类迁 V3 后两节点同属 V3。
class QGMaskCrop(io.ComfyNode):
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
    @classmethod
    def validate_inputs(cls, size_mode=None, fill=None):
        # size_mode/fill 中文标签在 LEGACY 表；具名报上去跳过列表校验，值由 coerce 换回。
        return True

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_MaskCrop",
            display_name="Mask Crop",
            category="QG-tools/Mask",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input("image", tooltip="The picture to cut from."),
                io.Mask.Input("mask", tooltip="What to keep in frame. The whole batch shares the union of every frame's painted area."),
                io.Combo.Input("size_mode", options=SIZE_MODES, default="native",
                    tooltip="native: the composed size. square: padded out to a square. custom: framed to the size below."),
                io.Int.Input("custom_width", default=1024, min=0, max=8192, step=8,
                    tooltip="custom only. 0 means derive it from custom_height and the composed aspect."),
                io.Int.Input("custom_height", default=1024, min=0, max=8192, step=8,
                    tooltip="custom only. 0 means derive it from custom_width and the composed aspect."),
                io.Int.Input("multiple", default=8, min=1, max=256, step=1,
                    tooltip="Round the crop up to a whole multiple of this. 8 keeps latent sizes legal; 1 disables it."),
                io.Float.Input("pad_top", default=1.4, min=1.0, max=4.0, step=0.05,
                    tooltip="Room above the paint, as a multiplier of its short side. 1.0 hugs it."),
                io.Float.Input("pad_right", default=1.4, min=1.0, max=4.0, step=0.05,
                    tooltip="Room to the right, same unit."),
                io.Float.Input("pad_bottom", default=1.4, min=1.0, max=4.0, step=0.05,
                    tooltip="Room below, same unit."),
                io.Float.Input("pad_left", default=1.4, min=1.0, max=4.0, step=0.05,
                    tooltip="Room to the left, same unit."),
                io.Boolean.Input("fill_holes", default=False,
                    tooltip="Fill the gaps the paint closes all the way round before measuring it, so a bracelet or a window does not shrink the frame."),
                io.Combo.Input("fill", options=FILL_MODES, default="edge",
                    tooltip="How the room outside the picture gets painted: edge takes each side's most common colour, stretch repeats its outer row or column, black leaves it empty."),
            ],
            outputs=[
                io.Custom(SEAM_TYPE).Output("seam", tooltip="Everything Crop Restore needs to put the result back: the source picture, the rectangle and the size it was cut at."),
                io.Image.Output("image", tooltip="The crop, ready for an upscale or a repaint."),
                io.Mask.Output("mask", tooltip="The same crop's mask. Empty where the crop reaches outside the picture."),
            ],
        )

    @classmethod
    def execute(cls, image, mask, size_mode="native", custom_width=1024,
                custom_height=1024, multiple=8, pad_top=1.4, pad_right=1.4,
                pad_bottom=1.4, pad_left=1.4, fill_holes=False, fill="edge"):
        # V1 装饰器 coerce 两个下拉值，V3 显式保留。
        size_mode = coerce("QG_MaskCrop", "size_mode", size_mode)
        fill = coerce("QG_MaskCrop", "fill", fill)
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
        return io.NodeOutput(seam, cropped, cut_mask)


class QGCropRestore(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_CropRestore",
            display_name="Crop Restore",
            category="QG-tools/Image",
            description=(
                "Pastes a processed crop back where Mask Crop took it from. The crop is "
                "resized back to the rectangle it was cut at, then blended over the "
                "source picture through the mask, so every pixel outside the mask stays "
                "bit-identical to the source. expand grows the mask before pasting (a "
                "few pixels hide the seam of a repaint), feather softens that edge, and "
                "colour_match shifts the patch's overall colour to match the source and "
                "remove the brightness drift an upscale-and-back leaves behind. Only the "
                "part of the rectangle inside the picture is written; a crop that hung "
                "outside the frame keeps its filled room outside."
            ),
            search_aliases=["crop restore", "paste back", "stitch crop", "裁剪恢复", "贴回", "qg"],
            inputs=[
                # 自定义输入类型：V3 用 io.Custom("QGSeam") 才能序列化回该类型名，
                # 与 V1 的 SEAM_TYPE 契约逐字一致；io.AnyType 会产出 "*" 破坏连线。
                io.Custom("QGSeam").Input(
                    "seam", tooltip="The seam output of Mask Crop."
                ),
                io.Image.Input(
                    "image",
                    tooltip="The crop after processing. Any size; it is resized back to the rectangle.",
                ),
                io.Int.Input(
                    "expand", default=0, min=-256, max=256, step=1,
                    tooltip="Grow the mask this many pixels before pasting; negative shrinks it. 4 to 16 hides a repaint seam.",
                ),
                io.Int.Input(
                    "feather", default=8, min=0, max=256, step=1,
                    tooltip="Soften the pasted edge over this many pixels. 0 gives a hard cut.",
                ),
                io.Float.Input(
                    "colour_match", default=0.0, min=0.0, max=1.0, step=0.05,
                    tooltip="Line the patch's median colour up with the source's. Fixes a brightness or cast drift, does not recolour a repaint.",
                ),
                io.Mask.Input(
                    "mask", optional=True,
                    tooltip="A mask for the processed crop (the crop's own mask, edited). Leave empty to reuse the painted area.",
                ),
                io.Image.Input(
                    "background", optional=True,
                    tooltip="Paste onto this instead of the source picture. Must be the source's size.",
                ),
            ],
            outputs=[
                io.Image.Output(id="image", tooltip="The source picture with the processed crop blended back in."),
            ],
        )

    @classmethod
    def execute(cls, seam, image, expand=0, feather=8, colour_match=0.0, mask=None, background=None):
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
        return io.NodeOutput(result)


NODE_CLASS_MAPPINGS = {
    "QG_MaskCrop": QGMaskCrop,
    "QG_CropRestore": QGCropRestore,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "QG_MaskCrop": "Mask Crop",
    "QG_CropRestore": "Crop Restore",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
