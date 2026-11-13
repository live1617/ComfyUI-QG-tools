# -*- coding: utf-8 -*-
"""QG_LongShortSide — long side, short side and aspect ratio of a picture.

Idea reference: Goohaitools-comfyui's "长边短边" node (GPL-3.0). This is an
independent implementation for this pack: English keys, English tooltips,
explicit output tooltips and a few guards the original lacks. No line of the
original source is reused.

Priority: a connected IMAGE wins over the width / height inputs; otherwise the
two INT inputs are used. With only one side given, both sides take that value
and the ratio is 0 (there is no honest aspect ratio to report). Anything that
cannot be read falls back to zeros so this node stays safe as a size fallback.
"""

from __future__ import annotations


def _as_int(value):
    """Best-effort non-negative int; None means "not usable"."""
    if value is None:
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (TypeError, ValueError, RuntimeError):
            return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return None


class QGLongShortSide:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Report the long side, the short side and the width / height ratio of "
        "a picture. A connected IMAGE wins over the width and height inputs, "
        "so it works in the middle of an image chain; without an image, wire "
        "the two INT inputs directly. With only one side connected, both sides "
        "take that value and the ratio is 0.0 because there is no real aspect "
        "ratio to report. Unreadable or missing inputs give zeros, so this node "
        "is safe as a size fallback. Unlike Image Or Latent Size (width, height, "
        "frame count) and Ratio Resolution (a ratio string plus a target size), "
        "this one only measures what is already there."
    )
    SEARCH_ALIASES = [
        "size", "dimension", "long side", "short side", "aspect ratio",
        "width", "height", "landscape", "portrait", "measure",
        "长边", "短边", "长短边", "宽高比", "比值", "尺寸", "图像尺寸", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "compute"
    RETURN_TYPES = ("INT", "INT", "FLOAT")
    RETURN_NAMES = ("long_side", "short_side", "ratio")
    OUTPUT_TOOLTIPS = (
        "The larger of width and height, in pixels; 0 when nothing usable is connected.",
        "The smaller of width and height, in pixels; 0 when nothing usable is connected.",
        "Width / height as a decimal; 0.0 when the height is 0 or only one side was given.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "A connected picture takes priority: its height "
                                   "and width are read from the tensor shape.",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "forceInput": True,
                        "tooltip": "Width in pixels, used when no image is connected.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "forceInput": True,
                        "tooltip": "Height in pixels, used when no image is connected.",
                    },
                ),
            },
        }

    def compute(self, image=None, width=None, height=None):
        try:
            w = h = None
            if image is not None:
                try:
                    shape = tuple(image.shape)
                except (AttributeError, TypeError):
                    shape = None
                if shape and len(shape) >= 3:
                    h = _as_int(shape[-3])
                    w = _as_int(shape[-2])

            single_value = False
            if w is None or h is None:
                in_w, in_h = _as_int(width), _as_int(height)
                if in_w is None and in_h is None:
                    w = h = 0
                elif in_w is None:
                    w = h = in_h
                    single_value = True
                elif in_h is None:
                    w = h = in_w
                    single_value = True
                elif in_w == 0 and in_h > 0:
                    w = h = in_h
                    single_value = True
                elif in_h == 0 and in_w > 0:
                    w = h = in_w
                    single_value = True
                else:
                    w, h = in_w, in_h

            long_side = max(w, h)
            short_side = min(w, h)
            ratio = float(w / h) if h and not single_value else 0.0
            return (int(long_side), int(short_side), ratio)
        except Exception as exc:  # keep this usable as a size fallback
            print("[QG-tools] Long / Short Sides: unusable input, returning zeros (%s)" % exc)
            return (0, 0, 0.0)


NODE_CLASS_MAPPINGS = {"QG_LongShortSide": QGLongShortSide}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_LongShortSide": "Long / Short Sides"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
