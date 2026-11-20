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

V3 形态（2026-11-15，批量迁移批 1 的首个节点）：对外契约与 V1 **逐字段一致**
—— node_id / display_name / category / description / 两个输入的键顺序与
tooltip / 输出类型 / 输出名 / 输出 tooltip 全部保持原值。对照
``reports/qg_object_info.v1-baseline.json`` 的 ``QG_BoolToggle`` 条目；
输出名 ``boolean`` 是存档键，必须显式写 ``Output(id="boolean")``
（V3 不写 id 会回落成类型名 ``BOOLEAN``）。

Only core modules are used -- no new dependency.
"""

from comfy_api.latest import io


class QGBoolToggle(io.ComfyNode):
    """V3 形态：一张大卡片就是一个布尔开关。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_BoolToggle",
            display_name="Boolean Toggle",
            category="QG-tools/Logic",
            description=(
                "A single on/off switch drawn as one big card: click the pill to flip "
                "it, and every node wired to the output follows. The front end paints "
                "the card and hides the underlying checkbox; the value is still a "
                "normal BOOLEAN, so saving, undo and API export behave natively."
            ),
            inputs=[
                # 前端会把这个控件折叠掉，改画成一张大卡片；值本身照旧存在
                # widgets_values 里，存档 / 撤销 / API 都不需要特殊处理。
                io.Boolean.Input(
                    "boolean",
                    default=False,
                    tooltip="The switch state. Click the pill on the card to flip it; wire the output into any downstream boolean condition.",
                ),
                # 卡片上的大字。留空就显示「开 / 关」；填了名字（比如「美颜」）
                # 就显示名字，状态只靠胶囊颜色区分。存在控件里是为了跟着工作流
                # 一起存档；输入框由前端双击卡片弹出（控件本身是隐藏的）。
                io.String.Input(
                    "label",
                    default="",
                    multiline=False,
                    tooltip='The name shown on the card, e.g. "Beauty". Leave it empty to show on / off. Double-click the card to rename it.',
                ),
            ],
            outputs=[
                io.Boolean.Output(
                    id="boolean",
                    tooltip="The switch state, ready for any boolean condition downstream.",
                ),
            ],
        )

    @classmethod
    def execute(cls, boolean=False, label=""):
        # 接上游时拿到的可能是 numpy 布尔或 0/1，统一成严格的 bool。
        # label 只是给前端画字用，不参与计算。
        return io.NodeOutput(bool(boolean))


NODE_CLASS_MAPPINGS = {"QG_BoolToggle": QGBoolToggle}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BoolToggle": "Boolean Toggle"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
