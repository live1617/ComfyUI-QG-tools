# -*- coding: utf-8 -*-
"""QG_ImageWatermark - stamp a watermark image onto a base image.

Ported from ComfyUI_Muye (image/add_image_watermark.py, class WatermarkMaster),
MIT licensed, authored by Muye. Rewritten to the QG conventions:

  * ASCII input names; every tooltip is Chinese (the node-info panel prints the
    backend string as-is, the translation pack only renames labels).
  * The upstream copy of ``common_upscale`` referenced helpers that did not
    exist in that module (``bislerp`` / ``lanczos`` were undefined), so it would
    have crashed on those two methods. The stock ``comfy.utils.common_upscale``
    is used instead - same resampling methods, maintained by ComfyUI itself.
  * Per-frame compositing over the whole batch. Upstream squashed the base
    tensor with ``squeeze()``, which mangled a 1-frame batch and broke on
    batches of differing frame counts.

Scope of the operation stays what it was: scale the watermark (or not), place
it by anchor + offset, optionally rotate it, apply opacity and an optional
mask, then paste it onto every frame of the base image.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.utils
import nodes
from ._qg_combo_legacy import combo_legacy


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0)


@combo_legacy("QG_ImageWatermark")
class QGImageWatermark:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Stamps a watermark image onto a base image: scale it (keep size, fit "
        "inside, multiply, or force a size), anchor it to one of nine positions, "
        "nudge it by pixels, rotate it, fade it with opacity, and optionally cut "
        "it with a mask. Applies to every frame of a batch."
    )
    SEARCH_ALIASES = [
        "watermark", "logo", "stamp", "水印", "角标", "logo", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, scale_mode=None, position=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_image": (
                    "IMAGE",
                    {"tooltip": "The base images. A batch is fine, the watermark lands on every frame."},
                ),
                "watermark_image": (
                    "IMAGE",
                    {"tooltip": "The watermark image; from a batch only the first frame is used."},
                ),
                "scale_mode": (
                    ["none", "fit", "factor", "width-height"],
                    {
                        "default": "none",
                        "tooltip": (
                            "none keeps the original size; fit shrinks it until it fits the "
                            "base image; factor multiplies the original size by the factor; "
                            "width-height uses the width and height filled in below."
                        ),
                    },
                ),
                "scale_method": (
                    nodes.ImageScale.upscale_methods,
                    {
                        "default": "bilinear",
                        "tooltip": "Resampling method used to scale the watermark, with no effect under none.",
                    },
                ),
                "scale_factor": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 16.0,
                        "step": 0.1,
                        "tooltip": "Used when the scale mode is set to factor.",
                    },
                ),
                "target_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Width used when the scale mode is set to width-height.",
                    },
                ),
                "target_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "Height used when the scale mode is set to width-height.",
                    },
                ),
                "position": (
                    [
                        "center", "top", "bottom", "left", "right",
                        "top-left", "top-right", "bottom-left", "bottom-right",
                    ],
                    {
                        "default": "bottom-right",
                        "tooltip": "Anchor point of the watermark on the base image.",
                    },
                ),
                "offset_x": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "Horizontal pixel offset from the anchor, positive moves right.",
                    },
                ),
                "offset_y": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "Vertical pixel offset from the anchor, positive moves down.",
                    },
                ),
                "rotation": (
                    "INT",
                    {
                        "default": 0,
                        "min": -180,
                        "max": 180,
                        "step": 1,
                        "tooltip": "Rotation in degrees, clockwise positive; the canvas grows to fit.",
                    },
                ),
                "opacity": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100.0,
                        "step": 5.0,
                        "display": "slider",
                        "tooltip": "0 is fully opaque and 100 is fully transparent.",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "Optional mask: white areas hide the watermark, black areas show it as usual.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = (
        "The images with the watermark applied, as many as went in.",
    )
    FUNCTION = "apply_watermark"

    def _resize_watermark(self, watermark, scale_mode, scale_method, scale_factor,
                          target_width, target_height, base_w, base_h):
        if scale_mode == "none":
            return watermark
        wm_w = watermark.shape[2]
        wm_h = watermark.shape[1]
        if scale_mode == "fit":
            ratio = min(base_w / wm_w, base_h / wm_h)
            new_w, new_h = max(1, round(wm_w * ratio)), max(1, round(wm_h * ratio))
        elif scale_mode == "factor":
            new_w, new_h = max(1, round(wm_w * scale_factor)), max(1, round(wm_h * scale_factor))
        else:
            new_w, new_h = max(1, int(target_width)), max(1, int(target_height))
        if new_w == wm_w and new_h == wm_h:
            return watermark
        samples = watermark.movedim(-1, 1)
        samples = comfy.utils.common_upscale(samples, new_w, new_h, scale_method, crop="disabled")
        return samples.movedim(1, -1)

    def apply_watermark(self, base_image, watermark_image, scale_mode, scale_method,
                        scale_factor, target_width, target_height, position,
                        offset_x, offset_y, rotation, opacity, mask=None):
        if base_image.dim() == 3:
            base_image = base_image.unsqueeze(0)
        if watermark_image.dim() == 3:
            watermark_image = watermark_image.unsqueeze(0)

        base_h, base_w = int(base_image.shape[1]), int(base_image.shape[2])
        watermark = watermark_image[0:1]
        watermark = self._resize_watermark(
            watermark, scale_mode, scale_method, scale_factor,
            target_width, target_height, base_w, base_h,
        )

        # Composite in RGBA so rotation expands the canvas without black corners.
        wm_pil = _tensor_to_pil(watermark[0])
        if wm_pil.mode != "RGB":
            wm_pil = wm_pil.convert("RGB")
        wm_pil = wm_pil.convert("RGBA")
        wm_pil.putalpha(Image.new("L", wm_pil.size, 255))

        if mask is not None:
            mask_frame = mask[0] if mask.dim() == 3 else mask
            mask_pil = _tensor_to_pil(mask_frame.float())
            if mask_pil.mode != "L":
                mask_pil = mask_pil.convert("L")
            if mask_pil.size != wm_pil.size:
                mask_pil = mask_pil.resize(wm_pil.size)
            # White area in the mask means "hide the watermark".
            wm_pil.putalpha(ImageOps.invert(mask_pil))

        if rotation % 360:
            wm_pil = wm_pil.rotate(int(rotation), expand=True, resample=Image.BICUBIC)

        if opacity > 0:
            r, g, b, a = wm_pil.split()
            factor = max(0.0, 1.0 - float(opacity) / 100.0)
            a = a.point(lambda v: int(v * factor))
            wm_pil.putalpha(a)

        wm_w, wm_h = wm_pil.size
        anchors = {
            "center": ((base_w - wm_w) / 2, (base_h - wm_h) / 2),
            "top": ((base_w - wm_w) / 2, 0),
            "bottom": ((base_w - wm_w) / 2, base_h - wm_h),
            "left": (0, (base_h - wm_h) / 2),
            "right": (base_w - wm_w, (base_h - wm_h) / 2),
            "top-left": (0, 0),
            "top-right": (base_w - wm_w, 0),
            "bottom-left": (0, base_h - wm_h),
            "bottom-right": (base_w - wm_w, base_h - wm_h),
        }
        # 🔴 这里的 key 必须是英文：老存档里的中文选项值在 @combo_legacy 里就换回英文了。
        #    而且 dict.get() 的默认值是「先求值再传参」—— 写个不存在的 key 会无条件 KeyError，
        #    不管 position 传什么都会炸（v0.8.5 搬进来时就写错了，一直没有节点用过 position
        #    以外的分支所以没人发现）。
        anchor_x, anchor_y = anchors.get(position, anchors["center"])
        location = (int(anchor_x + offset_x), int(anchor_y + offset_y))

        frames = []
        for frame in torch.unbind(base_image, dim=0):
            base_pil = _tensor_to_pil(frame)
            if base_pil.mode != "RGB":
                base_pil = base_pil.convert("RGB")
            # Always pass the RGBA watermark as its own mask: without it PIL
            # pastes the RGB channels opaquely and both the opacity slider and
            # the rotated corners stop working. (Upstream only passed a mask
            # when a MASK input was connected.)
            base_pil.paste(wm_pil, location, wm_pil)
            frames.append(_pil_to_tensor(base_pil))
        return (torch.stack(frames, dim=0),)


NODE_CLASS_MAPPINGS = {"QG_ImageWatermark": QGImageWatermark}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageWatermark": "Image Watermark"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
