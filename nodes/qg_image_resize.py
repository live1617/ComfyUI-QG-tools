# -*- coding: utf-8 -*-
"""QG_ImageResize — resize an image, and say how big the result actually came out.

Written for ComfyUI-QG-tools on 2026-10-30, replacing the rgthree-comfy port
that shipped in v0.8.0. The node id, the six widgets in their old order, the
three outputs and their names are unchanged, so a saved workflow opens and
runs exactly as before. The resampling still goes through ComfyUI's own
``common_upscale``, so it tracks whatever methods the installed core exposes.

What the port got right, and is kept
------------------------------------
* ``common_upscale`` instead of a private resampler: one code path, no extra
  dependency, and the same pixels as core's ImageScale.
* **0 means "not specified"** for either side, and the other side then fixes
  the aspect ratio. That is the shorthand people actually type.
* ``crop`` / ``pad`` / ``contain`` as three answers to "the box is a different
  shape than the picture".
* Width and height come back as integers read off the *result*, not off the
  request, so rounding never lies to the next node.

What this rewrite changed
-------------------------
* **Percentage lost its "not specified" value.** The port converted first and
  checked for zero afterwards::

      width  = round(width  * W / 100)   # 1% of a 50 px picture -> 0
      if width == 0: derive from height  # ...and 0 now means "empty"

  So 1% of a narrow picture silently became the full width, because the
  rounded pixel value collided with the sentinel. Not specified is now decided
  on the *percentage* before converting, and a converted value is floored at
  one pixel instead of falling back to "derive it".
* **A derived side could come out 0.** Deriving the width from a height of 1
  on a 1000x1 picture gives 0, and ``common_upscale`` raises on a zero
  dimension. Both the derived and the converted side are floored at 1.
* **The "nothing to do" path returned the input tensor itself**, while every
  other path returned a fresh one. Half the callers got storage shared with
  the upstream node and half did not, which is exactly the asymmetry that
  makes an in-place write somewhere downstream corrupt a cached image. All
  paths return their own tensor now.
* **A cropped result was a view into the resized tensor** (``narrow`` returns
  a view), so the output shared storage with an intermediate. The return is
  made contiguous, which also costs nothing when nothing was cropped.
* **Padding walked the batch in Python** (``for b in range(OB)``). One slice
  assignment does the whole batch.
* ``FUNCTION`` is ``execute``, matching the rest of the pack. Saved graphs
  never store it and nothing outside this file referenced ``main``.

One thing that is deliberately *not* changed
--------------------------------------------
The three fits are still measured against the requested box, and the reported
size is still the real one. ``contain`` can therefore return something smaller
than asked (a 200x150 request on a square picture gives 150x150) - that is what
contain means, and QG_ImageCropRotatePad is the node that reaches an exact
size by painting the rest instead.

Only core modules are used -- no new dependency.
"""

import comfy.utils
import nodes

PIXELS = "pixels"
PERCENTAGE = "percentage"
MEASUREMENTS = [PIXELS, PERCENTAGE]

CROP = "crop"
PAD = "pad"
CONTAIN = "contain"
FITS = [CROP, PAD, CONTAIN]

# common_upscale raises on a zero dimension, so anything derived or converted
# is lifted to one pixel rather than left at zero.
MIN_SIDE = 1

# What common_upscale recognises, used only if the core node cannot be read.
_FALLBACK_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]


def upscale_methods():
    """The installed core's resampling list, with a fallback.

    Reading it off ``nodes.ImageScale`` is what keeps this node in step with
    whatever ComfyUI adds later - but a rename in core would otherwise take
    the whole node down at import time, so the failure is caught.
    """
    try:
        methods = [str(name) for name in nodes.ImageScale.upscale_methods]
    except Exception:  # pragma: no cover - depends on the installed core
        return list(_FALLBACK_METHODS)
    return methods or list(_FALLBACK_METHODS)


