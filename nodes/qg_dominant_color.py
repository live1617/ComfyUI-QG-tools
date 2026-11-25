# -*- coding: utf-8 -*-
"""QG_DominantColor — report the most frequent colour as an uppercase #RRGGBB.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_dominant_color.py
        功能形态参考 Goohaitools「孤海-主色提取」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Color``；显示名与 DESCRIPTION 英化；
    3) ``"display": "slider"`` 改成 V3 的 ``display_mode=io.NumberDisplay.slider``；
    4) 空批次的报错从中文改英文（本包错误信息一律英文）；
    5) tooltip 补齐英文。
  保持不变：全部统计口径 —— 只取第一帧、LANCZOS 降采样（下限 4 像素）、
  平均亮度 15/240 剔除黑白边、按容差分桶、频次并列取亮度更高者。

性能：全程 numpy 向量化（布尔掩码过滤 + RGB 打包成 uint32 做 unique），
上游是 Python 逐像素循环，大图上快一个数量级。
"""

from __future__ import annotations

import numpy as np
import torch
from PIL import Image

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
DOWNSAMPLE_DEFAULT = 8
DOWNSAMPLE_MIN = 1
DOWNSAMPLE_MAX = 16
TOLERANCE_DEFAULT = 15
TOLERANCE_MIN = 0
TOLERANCE_MAX = 100
_MIN_SIDE = 4       # 降采样后宽/高的下限（与上游一致）
_DARK_CUT = 15      # 平均亮度低于此值视为黑边剔除
_BRIGHT_CUT = 240   # 平均亮度高于此值视为白边剔除


def _frame_to_rgb_uint8(frame):
    """单帧 [H, W, C] 转 uint8 RGB：0-1 浮点先放大 255，带 alpha 通道时预乘。

    通道数约定：3 通道直通；4 通道按 alpha 预乘后取 RGB（与上游
    _handle_alpha_channel 同语义，预乘到底色黑上）；1/2 通道灰度复制成
    3 通道；其余通道数超出预期时报错。
    """
    if not isinstance(frame, np.ndarray) or frame.ndim != 3:
        raise ValueError("Dominant Color expects a [H, W, C] frame.")
    channels = frame.shape[2]
    if channels == 3:
        rgb = frame[:, :, :3]
    elif channels == 4:  # RGB 与 alpha 各自归一到 0-1 再预乘，float/uint8 输入通吃
        scale = 255.0 if frame.dtype == np.uint8 else 1.0
        rgb = frame[:, :, :3].astype(np.float32) / scale * \
            frame[:, :, 3:4].astype(np.float32) / scale
    elif channels in (1, 2):
        gray = frame[:, :, :1]
        rgb = np.repeat(gray, 3, axis=2)
    else:
        raise ValueError(
            "Dominant Color cannot read %d-channel frames; expected 1 to 4."
            % channels)
    if rgb.dtype == np.uint8:  # 已是 0-255 的输入直通（预乘分支除外）
        return rgb.astype(np.uint8, copy=True)
    return np.clip(np.asarray(rgb, dtype=np.float32) * 255.0, 0, 255
                   ).astype(np.uint8)


