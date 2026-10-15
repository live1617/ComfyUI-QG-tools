# -*- coding: utf-8 -*-
"""QG 是否判断 — lazy boolean branch (if/else) node.

Ported from ComfyUI-Easy-Use (easy ifElse), GPL-3.0.
Outputs `on_true` when the boolean is true, otherwise `on_false`. Both inputs
are lazy: the branch that is not taken is never evaluated, which matters for
expensive branches (or loops that would error when executed).
Only core modules are used -- no new dependency.
"""


class AnyType(str):
    """ComfyUI 的「任意类型」占位：与任何类型比较都返回相等，槽类型标 * 即可。"""

    def __ne__(self, value):
        return False

    def __eq__(self, value):
        return True

    def __str__(self):
        return "*"


ANY = AnyType("*")


class QGIfElse:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Condition. True passes on_true through, false passes on_false.",
                }),
                "on_true": (ANY, {
                    "lazy": True,
                    "tooltip": "Value passed through when the condition is true. Not evaluated otherwise.",
                }),
                "on_false": (ANY, {
                    "lazy": True,
                    "tooltip": "Value passed through when the condition is false. Not evaluated otherwise.",
                }),
            }
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    FUNCTION = "execute"
    CATEGORY = "QG-tools/\u903b\u8f91"
    DESCRIPTION = (
        "Boolean if/else branch. Passes the on_true input through when the "
        "condition is true, otherwise the on_false input. Untaken branches are "
        "lazy and never executed, so expensive or risky subtrees stay idle."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    @classmethod
    def check_lazy_status(cls, boolean, on_true=None, on_false=None):
        # 懒执行：只评估会被输出用到的那一支。
        if boolean and on_true is None:
            return ["on_true"]
        if not boolean and on_false is None:
            return ["on_false"]

    def execute(self, boolean, on_true=None, on_false=None):
        return (on_true if boolean else on_false,)


NODE_CLASS_MAPPINGS = {"QG_IfElse": QGIfElse}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_IfElse": "QG 是否判断"}
