# -*- coding: utf-8 -*-
"""QG_TextSplit - split text by a delimiter into lists and pick one segment.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.8.5 port of
ComfyUI_Muye's ``TextSplitByDelimiterEnhanced`` (MIT). The three outputs and
the four knobs are unchanged; what follows is what was wrong under them.

Outputs
-------
ALL      every non-empty segment from every input text (``total_index``)
LIST     the full split of one chosen input text (``list_index``)
SEGMENT  one segment, from the total list or from LIST (``segment_index``)

Indexes are 1-based. A zero means "the whole thing" for ALL and "nothing" for
LIST and SEGMENT.

The bug this rewrite fixes
--------------------------
The pool SEGMENT drew from was chosen by comparing the mode input against a
*Chinese* literal::

    pool = total if input_source == "文本框" else selected_pieces

but ``input_source`` holds ``"text-field"`` or ``"external-list"`` - always
has, since the v0.8.5 options were translated. The comparison could never be
true, so SEGMENT always read from ``selected_pieces``. In text-field mode
that is the same list as ``total``, which is why it went unnoticed, *except*
when ``list_index`` was 0: then ``selected_pieces`` was emptied for LIST's
sake and SEGMENT silently went blank with it.

    text-field, segment_index=2, list_index=1  -> "b"
    text-field, segment_index=2, list_index=0  -> ""   (wrong: LIST only)

SEGMENT is governed by ``segment_index`` alone. Setting ``list_index`` to 0
to blank the LIST output must not blank SEGMENT too. Two things had to change
for that to be true, and only the first was found at the time:

* the mode is compared against the constants the options actually hold, so
  text-field mode reads from ``total``;
* ``selected_pieces`` is no longer emptied when ``list_index`` is 0. In
  external-list mode the SEGMENT pool *is* ``selected_pieces``, so clearing it
  for LIST's sake blanked SEGMENT there as well - the same defect, one mode
  over.

    external-list, texts=["a,b"], segment_index=1, list_index=0
        before: ""   (LIST blanking also blanked SEGMENT)
        after:  "a"

Two other things
----------------
* A delimiter that is not a valid regular expression raised a bare English
  ``missing ), unterminated subpattern``. It now names the field, in Chinese.
* ``re.split`` keeps the delimiter in the result when the pattern has a
  capturing group: splitting ``"a,b"`` on ``"(,)"`` yields
  ``["a", ",", "b"]``. That is Python's behaviour, not ours, and it is
  occasionally what someone wants - so it stays, documented, rather than
  being "fixed" into a surprise.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import re

from ._qg_combo_legacy import combo_legacy

TEXT_FIELD = "text-field"
EXTERNAL_LIST = "external-list"
MODES = [TEXT_FIELD, EXTERNAL_LIST]

EMPTY = ([], [], "")


def _split(value, delimiter, use_regex):
    """Split one string and drop pieces that are empty after stripping.

    Upstream dropped them too, and it is why the indexes count non-empty
    pieces only: a text that starts with the delimiter does not get an empty
    segment 0 that shifts everything by one.
    """
    pieces = re.split(delimiter, value) if use_regex else value.split(delimiter)
    return [piece.strip() for piece in pieces if piece.strip()]


@combo_legacy("QG_TextSplit")
class QGTextSplit:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Splits text (typed in, or a list from upstream) by a delimiter, plain "
        "or regular expression, and exposes three outputs: every segment from "
        "every text, the full split of one chosen text, and one chosen segment. "
        "Empty pieces are dropped. The three indexes are 1-based; 0 means 'all' "
        "for the total list and 'nothing' for the other two. In regex mode a "
        "pattern with a capturing group keeps the delimiter in the results."
    )
    SEARCH_ALIASES = [
        "split", "delimiter", "segment", "text", "分割", "分隔符", "切分", "qg",
    ]

    @classmethod
    def VALIDATE_INPUTS(cls, input_source=None):
        # 老工作流里存的还是中文选项值（中文原文），按下标校验会直接
        # 报 Value not in list。具名列出这几个选项 → ComfyUI 跳过列表校验，
        # 真正的换值在 combo_legacy 里做，数字的 min/max 校验不受影响。
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_source": (
                    MODES,
                    {"default": TEXT_FIELD, "tooltip": "text-field uses the single block of text below; external-list uses the texts wired in."},
                ),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "The multi-line text to split, used in text-field mode only.",
                    },
                ),
                "delimiter": (
                    "STRING",
                    {
                        "default": "<think>",
                        "tooltip": "The delimiter. With use_regex on it is read as a regular expression; the default suits cutting out a model's thinking block. A pattern with a capturing group keeps the delimiter in the results.",
                    },
                ),
                "use_regex": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "On: the delimiter is a regular expression. Off: it is split as a plain string.",
                    },
                ),
                "segment_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "Which segment the SEGMENT output returns, counting from 1; 0 returns an empty string. SEGMENT follows this index and nothing else.",
                    },
                ),
                "list_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "Which input text's full split the LIST output returns, counting from 1; 0 returns an empty list. LIST follows this index and nothing else.",
                    },
                ),
                "total_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "ALL output: 0 lists every segment, and N takes only segment N from each text.",
                    },
                ),
            },
            "optional": {
                "texts": (
                    "STRING",
                    {
                        "forceInput": True,
                        "is_list": True,
                        "tooltip": "The external list of texts, used in external-list mode only.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("ALL", "LIST", "SEGMENT")
    OUTPUT_TOOLTIPS = (
        "Every segment from every input, concatenated (governed by total_index).",
        "The full split of the chosen input text (governed by list_index).",
        "The single segment chosen (governed by segment_index).",
    )
    OUTPUT_IS_LIST = (True, True, False)
    FUNCTION = "execute"

    def execute(self, input_source, text, delimiter, use_regex,
                segment_index, list_index, total_index, texts=None):
        if not delimiter:
            return EMPTY

        if input_source == TEXT_FIELD:
            if not text:
                return EMPTY
            sources = [text]
        else:
            if not texts:
                return EMPTY
            sources = list(texts) if not isinstance(texts, str) else [texts]

        try:
            split_results = [_split(item, delimiter, use_regex) for item in sources]
        except re.error as exc:
            raise ValueError(
                "[QG-tools] Text Split: regex delimiters are on but the delimiter is not "
                "a valid regex - %r (%s). To split on plain characters, turn off Use Regex."
                % (delimiter, exc)
            ) from None

        total = [piece for pieces in split_results for piece in pieces]

        # ---- ALL：total_index 为 0 给全部，否则从每段文本里各取第 N 段 ----
        if total_index == 0:
            all_out = total
        else:
            idx = total_index - 1
            all_out = [pieces[idx] for pieces in split_results if 0 <= idx < len(pieces)]

        # ---- LIST：list_index 为 0 给空列表，越界钳到最后一组 ----
        # 🔴 取数池和输出必须分开算。这里曾经共用：list_index=0 时把
        #    selected_pieces 一起清空，于是 SEGMENT 跟着变空 —— 那正是
        #    下面注释里那个 bug 的另一半，修了模式比较之后仍然在。
        pos = max(0, min((list_index or 1) - 1, len(sources) - 1))
        selected_pieces = split_results[pos]
        list_out = [] if list_index == 0 else selected_pieces

        # ---- SEGMENT：只受 segment_index 支配 ----
        # 🔴 这里曾经写成 input_source == "文本框"，而该输入的值是 "text-field"
        # / "external-list"（v0.8.5 起选项就是英文），条件永假 → 永远走
        # selected_pieces。文本框模式下两者恰好同源所以看不出来，唯独
        # list_index=0 时 selected_pieces 被清空，SEGMENT 跟着一起变空 ——
        # 而 list_index 只该管 LIST。
        if segment_index == 0:
            segment = ""
        else:
            pool = total if input_source == TEXT_FIELD else selected_pieces
            idx = segment_index - 1
            segment = pool[idx] if 0 <= idx < len(pool) else ""

        return (all_out, list_out, segment)


NODE_CLASS_MAPPINGS = {"QG_TextSplit": QGTextSplit}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextSplit": "Text Split"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
