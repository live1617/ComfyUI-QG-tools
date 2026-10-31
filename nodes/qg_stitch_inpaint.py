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
    SEAM_CLASSIC,
    SEAM_MODES,
    apply_stitch,
    stitch_blend_mask,
)

# A workflow saved before Seam existed can hold the card's empty value in the
# slot Seam now takes. It loads, and stitches, as classic - the same value
# every earlier workflow had.
_UNSET_SEAM = ("", None)


class QGStitchInpaint:
    CATEGORY = "QG-tools/Retouch"
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

    def stitch(self, stitcher, inpainted, fix_edge_halo=False, color_match=0.0, seam=SEAM_CLASSIC):
        if seam in _UNSET_SEAM:
            seam = SEAM_CLASSIC
        if seam not in SEAM_MODES:
            raise ValueError(
                "[QG-tools] Stitch Inpaint: seam must be one of %s, not %r."
                % (SEAM_MODES, seam)
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
        return (image, blend)

    @classmethod
    def VALIDATE_INPUTS(cls, seam=SEAM_CLASSIC, **kwargs):
        # Naming seam here takes it out of ComfyUI's own list check, so the
        # empty value an older workflow carries in its place still queues.
        if seam in _UNSET_SEAM or seam in SEAM_MODES:
            return True
        return "[QG-tools] Stitch Inpaint: seam must be one of %s, not %r." % (
            SEAM_MODES,
            seam,
        )

NODE_CLASS_MAPPINGS = {"QG_StitchInpaint": QGStitchInpaint}

NODE_DISPLAY_NAME_MAPPINGS = {"QG_StitchInpaint": "Stitch Inpaint"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
