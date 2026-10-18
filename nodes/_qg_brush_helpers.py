# -*- coding: utf-8 -*-
"""QG 的画笔：一根圆心的实心笔芯，外面一圈软边。

「图像对比」的橡皮擦保存时，和「按触摸画遮罩」的软笔一样，都拿浏览器记下的
笔画在**原图尺寸**上重画一遍。一笔有大小（笔宽，单位是图上像素）、软度（0~1）
和路径：先画笔芯，再按软度做高斯模糊。

`web/shared/brush.mjs` 里是同一套数字，面板就是用它们画预览的；两边要一直
对得上（改名时特意保持公式逐字一致）。

移植自 ComfyUI-AusBoss（MIT，nodes/_brush_helpers.py）。
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageFilter

# 模糊比这还小，就当硬边画，省一次滤波。
SOFT_FROM = 0.25


def brush_core(size: float, soft: float) -> float:
    """笔芯（实心部分）的半径。``soft`` 取 0~1。"""
    return (size / 2.0) * (1.0 - soft / 2.0)


def brush_sigma(size: float, soft: float) -> float:
    """软边模糊的幅度：硬笔是 0，最软时是笔宽的八分之一。"""
    return soft * size / 8.0


def core_cover(points, core: float, left: int, top: int, right: int, bottom: int) -> np.ndarray:
    """沿一条路径，每个像素被笔芯盖住多少。

    盒子是图上像素坐标，可以伸到图外。像素按中心点算：离笔芯边缘半像素以内
    算盖满，外面半像素就完全不算。
    """
    cover = np.zeros((bottom - top, right - left), dtype=np.float32)
    reach = core + 1.0
    last = len(points) - 1
    for index in range(max(1, last)):
        x0, y0 = points[index]
        x1, y1 = points[min(index + 1, last)]
        box_left = max(left, int(math.floor(min(x0, x1) - reach)))
        box_right = min(right, int(math.ceil(max(x0, x1) + reach)))
        box_top = max(top, int(math.floor(min(y0, y1) - reach)))
        box_bottom = min(bottom, int(math.ceil(max(y0, y1) + reach)))
        if box_right <= box_left or box_bottom <= box_top:
            continue
        xs = np.arange(box_left, box_right, dtype=np.float32) + 0.5 - x0
        ys = (np.arange(box_top, box_bottom, dtype=np.float32) + 0.5 - y0)[:, None]
        dx, dy = x1 - x0, y1 - y0
        span = dx * dx + dy * dy
        if span > 0:
            along = np.clip((xs * dx + ys * dy) / span, 0.0, 1.0)
            distance = np.hypot(xs - along * dx, ys - along * dy)
        else:
            distance = np.hypot(xs, ys)
        part = cover[box_top - top:box_bottom - top, box_left - left:box_right - left]
        np.maximum(part, np.clip(core - distance + 0.5, 0.0, 1.0), out=part)
    return cover


def stroke_cover(points, size: float, soft: float, width: int, height: int):
    """一笔落在一张图上的样子：``(left, top, cover)``。

    ``cover`` 是每个像素被盖住多少（float32，0~1），只留落在图上的那一块；
    ``left`` / ``top`` 说这块从哪里开始。整笔都在图外时返回 None。
    """
    core = brush_core(size, soft)
    sigma = brush_sigma(size, soft)
    blur = sigma >= SOFT_FROM
    # 给模糊留出余量：笔跑出图外的地方，模糊也要看得见它。
    margin = int(math.ceil(3 * sigma)) + 2 if blur else 0
    reach = core + margin + 1
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left = max(-margin, int(math.floor(min(xs) - reach)))
    right = min(width + margin, int(math.ceil(max(xs) + reach)))
    top = max(-margin, int(math.floor(min(ys) - reach)))
    bottom = min(height + margin, int(math.ceil(max(ys) + reach)))
    if right <= left or bottom <= top:
        return None
    cover = core_cover(points, core, left, top, right, bottom)
    if blur:
        soft_cover = Image.fromarray(np.round(cover * 255.0).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma))
        cover = np.asarray(soft_cover, dtype=np.float32) / 255.0
    # 盒子落在图上的那一块。
    in_left, in_right = max(left, 0), min(right, width)
    in_top, in_bottom = max(top, 0), min(bottom, height)
    if in_right <= in_left or in_bottom <= in_top:
        return None
    return in_left, in_top, cover[in_top - top:in_bottom - top, in_left - left:in_right - left]


__all__ = [
    "SOFT_FROM",
    "brush_core",
    "brush_sigma",
    "core_cover",
    "stroke_cover",
]
