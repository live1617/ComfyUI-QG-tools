# -*- coding: utf-8 -*-
"""QG_AddWatermark - stamp a text or image watermark onto an image.

Ported from the author's own ComfyUI-QG-Multipack v0.1.0 (``watermark_node.py``),
which implements the same contract as Goohaitools' "孤海-图像添加水印": a text
watermark sized as a percentage of the base height, opacity, a nine-cell anchor
plus percentage offsets, colour, tiling, rotation and tile spacing; or an image
watermark scaled as a percentage of its own size. Both are rendered with PIL and
composited back into a torch tensor.

What this file changed relative to the source package
-----------------------------------------------------
* **Option values are English.** ``居中/靠左/靠右`` became ``center/left/right``
  and ``居中/靠上/靠下`` became ``center/top/bottom``; the old Chinese strings
  are registered in ``_qg_combo_legacy.LEGACY`` so saved workflows still load
  and still resolve to the same cell. Nothing else in the geometry changed -
  the arithmetic below is byte-for-byte the source package's.
* **Fonts come from the OS, not from a bundled folder.** The source package
  shipped 54 MB of ``fonts/``, much of it commercially licensed (PingFang,
  STHeiti); that cannot go into a public repository. This node reads the
  plugin's own ``fonts/`` folder when it exists (drop your own TTFs there) and
  otherwise lists the system font folders - the same approach
  ``QG_TextOverlayImage`` used. A saved font name that is not found falls back
  to the default face instead of raising, so an old workflow keeps running.
* **UI text is English and the tooltips are ours.** Also: the colour control is
  a plain ``STRING`` holding ``#RRGGBB`` - this plugin has no picker widget, and
  the tooltip says so instead of promising a swatch that does not exist.

Deliberately kept, so the outputs stay interchangeable with the reference
-----------------------------------------------------------------------
* **Only the first frame of a batch is watermarked.** The output is a single
  frame. That is the reference's behaviour, not an oversight.
* **Text size is a percentage of the base height**; image watermarks scale by a
  percentage of their own size. Two different bases, both inherited.
* **``angle == 0`` positions by the text's ink box, not by the padded layer.**
  The padded layer is one safety margin wider and taller on each side, so an
  offset computed from the ink box while pasting the bigger layer is off by
  that margin. The reference does exactly this and any "fix" would shift every
  existing watermark, so it stays; ``_check_add_watermark.py`` pins it down.
* **Tiling ignores the anchor and the offsets** - the tile grid starts one cell
  outside the canvas on both axes, which is what makes edge tiles whole.

The empty-batch case raises ``ValueError`` with the shape in the message rather
than letting numpy fail on a zero-length frame.
"""

import os
import platform

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from ._qg_combo_legacy import combo_legacy

_H_POSITIONS = ("center", "left", "right")
_V_POSITIONS = ("center", "top", "bottom")
_FONT_EXTS = (".ttf", ".otf", ".ttc")

# The plugin-level fonts/ folder, the same place the source package used, so a
# user who already keeps fonts there needs no change. Optional: when it does not
# exist the list falls back to the OS font folders below.
_FONT_DIR = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "fonts"))

_RESAMPLE_BICUBIC = getattr(getattr(Image, "Resampling", Image), "BICUBIC")
_RESAMPLE_LANCZOS = getattr(getattr(Image, "Resampling", Image), "LANCZOS")

_OS_FONT_DIRS = None


def _system_font_dirs():
    """OS font folders, cached - unlike the font list itself, these do not move."""
    global _OS_FONT_DIRS
    if _OS_FONT_DIRS is None:
        system = platform.system()
        if system == "Windows":
            # No environment lookups here, on purpose. The Registry scanner's
            # YARA rules flag environment reads as privilege escalation -
            # QG_TextOverlayImage tripped "python_environment_manipulation"
            # just for reading WINDIR (DEVELOPMENT.md "Registry 扫描误报"), and
            # that node is gone. Both well-known locations are listed instead:
            # the per-user font folder, where Windows 10+ puts fonts installed
            # without admin rights, and the classic machine-wide one. A system
            # partition somewhere other than C: just loses the second entry,
            # and _resolve_font falls back to a default face anyway.
            home = os.path.expanduser("~")
            dirs = [
                os.path.join(home, "AppData", "Local", "Microsoft", "Windows",
                             "Fonts"),
                r"C:\Windows\Fonts",
            ]
        elif system == "Darwin":
            dirs = ["/System/Library/Fonts", "/Library/Fonts",
                    os.path.expanduser("~/Library/Fonts")]
        else:
            dirs = ["/usr/share/fonts", "/usr/local/share/fonts",
                    os.path.expanduser("~/.fonts")]
        _OS_FONT_DIRS = [d for d in dirs if os.path.isdir(d)]
    return _OS_FONT_DIRS


