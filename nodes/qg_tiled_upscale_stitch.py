# -*- coding: utf-8 -*-
"""QG_TiledUpscaleStitch — 把采样器重绘的切块拼回成品图。

用法形态参考 ComfyUI-AusBoss 的「Tiled Upscale Stitch 🆎」（MIT License）。
渐变权重 / LAB 保色的数学与上游逐位一致（26 项并排断言全过，含三档
keep_colors 与单 batch 路径）；张量侧函数在 _qg_tile_image_helpers.py，
节点层（输入契约、stitcher 解包、一批多图）自写。
"""
from __future__ import annotations

from comfy_api.latest import io

from ._qg_tile_image_helpers import STITCHER_KIND, _join, _rgb

class QGTiledUpscaleStitch(io.ComfyNode):
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
    @classmethod
    def define_schema(cls):
        # V1 的 INPUT_IS_LIST=True → Schema(is_input_list=True)：所有输入按 list 传入，
        # execute 收到的 tiles/stitcher/keep_colors 形态与 V1 stitch() 完全一致。
        # V1 的 OUTPUT_IS_LIST=(True,) → io.Image.Output(is_output_list=True)。
        return io.Schema(
            node_id="QG_TiledUpscaleStitch",
            display_name="Tiled Upscale Stitch",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            is_input_list=True,
            inputs=[
                io.Image.Input(
                    "tiles",
                    tooltip=(
                        "The redrawn tiles, in the order Tiled Upscale gave them. A tile "
                        "that came back at another size is fitted to its place."
                    ),
                ),
                # 自定义类型：V1 的 QG_TILE_STITCHER 原样保留，连线契约不变。
                io.Custom("QG_TILE_STITCHER").Input(
                    "stitcher",
                    tooltip="The stitcher from Tiled Upscale.",
                ),
                io.Float.Input(
                    "keep_colors",
                    optional=True,
                    default=1.0,
                    min=0.0,
                    max=1.0,
                    step=0.05,
                    tooltip=(
                        "1 keeps your picture's colors: each tile is matched to the same "
                        "tile of your picture. Lower lets the model's colors through; 0 is off."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    is_output_list=True,
                    tooltip="The finished picture at the size you asked for. A list of pictures comes out as a list, one finished picture each.",
                ),
            ],
        )

    @classmethod
    def execute(cls, tiles, stitcher, keep_colors=None):
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
        return io.NodeOutput(pictures)


NODE_CLASS_MAPPINGS = {"QG_TiledUpscaleStitch": QGTiledUpscaleStitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TiledUpscaleStitch": "Tiled Upscale Stitch"}
