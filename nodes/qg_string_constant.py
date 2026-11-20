# -*- coding: utf-8 -*-
"""QG_StringConstant / QG_StringConstantMultiline - fixed text values.

Written for ComfyUI-QG-tools on 2026-11-18. The idea comes from the common
"string constant" node found in several node packs (KJNodes among them): a
text box on the node whose content is emitted as a STRING output, so a fixed
prompt, filename fragment or label can be fed into a graph without an upstream
text node.

This is an independent implementation, not a copy of any upstream source.
Only the public behaviour is shared: one STRING box, one STRING output, and
an optional "strip newlines" toggle on the multiline variant.

Two variants
------------
* QG_StringConstant - single-line box, value passed through verbatim.
* QG_StringConstantMultiline - multi-line box with a ``strip_newlines``
  switch; when on, every newline is removed and the result is stripped of
  surrounding whitespace. Text that was typed across lines becomes one
  clean line, which is handy for prompt fragments that must not carry line
  breaks. When off, the text is passed through exactly as typed.

Both keep the widget value stored under the English key ``string`` (the
archive key) and rely on the Chinese locale tables for the on-screen label.
"""

from comfy_api.latest import io


class QGStringConstant(io.ComfyNode):
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "A single-line text constant: type a value once and it is emitted "
        "as a STRING output. Nothing is trimmed or changed - exactly what "
        "you typed is what comes out. Useful for fixed prompts, filename "
        "fragments or labels without needing an upstream text node."
    )
    SEARCH_ALIASES = [
        "string constant", "constant string", "text constant", "string",
        "text", "value", "字符串常量", "字符串", "文本常量", "常量", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_StringConstant",
            display_name="String Constant",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "string",
                    multiline=False,
                    default="",
                    tooltip="The fixed text to emit. Typed once on the node and passed through verbatim, nothing trimmed.",
                ),
            ],
            outputs=[
                # "string" 是存档键，必须显式写 id，否则回落成类型名 STRING。
                io.String.Output(
                    "string",
                    tooltip="The text exactly as typed in the box.",
                ),
            ],
        )

    @classmethod
    def execute(cls, string=""):
        return io.NodeOutput("" if string is None else str(string))


NODE_CLASS_MAPPINGS = {
    "QG_StringConstant": QGStringConstant,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "QG_StringConstant": "String Constant",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
