# -*- coding: utf-8 -*-
"""QG Free Memory — pass any wire through and release VRAM on the way.

Ported from ComfyUI-AusBoss (nodes/node_free_memory.py + nodes/_memory_helpers.py), MIT.
Original by the ComfyUI-AusBoss author. The release routine is unchanged: unload
comfy's cached models, empty comfy's cache, collect garbage, empty the CUDA cache
-- each step independent and fail-soft, so a moved core API only drops that step
from the log instead of raising.

The wildcard type is that plugin's: a str subclass whose __ne__ always says "not
different", because ComfyUI validates a link by comparing type strings with !=.
The frontend needs no help, LiteGraph already treats "*" as compatible.

Modified for ComfyUI-QG-tools on 2026-10-27: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations


class _Wildcard(str):
    """A type string that matches every wire."""

    __slots__ = ()

    def __ne__(self, _other) -> bool:
        return False


WILDCARD = _Wildcard("*")


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

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": (
                    WILDCARD,
                    {
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
    FUNCTION = "free_memory"

    def free_memory(self, value):
        freed = free_gpu_memory()
        detail = ", ".join(freed) if freed else "nothing to free"
        # ASCII only: the banner rule applies to any console line we print.
        print("[QG-tools] Free Memory: %s." % detail)
        return (value,)


NODE_CLASS_MAPPINGS = {"QG_FreeMemory": QGFreeMemory}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_FreeMemory": "Free Memory"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
