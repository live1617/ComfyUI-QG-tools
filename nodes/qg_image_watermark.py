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
"""

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.utils
import nodes


def _tensor_to_pil(image: torch.Tensor) -> Image.Image:
    arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0)


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
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_image": (
                    "IMAGE",
                    {"tooltip": "底图（可以是批次，水印会贴到每一帧上）"},
                ),
                "watermark_image": (
                    "IMAGE",
                    {"tooltip": "水印图；接批次时只用第一帧"},
                ),
                "scale_mode": (
                    ["不缩放", "等比适配", "按倍数缩放", "按指定宽高缩放"],
                    {
                        "default": "不缩放",
                        "tooltip": (
                            "不缩放：保持原尺寸；等比适配：缩到能放进底图；"
                            "按倍数缩放：原尺寸乘以倍数；按指定宽高缩放：直接用下面填的宽高"
                        ),
                    },
                ),
                "scale_method": (
                    nodes.ImageScale.upscale_methods,
                    {
                        "default": "bilinear",
                        "tooltip": "缩放水印图用的重采样方法（不缩放时无效果）",
                    },
                ),
                "scale_factor": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 16.0,
                        "step": 0.1,
                        "tooltip": "缩放模式选「按倍数缩放」时生效",
                    },
                ),
                "target_width": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "缩放模式选「按指定宽高缩放」时的宽度",
                    },
                ),
                "target_height": (
                    "INT",
                    {
                        "default": 512,
                        "min": 0,
                        "max": nodes.MAX_RESOLUTION,
                        "step": 1,
                        "tooltip": "缩放模式选「按指定宽高缩放」时的高度",
                    },
                ),
                "position": (
                    ["居中", "上", "下", "左", "右", "左上", "右上", "左下", "右下"],
                    {
                        "default": "右下",
                        "tooltip": "水印在底图上的锚点位置",
                    },
                ),
                "offset_x": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "在锚点基础上的横向像素偏移（正数往右）",
                    },
                ),
                "offset_y": (
                    "INT",
                    {
                        "default": 32,
                        "min": -48000,
                        "max": 48000,
                        "step": 1,
                        "tooltip": "在锚点基础上的纵向像素偏移（正数往下）",
                    },
                ),
                "rotation": (
                    "INT",
                    {
                        "default": 0,
                        "min": -180,
                        "max": 180,
                        "step": 1,
                        "tooltip": "旋转角度（顺时针为正），画布会随旋转扩大",
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
                        "tooltip": "0 = 完全不透明，100 = 完全透明",
                    },
                ),
            },
            "optional": {
                "mask": (
                    "MASK",
                    {
                        "tooltip": "可选遮罩：白色区域不透出水印，黑色区域正常显示",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    OUTPUT_TOOLTIPS = ("贴好水印的图像（与底图同样张数）。",)
    FUNCTION = "apply_watermark"

    def _resize_watermark(self, watermark, scale_mode, scale_method, scale_factor,
                          target_width, target_height, base_w, base_h):
        if scale_mode == "不缩放":
            return watermark
        wm_w = watermark.shape[2]
        wm_h = watermark.shape[1]
        if scale_mode == "等比适配":
            ratio = min(base_w / wm_w, base_h / wm_h)
            new_w, new_h = max(1, round(wm_w * ratio)), max(1, round(wm_h * ratio))
        elif scale_mode == "按倍数缩放":
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
            "居中": ((base_w - wm_w) / 2, (base_h - wm_h) / 2),
            "上": ((base_w - wm_w) / 2, 0),
            "下": ((base_w - wm_w) / 2, base_h - wm_h),
            "左": (0, (base_h - wm_h) / 2),
            "右": (base_w - wm_w, (base_h - wm_h) / 2),
            "左上": (0, 0),
            "右上": (base_w - wm_w, 0),
            "左下": (0, base_h - wm_h),
            "右下": (base_w - wm_w, base_h - wm_h),
        }
        anchor_x, anchor_y = anchors.get(position, anchors["居中"])
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
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageWatermark": "图像水印"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
