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


class QGTextConcat:
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Joins two texts with a separator: text1 + separator + text2. Both "
        "texts are input slots; the separator is a widget. Nothing is "
        "trimmed - put a space or a newline in the separator if you want one. "
        "A slot with nothing wired into it is skipped entirely, separator "
        "included, so a single-text pass-through stays exact."
    )
    SEARCH_ALIASES = [
        "concat", "merge", "join", "combine", "text", "合并", "拼接", "连接", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "text1": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "The first text, wired from upstream. Leave it unwired and it disappears from the join, separator and all.",
                    },
                ),
                "text2": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "forceInput": True,
                        "tooltip": "The second text, wired from upstream. Leave it unwired and it disappears from the join, separator and all.",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "multiline": False,
                        "default": "",
                        "tooltip": "Inserted verbatim between the texts that are wired; type a space or a newline if that is what you want.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_TOOLTIPS = (
        "The wired texts joined by the separator, nothing trimmed.",
    )
    FUNCTION = "execute"

    def execute(self, text1=_MISSING, text2=_MISSING, separator=""):
        pieces = []
        for piece in (text1, text2):
            if piece is _MISSING:
                continue  # not wired: drop it, and the separator goes too
            pieces.append("" if piece is None else str(piece))
        return (separator.join(pieces),)


NODE_CLASS_MAPPINGS = {"QG_TextConcat": QGTextConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextConcat": "Text Concat"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
