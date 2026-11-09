# -*- coding: utf-8 -*-
"""QG_DualMath — two independent expressions sharing one set of five variables.

The interface follows the familiar "two expression boxes, five variable
inputs" shape, but every part of the implementation is written for this pack:

  * keys, names and messages are English (the Chinese UI comes from the
    language pack, never from the backend);
  * expressions go through ``_qg_math_engine.evaluate`` — a whitelisted AST
    walker, not ``eval`` — so attribute access, calls outside the whitelist,
    imports and arbitrary code are refused;
  * the variable set is a, b, c, d, f on purpose: ``e`` stays the math
    constant ``math.e`` instead of being shadowed by an unwired input.

Goohaitools' "数学运算 孤海" node is only the *idea* reference here; no line of
its source is reused (it evaluates expressions with ``eval`` and uses Chinese
keys, both of which this pack forbids).
"""

from __future__ import annotations

from ._qg_math_engine import (
    MathError,
    evaluate,
    round_half_away,
    to_value,
)

VARIABLES = ("a", "b", "c", "d", "f")

INT32_MIN = -2147483648
INT32_MAX = 2147483647

_HELP = (
    "Dual Math Expression - syntax\n"
    "Variables: a b c d f (unwired = 0). Constants: pi e tau.\n"
    "Operators: + - * / // % ** and comparisons == != > < >= <=.\n"
    "Logic: and or not; ternary: a if a > b else b. Use ** for powers (^ is xor).\n"
    "Functions: abs round min max sum pow int float sqrt exp log log2 log10\n"
    "sin cos tan floor ceil trunc hypot degrees radians factorial gcd lcm sign.\n"
    "Text: quote it, join with +, repeat with *; a text result gives 0 on the\n"
    "numeric sockets. Evaluation is whitelisted: no attributes, no arbitrary code."
)


class QGDualMath:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Two expressions evaluated independently against the same five "
        "variables a, b, c, d and f. Each expression returns a decimal and an "
        "integer (rounded halves away from zero, clamped to INT32), so one "
        "node can feed two different size, seed or strength inputs at once. "
        "Leave an expression empty to get zero. The fifth socket carries an "
        "English syntax cheat sheet you can display anywhere. Expressions are "
        "read by a whitelisted evaluator: only numbers, the five variables, "
        "listed math functions and literals are allowed — no attribute access "
        "and no arbitrary code. Constants pi, e and tau stay available because "
        "e is deliberately not one of the variable names."
    )
    SEARCH_ALIASES = [
        "math", "expression", "calculate", "dual", "two expressions",
        "variables", "formula", "运算", "数学", "表达式", "计算", "公式", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("FLOAT", "INT", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("float_1", "int_1", "float_2", "int_2", "help")
    OUTPUT_TOOLTIPS = (
        "The first expression as a decimal; 0 when it is empty or produces text.",
        "The same result rounded to an INT32 integer (halves away from zero).",
        "The second expression as a decimal; 0 when it is empty or produces text.",
        "The same result rounded to an INT32 integer (halves away from zero).",
        "An English syntax cheat sheet for the expression parser.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "expr1": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "e.g. a + b * 2",
                        "tooltip": "First expression. Leave it empty for zero. "
                                   "Use the variables a, b, c, d, f or plain numbers.",
                    },
                ),
                "expr2": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "e.g. round(c / d, 2)",
                        "tooltip": "Second expression, evaluated with the same "
                                   "variable values as the first one.",
                    },
                ),
            },
            "optional": {
                # A union type lets INT / FLOAT / BOOLEAN / STRING outputs be
                # wired straight in without a conversion node. Unwired = 0.
                name: ("INT,FLOAT,BOOLEAN,STRING", {
                    "default": 0,
                    "tooltip": "Variable %s, shared by both expressions." % name,
                })
                for name in VARIABLES
            },
        }

    def execute(self, expr1="", expr2="", **variables):
        try:
            scope = {
                name: to_value(variables.get(name, 0.0))
                for name in VARIABLES
            }
        except MathError as exc:
            raise ValueError("Dual Math cannot read the variables: %s" % exc)

        def compute(expr, label):
            try:
                result = evaluate(expr, scope)
            except MathError as exc:
                raise ValueError(
                    'Dual Math cannot evaluate %s "%s": %s' % (label, expr, exc)
                )
            if isinstance(result, str):
                return 0.0, 0
            number = float(result)
            integer = max(INT32_MIN, min(INT32_MAX, round_half_away(number)))
            return number, integer

        float_1, int_1 = compute(expr1, "expr1")
        float_2, int_2 = compute(expr2, "expr2")
        return (float_1, int_1, float_2, int_2, _HELP)


NODE_CLASS_MAPPINGS = {"QG_DualMath": QGDualMath}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_DualMath": "Dual Math Expression"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
