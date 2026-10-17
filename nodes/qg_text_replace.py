# -*- coding: utf-8 -*-
"""QG_TextReplace - apply up to three find/replace rules to a string or a list.

Ported from ComfyUI_Muye (text/batch_text_replace.py, class BatchTextReplace),
MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips.
  * The input is now optional on both sides: feed a string list through
    ``texts``, or type straight into ``text``. Upstream required a list input,
    so the node was unusable on its own.
  * Each rule is tried as a regular expression first and falls back to a plain
    literal replacement if the pattern does not compile - same order as
    upstream, now documented in the tooltip (it is easy to be surprised by a
    literal ``.`` or ``*`` behaving as regex).

Empty find strings are skipped, which is what makes the three rule slots
optional in practice.
"""

import re


class QGTextReplace:
    CATEGORY = "QG-tools/文本"
    DESCRIPTION = (
        "Runs up to three find/replace rules over a string or every entry of a "
        "string list, returning a list. A rule is applied as a regular "
        "expression when the pattern compiles, otherwise as a literal "
        "replacement; empty find strings are skipped. Rules run in order, so "
        "later rules see the output of earlier ones."
    )
    SEARCH_ALIASES = [
        "replace", "find", "regex", "text", "替换", "查找", "正则", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "texts": (
                    "STRING",
                    {
                        "forceInput": True,
                        "is_list": True,
                        "tooltip": "接文本列表（接单条字符串也会被当成一条处理）",
                    },
                ),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "没有接 texts 时用这里的文本",
                    },
                ),
                "find1": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "规则 1 的查找内容（留空跳过）；能编译成正则就按正则处理",
                    },
                ),
                "replace1": (
                    "STRING",
                    {"default": "", "tooltip": "规则 1 的替换内容（正则里可用 \\1 反向引用）"},
                ),
                "find2": (
                    "STRING",
                    {"default": "", "tooltip": "规则 2 的查找内容（留空跳过）"},
                ),
                "replace2": (
                    "STRING",
                    {"default": "", "tooltip": "规则 2 的替换内容"},
                ),
                "find3": (
                    "STRING",
                    {"default": "", "tooltip": "规则 3 的查找内容（留空跳过）"},
                ),
                "replace3": (
                    "STRING",
                    {"default": "", "tooltip": "规则 3 的替换内容"},
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("TEXTS",)
    OUTPUT_TOOLTIPS = ("替换后的文本列表（顺序与输入一致）。",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "replace_text"

    @staticmethod
    def _apply_rule(text, find, replace):
        if not find:
            return text
        try:
            re.compile(find)
        except re.error:
            return text.replace(find, replace)
        try:
            return re.sub(find, replace, text)
        except re.error:
            return text

    def replace_text(self, texts=None, text="", find1="", replace1="",
                     find2="", replace2="", find3="", replace3=""):
        if texts is None:
            items = [text] if text else []
        elif isinstance(texts, str):
            items = [texts]
        else:
            items = [t for t in texts if t is not None]

        if not items:
            raise ValueError("[QG-tools] 批量文本替换：没有输入文本（接 texts 或填 text）")

        rules = ((find1, replace1), (find2, replace2), (find3, replace3))
        out = []
        for item in items:
            current = item
            for find, replace in rules:
                current = self._apply_rule(current, find, replace)
            out.append(current)
        return (out,)


NODE_CLASS_MAPPINGS = {"QG_TextReplace": QGTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextReplace": "QG 批量文本替换"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
