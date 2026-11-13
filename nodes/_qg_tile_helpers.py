# -*- coding: utf-8 -*-
# 搬自 ComfyUI-AusBoss 的 nodes/_tile_helpers.py（MIT License）。
# 2026-11-11 1:1 搬入，给 QG_TiledUpscale / QG_TiledUpscaleStitch 用。
# 纯数字规划（无张量、无 ComfyUI 依赖）：切块网格、重叠、目标/重绘尺寸与报告。
# 除本头注释外与上游逐字相同 —— 上游算法有任何修正，请同步搬过来。
"""Tile planning shared by Tiled Upscale and Tiled Upscale Stitch.

Numbers only, no tensors, so the plan can be tested as arithmetic. One sum
covers every case a size control has to handle:

- the redraw size is the size asked for, but never more than ``max_growth``
  times the picture's own megapixels and never less than one tile, so a
  small picture is not redrawn far past the detail it has;
- the redraw is cut into ``k x k`` tiles of the picture's own shape, one tile
  for anything up to about ``tile_megapixels``;
- whatever the redraw is short of the size asked for is made up afterwards
  by a plain enlargement.
"""

from __future__ import annotations

import math

# A tile may run this far over tile_megapixels before the picture is cut: a
# "2 MP" picture snapped to a 32 px grid is often 2.05 to 2.1 MP.
TILE_SLACK = 1.125
# Rounding to the grid may add a little more; it never splits a picture.
SNAP_SLACK = 1.03
# A redraw limited by max_growth that still reaches this share of the size
# asked for is redrawn at that size: nobody wants a resample over 5%.
NEAR_ENOUGH = 0.9
# Tiles longer than this against their short side are avoided; a single tile
# keeps the picture's own shape whatever it is.
MAX_TILE_ASPECT = 2.2
# A picture of a megapixel or more shows little change unless it grows about
# this much per side (measured 2026-10-06 on phone photos).
MIN_VISIBLE_GROWTH = 1.6
# Under this growth per side the picture is being made smaller: the report says
# so, and does not call the size too close.
SHRINK_BELOW = 0.97
MAX_TILES = 144


def _round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def snap_to_multiple(value: float, multiple: int) -> int:
    """Nearest multiple, never below one step (the rule Image Resize uses)."""
    step = max(1, int(multiple))
    return max(step, _round_half_up(value / step) * step)


def megapixel_size(width: int, height: int, megapixels: float, multiple: int) -> tuple[int, int]:
    """The size Image Resize gives in megapixels mode with the same Multiple."""
    scale = math.sqrt(float(megapixels) * 1e6 / (int(width) * int(height)))
    return (
        snap_to_multiple(max(1, _round_half_up(width * scale)), multiple),
        snap_to_multiple(max(1, _round_half_up(height * scale)), multiple),
    )


def _starts(length: int, tile: int, count: int) -> list[int]:
    """Left edges of ``count`` tiles spread evenly over ``length`` pixels."""
    if count <= 1 or tile >= length:
        return [0]
    return [_round_half_up(index * (length - tile) / (count - 1)) for index in range(count)]


def _side(length: int, count: int, overlap: int, multiple: int) -> int:
    """Length of one of ``count`` tiles that cover ``length`` with ``overlap``."""
    if count <= 1:
        return length
    tile = math.ceil((length + (count - 1) * overlap) / count / multiple) * multiple
    return max(multiple, min(length, tile))


def _grid(width: int, height: int, cap_pixels: float, overlap: int, multiple: int) -> tuple[int, int, int, int]:
    """Fewest equal tiles of at most ``cap_pixels`` that cover the picture;
    among those the squarest. Returns columns, rows, tile width, tile height."""
    for count in range(1, MAX_TILES + 1):
        best = None
        for columns in range(1, count + 1):
            if count % columns:
                continue
            rows = count // columns
            tile_width = _side(width, columns, overlap, multiple)
            tile_height = _side(height, rows, overlap, multiple)
            if tile_width * tile_height > cap_pixels:
                continue
            aspect = max(tile_width / tile_height, tile_height / tile_width)
            if count > 1 and aspect > MAX_TILE_ASPECT:
                continue
            score = (abs(math.log(tile_width / tile_height)), columns)
            if best is None or score < best[0]:
                best = (score, columns, rows, tile_width, tile_height)
        if best is not None:
            return best[1:]
    raise ValueError(
        f"Tiled Upscale would cut this picture into more than {MAX_TILES} tiles. "
        "Ask for fewer megapixels or a larger tile size."
    )


