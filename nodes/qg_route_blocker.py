# -*- coding: utf-8 -*-
from ._qg_combo_legacy import combo_legacy
"""QG 路由阻断 —— 一条线路的总开关：原样放行、换成空值，或者静默掐断。

Ported from GoohaiTools (孤海工具箱) ``GoohaiRouteBlocker``「路由阻断」, GPL-3.0.

给「某些时候不该往下走」的流程一个开关位：

    any ──► [路由阻断] ──► any

- **通过**（开关关着）→ 原样透传，和一根导线没区别
- **阻断 + empty** → 输出 None，下游照常执行、自己去处理空值。
  适合「关掉这一路附加描述」这种仍然要跑完的场景
- **阻断 + cut** → 输出 ComfyUI 原生的 ``ExecutionBlocker``，
  下游节点被静默跳过，等于程序化地按了 Ctrl+M，但只掐这一条线，
  图里其它分支照跑

和 ``QG_IfElse`` 的分工：那个是「二选一、只走一条」，这个是「走不走、
走到哪一步为止」，可以串在任意位置，不用把线路拆成两股。

``any`` 是可选输入：没接线时它就是 None，阻断与否都不报错。

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

try:  # 旧版本 ComfyUI 没有这个模块；缺了就只有 empty 一种模式
    from comfy_execution.graph import ExecutionBlocker
except Exception:  # pragma: no cover
    ExecutionBlocker = ()


class AnyType(str):
    """ComfyUI 的「任意类型」占位：与任何类型比较都返回相等，槽类型标 * 即可。"""

    def __ne__(self, value):
        return False

    def __eq__(self, value):
        return True

    def __str__(self):
        return "*"


ANY = AnyType("*")

MODE_NULL = "empty"
MODE_CUT = "cut"


@combo_legacy("QG_RouteBlocker")
class QGRouteBlocker:
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "A switch for one wire. When the switch is off the value passes through "
        "untouched. When it is on, empty replaces the value with None and lets "
        "downstream nodes run anyway, while cut emits ComfyUI's ExecutionBlocker "
        "so everything behind this node is skipped silently, the same effect as "
        "muting a branch without rerouting the graph."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "block": ("BOOLEAN", {
                    "default": False,
                    "label_on": "阻断",
                    "label_off": "通过",
                    "tooltip": "Off passes the value straight through, as if this node were not on the wire; on "
                               "hands it to the mode below. You can also wire in an upstream boolean and let the "
                               "graph decide for itself.",
                }),
                "mode": ([MODE_NULL, MODE_CUT], {
                    "default": MODE_NULL,
                    "tooltip": "empty turns the value into None and passes it on, so downstream still runs and "
                               "handles the empty value itself. cut emits an execution-blocking signal and "
                               "the nodes behind it are skipped silently, the same as pressing Ctrl+M on this "
                               "wire, leaving other branches in the graph untouched.",
                }),
            },
            "optional": {
                # optional 不是「可以不填」，是「没接也能跑」：没接线时拿到的就是
                # None，阻断与否都能正常执行。
                "any": (ANY, {
                    "forceInput": True,
                    "tooltip": "The value to pass or to cut, of any type. Unwired it is already empty, so "
                               "emitting an empty value raises nothing.",
                }),
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("any",)
    OUTPUT_TOOLTIPS = (
        "The original value when it passes, an empty value or a blocking signal "
        "when it is cut. The type follows the input.",
    )
    FUNCTION = "execute"

    @classmethod
    def VALIDATE_INPUTS(cls, mode=None, input_types=None):
        # mode 具名列出 → ComfyUI 跳过「值必须在选项列表里」这道校验，老存档
        # 里的中文值才不会报 Value not in list；真正的换值在 combo_legacy 里做。
        # input_types 同理放行类型校验：输入声明成 ANY，前端按 * 校验，不放行
        # 的话接 IMAGE / 模型之类的端口会被判成类型不符。
        return True

    def execute(self, block=False, mode=MODE_NULL, any=None):
        if not block:
            return (any,)
        # 仅输出普通 None：下游继续执行，空值交给下游自己处理。
        if mode == MODE_CUT and isinstance(ExecutionBlocker, type):
            return (ExecutionBlocker(None),)
        return (None,)


NODE_CLASS_MAPPINGS = {"QG_RouteBlocker": QGRouteBlocker}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_RouteBlocker": "Route Blocker"}
