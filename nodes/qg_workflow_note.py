"""Workflow Note — the card that makes a shared workflow self-explanatory.

Ported from ComfyUI-AusBoss (nodes/node_workflow_note.py + the matching
frontend), MIT licensed. Renamed to the QG_ prefix,
category moved under ``QG-tools/工作流``, UI text translated to Chinese.

The whole node is a presentation surface: a title banner, a short how-to in
Markdown, the models it needs with download buttons and the folder each one
goes in, the node packs it depends on, and the author's links. The frontend
checks the model files and node packs against this install and marks each
row installed or missing, so a downloaded workflow tells its new owner what
is left to do before the first run.

The backend keeps one hidden STRING widget holding the card as JSON, so
save/load, undo and the API format all ride LiteGraph's default path. Nothing
executes: the node has no outputs and is never part of the prompt graph.

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

from comfy_api.latest import io


class QGWorkflowNote(io.ComfyNode):
    CATEGORY = "QG-tools/Workflow"
    DESCRIPTION = (
        "A workflow card for sharing: a big title, a Markdown how-to, the "
        "models the workflow needs with download buttons and the folder "
        "each goes in, the node packs it depends on, and your links. Each "
        "model and pack row is checked against this install and marked "
        "installed or missing, so whoever opens the workflow sees exactly "
        "what is left to set up. Click the pencil to edit; switch to the "
        "banner layout for a plain title label. Nothing runs — the node has "
        "no outputs."
    )
    SEARCH_ALIASES = [
        "note",
        "readme",
        "workflow note",
        "model links",
        "download models",
        "label",
        "title",
        "banner",
        "credits",
        "qg",
    ]

    @classmethod
    def define_schema(cls):
        # 零输出：整张卡片是纯前端呈现，node 不进 prompt 图。note 是隐藏的
        # JSON 存档控件，前端铅笔编辑器写回这里。
        return io.Schema(
            node_id="QG_WorkflowNote",
            display_name="Workflow Note",
            category="QG-tools/Workflow",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.String.Input(
                    "note",
                    multiline=True,
                    default="{}",
                    tooltip=(
                        "The card as JSON: title, subtitle, author, "
                        "Markdown body, model rows, node-pack rows and "
                        "links. The pencil on the card edits it; this "
                        "field is the storage behind that editor."
                    ),
                ),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, note="{}"):
        # Never reached: with no outputs and OUTPUT_NODE unset the node is
        # not part of any prompt. Kept so the class is a complete node.
        return io.NodeOutput()


NODE_CLASS_MAPPINGS = {"QG_WorkflowNote": QGWorkflowNote}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_WorkflowNote": "Workflow Note"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
