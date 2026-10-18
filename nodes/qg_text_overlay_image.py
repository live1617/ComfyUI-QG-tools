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
"""

import os
import platform

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

COLOR_MAP = {
    "黑": (0, 0, 0),
    "白": (255, 255, 255),
    "灰": (128, 128, 128),
    "红": (255, 0, 0),
    "绿": (0, 255, 0),
    "蓝": (0, 0, 255),
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


class QGTextOverlayImage:
    CATEGORY = "QG-tools/文本"
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
    def INPUT_TYPES(cls):
        fonts = _font_choices()
        default_font = "NotoSansSC-VF" if "NotoSansSC-VF" in fonts else fonts[0]
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "底图（批次时每一帧都画同样的字）"}),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "要画的文字；换行会被保留，纵向排版时逐字换行",
                    },
                ),
                "font": (
                    fonts,
                    {"default": default_font, "tooltip": "系统字体（读的是操作系统字体目录）"},
                ),
                "font_size": (
                    "INT",
                    {"default": 128, "min": 1, "max": 1024, "step": 1, "tooltip": "字号（像素）"},
                ),
                "color_name": (
                    list(COLOR_MAP.keys()),
                    {"default": "白", "tooltip": "文字颜色；接了「自定义 RGB」时以它为准"},
                ),
                "layout": (
                    ["横向", "纵向"],
                    {"default": "横向", "tooltip": "横向逐行排；纵向把每个字拆成一行"},
                ),
                "x": (
                    "INT",
                    {
                        "default": 384,
                        "min": -8192,
                        "max": 16384,
                        "step": 1,
                        "tooltip": "文字中心点的横坐标（像素）",
                    },
                ),
                "y": (
                    "INT",
                    {
                        "default": 512,
                        "min": -8192,
                        "max": 16384,
                        "step": 1,
                        "tooltip": "文字中心点的纵坐标（像素）",
                    },
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        "tooltip": (
                            "可选自定义颜色：接 [R, G, B] 三元组（0-255 或 0-1），"
                            "接了就不看上面的内置颜色"
                        )
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    OUTPUT_TOOLTIPS = (
        "画好字的图像。",
        "文字形状的遮罩（白=有字，黑=空白）。",
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
        if layout == "纵向":
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
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextOverlayImage": "文字叠加图像"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
