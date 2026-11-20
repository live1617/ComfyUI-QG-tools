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

V3 migration (2026-11-18): V1 -> V3 via ``io.ComfyNode``. Schema is built in
``define_schema``; ``execute`` is a classmethod returning ``io.NodeOutput``.
The ``@combo_legacy`` decorator is dropped (it wraps ``cls.FUNCTION``, which
in V3 is the base class's ``EXECUTE_NORMALIZED``) and replaced by an explicit
``coerce()`` call at the top of ``execute``, preserving legacy Chinese combo
values from saved workflows. ``validate_inputs`` is the V3 spelling of the old
``VALIDATE_INPUTS`` and keeps the same named-argument trick.
"""

import re

from comfy_api.latest import io

from ._qg_combo_legacy import coerce

LITERAL = "literal"
REGEX = "regex"
MODES = [LITERAL, REGEX]

# Where the two boxes that can be wrong are named in errors. Kept apart from
# the message text so the wording can change without touching the logic.
_FIND_LABEL = "the Find box"
_REPLACE_LABEL = "the Replace box"


class QGTextReplace(io.ComfyNode):
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
    def define_schema(cls):
        return io.Schema(
            node_id="QG_TextReplace",
            display_name="Text Replace",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "text",
                    multiline=True,
                    default="",
                    force_input=True,
                    tooltip="The text to edit, wired in from upstream.",
                ),
                io.Combo.Input(
                    "mode",
                    options=list(MODES),
                    default=LITERAL,
                    tooltip="Literal: the search string matches plain characters, so brackets and dots in a prompt are not read as regex. Regex: everything is treated as a regular expression, and the replacement becomes a template (\\1 for a group, \\\\ for one backslash); a bad pattern raises an error.",
                ),
                io.String.Input(
                    "find1",
                    optional=True,
                    default="",
                    tooltip="Search text for rule 1 (leave empty to skip).",
                ),
                io.String.Input(
                    "replace1",
                    optional=True,
                    default="",
                    tooltip="Replacement text for rule 1. In regex mode this is a template, so a literal backslash must be written twice.",
                ),
                io.String.Input(
                    "find2",
                    optional=True,
                    default="",
                    tooltip="Search text for rule 2 (leave empty to skip).",
                ),
                io.String.Input(
                    "replace2",
                    optional=True,
                    default="",
                    tooltip="Replacement text for rule 2. In regex mode this is a template, so a literal backslash must be written twice.",
                ),
                io.String.Input(
                    "find3",
                    optional=True,
                    default="",
                    tooltip="Search text for rule 3 (leave empty to skip).",
                ),
                io.String.Input(
                    "replace3",
                    optional=True,
                    default="",
                    tooltip="Replacement text for rule 3. In regex mode this is a template, so a literal backslash must be written twice.",
                ),
            ],
            outputs=[
                io.String.Output(
                    "text",
                    tooltip="The text after replacement, with the rules applied in order 1, 2, 3.",
                ),
            ],
        )

    @classmethod
    def validate_inputs(cls, mode=None):
        # 老工作流里存的还是中文选项值（"字面"/"正则"），按选项列表校验会直接
        # 报 Value not in list。具名列出 mode → ComfyUI 跳过列表校验，
        # 真正的换值在 execute 开头的 coerce() 里做。
        return True

    @classmethod
    def execute(cls, text="", mode=LITERAL, find1="", replace1="",
                find2="", replace2="", find3="", replace3=""):
        # 🔴 V3 不能套 @combo_legacy（它按 cls.FUNCTION 找方法，而 V3 的 FUNCTION
        # 是基类给的 EXECUTE_NORMALIZED）。直接在这里 coerce，语义与 V1 装饰器一致。
        mode = coerce("QG_TextReplace", "mode", mode)
        # text 是 required 槽，但上游输出的值可能是 None（未求值 / 空输出），
        # 拿它去拼接会抛看不出源头的 AttributeError。
        if text is None:
            text = ""
        elif not isinstance(text, str):
            text = str(text)

        rules = ((find1, replace1), (find2, replace2), (find3, replace3))
        for index, (find, replace) in enumerate(rules):
            text = cls._apply_rule(text, find, replace, mode, index + 1)
        return io.NodeOutput(text)

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
                "[QG-tools] Text Replace: rule %d uses regex mode but %s is not a valid regex - "
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
                "[QG-tools] Text Replace: rule %d has an escape in %s that regex does not understand - %r (%s). "
                "In regex mode the replacement is a template: write backslashes twice (C:\\temp), "
                "\\1 means group 1. To insert text that contains backslashes verbatim, "
                "switch this rule to literal mode (literal does not interpret anything)."
                % (rule_no, _REPLACE_LABEL, replace, exc)
            ) from None


NODE_CLASS_MAPPINGS = {"QG_TextReplace": QGTextReplace}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextReplace": "Text Replace"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
