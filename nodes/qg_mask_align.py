# -*- coding: utf-8 -*-
"""QG_MaskAlign - move a painted area onto a reference position.

Written for ComfyUI-QG-tools on 2026-10-29 from scratch. Same job as 孤海工具箱
(Goohaitools) 遮罩对齐V2: take a mask whose subject sits off-centre and slide it
so it lines up with another mask, or with the frame itself.

What is deliberately different:

  * Both axes take four anchors instead of an on/off pair. "left" glues the
    paint's left edge to the reference's left edge; "right" lines the two right
    edges up; "center" centres one inside the other. Off is still available per
    axis, so a horizontal-only nudge is one widget away.
  * The painted area's own pixels are slid, soft edges and all. Sliding a
    feathered mask does not erode it the way redrawing it as a rectangle does.
  * A batch moves by one shared offset (measured on the union of every frame),
    so a video's frames stay registered to each other instead of each frame
    drifting by its own few pixels.
  * Separate ``aligned`` and ``bbox`` outputs. bbox gives the solid rectangle
    the paint occupies, optionally unioned with the reference's, which is what
    a crop node wants; aligned gives the paint itself.
"""

from __future__ import annotations

import torch

from ._qg_execution_helpers import raise_if_interrupted, warn_once
from ._qg_mask_crop_helpers import mask_bounds

X_ANCHORS = ["none", "center", "left", "right"]
Y_ANCHORS = ["none", "center", "top", "bottom"]
OUTPUTS = ["aligned", "bbox"]

_WARNED: set[str] = set()


def _as_mask(mask) -> torch.Tensor:
    if not isinstance(mask, torch.Tensor):
        raise ValueError("[QG-tools] Mask Align expected a MASK tensor.")
    if mask.dim() == 4:
        mask = mask.flatten(0, 1)
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    if mask.dim() != 3:
        raise ValueError(
            "[QG-tools] Mask Align expected a BHW MASK, got shape %s." % (tuple(mask.shape),)
        )
    return mask.float().clamp(0.0, 1.0)


def _shift(mask: torch.Tensor, dx: int, dy: int) -> torch.Tensor:
    """Slide every frame by the same offset; whatever leaves the frame is lost."""
    if dx == 0 and dy == 0:
        return mask
    height, width = int(mask.shape[-2]), int(mask.shape[-1])
    out = torch.zeros_like(mask)
    src_x0, src_x1 = max(0, -dx), min(width, width - dx)
    src_y0, src_y1 = max(0, -dy), min(height, height - dy)
    if src_x1 > src_x0 and src_y1 > src_y0:
        out[:, src_y0 + dy:src_y1 + dy, src_x0 + dx:src_x1 + dx] = mask[
            :, src_y0:src_y1, src_x0:src_x1
        ]
    return out


class QGMaskAlign:
    CATEGORY = "QG-tools/Mask"
    DESCRIPTION = (
        "Slides a painted area so it lines up with a reference mask, or with the "
        "frame when none is given. Each axis picks its own anchor: center centres "
        "the paint inside the reference, left/top glues the two near edges "
        "together, right/bottom lines the two far edges up, none leaves that axis "
        "alone. output aligned moves the paint itself, soft edges and all; output "
        "bbox draws the solid rectangle it occupies, and union_bbox extends that "
        "rectangle to cover the reference too. A whole batch moves by one shared "
        "offset so video frames stay registered."
    )
    SEARCH_ALIASES = ["mask align", "center mask", "遮罩对齐", "对齐", "居中", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask": (
                    "MASK",
                    {"tooltip": "The mask to move. Every frame moves by the same offset."},
                ),
                "align_x": (
                    X_ANCHORS,
                    {
                        "default": "center",
                        "tooltip": "Horizontal anchor. none leaves x alone.",
                    },
                ),
                "align_y": (
                    Y_ANCHORS,
                    {
                        "default": "center",
                        "tooltip": "Vertical anchor. none leaves y alone.",
                    },
                ),
                "output": (
                    OUTPUTS,
                    {
                        "default": "aligned",
                        "tooltip": "aligned: the paint, moved. bbox: a solid rectangle covering where it landed.",
                    },
                ),
                "union_bbox": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "bbox only: stretch the rectangle to cover the reference's too. No effect without a reference.",
                    },
                ),
            },
            "optional": {
                "reference": (
                    "MASK",
                    {
                        "tooltip": "What to line up against. Anything not fully transparent counts, whatever its brightness. Empty means the frame itself."
                    },
                ),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    OUTPUT_TOOLTIPS = ("The moved mask, same size as the one handed in.",)
    FUNCTION = "align"

    def align(self, mask, align_x="center", align_y="center", output="aligned", union_bbox=False, reference=None):
        mask = _as_mask(mask)
        height, width = int(mask.shape[-2]), int(mask.shape[-1])

        own = mask_bounds(mask)
        if own is None:
            warn_once(
                "Mask Align: nothing painted, returning the mask unchanged.",
                _WARNED,
            )
            return (mask,)

        ref_bounds = None
        if reference is not None:
            reference = _as_mask(reference)
            if tuple(reference.shape[-2:]) != (height, width):
                raise ValueError(
                    "[QG-tools] Mask Align: the reference is %dx%d but the mask is %dx%d."
                    % (int(reference.shape[-1]), int(reference.shape[-2]), width, height)
                )
            ref_bounds = mask_bounds(reference)
        if ref_bounds is None:
            # No usable reference: the frame is the thing to line up inside.
            ref_bounds = (0, 0, width, height)

        own_x, own_y, own_w, own_h = own
        ref_x, ref_y, ref_w, ref_h = ref_bounds
        target_x = _anchor_offset(align_x, ref_x, ref_w, own_w)
        target_y = _anchor_offset(align_y, ref_y, ref_h, own_h)
        # "none" means that axis keeps its own origin, whatever the reference is.
        dx = 0 if target_x is None else target_x - own_x
        dy = 0 if target_y is None else target_y - own_y
        if target_x is None:
            target_x = own_x
        if target_y is None:
            target_y = own_y
        raise_if_interrupted()

        if output == "bbox":
            left, top = target_x, target_y
            right, bottom = target_x + own_w - 1, target_y + own_h - 1
            if union_bbox and ref_bounds is not None:
                left, top = min(left, ref_x), min(top, ref_y)
                right = max(right, ref_x + ref_w - 1)
                bottom = max(bottom, ref_y + ref_h - 1)
            left, top = max(0, left), max(0, top)
            right, bottom = min(width - 1, right), min(height - 1, bottom)
            out = torch.zeros_like(mask)
            if right >= left and bottom >= top:
                out[:, top:bottom + 1, left:right + 1] = 1.0
            return (out,)

        return (_shift(mask, dx, dy),)


def _anchor_offset(anchor: str, ref_start: int, ref_size: int, own_size: int):
    """Where the moved rectangle's left (or top) edge lands; None means stay put.

    Kept at the bottom of the module on purpose: the biligual checker walks up
    from each tooltip dict looking for the nearest ``"name": (`` line, and a
    ``"center":``-shaped line sitting above the class would be read as an input.
    """
    if anchor == "center":
        return ref_start + (ref_size - own_size) // 2
    if anchor in ("left", "top"):
        return ref_start
    if anchor in ("right", "bottom"):
        return ref_start + ref_size - own_size
    return None


NODE_CLASS_MAPPINGS = {"QG_MaskAlign": QGMaskAlign}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MaskAlign": "Mask Align"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
