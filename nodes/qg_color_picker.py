# -*- coding: utf-8 -*-
"""QG_ColorPicker — pick one colour from a swatch, emit it as value plus string.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_color_picker.py
        功能形态参考 Goohaitools「孤海 取色器」（GPL-3.0），代码为独立实现。
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Color``；
    3) 显示名与 DESCRIPTION 英化（本包 verify_bilingual 硬判据）；
    4) tooltip 补齐英文（源文件没有 tooltip）。
  保持不变：``normalize_color`` / ``to_rgb_string`` / ``to_hsl_string`` 的
  算法与输出口径逐字不变 —— HEX 大写、RGB/HSL 逗号后带一个空格，与孤海
  取色器一致，下游解析器按这个格式写的，不要动。

与 QG_ColorConvert 的分工：
  * QG_ColorConvert 是中间转换节点 —— 吃任意写法的色值字符串，转成目标格式；
  * 本节点是颜色源节点 —— 直接拖出来点色块选色，按模式输出，作为工作流起点。

图形化色块与弹出色板由前端 ``web/color_picker/index.js`` 接管（后端值仍是
STRING，老工作流与 API 调用都不受影响）。
"""

from __future__ import annotations

import colorsys
import re

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
MODE_CHOICES = ["HEX", "RGB", "HSL"]
DEFAULT_COLOR = "#213d50"

_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def normalize_color(value):
    """校验并规范化颜色：仅接受带 # 的 3/6 位十六进制，非法回退默认色。"""
    text = str(value if value is not None else "").strip().lower()
    return text if _HEX_RE.match(text) else DEFAULT_COLOR


def _hex_to_rgb01(value):
    """3/6 位 #hex 转 0-1 浮点三元组。"""
    code = value[1:]
    if len(code) == 3:
        code = "".join(c * 2 for c in code)
    return tuple(int(code[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def to_rgb_string(value):
    """#rrggbb → 'r, g, b'（逗号后带空格，与孤海取色器一致）。"""
    r, g, b = _hex_to_rgb01(value)
    return "%d, %d, %d" % (
        int(min(max(r * 255.0, 0.0), 255.0)),
        int(min(max(g * 255.0, 0.0), 255.0)),
        int(min(max(b * 255.0, 0.0), 255.0)),
    )


def to_hsl_string(value):
    """#rrggbb → 'h, s%, l%'（整数 H/S/L，逗号后带空格）。"""
    r, g, b = _hex_to_rgb01(value)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return "%d, %d%%, %d%%" % (
        int(round((h * 360.0) % 360.0)),
        int(round(s * 100.0)),
        int(round(l * 100.0)),
    )


class QGColorPicker(io.ComfyNode):
    """Pick a colour and emit it as a normalised value plus a formatted string."""

    CATEGORY = "QG-tools/Color"
    DESCRIPTION = (
        "Click the swatch to pick a colour; emits a normalised control value "
        "(lowercase #rgb as typed, 3 or 6 digits) and a formatted string in "
        "HEX (uppercase), RGB or HSL. Invalid values fall back to #213d50 "
        "instead of passing a dirty string downstream."
    )
    SEARCH_ALIASES = [
        "color", "colour", "picker", "hex", "rgb", "hsl", "取色", "颜色", "色板", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ColorPicker",
            display_name="Color Picker",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "color",
                    default=DEFAULT_COLOR,
                    tooltip=(
                        "The colour itself. Click the swatch to pick one; typing "
                        "#rgb or #rrggbb by hand works too."
                    ),
                ),
                io.Combo.Input(
                    "mode",
                    options=list(MODE_CHOICES),
                    default="HEX",
                    tooltip=(
                        "Format of the string output: HEX gives uppercase #RRGGBB, "
                        "RGB gives 'r, g, b', HSL gives 'h, s%, l%'."
                    ),
                ),
            ],
            outputs=[
                io.String.Output(
                    "color_control",
                    tooltip=(
                        "Normalised colour value (lowercase, keeps the 3- or "
                        "6-digit form as typed) for colour inputs and pickers."
                    ),
                ),
                io.String.Output(
                    "string",
                    tooltip=(
                        "The colour formatted per mode: uppercase HEX, "
                        "'r, g, b', or 'h, s%, l%'."
                    ),
                ),
            ],
        )

    @classmethod
    def execute(cls, color, mode):
        value = normalize_color(color)
        if mode == "RGB":
            text = to_rgb_string(value)
        elif mode == "HSL":
            text = to_hsl_string(value)
        else:  # HEX, including any unknown mode as a fallback
            text = value.upper()
        return io.NodeOutput(value, text)


NODE_CLASS_MAPPINGS = {"QG_ColorPicker": QGColorPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorPicker": "Color Picker"}
