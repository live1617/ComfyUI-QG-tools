# -*- coding: utf-8 -*-
"""QG_DualColorPicker — one colour mode plus two hex colours, three outputs.

搬入说明（2026-11-25，用户确认后搬入）
  来源：作者自有插件 ComfyUI-QG-Multipack v2.22.13 / qg_dual_color_picker.py
  改了什么：
    1) V1 -> V3：``io.ComfyNode`` + ``define_schema`` + ``io.NodeOutput``；
    2) CATEGORY「QG 工具」-> ``QG-tools/Color``；显示名与 DESCRIPTION 英化；
    3) ``mode`` 输出改成 ``io.Combo.Output(options=...)`` —— 源包 V1 版本靠
       ``RETURN_TYPES`` 第一槽直接塞 options 列表 + 前端把槽类型改成 "COMBO"
       才连得上下游；V3 的 Combo 输出自带 options，不需要那段前端 hack；
    4) tooltip 补齐英文。
  保持不变：``normalize_hex`` 的解析口径，以及它作为 ``qg_custom_color``
  的公共工具这一角色（两个节点共用同一套色值规范化）。

后端颜色值仍是 STRING：存档与 API 里就是 "#213d50" 这种可读字符串，色块与
色板由前端 ``web/color_picker/index.js`` 接管。模式值一律英文，中文显示走
``web/shared/combo_zh.mjs``。
"""

from __future__ import annotations

from comfy_api.latest import io

# 模块级常量不写类型标注：开发规范 §5（AST 扫描器只收 ast.Assign）
MODE_CHOICES = ["solid", "vertical_gradient", "radial_gradient"]

_HEX_DIGITS = frozenset("0123456789abcdef")
DEFAULT_PRIMARY = "#213d50"
DEFAULT_SECONDARY = "#402633"


def normalize_hex(value, fallback="#000000"):
    """把多种写法统一成小写 #rrggbb。

    接受：#rgb / #rrggbb / #rrggbbaa / 无 # 前缀 / (r, g, b) 元组。
    非法输入回退到 fallback，绝不把脏字符串透传给下游节点。
    """
    if isinstance(value, (tuple, list)) and len(value) >= 3:
        try:
            channels = []
            for raw in value[:3]:
                num = int(raw)
                channels.append(max(0, min(255, num)))
            return "#%02x%02x%02x" % tuple(channels)
        except (TypeError, ValueError):
            return fallback

    text = str(value if value is not None else "").strip().lower()
    if text.startswith("#"):
        text = text[1:]

    if len(text) == 3 and all(c in _HEX_DIGITS for c in text):
        text = "".join(c * 2 for c in text)

    if len(text) >= 6 and all(c in _HEX_DIGITS for c in text[:6]):
        return "#" + text[:6]
    return fallback


class QGDualColorPicker(io.ComfyNode):
    """Pick a colour mode plus a primary and a secondary colour."""

    CATEGORY = "QG-tools/Color"
    DESCRIPTION = (
        "One dropdown for the colour mode and two swatches for the primary and "
        "secondary colours. Emits the mode plus both colours normalised to "
        "lowercase #rrggbb, ready to feed QG_CustomColor or any string colour "
        "input."
    )
    SEARCH_ALIASES = [
        "color", "colour", "dual", "pair", "gradient", "双色", "取色", "颜色", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_DualColorPicker",
            display_name="Dual Color Picker",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Combo.Input(
                    "mode",
                    options=list(MODE_CHOICES),
                    default="solid",
                    tooltip=(
                        "Colour mode to hand downstream: solid, vertical_gradient "
                        "or radial_gradient. Values match QG_CustomColor."
                    ),
                ),
                io.String.Input(
                    "primary_color",
                    default=DEFAULT_PRIMARY,
                    tooltip=(
                        "The main colour. Click the swatch to pick one; typing "
                        "#rgb or #rrggbb by hand works too."
                    ),
                ),
                io.String.Input(
                    "secondary_color",
                    default=DEFAULT_SECONDARY,
                    tooltip=(
                        "The second colour, used by gradient modes. Click the "
                        "swatch to pick one."
                    ),
                ),
            ],
            outputs=[
                io.Combo.Output(
                    "mode",
                    options=list(MODE_CHOICES),
                    tooltip="The chosen mode, wireable to any combo input.",
                ),
                io.String.Output(
                    "primary_color",
                    tooltip="Primary colour as lowercase #rrggbb.",
                ),
                io.String.Output(
                    "secondary_color",
                    tooltip="Secondary colour as lowercase #rrggbb.",
                ),
            ],
        )

    @classmethod
    def execute(cls, mode, primary_color, secondary_color):
        if mode not in MODE_CHOICES:
            mode = MODE_CHOICES[0]
        return io.NodeOutput(
            mode,
            normalize_hex(primary_color, DEFAULT_PRIMARY),
            normalize_hex(secondary_color, DEFAULT_SECONDARY),
        )


NODE_CLASS_MAPPINGS = {"QG_DualColorPicker": QGDualColorPicker}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_DualColorPicker": "Dual Color Picker"}