def _downsample(rgb, factor):
    """LANCZOS 缩小到 (宽//factor, 高//factor)，两边下限 4 像素。"""
    height, width = rgb.shape[:2]
    new_w = max(width // int(factor), _MIN_SIDE)
    new_h = max(height // int(factor), _MIN_SIDE)
    if (new_w, new_h) == (width, height):
        return rgb
    img = Image.fromarray(rgb).resize((new_w, new_h), Image.Resampling.LANCZOS)
    return np.asarray(img)


def _drop_extreme_colors(pixels):
    """剔除平均亮度 <15 / >240 的黑边白边像素；全被剔时回退全部像素。"""
    mean = pixels.astype(np.float32).mean(axis=1)
    keep = (mean >= _DARK_CUT) & (mean <= _BRIGHT_CUT)
    if not keep.any():
        return pixels
    return pixels[keep]


def _quantized_dominant(pixels, tolerance):
    """容差分桶统计，返回 (主色三元组, 主色桶像素数)。

    每通道按 c // tolerance * tolerance 量化（tolerance<=0 时逐原色），
    RGB 打包成一个整数做 unique 计数；频次并列取通道和更高的桶。
    """
    tol = max(0, int(tolerance))
    if tol > 1:
        pixels = (pixels // tol) * tol
    packed = (pixels[:, 0].astype(np.uint32) << 16 |
              pixels[:, 1].astype(np.uint32) << 8 |
              pixels[:, 2].astype(np.uint32))
    values, counts = np.unique(packed, return_counts=True)
    top = counts.max()
    tied = values[counts == top]
    sums = (tied >> 16) + ((tied >> 8) & np.uint32(0xFF)) + (tied & np.uint32(0xFF))
    best = int(tied[np.argmax(sums)])
    color = ((best >> 16) & 0xFF, (best >> 8) & 0xFF, best & 0xFF)
    return color, int(top)


def extract_dominant(image, downsample, tolerance):
    """主色提取主流程，返回大写 #RRGGBB 字符串。"""
    factor = max(DOWNSAMPLE_MIN, min(int(downsample), DOWNSAMPLE_MAX))
    tolerance = max(TOLERANCE_MIN, min(int(tolerance), TOLERANCE_MAX))

    if isinstance(image, torch.Tensor):
        array = image.detach().cpu().numpy()
    else:
        array = np.asarray(image)
    # 空批次：0 帧没有「主色」概念，明确报错而不是静默返回默认色
    # （那会让下游以为真的提取到了）。
    if array.ndim == 4 and array.shape[0] == 0:
        raise ValueError(
            "Dominant Color received an empty image batch (0 frames), so there "
            "is no colour to report. Check whether an upstream node filtered "
            "every frame out.")
    frame = array[0] if array.ndim == 4 else array
    rgb = _frame_to_rgb_uint8(frame)
    rgb = _downsample(rgb, factor)

    pixels = rgb.reshape(-1, rgb.shape[2])
    pixels = _drop_extreme_colors(pixels)
    color, _count = _quantized_dominant(pixels, tolerance)
    return "#%02X%02X%02X" % color


class QGDominantColor(io.ComfyNode):
    """Extract the dominant colour of an image."""

    CATEGORY = "QG-tools/Color"
    DESCRIPTION = (
        "Report the colour that covers the most pixels as an uppercase #RRGGBB "
        "string. Downsamples first, drops near-black and near-white border "
        "pixels, then buckets colours by per-channel tolerance and takes the "
        "largest bucket (ties broken by brightness). Only the first frame is "
        "examined."
    )
    SEARCH_ALIASES = [
        "dominant", "color", "colour", "main", "average", "主色", "取色", "颜色", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_DominantColor",
            display_name="Dominant Color",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Image.Input(
                    "image",
                    tooltip="The image to analyse; only the first frame is used.",
                ),
                io.Int.Input(
                    "downsample",
                    default=DOWNSAMPLE_DEFAULT,
                    min=DOWNSAMPLE_MIN,
                    max=DOWNSAMPLE_MAX,
                    step=1,
                    display_mode=io.NumberDisplay.slider,
                    tooltip=(
                        "Shrink the image by this factor before counting, so a "
                        "few stray pixels cannot win. Larger is faster and more "
                        "tolerant; 1 keeps full resolution."
                    ),
                ),
                io.Int.Input(
                    "tolerance",
                    default=TOLERANCE_DEFAULT,
                    min=TOLERANCE_MIN,
                    max=TOLERANCE_MAX,
                    step=1,
                    display_mode=io.NumberDisplay.slider,
                    tooltip=(
                        "Per-channel bucket width for grouping near-identical "
                        "colours. 0 counts exact colours only; higher merges "
                        "shades together."
                    ),
                ),
            ],
            outputs=[
                io.String.Output(
                    "hex",
                    tooltip="The dominant colour as uppercase #RRGGBB.",
                ),
            ],
        )

    @classmethod
    def execute(cls, image, downsample=DOWNSAMPLE_DEFAULT,
                tolerance=TOLERANCE_DEFAULT):
        return io.NodeOutput(extract_dominant(image, downsample, tolerance))


NODE_CLASS_MAPPINGS = {"QG_DominantColor": QGDominantColor}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_DominantColor": "Dominant Color"}
