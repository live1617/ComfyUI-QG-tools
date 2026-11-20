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


from comfy_api.latest import io


class QGPromptLine(io.ComfyNode):
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
    @classmethod
    def define_schema(cls):
        # 两路输出都是 is_output_list；COMBO 是 V1 的伪类型，用 io.Custom 表达。
        return io.Schema(
            node_id="QG_PromptLine",
            display_name="Prompt Line",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input("prompt", multiline=True, default="text",
                    tooltip="Multi-line text, one prompt per line; the output is the list of rows."),
                io.Int.Input("start_index", default=0, min=0, max=9999, step=1,
                    tooltip="Which row to start from (0 is the first). Past the last row it falls back to that last row."),
                io.Int.Input("max_rows", default=1000, min=1, max=9999, step=1,
                    tooltip="How many rows to take at most; fewer are returned when the text runs out."),
                io.Boolean.Input("remove_empty_lines", default=True,
                    tooltip="Drop blank and whitespace-only rows before the start index / max rows slice is applied."),
            ],
            outputs=[
                io.String.Output("STRING", is_output_list=True,
                    tooltip="Every selected row as a list of strings."),
                io.Custom("COMBO").Output("COMBO", is_output_list=True,
                    tooltip="The same rows, typed as options so the slot can drive a combo input."),
            ],
        )

    @classmethod
    def execute(cls, prompt, start_index, max_rows, remove_empty_lines=True):
        lines = str(prompt).split("\n")

        if remove_empty_lines:
            lines = [line for line in lines if line.strip()]

        # Empty input gives len(lines) - 1 == -1 here; the slice below is then
        # empty instead of raising. Same as the reference node.
        start_index = max(0, min(start_index, len(lines) - 1))

        end_index = min(start_index + max_rows, len(lines))

        rows = lines[start_index:end_index]

        return io.NodeOutput(rows, rows)


NODE_CLASS_MAPPINGS = {"QG_PromptLine": QGPromptLine}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_PromptLine": "Prompt Line"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
