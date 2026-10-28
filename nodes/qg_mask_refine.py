# -*- coding: utf-8 -*-
"""QG Mask Refine — clean up a mask in one fixed-order pass.

Ported from ComfyUI-AusBoss (nodes/node_refine_mask.py), MIT.
Original by the ComfyUI-AusBoss author. The pass order and every routine are
unchanged (see _qg_mask_refine_helpers for the algorithms):

  expand -> fill holes -> smooth -> feather -> edge refine -> levels

QG changes: renamed to the QG_ prefix, category moved under QG-tools/Mask,
display name and tooltips rewritten, and the face preview reuses this pack's
temp-PNG helper instead of upstream's. OUTPUT_NODE is on here (upstream left it
off): it is what makes the preview land in the history payload and on the node
face reliably, and every other previewing node in this pack does the same.

Modified for ComfyUI-QG-tools on 2026-10-27: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import os
import random

import numpy as np
import folder_paths
from PIL import Image

from ._qg_mask_refine_helpers import EDGE_REFINE_MODES, refine_mask


class QGMaskRefine:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Cleans up a mask in one fixed-order pass: expand (grow/shrink by whole "
        "pixels), fill enclosed holes (all of them, or only those up to "
        "max_hole_size), smooth (melts staircase jaggies without feathering), "
        "feather with a gaussian blur, edge-refine against the optional "
        "guide_image (guided filter or alpha matting), then remap levels with "
        "black_point / white_point to clear gray haze. Returns the refined mask "
        "and its inverse."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": ("MASK", {"tooltip": "BHW mask; white is the selected area."}),
                "expand": (
                    "INT",
                    {
                        "default": 0,
                        "min": -1024,
                        "max": 1024,
                        "step": 1,
                        "tooltip": "Pixels to grow (+) or shrink (-) the mask.",
                    },
                ),
                "blur": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "tooltip": "Gaussian feather strength in pixels; 0 keeps hard edges.",
                    },
                ),
                "fill_holes": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": (
                            "Fill fully enclosed gaps inside the mask before feathering. "
                            "Gaps that touch the frame edge never count as holes."
                        ),
                    },
                ),
                "smooth": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 256,
                        "step": 1,
                        "tooltip": (
                            "Melts staircase jaggies by this many pixels while keeping a "
                            "hard edge; 0 is off. Runs before the feather blur."
                        ),
                    },
                ),
                "black_point": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": (
                            "Mask values at or below this become fully black; clears faint "
                            "gray haze outside the subject. Applied last."
                        ),
                    },
                ),
                "white_point": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": (
                            "Mask values at or above this become fully white; solidifies "
                            "the mask core. Applied last."
                        ),
                    },
                ),
                "edge_refine": (
                    list(EDGE_REFINE_MODES),
                    {
                        "default": "off",
                        "tooltip": (
                            "Snap the mask edge to the guide_image. 'guided filter' is fast "
                            "edge-aware filtering (needs opencv-contrib-python); 'matting' "
                            "solves closed-form alpha matting around the edge (needs "
                            "pymatting). Both require the guide_image input."
                        ),
                    },
                ),
            },
            "optional": {
                "preview": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": (
                            "Show the refined mask on the node face. Off skips writing the "
                            "preview file to ComfyUI's temp folder."
                        ),
                    },
                ),
                "guide_image": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "RGB frames the mask belongs to; required when edge_refine is "
                            "'guided filter' or 'matting'."
                        ),
                    },
                ),
                "max_hole_size": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 0.1,
                        "tooltip": (
                            "The biggest hole fill_holes fills, in percent of the picture. "
                            "2 fills the gaps a quick brush leaves but keeps a person or pet "
                            "you left unpainted; 0 fills every hole."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("MASK", "MASK")
    RETURN_NAMES = ("mask", "mask_inverted")
    OUTPUT_TOOLTIPS = (
        "The refined BHW mask.",
        "The refined mask inverted, for operations that target the background.",
    )
    FUNCTION = "refine"
    # 带预览的中间节点，跟本插件其它预览节点一致（见文件头说明）。
    OUTPUT_NODE = True

    def refine(
        self,
        mask,
        expand,
        blur,
        fill_holes,
        smooth,
        black_point,
        white_point,
        edge_refine,
        guide_image=None,
        preview=True,
        max_hole_size=0.0,
    ):
        refined, inverted = refine_mask(
            mask,
            int(expand),
            float(blur),
            bool(fill_holes),
            smooth=int(smooth),
            black_point=float(black_point),
            white_point=float(white_point),
            edge_refine=str(edge_refine),
            guide_image=guide_image,
            max_hole_size=float(max_hole_size),
        )
        if not preview:
            return (refined, inverted)
        # The refined mask itself is the preview: upstream showed whatever fed
        # the mask input, and a segmentation node upstream has no picture to
        # show, so the panel stayed empty exactly when the result mattered.
        try:
            return {"ui": {"images": self._preview(refined)}, "result": (refined, inverted)}
        except Exception as exc:  # a failed preview is never fatal
            detail = str(exc).encode("ascii", "replace").decode("ascii")
            print("[QG-tools] Mask Refine: preview unavailable (%s)." % detail)
            return (refined, inverted)

    @staticmethod
    def _preview(mask):
        out_dir = folder_paths.get_temp_directory()
        prefix = "QG_MaskRefine_temp_" + "".join(
            random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5)
        )
        filename = prefix + ".png"
        array = np.clip(255.0 * mask[0].cpu().numpy(), 0, 255).astype(np.uint8)
        Image.fromarray(array, mode="L").save(os.path.join(out_dir, filename), compress_level=1)
        return [{"filename": filename, "subfolder": "", "type": "temp"}]


NODE_CLASS_MAPPINGS = {"QG_MaskRefine": QGMaskRefine}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskRefine": "Mask Refine"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
