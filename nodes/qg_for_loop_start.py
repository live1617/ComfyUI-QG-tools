# -*- coding: utf-8 -*-
"""QG_ForLoopStart —— For 循环起点（截图「For循环-起始」，零依赖自写）。

输入：总量 + 四个初始值；输出：流 / 索引 / 值1 / 值2 / 值3 / 值4。
"流" 是循环标记（自定义 QG_FLOW 类型），只用来把起点和 QG_ForLoopEnd 绑定，
不传数据。真正的回环与索引推进都在 QG_ForLoopEnd 里完成。
只依赖 ComfyUI 内核，不依赖任何外部插件。
"""

from comfy_api.latest import io


def _as_int(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(value)
    except Exception:
        return 0


class QGForLoopStart(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "For-loop start: total iterations plus four carried values; outputs flow, index, value1, value2, value3 and value4. "
        "Pair with QG For Loop End. Index starts at 0. IMPORTANT: connect the end node's output to a "
        "final output node, otherwise the loop is never triggered. total can be a fixed number or a link. "
        "Zero-dependency, ComfyUI core only."
    )
    SEARCH_ALIASES = ["for loop start", "forloop", "循环开始", "for循环", "qg"]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_ForLoopStart",
            display_name="For Loop Start",
            category=cls.CATEGORY,
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Int.Input("total", default=1, min=0, max=100000, step=1,
                             display_name="total", tooltip="Number of iterations."),
                io.AnyType.Input("value1", optional=True, tooltip="Carried value 1."),
                io.AnyType.Input("value2", optional=True, tooltip="Carried value 2."),
                io.AnyType.Input("value3", optional=True, tooltip="Carried value 3."),
                io.AnyType.Input("value4", optional=True, tooltip="Carried value 4."),
                # 内部索引：由终点每轮回带 idx+1；循环体的 Math 等节点可读它做递增计算。
                io.Int.Input("idx", default=0, min=0, max=0x7FFFFFFFFFFFFFFF, step=1,
                             optional=True, advanced=True,
                             tooltip="Internal loop index, advanced by the loop end."),
            ],
            outputs=[
                io.Custom("QG_FLOW").Output("flow", tooltip="Loop marker to QG For Loop End."),
                io.Int.Output("index", tooltip="Current index, starting at 0."),
                io.AnyType.Output("value1", tooltip="Carried value 1 at loop exit."),
                io.AnyType.Output("value2", tooltip="Carried value 2 at loop exit."),
                io.AnyType.Output("value3", tooltip="Carried value 3 at loop exit."),
                io.AnyType.Output("value4", tooltip="Carried value 4 at loop exit."),
            ],
        )

    @classmethod
    def execute(cls, total=1, value1=None, value2=None, value3=None, value4=None, idx=0):
        # total=0 时阻断 index 槽：否则贴在起点下游、靠 index 驱动的循环体
        # 节点（如 Math / SaveImage）会被内核正常调度一次，出现「0 轮却执行
        # 1 轮」的副作用（循环体里有 SaveImage 时会多存一张图）。
        # ExecutionBlocker 是内核原生机制：下游消费被阻断的槽时整个节点被跳过。
        # 只阻断 index、不阻断四个 value：终点直接接起点 value 时仍能输出
        # 初始值；若循环体 value 链上有节点，它拿的是 value 不是 blocker，会
        # 照常算一次，但该结果无人消费、不影响最终输出。
        if _as_int(total) <= 0:
            from comfy_execution.graph_utils import ExecutionBlocker
            return io.NodeOutput("flow", ExecutionBlocker(None), value1, value2, value3, value4)
        return io.NodeOutput("flow", idx, value1, value2, value3, value4)


NODE_CLASS_MAPPINGS = {"QG_ForLoopStart": QGForLoopStart}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_ForLoopStart": "For Loop Start"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