def plan_tiles(
    source_width: int,
    source_height: int,
    megapixels: float,
    tile_megapixels: float = 2.0,
    overlap: int = 128,
    multiple: int = 32,
    max_growth: float = 8.0,
) -> dict:
    """Plan one upscale as plain numbers.

    ``megapixels`` 0 keeps the picture's own size (a light pass over a
    finished picture). Returns the result size, the redraw size, the tile
    size, every tile's box in redraw pixels (row by row) and the overlap
    between neighbours along each axis.
    """
    width, height = int(source_width), int(source_height)
    if width <= 0 or height <= 0:
        raise ValueError("Tiled Upscale needs a picture larger than 0x0.")
    multiple = max(1, int(multiple))
    overlap = max(0, int(overlap))
    tile_mp = float(tile_megapixels)
    if tile_mp <= 0:
        raise ValueError("Tiled Upscale needs a tile size above 0 megapixels.")
    growth = max(1.0, float(max_growth))
    source_mp = width * height / 1e6
    keep_size = float(megapixels) <= 0
    asked_mp = source_mp if keep_size else float(megapixels)

    if keep_size:
        result_width, result_height = width, height
    else:
        result_width, result_height = megapixel_size(width, height, asked_mp, multiple)

    limit_mp = max(tile_mp, growth * source_mp)
    limited = (not keep_size) and limit_mp < asked_mp * NEAR_ENOUGH
    if keep_size:
        redraw_width = snap_to_multiple(width, multiple)
        redraw_height = snap_to_multiple(height, multiple)
    elif limited:
        redraw_width, redraw_height = megapixel_size(width, height, limit_mp, multiple)
    else:
        redraw_width, redraw_height = result_width, result_height

    columns, rows, tile_width, tile_height = _grid(
        redraw_width, redraw_height, tile_mp * TILE_SLACK * SNAP_SLACK * 1e6, overlap, multiple
    )
    xs = _starts(redraw_width, tile_width, columns)
    ys = _starts(redraw_height, tile_height, rows)
    boxes = [(x, y, x + tile_width, y + tile_height) for y in ys for x in xs]
    overlap_x = tile_width - (xs[1] - xs[0]) if len(xs) > 1 else 0
    overlap_y = tile_height - (ys[1] - ys[0]) if len(ys) > 1 else 0

    result_mp = result_width * result_height / 1e6
    growth_per_side = math.sqrt(result_mp / source_mp)
    # asked for clearly fewer megapixels than the picture has: it is made smaller, which is a choice, not a size too close
    shrunk = (not keep_size) and growth_per_side < SHRINK_BELOW
    return {
        "source": (width, height),
        "source_megapixels": source_mp,
        "asked_megapixels": asked_mp,
        "keep_size": keep_size,
        "result": (result_width, result_height),
        "redraw": (redraw_width, redraw_height),
        "tile": (tile_width, tile_height),
        "columns": len(xs),
        "rows": len(ys),
        "boxes": boxes,
        "overlap": (max(0, overlap_x), max(0, overlap_y)),
        "enlarged": limited,
        "shrunk": shrunk,
        "too_close": (not keep_size)
        and (not shrunk)
        and source_mp >= 1.0
        and growth_per_side < MIN_VISIBLE_GROWTH,
        "suggested_megapixels": math.ceil(source_mp * MIN_VISIBLE_GROWTH**2 * 2) / 2,
    }


def _megapixels_text(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return f"{text} MP"


def describe_plan(plan: dict) -> str:
    """One or two plain sentences on what the plan does with this picture."""
    source_width, source_height = plan["source"]
    result_width, result_height = plan["result"]
    redraw_width, redraw_height = plan["redraw"]
    tiles = len(plan["boxes"])
    tile_width, tile_height = plan["tile"]
    head = f"{source_width} x {source_height} px ({_megapixels_text(plan['source_megapixels'])})"
    redraw = _megapixels_text(redraw_width * redraw_height / 1e6)
    if tiles == 1:
        how = f"redrawn as one tile of {redraw_width} x {redraw_height} px"
    else:
        how = (
            f"redrawn at {redraw} in {tiles} tiles of "
            f"{tile_width} x {tile_height} px"
        )
    if plan["keep_size"]:
        return f"{head} keeps its size: {how}."
    text = f"{head} to {result_width} x {result_height} px ({_megapixels_text(result_width * result_height / 1e6)}): {how}"
    if plan["enlarged"]:
        text += ", then enlarged the plain way. A picture this small has no more detail to redraw from."
    else:
        text += "."
    if plan.get("shrunk"):
        text += " The picture is larger than the size asked for, so it is made smaller first."
    if plan["too_close"]:
        text += (
            " That is close to the picture's own size, so expect little change: "
            f"ask for {_megapixels_text(plan['suggested_megapixels'])} or more."
        )
    return text


__all__ = [
    "MAX_TILES",
    "describe_plan",
    "megapixel_size",
    "plan_tiles",
    "snap_to_multiple",
]
