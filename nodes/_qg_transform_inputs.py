"""Stable V1 widget definitions shared by the three Crop + Rotate + Pad nodes."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ._qg_execution_helpers import warn_once
from ._qg_transform_engine import TransformSpec


ASPECT_RATIOS = ["free", "source", "1:1", "9:16", "16:9", "2:3", "3:2", "3:4", "4:3", "9:21", "21:9"]

# Optional user presets: copy qg_presets_example.json (repo root) to
# qg_presets.json (gitignored) and edit. Read fresh at INPUT_TYPES time,
# so a browser reload picks up edits. Any problem warns once (ASCII) and
# falls back to the built-in list - never breaks node registration.
PRESETS_PATH = Path(__file__).resolve().parent.parent / "qg_presets.json"

_RATIO_PATTERN = re.compile(r"^[1-9]\d*:[1-9]\d*$")
# Preset warnings quote what the user wrote, so the set is capped at this
# many notes rather than kept for the whole session.
_warned_presets: set[str] = set()
_PRESET_WARNING_LIMIT = 64


def load_custom_aspect_ratios(path: Path | None = None) -> list[str]:
    """Extra crop_aspect_ratio entries from the optional presets file."""
    path = PRESETS_PATH if path is None else Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        warn_once(
            f"Presets: could not read {path.name}: {exc}",
            _warned_presets, limit=_PRESET_WARNING_LIMIT,
        )
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        warn_once(
            f"Presets: {path.name} is not valid JSON ({exc}); using built-in aspect ratios.",
            _warned_presets, limit=_PRESET_WARNING_LIMIT,
        )
        return []
    entries = data.get("crop_aspect_ratios") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        warn_once(
            f"Presets: {path.name} needs a crop_aspect_ratios list; using built-in aspect ratios.",
            _warned_presets, limit=_PRESET_WARNING_LIMIT,
        )
        return []
    valid: list[str] = []
    skipped: list[str] = []
    for entry in entries:
        candidate = str(entry).strip()
        if _RATIO_PATTERN.match(candidate) or candidate in ("free", "source"):
            if candidate not in valid:
                valid.append(candidate)
        else:
            skipped.append(candidate)
    if skipped:
        safe = ", ".join(item.encode("ascii", "backslashreplace").decode("ascii") for item in skipped)
        warn_once(
            f"Presets: skipped entries that are not W:H integer pairs: {safe}",
            _warned_presets, limit=_PRESET_WARNING_LIMIT,
        )
    return valid


class AspectRatioChoices(list):
    """The crop_aspect_ratio choices: built-in ratios plus this machine's presets.

    ComfyUI checks a list input with ``in`` before a run. A workflow made on
    a machine with other presets can carry a ratio missing here, and the
    transform draws any whole-number W:H, so any such ratio counts as a
    member. Everything else is still refused before the run.
    """

    def __contains__(self, value) -> bool:
        if list.__contains__(self, value):
            return True
        return isinstance(value, str) and _RATIO_PATTERN.match(value.strip()) is not None


def aspect_ratio_options(path: Path | None = None) -> list[str]:
    """Built-in ratios extended with any user presets, order preserved."""
    options = list(ASPECT_RATIOS)
    for entry in load_custom_aspect_ratios(path):
        if entry not in options:
            options.append(entry)
    return AspectRatioChoices(options)


def transform_inputs(*, feather: int = 24, fill_color: str = "#808080") -> dict[str, tuple]:
    """The shared rotate/crop/pad widgets. ``feather`` and ``fill_color`` are
    the defaults a fresh node starts with: the image nodes keep the soft grey
    canvas inpaint models like, the clip node asks for black and a hard edge.
    """
    return {
        "rotation_degrees": (
            "FLOAT",
            {
                "default": 0.0,
                "min": -180.0,
                "max": 180.0,
                "step": 0.1,
                "tooltip": "Clockwise rotation applied before crop and padding.",
            },
        ),
        "crop_aspect_ratio": (
            aspect_ratio_options(),
            {"default": "free", "tooltip": "Locks crop handles to a ratio; free allows any rectangle."},
        ),
        "crop_x": (
            "INT",
            {"default": 0, "min": 0, "max": 65536, "step": 1, "tooltip": "Left edge of the crop in pixels, measured on the rotated image."},
        ),
        "crop_y": (
            "INT",
            {"default": 0, "min": 0, "max": 65536, "step": 1, "tooltip": "Top edge of the crop in pixels, measured on the rotated image."},
        ),
        "crop_width": (
            "INT",
            {"default": 0, "min": 0, "max": 65536, "step": 1, "tooltip": "0 keeps the full available width."},
        ),
        "crop_height": (
            "INT",
            {"default": 0, "min": 0, "max": 65536, "step": 1, "tooltip": "0 keeps the full available height."},
        ),
        "pad_left": (
            "INT",
            {"default": 0, "min": 0, "max": 32768, "step": 1, "tooltip": "Fill-color pixels added on the left; padding lands in the output mask."},
        ),
        "pad_top": (
            "INT",
            {"default": 0, "min": 0, "max": 32768, "step": 1, "tooltip": "Fill-color pixels added on top; padding lands in the output mask."},
        ),
        "pad_right": (
            "INT",
            {"default": 0, "min": 0, "max": 32768, "step": 1, "tooltip": "Fill-color pixels added on the right; padding lands in the output mask."},
        ),
        "pad_bottom": (
            "INT",
            {"default": 0, "min": 0, "max": 32768, "step": 1, "tooltip": "Fill-color pixels added on the bottom; padding lands in the output mask."},
        ),
        "feather": (
            "INT",
            {
                "default": int(feather),
                "min": 0,
                "max": 4096,
                "step": 1,
                "tooltip": "Feathers the mask into kept pixels; the image keeps a hard edge against the fill.",
            },
        ),
        "canvas_multiple": (
            "INT",
            {
                "default": 1,
                "min": 1,
                "max": 4096,
                "step": 1,
                "tooltip": (
                    "Makes the width and height divide evenly by this number: "
                    "padding grows by a few pixels, and a side with no padding is "
                    "trimmed by a few instead. Some models need sizes divisible "
                    "by 8, 16 or 32; 1 = off."
                ),
            },
        ),
        "fill_color": (
            "STRING",
            {
                "default": str(fill_color),
                "tooltip": (
                    "Color for rotation voids and padding; accepts #RGB/#RRGGBB hex, "
                    "R, G, B (0-255 or 0..1 floats), one grayscale number, or a CSS "
                    "color name. Unparseable values fall back to mid-gray."
                ),
            },
        ),
    }


# Every transform node, appended after its other widgets: resize the
# transformed output to a pixel budget, core ImageScaleToTotalPixels-style.
RESIZE_METHODS = ["lanczos", "area", "bicubic", "bilinear", "nearest-exact"]


def resize_inputs() -> dict[str, tuple]:
    return {
        "resize_to_megapixels": (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": "Resize the output to the megapixel budget below, aspect preserved.",
            },
        ),
        "megapixels": (
            "FLOAT",
            {
                "default": 1.0,
                "min": 0.01,
                "max": 16.0,
                "step": 0.01,
                "tooltip": (
                    "Output pixel budget in megapixels (x 1024x1024, matching "
                    "the core Scale Image to Total Pixels node)."
                ),
            },
        ),
        "resize_method": (
            RESIZE_METHODS,
            {
                "default": "lanczos",
                "tooltip": "Sampling filter for the resize; lanczos is the sharp default.",
            },
        ),
        "resolution_steps": (
            "INT",
            {
                "default": 1,
                "min": 1,
                "max": 256,
                "tooltip": (
                    "Rounds each resized dimension to a multiple of this - "
                    "8 or 64 keeps VAE-friendly sizes."
                ),
            },
        ),
    }


def spec_from_values(**values) -> TransformSpec:
    names = TransformSpec.__dataclass_fields__.keys()
    return TransformSpec(**{name: values[name] for name in names if name in values}).normalized()

