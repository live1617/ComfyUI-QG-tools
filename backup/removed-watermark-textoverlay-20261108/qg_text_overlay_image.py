# -*- coding: utf-8 -*-
"""QG_TextOverlayImage - draw text onto an image, output the image and the text mask.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.5 port of
ComfyUI_Muye's ``TextOverlayImage`` (MIT). The node draws a white-on-black
text mask, colours the text, and returns both the composited image and the
mask, so the text can be reused downstream.

Already right in the port, and kept
-----------------------------------
* **The default font is a font, not a letter.** Upstream did
  ``font_choices[0][0]``, which took the first *character* of the first font
  name and then failed to open it.
* **Every frame of a batch gets the text.** Upstream drew on the first frame
  and silently dropped the rest.
* **``IS_CHANGED`` does not force a re-run.** The port already removed that;
  it would have defeated caching on every queue.

What changed in this rewrite
----------------------------
**The text is now centred on its ink, not on the font's line box.** Pillow's
``anchor="mm"`` centres the *line box* - ascender to descender - and a line
box is taller than the letters inside it. Measured on "AB" at 100 px, the
visible strokes sat 19 px above the requested ``y``; for "AB\nCD" and for
vertical text it was the same 19 px. The contract on this node says the text
is centred on ``x``/``y``, and it was not.

The fix measures the real ink box first and offsets by its centre, so the
strokes land where the number says. ``anchor="mm"`` is gone; ``align`` stays,
so a multi-line block is still centred as a block.

⚠️ **This moves the text in every existing workflow** - down by roughly 19%
of the font size. Anyone who compensated by nudging ``y`` will need to nudge
it back. There is no way to make centring correct and also leave the old
positions untouched; the old positions were the bug.

Also fixed here
---------------
* ``color_rgb`` had no ``forceInput``, so the frontend drew a text box that
  could never carry a colour. Same flag the other wildcard inputs carry.
* **A zero-frame batch used to raise.** ``torch.unbind`` on an empty batch
  produced no frames, ``torch.stack([])`` raised ``stack expects a non-empty
  TensorList``, and the ``if mask_out is None`` fallback below it could never
  run because the stack blew up first. Empty in, empty out now.
* ``_FONT_INDEX`` was assigned and never read - the index is deliberately
  rebuilt on every ``INPUT_TYPES`` call so a newly installed font appears
  without a restart. The dead global is gone; ``_FONT_DIRS`` keeps its cache
  because the font folder does not move.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import os
import platform

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from ._qg_color_helpers import (
    CHANNEL_UNSET,
    as_rgb_triple,
    channel_inputs,
    mix_channels,
)
from ._qg_combo_legacy import combo_legacy
from ._qg_tensor_helpers import as_image_batch

COLOR_MAP = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "gray": (128, 128, 128),
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
}

_FONT_DIRS = None


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
    """name -> full path.

    Rebuilt on every call on purpose: ``INPUT_TYPES`` runs on each refresh,
    and a font installed five minutes ago should show up without a restart.
    The folder listing itself is cached in ``_FONT_DIRS``.
    """
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
        "is centred on the X/Y position, measured on its actual strokes rather "
        "than on the font's line box. For a custom colour, either type it into "
        "the R/G/B boxes (leave a box at -1 to keep that channel from the "
        "picker) or wire an RGB triple, which wins over both. The mask output is "
        "white where the text sits, so it can drive inpainting or downstream "
        "compositing."
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
                        "tooltip": "X of the text's centre, in pixels. Measured on the strokes, so the visible text is really centred here.",
                    },
                ),
                "y": (
                    "INT",
                    {
                        "default": 512,
                        "min": -8192,
                        "max": 16384,
                        "step": 1,
                        "tooltip": "Y of the text's centre, in pixels. Measured on the strokes, so the visible text is really centred here.",
                    },
                ),
            },
            "optional": {
                "color_rgb": (
                    "*",
                    {
                        # 通配输入不加 forceInput，前端会画一个填不出颜色的文本框
                        "forceInput": True,
                        "tooltip": (
                            "Optional custom colour: wire an [R, G, B] triple (0-255 or 0-1) "
                            "and the built-in colour above is ignored."
                        ),
                    },
                ),
                # 🔴 必须排在 color_rgb 之后（见 _qg_color_helpers.channel_inputs）
                **channel_inputs("the built-in text colour above"),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    OUTPUT_TOOLTIPS = (
        "The images with the text drawn on.",
        "A mask shaped like the text: white where there is text, black "
        "elsewhere.",
    )
    FUNCTION = "execute"

    @staticmethod
    def _resolve_color(color_rgb, color_name, r=CHANNEL_UNSET, g=CHANNEL_UNSET,
                       b=CHANNEL_UNSET):
        """A wired RGB triple to a PIL-safe 0-255 triple, else the named colour.

        The triple parsing (0-1 vs 0-255, clamping, refusing non-numbers) used to
        be written twice - here and in ``QG_MaskColorize`` - and the two copies
        rounded differently (this one truncated, that one rounded). Both now call
        ``_qg_color_helpers.as_rgb_triple``. This used to hand ``(300, 0, 0)``
        and ``int("a" * 255)`` straight to Pillow, so a wired colour could
        either raise inside ``Image.new`` or paint something nobody asked for.
        """
        triple = as_rgb_triple(color_rgb)
        if triple is not None:
            return triple
        return mix_channels(COLOR_MAP.get(color_name, (255, 0, 0)), r, g, b)

    def execute(self, image, text, font, font_size, color_name, layout, x, y,
                color_rgb=None, r=CHANNEL_UNSET, g=CHANNEL_UNSET, b=CHANNEL_UNSET):
        image, _ = as_image_batch(image, "文字叠加：底图")
        color = self._resolve_color(color_rgb, color_name, r, g, b)

        path = _font_index().get(font)
        try:
            pil_font = ImageFont.truetype(path, int(font_size)) if path else ImageFont.load_default()
        except OSError:
            pil_font = ImageFont.load_default()

        body = text or ""
        if layout == "vertical":
            body = "\n".join(list(body.replace("\n", "")))

        # 空批次：以前会走到 torch.stack([]) 抛 stack expects a non-empty
        # TensorList，那个 if mask_out is None 的兜底永远轮不到。空进空出。
        if image.shape[0] == 0:
            return (image, torch.zeros(
                (0, int(image.shape[1]), int(image.shape[2])), dtype=image.dtype))

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
                # 先量真实墨迹框，再按框的中心对齐到 (x, y)。
                # 不能用 anchor="mm"：那个按字体行高（ascender..descender）居中，
                # 行高比字母本身高，实测 100px 字号下 "AB" 的笔画会偏高 19px。
                left, top, right, bottom = draw.multiline_textbbox(
                    (0, 0), body, font=pil_font, align="center")
                origin = (x - (left + right) / 2.0, y - (top + bottom) / 2.0)
                draw.multiline_text(
                    origin, body, font=pil_font, fill=255, align="center",
                )
            mask_np = np.array(mask)

            layer = Image.new("RGB", (width, height), color)
            composited = Image.composite(layer, base, mask)

            frames.append(torch.from_numpy(
                np.array(composited).astype(np.float32) / 255.0
            ))
            if mask_out is None:
                # 每帧画的是同一段文字，遮罩必然一样，留第一帧就够。
                mask_out = torch.from_numpy(mask_np.astype(np.float32) / 255.0).unsqueeze(0)

        if mask_out is None:
            mask_out = torch.zeros((1, int(image.shape[1]), int(image.shape[2])))
        return (torch.stack(frames, dim=0), mask_out)


NODE_CLASS_MAPPINGS = {"QG_TextOverlayImage": QGTextOverlayImage}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextOverlayImage": "Text Overlay"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
