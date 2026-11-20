# -*- coding: utf-8 -*-
"""QG_ColorImage —— 按指定颜色生成一张纯色图像。

功能对位 LayerStyle「图层工具：纯色图像_V2」(LayerUtility: ColorImage V2)
的节点形态与参数，但**代码完全自写**：不引 PIL / numpy，纯 torch 生成张量。
尺寸有三个来源，优先级从高到低：

  1. ``size_as`` 接了任意带形状的输入（图像 / 遮罩 / latent 等）→ 取它的宽高；
  2. ``size`` 选了某个预设档（如 ``1024x1024``）→ 用该档宽高；
  3. ``size`` = ``custom`` → 用自定义宽 / 高。

参考实现从 ``custom_size.ini`` 读档位，本机无该文件；本节点把常用档位内置进
下拉，仍保留 ``custom`` 走自定义宽高，参数形态与参考一致。

颜色是 ``#RRGGBB`` 字符串（也收 3 位 ``#RGB``、不带 # 的写法），按 0..1
浮点填进 float32 张量，可直接喂任何吃 IMAGE 的节点。

V3 migration (2026-11-19): V1 -> V3 via ``io.ComfyNode``. Schema is built in
``define_schema``; ``execute`` is a classmethod returning ``io.NodeOutput``.
The ``@combo_legacy`` decorator is dropped (it wraps ``cls.FUNCTION``, which
in V3 is the base class's ``EXECUTE_NORMALIZED``) and replaced by an explicit
``coerce()`` call at the top of ``execute``, preserving legacy Chinese combo
values from saved workflows. ``validate_inputs`` is the V3 spelling of the old
``VALIDATE_INPUTS``. ``size_as`` is an any-type optional input, which V3 writes
as ``io.AnyType.Input(optional=True)`` to keep the ``"*"`` contract.
"""

import re

import torch

from comfy_api.latest import io

from ._qg_combo_legacy import coerce


# 下拉值：custom 走自定义宽高，档位值形如 "1024x1024"（是数据不是文案）。
SIZE_PRESETS = (
    "custom",
    "256x256", "512x512", "768x768", "1024x1024",
    "512x768", "768x512", "768x1024", "1024x768",
    "1024x1536", "1536x1024",
)
_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_SIZE = re.compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$")


def _parse_color(value):
    """``#RRGGBB`` / ``#RGB`` -> (r, g, b) 0..1；其它写法报英文错。"""
    text = str(value).strip() if value is not None else ""
    match = _HEX.match(text)
    if not match:
        raise ValueError(
            "Color Image: expected a hex colour like '#RRGGBB' or '#RGB', got %r."
            % (value,)
        )
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    return tuple(int(digits[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _shape_size(value):
    """从任意输入里取宽高：IMAGE [B,H,W,C] / MASK [B,H,W] / latent dict。"""
    if value is None:
        return None
    if isinstance(value, dict):
        # LATENT 的 samples 是 [B,C,H,W]，通道在第二维；IMAGE 是 [B,H,W,C]。
        # 这里单独处理，不能掉进下面的 4 维 IMAGE 分支。
        samples = value.get("samples")
        if samples is None or not hasattr(samples, "shape") or len(samples.shape) < 4:
            return None
        return int(samples.shape[3]), int(samples.shape[2])
    if not hasattr(value, "shape"):
        return None
    shape = tuple(value.shape)
    if len(shape) >= 4:   # IMAGE [B,H,W,C] 或 [B,C,H,W]
        return int(shape[2]), int(shape[1])
    if len(shape) == 3:   # MASK [B,H,W]（单帧 [H,W,C] 也按此读）
        return int(shape[2]), int(shape[1])
    if len(shape) == 2:   # 单帧 MASK [H,W]
        return int(shape[1]), int(shape[0])
    return None


class QGColorImage(io.ComfyNode):
    CATEGORY = "QG-tools/Image"

    DESCRIPTION = (
        "Generates a solid-colour image. Size comes from three sources in "
        "order: if Size As is connected, the width and height of that input "
        "(image, mask or latent) are used; otherwise a preset size such as "
        "1024x1024 is used; otherwise the Custom Width and Custom Height are "
        "used when Size is set to custom. Colour is a hex string like "
        "'#RRGGBB' (short '#RGB' also works). The result is a float32 IMAGE "
        "filled entirely with that colour, ready to feed any image node."
    )
    SEARCH_ALIASES = [
        "color image", "colour image", "solid color", "solid colour",
        "solid color image", "blank image", "background color", "fill color",
        "纯色图像", "纯色图", "生成纯色", "颜色图像", "背景色", "纯色底",
    ]
    OUTPUT_NODE = False

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ColorImage",
            display_name="Solid Color Image",
            category="QG-tools/Image",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Combo.Input(
                    "size",
                    options=list(SIZE_PRESETS),
                    default="custom",
                    tooltip="Output size: a preset like 1024x1024, or custom to use the two fields below.",
                ),
                io.Int.Input(
                    "custom_width", default=512, min=4, max=99999, step=1,
                    tooltip="Width when Size is custom. Ignored when Size As is connected.",
                ),
                io.Int.Input(
                    "custom_height", default=512, min=4, max=99999, step=1,
                    tooltip="Height when Size is custom. Ignored when Size As is connected.",
                ),
                io.String.Input(
                    "color", default="#000000",
                    tooltip="The fill colour as a hex string, e.g. #RRGGBB or #RGB.",
                ),
                io.AnyType.Input(
                    "size_as", optional=True,
                    tooltip="Optional image, mask or latent: its width and height are used, overriding Size.",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image",
                    tooltip="A solid-colour image of the requested size.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, size=None):
        # Name the combo so ComfyUI skips its list check; coerce() in execute
        # handles any legacy value before execution.
        return True

    @classmethod
    def execute(cls, size="custom", custom_width=512, custom_height=512,
                color="#000000", size_as=None):
        # 🔴 V3 不能套 @combo_legacy（它按 cls.FUNCTION 找方法，而 V3 的 FUNCTION
        # 是基类给的 EXECUTE_NORMALIZED）。直接在这里 coerce，语义与 V1 装饰器一致。
        size = coerce("QG_ColorImage", "size", size)
        width, height = int(custom_width), int(custom_height)
        from_reference = _shape_size(size_as)
        if from_reference is not None:
            width, height = from_reference
        elif str(size) != "custom":
            match = _SIZE.match(str(size))
            if match:
                width, height = int(match.group(1)), int(match.group(2))
        width, height = max(4, width), max(4, height)

        red, green, blue = _parse_color(color)
        image = torch.empty((1, height, width, 3), dtype=torch.float32)
        image[..., 0] = red
        image[..., 1] = green
        image[..., 2] = blue
        return io.NodeOutput(image)


NODE_CLASS_MAPPINGS = {"QG_ColorImage": QGColorImage}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ColorImage": "Solid Color Image"}
