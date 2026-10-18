"""QG LoRA Loader."""

from __future__ import annotations

from ._qg_lora_helpers import (
    MISSING_MODES,
    apply_lora_stack,
    collect_trigger_words,
    missing_lora_rows,
    parse_lora_stack,
    register_lora_routes,
    stack_fingerprint,
    unreadable_lora_message,
    unreadable_lora_rows,
)


class QGLoraLoader:
    CATEGORY = "QG-tools/加载器"
    DESCRIPTION = (
        "Applies a stack of LoRAs to a model and CLIP from one compact node. "
        "Each row has an enable toggle, a searchable LoRA picker, "
        "drag-to-scrub model/CLIP strengths, and a center-zero strength bar "
        "behind its name; trigger words from all enabled rows are joined "
        "into one string output. The bar's ▤ button saves and applies named "
        "templates of the whole stack, and a gear-menu action absorbs every "
        "LoRA loader wired into the model chain - upstream and downstream - "
        "into this stack and bypasses the originals. Moved LoRA files "
        "resolve by name at run time; a genuinely missing one fails validation "
        "before anything is sampled and the error names the file - turn the "
        "gear menu's Stop on missing LoRA switch off to warn and skip it instead."
    )
    SEARCH_ALIASES = [
        "lora", "lora stack", "lora loader", "trigger words",
        "strength bars", "import loras", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The diffusion model the LoRA stack patches."}),
                "loras": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "tooltip": (
                            "Serialized LoRA stack managed by the node's row "
                            "editor; edit the rows, not this value."
                        ),
                    },
                ),
            },
            "optional": {
                "clip": ("CLIP", {"tooltip": "Optional CLIP to patch; without it, CLIP strengths are ignored."}),
                "trigger_separator": (
                    "STRING",
                    {
                        "default": ", ",
                        "tooltip": (
                            "Joins the enabled rows' trigger words into the "
                            "triggers output. Set from the node's gear "
                            "menu; hidden on the canvas."
                        ),
                    },
                ),
                "on_missing": (
                    list(MISSING_MODES),
                    {
                        "default": "error",
                        "tooltip": (
                            "What happens when an enabled row's file cannot be "
                            "found. error (the default) fails validation before "
                            "sampling and names the file, so an unattended or "
                            "scripted run never renders without a LoRA it asked "
                            "for; skip warns once in the console and applies the "
                            "rest of the stack. Set from the node's gear menu "
                            "(Stop on missing LoRA); hidden on the canvas."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    # "triggers", not "trigger_words": output links ride slot indices, so the
    # label is free to be short - and the narrow name is what leaves room for
    # the control cluster floating in the slot band on the frontend.
    RETURN_NAMES = ("model", "clip", "triggers")
    OUTPUT_TOOLTIPS = (
        "The model with every enabled LoRA applied in row order.",
        "The CLIP with every enabled LoRA applied in row order.",
        "Enabled rows' trigger words, deduplicated and joined with "
        "trigger_separator (set in the gear menu). A row skipped for a "
        "missing file adds none.",
    )
    FUNCTION = "load_loras"

    def load_loras(self, model, loras: str, clip=None, trigger_separator=", ", on_missing="error"):
        rows = parse_lora_stack(loras)
        missing: list[dict] = []
        model, clip = apply_lora_stack(model, clip, rows, on_missing=on_missing, missing=missing)
        # A row skipped for a missing file loaded nothing, so its words stay
        # out of the prompt. A row parked at strength 0 keeps them on purpose
        # (see the node docs): comparing with and without it changes only
        # the weights.
        worded = [row for row in rows if not any(row is gone for gone in missing)]
        return model, clip, collect_trigger_words(worded, str(trigger_separator))

    @classmethod
    def VALIDATE_INPUTS(cls, loras, on_missing="error"):
        # Structural validation always. A row whose FILE is gone blocks the
        # queue unless the node was switched to 'skip': apply_lora_stack
        # resolves moved files by basename either way, so only a genuinely
        # missing file gets this far. Old graphs saved without the input get
        # the default, which is strict. Only the two inputs read here are
        # named: ComfyUI keeps checking the rest, and files a failure once
        # per named input. The LoRA names live inside the loras text, so no
        # list check ever applied to them.
        try:
            rows = parse_lora_stack(loras)
        except ValueError as exc:
            return f"QG LoRA Loader: {exc}"
        # A file that is plainly not a LoRA stops the run in both modes: it
        # would fail at load either way, after the models were loaded.
        unreadable = unreadable_lora_rows(rows)
        if unreadable:
            return " ".join(unreadable_lora_message(name, reason) for name, reason in unreadable)
        if on_missing != "skip":
            missing = missing_lora_rows(rows)
            if missing:
                detail = "; ".join(f"'{name}' - {reason}" for name, reason in missing)
                return (
                    f"QG LoRA Loader: missing LoRA file, so the run stopped before sampling: {detail} "
                    "Stop on missing LoRA is on (the default). Fix or remove the row, or turn "
                    "'Stop on missing LoRA' off in the node's settings menu (the gear icon on "
                    "the node) to warn and skip instead; in API graphs that is on_missing: skip."
                )
        return True

    @classmethod
    def IS_CHANGED(cls, loras, **_values):
        try:
            return stack_fingerprint(parse_lora_stack(loras))
        except ValueError:
            return loras


NODE_CLASS_MAPPINGS = {"QG_LoraLoader": QGLoraLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_LoraLoader": "LoRA Loader"}

register_lora_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
