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
"""

import re


class QGTextSplit:
    CATEGORY = "QG-tools/文本"
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
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_source": (
                    ["文本框", "外部列表"],
                    {"default": "文本框", "tooltip": "文本框：用下面的单段文本；外部列表：用接进来的 texts"},
                ),
                "text": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "要分割的多行文本（仅在「文本框」模式下使用）",
                    },
                ),
                "delimiter": (
                    "STRING",
                    {
                        "default": "<think>",
                        "tooltip": "分隔符；打开「使用正则」后按正则解释（默认值适合切掉模型的思考块）",
                    },
                ),
                "use_regex": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "开：分隔符按正则表达式处理；关：按普通字符串切",
                    },
                ),
                "segment_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "SEGMENT 输出取第几段（从 1 开始；0 = 输出空字符串）",
                    },
                ),
                "list_index": (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "LIST 输出取第几条输入文本的完整分割（从 1 开始；0 = 输出空列表）",
                    },
                ),
                "total_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 100,
                        "step": 1,
                        "tooltip": "ALL 输出：0 = 列出所有段落；N = 每条文本只取第 N 段",
                    },
                ),
            },
            "optional": {
                "texts": (
                    "STRING",
                    {
                        "forceInput": True,
                        "is_list": True,
                        "tooltip": "外部文本列表（仅在「外部列表」模式下使用）",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("ALL", "LIST", "SEGMENT")
    OUTPUT_TOOLTIPS = (
        "所有输入文本分割后的段落合集（受 total_index 影响）。",
        "选定那条输入文本的完整分割结果（受 list_index 影响）。",
        "选定的单个段落（受 segment_index 影响）。",
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

        if input_source == "文本框":
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
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextSplit": "文本按分隔符分割"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
