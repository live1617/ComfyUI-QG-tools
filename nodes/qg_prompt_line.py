# -*- coding: utf-8 -*-
"""QG_PromptLine - split a multi-line prompt into one row per line.

1:1 of the author's own QG-Multipack plugin (``prompt_line_node.py``),
2026-11-08. What changes on the way in is only wording:

* CATEGORY "QG 工具" -> "QG-tools/Text";
* DESCRIPTION and the four tooltips anglicised (the Chinese copy lives in
  ``locales/zh/nodeDefs.json`` and the translation pack);
* the frontend button moved to ``web/prompt_line/index.js`` with an absolute
  import and an English label.

Nothing else moved. The widget names were already English, so unlike
QG_RatioResolution there is no ``LEGACY`` entry: no saved workflow can hold a
Chinese value here.

The behaviour matches ComfyUI-Easy-Use's "prompt line" (``easy promptLine``,
``py/nodes/prompt.py``) line for line, including the edges that look wrong:

* split on ``'\\n'`` only — ``\\r`` is left in place (ComfyUI's multiline
  widget submits ``\\n``, so this never shows up in practice);
* "remove empty lines" drops rows whose ``strip()`` is empty, so a row of
  spaces counts as empty;
* the start index is clamped to ``[0, len-1]`` first, which yields ``-1`` for
  an empty prompt — the slice is still empty, no exception;
* "max rows" takes that many rows from the start index and truncates at the
  end.

Both outputs are lists (``OUTPUT_IS_LIST``) holding the same rows: STRING feeds
list-aware text nodes, COMBO feeds any combo input. The frontend adds a
"fill from combo link" button that copies every option of the dropdown wired
to the COMBO output into the text box (``web/prompt_line/index.js``).
"""


class QGPromptLine:
    """Split a multi-line prompt into a list, one entry per line."""

    DESCRIPTION = (
        "Split a multi-line text into one row per line and output it as a list: "
        "STRING (list of strings) and COMBO (list of options) carry the same "
        "rows. 'remove_empty_lines' drops blank and whitespace-only rows, "
        "'start_index' and 'max_rows' pick where to start and how many rows to "
        "take. The 'fill from combo link' button on the canvas copies every "
        "option of the dropdown wired downstream into the text box. Same "
        "behaviour as Easy-Use's prompt line."
    )
    SEARCH_ALIASES = [
        "prompt line", "promptline", "prompt rows", "lines", "combo",
        "string list", "提示词行", "提示词列表", "行", "多行", "组合",
        "列表", "qg",
    ]
    CATEGORY = "QG-tools/Text"
    OUTPUT_NODE = False
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING", "COMBO")
    RETURN_NAMES = ("STRING", "COMBO")
    OUTPUT_TOOLTIPS = (
        "Every selected row as a list of strings.",
        "The same rows, typed as options so the slot can drive a combo input.",
    )
    OUTPUT_IS_LIST = (True, True)

    @classmethod
    def INPUT_TYPES(cls):
        # 🔴 Each input is written as "name": ( on its own line with the dict
        # spread over the following lines: verify_bilingual / verify_combo_i18n
        # find input names with a regex, and leaving "tooltip": at the end of
        # the line makes them treat every input as one called tooltip.
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "text",
                        "tooltip": (
                            "Multi-line text, one prompt per line; the output is "
                            "the list of rows."
                        ),
                    },
                ),
                "start_index": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 9999,
                        "step": 1,
                        "tooltip": (
                            "Which row to start from (0 is the first). Past the "
                            "last row it falls back to that last row."
                        ),
                    },
                ),
                "max_rows": (
                    "INT",
                    {
                        "default": 1000,
                        "min": 1,
                        "max": 9999,
                        "step": 1,
                        "tooltip": (
                            "How many rows to take at most; fewer are returned "
                            "when the text runs out."
                        ),
                    },
                ),
                "remove_empty_lines": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": (
                            "Drop blank and whitespace-only rows before the start "
                            "index / max rows slice is applied."
                        ),
                    },
                ),
            },
        }

    def execute(self, prompt, start_index, max_rows, remove_empty_lines=True):
        lines = str(prompt).split("\n")

        if remove_empty_lines:
            lines = [line for line in lines if line.strip()]

        # Empty input gives len(lines) - 1 == -1 here; the slice below is then
        # empty instead of raising. Same as the reference node.
        start_index = max(0, min(start_index, len(lines) - 1))

        end_index = min(start_index + max_rows, len(lines))

        rows = lines[start_index:end_index]

        return (rows, rows)


NODE_CLASS_MAPPINGS = {"QG_PromptLine": QGPromptLine}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_PromptLine": "Prompt Line"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
