# -*- coding: utf-8 -*-
"""QG_StitchInpaint - paste an inpainted crop back into its picture.

Written for ComfyUI-QG-tools on 2026-10-30.

The work is done by ``_qg_inpaint_crop_helpers.apply_stitch`` and
``stitch_blend_mask``, which came in with the transform nodes (v0.5.0). This
node is the read end of the stitcher contract: the other end is
QG_CropForInpaint, and the upstream plugin's Stitch Inpaint reads the very
same data.

The socket type ``AUSBOSS_STITCHER`` and the stitcher's ``kind``
``ausboss_inpaint_stitcher`` are a cross-plugin data contract. Do not rename
them: ``apply_stitch`` raises on a stitcher it does not recognise, so a
rename here and not there silently breaks every saved workflow.
"""

from __future__ import annotations

from ._qg_execution_helpers import raise_if_interrupted
from ._qg_inpaint_crop_helpers import (
    PASTE_ONTO_CROP,
    PASTE_ONTO_MODES,
    PASTE_ONTO_ORIGINAL,
    SEAM_CLASSIC,
    SEAM_MODES,
    apply_stitch,
    paste_on_original,
    stitch_blend_mask,
)

# A workflow saved before Seam existed can hold the card's empty value in the
# slot Seam now takes. It loads, and stitches, as classic - the same value
# every earlier workflow had.
_UNSET_SEAM = ("", None)

# Same guard for paste_onto: a slot that did not exist before can carry an
# empty value from an older save. It loads, and stitches, as crop.
_UNSET_PASTE_ONTO = ("", None)


