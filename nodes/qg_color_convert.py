# -*- coding: utf-8 -*-
"""QG_ColorConvert — parse any colour notation, re-emit it in a chosen format.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_color_convert.py
        功能形态参考 Goohaitools「孤海 颜色转换」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Color``；显示名与 DESCRIPTION 英化；
    3) tooltip 补齐英文（格式说明从中文注释搬进英文 tooltip）。
  保持不变：``parse_color`` 的四种写法识别（hex / RGB 整数 / HSL 百分比 /
  0-1 浮点）、全角转半角、解析失败回退白色，以及 ``to_hex`` 的输出口径。

与 QG_ColorPicker 的分工：本节点是中间转换器（吃任意写法、按目标格式出），
取色器是颜色源（点色块选色）。
"""

from __future__ import annotations

import colorsys
import re

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
FORMAT_CHOICES = ["#HEX", "HEX", "RGB", "HSL"]
DEFAULT_COLOR = "#FFFFFF"

_FULLWIDTH_MAP = {
    "，": ",",
    "（": "(",
    "）": ")",
    "　": " ",
}

_HEX_RE = re.compile(r"^#?([0-9a-f]{3}|[0-9a-f]{6})$")
_RGB_RE = re.compile(r"^\(?([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3})\)?$")
_HSL_RE = re.compile(r"^\(?([0-9]{1,3}),([0-9]{1,3})%,([0-9]{1,3})%\)?$")
_FLOAT_RE = re.compile(
    r"^(?:0(?:\.[0-9]+)?|1(?:\.0+)?),(?:0(?:\.[0-9]+)?|1(?:\.0+)?),"
    r"(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$"
)


def _clean(text):
    """归一化输入：转小写、全角转半角、去掉所有空白。"""
    text = str(text if text is not None else "").strip().lower()
    for full, half in _FULLWIDTH_MAP.items():
        text = text.replace(full, half)
    return re.sub(r"\s+", "", text)


def _hex_to_rgb01(hex_code):
    """6 位 hex 转 0-1 浮点三元组（3 位在正则后已展开）。"""
    r = int(hex_code[0:2], 16) / 255.0
    g = int(hex_code[2:4], 16) / 255.0
    b = int(hex_code[4:6], 16) / 255.0
    return (r, g, b)


def parse_color(text):
    """把多种颜色写法解析成 0-1 浮点三元组，失败回退白色。"""
    text = _clean(text)

    m = _HEX_RE.match(text)
    if m:
        code = m.group(1)
        if len(code) == 3:
            code = "".join(c * 2 for c in code)
        return _hex_to_rgb01(code)

    m = _RGB_RE.match(text)
    if m:
        channels = [int(v) for v in m.groups()]
        if all(0 <= v <= 255 for v in channels):
            return tuple(v / 255.0 for v in channels)

    m = _HSL_RE.match(text)
    if m:
        h = int(m.group(1)) / 360.0
        s = int(m.group(2)) / 100.0
        l = int(m.group(3)) / 100.0
        return colorsys.hls_to_rgb(h, l, s)

    m = _FLOAT_RE.match(text)
    if m:
        parts = [float(v) for v in text.split(",")]
        if all(0.0 <= v <= 1.0 for v in parts):
            return tuple(parts)

    return (1.0, 1.0, 1.0)


def rgb_to_hsl360(r, g, b):
    """0-1 浮点 RGB 转 (0-360, 0-100, 0-100) 整数 HSL。"""
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return (
        int(round((h * 360.0) % 360.0)),
        int(round(s * 100.0)),
        int(round(l * 100.0)),
    )


def to_hex(r, g, b, with_hash=True):
    """0-1 浮点 RGB 转小写十六进制，with_hash 控制是否带 # 前缀。"""
    channels = [int(min(max(v * 255.0, 0.0), 255.0)) for v in (r, g, b)]
    code = "%02x%02x%02x" % tuple(channels)
    return ("#" + code) if with_hash else code


def normalize_hex(value, fallback="#000000"):
    """把任意可解析输入统一成小写 #rrggbb（颜色控件输出槽专用）。"""
    rgb = parse_color(value)
    return to_hex(*rgb, with_hash=True) if _clean(value) else fallback


class QGColorConvert(io.ComfyNode):
    """Convert a colour between hex, RGB, HSL and 0-1 float notations."""

    CATEGORY = "QG-tools/Color"
    DESCRIPTION = (
        "Parse a colour written as #hex, hex, RGB integers, HSL percentages or "
        "0-1 floats, then re-emit it in the chosen format plus a normalised "
        "lowercase hex for colour widgets. Full-width punctuation is accepted; "
        "anything unparseable falls back to white rather than passing a dirty "
        "string downstream."
    )
    SEARCH_ALIASES = [
        "color", "colour", "convert", "hex", "rgb", "hsl", "颜色转换", "色值", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ColorConvert",
            display_name="Color Convert",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "color",
                    default=DEFAULT_COLOR,
                    tooltip=(
                        "Any of: #abc / abc / #aabbcc / '255,128,0' / "
                        "'120,80%,50%' / '1,0.5,0'. Whitespace is ignored."
                    ),
                ),
                io.Combo.Input(
                    "format",
                    options=list(FORMAT_CHOICES),
                    default="#HEX",
                    tooltip=(
                        "Output notation: #HEX with the hash, HEX without it, "
                        "'r,g,b' integers, or 'h,s%,l%' percentages."
                    ),
                ),
            ],
            outputs=[
                io.String.Output(
                    "string",
                    tooltip="The colour rewritten in the chosen format.",
                ),
                io.String.Output(
                    "color_control",
                    tooltip="Normalised lowercase #rrggbb for colour inputs.",
                ),
            ],
        )

    @classmethod
    def execute(cls, color, format):
        if format not in FORMAT_CHOICES:
            format = FORMAT_CHOICES[0]
        r, g, b = parse_color(color)

        if format == "#HEX":
            result = to_hex(r, g, b, with_hash=True)
        elif format == "HEX":
            result = to_hex(r, g, b, with_hash=False)
        elif format == "RGB":
            result = "%d,%d,%d" % (
                int(min(max(r * 255.0, 0.0), 255.0)),
                int(min(max(g * 255.0, 0.0), 255.0)),
                int(min(max(b * 255.0, 0.0), 255.0)),
            )
        else:  # HSL
            h, s, l = rgb_to_hsl360(r, g, b)
            result = "%d,%d%%,%d%%" % (h, s, l)

        control = to_hex(r, g, b, with_hash=True)
        return io.NodeOutput(result, control)


NODE_CLASS_MAPPINGS = {"QG_ColorConvert": QGColorConvert}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorConvert": "Color Convert"}
