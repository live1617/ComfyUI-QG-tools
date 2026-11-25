# -*- coding: utf-8 -*-
"""QG_CustomColor — render a solid or gradient canvas from two hex colours.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_custom_color.py
        功能形态参考 Goohaitools「孤海 自定义颜色」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Color``；显示名与 DESCRIPTION 英化；
    3) tooltip 补齐英文。
  保持不变：全部渲染算术 —— 分块计算（_CHUNK_ROWS）控内存、缩放对渐变推进与
  半径的作用、颗粒强度公式、插值系数钳制在 [0,1]。

规格语义（与上游一致）：
  * 缩放控制渐变推进（上下渐变）或渐变半径（中心渐变），100 为标准；
  * 缩放 0 时上下渐变退化为正常渐变、中心渐变全图为颜色 1；
  * 颗粒是三通道相同的灰度噪声，强度 = 颗粒/100 * 0.15；
  * 插值系数钳制在 [0, 1]，缩放 >100 时不会溢出颜色区间（刻意改进）。
"""

from __future__ import annotations

import numpy as np
import torch

from comfy_api.latest import io

from .qg_dual_color_picker import normalize_hex

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
MODE_CHOICES = ["solid", "vertical_gradient", "radial_gradient"]
DEFAULT_COLOR1 = "#364254"
DEFAULT_COLOR2 = "#4C3843"
_MAX_SIDE = 8192
_CHUNK_ROWS = 256  # 分块行数：限制 8192 宽大图的中间数组内存


def _hex_to_rgb01(hex_color):
    """#rrggbb 转 0-1 浮点三元组（输入已经过 normalize_hex）。"""
    text = hex_color.lstrip("#")
    return (
        int(text[0:2], 16) / 255.0,
        int(text[2:4], 16) / 255.0,
        int(text[4:6], 16) / 255.0,
    )


def _ratio_column(height, scale):
    """上下渐变的行插值系数：缩放乘进推进速度，缩放 0 退化为正常渐变。"""
    ratio = np.linspace(0.0, 1.0, height, dtype=np.float32)
    factor = scale / 100.0
    if factor != 0.0:
        ratio = ratio * factor
    return np.clip(ratio, 0.0, 1.0)[:, None]


def _gradient_rows(height, width, c1, c2, scale):
    """上下渐变：顶部颜色1 → 底部颜色2，按行插值（每行常量，广播成图）。"""
    ratio = _ratio_column(height, scale)
    rows = c1 + (c2 - c1) * ratio  # (H, 3)，每行一个颜色
    return np.broadcast_to(rows[:, None, :], (height, width, 3))


def _radial_ratio_block(ys, width, center_x, center_y, radius):
    """中心渐变一块行区域的插值系数（中心颜色1 → 边缘颜色2）。"""
    xs = np.arange(width, dtype=np.float32)
    dist = np.sqrt(
        (ys[:, None] - center_y) ** 2 + (xs[None, :] - center_x) ** 2)
    if radius <= 0.0:
        return np.ones(dist.shape, dtype=np.float32)
    return np.clip(dist / radius, 0.0, 1.0)


def _apply_grain(image, grain):
    """灰度颗粒噪声：三通道同值，强度 = grain/100 * 0.15，钳制 0-1。"""
    strength = grain / 100.0 * 0.15
    noise = np.random.normal(
        scale=strength, size=(image.shape[0], image.shape[1], 1)
    ).astype(np.float32)
    return np.clip(image + np.repeat(noise, 3, axis=2), 0.0, 1.0)


