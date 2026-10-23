# -*- coding: utf-8 -*-
"""QG_TextReplace - apply up to three find/replace rules to a string.

Ported from ComfyUI_Comfyroll_CustomNodes (nodes/nodes_utils_text.py, class
CR_TextReplace), MIT licensed, authored by Suzie1 / Comfyroll.

Structure and default semantics are upstream's: three rules run in order and
every find string is matched **literally**, so brackets, dots, pipes and
backslashes are ordinary characters.

Deliberate QG changes:

  * Node id / class name, category, display name, Chinese tooltips, aliases.
  * Upstream declares a second ``show_help`` output that only ever carries a
    wiki URL; it is dropped here instead of being kept as a dead socket.
  * An empty find string skips its rule instead of going to ``str.replace``.
    Upstream splices the replacement between every character in that case
    ("hello" -> "XhXeXlXlXoX"), which reads as data corruption.
  * A ``mode`` selector adds an explicit regex path. It defaults to literal,
    so upstream behaviour is unchanged unless asked for. In regex mode a
    pattern that does not compile raises instead of silently degrading to a
    literal match - a silent fallback is exactly how subtle text corruption
    goes unnoticed.
"""

import re

LITERAL = "字面"
REGEX = "正则"
MODES = [LITERAL, REGEX]


class QGTextReplace:
    CATEGORY = "QG-tools/文本"
    DESCRIPTION = (
        "Runs up to three find/replace rules on a string, in order. Mode "
        "'literal' matches plain text, so brackets, dots and pipes are safe in "
        "prompts; mode 'regex' treats every find string as a regular expression "
        "and lets the replacement use \\1 back-references. A rule whose find "
        "box is empty is skipped entirely."
    )
    SEARCH_ALIASES = [
        "replace", "find", "regex", "text replace", "string replace",
        "替换", "查找", "正则", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "要改的文本，从上游连过来。",
                    },
                ),
                "mode": (
                    MODES,
                    {
                        "default": LITERAL,
                        "tooltip": "字面：查找内容按普通字符匹配（提示词里的括号、点号不会被当正则）；"
                                   "正则：按正则表达式处理，替换内容可用 \\1 反向引用，写错了直接报错",
                    },
                ),
            },
            "optional": {
                "find1": (
                    "STRING",
                    {"default": "", "tooltip": "规则 1 的查找内容（留空跳过）"},
                ),
                "replace1": (
                    "STRING",
                    {"default": "", "tooltip": "规则 1 的替换内容"},
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

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("STRING",)
    OUTPUT_TOOLTIPS = ("替换后的文本，规则按 1 → 2 → 3 顺序生效。",)
    FUNCTION = "replace_text"

    def replace_text(self, text, mode=LITERAL, find1="", replace1="", find2="",
                     replace2="", find3="", replace3=""):
        text = self._apply_rule(text, find1, replace1, mode)
        text = self._apply_rule(text, find2, replace2, mode)
        text = self._apply_rule(text, find3, replace3, mode)
        return (text,)

    @staticmethod
    def _apply_rule(text, find, replace, mode):
        # An empty find would make str.replace splice the replacement between
        # every character; treat it as "no rule".
        if not find:
            return text
        # ComfyUI can hand over None if the upstream output is unset; without
        # this the whole prompt graph dies on AttributeError.
        text = text or ""
        if mode != REGEX:
            return text.replace(find, replace)
        try:
            pattern = re.compile(find)
        except re.error as exc:
            raise ValueError(
                "[QG-tools] 文本替换：模式选了「正则」，但查找内容不是合法正则 —— "
                "%r（%s）" % (find, exc)
            )
        return pattern.sub(replace, text)


NODE_CLASS_MAPPINGS = {"QG_TextReplace": QGTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextReplace": "文本替换"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