class QGStitchInpaint:
    CATEGORY = "QG-tools/Inpaint"
    DESCRIPTION = (
        "Pastes an inpainted crop back into the picture it came from. Wire the "
        "stitcher from Crop For Inpaint, or from Crop + Rotate + Pad when "
        "outpainting a padded canvas. seam classic, the default, blends with the "
        "feathered mask recorded in the stitcher and is what every earlier "
        "workflow did; blend in fades the model's picture into yours a little "
        "way inside your own picture, which suits outpaints, turned or straight. "
        "Raise color_match when the new area reads lighter, darker or warmer than "
        "the picture. fix_edge_halo recovers the true colour under a feathered "
        "seam when it leaves a dark or light rim, and needs the optional "
        "pymatting package. Pixels the stitch does not reach are bit-identical "
        "to the original - they never pass through a resize. blend_mask marks "
        "exactly what the stitch changed, ready for a downstream colour match."
    )
    SEARCH_ALIASES = [
        "stitch inpaint",
        "paste back",
        "crop and stitch",
        "recompose",
        "重绘缝合",
        "缝合",
        "贴回",
        "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stitcher": (
                    "AUSBOSS_STITCHER",
                    {
                        "tooltip": (
                            "The stitcher from Crop For Inpaint (this pack's or "
                            "AusBoss's), or from Crop + Rotate + Pad when "
                            "outpainting a padded canvas."
                        )
                    },
                ),
                "inpainted": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "The painted crop to paste back. It is resized to the "
                            "crop window if the sampler changed its size."
                        )
                    },
                ),
            },
            "optional": {
                "fix_edge_halo": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": (
                            "Recover the true colour under the feathered seam "
                            "before pasting, so half-transparent edge pixels stop "
                            "blending their background in twice and leaving a dark "
                            "or light rim. Needs the optional pymatting package; "
                            "without it the paste is unchanged and the console "
                            "says so once."
                        ),
                    },
                ),
                "color_match": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": (
                            "Match the new area's tone to the picture when it comes "
                            "back lighter, darker or warmer. 1 is a full match, 0 "
                            "is off. It needs a feather, since it reads the strip "
                            "of the picture the model repainted."
                        ),
                    },
                ),
                "seam": (
                    list(SEAM_MODES),
                    {
                        "default": SEAM_CLASSIC,
                        "tooltip": (
                            "How the new area joins the picture. Pick blend in for "
                            "outpaints, turned or straight: the model's picture "
                            "fades into yours across your picture's own edge. "
                            "classic keeps the older paste for every existing "
                            "workflow, and is what a plain crop always uses."
                        ),
                    },
                ),
                "paste_onto": (
                    list(PASTE_ONTO_MODES),
                    {
                        "default": PASTE_ONTO_CROP,
                        "tooltip": (
                            "Where the stitched canvas lands. crop keeps the result "
                            "at the crop's original size (the default, and what "
                            "every earlier workflow did). original lays it onto the "
                            "whole picture - only meaningful for a transform "
                            "stitcher that records one; a plain Crop For Inpaint "
                            "stitcher passes through unchanged either way. Matches "
                            "AusBoss 2.25.0."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "blend_mask")
    OUTPUT_TOOLTIPS = (
        "Original-size picture with the painted crop blended in; pixels outside "
        "the blend region are untouched.",
        "The feathered paste mask in the stitched picture's coordinates - white "
        "where the paint blended in, zero where the original survived. Wire it to "
        "a colour-match or compositing node to treat exactly the pasted region.",
    )
    FUNCTION = "stitch"

    def stitch(
        self, stitcher, inpainted, fix_edge_halo=False, color_match=0.0,
        seam=SEAM_CLASSIC, paste_onto=PASTE_ONTO_CROP,
    ):
        if seam in _UNSET_SEAM:
            seam = SEAM_CLASSIC
        if seam not in SEAM_MODES:
            raise ValueError(
                "[QG-tools] Stitch Inpaint: seam must be one of %s, not %r."
                % (SEAM_MODES, seam)
            )
        if paste_onto not in _UNSET_PASTE_ONTO and paste_onto not in PASTE_ONTO_MODES:
            raise ValueError(
                "[QG-tools] Stitch Inpaint: paste_onto must be one of %s, not %r."
                % (PASTE_ONTO_MODES, paste_onto)
            )
        raise_if_interrupted()
        image = apply_stitch(
            stitcher,
            inpainted,
            bool(fix_edge_halo),
            float(color_match),
            str(seam),
        )
        raise_if_interrupted()
        blend = stitch_blend_mask(stitcher, int(image.shape[0]), str(seam))
        result = (image, blend)
        if paste_onto == PASTE_ONTO_ORIGINAL:
            result = paste_on_original(stitcher, *result)
        return result

    @classmethod
    def VALIDATE_INPUTS(cls, seam=SEAM_CLASSIC, paste_onto=PASTE_ONTO_CROP):
        # Naming seam and paste_onto here takes them out of ComfyUI's own list
        # check, so the empty value an older workflow carries in their place
        # still queues.
        #
        # 🔴 这里**不能**再补 **kwargs。execution.validate_inputs 里那段
        # `if x not in validate_function_inputs and not validate_has_kwargs:`
        # 的意思是：只要 VALIDATE_INPUTS 收了 **kwargs，本节点**所有**输入的
        # min / max / 下拉列表校验就整块跳过 —— color_match 的 0..1 会形同虚设。
        # 具名只收 seam / paste_onto 时，核心只把这两个传进来
        # （`input_filtered` 按参数名过滤），其余输入照旧走它自己的校验，
        # 也不会 TypeError。
        if seam not in _UNSET_SEAM and seam not in SEAM_MODES:
            return "[QG-tools] Stitch Inpaint: seam must be one of %s, not %r." % (
                SEAM_MODES,
                seam,
            )
        if paste_onto not in _UNSET_PASTE_ONTO and paste_onto not in PASTE_ONTO_MODES:
            return (
                "[QG-tools] Stitch Inpaint: paste_onto must be one of %s, not %r."
                % (PASTE_ONTO_MODES, paste_onto)
            )
        return True

NODE_CLASS_MAPPINGS = {"QG_StitchInpaint": QGStitchInpaint}

NODE_DISPLAY_NAME_MAPPINGS = {"QG_StitchInpaint": "Stitch Inpaint"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
