"""Workflow Switches — switch parts of a workflow off and on from one card.

The whole node is a frontend panel: one row per switch, each with an
off | on pill. A switch holds the nodes that were picked for it (a box and
its Save, say), and every group can have a row of its own. Off bypasses those
nodes (or mutes them), on runs them again. A switch can also change settings
instead: it remembers what chosen nodes hold for on and for off. The truth
lives in the nodes' own modes and values; this node stores only which nodes
each switch holds, the values it remembers and its settings, in its
properties.

It is registered here, with a literal mapping key, so registry scanners and
"install missing custom nodes" can find the pack from a workflow that uses
it. The frontend marks it virtual, so it never enters a prompt. Should an API
prompt name it anyway, it is harmless: it has no inputs and no outputs, it is
not an output node and nothing can depend on it, so ComfyUI accepts the
prompt and never runs it.
"""

from __future__ import annotations


class QGWorkflowSwitches:
    CATEGORY = "QG-tools/工作流"
    DESCRIPTION = (
        "Switch parts of a workflow off and on from one small card. Select "
        "the nodes that make up a part, such as a box and its Save, and "
        "press + Switch: they get one off | on switch with a name you "
        "choose. Every group can have a switch of its own too. Off bypasses "
        "the nodes, so the picture still passes through to the next step (or "
        "mutes them - a setting). On runs them again. A switch can also "
        "change settings instead of turning nodes off: save what the nodes "
        "hold for on and for off, and one click sets Steps to 8 and turns a "
        "LoRA row on. Press Done and the node shrinks to the labels and "
        "their switches. It never runs and has no wires."
    )
    SEARCH_ALIASES = [
        "switch",
        "toggle",
        "bypass",
        "mute",
        "on off",
        "enable",
        "disable",
        "groups",
        "group bypass",
        "stages",
        "parts",
        "sections",
        "preset",
        "fast mode",
        "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        # Never reached: the frontend keeps the node out of the prompt, and
        # with no outputs nothing could ask for it.
        return ()


NODE_CLASS_MAPPINGS = {"QG_WorkflowSwitches": QGWorkflowSwitches}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_WorkflowSwitches": "Workflow Switches"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
