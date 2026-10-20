# -*- coding: utf-8 -*-
"""Markdown Note — a sticky note on the canvas that understands Markdown.

Like the canvas label this node is frontend-only: it has no outputs, so it is
never part of the prompt and never runs. The text, font and colours live on
the node and are drawn by ``node.draw()`` with the bundled Markdown renderer
(``web/shared/md_render.mjs``, no external dependency).

Double click (or right-click → Edit text…) opens a centred dialog, preview on
the left and the form on the right. Edits only move the preview until you
press Apply, so you can try things out without touching the canvas.
"""

from __future__ import annotations


class QGMarkdownNote:
    CATEGORY = "QG-tools/标注"
    DESCRIPTION = (
        "A Markdown sticky note on the canvas: headings, bold and italic, "
        "lists, quotes, tables, code blocks and inline colour. A self "
        "contained renderer draws it — no browser HTML, no external library. "
        "Double click to open a centred editor with a live preview on the "
        "left; nothing is written to the canvas until you press Apply. "
        "Nothing runs — the node has no outputs. Use the canvas label for a "
        "single line of plain text."
    )
    SEARCH_ALIASES = [
        "markdown",
        "markdown note",
        "note",
        "sticky note",
        "canvas note",
        "annotation",
        "comment",
        "documentation",
        "便签",
        "标注",
        "说明",
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


NODE_CLASS_MAPPINGS = {"QG_MarkdownNote": QGMarkdownNote}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_MarkdownNote": "Markdown 便签"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
