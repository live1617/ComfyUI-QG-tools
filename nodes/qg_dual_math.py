# -*- coding: utf-8 -*-
"""QG_DualMath — two independent expressions sharing one set of variables.

The interface follows the familiar "two expression boxes, a..z variable
inputs" shape (every letter except e), but every part of the implementation
is written for this pack:

  * keys, names and messages are English (the Chinese UI comes from the
    language pack, never from the backend);
  * expressions go through ``_qg_math_engine.evaluate`` — a whitelisted AST
    walker, not ``eval`` — so attribute access, calls outside the whitelist,
    imports and arbitrary code are refused;
  * the variable set is a..z except e on purpose: ``e`` stays the math
    constant ``math.e`` instead of being shadowed by an unwired input.

Goohaitools' "数学运算 孤海" node is only the *idea* reference here; no line of
its source is reused (it evaluates expressions with ``eval`` and uses Chinese
keys, both of which this pack forbids).
"""

from __future__ import annotations

import string

from ._qg_math_engine import (
    MathError,
    evaluate,
    round_half_away,
    to_value,
)

# 与「数学运算」同一套规则：a–z 跳过 e（e 是常量 math.e）。
VARIABLES = tuple(c for c in string.ascii_lowercase if c != "e")

INT32_MIN = -2147483648
INT32_MAX = 2147483647


class QGDualMath:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Two expressions evaluated independently against the same variables "
        "a through z (every letter except e). Each expression returns a decimal "
        "and an integer (rounded halves away from zero, clamped to INT32), so "
        "one node can feed two different size, seed or strength inputs at once. "
        "Leave an expression empty to get zero. Expressions are read by a "
        "whitelisted evaluator: only numbers, the variables, listed math "
        "functions and literals are allowed \u2014 no attribute access and no "
        "arbitrary code. Constants pi, e and tau stay available because e is "
        "deliberately not one of the variable names. The variable sockets grow "
        "as you connect them (four shown first, then one more opens up to z, "
        "always leaving one spare)."
    )
    SEARCH_ALIASES = [
        "math", "expression", "calculate", "dual", "two expressions",
        "variables", "formula", "运算", "数学", "表达式", "计算", "公式", "qg",
    ]
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("FLOAT", "INT", "FLOAT", "INT")
    RETURN_NAMES = ("float_1", "int_1", "float_2", "int_2")
    OUTPUT_TOOLTIPS = (
        "The first expression as a decimal; 0 when it is empty or produces text.",
        "The same result rounded to an INT32 integer (halves away from zero).",
        "The second expression as a decimal; 0 when it is empty or produces text.",
        "The same result rounded to an INT32 integer (halves away from zero).",
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
                                   "Use the variables a through z (except e) or plain numbers.",
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
        return (float_1, int_1, float_2, int_2)


NODE_CLASS_MAPPINGS = {"QG_DualMath": QGDualMath}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_DualMath": "Dual Math Expression"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
