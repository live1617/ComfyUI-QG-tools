# -*- coding: utf-8 -*-
"""QG_ImageComposite — paste a source image onto a canvas at (x, y), mask optional.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_image_composite.py
        功能规格参照 ComfyUI_essentials 的 ``ImageComposite+``（GPL-3.0），
        代码为独立实现，未复制上游源码。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Image``；显示名与 DESCRIPTION 英化；
    3) 空批次报错与「完全落在画布外」的提示从中文改英文；
    4) tooltip 补齐英文（源文件的 tooltip 是中文）。
  保持不变：全部几何算术 —— 源图矩形与画布矩形求交集、四边越界统一裁切、
  帧数取两边较大值、遮罩双三次缩放并按先验 alpha 混合。

与 QG_ImageMergeMask 的分工：那个是全画布按遮罩叠加（覆盖图跟背景对齐），
本节点是把源图放到指定坐标（尺寸可以不一样、可以越界裁切）。
"""

from __future__ import annotations

import numpy as np
import torch
from PIL import Image

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
# 坐标控件范围（ComfyUI 惯例；只是滑块的上下限，不限制实际贴图尺寸）
COORD_LIMIT = 16384


def _as_frames(tensor):
    """把 ``[H,W,C]`` 或 ``[B,H,W,C]`` 统一成 ``[B,H,W,C]``。"""
    if tensor.ndim == 3:
        return tensor.unsqueeze(0)
    return tensor


def _mask_planes(mask):
    """把 MASK 规整成 ``[H,W]`` float32 列表，裁到 0..1，清掉 NaN。"""
    if mask is None:
        return []
    frames = mask.unsqueeze(0) if mask.ndim == 2 else mask
    if frames.ndim == 4:  # 个别来源会给 [B,H,W,1]
        frames = frames[..., 0]
    arr = frames.detach().cpu().numpy().astype(np.float32)
    arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=0.0)
    return [np.clip(arr[i], 0.0, 1.0) for i in range(arr.shape[0])]


