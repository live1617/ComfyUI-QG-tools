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

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import re
from ._qg_combo_legacy import combo_legacy

LITERAL = "literal"
REGEX = "regex"
MODES = [LITERAL, REGEX]


@combo_legacy("QG_TextReplace")
class QGTextReplace:
    CATEGORY = "QG-tools/Text"
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
    def VALIDATE_INPUTS(cls, mode=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

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
                        "tooltip": "The text to edit, wired in from upstream.",
                    },
                ),
                "mode": (
                    MODES,
                    {
                        "default": LITERAL,
                        "tooltip": "Literal: the search string matches plain characters, so brackets and dots in a prompt are not read as regex. Regex: everything is treated as a regular expression, the replacement may back-reference with \\1, and a bad pattern raises an error.",
                    },
                ),
            },
            "optional": {
                "find1": (
                    "STRING",
                    {"default": "", "tooltip": "Search text for rule 1 (leave empty to skip)."},
                ),
                "replace1": (
                    "STRING",
                    {"default": "", "tooltip": "Replacement text for rule 1."},
                ),
                "find2": (
                    "STRING",
                    {"default": "", "tooltip": "Search text for rule 2 (leave empty to skip)."},
                ),
                "replace2": (
                    "STRING",
                    {"default": "", "tooltip": "Replacement text for rule 2."},
                ),
                "find3": (
                    "STRING",
                    {"default": "", "tooltip": "Search text for rule 3 (leave empty to skip)."},
                ),
                "replace3": (
                    "STRING",
                    {"default": "", "tooltip": "Replacement text for rule 3."},
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("STRING",)
    OUTPUT_TOOLTIPS = (
        "The text after replacement, with the rules applied in order 1, 2, 3.",
    )
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
                "[QG-tools] 文本替换：模式选了 regex，但查找内容不是合法正则 —— "
                "%r（%s）" % (find, exc)
            )
        return pattern.sub(replace, text)


NODE_CLASS_MAPPINGS = {"QG_TextReplace": QGTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextReplace": "Text Replace"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
