# -*- coding: utf-8 -*-
"""QG_ImageOrLatentSize - read the width, height and count of an image, mask or latent.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.x port of
rgthree-comfy's ``RgthreeImageOrLatentSize`` (MIT); extended on 2026-11-08 with
what the QG-Multipack ``QG_GetImageSize`` did better (see below). The first two
outputs keep their slots and names, so existing links are untouched.

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

What the 2026-11-08 extension added
-----------------------------------
``QG_GetImageSize`` from the author's own QG-Multipack plugin overlapped this
node almost completely, so instead of shipping both, its three advantages were
folded in here:

1. **A third output, ``COUNT``** - the frame count, i.e. the batch dimension.
   A batch of 8 images reads 8; a single ``(H, W)`` mask reads 1. This is what
   video / batch workflows need and this node could not answer before.
2. **Non-torch input** - numpy arrays and nested lists are read by shape
   instead of falling through to ``(0, 0)``. Lists are never converted to a
   tensor (that would copy them); their shape is walked from the first branch.
3. **No more silent zeros** - a value that is connected but cannot be measured
   now raises, naming the shape it got. Returning ``(0, 0)`` for a 1-d tensor
   or a string made ``EmptyLatentImage`` fail later with "width must be > 0"
   and no clue where the zero came from. An *unwired* input still returns
   ``(0, 0, 0)``: that is this node's contract and several workflows use it.

``COUNT`` for a LATENT is ``samples.shape[0]``. A 5-d video latent keeps its
time axis somewhere else and the order is not standardised, so this node does
not guess: it reports the batch dimension only, while width and height still
come from the last two dims.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import torch

# A last dimension in this set reads as a channel count, not as a width.
_CHANNEL_COUNTS = (1, 3, 4)

# LATENT dimensions are stored downscaled by the VAE's spatial factor.
_LATENT_SCALE = 8


def _nested_shape(data):
    """Shape of a nested list / tuple, walking the first branch only."""
    shape = []
    node = data
    while isinstance(node, (list, tuple)):
        shape.append(len(node))
        if not shape[-1]:
            break
        node = node[0]
    return tuple(shape)


def _shape_of(data):
    """Shape tuple for anything tensor-like: torch, numpy, nested lists."""
    if isinstance(data, torch.Tensor):
        return tuple(int(v) for v in data.shape)

    shape = getattr(data, "shape", None)      # numpy arrays and friends
    if shape is not None:
        try:
            return tuple(int(v) for v in shape)
        except (TypeError, ValueError):
            pass

    if isinstance(data, (list, tuple)):
        return _nested_shape(data)

    raise ValueError(
        "Image or Latent Size: the input is %s, which has no width or height; "
        "it accepts IMAGE / MASK / LATENT (plus numpy arrays and nested lists)"
        % type(data).__name__
    )


def _measure(shape):
    """(width, height, count) from a 2-, 3- or 4-d shape."""
    dims = len(shape)

    if dims == 4:
        batch, second, third, last = shape
        if second == 1 and last not in _CHANNEL_COUNTS:
            # (B, 1, H, W) - a mask
            return int(last), int(third), int(batch)
        # (B, H, W, C) - an image
        return int(third), int(second), int(batch)

    if dims == 3:
        # (B, H, W) - the shape ComfyUI's own mask nodes produce
        return int(shape[2]), int(shape[1]), int(shape[0])

    if dims == 2:
        # (H, W) - a single mask with no batch dimension
        return int(shape[1]), int(shape[0]), 1

    raise ValueError(
        "Image or Latent Size: a %dD shape %s has no width or height; "
        "IMAGE is [B,H,W,C], MASK is [B,H,W] / [B,1,H,W] / [H,W]"
        % (dims, tuple(shape))
    )


def _measure_latent(samples):
    """(width, height, count) for a LATENT's samples tensor."""
    shape = _shape_of(samples)
    if len(shape) < 4:
        raise ValueError(
            "Image or Latent Size: LATENT samples is only %dD (%s); at least 4D is required. "
            "Is this a fake latent produced by some other node?"
            % (len(shape), tuple(shape))
        )
    # (B, channels, H, W) - and 5-d for video latents, so the last two dims are
    # read rather than fixed positions. Count stays the batch dimension: a 5-d
    # video latent keeps its time axis elsewhere and the order is not
    # standardised, so guessing it would be worse than not answering.
    return (int(shape[-1]) * _LATENT_SCALE,
            int(shape[-2]) * _LATENT_SCALE,
            int(shape[0]))


class QGImageOrLatentSize:
    CATEGORY = "QG-tools/Image/Transform"
    DESCRIPTION = (
        "Read the width, height and count of whatever you connect: an IMAGE, a "
        "MASK or a LATENT. A Latent stores dimensions divided by 8, so they are "
        "scaled back up automatically. Masks are read in any of the shapes "
        "ComfyUI produces - (B,H,W), (B,1,H,W) or (H,W). Count is the batch "
        "dimension, i.e. the frame count. Unwired, all three outputs are 0."
    )
    SEARCH_ALIASES = [
        "size", "width", "height", "count", "batch", "frames", "latent",
        "image", "mask", "尺寸", "宽", "高", "帧数", "数量", "批次", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "input": ("*", {
                    "forceInput": True,
                    "tooltip": "Connect an IMAGE, a MASK or a LATENT; the node outputs its width, height and frame count.",
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT", "COUNT")
    OUTPUT_TOOLTIPS = (
        "Width of what you connected (a Latent is already scaled by 8).",
        "Height of what you connected (a Latent is already scaled by 8).",
        "Batch dimension - the frame count. A single (H,W) mask counts as 1; for a Latent this is samples' first dimension.",
    )
    FUNCTION = "execute"

    def execute(self, input=None):
        if input is None:
            return (0, 0, 0)

        if isinstance(input, dict):
            if "samples" not in input:
                keys = ", ".join(str(k) for k in list(input)[:6]) or "empty"
                raise ValueError(
                    "Image or Latent Size: got a dict without a samples key (keys: %s); "
                    "that is not a LATENT - LATENT looks like {'samples': tensor}" % keys
                )
            return _measure_latent(input["samples"])

        return _measure(_shape_of(input))


NODE_CLASS_MAPPINGS = {"QG_ImageOrLatentSize": QGImageOrLatentSize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageOrLatentSize": "Image or Latent Size"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
