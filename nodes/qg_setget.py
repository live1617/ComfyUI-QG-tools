# -*- coding: utf-8 -*-
"""QG_SetPoint / QG_GetPoint - collapse a long wire into a named pair.

1:1 of the author's own QG-Multipack plugin (``web/qg_setget.js``, one file for
both nodes), 2026-11-08. All the behaviour lives in the frontend
(``web/setget/index.js``); these two classes are shells that put the nodes into
/object_info so the node library and the search menu can find them.

Why shells, when the source pack registered them purely in the frontend with
``python_module: "custom_nodes.frontend_only"``: every node in this pack has a
backend definition, and the tooling that keeps the four registries in sync
(packaging, the translation checks, the size table) all keys off
``nodes/*.py``. The visible cost is one thing only — the small green
``frontend_only`` badge the source pack showed in the node's top-right corner
disappears, because the definition is now a real module. Nothing else changes:
both classes still declare ``isVirtualNode`` in the frontend, so they never
enter a prompt and never execute.

Pair rule: QG_GetPoint resolves its value by looking up a QG_SetPoint with the
same name in the same graph, so the two must be moved (and installed) together.
The frontend also yields to KJNodes when its Set/Get patches are present, so
both menu entries never show up twice.
"""

from __future__ import annotations


class QGSetPoint:
    """Name a wire: one input on the left, one output on the right."""

    CATEGORY = "QG-tools/Workflow"
    DESCRIPTION = (
        "Name a link: feed an upstream output into the left slot, type the name "
        "into 'Name', then keep wiring from the right slot. The title and port "
        "type follow whatever is connected, and a get point with the same name "
        "carries the same value anywhere in the graph. Frontend only: never "
        "executes, never enters a prompt."
    )
    SEARCH_ALIASES = [
        "set point", "setpoint", "set node", "setnode", "name a link",
        "named link", "wireless", "reroute", "设置点", "设置节点", "命名连线",
        "无线连接", "qg",
    ]
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        # 端口由前端自己 addInput / addOutput（通配类型，接什么变什么）。
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        return ()


class QGGetPoint:
    """Read the value of a named Set Point without drawing a long wire."""

    CATEGORY = "QG-tools/Workflow"
    DESCRIPTION = (
        "Pick the name of a Set Point from the 'Name' dropdown and the right "
        "slot carries that link's value, so a long wire can be cut into two "
        "short ones. The port type follows the Set Point, and a link that has "
        "become incompatible is dropped instead of silently mis-wired. "
        "Frontend only: never executes, never enters a prompt."
    )
    SEARCH_ALIASES = [
        "get point", "getpoint", "get node", "getnode", "named link",
        "wireless", "reroute", "获取点", "获取节点", "取值", "无线连接", "qg",
    ]
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "QG_SetPoint": QGSetPoint,
    "QG_GetPoint": QGGetPoint,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "QG_SetPoint": "Set Point",
    "QG_GetPoint": "Get Point",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