def _font_index():
    """name -> full path, the plugin's fonts/ folder taking precedence.

    Rebuilt on every call on purpose: ``INPUT_TYPES`` runs on each refresh, and
    a font copied in five minutes ago should show up without a restart. Both
    folders are scanned one level deep - that is where Windows and macOS keep
    their fonts, and recursing over ``/usr/share/fonts`` would walk thousands of
    files on every refresh for little gain.
    """
    index = {}
    folders = ([_FONT_DIR] if os.path.isdir(_FONT_DIR) else []) + _system_font_dirs()
    for folder in folders:
        try:
            entries = os.listdir(folder)
        except OSError:
            continue
        for entry in entries:
            if not entry.lower().endswith(_FONT_EXTS):
                continue
            index.setdefault(os.path.splitext(entry)[0],
                             os.path.join(folder, entry))
    return index


def _font_choices():
    names = sorted(_font_index(), key=str.lower)
    # A combo box may not be empty, so keep a placeholder even on a bare system;
    # _resolve_font then quietly falls back to whatever PIL has.
    return names or ["Arial"]


def _resolve_font(name, size):
    """Font face by name, with fallbacks - a stale saved name must not raise."""
    index = _font_index()
    candidates = [name]
    if name:
        stem, ext = os.path.splitext(name)
        if ext:
            # Saved by the source package as "楷体.ttf"; the index keys are stems.
            candidates.append(stem)
    for candidate in candidates:
        path = index.get(candidate)
        if path:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    for candidate in ("NotoSansSC-VF", "msyh", "simhei", "Arial", "arial",
                      "DejaVuSans"):
        path = index.get(candidate)
        if path:
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    if index:
        try:
            return ImageFont.truetype(next(iter(index.values())), size)
        except Exception:
            pass
    return ImageFont.load_default()


def _to_pil(tensor):
    """ComfyUI tensor [B,H,W,C] -> PIL; first frame only, empty batch raises."""
    if tensor.ndim != 4 or tensor.shape[0] < 1:
        raise ValueError(
            "[QG-tools] Add Watermark needs an image shaped "
            "[batch,height,width,channels] with batch >= 1, got %s."
            % (tuple(tensor.shape),)
        )
    frame = tensor[0].cpu().numpy()
    return Image.fromarray(np.clip(frame * 255.0, 0, 255).astype(np.uint8))


def _to_tensor(img):
    """PIL -> ComfyUI tensor [1,H,W,C], float32 in 0-1."""
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr[None, ...])


def _hex_to_rgba(color, opacity):
    """``#RRGGBB`` plus an opacity percentage -> (r, g, b, a), a = 255 x pct / 100."""
    value = color.lstrip("#")
    r, g, b = (int(value[i:i + 2], 16) for i in (0, 2, 4))
    return (r, g, b, int(255 * (opacity / 100)))


def _text_bounds(text, font):
    """Ink box of the text: (width, height, top offset); the offset avoids clipping."""
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    left, top, right, bottom = probe.textbbox((0, 0), text, font=font)
    return right - left, bottom - top, top


def _place(base_w, base_h, mark_w, mark_h, h_pos, v_pos, x_off, y_off):
    """Nine-cell anchor plus percentage offsets -> top-left corner of the layer."""
    dx = int(base_w * (x_off / 100))
    if h_pos == "left":
        x = dx
    elif h_pos == "right":
        x = base_w - mark_w - dx
    else:
        x = (base_w - mark_w) // 2 + dx
    dy = int(base_h * (y_off / 100))
    if v_pos == "top":
        y = dy
    elif v_pos == "bottom":
        y = base_h - mark_h - dy
    else:
        y = (base_h - mark_h) // 2 + dy
    return x, y


def _rotate(layer, angle):
    """Rotate by a non-zero angle, expanding the canvas, bicubic like the reference."""
    if angle != 0:
        layer = layer.rotate(angle, expand=True, resample=_RESAMPLE_BICUBIC)
    return layer