def _resize_plane(plane, height, width):
    """遮罩平面双三次缩放到源图尺寸（尺寸已对则原样返回）。"""
    if plane.shape == (height, width):
        return plane
    img = Image.fromarray((np.clip(plane, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "L")
    img = img.resize((width, height), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def _fit_channels(patch, channels):
    """源图通道数与画布不一致时补齐 / 截断，避免广播失败。"""
    if patch.shape[2] == channels:
        return patch
    if patch.shape[2] == 1:
        return np.repeat(patch, channels, axis=2)
    if patch.shape[2] > channels:
        return patch[:, :, :channels]
    pad = np.repeat(patch[:, :, -1:], channels - patch.shape[2], axis=2)
    return np.concatenate((patch, pad), axis=2)


def compose_frame(canvas, source, alpha, left, top):
    """把 ``source`` 贴到 ``canvas`` 的 ``(left, top)``，返回新帧（不改入参）。

    ``alpha`` 为 ``None`` 时直接覆盖；否则按 ``source*a + canvas*(1-a)`` 混合。
    源图矩形与画布矩形的交集为空时，返回画布副本。
    """
    out = canvas.copy()
    height, width = canvas.shape[:2]
    src_h, src_w = source.shape[:2]

    x0 = max(int(left), 0)
    y0 = max(int(top), 0)
    x1 = min(int(left) + src_w, width)
    y1 = min(int(top) + src_h, height)
    if x1 <= x0 or y1 <= y0:
        return out

    src_x0 = x0 - int(left)
    src_y0 = y0 - int(top)
    patch = source[src_y0:src_y0 + (y1 - y0), src_x0:src_x0 + (x1 - x0), :]
    patch = _fit_channels(patch, canvas.shape[2])

    if alpha is None:
        out[y0:y1, x0:x1, :] = patch
        return out

    a = alpha[src_y0:src_y0 + (y1 - y0), src_x0:src_x0 + (x1 - x0)]
    a = a[:, :, None]
    out[y0:y1, x0:x1, :] = patch * a + out[y0:y1, x0:x1, :] * (1.0 - a)
    return out


def compose_batch(destination, source, mask, x, y, offset_x, offset_y):
    """整批合成，返回 ``(输出帧列表, 是否完全落在画布外)``。"""
    dest = _as_frames(destination)
    src = _as_frames(source)
    if dest.shape[0] == 0 or src.shape[0] == 0:
        raise ValueError(
            "Image Composite needs at least one frame on both sides; the "
            "destination or the source batch was empty.")

    count = max(int(dest.shape[0]), int(src.shape[0]))
    left = int(x) + int(offset_x)
    top = int(y) + int(offset_y)

    planes = _mask_planes(mask)
    src_h, src_w = int(src.shape[1]), int(src.shape[2])
    canvas_h, canvas_w = int(dest.shape[1]), int(dest.shape[2])
    outside = (left + src_w <= 0 or top + src_h <= 0
               or left >= canvas_w or top >= canvas_h)

    frames = []
    for i in range(count):
        canvas = dest[min(i, dest.shape[0] - 1)].detach().cpu().numpy().astype(np.float32)
        patch = src[min(i, src.shape[0] - 1)].detach().cpu().numpy().astype(np.float32)
        alpha = None
        if planes:
            alpha = _resize_plane(planes[min(i, len(planes) - 1)], src_h, src_w)
        frames.append(compose_frame(canvas, patch, alpha, left, top))
    return frames, outside


class QGImageComposite(io.ComfyNode):
    """Paste a source image onto a destination canvas at a given position."""

    CATEGORY = "QG-tools/Image"
    DESCRIPTION = (
        "Paste the source onto the destination canvas at "
        "(x + offset_x, y + offset_y), blended through an optional mask. "
        "Negative coordinates crop instead of wrapping, all four edges are "
        "clipped the same way, and the shorter batch repeats its last frame. "
        "The destination size decides the output size."
    )
    SEARCH_ALIASES = [
        "composite", "paste", "overlay", "blend", "place", "图像合成", "合成",
        "贴图", "叠加", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ImageComposite",
            display_name="Image Composite",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input(
                    "destination",
                    tooltip="The canvas. Its size decides the output size.",
                ),
                io.Image.Input(
                    "source",
                    tooltip="The image to paste onto the canvas.",
                ),
                io.Int.Input(
                    "x",
                    default=0, min=-COORD_LIMIT, max=COORD_LIMIT, step=1,
                    tooltip=(
                        "X of the source's top-left corner on the canvas, in "
                        "pixels. Negative crops the left side."
                    ),
                ),
                io.Int.Input(
                    "y",
                    default=0, min=-COORD_LIMIT, max=COORD_LIMIT, step=1,
                    tooltip=(
                        "Y of the source's top-left corner on the canvas, in "
                        "pixels. Negative crops the top."
                    ),
                ),
                io.Int.Input(
                    "offset_x",
                    default=0, min=-COORD_LIMIT, max=COORD_LIMIT, step=1,
                    tooltip=(
                        "Added to x. Lets an upstream value move the source "
                        "without changing x itself."
                    ),
                ),
                io.Int.Input(
                    "offset_y",
                    default=0, min=-COORD_LIMIT, max=COORD_LIMIT, step=1,
                    tooltip=(
                        "Added to y. Lets an upstream value move the source "
                        "without changing y itself."
                    ),
                ),
                io.Mask.Input(
                    "mask",
                    optional=True,
                    tooltip=(
                        "Blend mask the size of the source: white keeps the "
                        "source, black keeps the canvas. Resized if it does not "
                        "match; a single frame applies to all frames."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="The composited batch, one frame per destination frame.",
                ),
            ],
        )

    @classmethod
    def execute(cls, destination, source, x=0, y=0, offset_x=0, offset_y=0,
                mask=None):
        frames, outside = compose_batch(destination, source, mask,
                                        x, y, offset_x, offset_y)
        if outside:
            src = _as_frames(source)
            height, width = int(frames[0].shape[0]), int(frames[0].shape[1])
            print("[QG-ImageComposite] source %dx%d at (%d, %d) falls completely "
                  "outside the %dx%d canvas; output equals the destination."
                  % (int(src.shape[2]), int(src.shape[1]),
                     int(x) + int(offset_x), int(y) + int(offset_y),
                     width, height))
        result = torch.from_numpy(np.stack(frames, axis=0))
        result = result.to(device=destination.device, dtype=destination.dtype)
        return io.NodeOutput(result)


NODE_CLASS_MAPPINGS = {"QG_ImageComposite": QGImageComposite}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ImageComposite": "Image Composite"}
