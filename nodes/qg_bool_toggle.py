# -*- coding: utf-8 -*-
"""QG 布尔开关 — a big on/off card that exports a BOOLEAN.

The pack already has booleans (``QG_IfElse``, ``QG_StringSwitch``), but each
one lives as a small checkbox buried among a node's other widgets. This node
exists purely to be *the* switch of a workflow: the whole node is one card
painted on the canvas (see ``web/bool_toggle/index.js``), with a large
开 / 关 label and a sliding pill, so a glance across the graph tells you which
state a run is in.

A single BOOLEAN output means one switch can fan out to as many downstream
conditions as needed. The real widget stays on the node (hidden) so the value
survives save / undo / API export exactly like any native boolean.

Only core modules are used -- no new dependency.
"""


class QGBoolToggle:
    CATEGORY = "QG-tools/\u903b\u8f91"
    DESCRIPTION = (
        "A single on/off switch drawn as one big card: click the pill to flip "
        "it, and every node wired to the output follows. The front end paints "
        "the card and hides the underlying checkbox; the value is still a "
        "normal BOOLEAN, so saving, undo and API export behave natively."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端会把这个控件折叠掉，改画成一张大卡片；值本身照旧存在
                # widgets_values 里，存档 / 撤销 / API 都不需要特殊处理。
                "boolean": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "开关状态。点节点上的胶囊切换；输出接到下游的布尔条件上。",
                }),
                # 卡片上的大字。留空就显示「开 / 关」；填了名字（比如「美颜」）
                # 就显示名字，状态只靠胶囊颜色区分。存在控件里是为了跟着工作流
                # 一起存档；输入框由前端双击卡片弹出（控件本身是隐藏的）。
                "label": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "卡片上显示的名字，比如「美颜」。留空则显示「开 / 关」。双击卡片可改。",
                }),
            }
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("boolean",)
    FUNCTION = "execute"

    def execute(self, boolean=False, label=""):
        # 接上游时拿到的可能是 numpy 布尔或 0/1，统一成严格的 bool。
        # label 只是给前端画字用，不参与计算。
        return (bool(boolean),)


NODE_CLASS_MAPPINGS = {"QG_BoolToggle": QGBoolToggle}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BoolToggle": "\u5e03\u5c14\u5f00\u5173"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