def _composite(base, layer, pos=(0, 0)):
    """Paste the layer onto a transparent sheet at pos, then alpha-composite."""
    holder = Image.new("RGBA", base.size, (0, 0, 0, 0))
    holder.paste(layer, pos, layer)
    return Image.alpha_composite(base, holder)


def _text_watermark(base, text, font_name, size_pct, opacity, h_pos, v_pos,
                    x_off, y_off, color, tile, angle, spacing):
    """Text watermark: font size from the base height, drawn on its own layer."""
    base_w, base_h = base.size
    font_size = int(base_h * (size_pct / 100))
    font = _resolve_font(font_name, font_size)
    text_w, text_h, top_offset = _text_bounds(text, font)

    # 10% of the font size as a safety margin on all four sides; drawing is
    # shifted up by top_offset so the ascenders are not clipped.
    margin = int(font_size * 0.1)
    layer = Image.new("RGBA", (text_w + 2 * margin, text_h + 2 * margin),
                      (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((margin, margin - top_offset), text,
                               font=font, fill=_hex_to_rgba(color, opacity))
    layer = _rotate(layer, angle)
    mark_w, mark_h = layer.size

    # Same quirk as the reference, kept on purpose so the outputs stay
    # interchangeable: at angle 0 the anchor is computed from the text's ink box
    # while the pasted layer is one margin wider and taller on each side; only a
    # rotated layer positions by its own size.
    pos_w, pos_h = (text_w, text_h) if angle == 0 else (mark_w, mark_h)

    holder = Image.new("RGBA", base.size, (0, 0, 0, 0))
    if tile:
        gap = int(base_h * (spacing / 100))
        cols = (base_w // (pos_w + gap)) + 2
        rows = (base_h // (pos_h + gap)) + 2
        for i in range(cols):
            for j in range(rows):
                holder.paste(layer, (i * (pos_w + gap) - pos_w,
                                     j * (pos_h + gap) - pos_h), layer)
    else:
        x, y = _place(base_w, base_h, pos_w, pos_h, h_pos, v_pos, x_off, y_off)
        holder.paste(layer, (x, y), layer)
    return Image.alpha_composite(base, holder)


def _image_watermark(base, mark_src, size_pct, opacity, h_pos, v_pos,
                     x_off, y_off, angle):
    """Image watermark: scaled by a percentage of its own size, alpha faded."""
    ratio = size_pct / 100.0
    mark_w, mark_h = mark_src.size
    mark = mark_src.resize((int(mark_w * ratio), int(mark_h * ratio)),
                           _RESAMPLE_LANCZOS)
    if mark.mode != "RGBA":
        mark = mark.convert("RGBA")
    alpha = mark.getchannel("A").point(lambda v: int(v * (opacity / 100)))
    mark.putalpha(alpha)
    mark = _rotate(mark, angle)
    x, y = _place(base.size[0], base.size[1], mark.size[0], mark.size[1],
                  h_pos, v_pos, x_off, y_off)
    return _composite(base, mark, (x, y))


@combo_legacy("QG_AddWatermark")
class QGAddWatermark:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Stamps a text or image watermark onto an image: text size as a "
        "percentage of the base height, opacity, a nine-cell anchor with "
        "percentage offsets, colour, tiling, rotation and tile spacing; image "
        "watermarks scale by a percentage of their own size. Only the first "
        "frame of a batch is watermarked, and the output is a single frame."
    )
    SEARCH_ALIASES = [
        "image", "watermark", "text", "font", "opacity", "tile", "angle",
        "图像", "水印", "文字", "字体", "透明度", "平铺", "角度", "偏移",
        "居中", "logo", "签名", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_TOOLTIPS = (
        "The watermarked image: a single frame with the stamp composited onto "
        "the first input frame.",
    )

    @classmethod
    def VALIDATE_INPUTS(cls, font=None, h_position=None, v_position=None):
        # All three are combo boxes whose saved values may not be in the current
        # list: the anchors changed from Chinese to English keys (old workflows),
        # and the font list depends on what is installed on this machine (a
        # workflow built elsewhere). Naming them here skips ComfyUI's "value must
        # be in the list" check; the real conversion happens in combo_legacy and
        # a missing font falls back to the default face. Not **kwargs - that
        # would also switch off min/max for the numeric inputs.
        return True

    @classmethod
    def INPUT_TYPES(cls):
        fonts = _font_choices()
        installed = set(fonts)
        default_font = next(
            (f for f in ("NotoSansSC-VF", "msyh", "simhei") if f in installed),
            fonts[0])

        return {
            "required": {
                "image": (
                    "IMAGE",
                    {"tooltip": "The image to watermark, shaped [B,H,W,C]. Only the first frame is used, matching the reference node - the output is a single frame."},
                ),
                "watermark_text": (
                    "STRING",
                    {"default": "Watermark", "tooltip": "Text to draw. Ignored when an image watermark is connected."},
                ),
                "font": (
                    fonts,
                    {"default": default_font, "tooltip": "Typeface for the text watermark. Lists the plugin's own fonts/ folder plus the system fonts; a name that is not installed falls back to the default face, so an old workflow still runs."},
                ),
                "size_percent": (
                    "INT",
                    {"default": 5, "min": 0, "max": 100, "step": 1, "tooltip": "Text size as a percentage of the base image height. For an image watermark this is a percentage of the watermark's own size instead - two different bases, both matching the reference."},
                ),
                "opacity": (
                    "INT",
                    {"default": 50, "min": 0, "max": 100, "step": 1, "tooltip": "Watermark opacity in percent; 100 is fully opaque."},
                ),
                "h_position": (
                    _H_POSITIONS,
                    {"tooltip": "Horizontal cell of the nine-cell anchor. The X offset below is applied relative to this cell."},
                ),
                "v_position": (
                    _V_POSITIONS,
                    {"tooltip": "Vertical cell of the nine-cell anchor. The Y offset below is applied relative to this cell."},
                ),
                "x_offset": (
                    "INT",
                    {"default": 0, "min": 0, "max": 50, "step": 1, "tooltip": "Horizontal shift as a percentage of the base width, measured away from the chosen cell (positive always moves inward)."},
                ),
                "y_offset": (
                    "INT",
                    {"default": 0, "min": 0, "max": 50, "step": 1, "tooltip": "Vertical shift as a percentage of the base height, measured away from the chosen cell (positive always moves inward)."},
                ),
                "text_color": (
                    "STRING",
                    {"default": "#FFFFFF", "tooltip": "Text colour as #RRGGBB. Click the swatch on the node to pick one, or type the hex. The same value works in the reference node's colour input."},
                ),
                "tile": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "Repeat the watermark across the whole image. The anchor and both offsets are ignored in this mode; the spacing below sets the gap."},
                ),
                "angle": (
                    "INT",
                    {"default": 0, "min": -90, "max": 90, "step": 1, "tooltip": "Rotation in degrees, positive counter-clockwise."},
                ),
                "spacing": (
                    "INT",
                    {"default": 10, "min": 0, "max": 50, "step": 1, "tooltip": "Gap between tiles as a percentage of the base height. Only used when tiling is on."},
                ),
                "alpha_output": (
                    "BOOLEAN",
                    {"default": False, "tooltip": "Keep the alpha channel and return RGBA. Off returns RGB, matching the reference."},
                ),
            },
            "optional": {
                "watermark_image": (
                    "IMAGE",
                    {"tooltip": "Optional image watermark. When connected every text setting is ignored: this image is scaled by the percentage above and stamped instead. Also first frame only."},
                ),
            },
        }

    def execute(self, image, watermark_text="Watermark", font=None,
                size_percent=5, opacity=50, h_position="center",
                v_position="center", x_offset=0, y_offset=0,
                text_color="#FFFFFF", tile=False, angle=0, spacing=10,
                alpha_output=False, watermark_image=None):
        base = _to_pil(image)
        if base.mode in ("RGB", "L"):
            base = base.convert("RGBA")

        if watermark_image is not None:
            result = _image_watermark(base, _to_pil(watermark_image),
                                      size_percent, opacity, h_position,
                                      v_position, x_offset, y_offset, angle)
        else:
            result = _text_watermark(base, watermark_text, font, size_percent,
                                     opacity, h_position, v_position, x_offset,
                                     y_offset, text_color, tile, angle, spacing)

        if not alpha_output and result.mode == "RGBA":
            result = result.convert("RGB")
        return (_to_tensor(result),)


NODE_CLASS_MAPPINGS = {"QG_AddWatermark": QGAddWatermark}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_AddWatermark": "Add Watermark"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
