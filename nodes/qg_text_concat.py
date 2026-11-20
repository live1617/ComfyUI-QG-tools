# -*- coding: utf-8 -*-
"""QG_TextConcat - join two pieces of text with a separator.

Written for ComfyUI-QG-tools on 2026-10-30, replacing the v0.9.4 port of
Comfyroll's ``CR_TextConcatenate`` (MIT). The idea - text1 + separator +
text2, nothing trimmed - is the same and stays the same; the port could not
tell "not wired" from "wired but empty", and that turned out to matter.

What was wrong with the port
----------------------------
``concat_text`` was:

    return (text1 + separator + text2,)

with both slots defaulting to "". An unwired slot therefore arrived as "",
which is indistinguishable from a genuinely empty string sitting on the
wire - so the separator got emitted for a side that was not there:

    text1 "A" only         -> "A-"
    text2 "B" only         -> "-B"
    neither wired          -> "-"

That last one is a lone separator out of a node with nothing plugged into
it. The first two silently append or prepend a stray delimiter, which then
shows up in a prompt or a filename.

The two cases this node now keeps apart
---------------------------------------
* **not wired** - the slot defaults to ``_MISSING``, so it is dropped, and
  the separator that would have joined it goes with it.
* **wired but empty** - the value is "", it takes part, and the separator
  is kept. Empty text is a value, not a hole: joining "" and "X" with "-"
  still gives "-X", same as the port did.

This needs the function signature default to be a sentinel rather than "".
ComfyUI builds the call arguments from the inputs actually present in the
prompt (``execution.get_input_data`` returns only those) and lets Python
fill the rest from the signature, so an unwired slot never appears. If a
future frontend starts injecting INPUT_TYPES defaults for unwired slots,
this distinction silently collapses - ``tools/_check_text_concat.py``
asserts the sentinel is still in place so that day gets noticed.

Output type
-----------
``RETURN_TYPES`` was ``("*",)`` while ``RETURN_NAMES`` said ``("STRING",)``
- an output that claims one thing and is another. The value has always been
a string (upstream used its ``any_type`` so the node could feed anything),
and "*" is why the name had to be spelled out. It is declared ``STRING``
now. Existing graphs keep working: a "*" socket connected to a STRING input
is the same edge as a STRING socket connected to a STRING input, and a
connection to a non-STRING input was always going to fail at run time.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours; joining semantics unchanged. Third-party
notice: THIRD-PARTY-NOTICES.md.
"""

# Sentinel for "this slot has nothing plugged into it". Must not be None:
# None is a value an upstream node can actually produce, and the whole point
# here is to tell that apart from absence.
_MISSING = object()

from comfy_api.latest import io


class QGTextConcat(io.ComfyNode):
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Joins up to eight texts with a separator: text1 + separator + text2 + "
        "... Eight slots are declared, but the node shows two at first and "
        "grows one more each time the last visible slot gets wired, up to "
        "eight. Every text is an input slot; the separator is a widget. "
        "Nothing is trimmed - put a space or a newline in the separator if you "
        "want one. A slot with nothing wired into it is skipped entirely, "
        "separator included, so a single-text pass-through stays exact."
    )
    SEARCH_ALIASES = [
        "concat", "merge", "join", "combine", "text", "合并", "拼接", "连接", "qg",
    ]

    @classmethod
    def define_schema(cls):
        # 8 个 text 槽是 forceInput optional；separator 是普通 widget，必须排末尾
        # （widgets_values 按位置存，V1 就在 optional 最后）。
        _text_tips = [
            "The first text, wired from upstream. Leave it unwired and it disappears from the join, separator and all.",
            "The second text, wired from upstream. Leave it unwired and it disappears from the join, separator and all.",
            "The third text, wired from upstream. Shown once text2 is wired; unwired it disappears from the join, separator and all.",
            "The fourth text, wired from upstream. Shown once text3 is wired; unwired it disappears from the join, separator and all.",
            "The fifth text, wired from upstream. Shown once text4 is wired; unwired it disappears from the join, separator and all.",
            "The sixth text, wired from upstream. Shown once text5 is wired; unwired it disappears from the join, separator and all.",
            "The seventh text, wired from upstream. Shown once text6 is wired; unwired it disappears from the join, separator and all.",
            "The eighth and last text, wired from upstream. Shown once text7 is wired; unwired it disappears from the join, separator and all.",
        ]
        inputs = [
            io.String.Input("text%d" % (i + 1), optional=True, extra_dict={"forceInput": True},
                            tooltip=tip)
            for i, tip in enumerate(_text_tips)
        ]
        inputs.append(io.String.Input("separator", optional=True,
            tooltip="Inserted verbatim between the texts that are wired; type a space or a newline if that is what you want."))
        return io.Schema(
            node_id="QG_TextConcat",
            display_name="Text Concat",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=inputs,
            outputs=[
                io.String.Output("text", tooltip="The wired texts joined by the separator, nothing trimmed."),
            ],
        )

    @classmethod
    def execute(
        cls,
        text1=_MISSING, text2=_MISSING, text3=_MISSING, text4=_MISSING,
        text5=_MISSING, text6=_MISSING, text7=_MISSING, text8=_MISSING,
        separator="",
    ):
        pieces = []
        for piece in (text1, text2, text3, text4, text5, text6, text7, text8):
            if piece is _MISSING:
                continue  # not wired: drop it, and the separator goes too
            pieces.append("" if piece is None else str(piece))
        return io.NodeOutput(separator.join(pieces))


NODE_CLASS_MAPPINGS = {"QG_TextConcat": QGTextConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextConcat": "Text Concat"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
