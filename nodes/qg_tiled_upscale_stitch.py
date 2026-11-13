# -*- coding: utf-8 -*-
"""QG_TiledUpscaleStitch — 把采样器重绘的切块拼回成品图。

用法形态参考 ComfyUI-AusBoss 的「Tiled Upscale Stitch 🆎」（MIT License）。
渐变权重 / LAB 保色的数学与上游逐位一致（26 项并排断言全过，含三档
keep_colors 与单 batch 路径）；张量侧函数在 _qg_tile_image_helpers.py，
节点层（输入契约、stitcher 解包、一批多图）自写。
"""
from __future__ import annotations

import torch

from ._qg_tile_image_helpers import STITCHER_KIND, _join, _rgb

class QGTiledUpscaleStitch:
    """把采样器重绘的 tiles 拼回成品图：渐变融合 + LAB 保色。"""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Puts the tiles from Tiled Upscale back together after your model has "
        "redrawn them, blends the joins and brings the picture to the size you "
        "asked for. Keep colors matches each tile to the same tile of your "
        "picture first, so the tiles agree with each other and the picture "
        "keeps its own colors."
    )
    SEARCH_ALIASES = [
        "tiled upscale stitch", "join tiles", "merge tiles", "tiled upscale",
        "拼接", "拼回", "融合", "qg",
    ]
    OUTPUT_NODE = False
    INPUT_IS_LIST = True
    FUNCTION = "stitch"

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_TOOLTIPS = (
        "The finished picture at the size you asked for. A list of pictures comes out as a list, one finished picture each.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tiles": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "The redrawn tiles, in the order Tiled Upscale gave them. A tile "
                            "that came back at another size is fitted to its place."
                        ),
                    },
                ),
                "stitcher": (
                    "QG_TILE_STITCHER",
                    {"tooltip": "The stitcher from Tiled Upscale."},
                ),
            },
            "optional": {
                "keep_colors": (
                    "FLOAT",
                    {
                        "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                        "tooltip": (
                            "1 keeps your picture's colors: each tile is matched to the same "
                            "tile of your picture. Lower lets the model's colors through; 0 is off."
                        ),
                    },
                ),
            },
        }

    def stitch(self, tiles, stitcher, keep_colors=None):
        # A list of pictures runs Tiled Upscale once per picture: the tiles
        # arrive as one list, picture after picture, with one stitcher each.
        stitchers = list(stitcher) if isinstance(stitcher, (list, tuple)) else [stitcher]
        if not stitchers or any(
            not isinstance(item, dict) or item.get("kind") != STITCHER_KIND for item in stitchers
        ):
            raise ValueError("Tiled Upscale Stitch needs the stitcher from Tiled Upscale.")
        strength = keep_colors[0] if isinstance(keep_colors, (list, tuple)) and keep_colors else keep_colors
        strength = 1.0 if strength is None else max(0.0, min(1.0, float(strength)))
        counts = [len(item["plan"]["boxes"]) for item in stitchers]
        expected = sum(counts)

        redrawn = [_rgb(tile, "Tiled Upscale Stitch") for tile in (tiles if isinstance(tiles, (list, tuple)) else [tiles])]
        if len(redrawn) == 1 and expected > 1 and redrawn[0].shape[0] % expected == 0:
            # the tiles came back as one batch: split it the way it was made
            per_tile = redrawn[0].shape[0] // expected
            redrawn = list(redrawn[0].split(per_tile, dim=0))
        if len(redrawn) != expected:
            has = f"{len(stitchers)} stitchers have" if len(stitchers) > 1 else "the stitcher has"
            raise ValueError(
                f"Tiled Upscale Stitch got {len(redrawn)} tiles and {has} {expected}. "
                "Send every tile from Tiled Upscale through the same nodes, in order."
            )

        pictures = []
        start = 0
        for item, count in zip(stitchers, counts):
            pictures.append(_join(redrawn[start:start + count], item, strength))
            start += count
        return (pictures,)


NODE_CLASS_MAPPINGS = {"QG_TiledUpscaleStitch": QGTiledUpscaleStitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TiledUpscaleStitch": "Tiled Upscale Stitch"}