class QGImageResize:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Resize an image. Measurement picks whether the two numbers are pixels "
        "or percentages of the source; 0 on either side means 'work it out "
        "from the other one', keeping the aspect ratio. Fit decides how the "
        "picture meets a differently shaped box: crop fills the box and trims "
        "the overflow, pad fits inside and paints the gaps black, contain fits "
        "inside and stops there. The node also returns the real output width "
        "and height as integers, so downstream size maths never has to guess."
    )
    SEARCH_ALIASES = ["resize", "scale", "image", "宽", "高", "缩放", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        # Widget order is load-bearing: saved workflows store widgets_values by
        # position, so nothing here may be reordered or inserted.
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The image batch to resize."}),
                "measurement": (
                    MEASUREMENTS,
                    {
                        "default": PIXELS,
                        "tooltip": "pixels: the two numbers are the target size in pixels. "
                                   "percentage: they are a share of the source size (100 = unchanged).",
                    },
                ),
                "width": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Target width: pixels, or a percentage of the source when the "
                                   "measurement is percentage. 0 derives it from the height and keeps "
                                   "the aspect ratio.",
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Target height: pixels, or a percentage of the source when the "
                                   "measurement is percentage. 0 derives it from the width and keeps "
                                   "the aspect ratio.",
                    },
                ),
                "fit": (
                    FITS,
                    {
                        "default": CROP,
                        "tooltip": "crop: scale up until the box is full, then trim the overflow "
                                   "evenly, so the output is exactly the target size.\n"
                                   "pad: scale down to fit inside, then paint the gaps black, so the "
                                   "output is exactly the target size.\n"
                                   "contain: scale down to fit inside and stop, so one side may end "
                                   "up smaller than the target.\n"
                                   "\n"
                                   "With either width or height at 0 the aspect ratio is locked and "
                                   "contain is what runs.",
                    },
                ),
                "method": (
                    upscale_methods(),
                    {
                        "tooltip": "Resampling filter, the same list core's Image Scale offers. "
                                   "nearest-exact keeps hard mask edges, lanczos is sharpest for "
                                   "downscale-to-upscale work, area is good for heavy shrinking.",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("IMAGE", "WIDTH", "HEIGHT")
    OUTPUT_TOOLTIPS = (
        "The resized images.",
        "The width the output actually came out at, after fitting.",
        "The height the output actually came out at, after fitting.",
    )
    FUNCTION = "execute"

    @staticmethod
    def _target_pixels(measurement, width, height, source_w, source_h):
        """Convert the two numbers to pixels; 0 means "this side was not asked for".

        "Not asked for" has to be decided on the *percentage*, before it is
        converted. 1% of a 50 px picture rounds to 0 pixels, and checking for 0
        afterwards cannot tell that from an empty box - the port did exactly
        that and handed back a full-width picture.
        """
        width = int(width or 0)
        height = int(height or 0)
        if measurement != PERCENTAGE:
            return width, height

        want_w = round(source_w * width / 100.0) if width > 0 else 0
        want_h = round(source_h * height / 100.0) if height > 0 else 0
        if width > 0:
            want_w = max(MIN_SIDE, want_w)
        if height > 0:
            want_h = max(MIN_SIDE, want_h)
        return want_w, want_h

    def execute(self, image, measurement, width, height, fit, method):
        _, source_h, source_w, _ = image.shape
        want_w, want_h = self._target_pixels(measurement, width, height, source_w, source_h)

        # Nothing asked for: hand back a copy. The port returned the input
        # tensor itself here and a fresh tensor everywhere else, so whether an
        # output shared storage with the upstream node depended on the branch.
        if not want_w and not want_h:
            return (image.clone(), source_w, source_h)

        # One side asked for: the other follows the source ratio. The box has
        # collapsed to a line, so there is nothing left to crop or pad into.
        if not want_w:
            want_w = max(MIN_SIDE, round(want_h * source_w / source_h))
            fit = CONTAIN
        elif not want_h:
            want_h = max(MIN_SIDE, round(want_w * source_h / source_w))
            fit = CONTAIN

        if want_w == source_w and want_h == source_h:
            return (image.clone(), source_w, source_h)

        # A single scale factor keeps the aspect ratio honest: contain and pad
        # take the smaller one so the picture fits inside the box, crop takes
        # the larger one so it covers the box and can be trimmed back.
        scale_w = want_w / source_w
        scale_h = want_h / source_h
        scale = max(scale_w, scale_h) if fit == CROP else min(scale_w, scale_h)
        resize_w = max(MIN_SIDE, round(source_w * scale))
        resize_h = max(MIN_SIDE, round(source_h * scale))

        out = comfy.utils.common_upscale(
            image.movedim(-1, 1), resize_w, resize_h, method, crop="disabled"
        ).movedim(1, -1)

        if fit != CONTAIN:
            out_h, out_w = out.shape[1], out.shape[2]
            # Written as "trim down to the box, then paint up to the box" even
            # though crop only ever trims and pad only ever paints: rounding
            # can leave the supposedly exact side a pixel short, and this
            # order absorbs that without a special case.
            top = max(0, (out_h - want_h) // 2)
            left = max(0, (out_w - want_w) // 2)
            out = out[:, top:top + min(out_h, want_h), left:left + min(out_w, want_w), :]

            out_h, out_w = out.shape[1], out.shape[2]
            if out_h != want_h or out_w != want_w:
                canvas = out.new_zeros((out.shape[0], want_h, want_w, out.shape[3]))
                y = (want_h - out_h) // 2
                x = (want_w - out_w) // 2
                canvas[:, y:y + out_h, x:x + out_w, :] = out
                out = canvas

        # The slice above is a view into the resized tensor when it trimmed, so
        # without this the output would share storage with an intermediate.
        out = out.contiguous()
        return (out, out.shape[2], out.shape[1])


NODE_CLASS_MAPPINGS = {"QG_ImageResize": QGImageResize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageResize": "Image Resize"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
