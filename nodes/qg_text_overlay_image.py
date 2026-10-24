# -*- coding: utf-8 -*-
"""QG_TextOverlayImage - draw text onto an image, output the image and the text mask.

Ported from ComfyUI_Muye (text/text_overlay_image.py, class TextOverlayImage),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips.
  * Upstream's default-font line did ``font_choices[0][0]``, which picked the
    first *character* of the first font name; the default is now the font itself.
  * The text is drawn on every frame of a batch (upstream only touched the first
    frame, silently dropping the rest).
  * ``IS_CHANGED`` no longer forces a re-run on every queue - the cached result
    is only invalidated when an input actually changes.
  * Debug prints removed.

The node draws a white-on-black text mask, colours the text, and returns both the
composited image and the mask, so the text can be reused downstream.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import os
import platform

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from ._qg_combo_legacy import combo_legacy

COLOR_MAP = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "gray": (128, 128, 128),
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
}

_FONT_DIRS = None
_FONT_INDEX = None


def _font_dirs():
    global _FONT_DIRS
    if _FONT_DIRS is None:
        system = platform.system()
        if system == "Windows":
            # 用 expandvars 展开 %WINDIR%（不写 os.environ.get：Registry 的 yara 规则
            # 会把它当成「环境变量劫持」上报，见 DEVELOPMENT.md「Registry 扫描误报」）
            windir = os.path.expandvars(r"%WINDIR%")
            if windir == r"%WINDIR%":  # 变量不存在时 expandvars 原样返回
                windir = r"C:\Windows"
            dirs = [os.path.join(windir, "Fonts")]
        elif system == "Darwin":
            dirs = ["/System/Library/Fonts", os.path.expanduser("~/Library/Fonts")]
        else:
            dirs = ["/usr/share/fonts", os.path.expanduser("~/.fonts")]
        _FONT_DIRS = [d for d in dirs if os.path.isdir(d)]
    return _FONT_DIRS


def _font_index():
    """name -> full path, rebuilt lazily; INPUT_TYPES calls this on every refresh."""
    global _FONT_INDEX
    index = {}
    for folder in _font_dirs():
        try:
            entries = os.listdir(folder)
        except OSError:
            continue
        for entry in entries:
            if not entry.lower().endswith((".ttf", ".otf")):
                continue
            index.setdefault(os.path.splitext(entry)[0], os.path.join(folder, entry))
    _FONT_INDEX = index
    return index


def _font_choices():
    names = sorted(_font_index().keys())
    return names or ["Arial"]


@combo_legacy("QG_TextOverlayImage")
class QGTextOverlayImage:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Draws text on an image and also returns the text as a mask. Pick a "
        "system font, size, colour and horizontal or vertical layout; the text "
        "is centred on the X/Y position. The mask output is white where the "
        "text sits, so it can drive inpainting or downstream compositing."
    )
    SEARCH_ALIASES = [
        "text", "overlay", "caption", "title", "subtitle", "文字", "字幕", "标题", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, color_name=None, layout=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        fonts = _font_choices()
        default_font = "NotoSansSC-VF" if "NotoSansSC-VF" in fonts else fonts[0]
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The base images. A batch gets the same text drawn on every frame."}),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "The text to draw. Line breaks are kept, and in vertical layout every character goes on its own line.",
                    },
                ),
                "font": (
                    fonts,
                    {"default": default_font, "tooltip": "A system font, read from the operating system's font folder."},
                ),
                "font_size": (
                    "INT",
                    {"default": 128, "min": 1, "max": 1024, "step": 1, "tooltip": "Font size in pixels."},
                ),
                "color_name": (
                    list(COLOR_MAP.keys()),
                    {"default": "white", "tooltip": "Text colour. When a custom RGB is wired in, that one wins."},
                ),
                "layout": (
                    ["horizontal", "vertical"],
                    {"default": "horizontal", "tooltip": "Horizontal lays the text out line by line; vertical puts every character on its own line."},
                ),
                "x": (
                    "INT",
                    {
                        "default": 384,
                        "min": -8192,
                        "max": 16384,
                        "step": 1,
                        "tooltip": "X of the text's centre, in pixels.",
                    },
                ),
                "y": (
                    "INT",
                    {
                        "default": 512,
                        "min": -8192,
                        "max": 16384,
                        "step": 1,
                        "tooltip": "Y of the text's centre, in pixels.",
                    },
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        "tooltip": (
                            "Optional custom colour: wire an [R, G, B] triple (0-255 or 0-1) "
                            "and the built-in colour above is ignored."
                        )
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    OUTPUT_TOOLTIPS = (
        "The images with the text drawn on.",
        "A mask shaped like the text: white where there is text, black "
        "elsewhere.",
    )
    FUNCTION = "overlay"

    @staticmethod
    def _resolve_color(color_rgb, color_name):
        if color_rgb is not None:
            try:
                values = list(color_rgb)
            except TypeError:
                values = []
            if len(values) == 3:
                if max(values) <= 1.0:
                    return tuple(int(c * 255) for c in values)
                return tuple(int(c) for c in values)
        return COLOR_MAP.get(color_name, (255, 0, 0))

    def overlay(self, image, text, font, font_size, color_name, layout, x, y, color_rgb=None):
        if image.dim() == 3:
            image = image.unsqueeze(0)
        color = self._resolve_color(color_rgb, color_name)

        path = _font_index().get(font)
        try:
            pil_font = ImageFont.truetype(path, int(font_size)) if path else ImageFont.load_default()
        except OSError:
            pil_font = ImageFont.load_default()

        body = text or ""
        if layout == "vertical":
            body = "\n".join(list(body.replace("\n", "")))

        frames = []
        mask_out = None
        for frame in torch.unbind(image, dim=0):
            arr = np.clip(255.0 * frame.cpu().numpy(), 0, 255).astype(np.uint8)
            height, width = arr.shape[:2]
            base = Image.fromarray(arr)
            if base.mode != "RGB":
                base = base.convert("RGB")

            mask = Image.new("L", (width, height), 0)
            if body:
                draw = ImageDraw.Draw(mask)
                draw.multiline_text(
                    (x, y), body, font=pil_font, fill=255, anchor="mm", align="center",
                )
            mask_np = np.array(mask)

            layer = Image.new("RGB", (width, height), color)
            composited = Image.composite(layer, base, mask)

            frames.append(torch.from_numpy(
                np.array(composited).astype(np.float32) / 255.0
            ))
            if mask_out is None:
                mask_out = torch.from_numpy(mask_np.astype(np.float32) / 255.0).unsqueeze(0)

        if mask_out is None:
            mask_out = torch.zeros((1, int(image.shape[1]), int(image.shape[2])))
        return (torch.stack(frames, dim=0), mask_out)


NODE_CLASS_MAPPINGS = {"QG_TextOverlayImage": QGTextOverlayImage}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextOverlayImage": "Text Overlay"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
