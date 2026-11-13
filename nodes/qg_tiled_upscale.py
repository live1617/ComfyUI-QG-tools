# -*- coding: utf-8 -*-
"""QG_TiledUpscale — 把图切成模型能逐块重绘的 tiles。

用法形态参考 ComfyUI-AusBoss 的「Tiled Upscale 🆎」（MIT License）。
切块**规划** 1:1 搬自它的 nodes/_tile_helpers.py（本包 _qg_tile_helpers.py，
MIT 头注释保留、与上游逐字一致）；张量侧共享函数在 _qg_tile_image_helpers.py；
节点层（输入契约、stitcher 打包、报告）自写。与 AusBoss 的同类节点同参数输出逐位一致。
"""
from __future__ import annotations

from ._qg_tile_helpers import describe_plan, plan_tiles
from ._qg_tile_image_helpers import STITCHER_KIND, _model_enlarge, _resample, _rgb

class QGTiledUpscale:
    """按目标兆像素把图切成模型能逐块重绘的 tiles。"""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Sets the size of the finished picture in megapixels and cuts your "
        "picture into tiles a model can redraw one at a time. A picture "
        "that fits in one tile stays whole. Send the tiles through your "
        "sampler, then into Tiled Upscale Stitch with the stitcher. A small "
        "picture is not redrawn far past the detail it has: it is redrawn "
        "at most max_growth times its own megapixels and enlarged the plain "
        "way from there. The report says what was done with your picture."
    )
    SEARCH_ALIASES = [
        "tiled upscale", "tile upscale", "tiles", "split into tiles",
        "megapixels", "upscale", "切块", "分块", "放大", "超分", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "split"

    RETURN_TYPES = ("IMAGE", "QG_TILE_STITCHER", "IMAGE", "INT", "INT", "STRING")
    RETURN_NAMES = ("tiles", "stitcher", "before", "width", "height", "report")
    OUTPUT_IS_LIST = (True, False, False, False, False, False)
    OUTPUT_TOOLTIPS = (
        "The tiles, one after another. Nodes after this run once per tile.",
        "What Tiled Upscale Stitch needs to put the tiles back together.",
        "Your picture enlarged the plain way to the finished size: the before picture.",
        "Width of the finished picture in pixels.",
        "Height of the finished picture in pixels.",
        "What was done with your picture, in one or two sentences.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "The picture to enlarge and cut into tiles."}),
                "megapixels": (
                    "FLOAT",
                    {
                        "default": 4.0, "min": 0.0, "max": 64.0, "step": 0.05,
                        "tooltip": "Size of the finished picture, in megapixels. 0 keeps the picture's own size.",
                    },
                ),
            },
            "optional": {
                "upscale_model": (
                    "UPSCALE_MODEL",
                    {
                        "tooltip": (
                            "Optional. Enlarges the picture with an upscale model before it is "
                            "cut into tiles. Unplugged, it is enlarged the plain way (lanczos)."
                        ),
                    },
                ),
                "tile_megapixels": (
                    "FLOAT",
                    {
                        "default": 2.0, "min": 0.25, "max": 16.0, "step": 0.05,
                        "tooltip": (
                            "The most your model redraws at once. A picture up to about this "
                            "size stays in one tile. 2 suits Qwen Image 2.1 and Krea 2; use 1 for SDXL."
                        ),
                    },
                ),
                "overlap": (
                    "INT",
                    {
                        "default": 128, "min": 0, "max": 1024, "step": 8,
                        "tooltip": "How many pixels neighbouring tiles share. The join is blended across this strip.",
                    },
                ),
                "multiple": (
                    "INT",
                    {
                        "default": 32, "min": 1, "max": 256, "step": 1,
                        "tooltip": (
                            "Every tile's width and height is a multiple of this. 32 works with "
                            "every model tried; Qwen Image 2.1 needs it."
                        ),
                    },
                ),
                "max_growth": (
                    "FLOAT",
                    {
                        "default": 8.0, "min": 1.0, "max": 64.0, "step": 0.5,
                        "tooltip": (
                            "A small picture is redrawn at no more than this many times its own "
                            "megapixels, and enlarged the plain way from there. Raise it to redraw "
                            "a tiny picture at a big size anyway."
                        ),
                    },
                ),
            },
        }

    def split(self, image, megapixels, upscale_model=None, tile_megapixels=2.0,
              overlap=128, multiple=32, max_growth=8.0):
        source = _rgb(image, "Tiled Upscale")
        height, width = int(source.shape[1]), int(source.shape[2])
        plan = plan_tiles(
            width, height, megapixels, tile_megapixels, overlap, multiple, max_growth
        )
        redraw_width, redraw_height = plan["redraw"]
        result_width, result_height = plan["result"]

        enlarged = source
        # A redraw within a grid step of the picture's own size is not worth a model pass.
        if upscale_model is not None and redraw_width * redraw_height > width * height * 1.05:
            enlarged = _model_enlarge(upscale_model, source, redraw_width, redraw_height)
        base = _resample(enlarged, redraw_width, redraw_height, "lanczos")
        before = _resample(source, result_width, result_height, "lanczos")
        tiles = [
            base[:, top:bottom, left:right, :].contiguous()
            for left, top, right, bottom in plan["boxes"]
        ]
        stitcher = {"kind": STITCHER_KIND, "version": 1, "plan": plan, "tiles": tiles}
        report = describe_plan(plan)
        return (tiles, stitcher, before, result_width, result_height, report)


NODE_CLASS_MAPPINGS = {"QG_TiledUpscale": QGTiledUpscale}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TiledUpscale": "Tiled Upscale"}
