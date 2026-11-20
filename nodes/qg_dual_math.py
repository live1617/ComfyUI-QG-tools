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

from comfy_api.latest import io

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

_DESCRIPTION = (
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


class QGDualMath(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_DualMath",
            display_name="Dual Math Expression",
            category="QG-tools/Logic",
            description=_DESCRIPTION,
            search_aliases=[
                "math", "expression", "calculate", "dual", "two expressions",
                "variables", "formula", "运算", "数学", "表达式", "计算", "公式", "qg",
            ],
            inputs=[
                io.String.Input(
                    "expr1",
                    default="",
                    multiline=False,
                    placeholder="e.g. a + b * 2",
                    tooltip=(
                        "First expression. Leave it empty for zero. "
                        "Use the variables a through z (except e) or plain numbers."
                    ),
                ),
                io.String.Input(
                    "expr2",
                    default="",
                    multiline=False,
                    placeholder="e.g. round(c / d, 2)",
                    tooltip=(
                        "Second expression, evaluated with the same "
                        "variable values as the first one."
                    ),
                ),
                # 联合类型让 INT / FLOAT / BOOLEAN / STRING 输出直接接进来，
                # 无需转换节点；没连线按 0 算。V1 的 optional 槽带 "default": 0，
                # V3 的 MultiType 不收 default 参数，必须走 extra_dict 才能写回
                # object_info，否则存档/契约 diff 少一个键。序列化后正好是
                # V1 的 "INT,FLOAT,BOOLEAN,STRING"，连线零漂移。
                *[
                    io.MultiType.Input(
                        name,
                        [io.Int, io.Float, io.Boolean, io.String],
                        optional=True,
                        tooltip="Variable %s, shared by both expressions." % name,
                        extra_dict={"default": 0},
                    )
                    for name in VARIABLES
                ],
            ],
            outputs=[
                io.Float.Output(
                    id="float_1",
                    tooltip=(
                        "The first expression as a decimal; 0 when it is empty "
                        "or produces text."
                    ),
                ),
                io.Int.Output(
                    id="int_1",
                    tooltip=(
                        "The same result rounded to an INT32 integer "
                        "(halves away from zero)."
                    ),
                ),
                io.Float.Output(
                    id="float_2",
                    tooltip=(
                        "The second expression as a decimal; 0 when it is empty "
                        "or produces text."
                    ),
                ),
                io.Int.Output(
                    id="int_2",
                    tooltip=(
                        "The same result rounded to an INT32 integer "
                        "(halves away from zero)."
                    ),
                ),
            ],
        )

    @classmethod
    def execute(cls, expr1="", expr2="", **variables):
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
        return io.NodeOutput(float_1, int_1, float_2, int_2)


NODE_CLASS_MAPPINGS = {"QG_DualMath": QGDualMath}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_DualMath": "Dual Math Expression"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
