# -*- coding: utf-8 -*-
"""QG_ImageOrLatentSize - read the width and height of an image, mask or latent.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.x port of
rgthree-comfy's ``RgthreeImageOrLatentSize`` (MIT). The interface is unchanged:
one wildcard input, two INT outputs named WIDTH / HEIGHT.

What was wrong with the port
----------------------------
It only looked at 4-dimensional tensors::

    if len(shp) == 4:
        ...

and returned ``(0, 0)`` for anything else. But a MASK in ComfyUI is usually
**3-dimensional** - ``ImageToMask`` returns ``image[:, :, :, channel]`` and
``LoadImage`` returns ``mask.unsqueeze(0)``, both ``(B, H, W)``. So the most
common mask shape fell straight through to ``(0, 0)``: connect a mask, get
zero by zero, and nothing says why.

Only the 4-d ``(B, 1, H, W)`` form worked, and that is the less common one.

Shapes now handled
------------------
LATENT                       dict with a ``samples`` tensor, last two dims x 8
IMAGE  (B, H, W, C)          4-d, last dim is a channel count
MASK   (B, 1, H, W)          4-d, second dim is the singleton
MASK   (B, H, W)             3-d, the common one
MASK   (H, W)                2-d, a single mask

Telling ``(B, H, W, C)`` from ``(B, 1, H, W)`` at 4-d
-----------------------------------------------------
Both are 4-d, so the second dimension alone is not enough: an image one pixel
tall would look like a mask. What separates them is the last dimension - an
image's is a channel count (1, 3 or 4), a mask's is a real width. So a
leading singleton only means "mask" when the last dimension is *not* a
plausible channel count. An image of height 1 therefore reads correctly,
which the port could not do.

The ``*`` input also had no ``forceInput``. A wildcard input without it
makes the frontend render a text box that does nothing: you can type into
it, and the value goes nowhere. Same fix as QG_Exists and QG_RouteBlocker.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import torch

# A last dimension in this set reads as a channel count, not as a width.
_CHANNEL_COUNTS = (1, 3, 4)

# LATENT dimensions are stored downscaled by the VAE's spatial factor.
_LATENT_SCALE = 8


def _measure_tensor(data):
    """(width, height) for an IMAGE or MASK tensor, or (0, 0) if unknown."""
    shape = tuple(data.shape)
    dims = len(shape)

    if dims == 4:
        _, second, third, last = shape
        if second == 1 and last not in _CHANNEL_COUNTS:
            # (B, 1, H, W) - a mask
            return int(last), int(third)
        # (B, H, W, C) - an image
        return int(third), int(second)

    if dims == 3:
        # (B, H, W) - the shape ComfyUI's own mask nodes produce
        return int(shape[2]), int(shape[1])

    if dims == 2:
        # (H, W) - a single mask with no batch dimension
        return int(shape[1]), int(shape[0])

    return 0, 0


class QGImageOrLatentSize:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Read the width and height of whatever you connect: an IMAGE, a MASK or "
        "a LATENT. A Latent stores dimensions divided by 8, so they are scaled "
        "back up automatically. Masks are read in any of the shapes ComfyUI "
        "produces - (B,H,W), (B,1,H,W) or (H,W). Unwired, both outputs are 0."
    )
    SEARCH_ALIASES = ["size", "width", "height", "latent", "image", "mask", "尺寸", "宽", "高", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "input": ("*", {
                    "forceInput": True,
                    "tooltip": "Connect an IMAGE, a MASK or a LATENT; the node outputs its width and height.",
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT")
    OUTPUT_TOOLTIPS = (
        "Width of what you connected (a Latent is already scaled by 8).",
        "Height of what you connected (a Latent is already scaled by 8).",
    )
    FUNCTION = "execute"

    def execute(self, input=None):
        if input is None:
            return (0, 0)

        if isinstance(input, dict):
            samples = input.get("samples")
            if isinstance(samples, torch.Tensor) and samples.dim() >= 4:
                # (B, channels, H, W) - and 5-d for video latents, so the last
                # two dims are read rather than fixed positions.
                return (int(samples.shape[-1]) * _LATENT_SCALE,
                        int(samples.shape[-2]) * _LATENT_SCALE)
            return (0, 0)

        if isinstance(input, torch.Tensor):
            return _measure_tensor(input)

        return (0, 0)


NODE_CLASS_MAPPINGS = {"QG_ImageOrLatentSize": QGImageOrLatentSize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageOrLatentSize": "Image or Latent Size"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
