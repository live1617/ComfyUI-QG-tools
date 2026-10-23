# -*- coding: utf-8 -*-
"""QG_TextConcat - join two pieces of text with a separator.

Ported from ComfyUI_Comfyroll_CustomNodes (nodes/nodes_utils_text.py, class
CR_TextConcatenate), MIT licensed, authored by Suzie1 / Comfyroll.

Structure follows upstream: both text inputs are forced input slots
(``forceInput``), the separator is a widget, and nothing is trimmed - joining
"" and "b" with "-" gives "-b", matching upstream byte for byte.

Deliberate QG changes:

  * Node id / class name, category, display name, Chinese tooltips, aliases.
  * The dead ``show_help`` output is removed. Upstream declares two outputs but
    ``concat_text`` only returns a one-item tuple, so that second socket could
    never carry a value.
"""


class QGTextConcat:
    CATEGORY = "QG-tools/文本"
    DESCRIPTION = (
        "Joins two texts with a separator: text1 + separator + text2. Both "
        "texts are input slots and must be connected; the separator is a "
        "widget. Nothing is trimmed - if you want a space between the pieces, "
        "put it in the separator."
    )
    SEARCH_ALIASES = [
        "concat", "merge", "join", "combine", "text", "合并", "拼接", "连接", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "text1": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "第一段文本，从上游连过来。",
                    },
                ),
                "text2": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "第二段文本，从上游连过来。",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "tooltip": "两段文本之间的分隔符，原样插入（想用空格或换行就填什么）",
                    },
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("STRING",)
    OUTPUT_TOOLTIPS = ("text1 + 分隔符 + text2 的结果，不做任何去空格处理。",)
    FUNCTION = "concat_text"

    def concat_text(self, text1="", text2="", separator=""):
        return (text1 + separator + text2,)


NODE_CLASS_MAPPINGS = {"QG_TextConcat": QGTextConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextConcat": "文本合并"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
