# -*- coding: utf-8 -*-
"""QG_FreeMemory - pass any wire through and release VRAM on the way.

Rewritten for ComfyUI-QG-tools on 2026-10-30, on top of the v0.9.x port of
ComfyUI-AusBoss's ``node_free_memory.py`` (MIT). The release routine is
unchanged and stays unchanged: it was already right.

What the release routine gets right, and keeps
----------------------------------------------
* **Every step is independent and fail-soft.** comfy absent, a core API
  renamed, CUDA absent - each just drops that entry from the list and the
  wire still flows. A memory-release node that raises on a moved API would
  delete itself from the menu on someone else's machine.
* **Nothing imports ComfyUI at module level**, for the same reason.
* **It only runs when its input changes**, like any node. That is what keeps
  it from breaking downstream caching - worth knowing before "improving" it
  into something that runs on every prompt.

What changed in this rewrite
----------------------------
The ``value`` input had no ``forceInput``. A wildcard input without it makes
the frontend draw a text box that does nothing: you can type a value into it
and it goes nowhere, because the slot is a wire and the box is not connected
to anything. QG_Exists and QG_RouteBlocker already carry the flag; this one
was missed. ``FUNCTION`` is now ``execute`` like the rest of the pack.

The wildcard type
-----------------
Was a local ``str`` subclass whose ``__ne__`` always answered "not different",
with ``__eq__`` left at ``str``'s. That combination is self-contradictory: for
any foreign type string, ``a != b`` is false while ``a == b`` is also false.
Current core validates types with ``==`` first and only then falls back to the
``__ne__`` shortcut, so it worked - but only because ``"*" == "*"``; a core
tweak would have cut every wire into this node. Both directions are now
overridden, in the pack's single wildcard module (``_qg_any_type``), together
with the ``__hash__`` that overriding ``__eq__`` takes away.

Modified for ComfyUI-QG-tools: id / class name, category, display name,
tooltips and aliases are ours. Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

from ._qg_any_type import ANY

# 通配类型走全包唯一实现。这里曾经自带一个只覆盖 ``__ne__`` 的 ``_Wildcard``，
# 那种写法在「值都是 "*"，靠字符串相等也能连上」时看不出问题，但它没有覆盖
# ``__eq__``，于是 ``__ne__`` 说「不不同」而 ``__eq__`` 说「不相等」——
# 校验一旦改回用 ``==`` 就整路连不上。
WILDCARD = ANY


def free_gpu_memory() -> list:
    """Best-effort release of model VRAM and cached allocations.

    Returns the steps that succeeded, for a one-line runtime log. Every step
    is independent and fail-soft: comfy absent, an API renamed, or CUDA not
    present each just drops that entry from the list.
    """
    freed = []
    try:
        import comfy.model_management as model_management
    except Exception:
        model_management = None
    if model_management is not None:
        try:
            model_management.unload_all_models()
            freed.append("unloaded models")
        except Exception:
            pass
        try:
            model_management.soft_empty_cache()
            freed.append("emptied the model cache")
        except Exception:
            pass
    try:
        import gc

        gc.collect()
        freed.append("collected garbage")
    except Exception:
        pass
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            freed.append("emptied the CUDA cache")
    except Exception:
        pass
    return freed


class QGFreeMemory:
    """Free VRAM in the middle of a graph without breaking the wire."""

    CATEGORY = "QG-tools/Workflow"
    DESCRIPTION = (
        "Passes any wire through unchanged and, on the way, unloads ComfyUI's "
        "cached models and empties the CUDA cache. Put it between a heavy stage "
        "and the next one when the second keeps running out of VRAM. Every "
        "release step is best-effort: if a core API is missing or renamed, that "
        "step is skipped and the wire still flows. Like any node it only runs "
        "when its input changes, so it never breaks caching downstream."
    )
    SEARCH_ALIASES = ["free vram", "purge vram", "unload models", "empty cache", "释放显存", "清显存", "qg"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (
                    WILDCARD,
                    {
                        # 通配输入不加 forceInput，前端会在画布上画一个填了也没用的
                        # 文本框（QG_Exists / QG_RouteBlocker 都带着这个标志）。
                        "forceInput": True,
                        "tooltip": (
                            "Any wire: image, latent, model, text, number. Memory "
                            "is freed when this node runs, then the value carries "
                            "on unchanged."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = (WILDCARD,)
    RETURN_NAMES = ("value",)
    OUTPUT_TOOLTIPS = ("The input, passed through untouched.",)
    FUNCTION = "execute"

    def execute(self, value):
        freed = free_gpu_memory()
        detail = ", ".join(freed) if freed else "nothing to free"
        # ASCII only: the banner rule applies to any console line we print.
        print("[QG-tools] Free Memory: %s." % detail)
        return (value,)


NODE_CLASS_MAPPINGS = {"QG_FreeMemory": QGFreeMemory}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_FreeMemory": "Free Memory"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
