# -*- coding: utf-8 -*-
"""QG_TextReplace - apply up to three find/replace rules to a string.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.9.4 port of
Comfyroll's ``CR_TextReplace`` (MIT). The shape is upstream's: three rules in
order, every find matched literally unless asked otherwise, no trimming.

What the port already got right, and is kept
--------------------------------------------
* **Rules run 1 -> 2 -> 3**, each on the previous result, so a later rule sees
  what an earlier one wrote.
* **Empty find skips the rule.** ``str.replace("", x)`` splices the
  replacement between every character ("hello" -> "XhXeXlXlXoX"), which reads
  as corruption rather than as an instruction.
* **A second ``show_help`` output is not declared.** Upstream emits a wiki
  URL there; a socket that exists only to carry a link is noise.
* **``mode`` is an addition of ours**, defaulting to literal, so upstream
  behaviour is what you get unless you ask for regex.

What changed in this rewrite
----------------------------
* ``RETURN_TYPES`` was ``("*",)`` while ``RETURN_NAMES`` said ``("STRING",)``
  - a socket that claims one thing and is another. It is ``STRING`` now, and
  the slot is named ``text`` like the other text nodes.
* ``FUNCTION`` is ``execute`` (was ``replace_text``), matching the rest of the
  pack. Nothing outside this file referenced the old name, and saved graphs
  never store it.

The regex replacement is a template, not a literal
--------------------------------------------------
``re.sub`` reads its second argument as a template: ``\\1`` means "group 1",
``\\n`` means a newline. That is what makes back-references work, and it is
also why a Windows path in the replacement box blows up:

    C:\\new          -> "C:" + newline + "ew"    (silently wrong)
    C:\\temp\\x      -> error: bad escape \\x
    back\\slash      -> error: bad escape \\s

None of that is visible in a literal-mode rule, which uses ``str.replace``
and treats every character as itself. The fix is not to auto-escape the
replacement - that would kill ``\\1`` - but to catch it and say, in Chinese,
which box is at fault and what to write instead. An error in this node
should name the field; a raw ``bad escape \\x at position 7`` does not.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import re

from ._qg_combo_legacy import combo_legacy

LITERAL = "literal"
REGEX = "regex"
MODES = [LITERAL, REGEX]

# Where the two boxes that can be wrong are named in errors. Kept apart from
# the message text so the wording can change without touching the logic.
_FIND_LABEL = "查找内容"
_REPLACE_LABEL = "替换内容"


@combo_legacy("QG_TextReplace")
class QGTextReplace:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Runs up to three find/replace rules on a string, in order 1 -> 2 -> 3. "
        "Mode 'literal' matches plain text, so brackets, dots and pipes are "
        "safe in prompts. Mode 'regex' treats every find string as a regular "
        "expression and lets the replacement use \\1 back-references - note it "
        "is then a template, so a backslash in the replacement needs doubling. "
        "A rule whose find box is empty is skipped entirely."
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
                        "tooltip": "Literal: the search string matches plain characters, so brackets and dots in a prompt are not read as regex. Regex: everything is treated as a regular expression, and the replacement becomes a template (\\1 for a group, \\\\ for one backslash); a bad pattern raises an error.",
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
                    {"default": "", "tooltip": "Replacement text for rule 1. In regex mode this is a template, so a literal backslash must be written twice."},
                ),
                "find2": (
                    "STRING",
                    {"default": "", "tooltip": "Search text for rule 2 (leave empty to skip)."},
                ),
                "replace2": (
                    "STRING",
                    {"default": "", "tooltip": "Replacement text for rule 2. In regex mode this is a template, so a literal backslash must be written twice."},
                ),
                "find3": (
                    "STRING",
                    {"default": "", "tooltip": "Search text for rule 3 (leave empty to skip)."},
                ),
                "replace3": (
                    "STRING",
                    {"default": "", "tooltip": "Replacement text for rule 3. In regex mode this is a template, so a literal backslash must be written twice."},
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = (
        "The text after replacement, with the rules applied in order 1, 2, 3.",
    )
    FUNCTION = "execute"

    def execute(self, text, mode=LITERAL, find1="", replace1="", find2="",
                replace2="", find3="", replace3=""):
        # 只在这里兜一次：text 是 required 槽，但上游输出的值可能是 None
        # （未求值 / 空输出），拿它去拼接会抛看不出源头的 AttributeError。
        if text is None:
            text = ""
        elif not isinstance(text, str):
            text = str(text)

        rules = ((find1, replace1), (find2, replace2), (find3, replace3))
        for index, (find, replace) in enumerate(rules):
            text = self._apply_rule(text, find, replace, mode, index + 1)
        return (text,)

    @staticmethod
    def _apply_rule(text, find, replace, mode, rule_no):
        # An empty find would make str.replace splice the replacement between
        # every character; treat it as "no rule". None lands here too.
        if not find:
            return text
        if replace is None:
            replace = ""
        elif not isinstance(replace, str):
            replace = str(replace)

        if mode != REGEX:
            return text.replace(find, replace)

        # ---- regex：查找是模式，替换是模板，两处都可能写错 ----
        try:
            pattern = re.compile(find)
        except re.error as exc:
            raise ValueError(
                "[QG-tools] 文本替换：第 %d 条规则的模式选了 regex，但%s不是合法正则 —— "
                "%r（%s）" % (rule_no, _FIND_LABEL, find, exc)
            ) from None

        try:
            return pattern.sub(replace, text)
        except re.error as exc:
            # sub() 阶段才会炸的写法，几乎都是替换内容里那个反斜杠：
            #   C:\temp   -> bad escape \t
            #   back\slash-> bad escape \s
            #   \1        -> invalid group reference（没分组或分组不够）
            raise ValueError(
                "[QG-tools] 文本替换：第 %d 条规则的%s里有 regex 不认的转义 —— %r（%s）。"
                "regex 模式下替换内容是模板：反斜杠要写两次（C:\\\\temp），"
                "\\1 表示第 1 个分组。只是想原样插入一段带反斜杠的文本，"
                "就把这条规则改成字面模式（literal 不解释任何字符）。"
                % (rule_no, _REPLACE_LABEL, replace, exc)
            ) from None


NODE_CLASS_MAPPINGS = {"QG_TextReplace": QGTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextReplace": "Text Replace"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