def render_color(width, height, mode, color1, color2, scale, grain):
    """生成底图张量 [1,H,W,3] float32。"""
    if mode not in MODE_CHOICES:
        mode = MODE_CHOICES[0]
    width = max(1, min(int(width), _MAX_SIDE))
    height = max(1, min(int(height), _MAX_SIDE))
    c1 = np.array(_hex_to_rgb01(
        normalize_hex(color1, DEFAULT_COLOR1)), dtype=np.float32)
    c2 = np.array(_hex_to_rgb01(
        normalize_hex(color2, DEFAULT_COLOR2)), dtype=np.float32)

    if mode == "solid":
        image = np.ones((height, width, 3), dtype=np.float32) * c1
    elif mode == "vertical_gradient":
        image = _gradient_rows(height, width, c1, c2, scale)
    else:  # radial_gradient：中心颜色1 → 边缘颜色2
        max_radius = ((width ** 2 + height ** 2) ** 0.5) / 2.0
        radius = max_radius * (scale / 100.0)
        center_x, center_y = width // 2, height // 2
        image = np.empty((height, width, 3), dtype=np.float32)
        for start in range(0, height, _CHUNK_ROWS):
            end = min(start + _CHUNK_ROWS, height)
            ys = np.arange(start, end, dtype=np.float32)
            ratio = _radial_ratio_block(
                ys, width, center_x, center_y, radius)[:, :, None]
            image[start:end] = \
                c2[None, None, :] + (c1 - c2)[None, None, :] * ratio

    if grain > 0:
        image = _apply_grain(image, grain)

    return torch.from_numpy(np.clip(image, 0.0, 1.0))[None,]


class QGCustomColor(io.ComfyNode):
    """Render a solid or gradient background canvas."""

    CATEGORY = "QG-tools/Color"
    DESCRIPTION = (
        "Render a solid colour or a vertical / radial gradient canvas from two "
        "hex colours. Scale drives gradient progress or radius (100 is normal, "
        "0 flattens it); grain adds monochrome noise on top."
    )
    SEARCH_ALIASES = [
        "color", "colour", "gradient", "canvas", "background", "纯色",
        "渐变", "底图", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_CustomColor",
            display_name="Custom Color",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Int.Input(
                    "width",
                    default=512, min=1, max=_MAX_SIDE, step=1,
                    tooltip="Canvas width in pixels.",
                ),
                io.Int.Input(
                    "height",
                    default=512, min=1, max=_MAX_SIDE, step=1,
                    tooltip="Canvas height in pixels.",
                ),
                io.Combo.Input(
                    "mode",
                    options=list(MODE_CHOICES),
                    default="solid",
                    tooltip=(
                        "solid fills with colour 1; vertical_gradient runs "
                        "colour 1 at the top to colour 2 at the bottom; "
                        "radial_gradient runs colour 1 at the centre outwards."
                    ),
                ),
                io.String.Input(
                    "color1",
                    default=DEFAULT_COLOR1,
                    tooltip=(
                        "First colour (the solid fill, or the gradient start). "
                        "Click the swatch to pick one."
                    ),
                ),
                io.String.Input(
                    "color2",
                    default=DEFAULT_COLOR2,
                    tooltip="Second colour, used by the gradient modes only.",
                ),
                io.Int.Input(
                    "scale",
                    default=100, min=0, max=300, step=1,
                    tooltip=(
                        "100 is the natural gradient; below 100 compresses the "
                        "transition, above 100 stretches it. In radial mode it "
                        "scales the radius. 0 makes vertical_gradient normal and "
                        "radial_gradient a flat fill."
                    ),
                ),
                io.Int.Input(
                    "grain",
                    default=0, min=0, max=100, step=1,
                    tooltip=(
                        "Monochrome film grain strength, 0 to 100. The noise is "
                        "the same value on all three channels."
                    ),
                ),
            ],
            outputs=[
                io.Image.Output("image", tooltip="The rendered canvas as a single frame."),
            ],
        )

    @classmethod
    def execute(cls, width, height, mode, color1, color2, scale, grain):
        return io.NodeOutput(
            render_color(width, height, mode, color1, color2, scale, grain))


NODE_CLASS_MAPPINGS = {"QG_CustomColor": QGCustomColor}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_CustomColor": "Custom Color"}
