# -*- coding: utf-8 -*-
"""QG 数学运算 —— 写一行表达式，a–z 变量随便用。

为什么不是「两个下拉 + 两输入」那种四则节点：真正要用运算的地方往往是
「宽按高度算」「步数按总帧数除」，一行 ``round(a / b * 2, 2)`` 就够了，
比接三个节点省地方，也不会因为中间结果被四舍五入掉两次。

卡片上只有一行：表达式。变量 a、b、c… 是节点左侧的输入槽，只从上游连线取，
默认露 3 个空槽、接满一个就自己长出下一个（最多到 z），没连线按 0 算，
所以常数直接写进表达式，不用另开一排数字框。
表达式里能用的东西写在节点 ``?`` 的帮助卡里，也在这份文件的 DESCRIPTION。

安全性由 ``_qg_math_engine`` 负责：表达式先解析成语法树，再按白名单逐节点算，
不走 Python 的动态求值通道。算不出来（语法错、未知名字、除零、参数不对）会抛
ValueError，ComfyUI 的红框里带着原始表达式和原因，比静默返回 0 好排查。

输出四个槽，都是同一个结果的不同形态：
    数值 FLOAT   —— 原样
    整数 INT     —— 四舍五入（正好 .5 时远离零）后夹到 INT32
    布尔 BOOLEAN —— 非零为真（比较表达式 ``a > b`` 直接拿来当条件用）
    文本 STRING  —— 数字按人读的样子写（1024 而不是 1024.0），文本原样

结果本身也可以是文本：``a + ", best quality"`` 这类拼接、``upper(a)`` 这类
变换都直接返回字符串，此时前三个数字输出给 0 / 0 / False，免得下游把一段
算不上数的文字当尺寸用。

只用标准库，没有新依赖。
"""

import string

from ._qg_math_engine import (
    MathError,
    evaluate,
    format_number,
    round_half_away,
    to_value,
)

# 变量名跟官方「数学表达式」一样：a–z，接满一个就自己长下一个。
# 前端只把前面几个放出来（默认 3 个空槽），剩下的一律隐藏 ——
# 所以这里声明全部 26 个，界面上并不长。
VARIABLES = tuple(string.ascii_lowercase)

INT32_MIN = -2147483648
INT32_MAX = 2147483647

# 帮助卡里那段语法速查。走 DESCRIPTION，前端 `?` 直接读 schema 渲染，
# 不用单独写一份说明 —— 改了这里，界面上的帮助就跟着变。
# 🔴 这里**不要再讲变量**：变量的说明只在 DESCRIPTION 开头留一条，
#    两处各写一遍会出现「一段蓝字重复两遍」（用户按截图打回过）。
_EXPRESSION_HELP = (
    "Expression: a + b * 2. Operators + - * / // % **; comparisons == != > < >= <=, "
    "in and not in; and or not; a if a > b else b; constant pi, e, tau. Functions: abs "
    "round min max sum pow int float bool; sqrt exp log log2 log10; sin cos tan asin "
    "acos atan atan2 sinh cosh tanh; floor ceil trunc; hypot degrees radians; factorial "
    "gcd lcm sign fmod fabs copysign dist prod fsum isnan isinf isfinite. Note: ^ is "
    "bitwise xor, use ** for powers. Text: write it in quotes and join with +, repeat "
    "with *; index and slice with [ ] such as a[0] or a[1:4]; functions str len upper "
    "lower title capitalize swapcase strip lstrip rstrip replace split join find rfind "
    "count startswith endswith zfill. A variable that arrives as text is used as a "
    "number when the whole string is a number, otherwise as text."
)


