# -*- coding: utf-8 -*-
"""切块超分的张量侧共享函数（Split 与 Stitch 都用）。

数学与 ComfyUI-AusBoss 的 Tiled Upscale 对（MIT License）逐位一致；
这里的实现是节点层自写，不是为了逐字搬运（切块**规划**那个纯数字
helper 才是 1:1 搬入，见 _qg_tile_helpers.py 的 MIT 头注释）。
"""
from __future__ import annotations

import sys

import torch

from ._qg_color_helpers import lab_to_rgb, rgb_to_lab
from .qg_image_fit_resize import _resample

STITCHER_KIND = "qg_tile_stitcher"
# 上游核心节点的注册键；V3 类也进 NODE_CLASS_MAPPINGS，execute 是 classmethod，
# 返回 io.NodeOutput（.result[0] 取图），与这里的调用方式兼容。
UPSCALE_MODEL_NODE = "ImageUpscaleWithModel"
NEEDS_UPSCALE_NODE = (
    "Tiled Upscale could not find ComfyUI's Upscale Image (using Model) node. "
    "Update ComfyUI, or unplug the upscale model: the picture is then enlarged the plain way."
)

# 颜色保真：在小尺寸平均图上给每个 LAB 通道做直线拟合 source = gain x redraw + offset。
COLOR_CELLS = 32
COLOR_FLOOR = 0.5
COLOR_GAIN_MAX = 3.0


def _rgb(image: torch.Tensor, who: str) -> torch.Tensor:
    """BHWC float batch with exactly three channels."""
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError(f"{who} expected a BHWC IMAGE batch.")
    image = image.float()
    if image.shape[-1] == 1:
        return image.expand(-1, -1, -1, 3)
    return image[..., :3]


def _core_nodes() -> dict:
    """ComfyUI's own node classes, by key. Empty outside ComfyUI."""
    mappings = getattr(sys.modules.get("nodes"), "NODE_CLASS_MAPPINGS", None)
    return mappings if isinstance(mappings, dict) else {}


def _model_enlarge(upscale_model, image: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Enlarge with an upscale model until the picture covers the target.

    ComfyUI's own Upscale Image (using Model) node does each pass; nothing
    of it is copied here. The result is larger than or equal to the target
    and is brought to the exact size by the caller.
    """
    runner = _core_nodes().get(UPSCALE_MODEL_NODE)
    if runner is None or not hasattr(runner, "execute"):
        raise RuntimeError(NEEDS_UPSCALE_NODE)
    for _ in range(4):
        if image.shape[2] >= width and image.shape[1] >= height:
            break
        before = image.shape[1:3]
        image = runner.execute(upscale_model=upscale_model, image=image).result[0]
        image = _rgb(image, "Tiled Upscale")
        if image.shape[1] <= before[0] or image.shape[2] <= before[1]:
            break  # a 1x model: nothing more to gain
    return image


def _averaged_lab(rgb: torch.Tensor) -> torch.Tensor:
    """LAB of a small averaged copy: fine detail gone, the colors kept."""
    height, width = int(rgb.shape[1]), int(rgb.shape[2])
    scale = COLOR_CELLS / max(height, width)
    size = (max(2, min(height, round(height * scale))), max(2, min(width, round(width * scale))))
    small = torch.nn.functional.interpolate(rgb.movedim(-1, 1), size=size, mode="area")
    return rgb_to_lab(small.movedim(1, -1))


def _keep_colors(tile: torch.Tensor, source: torch.Tensor, strength: float) -> torch.Tensor:
    """Bring a redrawn tile to the colors of the tile it came from.

    A redrawn tile shows the same thing in the same place as its source, so
    each LAB channel gets a straight-line fit, source = gain x redraw +
    offset, taken on small averaged copies of both. A fit follows what the
    two pictures share: noise in an old photo does not tilt it.
    """
    mine, wanted = _averaged_lab(tile), _averaged_lab(source)
    mean = mine.mean(dim=(1, 2), keepdim=True)
    wanted_mean = wanted.mean(dim=(1, 2), keepdim=True)
    variance = ((mine - mean) ** 2).mean(dim=(1, 2), keepdim=True)
    shared = ((mine - mean) * (wanted - wanted_mean)).mean(dim=(1, 2), keepdim=True)
    gain = ((shared + COLOR_FLOOR**2) / (variance + COLOR_FLOOR**2)).clamp(0.0, COLOR_GAIN_MAX)
    matched = lab_to_rgb((rgb_to_lab(tile) - mean) * gain + wanted_mean)
    return tile + (matched - tile) * strength


def _ramp(length: int, rise: int, fall: int) -> torch.Tensor:
    """Blend weights along one side of a tile: up over ``rise`` pixels at the
    start, down over ``fall`` at the end, 1 between."""
    weights = torch.ones(length, dtype=torch.float32)
    rise = max(0, min(int(rise), length))
    fall = max(0, min(int(fall), length))
    if rise:
        weights[:rise] = torch.arange(1, rise + 1, dtype=torch.float32) / (rise + 1)
    if fall:
        weights[length - fall:] *= torch.arange(fall, 0, -1, dtype=torch.float32) / (fall + 1)
    return weights


def _shared(starts: list[int], size: int, start: int) -> tuple[int, int]:
    """Pixels this tile shares with the tile before and the tile after."""
    index = starts.index(start)
    before = starts[index - 1] + size - start if index > 0 else 0
    after = start + size - starts[index + 1] if index + 1 < len(starts) else 0
    return max(0, before), max(0, after)


def _join(redrawn: list[torch.Tensor], stitcher: dict, strength: float) -> torch.Tensor:
    """One picture from its redrawn tiles, blended at the joins."""
    plan = stitcher["plan"]
    boxes = plan["boxes"]
    sources = stitcher["tiles"]
    redraw_width, redraw_height = plan["redraw"]
    result_width, result_height = plan["result"]
    tile_width, tile_height = plan["tile"]
    lefts = sorted({box[0] for box in boxes})
    tops = sorted({box[1] for box in boxes})
    batch = max(tile.shape[0] for tile in redrawn)
    total = torch.zeros((batch, redraw_height, redraw_width, 3), dtype=torch.float32)
    weight = torch.zeros((redraw_height, redraw_width), dtype=torch.float32)

    for tile, source, (left, top, right, bottom) in zip(redrawn, sources, boxes):
        tile = _resample(tile.cpu(), tile_width, tile_height, "lanczos")
        if strength > 0.0:
            reference = source.cpu()
            if reference.shape[0] not in (1, tile.shape[0]):
                reference = reference[:1]
            tile = _keep_colors(tile, reference, strength)
        share_left, share_right = _shared(lefts, tile_width, left)
        share_top, share_bottom = _shared(tops, tile_height, top)
        mask = _ramp(tile_height, share_top, share_bottom)[:, None] * _ramp(tile_width, share_left, share_right)[None, :]
        total[:, top:bottom, left:right, :] += tile * mask[None, :, :, None]
        weight[top:bottom, left:right] += mask

    merged = total / weight.clamp_min(1e-6)[None, :, :, None]
    return _resample(merged.clamp_(0.0, 1.0), result_width, result_height, "lanczos")


