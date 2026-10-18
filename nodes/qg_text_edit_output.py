# -*- coding: utf-8 -*-
"""Text Edit Output — a manual text box that emits its content as a list.

Ported from ComfyUI-Muye #24 (text/text_edit_output.py, class MuyeTextEditOutput).
The node is an output node: it hands the typed text back as a one-element STRING
list, so it can feed any downstream text input. No model, no dependencies.

Source node ID was "MuyeTextEditOutput" (display "文本"); renamed to the QG_
prefix and given an English display name per this plugin's conventions.
"""

from __future__ import annotations


class QGTextEditOutput:
    CATEGORY = "QG-tools/文本"
    DESCRIPTION = (
        "A manual text box that outputs its content as a one-element STRING "
        "list. Type a prompt or a note on the canvas, then pipe it into any "
        "downstream text input. No model, no dependencies."
    )
    SEARCH_ALIASES = ["text", "edit", "note", "prompt", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "rows": 5,
                    "tooltip": "Manually entered text",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_IS_LIST = (True,)
    OUTPUT_NODE = True
    FUNCTION = "process_text"

    def process_text(self, text=""):
        # Emit the whole edited text as a single-item list; do not split.
        text = text if text else ""
        return ([text],)


NODE_CLASS_MAPPINGS = {"QG_TextEditOutput": QGTextEditOutput}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_TextEditOutput": "Text"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
