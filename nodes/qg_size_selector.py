# -*- coding: utf-8 -*-
"""QG_SizeSelector - pick a resolution from presets and emit an empty latent.

Ported from ComfyUI_Muye (tool/size_selector.py, class MuyeSizeSelector),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips, debug print removed.
  * Two upstream bugs fixed:
      - ``latent_channels`` is now explicit. Upstream always built a 16-channel
        latent, which is right for Flux / SD3 / Hunyuan video but wrong for
        SD 1.5 and SDXL (4 channels) - those silently produced unusable latents.
        Default is 4; switch to 16 for Flux / SD3 / video models.
      - With ``ratio`` left at "无" and ``long_edge`` set, upstream assigned the
        long edge to *both* dimensions (a square). It now scales the preset so
        its long edge equals ``long_edge`` and the aspect ratio is preserved.
  * Everything else is unchanged: preset resolution, optional width/height
    overrides of any type (parsed as numbers), a ratio override, a frame count
    for video models, and rounding up to a factor (typically 8 or 16).
"""

import re

import torch

import comfy.model_management

MAX_RESOLUTION = 8192

PRESETS = (
    "3840x2160 - 16:9",
    "2160x3840 - 9:16",
    "2560x1440 - 16:9",
    "1440x2560 - 9:16",
    "2304x1280 - 16:9",
    "1280x2304 - 9:16",
    "1920x1080 - 16:9",
    "1080x1920 - 9:16",
    "1344x768 - 16:9",
    "768x1344 - 9:16",
    "2240x1280 - 7:4",
    "1280x2240 - 4:7",
    "1792x1024 - 7:4",
    "1024x1792 - 4:7",
    "1400x800 - 7:4",
    "800x1400 - 4:7",
    "2560x1920 - 4:3",
    "1920x2560 - 3:4",
    "2048x1536 - 4:3",
    "1536x2048 - 3:4",
    "1920x1440 - 4:3",
    "1440x1920 - 3:4",
    "1600x1200 - 4:3",
    "1200x1600 - 3:4",
    "1280x960 - 4:3",
    "960x1280 - 3:4",
    "1024x768 - 4:3",
    "768x1024 - 3:4",
    "2400x1600 - 3:2",
    "1600x2400 - 2:3",
    "1920x1280 - 3:2",
    "1280x1920 - 2:3",
    "1800x1200 - 3:2",
    "1200x1800 - 2:3",
    "1536x1024 - 3:2",
    "1024x1536 - 2:3",
    "1440x960 - 3:2",
    "960x1440 - 2:3",
    "1216x832 - 3:2",
    "832x1216 - 2:3",
    "2048x2048 - 1:1",
    "1024x1024 - 1:1",
    "768x768 - 1:1",
    "512x512 - 1:1",
)


