# -*- coding: utf-8 -*-
"""QG_RatioResolution - work out an output size from a ratio and a mode.

1:1 of the author's own QG-Multipack plugin (``ratio_resolution_node.py``),
2026-11-08, with the interface anglicised for this pack. What changes on the way
in is only naming, never the arithmetic:

* widget names 比例 / 模式 / 固定边像素 … become ratio / mode / fixed_edge …;
* the two dropdowns' *values* were Chinese (原始比例, 固定长边 …) so they could
  not ship as-is. They are English keys now (``original``, ``long-side`` …) and
  the old strings are registered in ``_qg_combo_legacy.LEGACY``, which migrates
  saved workflows in the frontend and again in ``combo_legacy`` before running;
* output slots were 比例 / 宽度 / 高度, now ``ratio`` / ``width`` / ``height``.

Execution semantics match the reference node (Goohaitools' 比例与分辨率) line by
line, including the parts that look wrong:

* ``original`` reads the optional image (1:1 when it is missing or unreadable);
* ``custom`` uses the two custom widgets; ``original`` prints the reduced ratio
  (gcd), every other ratio echoes its own dropdown label;
* six modes: long side / short side / width / height (all from ``fixed_edge``),
  total pixels (megapixels x 1024², same as ComfyUI's official Resolution
  Selector), long-side range (clamps the incoming image's long edge into
  [min, max], swapping them when reversed; 1536 when there is no image);
  an unknown mode falls back to long side;
* ``multiple`` rounds each side to the nearest multiple, never below one
  multiple, and ``multiple <= 0`` just rounds to an integer.

The frontend (``web/ratio_resolution/index.js``) hides the widgets a mode does
not use, previews the width / height in cyan next to their output slots, and
writes the real numbers back after a run. That ``ui.ratio_resolution`` payload
below is what it reads.
"""

import math

from comfy_api.latest import io

from ._qg_combo_legacy import coerce

RATIO_OPTIONS = [
    "original",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "5:7",
    "9:16",
    "16:9",
    "21:9",
    "1:2",
    "2:1",
    "custom",
]

MODE_OPTIONS = [
    "long-side",
    "short-side",
    "width",
    "height",
    "total-pixels",
    "long-side-range",
]

RATIO_VALUES = {
    "1:1": (1.0, 1.0),
    "2:3": (2.0, 3.0),
    "3:2": (3.0, 2.0),
    "3:4": (3.0, 4.0),
    "4:3": (4.0, 3.0),
    "5:7": (5.0, 7.0),
    "9:16": (9.0, 16.0),
    "16:9": (16.0, 9.0),
    "21:9": (21.0, 9.0),
    "1:2": (1.0, 2.0),
    "2:1": (2.0, 1.0),
}


