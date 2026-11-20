# -*- coding: utf-8 -*-
"""QG_CropForInpaint - cut the painted area out for an inpainting model.

Written for ComfyUI-QG-tools on 2026-10-30.

The stitching engine was already in the pack: it came in with the transform
nodes (v0.5.0) as ``_qg_inpaint_crop_helpers.build_crop``. What was missing
was a node on this end, so ``QG_ImageCropRotatePad``'s stitcher output could
only be read by AusBoss's Stitch Inpaint - a dead slot on a machine without
that plugin.

How it differs from QG_MaskCrop
-------------------------------
Mask Crop is plain geometry: cut a rectangle out, put the pixels back where
they came from, never look at colour. This one is for painting: it keeps
context around the painted area, scales the crop to a size the sampler
likes, and emits a stitcher that carries enough data to blend the result
into the old pixels - feathered paste, tone match, edge-halo recovery, and a
seam across the picture's own edge.

The socket type stays ``AUSBOSS_STITCHER`` and the stitcher's ``kind`` stays
``ausboss_inpaint_stitcher``. That is a cross-plugin data contract, not a
naming oversight: both this pack's Stitch Inpaint and the upstream one read
the same stitcher. Renaming either turns this node into an island.
"""

from __future__ import annotations

import torch

from comfy_api.latest import io

from ._qg_execution_helpers import raise_if_interrupted
from ._qg_inpaint_crop_helpers import RESIZE_ALGORITHMS, build_crop
from ._qg_mask_helpers import is_unpainted_mask


