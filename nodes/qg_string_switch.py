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


class QGStringSwitch:
    CATEGORY = "QG-tools/\u903b\u8f91"
    DESCRIPTION = (
        "Picks between two inline text branches with a boolean: true outputs "
        "the top text, false outputs the bottom one. Both boxes can still be "
        "wired from upstream; the branch not taken is lazy and never "
        "evaluated. Handy for A/B prompt variants without extra text nodes."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 两段文本写在节点上（有 default 就是控件），需要上游时直接连线覆盖。
        return {
            "required": {
                "boolean": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "条件。为真输出「真时文本」，为假输出「假时文本」。",
                }),
                "on_true": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "rows": 3,
                    "lazy": True,
                    "tooltip": "条件为真时输出的文本。可以直接在这里打字，也可以连上游覆盖。",
                }),
                "on_false": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "rows": 3,
                    "lazy": True,
                    "tooltip": "条件为假时输出的文本。可以直接在这里打字，也可以连上游覆盖。",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "execute"

    @classmethod
    def check_lazy_status(cls, boolean=False, on_true=None, on_false=None):
        # 懒执行：只评估会被输出用到的那一支。自带默认值的控件不会走到这里
        # （值不是 None），只有接了线又还没解析时才需要主动请求。
        if boolean and on_true is None:
            return ["on_true"]
        if not boolean and on_false is None:
            return ["on_false"]

    def execute(self, boolean, on_true="", on_false=""):
        value = on_true if boolean else on_false
        # 上游接了线却返回 None 时给空串，免得下游拿到 None 报奇怪的错。
        return ("" if value is None else value,)


NODE_CLASS_MAPPINGS = {"QG_StringSwitch": QGStringSwitch}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_StringSwitch": "\u5b57\u7b26\u4e32\u5207\u6362"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