class QGMath:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "One expression over variables a to z, for numbers or for text. Type a "
        "formula such as round(a / b * 2, 2) or a + \", best quality\" on the card. "
        "Variables a, b, c\u2026 are wire-only inputs: three slots show up first and "
        "the next one appears as soon as the last is connected (up to z); they take "
        "integers, floats, booleans or text, and an unwired slot counts as 0, so any "
        "constant goes straight into the expression. A variable that arrives as text "
        "counts as a number when the whole string is a number, otherwise it stays "
        "text. "
        "Outputs the result four ways: as a decimal, as an integer rounded to the "
        "nearest whole number (halves go away from zero, so 2.5 becomes 3), as a "
        "boolean (non-zero is true), and as text (a number is written the way you "
        "would write it, 1024 rather than 1024.0). When the expression produces "
        "text the three numeric outputs are 0, 0 and false. Expressions are parsed, "
        "never executed, which keeps a shared workflow from running code. Every "
        "function with an example: "
        "https://github.com/live1617/ComfyUI-QG-tools/blob/main/docs/math.md . "
        + _EXPRESSION_HELP
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "expr": ("STRING", {
                    "default": "a + b",
                    "multiline": False,
                    # 🔴 变量怎么接、常数写哪里统一放 DESCRIPTION（帮助卡第一段），
                    #    这里只讲「算式能写什么」。两边都写 = 帮助卡里两段重复的蓝字。
                    "tooltip": "The expression, for example round(a / b * 2, 2).\nConstants pi, e and tau; operators + - * / // % **, comparisons, and/or/not and the ternary form; plus over thirty functions including sqrt, round, min, max, log and sin, each documented in docs/math.md. Empty evaluates to 0.",
                }),
            },
            "optional": {
                # 🔴 类型写成联合值：只写 FLOAT 的话，「宽度 / 高度」这类整数输出
                #    接不进来（ComfyUI 的连线规则是类型必须对得上）；补 BOOLEAN
                #    是跟官方「数学表达式」对齐；再补 STRING 才能把文本拼进去
                #    （纯文本上游以前根本接不上，只能绕 TextConcat）。
                #    老式 INPUT_TYPES 里用逗号分隔表示「任一即可」。
                #    没连线时按 0 算 —— 常数直接写进表达式（`100 * 2`），不需要
                #    再给变量单独留一排数字框。
                name: ("INT,FLOAT,BOOLEAN,STRING", {
                    "default": 0,
                    "tooltip": "Variable %s" % name,
                })
                for name in VARIABLES
            },
        }

    RETURN_TYPES = ("FLOAT", "INT", "BOOLEAN", "STRING")
    RETURN_NAMES = ("value", "integer", "boolean", "text")
    OUTPUT_TOOLTIPS = (
        "The result of the expression, as a decimal. It is 0 when the "
        "expression produces text.",
        "The same result rounded to the nearest whole number, halves away from "
        "zero (2.5 gives 3), then clamped to the INT32 range. It is 0 when the "
        "expression produces text.",
        "Whether the same result is non-zero. With a comparison such as a > b "
        "it works as a condition directly. False when the expression produces text.",
        "The result as text. A number is written the way you would write it "
        "(1024 rather than 1024.0), so it can go straight into a prompt.",
    )
    FUNCTION = "execute"

    def execute(self, expr="", **variables):
        # 变量不再一律压成数字：接进来的文本要能原样传给表达式。
        scope = {name: to_value(variables.get(name, 0.0)) for name in VARIABLES}
        try:
            result = evaluate(expr, scope)
        except MathError as exc:
            # 带上表达式原文：红框里能直接看出是哪一版算错了。
            raise ValueError("数学运算「%s」算不了：%s" % (expr, exc))

        # 文本结果只走 text 槽：三个数字输出一律给 0 / 0 / False，
        # 免得下游拿一个「算不上数的字符串」当尺寸用。
        if isinstance(result, str):
            return (0.0, 0, False, result)

        # 布尔 / 整数结果也走 float，下游拿到的是统一的数字形态。
        # evaluate() 已经保证是有限数，这里不再需要 NaN 兜底。
        number = float(result)
        integer = max(INT32_MIN, min(INT32_MAX, round_half_away(number)))
        return (number, integer, bool(number), format_number(number))


NODE_CLASS_MAPPINGS = {"QG_Math": QGMath}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Math": "Math Expression"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