class QGCropForInpaint(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_CropForInpaint",
            display_name="Crop For Inpaint",
            category="QG-tools/Inpaint",
            description=(
                "Cuts the painted area out with room around it, at a size the sampler "
                "accepts, and emits a stitcher that Stitch Inpaint uses to paste the "
                "result back seamlessly. context_factor grows the painted box "
                "symmetrically so the model sees its surroundings; context_pixels adds "
                "flat pixels on top of that. blend_pixels feathers only the paste-back "
                "-- mask_grow and mask_blur are what reshape the sampling mask. "
                "target_megapixels, or explicit target_width/target_height, rescale the "
                "crop for the sampler; extend_left/right/up/down grow the frame itself, "
                "which is how this pair outpaints. An empty mask selects the whole "
                "picture and stitches back unchanged. Unlike Mask Crop, which is plain "
                "geometry restored by Crop Restore, this keeps the data a seam needs: "
                "tone match, edge-halo recovery and a fade across the picture's own edge."
            ),
            search_aliases=[
                "crop for inpaint", "inpaint crop", "crop and stitch", "context crop",
                "masked region", "zoom inpaint", "outpaint", "重绘裁剪", "扩图", "qg",
            ],
            inputs=[
                io.Image.Input("image", tooltip="BHWC picture, or the frames of a clip, to cut from."),
                io.Mask.Input(
                    "mask",
                    tooltip=(
                        "White marks what the model should paint. Several frames "
                        "are unioned into one crop window. A mask of the wrong "
                        "size is an error, but the 64x64 stand-in core Load Image "
                        "hands over when nothing was painted counts as empty, not "
                        "wrong: it selects the whole picture."
                    ),
                ),
                io.Float.Input(
                    "context_factor", default=1.2, min=1.0, max=10.0, step=0.05,
                    tooltip=(
                        "Grows the painted box by this factor so the inpainter "
                        "sees surrounding context. 1.0 hugs the paint exactly."
                    ),
                ),
                io.Int.Input(
                    "blend_pixels", default=16, min=0, max=256, step=1,
                    tooltip=(
                        "Feather width for pasting the result back: the paste "
                        "mask is widened by this many pixels and blurred. It "
                        "never touches the sampling mask; 0 pastes hard."
                    ),
                ),
                io.Int.Input(
                    "output_multiple", default=32, min=1, max=128, step=1,
                    tooltip=(
                        "Crop and target dimensions are rounded up to a multiple "
                        "of this so samplers accept them. 32 keeps latent sizes "
                        "legal (matches AusBoss 2.25.0)."
                    ),
                ),
                io.Int.Input(
                    "target_width", default=0, min=0, max=16384, step=8, optional=True,
                    tooltip=(
                        "Rescale the crop to this width for the sampler; 0 keeps "
                        "the native width, or follows target_height at the crop's "
                        "aspect ratio."
                    ),
                ),
                io.Int.Input(
                    "target_height", default=0, min=0, max=16384, step=8, optional=True,
                    tooltip=(
                        "Rescale the crop to this height for the sampler; 0 keeps "
                        "the native height, or follows target_width at the crop's "
                        "aspect ratio."
                    ),
                ),
                io.Int.Input(
                    "mask_grow", default=0, min=-256, max=256, step=1, optional=True,
                    tooltip=(
                        "Dilate the sampling mask by this many pixels (negative "
                        "shrinks it) so the inpainter repaints past the drawn "
                        "edge. Reshapes what gets painted, unlike blend_pixels "
                        "which only feathers the paste-back."
                    ),
                ),
                io.Float.Input(
                    "mask_blur", default=0.0, min=0.0, max=64.0, step=0.5, optional=True,
                    tooltip=(
                        "Gaussian sigma softening the sampling mask's edge, for "
                        "models that honour soft masks. 0 keeps the hard edge."
                    ),
                ),
                io.Boolean.Input(
                    "invert_mask", default=False, optional=True,
                    tooltip=(
                        "Paint the black area instead of the white one - "
                        "everything outside the drawn region."
                    ),
                ),
                io.Int.Input(
                    "context_pixels", default=0, min=0, max=4096, step=8, optional=True,
                    tooltip=(
                        "Flat extra context in pixels, added around the box after "
                        "context_factor's growth."
                    ),
                ),
                io.Float.Input(
                    "target_megapixels", default=0.0, min=0.0, max=64.0, step=0.05,
                    optional=True,
                    tooltip=(
                        "Rescale the crop so its area is about this many "
                        "megapixels: 1.0 suits SDXL-class models, 0 keeps the "
                        "native crop size. Explicit target_width/height win."
                    ),
                ),
                # COMBO：V3 用 io.Combo.Input(options=...)，序列化为
                # ["COMBO", {options, ...}]；真机 object_info 与 V1 的
                # [[options], meta] 差异由 verify_v3_contract 归一化处理。
                io.Combo.Input(
                    "rescale_algorithm", options=list(RESIZE_ALGORITHMS),
                    default="bilinear", optional=True,
                    tooltip=(
                        "Resize filter for the sampler round trip. bilinear is "
                        "the safe default, bicubic keeps upscales a touch "
                        "crisper, area suits heavy downscales, nearest never "
                        "invents pixels."
                    ),
                ),
                io.Int.Input(
                    "extend_left", default=0, min=0, max=8192, step=8, optional=True,
                    tooltip=(
                        "Outpainting: grow the frame this many pixels leftward. "
                        "The new band joins the mask and becomes part of the "
                        "stitched output."
                    ),
                ),
                io.Int.Input(
                    "extend_right", default=0, min=0, max=8192, step=8, optional=True,
                    tooltip="Outpainting: grow the frame this many pixels rightward.",
                ),
                io.Int.Input(
                    "extend_up", default=0, min=0, max=8192, step=8, optional=True,
                    tooltip="Outpainting: grow the frame this many pixels upward.",
                ),
                io.Int.Input(
                    "extend_down", default=0, min=0, max=8192, step=8, optional=True,
                    tooltip="Outpainting: grow the frame this many pixels downward.",
                ),
                io.Boolean.Input(
                    "keep_inside", default=True, optional=True,
                    tooltip=(
                        "Keep the crop inside the picture. On, the context stops "
                        "at the picture's edges, so the model sees only real "
                        "pixels. Off, the crop runs past them, filled with "
                        "stretched copies of the edge pixels."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(id="image", tooltip="The crop around the painted area, sized for the sampler."),
                io.Mask.Output(id="mask", tooltip=(
                    "The sampling mask, cropped like the picture: the input mask after "
                    "invert, grow and blur. blend_pixels never feathers it.")),
                # 自定义类型 AUSBOSS_STITCHER：跨插件数据契约，socket 类型不能变。
                # V3 用 io.Custom("AUSBOSS_STITCHER") 才能序列化回该类型名；
                # io.AnyType.Output 会产出 "*"，破坏连线契约。
                io.Custom("AUSBOSS_STITCHER").Output(id="stitcher", tooltip=(
                    "Stitch data for Stitch Inpaint: canvas, rects, paste mask, scale. "
                    "Works with AusBoss's Stitch Inpaint too - the socket type and the "
                    "stitcher format are shared on purpose.")),
            ],
        )

    @classmethod
    def execute(
        cls, image, mask, context_factor, blend_pixels, output_multiple,
        target_width=0, target_height=0, mask_grow=0, mask_blur=0.0,
        invert_mask=False, context_pixels=0, target_megapixels=0.0,
        rescale_algorithm="bilinear", extend_left=0, extend_right=0,
        extend_up=0, extend_down=0, keep_inside=True,
    ):
        raise_if_interrupted()
        if is_unpainted_mask(mask) and isinstance(image, torch.Tensor) and image.ndim == 4:
            mask = torch.zeros(
                (1, int(image.shape[1]), int(image.shape[2])),
                dtype=torch.float32,
                device=image.device,
            )
        cropped, sampling, stitcher = build_crop(
            image, mask,
            context_factor=float(context_factor),
            blend_pixels=int(blend_pixels),
            output_multiple=int(output_multiple),
            target_width=int(target_width),
            target_height=int(target_height),
            mask_grow=int(mask_grow),
            mask_blur=float(mask_blur),
            invert_mask=bool(invert_mask),
            context_pixels=int(context_pixels),
            target_megapixels=float(target_megapixels),
            rescale_algorithm=str(rescale_algorithm),
            extend_left=int(extend_left),
            extend_right=int(extend_right),
            extend_up=int(extend_up),
            extend_down=int(extend_down),
            keep_inside=bool(keep_inside),
        )
        raise_if_interrupted()
        return io.NodeOutput(cropped, sampling, stitcher)


NODE_CLASS_MAPPINGS = {"QG_CropForInpaint": QGCropForInpaint}

NODE_DISPLAY_NAME_MAPPINGS = {"QG_CropForInpaint": "Crop For Inpaint"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
