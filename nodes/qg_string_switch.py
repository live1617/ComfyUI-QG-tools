# -*- coding: utf-8 -*-
"""QG 字符串切换 — pick one of two inline texts with a boolean.

Same job as Crystools' "Switch string" node, implemented from scratch here so
the whole logic family lives under the QG-tools category.

Why it exists next to ``QG_IfElse``: that node switches between two *sockets*,
so flipping between two prompt variants costs two extra text nodes and two
links. Here the two branches are **editable text widgets** — type both prompts
on the node, flip the boolean, done.

Both branches stay convertible to inputs: drag a widget into a socket (or just
wire the input) and the upstream text wins, because a linked input overrides
the widget value. Whichever branch is not selected is declared ``lazy``, so an
expensive upstream (an LLM call, a file read) is never evaluated for nothing.
Only core modules are used -- no new dependency.
"""

from comfy_api.latest import io


class QGStringSwitch(io.ComfyNode):
    CATEGORY = "QG-tools/Logic"
    DESCRIPTION = (
        "Picks between two inline text branches with a boolean: true outputs "
        "the top text, false outputs the bottom one. Both boxes can still be "
        "wired from upstream; the branch not taken is lazy and never "
        "evaluated. Handy for A/B prompt variants without extra text nodes."
    )

    @classmethod
    def define_schema(cls):
        # 两段文本写在节点上（有 default 就是控件），需要上游时直接连线覆盖。
        # 未选中的一支声明 lazy，免得白算昂贵的上游（LLM / 文件读取）。
        return io.Schema(
            node_id="QG_StringSwitch",
            display_name="String Switch",
            category="QG-tools/Logic",
            description=cls.DESCRIPTION,
            inputs=[
                io.Boolean.Input(
                    "boolean",
                    default=False,
                    tooltip="The condition. True outputs the top text, false outputs the bottom one.",
                ),
                io.String.Input(
                    "on_true",
                    multiline=True,
                    default="",
                    lazy=True,
                    extra_dict={"rows": 3},
                    tooltip="Text output when the condition is true. Type it here, or wire an upstream STRING to override it.",
                ),
                io.String.Input(
                    "on_false",
                    multiline=True,
                    default="",
                    lazy=True,
                    extra_dict={"rows": 3},
                    tooltip="Text output when the condition is false. Type it here, or wire an upstream STRING to override it.",
                ),
            ],
            outputs=[
                io.String.Output(
                    "string",
                    tooltip="The text of the branch the condition selected; the other branch is never evaluated.",
                ),
            ],
        )

    @classmethod
    def check_lazy_status(cls, boolean=False, on_true=None, on_false=None):
        # 懒执行：只评估会被输出用到的那一支。自带默认值的控件不会走到这里
        # （值不是 None），只有接了线又还没解析时才需要主动请求。
        if boolean and on_true is None:
            return ["on_true"]
        if not boolean and on_false is None:
            return ["on_false"]

    @classmethod
    def execute(cls, boolean, on_true="", on_false=""):
        value = on_true if boolean else on_false
        # 上游接了线却返回 None 时给空串，免得下游拿到 None 报奇怪的错。
        return io.NodeOutput("" if value is None else value)


NODE_CLASS_MAPPINGS = {"QG_StringSwitch": QGStringSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_StringSwitch": "String Switch"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
