# -*- coding: utf-8 -*-
"""QG 数值滑条 — 一根滑条挑一个数，范围自己定。

跟「数值」节点的区别只有一个：那边是纯粹的数字框，这边多一根滑条，
而且**范围是可调的**（最小 / 最大），适合「强度 0–1」「步数 20–50」这种
有明确上下界的参数。

默认就是最常见的那个用法：0 – 1、一格 0.1、输出小数（LoRA 强度 / 权重 /
去噪强度都是这个区间）。要当计数用，把范围改成 0 – 100、步长按需调整即可。

🔴 2026-11-24：移除「整数 / 浮点」切换，本节点固定输出浮点。
``kind`` 输入**保留**（老存档的 widgets_values 有它，删掉会整体错位），
但前端不再提供切换、后端 execute 恒走浮点分支；老图纸里存的 ``integer``
会被归一成浮点，输出小数而非整数。

界面上是一张卡片一行：
    [ ====== 滑条 ====== ]  66  [齿轮]   ← 主操作，右端是当前值，齿轮紧挨着

范围（最小 / 最大）、步长都收在齿轮菜单里 —— 它们一次设好就不常动，摆在卡片上白占地方。

输出类型写 ``*`` 的理由与「数值」节点相同：类型是运行时选的，而
``RETURN_TYPES`` 是类级静态声明，改不了；真正的类型由 ``execute`` 的返回值决定。
前端**也不会**把输出槽改成 INT / FLOAT —— 那样虽然好看，却会让输出接不进
FLOAT 输入（LoRA 的强度就是 FLOAT），纯属自断出路。槽一律 ``*``。

范围的兜底在这个文件里做（而不是只靠前端）：手写 API / 别的插件塞进来的
数值超出范围时，输出仍然会被夹到 [最小, 最大]，保证「滑条拖到头的值 = 输出的值」。

只用核心模块，没有新依赖。
"""

import math

from comfy_api.latest import io

# kind 的历史取值，KINDS 保留给输入位的选项列表（老存档可能存着 integer）。
KIND_INT = "integer"
KIND_FLOAT = "float"
KINDS = [KIND_INT, KIND_FLOAT]

# 浮点对齐步长后保留的小数位：0.1 的输出要写 0.30000000000000004 就太难看了。
ROUND_DIGITS = 6


def _number(value, fallback=0.0):
    """上游接进来的可能是 numpy 数字或字符串，统一成有限 float。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _bounds(min_value, max_value):
    """上下界。填反了就交换 —— 滑条总得有个方向，报错反而挡路。"""
    low = _number(min_value, 0.0)
    high = _number(max_value, 1.0)
    if high < low:
        low, high = high, low
    return low, high


class QGSlider(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_Slider",
            display_name="Number Slider",
            category="QG-tools/Logic",
            description=(
                "One number picked on a slider whose range you set yourself — it opens as 0 "
                "to 1 in steps of 0.1, which is what a LoRA strength or a weight wants. Drag "
                "the track, or click the number to type an exact value (Enter confirms, Esc "
                "cancels). The gear at the card's right end holds the range and the step. The "
                "output is always a decimal; the socket stays untyped so it feeds a FLOAT input "
                "such as a LoRA strength. Values outside the range are clamped to it."
            ),
            inputs=[
                io.Combo.Input(
                    "kind", options=list(KINDS), default=KIND_FLOAT,
                    tooltip="Kept for old workflows only; always outputs a decimal. The step is set in the gear at the card's right end.",
                ),
                io.Float.Input(
                    "value", default=0.0, min=-1e12, max=1e12, step=0.01,
                    tooltip="The current value. Drag the track, or click the number to type it (Enter confirms, Esc cancels); values outside the range are clamped to its ends.",
                ),
                io.Float.Input(
                    "min_value", default=0.0, min=-1e12, max=1e12, step=0.01,
                    tooltip="The track's left end, the lowest value you can pick. Swapped automatically when it sits above the max.",
                ),
                io.Float.Input(
                    "max_value", default=1.0, min=-1e12, max=1e12, step=0.01,
                    tooltip="The track's right end, the highest value you can pick. Swapped automatically when it sits below the min.",
                ),
                io.Float.Input(
                    "step", default=0.1, min=0.000001, max=1000.0, step=0.000001,
                    tooltip="How far one step moves. 0.1 gives one decimal place.",
                ),
            ],
            outputs=[
                io.AnyType.Output(
                    id="value",
                    tooltip="The value on the slider, clamped to its range and aligned to the step. Always a decimal.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, kind=None):
        # 老存档可能存着中文选项值或 integer；kind 已不再参与输出，一律放行。
        return True

    @classmethod
    def execute(cls, kind=KIND_FLOAT, value=0.0, min_value=0.0, max_value=1.0, step=0.1):
        # 2026-11-24 起固定浮点：kind 输入位保留只为老存档不错位，
        # 无论它存的是 float 还是 integer，都不再走整数分支。
        low, high = _bounds(min_value, max_value)
        number = min(high, max(low, _number(value)))

        size = _number(step, 0.1)
        if size > 0:
            number = low + round((number - low) / size) * size
            number = min(high, max(low, round(number, ROUND_DIGITS)))
        return io.NodeOutput(float(number))


NODE_CLASS_MAPPINGS = {"QG_Slider": QGSlider}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Slider": "Number Slider"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