class QGSizeSelector:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Builds an empty latent from a preset resolution and returns its width "
        "and height as integers. Optional width/height inputs override the "
        "preset, a ratio string (16:9, 2.39:1, ...) reshapes it, long_edge sets "
        "the long side while keeping the ratio, frames > 0 produces a video "
        "latent, and factor rounds dimensions up to a multiple (8 or 16). "
        "latent_channels is 4 for SD 1.5 / SDXL and 16 for Flux / SD3 / video."
    )
    SEARCH_ALIASES = [
        "size", "resolution", "latent", "aspect ratio", "尺寸", "分辨率", "比例", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (
                    list(PRESETS),
                    {
                        "default": "832x1216 - 2:3",
                        "tooltip": "预设分辨率与比例；下面的「比例」留「无」时才用它",
                    },
                ),
                "batch_size": (
                    "INT",
                    {"default": 1, "min": 1, "max": 4096, "tooltip": "批次大小"},
                ),
                "long_edge": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "tooltip": "长边像素；0 = 用预设原始尺寸，非 0 时保持比例缩放长边",
                    },
                ),
                "ratio": (
                    "STRING",
                    {
                        "default": "无",
                        "tooltip": "比例覆盖，如 16:9 / 2.39:1 / 1 1；填「无」则用预设的比例",
                    },
                ),
                "frames": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1024,
                        "tooltip": "帧数；0 = 图像模型（无时间维），大于 0 = 视频模型",
                    },
                ),
                "factor": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "tooltip": "把宽高向上取整到这个数的倍数（8/16/32…）；0 = 不取整",
                    },
                ),
                "latent_channels": (
                    ["4", "16"],
                    {
                        "default": "4",
                        "tooltip": "潜在通道数：SD 1.5 / SDXL 用 4；Flux / SD3 / 视频模型用 16",
                    },
                ),
            },
            "optional": {
                "width": (
                    "*",
                    {"tooltip": "可选宽度覆盖（任意类型，按数字解析）；接了并大于 0 就优先用宽高"},
                ),
                "height": (
                    "*",
                    {"tooltip": "可选高度覆盖（任意类型，按数字解析）"},
                ),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("LATENT", "WIDTH", "HEIGHT", "FRAMES")
    OUTPUT_TOOLTIPS = (
        "空潜在张量。",
        "实际使用的宽度。",
        "实际使用的高度。",
        "实际使用的帧数（0 = 图像模型）。",
    )
    FUNCTION = "execute"

    def __init__(self):
        self._device = comfy.model_management.intermediate_device()

    @staticmethod
    def _parse_ratio(ratio_str):
        if not ratio_str or ratio_str == "无":
            return None
        cleaned = re.sub(r"[\s/\\]", ":", ratio_str)
        numbers = re.findall(r"\d*\.?\d+", cleaned)
        if len(numbers) >= 2:
            return float(numbers[0]), float(numbers[1])
        return None

    @staticmethod
    def _adjust_to_factor(value, factor):
        if factor <= 0:
            return int(value)
        return ((int(value) + factor - 1) // factor) * factor

    @staticmethod
    def _parse_num(value):
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value)
        except Exception:
            return 0

    def execute(self, preset, batch_size, long_edge, ratio, frames, factor,
                latent_channels, width=0, height=0):
        width_num = self._parse_num(width)
        height_num = self._parse_num(height)

        if width_num > 0 and height_num > 0:
            out_w = min(self._adjust_to_factor(width_num, factor), MAX_RESOLUTION)
            out_h = min(self._adjust_to_factor(height_num, factor), MAX_RESOLUTION)
        else:
            base_w, base_h = preset.split(" ")[0].split("x")
            out_w, out_h = int(base_w), int(base_h)
            ratio_value = self._parse_ratio(ratio)

            if ratio_value:
                ratio_w, ratio_h = ratio_value
                if long_edge > 0:
                    if ratio_w >= ratio_h:
                        out_w = long_edge
                        out_h = int(out_w * ratio_h / ratio_w)
                    else:
                        out_h = long_edge
                        out_w = int(out_h * ratio_w / ratio_h)
                else:
                    if out_w / out_h > ratio_w / ratio_h:
                        out_w = int(out_h * ratio_w / ratio_h)
                    else:
                        out_h = int(out_w * ratio_h / ratio_w)
            elif long_edge > 0:
                # Keep the preset's aspect ratio and set its long edge.
                if out_w >= out_h:
                    out_h = int(round(out_h * long_edge / out_w))
                    out_w = long_edge
                else:
                    out_w = int(round(out_w * long_edge / out_h))
                    out_h = long_edge

            out_w = min(out_w, MAX_RESOLUTION)
            out_h = min(out_h, MAX_RESOLUTION)
            out_w = self._adjust_to_factor(out_w, factor)
            out_h = self._adjust_to_factor(out_h, factor)

        channels = int(latent_channels)
        if frames > 0:
            latent_frames = ((int(frames) - 1) // 4) + 1
            samples = torch.zeros(
                [batch_size, channels, latent_frames, out_h // 8, out_w // 8],
                device=self._device,
            )
        else:
            samples = torch.zeros(
                [batch_size, channels, out_h // 8, out_w // 8],
                device=self._device,
            )
            frames = 0

        return ({"samples": samples}, out_w, out_h, frames)


NODE_CLASS_MAPPINGS = {"QG_SizeSelector": QGSizeSelector}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_SizeSelector": "QG 尺寸选择器"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
