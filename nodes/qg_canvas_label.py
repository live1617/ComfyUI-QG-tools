# -*- coding: utf-8 -*-
"""Canvas Label — a free-floating block of plain text on the canvas.

Everything about this node lives in the frontend: the text, the font, the
colour, the background and the rotation are all stored on the node itself and
drawn by ``node.draw()``. The backend never runs it — the node has no outputs,
so ``graphToPrompt`` cannot reach it while walking back from the output nodes
and it drops out of the prompt silently.

That is why it must stay output-less: give it an output and the backend is
handed a type with ``RETURN_TYPES = ()`` and the whole prompt fails validation.
"""

from __future__ import annotations


class QGCanvasLabel:
    CATEGORY = "QG-tools/标注"
    DESCRIPTION = (
        "A plain text label you drop anywhere on the canvas: section titles, "
        "reminders, a note next to a group. No wires, no execution. Double "
        "click (or right-click → Edit label…) to open a floating toolbar "
        "under the node — size, font, colour, background, rounding, padding, "
        "alignment and rotation all apply to the canvas live while you type. "
        "Use the Markdown note instead when you want headings, lists, tables "
        "or code blocks."
    )
    SEARCH_ALIASES = [
        "label",
        "canvas label",
        "text",
        "note",
        "title",
        "sticky note",
        "annotation",
        "comment",
        "标签",
        "文字",
        "便签",
        "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        # Never reached: with no outputs the node is not part of any prompt.
        # Kept so the class is a complete node.
        return ()


NODE_CLASS_MAPPINGS = {"QG_CanvasLabel": QGCanvasLabel}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_CanvasLabel": "画布标签"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
