# -*- coding: utf-8 -*-
"""QG 数值 — 一个数字，可以当整数用，也可以当浮点数用。

ComfyUI 自带的 primitive 把字符串、整数、浮点塞在同一个节点里；这里的取舍是
反过来的：一个节点只放**一个数字**。界面上就是一张卡片里的一行：左边小字
「值」，右边一个可拖、可点、可滚的数字框；类型（整数 / 浮点）走标题栏 `?` 左边
那枚齿轮的菜单，不占卡片的位置。

后端仍然留两个控件（`kind` + `value`）：前端把两个都藏起来，但 `widgets_values`
的顺位不变，存档、撤销、API 导出都跟普通数字节点一致。

为什么输出类型写 ``*``：类型是运行时选的，而 ``RETURN_TYPES`` 是类级静态声明，
改不了。``*`` 在 ComfyUI 里是「任意类型」，接 INT 或 FLOAT 输入都能过校验；
真正的类型由 ``execute`` 的返回值决定（整数就回 int，浮点就回 float）。
前端 ``web/number/index.js`` 只负责把输出槽的**显示**类型跟着类型改，方便一眼
看出来当前给的是整数还是小数。

只用核心模块，没有新依赖。
"""

KIND_INT = "\u6574\u6570"      # 整数
KIND_FLOAT = "\u6d6e\u70b9\u6570"  # 浮点数
KINDS = [KIND_INT, KIND_FLOAT]

INT32_MIN = -2147483648
INT32_MAX = 2147483647


class QGNumber:
    CATEGORY = "QG-tools/\u903b\u8f91"
    DESCRIPTION = (
        "One number, either an integer or a decimal. The card shows a label "
        "and a number box you can drag, click and type in; the gear in the "
        "title bar (left of the ?) switches between integer and decimal. The "
        "output type follows that choice, so it can feed either an INT input "
        "or a FLOAT input."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "kind": (KINDS, {
                    "default": KIND_INT,
                    "tooltip": "这个数字是整数还是浮点数。在标题栏 `?` 左边的齿轮里"
                               "切换；换成整数时小数部分会被四舍五入掉。",
                }),
                # 存小数：整数模式只是显示 / 输出时取整，控件本身始终是 FLOAT，
                # 这样从整数切回浮点不用换控件，存档结构也不会变。
                # 🔴 step 必须和浮点模式的小数位对齐（0.01 ↔ 两位）：
                #    前端 RULES 会按这一格取整，写成 0.1 的话输入 1.25 会被吃成 1.3。
                "value": ("FLOAT", {
                    "default": 0.0,
                    "min": -1e12,
                    "max": 1e12,
                    "step": 0.01,
                    "tooltip": "数值。左右拖动改，单击可以直接输入，右边的上下箭头"
                               "按步进调（按住 Shift 是细步进）；整数模式下按 1 走。",
                }),
            }
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("value",)
    FUNCTION = "execute"

    def execute(self, kind=KIND_INT, value=0.0):
        # 上游接进来的可能是 numpy 数字，先统一成 Python float 再分流。
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = 0.0
        if kind == KIND_FLOAT:
            return (number,)
        # 整数模式：四舍五入后夹到 INT32，免得下游拿到 1e12 这种非法值。
        return (max(INT32_MIN, min(INT32_MAX, int(round(number)))),)


NODE_CLASS_MAPPINGS = {"QG_Number": QGNumber}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Number": "\u6570\u503c"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
