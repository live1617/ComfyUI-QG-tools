# -*- coding: utf-8 -*-
"""QG 数值滑条 — 一根滑条挑一个数，范围自己定。

跟「数值」节点的区别只有一个：那边是纯粹的数字框，这边多一根滑条，
而且**范围是可调的**（最小 / 最大），适合「强度 0–1」「步数 20–50」这种
有明确上下界的参数。

默认就是最常见的那个用法：0 – 1、一格 0.1、输出小数（LoRA 强度 / 权重 /
去噪强度都是这个区间）。要当计数用，在齿轮里把范围改成 0 – 100、类型改成整数。

界面上是一张卡片一行：
    [ ====== 滑条 ====== ]  66  [齿轮]   ← 主操作，右端是当前值，齿轮紧挨着

范围（最小 / 最大）、类型（整数 / 浮点数）、步长都收在齿轮菜单里 —— 它们一次
设好就不常动，摆在卡片上白占地方。整数模式下步长固定 1、小数会被四舍五入掉，
浮点模式下步长在齿轮里调。

输出类型写 ``*`` 的理由与「数值」节点相同：类型是运行时选的，而
``RETURN_TYPES`` 是类级静态声明，改不了；真正的类型由 ``execute`` 的返回值决定。
前端**也不会**把输出槽改成 INT / FLOAT —— 那样虽然好看，却会让整数模式下的
输出接不进 FLOAT 输入（LoRA 的强度就是 FLOAT），纯属自断出路。槽一律 ``*``，
当前是整数还是小数看卡片右端读数（小数模式带小数位）。

范围的兜底在这个文件里做（而不是只靠前端）：手写 API / 别的插件塞进来的
数值超出范围时，输出仍然会被夹到 [最小, 最大]，保证「滑条拖到头的值 = 输出的值」。

只用核心模块，没有新依赖。
"""

import math
from ._qg_combo_legacy import combo_legacy

KIND_INT = "integer"
KIND_FLOAT = "float"
KINDS = [KIND_INT, KIND_FLOAT]

INT32_MIN = -2147483648
INT32_MAX = 2147483647

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


@combo_legacy("QG_Slider")
class QGSlider:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "One number picked on a slider whose range you set yourself — it opens as 0 "
        "to 1 in steps of 0.1, which is what a LoRA strength or a weight wants. Drag "
        "the track, or click the number to type an exact value (Enter confirms, Esc "
        "cancels). The gear at the card's right end holds the range, the step, and "
        "the choice between integer and decimal — an integer output steps by 1 and "
        "drops the decimals, a decimal one steps by the step set there. The socket "
        "stays untyped, so the output feeds an INT input as well as a FLOAT one (a "
        "LoRA strength, say) in either mode. Values outside the range are clamped to "
        "it."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, kind=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "kind": (KINDS, {
                    "default": KIND_FLOAT,
                    "tooltip": "Whether the output is an integer or a decimal. Switch it in the gear at the card's right end; integer mode fixes the step at 1 and rounds the decimals away.",
                }),
                # 存小数：整数模式只是显示 / 输出时取整，控件本身始终是 FLOAT，
                # 这样切模式不用换控件，存档结构也不会变。
                # 🔴 step 必须和浮点模式的小数位对齐（0.01 ↔ 两位）：
                #    前端会按这一格取整，写成 0.1 的话输入 1.25 会被吃成 1.3。
                "value": ("FLOAT", {
                    "default": 0.0,
                    "min": -1e12,
                    "max": 1e12,
                    "step": 0.01,
                    "tooltip": "The current value. Drag the track, or click the number to type it (Enter confirms, Esc cancels); values outside the range are clamped to its ends.",
                }),
                "min_value": ("FLOAT", {
                    "default": 0.0,
                    "min": -1e12,
                    "max": 1e12,
                    "step": 0.01,
                    "tooltip": "The track's left end, the lowest value you can pick. Swapped automatically when it sits above the max.",
                }),
                "max_value": ("FLOAT", {
                    "default": 1.0,
                    "min": -1e12,
                    "max": 1e12,
                    "step": 0.01,
                    "tooltip": "The track's right end, the highest value you can pick. Swapped automatically when it sits below the min.",
                }),
                "step": ("FLOAT", {
                    "default": 0.1,
                    "min": 0.000001,
                    "max": 1000.0,
                    "step": 0.000001,
                    "tooltip": "How far one step moves in decimal mode (integer mode is fixed at 1 and ignores this). 0.1 gives one decimal place.",
                }),
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "execute"

    def execute(self, kind=KIND_FLOAT, value=0.0, min_value=0.0, max_value=1.0, step=0.1):
        low, high = _bounds(min_value, max_value)
        number = min(high, max(low, _number(value)))

        if kind == KIND_FLOAT:
            # 对齐步长：滑条只能停在一格一格上，光靠 UI 对齐的话，
            # 别人手写 API 塞进来的 0.37 会跟界面显示不一致。
            size = _number(step, 0.1)
            if size > 0:
                number = low + round((number - low) / size) * size
                # 一个格子跨到另一端外面时，round 会把它顶出去，再夹一次
                number = min(high, max(low, round(number, ROUND_DIGITS)))
            return (float(number),)

        # 整数模式：四舍五入后夹到 INT32，免得下游拿到 1e12 这种非法值。
        # 🔴 用 floor(x + 0.5) 而不是 Python 的 round()：后者是银行家舍入
        #    （round(0.5) == 0、round(2.5) == 2），跟前端 Math.round 不一致 ——
        #    卡片上显示 1、输出却是 0，是最难查的那种不一致。
        # 范围两端也取整成整数（0.5–3.7 只可能给 1..3）；范围窄到装不下一个
        # 整数时（0.2–0.8），退回两端的中点，至少能出个数而不是空范围。
        low_i, high_i = int(math.ceil(low)), int(math.floor(high))
        if high_i < low_i:
            low_i = high_i = int(math.floor((low + high) / 2 + 0.5))
        rounded = max(low_i, min(high_i, int(math.floor(number + 0.5))))
        return (max(INT32_MIN, min(INT32_MAX, rounded)),)


NODE_CLASS_MAPPINGS = {"QG_Slider": QGSlider}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Slider": "Number Slider"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
