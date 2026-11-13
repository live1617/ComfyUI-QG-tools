"""QG LoRA Stack.

A LoRA stack whose every row can be switched from the graph: row N has an
``on_N`` BOOLEAN input, and the row's own toggle is what that input overrides.

Why this exists next to QG_LoraLoader: that node edits its stack inside one
DOM panel, so its inputs can only live on the node's left edge. Here each row
is a native litegraph widget, and a BOOLEAN input bound to that widget is
drawn by the canvas *on the row itself* - no ``input.pos`` tricks, no fighting
the widget layout. Same look, the switches sit where the rows are.

Data model: one hidden ``rows_data`` widget holds the whole stack as a JSON
list with one entry per slot (empty rows included, so ``on_N`` always means
row N). ``SLOT_COUNT`` is the single source of truth for both the number of
rows and the number of ``on_N`` inputs; upstream helpers put no row cap on
the list, so raising it only lengthens the stack the node can carry.
"""

from __future__ import annotations

import json
from typing import Any

from ._qg_lora_helpers import (
    MISSING_MODES,
    apply_lora_stack,
    collect_trigger_words,
    missing_lora_rows,
    parse_lora_stack,
    stack_fingerprint,
    truthy,
    unreadable_lora_message,
    unreadable_lora_rows,
)

# How many rows the node offers, and therefore how many on_N inputs INPUT_TYPES
# declares. Static on purpose: slot count is part of the contract, and the
# frontend hides the unused rows instead of adding or removing inputs.
# 24 rows, each with its own on_N BOOLEAN, so every row can be wired from the
# graph. The frontend/verify/probes/i18n all mirror this number - bump them
# together (see DEVELOPMENT.md "LoRA Switch Stack").
SLOT_COUNT = 24


def _merge_slots(rows_data: Any, on_slots: dict[str, Any]) -> str:
    """Overlay the wired on_N switches onto the stored stack.

    Applies by *position in the raw list* (1-based), matching the row the user
    sees: empty rows stay in the list, so row 3 is entry 3 even when rows 1 and
    2 hold nothing. Filtering empty rows first - which is what
    ``parse_lora_stack`` does - would shift every switch onto its neighbour.

    Anything unparsable is returned untouched so ``parse_lora_stack`` can raise
    the one error message the user is used to.
    """
    if not on_slots:
        return "" if rows_data is None else str(rows_data)
    try:
        data = json.loads(str(rows_data).strip() or "[]")
    except (TypeError, ValueError):
        return "" if rows_data is None else str(rows_data)
    if not isinstance(data, list):
        return str(rows_data)
    merged = []
    for position, entry in enumerate(data, start=1):
        if isinstance(entry, dict):
            key = "on_%d" % position
            # 🔴 用 truthy 而不是 bool：bool("false") is True，会把本该关掉的
            # 行静默打开。另外 IS_CHANGED 里核心对连线输入只给 None（拿不到
            # 上游值），None 不该把这一行的存档开关强行改写成 False —— 那种
            # 情况下保留行自身的 enabled 更接近真实执行结果。
            if key in on_slots and on_slots[key] is not None:
                entry = dict(entry)
                entry["enabled"] = truthy(on_slots[key])
        merged.append(entry)
    return json.dumps(merged)


