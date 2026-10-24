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

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""


class QGTextConcat:
    CATEGORY = "QG-tools/Text"
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
                        "tooltip": "The first text, wired from upstream.",
                    },
                ),
                "text2": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "The second text, wired from upstream.",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "tooltip": "Inserted verbatim between the two texts; type a space or a newline if that is what you want.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("STRING",)
    OUTPUT_TOOLTIPS = (
        "text1 + separator + text2, with nothing trimmed.",
    )
    FUNCTION = "concat_text"

    def concat_text(self, text1="", text2="", separator=""):
        return (text1 + separator + text2,)


NODE_CLASS_MAPPINGS = {"QG_TextConcat": QGTextConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextConcat": "Text Concat"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
