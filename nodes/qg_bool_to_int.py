# -*- coding: utf-8 -*-
"""QG_BoolToInt —— 布尔到整数：让整数输入口跟着一个布尔信号走。

自写节点，没有上游代码。行为只有一条：A 为真输出 1，为假输出 0。
输入是强制接线槽（与参考图一致），不接线时按 False 处理、返回 0，
不会因为空输入把整条流程打断。
"""

from comfy_api.latest import io


class QGBoolToInt(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Turn a boolean into an integer: True gives 1, False gives 0. "
        "Use it to drive an integer input from a switch or a boolean signal."
    )
    SEARCH_ALIASES = [
        "bool to int", "booltoint", "boolean to integer", "true false", "1 0",
        "布尔到整数", "布尔转整数", "布尔转数字", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_BoolToInt",
            display_name="Bool To Int",
            category="QG-tools/Logic",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Boolean.Input(
                    "A",
                    default=False,
                    optional=True,
                    # 纯接线槽：槽位显示布尔色，不放复选框。
                    extra_dict={"forceInput": True},
                    tooltip="The boolean to convert. True gives 1, False gives 0.",
                ),
            ],
            outputs=[
                # "INT" 是存档键，必须显式写 id（V3 不写会回落成类型名 BOOLEAN/INT）。
                io.Int.Output(
                    "INT",
                    tooltip="1 when A is true, 0 when A is false or not connected.",
                ),
            ],
        )

    @classmethod
    def execute(cls, A=False):
        return io.NodeOutput(1 if bool(A) else 0)


NODE_CLASS_MAPPINGS = {"QG_BoolToInt": QGBoolToInt}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_BoolToInt": "Bool To Int"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
