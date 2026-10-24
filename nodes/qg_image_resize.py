# -*- coding: utf-8 -*-
"""QG_ImageResize — resize an image, output image + width + height.

Ported from rgthree-comfy (py/image_resize.py, class RgthreeImageResize),
MIT licensed, authored by rgthree. Reuses ComfyUI's stock upscale routine
(comfy.utils.common_upscale) so it tracks whatever resampling methods the
installed ComfyUI exposes. Renamed to the QG_ prefix and output names kept in
Chinese to match the rest of the pack.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import torch
import comfy.utils
import nodes


class QGImageResize:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Resize an image. Pick pixels or percentage for the measurement, and "
        "crop / pad / contain for how the result fits the target box; the node "
        "also returns the resulting width and height as integers so you can "
        "drive downstream size math."
    )
    SEARCH_ALIASES = ["resize", "scale", "image", "宽", "高", "缩放", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "measurement": (["pixels", "percentage"],),
                "width": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": (
                            "Target width: pixels when the measurement is pixels, a percentage "
                            "of the source when it is percentage; 0 derives it from the height, "
                            "keeping the aspect ratio."
                        ),
                    },
                ),
                "height": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": (
                            "Target height: pixels when the measurement is pixels, a percentage "
                            "of the source when it is percentage; 0 derives it from the width, "
                            "keeping the aspect ratio."
                        ),
                    },
                ),
                "fit": (
                    ["crop", "pad", "contain"],
                    {
                        "tooltip": (
                            "crop: scale up to fill the target box, then trim the overflow "
                            "evenly so the output is exactly the target size.\n"
                            "pad: scale to fit inside the target box, then pad the gaps evenly "
                            "so the output is exactly the target size.\n"
                            "contain: scale to fit inside the target box and stop there, so one "
                            "side may end up smaller than the target.\n"
                            "\n"
                            "When either width or height is 0, contain is what runs."
                        )
                    },
                ),
                "method": (nodes.ImageScale.upscale_methods,),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("IMAGE", "WIDTH", "HEIGHT")
    OUTPUT_TOOLTIPS = (
        "The resized images.",
        "The actual width of the output image.",
        "The actual height of the output image.",
    )
    FUNCTION = "main"

    def main(self, image, measurement, width, height, method, fit):
        """Resizes the image and reports the resulting size."""
        _, H, W, _ = image.shape

        if measurement == "percentage":
            width = round(width * W / 100)
            height = round(height * H / 100)

        if (width == 0 and height == 0) or (width == W and height == H):
            return (image, W, H)

        # One dimension 0 -> derive it from the other with a locked aspect ratio,
        # which also implies a 'contain' fit.
        if width == 0 or height == 0:
            width = round(height / H * W) if width == 0 else width
            height = round(width / W * H) if height == 0 else height
            fit = "contain"

        # At this point width/height are the desired output size, but the size we
        # upscale to may differ depending on the fit.
        resized_width = width
        resized_height = height
        if fit == "crop":
            if (height / H * W) > width:
                resized_width = round(height / H * W)
            elif (width / W * H) > height:
                resized_height = round(width / W * H)
        elif fit in ("contain", "pad"):
            if (height / H * W) > width:
                resized_height = round(width / W * H)
            elif (width / W * H) > height:
                resized_width = round(height / H * W)

        out_image = comfy.utils.common_upscale(
            image.clone().movedim(-1, 1), resized_width, resized_height, method, crop="disabled"
        ).movedim(1, -1)
        OB, OH, OW, OC = out_image.shape

        if fit != "contain":
            # First crop to the exact box, then pad if still short.
            if OW > width:
                out_image = out_image.narrow(-2, (OW - width) // 2, width)
            if OH > height:
                out_image = out_image.narrow(-3, (OH - height) // 2, height)

            OB, OH, OW, OC = out_image.shape
            if width != OW or height != OH:
                padded_image = torch.zeros(
                    (OB, height, width, OC), dtype=image.dtype, device=image.device
                )
                x = (width - OW) // 2
                y = (height - OH) // 2
                for b in range(OB):
                    padded_image[b, y : y + OH, x : x + OW, :] = out_image[b]
                out_image = padded_image

        return (out_image, out_image.shape[2], out_image.shape[1])


NODE_CLASS_MAPPINGS = {"QG_ImageResize": QGImageResize}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageResize": "Image Resize"}