# V1 @combo_legacy("QG_RatioResolution")：ratio/mode 有中文遗留值需 coerce。
# V3 去装饰器，execute 开头 coerce，与 V1 等价。
class QGRatioResolution(io.ComfyNode):
    """Work out the width / height for a target ratio."""

    DESCRIPTION = (
        "Work out a width and height pair from a ratio and a mode: long side, "
        "short side, width, height, total pixels (megapixels x 1024²) or a "
        "long-side range that follows the image you connect. Both sides are then "
        "rounded to the 'multiple' you set. Outputs the ratio string plus the "
        "width and height; the canvas previews both in cyan next to their slots "
        "and shows the real numbers after a run. Same maths as Goohaitools' "
        "ratio-and-resolution node."
    )
    SEARCH_ALIASES = [
        "ratio", "resolution", "size", "width", "height", "megapixel",
        "aspect", "latent size", "比例", "分辨率", "比例与分辨率",
        "宽高", "百万像素", "尺寸", "倍数取整", "qg",
    ]
    CATEGORY = "QG-tools/Image"

    @classmethod
    def validate_inputs(cls, ratio=None, mode=None):
        # 两个下拉旧存档含中文值；具名跳过列表校验，值由 execute 开头 coerce 换回。
        return True

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_RatioResolution",
            display_name="Ratio Resolution",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Combo.Input("ratio", options=RATIO_OPTIONS, default="original",
                    tooltip="Target aspect ratio. 'original' follows the image you connect, 'custom' uses the two custom widgets below."),
                io.Combo.Input("mode", options=MODE_OPTIONS, default="long-side",
                    tooltip="How the size is pinned down. long-side / short-side / width / height all use 'fixed edge'; total-pixels uses 'megapixels'; long-side-range follows the incoming image's long edge clamped between min and max (needs an image)."),
                io.Int.Input("fixed_edge", default=1024, min=8, max=10240, step=1,
                    tooltip="Target edge length for the long-side / short-side / width / height modes; unused by the others."),
                io.Float.Input("megapixels", default=2.0, min=0.2, max=50.0, step=0.1,
                    tooltip="Target area for the total-pixels mode, in megapixels of 1024x1024 (same as ComfyUI's official Resolution Selector); unused by the others."),
                io.Int.Input("long_edge_min", default=512, min=8, max=10240, step=1,
                    tooltip="Shortest long edge allowed by the long-side-range mode. Swapped with the maximum automatically when it is larger."),
                io.Int.Input("long_edge_max", default=2048, min=8, max=10240, step=1,
                    tooltip="Longest long edge allowed by the long-side-range mode."),
                io.Int.Input("custom_width", default=1024, min=8, max=10240, step=1,
                    tooltip="Width used directly by the 'custom' ratio (still rounded to the multiple)."),
                io.Int.Input("custom_height", default=1024, min=8, max=10240, step=1,
                    tooltip="Height used directly by the 'custom' ratio (still rounded to the multiple)."),
                io.Int.Input("multiple", default=16, min=0, max=1024, step=1,
                    tooltip="Round each side to the nearest multiple of this. A result smaller than one multiple still gets a full multiple; 0 rounds to whole pixels."),
                io.Image.Input("image", optional=True,
                    tooltip="Optional. 'original' reads its size as the base ratio (1:1 when unwired); long-side-range reads its long edge and clamps it (1536 when unwired)."),
            ],
            outputs=[
                io.String.Output("ratio", tooltip="The aspect ratio as text: the reduced one for original / custom, the dropdown label otherwise."),
                io.Int.Output("width", tooltip="Computed width, already rounded to the multiple."),
                io.Int.Output("height", tooltip="Computed height, already rounded to the multiple."),
            ],
        )

    @staticmethod
    def _image_size(image):
        """Width and height of a ComfyUI IMAGE, or (1, 1) when unreadable."""
        if image is None:
            return 1, 1

        try:
            shape = tuple(image.shape)
        except AttributeError:
            return 1, 1

        # ComfyUI IMAGE is [batch, height, width, channels].
        if len(shape) >= 3:
            height = int(shape[-3])
            width = int(shape[-2])
            if width > 0 and height > 0:
                return width, height
        return 1, 1

    @staticmethod
    def _round_to_multiple(value, multiple):
        value = max(1.0, float(value))
        multiple = int(multiple)
        if multiple <= 0:
            return max(1, int(round(value)))

        # Keep the size valid: below one multiple, still output one multiple.
        return max(multiple, int(round(value / multiple)) * multiple)

    @classmethod
    def _ratio(cls, ratio_name, image):
        if ratio_name == "original":
            old_width, old_height = cls._image_size(image)
            return float(old_width), float(old_height)
        if ratio_name == "custom":
            return None
        return RATIO_VALUES.get(ratio_name, (1.0, 1.0))

    @staticmethod
    def _simplest_ratio(width, height):
        """Reduced integer ratio string for the final width / height."""
        width = max(1, int(width))
        height = max(1, int(height))
        divisor = math.gcd(width, height)
        return f"{width // divisor}:{height // divisor}"

    @classmethod
    def execute(
        cls,
        ratio,
        mode,
        fixed_edge,
        megapixels,
        long_edge_min,
        long_edge_max,
        custom_width,
        custom_height,
        multiple,
        image=None,
    ):
        # V1 装饰器 coerce 两个下拉值，V3 显式保留。
        ratio = coerce("QG_RatioResolution", "ratio", ratio)
        mode = coerce("QG_RatioResolution", "mode", mode)
        if ratio == "custom":
            width = float(custom_width)
            height = float(custom_height)
        else:
            ratio_w, ratio_h = cls._ratio(ratio, image)
            ratio_w = max(1.0, float(ratio_w))
            ratio_h = max(1.0, float(ratio_h))

            if mode == "long-side-range":
                src_w, src_h = cls._image_size(image)
                src_long = (max(1536, src_w, src_h) if (src_w <= 1 or src_h <= 1)
                            else max(src_w, src_h))
                smallest = max(8, int(long_edge_min))
                largest = max(8, int(long_edge_max))
                if smallest > largest:
                    smallest, largest = largest, smallest
                target_long = min(max(src_long, smallest), largest)
                scale = float(target_long) / max(ratio_w, ratio_h)
                width, height = ratio_w * scale, ratio_h * scale
            elif mode == "long-side":
                scale = float(fixed_edge) / max(ratio_w, ratio_h)
                width, height = ratio_w * scale, ratio_h * scale
            elif mode == "short-side":
                scale = float(fixed_edge) / min(ratio_w, ratio_h)
                width, height = ratio_w * scale, ratio_h * scale
            elif mode == "width":
                width = float(fixed_edge)
                height = width * ratio_h / ratio_w
            elif mode == "height":
                height = float(fixed_edge)
                width = height * ratio_w / ratio_h
            elif mode == "total-pixels":
                # Same as ComfyUI's official Resolution Selector: megapixels are
                # 1024², then each side is rounded to the multiple.
                area = max(0.2, float(megapixels)) * 1024.0 * 1024.0
                scale = math.sqrt(area / (ratio_w * ratio_h))
                width, height = ratio_w * scale, ratio_h * scale
            else:
                # Unknown mode falls back to long side, like the reference.
                scale = float(fixed_edge) / max(ratio_w, ratio_h)
                width, height = ratio_w * scale, ratio_h * scale

        final_w = cls._round_to_multiple(width, multiple)
        final_h = cls._round_to_multiple(height, multiple)
        if ratio in ("original", "custom"):
            ratio_text = cls._simplest_ratio(final_w, final_h)
        else:
            ratio_text = str(ratio)
        ratio_number = round(float(final_w) / float(final_h), 10)
        # Hand the real numbers to the frontend through the ui channel: when the
        # image size only becomes readable mid-run, the canvas would otherwise
        # keep showing the preview it could not compute.
        # V1 {"result":..., "ui":...} → V3 io.NodeOutput(*result, ui=...)。
        return io.NodeOutput(
            ratio_text, final_w, final_h,
            ui={
                "ratio_resolution": [{
                    "width": final_w,
                    "height": final_h,
                    "ratio": ratio_number,
                    "ratio_string": ratio_text,
                }]
            },
        )


NODE_CLASS_MAPPINGS = {"QG_RatioResolution": QGRatioResolution}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RatioResolution": "Ratio and Resolution"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
