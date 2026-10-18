# -*- coding: utf-8 -*-
"""QG_ImageOrLatentSize — read WIDTH / HEIGHT of an image, mask or Latent.

Ported from rgthree-comfy (py/image_or_latent_size.py, class
RgthreeImageOrLatentSize), MIT licensed, authored by rgthree. The input is a
wildcard ("*") so it accepts an IMAGE, a MASK or a LATENT; a Latent's samples
are (batch, 4, height, width) so the dimensions are multiplied back by 8.
Renamed to the QG_ prefix.
"""

import torch


class QGImageOrLatentSize:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Read the width and height of whatever you connect: an IMAGE, a MASK or "
        "a LATENT. A Latent stores dimensions divided by 8, so they are scaled "
        "back up automatically. Handy for driving size-conditional nodes."
    )
    SEARCH_ALIASES = ["size", "width", "height", "latent", "image", "mask", "尺寸", "宽", "高", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "input": ("*", {
                    "tooltip": "接入图像（IMAGE）、遮罩（MASK）或 Latent，节点输出其宽度和高度。",
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT")
    OUTPUT_TOOLTIPS = (
        "接入内容的宽度（Latent 已自动 ×8）。",
        "接入内容的高度（Latent 已自动 ×8）。",
    )
    FUNCTION = "main"

    def main(self, **kwargs):
        """Returns the width and height of the connected image/latent/mask."""
        data = kwargs.get("input", None)
        if data is None:
            return (0, 0)

        # Latent: dict with "samples" -> torch.Tensor of shape (B, 4, H, W).
        if isinstance(data, dict) and isinstance(data.get("samples"), torch.Tensor):
            _, _, height, width = data["samples"].shape
            return (width * 8, height * 8)

        # Torch tensor: IMAGE is (B, H, W, C); MASK is (B, 1, H, W).
        if isinstance(data, torch.Tensor):
            shp = data.shape
            if len(shp) == 4:
                _, a, b, c = shp
                if a == 1:  # mask (B, 1, H, W) -> width=c, height=b
                    return (int(c), int(b))
                # image (B, H, W, C) -> width=b, height=a
                return (int(b), int(a))

        return (0, 0)


NODE_CLASS_MAPPINGS = {"QG_ImageOrLatentSize": QGImageOrLatentSize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageOrLatentSize": "图像或 Latent 尺寸"}
