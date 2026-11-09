# -*- coding: utf-8 -*-
"""QG 文本 — a box on the canvas that outputs exactly what is typed into it.

Written for ComfyUI-QG-tools on 2026-10-30, replacing the ComfyUI-Muye port
that shipped in v0.6.0. The node id, the input name, the display name and the
shape of the output are unchanged, so a saved workflow opens and runs exactly
as before.

Why the output is a one-item list
---------------------------------
This is the one thing about the node that looks like a mistake and is not.
``OUTPUT_IS_LIST`` hands downstream a batch, and the batch holds exactly one
item: the whole box, newlines included. ComfyUI unfolds that batch again for
any input that is not itself a list, so a plain STRING consumer - a text
encoder, a filename field - receives the string as if it had never been a
list. The difference only shows up in the other direction: a downstream node
that declares a list input gets the list instead of being called once per
string. Dropping the flag would read tidier and change behaviour for exactly
those graphs.

It also decides what "do not split" means here. The text is never cut on
newlines or commas - a three-line paragraph is one item, not three. That is
what separates this node from QG_TextSplit, which does cut, and says so.

Typing versus wiring
--------------------
``text`` stays a required widget, which is what draws the box; the typed value
is the default. Wiring an upstream string into the same slot overrides it for
that run without touching the saved text, so the node doubles as a fallback
when nothing upstream produced anything.

Only core modules are used -- no new dependency.
"""


class QGTextEditOutput:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "A hand-typed text box that outputs its content as a one-item STRING "
        "list. The whole box is one item, never split on newlines or commas. "
        "Wiring an upstream string overrides the typed text for that run. "
        "No model, no dependencies."
    )
    # ComfyUI 会把它导成 object_info 的 search_aliases 参与原生搜索；
    # 中文别名在 web/shared/node_aliases.mjs 里另有一份（那套是给补丁用的）。
    SEARCH_ALIASES = ["text", "edit", "note", "prompt", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "rows": 5,
                    "tooltip": "The text. Type it here, or wire a string in to override it for that run without "
                               "changing what is saved.",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = (
        "The text as a one-item STRING list; the whole box is one item and "
        "is never split.",
    )
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = True
    FUNCTION = "execute"

    def execute(self, text=""):
        # 存档里永远是字符串；None 只可能来自 API 直连（少传了参数），
        # 数字则来自上游接了个非 STRING 槽。统一成字符串，免得下游拿 None
        # 去拼接时报一句看不出源头的错。
        if text is None:
            text = ""
        elif not isinstance(text, str):
            text = str(text)
        return ([text],)


NODE_CLASS_MAPPINGS = {"QG_TextEditOutput": QGTextEditOutput}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextEditOutput": "Text"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