class QGLoraSwitchStack:
    CATEGORY = "QG-tools/Loaders"
    DESCRIPTION = (
        "Applies a stack of LoRAs where each row's toggle can be driven from "
        "the graph: row N has its own BOOLEAN input, drawn on that row. Wire a "
        "switch, a comparison or a seed-driven boolean in and the row follows "
        "the wire; leave it unwired and the row keeps its own toggle. "
        "Trigger words from the enabled rows are joined into one string."
    )
    SEARCH_ALIASES = [
        "lora", "lora stack", "switchable lora", "lora switch",
        "boolean lora", "lora rows", "trigger words", "qg",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The diffusion model the LoRA stack patches."}),
                "rows_data": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": False,
                        "tooltip": (
                            "Serialized rows of the stack, one entry per row "
                            "(empty rows included). Edited by the rows on the "
                            "node; edit those, not this value."
                        ),
                    },
                ),
            },
            "optional": {
                "clip": (
                    "CLIP",
                    {"tooltip": "Optional CLIP to patch; without it, CLIP strengths are ignored."},
                ),
                **{
                    "on_%d" % slot: (
                        "BOOLEAN",
                        {
                            "forceInput": True,
                            "tooltip": (
                                "Row %d's switch, wired from the graph. A wire "
                                "overrides the row's own toggle; unwired, the "
                                "toggle decides." % slot
                            ),
                        },
                    )
                    for slot in range(1, SLOT_COUNT + 1)
                },
                "trigger_separator": (
                    "STRING",
                    {
                        "default": ", ",
                        "tooltip": "Joins the enabled rows' trigger words into the triggers output.",
                    },
                ),
                "on_missing": (
                    list(MISSING_MODES),
                    {
                        "default": "error",
                        "tooltip": (
                            "What happens when a row's file cannot be found: "
                            "error stops the run before sampling and names the "
                            "file, skip warns and applies the rest."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("model", "clip", "triggers")
    OUTPUT_TOOLTIPS = (
        "The model with every enabled LoRA applied in row order.",
        "The CLIP with every enabled LoRA applied in row order.",
        "Enabled rows' trigger words, deduplicated and joined with "
        "trigger_separator. A row skipped for a missing file adds none.",
    )
    FUNCTION = "load_loras"

    def load_loras(
        self,
        model,
        rows_data: str,
        clip=None,
        trigger_separator=", ",
        on_missing="error",
        **on_slots,
    ):
        rows = parse_lora_stack(_merge_slots(rows_data, on_slots))
        missing: list[dict] = []
        model, clip = apply_lora_stack(model, clip, rows, on_missing=on_missing, missing=missing)
        skipped = {id(row) for row in missing}
        worded = [row for row in rows if id(row) not in skipped]
        return model, clip, collect_trigger_words(worded, str(trigger_separator))

    @classmethod
    def VALIDATE_INPUTS(cls, rows_data, on_missing="error"):
        # Checks the stored stack only - not the wired on_N switches. Naming
        # those would make ComfyUI skip its own validation for every input it
        # was not told about, and the only thing they can do here is turn a row
        # off; a row switched off needs no file. Being stricter than the run
        # (a wired False on the one row whose file is gone still stops the
        # queue) is the direction that cannot silently drop a LoRA.
        try:
            rows = parse_lora_stack(rows_data)
        except ValueError as exc:
            return f"QG LoRA Stack: {exc}"
        unreadable = unreadable_lora_rows(rows)
        if unreadable:
            return " ".join(unreadable_lora_message(name, reason) for name, reason in unreadable)
        if on_missing != "skip":
            missing = missing_lora_rows(rows)
            if missing:
                detail = "; ".join(f"'{name}' - {reason}" for name, reason in missing)
                return (
                    f"QG LoRA Stack: missing LoRA file, so the run stopped before "
                    f"sampling: {detail} Fix or clear the row, or set on_missing to skip "
                    "to warn and skip it instead."
                )
        return True

    @classmethod
    def IS_CHANGED(cls, rows_data, trigger_separator=", ", clip=None, **on_slots):
        # Defining IS_CHANGED makes the core ignore every other input when
        # deciding on the cache, so everything that changes the outputs is
        # folded in here: the merged stack (which already carries the wired
        # switches), the separator, and whether a CLIP is wired at all - a row
        # with model strength 0 and a non-zero CLIP strength only counts as
        # loaded when CLIP is connected.
        #
        # 🔴 实测限制（ComfyUI 1.58.5 execution.py）：调 IS_CHANGED 时核心对
        # **连线**输入只传 None，拿不到上游的布尔 / CLIP 值。所以 has_clip 与
        # on_slots 主要覆盖常量输入；连线变化由核心缓存键里的拓扑与祖先签名兜住。
        # 别在这里假装有上游真值 —— _merge_slots 已让 None 保留行自身开关，
        # 不会把接线行在指纹里一律写成关闭。
        has_clip = 1 if clip is not None else 0
        try:
            fingerprint = stack_fingerprint(
                parse_lora_stack(_merge_slots(rows_data, on_slots))
            )
        except ValueError:
            fingerprint = str(rows_data)
        return "%s|sep=%s|clip=%d" % (fingerprint, trigger_separator, has_clip)


NODE_CLASS_MAPPINGS = {"QG_LoraSwitchStack": QGLoraSwitchStack}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_LoraSwitchStack": "LoRA Switch Stack"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
