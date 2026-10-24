# -*- coding: utf-8 -*-
"""QG_SizeSelector - pick a resolution and emit an empty latent.

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

Changes queued for v0.9.4 (not upstream):

  * ``downscale_ratio_spacial`` is now declared on the LATENT output. Core's
    EmptyLatentImage always ships it, and ``comfy.sample.fix_empty_latent_channels``
    only rescales an empty latent when that key is present and disagrees with the
    model. Without it, a 16x model (Qwen Image 2.x, Flux 2 Klein) read our 8x
    latent as-is and produced a picture TWICE the size asked for on the node.
  * ``mp`` (megapixels): pick the area instead of the pixels. The shape comes from
    ``ratio`` (or from the preset), and the size is solved on the exact ratio.
  * Ratio handling is now exact AND on-grid in one pass. Upstream reshaped the
    rectangle and then rounded each side up to ``factor`` separately, which drifts
    the ratio (16:9 at factor 32 came out 1344x768 = 7:4). The new solver walks
    ``w = rx*k, h = ry*k`` over a stride of ``lcm(step/gcd(step,rx),
    step/gcd(step,ry))``, so the ratio stays mathematically exact while both
    sides stay multiples of ``factor`` - no second snapping pass, no drift.

v0.9.4 later revision - ``ratio`` became a real dropdown:

  * ``ratio`` used to be a free-text STRING. It is now a COMBO: "无" /
    "采用比例" / the common ratios. "采用比例" means "use the ratio printed in
    the preset label" - e.g. ``2304x1280 - 16:9`` really is 9:5 in pixels, so
    without this the megapixel / long-edge solvers work off 9:5 instead of the
    16:9 the preset advertises.
  * Free text is not lost: ``ratio_custom`` (last optional) takes any ratio
    string and wins over the dropdown. Older workflows that stored a custom
    ratio in ``ratio`` are migrated by ``web/size_selector/index.js``
    (onConfigure moves the unknown value here), so nothing breaks.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import math
import re

import torch

import comfy.model_management
from ._qg_combo_legacy import combo_legacy

MAX_RESOLUTION = 8192
MIN_RESOLUTION = 64

# Core's EmptyLatentImage reports the same number: our zeros tensor is laid out
# one latent cell per 8 pixels. A model whose latent_format packs pixels
# differently (16x, 32x) is then rescaled for us by fix_empty_latent_channels.
LATENT_SPACIAL_DOWNSCALE = 8

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

# 比例下拉的固定选项。
#   「无」        —— 用预设的原始像素，不做任何比例换算（老语义）
#   「采用比例」  —— 用**预设标签里写的那条比例**。preset 形如 "2304x1280 - 16:9"，
#                    但 2304:1280 实际是 9:5，标签才是作者想要的比例；不选它的话
#                    百万像素 / 长边会按 9:5 算，出来的不是 16:9。
RATIOS = (
    "none",
    "from-preset",
    "1:1",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
    "5:4",
    "4:5",
    "7:4",
    "4:7",
    "2:1",
    "21:9",
)

# preset 末尾的 "- 16:9" / "- 2.39:1"
_PRESET_TAG_RE = re.compile(r"-\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$")


# --------------------------------------------------------------------------
# exact-ratio geometry
#
# w = rx*k and h = ry*k both land on the ``step`` grid exactly when k is a
# multiple of lcm(step/gcd(step,rx), step/gcd(step,ry)). 7:4 at /32 needs
# k=32n (192 -> 1344x768); 16:9 at /32 needs k=32n too, so its width only
# moves in 512px jumps - that coarseness is a property of the grid, not a bug,
# and it is why ``factor`` should be left at 0 when the ratio matters more
# than the grid.
# --------------------------------------------------------------------------

def _gcd(a, b):
    a, b = abs(int(a)), abs(int(b))
    while b:
        a, b = b, a % b
    return a or 1


def _lcm(a, b):
    return (int(a) * int(b)) // _gcd(a, b)


def _ratio_stride(rx, ry, step):
    s = int(step)
    if s <= 1:
        return 1
    return _lcm(s // _gcd(s, rx), s // _gcd(s, ry))


def _simplify_ratio(width, height):
    d = _gcd(width, height)
    return max(1, int(width) // d), max(1, int(height) // d)


def _size_for_axis(rx, ry, axis, target, step):
    """Exact-ratio size nearest ``target`` on the driven axis, or None."""
    k_step = _ratio_stride(rx, ry, step)
    driven = rx if axis == "width" else ry
    lo = math.ceil(max(MIN_RESOLUTION / rx, MIN_RESOLUTION / ry) / k_step) * k_step
    hi = math.floor(min(MAX_RESOLUTION / rx, MAX_RESOLUTION / ry) / k_step) * k_step
    if lo > hi:
        return None
    k = int(round(float(target) / driven / k_step)) * k_step
    k = max(int(lo), min(int(hi), k))
    return rx * k, ry * k


def _size_near(rx, ry, width, height, step):
    """Exact-ratio size nearest a free w x h point, judged by per-side error."""
    candidates = [c for c in (_size_for_axis(rx, ry, "width", width, step),
                              _size_for_axis(rx, ry, "height", height, step)) if c]
    if not candidates:
        return None
    return min(candidates, key=lambda c: abs(c[0] - width) + abs(c[1] - height))


def _size_for_megapixels(rx, ry, target_mp, step):
    """Exact-ratio size whose area is nearest ``target_mp`` million pixels."""
    target_px = max(0.01, float(target_mp)) * 1_000_000.0
    ideal = math.sqrt(target_px * rx / ry)
    k_step = _ratio_stride(rx, ry, step)
    span = max(k_step, step)
    candidates = [c for c in (_size_for_axis(rx, ry, "width", ideal + d, step)
                              for d in (-span, 0, span)) if c]
    if not candidates:
        return None
    return min(candidates, key=lambda c: abs(c[0] * c[1] - target_px))


@combo_legacy("QG_SizeSelector")
class QGSizeSelector:
    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Builds an empty latent from a preset resolution and returns its width "
        "and height as integers. Optional width/height inputs override the "
        "preset, a ratio string (16:9, 2.39:1, ...) reshapes it, long_edge sets "
        "the long side while keeping the ratio, mp (megapixels) picks the area "
        "instead of the pixels, frames > 0 produces a video latent, and factor "
        "rounds dimensions up while keeping the ratio exact - the ratio is "
        "solved as w = rx*k, h = ry*k so it never drifts. latent_channels is 4 "
        "for SD 1.5 / SDXL and 16 for Flux / SD3 / video; the latent also "
        "declares its 8x downsample so a 16x model gets rescaled by the sampler."
    )
    SEARCH_ALIASES = [
        "size", "resolution", "latent", "aspect ratio", "megapixel", "mp",
        "尺寸", "分辨率", "比例", "百万像素", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, ratio=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (
                    list(PRESETS),
                    {
                        "default": "832x1216 - 2:3",
                        "tooltip": (
                            "Preset resolutions and aspect ratios. With ratio set to none you get "
                            "the preset's raw pixels, with from-preset you get the ratio printed in "
                            "its label."
                        ),
                    },
                ),
                "batch_size": (
                    "INT",
                    {"default": 1, "min": 1, "max": 4096, "tooltip": "Batch size."},
                ),
                "long_edge": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_RESOLUTION,
                        "step": 8,
                        "tooltip": "Long-edge pixels. 0 uses the preset's own size; any other value scales the long "
                                   "edge to it while keeping the aspect ratio.",
                    },
                ),
                "ratio": (
                    list(RATIOS),
                    {
                        "default": "none",
                        "tooltip": (
                            "Overrides the aspect ratio. none uses the preset's raw pixels; from-preset "
                            "uses the ratio printed in the preset's label, so 2304x1280 "
                            "labelled 16:9 is really 9:5; you can also pick a fixed ratio "
                            "directly. For an arbitrary ratio use the custom ratio below."
                        ),
                    },
                ),
                "frames": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1024,
                        "tooltip": "Frame count. 0 is an image model with no time axis, anything above 0 is a video model.",
                    },
                ),
                "factor": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 64,
                        "step": 1,
                        "tooltip": (
                            "Snaps width and height to a multiple of this number while keeping "
                            "the aspect ratio. 0 adds no snapping, though solving the ratio "
                            "still holds a multiple of 8, which is how latents unfold. The "
                            "coarser the snap, the further apart the sizes a ratio can reach: "
                            "at 32 a 16:9 frame moves in width steps of 512. Leave 0 when the "
                            "ratio matters."
                        ),
                    },
                ),
                "latent_channels": (
                    ["4", "16"],
                    {
                        "default": "4",
                        "tooltip": "Latent channels: 4 for SD 1.5 and SDXL, 16 for Flux, SD3 and video models.",
                    },
                ),
            },
            "optional": {
                "width": (
                    "*",
                    {"tooltip": "Optional width override of any type, parsed as a number. Wired in and above 0, "
                                "it takes priority over the preset."},
                ),
                "height": (
                    "*",
                    {"tooltip": "Optional height override of any type, parsed as a number."},
                ),
                # 必须排在 optional 末尾：LiteGraph 按位置还原 widgets_values，
                # 插在中间会让老存档整体错位。
                "mp": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 64.0,
                        "step": 0.25,
                        "round": 0.01,
                        "tooltip": (
                            "Megapixels: 0 means unused. Given a value, the size comes from "
                            "this area while the shape still follows the ratio or the preset, "
                            "for example 1.0 or 2.0."
                        ),
                    },
                ),
                # 同样必须排在最后：老存档只有 8 个 widget 值，
                # 这一格缺席时取默认空串，前面一个都不会错位。
                "ratio_custom": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": (
                            "Custom aspect ratio such as 2.39:1, 5 4 or 1.85. Filled in, it "
                            "wins over the ratio dropdown above; empty means the dropdown "
                            "decides."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("LATENT", "WIDTH", "HEIGHT", "FRAMES")
    OUTPUT_TOOLTIPS = (
        "The empty latent tensor.",
        "The width actually used.",
        "The height actually used.",
        "The frame count actually used (0 = image model).",
    )
    FUNCTION = "execute"

    def __init__(self):
        self._device = comfy.model_management.intermediate_device()

    @staticmethod
    def _parse_ratio(ratio_str):
        if not ratio_str or ratio_str == "none":
            return None
        cleaned = re.sub(r"[\s/\\]", ":", ratio_str)
        numbers = re.findall(r"\d*\.?\d+", cleaned)
        if len(numbers) >= 2:
            try:
                rx, ry = float(numbers[0]), float(numbers[1])
            except ValueError:
                return None
            if rx <= 0 or ry <= 0:
                return None
            return rx, ry
        return None

    @staticmethod
    def _ratio_from_preset(preset, base_w, base_h):
        """预设标签里的比例："2304x1280 - 16:9" -> (16.0, 9.0)。

        标签才是作者想要的比例；像素比只是取整后的近似
        （2304:1280 = 9:5，标的是 16:9）。
        """
        m = _PRESET_TAG_RE.search(preset or "")
        if m:
            rx, ry = float(m.group(1)), float(m.group(2))
            if rx > 0 and ry > 0:
                return rx, ry
        return _simplify_ratio(base_w, base_h)

    def _resolve_ratio(self, ratio, ratio_custom, preset, base_w, base_h):
        """自定义比例 > 下拉（含「采用比例」）> 不覆盖。"""
        custom = str(ratio_custom or "").strip()
        if custom and custom != "none":
            parsed = self._parse_ratio(custom)
            if parsed:
                return parsed
        if ratio == "from-preset":
            return self._ratio_from_preset(preset, base_w, base_h)
        return self._parse_ratio(ratio)

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

    @staticmethod
    def _clamp(width, height):
        return (max(MIN_RESOLUTION, min(MAX_RESOLUTION, int(width))),
                max(MIN_RESOLUTION, min(MAX_RESOLUTION, int(height))))

    def execute(self, preset, batch_size, long_edge, ratio, frames, factor,
                latent_channels, width=0, height=0, mp=0.0, ratio_custom=""):
        width_num = self._parse_num(width)
        height_num = self._parse_num(height)
        # 求解路径（比例 / 百万像素 / 长边）的网格步长。
        #
        # 至少 8：latent 是按 ``out_w // 8`` 展开的，非 8 的倍数会被截断 ——
        # from-preset 在 factor=0 时曾算出 810x1215，节点报的高度是 1215，
        # 实际张量只有 1216-8=1208 那一档，数值对不上图。
        #
        # 只影响求解路径：手填 width/height 覆盖、以及 preset 原样两条老路径
        # 仍然按 factor 走（factor=0 即完全不贴），不动存量行为。
        step = max(int(factor), LATENT_SPACIAL_DOWNSCALE)

        base_w, base_h = (int(v) for v in preset.split(" ")[0].split("x"))
        ratio_value = self._resolve_ratio(ratio, ratio_custom, preset, base_w, base_h)

        try:
            megapixels = max(0.0, float(mp or 0.0))
        except (TypeError, ValueError):
            megapixels = 0.0

        solved = None
        explicit = False

        if width_num > 0 and height_num > 0:
            # Explicit pixel overrides win over everything, like upstream.
            explicit = True
            out_w = self._adjust_to_factor(width_num, factor)
            out_h = self._adjust_to_factor(height_num, factor)
        elif megapixels > 0:
            # Area first: shape from the ratio override, else from the preset.
            rx, ry = ratio_value if ratio_value else _simplify_ratio(base_w, base_h)
            solved = _size_for_megapixels(rx, ry, megapixels, step)
        elif ratio_value:
            rx, ry = ratio_value
            if long_edge > 0:
                axis = "width" if rx >= ry else "height"
                solved = _size_for_axis(rx, ry, axis, long_edge, step)
            else:
                solved = _size_near(rx, ry, base_w, base_h, step)
        elif long_edge > 0:
            rx, ry = _simplify_ratio(base_w, base_h)
            axis = "width" if base_w >= base_h else "height"
            solved = _size_for_axis(rx, ry, axis, long_edge, step)
        else:
            out_w = self._adjust_to_factor(base_w, factor)
            out_h = self._adjust_to_factor(base_h, factor)

        if solved is not None:
            out_w, out_h = solved
        elif not explicit and (megapixels > 0 or ratio_value or long_edge > 0):
            # Every exact-ratio solver refused (extreme ratio or far too coarse
            # a grid). Fall back to the legacy path rather than raising.
            out_w, out_h = self._legacy_shape(base_w, base_h, ratio_value, long_edge, factor)

        out_w, out_h = self._clamp(out_w, out_h)

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

        return (
            {
                "samples": samples,
                "downscale_ratio_spacial": LATENT_SPACIAL_DOWNSCALE,
            },
            out_w,
            out_h,
            frames,
        )

    @staticmethod
    def _legacy_shape(base_w, base_h, ratio_value, long_edge, factor):
        """Upstream's reshape-then-round-up, kept only as a last-resort fallback."""
        out_w, out_h = base_w, base_h
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
            if out_w >= out_h:
                out_h = int(round(out_h * long_edge / out_w))
                out_w = long_edge
            else:
                out_w = int(round(out_w * long_edge / out_h))
                out_h = long_edge

        out_w = min(out_w, MAX_RESOLUTION)
        out_h = min(out_h, MAX_RESOLUTION)
        # 同 execute()：兜底路径也至少贴到 8，否则 latent 会截断。
        align = max(int(factor), LATENT_SPACIAL_DOWNSCALE)
        out_w = ((int(out_w) + align - 1) // align) * align
        out_h = ((int(out_h) + align - 1) // align) * align
        return out_w, out_h


NODE_CLASS_MAPPINGS = {"QG_SizeSelector": QGSizeSelector}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_SizeSelector": "Size Selector"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
