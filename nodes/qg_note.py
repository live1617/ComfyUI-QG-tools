# -*- coding: utf-8 -*-
"""QG_Note - a sticky note / title card on the canvas.

1:1 of the author's own QG-Multipack plugin (``note_node.py``), 2026-11-08.
Only wording and placement changed: CATEGORY "QG 工具" -> "QG-tools/Workflow",
display name "QG 注释" -> "Note", DESCRIPTION anglicised.

The backend class exists only so the node shows up in the node library: it has
no inputs, no outputs and is not an OUTPUT_NODE, so it never enters a prompt
and never runs.

Everything real lives in the frontend (``web/note/index.js``):
  * text, font size, colours, alignment, line height, radius … are stored in
    the node's ``properties`` and saved with the workflow through LiteGraph's
    own serialization;
  * that file draws the card, handles double-click editing, links, right-drag
    scaling and pinning.

Why keep a backend shell at all: Goohaitools' 孤海注释 registers purely in the
frontend, so it is absent from /object_info and cannot be found in the node
search menu. With this definition, "add node -> QG-tools -> Note" works.
"""

from __future__ import annotations


class QGNote:
    CATEGORY = "QG-tools/Workflow"
    DESCRIPTION = (
        "A sticky note or title card on the canvas. Double-click to edit the "
        "text; the toolbar above the note sets font size, alignment, line "
        "height, text colour, background colour and opacity, corner radius and "
        "the outline. CJK text wraps automatically, and http(s) / www links or "
        "[[label|url]] in the text become clickable blue links. Right-drag "
        "scales text and card together, the bottom-right corner resizes the "
        "card only, and the context menu pins the node (clicks then pass "
        "through), copies the text and switches colour presets. Presentation "
        "only: no outputs, never queued."
    )
    SEARCH_ALIASES = [
        "note",
        "sticky note",
        "comment",
        "annotation",
        "label",
        "title",
        "注释",
        "便签",
        "备注",
        "说明",
        "标题",
        "孤海注释",
        "qg",
    ]
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        # 不设任何 widget：文本放在 properties 里，避免节点上多出一个输入框
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        # 正常不会执行；保留一个完整的节点类，便于静态检查与单元测试
        return ()


NODE_CLASS_MAPPINGS = {"QG_Note": QGNote}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_Note": "Note"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
