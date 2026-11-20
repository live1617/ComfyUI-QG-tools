# -*- coding: utf-8 -*-
"""QG_StringConstantMultiline - multi-line fixed text value.

Written for ComfyUI-QG-tools on 2026-11-18. Independent implementation; the
node shape (a text box emitted as a STRING, with a strip-newlines toggle)
follows the common "string constant" idea, but no upstream source was copied
and no dependency is required. Kept in its own module so the i18n checker
(which reads INPUT_TYPES per file) sees exactly one node per file.
"""

# 多行版的换行清理：去掉所有换行（含 CR）再去首尾空白。
# 单独写成函数便于离线逐字验证边界（纯空格、全换行、CRLF）。
def _strip_newlines(text):
    """Remove every newline/CR and trim the ends; other characters untouched."""
    value = "" if text is None else str(text)
    return value.replace("\n", "").replace("\r", "").strip()


from comfy_api.latest import io


class QGStringConstantMultiline(io.ComfyNode):
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "A multi-line text constant with a 'strip newlines' switch. With "
        "the switch on, all line breaks are removed and the ends trimmed, "
        "so a prompt typed across lines becomes one clean line; with it "
        "off, the text is emitted exactly as typed."
    )
    SEARCH_ALIASES = [
        "string constant multiline", "multiline string constant",
        "text constant multiline", "multiline string", "string", "text",
        "value", "多行字符串常量", "多行字符串", "多行文本常量", "字符串常量", "常量", "qg",
    ]

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QG_StringConstantMultiline",
            display_name="String Constant Multiline",
            category="QG-tools/Text",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "string",
                    multiline=True,
                    default="",
                    tooltip="The fixed text to emit, typed across multiple lines. Newlines are kept unless 'strip newlines' is on.",
                ),
                io.Boolean.Input(
                    "strip_newlines",
                    default=True,
                    tooltip="When on, remove every line break and trim the ends before emitting; when off, pass the text through exactly as typed.",
                ),
            ],
            outputs=[
                # "string" 是存档键，必须显式写 id，否则回落成类型名 STRING。
                io.String.Output(
                    "string",
                    tooltip="The constant text, newline-stripped or verbatim depending on the switch.",
                ),
            ],
        )

    @classmethod
    def execute(cls, string="", strip_newlines=True):
        if strip_newlines:
            return io.NodeOutput(_strip_newlines(string))
        return io.NodeOutput("" if string is None else str(string))

NODE_CLASS_MAPPINGS = {"QG_StringConstantMultiline": QGStringConstantMultiline}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_StringConstantMultiline": "String Constant Multiline"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
