"""QG LoRA Loader.

Originally ported from ComfyUI-AusBoss (nodes/node_lora_loader.py), MIT licensed.
The backend (this file and nodes/_qg_lora_helpers.py) was rewritten for
ComfyUI-QG-tools on 2026-10-30: the six HTTP routes keep their URLs and payloads
(list / thumb / info / hash / civitai / triggers) because the front end calls
them, but every routine behind them is this pack's own. The node's interface -
ID, inputs, outputs, the serialized stack format - is unchanged, so saved
workflows keep working.

The front end under web/lora_loader/ is still the ported one, hence the origin
in ORIGINS.json stays "ported".

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

from __future__ import annotations

import json
from typing import Any

from ._qg_lora_helpers import (
    MISSING_MODES,
    apply_lora_stack,
    clamp_strength,
    collect_trigger_words,
    missing_lora_rows,
    parse_lora_stack,
    register_lora_routes,
    stack_fingerprint,
    unreadable_lora_message,
    unreadable_lora_rows,
)

from comfy_api.latest import io

# 行强度外控槽的数量。前端 web/lora_loader/index.js 里有一份同样的数字，
# 改的话两边一起改（后端槽名决定存档键，前端只决定画几行连接点）。
# 与 QG_LoraSwitchStack 的 SLOT_COUNT 保持同一口径，用户在两个节点间的
# 心智模型一致。超过这个行数的行不能外控，仍可用面板里自己的强度。
SLOT_COUNT = 24
STRENGTH_PREFIX = "strength_"


def _merge_strengths(rows_data: Any, wired: dict[str, Any]) -> str:
    """把接线进来的 ``strength_N`` 覆盖到第 N 行的 model 强度上。

    与 ``QG_LoraSwitchStack._merge_slots`` 同源，但**只动 model 强度**：
    ``strength_clip`` 保持行自身值，与官方 ``LoraLoader`` 的语义一致（官方
    的两个强度是两个独立输入，改一个不带动另一个）。用户 2026-11-22 明确
    要求保持这个行为，不要改成 AusBoss 那种按比例跟随。

    位置按**原始列表** 1-based 计，空行也占位 —— 与用户在面板里看到的行号
    对齐（``parse_lora_stack`` 会滤掉空行，先滤会让开关/强度串到邻居上）。
    未接线（None）的槽保留行自身强度。
    """
    text = "" if rows_data is None else str(rows_data)
    if not wired:
        return text
    if not any(isinstance(name, str) and name.startswith(STRENGTH_PREFIX) for name in wired):
        return text
    try:
        data = json.loads(text.strip() or "[]")
    except (TypeError, ValueError):
        return text
    if not isinstance(data, list):
        return text
    merged: list[Any] = []
    for position, entry in enumerate(data, start=1):
        if isinstance(entry, dict):
            value = wired.get("%s%d" % (STRENGTH_PREFIX, position))
            if value is not None:
                entry = dict(entry)
                entry["strength"] = clamp_strength(value)
                # 刻意不动 strength_clip：CLIP 强度只由面板里的那一栏决定。
        merged.append(entry)
    return json.dumps(merged)


class QGLoraLoader(io.ComfyNode):
    CATEGORY = "QG-tools/Loaders"
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
        "gear menu's Stop on missing LoRA switch off to warn and skip it instead. "
        "A row's model strength can also come from the graph: drop a number wire "
        "on the row and it overrides the row's own strength, while the CLIP "
        "strength stays exactly as the row has it. The first 24 rows accept a "
        "wire; rows past that keep their panel strength."
    )
    SEARCH_ALIASES = [
        "lora", "lora stack", "lora loader", "trigger words",
        "strength bars", "import loras", "qg",
    ]

    @classmethod
    def define_schema(cls):
        # 24 个 strength_N 是 FLOAT forceInput 可选槽：接上就覆盖该行的 model
        # 强度，不接（None）保留面板里的值；CLIP 强度不受影响。
        # 🔴 必须追加在所有既有输入**之后**：连线在 prompt 里按槽下标引用
        # （[node_id, slot]），插在中间会让 model/clip 的下标整体后移、老图断线。
        strength_inputs = [
            io.Float.Input(
                "%s%d" % (STRENGTH_PREFIX, slot),
                optional=True,
                force_input=True,
                tooltip=(
                    "Row %d's model strength, wired from a slider. A wire overrides "
                    "the row's own strength; unwired, the row keeps its value. Only "
                    "the model strength changes - the CLIP strength stays as set on "
                    "the row, same as the built-in LoRA Loader." % slot
                ),
            )
            for slot in range(1, SLOT_COUNT + 1)
        ]
        return io.Schema(
            node_id="QG_LoraLoader",
            display_name="LoRA Loader",
            category="QG-tools/Loaders",
            description=cls.DESCRIPTION,
            search_aliases=cls.SEARCH_ALIASES,
            inputs=[
                io.Model.Input("model", tooltip="The diffusion model the LoRA stack patches."),
                io.String.Input("loras", multiline=True, default="[]",
                    tooltip="Serialized LoRA stack managed by the node's row editor; edit the rows, not this value."),
                io.Clip.Input("clip", optional=True,
                    tooltip="Optional CLIP to patch; without it, CLIP strengths are ignored."),
                io.String.Input("trigger_separator", optional=True, default=", ",
                    tooltip="Joins the enabled rows' trigger words into the triggers output. Set from the node's gear menu; hidden on the canvas."),
                io.Combo.Input("on_missing", optional=True, options=list(MISSING_MODES), default="error",
                    tooltip="What happens when an enabled row's file cannot be found. error (the default) fails validation before sampling and names the file, so an unattended or scripted run never renders without a LoRA it asked for; skip warns once in the console and applies the rest of the stack. Set from the node's gear menu (Stop on missing LoRA); hidden on the canvas."),
                *strength_inputs,
            ],
            outputs=[
                io.Model.Output("model", tooltip="The model with every enabled LoRA applied in row order."),
                io.Clip.Output("clip", tooltip="The CLIP with every enabled LoRA applied in row order."),
                io.String.Output("triggers", tooltip="Enabled rows' trigger words, deduplicated and joined with trigger_separator (set in the gear menu). A row skipped for a missing file adds none."),
            ],
        )

    @classmethod
    def execute(cls, model, loras: str, clip=None, trigger_separator=", ", on_missing="error", **wired):
        # 接线的 strength_N 覆盖对应行的 model 强度；CLIP 强度保持不变。
        rows = parse_lora_stack(_merge_strengths(loras, wired))
        missing: list[dict] = []
        model, clip = apply_lora_stack(model, clip, rows, on_missing=on_missing, missing=missing)
        # A row skipped for a missing file loaded nothing, so its words stay
        # out of the prompt. A row parked at strength 0 keeps them on purpose
        # (see the node docs): comparing with and without it changes only
        # the weights.
        skipped = {id(row) for row in missing}
        worded = [row for row in rows if id(row) not in skipped]
        return io.NodeOutput(model, clip, collect_trigger_words(worded, str(trigger_separator)))

    @classmethod
    def validate_inputs(cls, loras, on_missing="error"):
        # Structural validation always. A row whose FILE is gone blocks the
        # queue unless the node was switched to 'skip': apply_lora_stack
        # resolves moved files by basename either way, so only a genuinely
        # missing file gets this far. Old graphs saved without the input get
        # the default, which is strict. Only the two inputs read here are
        # named: ComfyUI keeps checking the rest, and files a failure once
        # per named input. The LoRA names live inside the loras text, so no
        # list check ever applied to them.
        #
        # 🔴 clip is deliberately NOT named here. Naming an input makes the
        # core file the same failure once per named input, and the signature
        # only ever sees the link ("[node, slot]"), never the CLIP itself -
        # so it could at best tell "not wired". The rows below are therefore
        # checked as if CLIP were connected: a row with model strength 0 and
        # a non-zero CLIP strength survives that check even when no CLIP is
        # wired, and its missing file still stops the queue. That is the
        # conservative direction - one extra stop on a rare arrangement beats
        # letting a file that really is needed slip through. Execution uses
        # the real value (apply_lora_stack knows whether clip is None).
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
    def fingerprint_inputs(cls, loras, trigger_separator=", ", clip=None, **wired):
        # 🔴 一旦定义了 fingerprint_inputs，核心就**只**看它的返回值，不再逐个比较输入。
        # 所以凡是会改变 outputs 的值都得进来，这里是两个容易被忘掉的：
        #
        #   trigger_separator —— 齿轮菜单里的设置，只影响 triggers 那一路。改了
        #   之后栈没动，漏掉它就会命中上一次的输出缓存，分隔符还是旧的。
        #
        #   clip 有没有接 —— 一行「模型强度 0、CLIP 强度非 0」在接了 CLIP 时才
        #   算「会加载」，文件缺失才会被记进 missing、它的词才会被排除；拔掉
        #   CLIP 线之后同一个栈的 triggers 就变了。只记「接没接」这个布尔，
        #   不拼对象本身：对象每次运行都可能是新的，拼进去会让缓存永不命中。
        #
        # wired 里的 strength_N 照 _merge_strengths 折进指纹；但按 ComfyUI
        # 1.58.5 的实测限制，调 fingerprint_inputs 时核心对连线输入只传 None，真正的
        # 连线值变化由核心缓存键里的拓扑与祖先签名兜住（与 QG_LoraSwitchStack
        # 的 fingerprint_inputs 同一处理）。别在这里假装拿得到上游真值。
        #
        # （on_missing 不用进：error 模式下缺文件在采样前就被拦下，根本走不到
        # 缓存这一层。）
        has_clip = 1 if clip is not None else 0
        try:
            fingerprint = stack_fingerprint(parse_lora_stack(_merge_strengths(loras, wired)))
        except ValueError:
            fingerprint = loras
        return "%s|sep=%s|clip=%d" % (fingerprint, trigger_separator, has_clip)


NODE_CLASS_MAPPINGS = {"QG_LoraLoader": QGLoraLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"QG_LoraLoader": "LoRA Loader"}

register_lora_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
