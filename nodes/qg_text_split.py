# -*- coding: utf-8 -*-
"""QG_TextSplit - split text by a delimiter into lists and pick one segment.

Ported from ComfyUI_Muye (text/text_split_delimiter.py, class
TextSplitByDelimiterEnhanced), MIT licensed, authored by Muye. QG changes:

  * ASCII input names, Chinese tooltips; the three indexes are documented on the
    node instead of only in the source.
  * Empty segments (after stripping) are dropped, as upstream did - the
    zero-based indexing therefore counts only non-empty pieces.
  * Everything else - the three outputs and the four index knobs - behaves as
    upstream: 0 means "everything" for the total list, "nothing" for the other
    two.

Outputs:
  ALL       every non-empty segment from every input text
  LIST      the full split of one chosen input text (list_index)
  SEGMENT   one segment (segment_index) of the total list or of LIST

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten; behaviour changes are
listed above. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import re
from ._qg_combo_legacy import combo_legacy


@combo_legacy("QG_TextSplit")
class QGTextSplit:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Splits text (typed in, or a list from upstream) by a delimiter, plain "
        "or regular expression, and exposes three outputs: every segment from "
        "every text, the full split of one chosen text, and one chosen segment. "
        "Empty pieces are dropped. The three indexes are 1-based; 0 means 'all' "
        "for the total list and 'nothing' for the other two."
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
                    ["text-field", "external-list"],
                    {"default": "text-field", "tooltip": "text-field uses the single block of text below; external-list uses the texts wired in."},
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
                        "tooltip": "The delimiter. With use_regex on it is read as a regular expression; the default suits cutting out a model's thinking block.",
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
                        "tooltip": "Which segment the SEGMENT output returns, counting from 1; 0 returns an empty string.",
                    },
                ),
                "list_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "Which input text's full split the LIST output returns, counting from 1; 0 returns an empty list.",
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
        "Every segment from every input, concatenated (governed by "
        "total_index).",
        "The full split of the chosen input text (governed by list_index).",
        "The single segment chosen (governed by segment_index).",
    )
    OUTPUT_IS_LIST = (True, True, False)
    FUNCTION = "split_text"

    def _split(self, value, delimiter, use_regex):
        pieces = re.split(delimiter, value) if use_regex else value.split(delimiter)
        return [piece.strip() for piece in pieces if piece.strip()]

    def split_text(self, input_source, text, delimiter, use_regex,
                   segment_index, list_index, total_index, texts=None):
        if not delimiter:
            return ([], [], "")

        if input_source == "text-field":
            if not text:
                return ([], [], "")
            sources = [text]
        else:
            if not texts:
                return ([], [], "")
            sources = list(texts) if not isinstance(texts, str) else [texts]

        split_results = [self._split(item, delimiter, use_regex) for item in sources]
        total = [piece for pieces in split_results for piece in pieces]

        if total_index == 0:
            all_out = total
        else:
            idx = total_index - 1
            all_out = [pieces[idx] for pieces in split_results if 0 <= idx < len(pieces)]

        if list_index == 0:
            list_out = []
            selected_pieces = []
        else:
            pos = max(0, min(list_index - 1, len(sources) - 1))
            list_out = split_results[pos]
            selected_pieces = list_out

        if segment_index == 0:
            segment = ""
        else:
            idx = segment_index - 1
            pool = total if input_source == "文本框" else selected_pieces
            segment = pool[idx] if 0 <= idx < len(pool) else ""

        return (all_out, list_out, segment)


NODE_CLASS_MAPPINGS = {"QG_TextSplit": QGTextSplit}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextSplit": "Text Split"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
